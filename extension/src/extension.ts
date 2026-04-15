import * as vscode from 'vscode';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';

export function activate(context: vscode.ExtensionContext) {
    const provider = new OmrixChatProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(OmrixChatProvider.viewType, provider)
    );
}

export function deactivate() { }

class OmrixChatProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'omrix.chatView';

    private _view?: vscode.WebviewView;
    private _chatHistory: { role: 'user' | 'bot', text: string }[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen for messages from the Webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'prompt') {
                await this.handlePrompt(message.text, message.model, webviewView);
            }
        });
    }

    private async handlePrompt(prompt: string, model: string, webviewView: vscode.WebviewView) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const API_URL = 'http://localhost:8000/chat';
        const globalFetch = (globalThis as any).fetch;

        try {
            // 1. Setup the UI
            webviewView.webview.postMessage({ type: 'addMessage', text: prompt, isUser: true });
            webviewView.webview.postMessage({ type: 'startBotMessage' });
            webviewView.webview.postMessage({ type: 'setLoading', text: 'Thinking...' });

            // 2. The initial payload
            let toolHistory: any[] = [];
            let verifiedFiles = new Set<string>();
            let verificationRetryCount = 0;
            const MAX_VERIFICATION_RETRIES = 2;
            let currentPayload: any = { 
                prompt, 
                model, 
                workspace: workspacePath, 
                tool_history: toolHistory,
                chat_history: [...this._chatHistory] // Clone history
            };
            let isDone = false;
            let finalResponseText = "No response field returned.";

            // 3. THE AGENTIC LOOP
            while (!isDone) {
                let response = await globalFetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentPayload)
                });

                if (!response.ok) throw new Error('Server responded with an error');
                let data: any = await response.json();

                // Scenario A: Gemini wants to use a tool
                if (data.type === 'tool_call') {
                    const toolName = data.tool_name;
                    const toolArgs = data.arguments;
                    const targetPath = toolArgs.relative_path || '';
                    let toolResultContent = '';

                    // --- UI UPDATE: Log the step permanently ---
                    // Temporarily remove the loading spinner
                    webviewView.webview.postMessage({ type: 'removeLoading' });

                    // Log the step using the new collapsible UI
                    if (toolName === 'read_file') {
                        webviewView.webview.postMessage({ type: 'addStep', icon: '📄', action: 'Reading file', target: targetPath });
                    } else if (toolName === 'modify_file') {
                        webviewView.webview.postMessage({ type: 'addStep', icon: '✏️', action: 'Editing file', target: targetPath });
                    } else if (toolName === 'search_in_files') {
                        webviewView.webview.postMessage({ type: 'addStep', icon: '🔍', action: 'Searching workspace', target: toolArgs.query });
                    } else {
                        webviewView.webview.postMessage({ type: 'addStep', icon: '📂', action: 'Scanning directory', target: targetPath });
                    }

                    // Put the loading spinner back at the bottom
                    webviewView.webview.postMessage({ type: 'setLoading', text: `Executing ${toolName}...` });
                    // -------------------------------------------

                    try {
                        const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(workspacePath, targetPath);
                        const targetUri = vscode.Uri.file(absolutePath);

                        if (toolName === 'read_file') {
                            const uint8Array = await vscode.workspace.fs.readFile(targetUri);
                            toolResultContent = new TextDecoder().decode(uint8Array);
                        } else if (toolName === 'modify_file') {
                            const uint8Array = await vscode.workspace.fs.readFile(targetUri);
                            let fileContent = new TextDecoder().decode(uint8Array);
                            const oldText = toolArgs.old_text;
                            const newText = toolArgs.new_text;
                            if (fileContent.includes(oldText)) {
                                fileContent = fileContent.replace(oldText, newText);
                                await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(fileContent));
                                toolResultContent = `Successfully replaced exact text string in ${targetPath}`;
                            } else {
                                toolResultContent = `Error: Exact old_text string not found in ${targetPath}. Consider reading the file again to check whitespace/formatting.`;
                            }
                        } else if (toolName === 'list_directory') {
                            const entries = await vscode.workspace.fs.readDirectory(targetUri);
                            toolResultContent = entries.map(([name, type]) => type === vscode.FileType.Directory ? `[Folder] ${name}` : `[File] ${name}`).join('\n');
                        } else if (toolName === 'search_in_files') {
                            const query = toolArgs.query;
                            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
                            let matches: string[] = [];
                            
                            for (const file of files) {
                                try {
                                    const uint8Array = await vscode.workspace.fs.readFile(file);
                                    const content = new TextDecoder().decode(uint8Array);
                                    if (content.includes(query)) {
                                        matches.push(vscode.workspace.asRelativePath(file));
                                    }
                                } catch (e) {
                                    // Skip files that can't be read (e.g. binaries)
                                }
                                // Limit results to avoid token overflow
                                if (matches.length > 20) break; 
                            }
                            toolResultContent = matches.length > 0 ? matches.join('\n') : "No matches found.";
                        }
                    } catch (err: any) {
                        toolResultContent = `Error executing tool: ${err.message}`;
                    }

                    // Update spinner text
                    webviewView.webview.postMessage({ type: 'setLoading', text: 'Analyzing results...' });

                    // Update the payload for the NEXT iteration of the loop
                    toolHistory.push({
                        tool_name: toolName,
                        content: toolResultContent,
                        arguments: toolArgs
                    });
                    
                    // --- TRACK VERIFIED FILES ---
                    if (toolName === 'list_directory') {
                        const lines = toolResultContent.split('\n');
                        lines.forEach(line => {
                            if (line.includes('[File] ')) {
                                const fileName = line.replace('[File] ', '').trim();
                                verifiedFiles.add(path.join(targetPath, fileName).replace(/\\/g, '/'));
                            }
                        });
                    } else if (toolName === 'read_file' || toolName === 'modify_file') {
                        verifiedFiles.add(targetPath.replace(/\\/g, '/'));
                    } else if (toolName === 'search_in_files') {
                        const files = toolResultContent.split('\n');
                        files.forEach(f => verifiedFiles.add(f.trim().replace(/\\/g, '/')));
                    }
                    // ----------------------------

                    currentPayload = {
                        prompt: prompt,
                        model: model,
                        workspace: workspacePath,
                        tool_history: toolHistory,
                        chat_history: currentPayload.chat_history // Keep history if any
                    };
                }
                // Scenario B: AI is finished and gives us the final text
                else if (data.type === 'message') {
                    const messageContent = data.content || "";
                    
                    // --- VERIFICATION LOOP ---
                    // Regex to find potential filenames (word.extension)
                    const fileRegex = /\b[\w\-]+\.(html|js|ts|py|css|json|md|txt|sh)\b/g;
                    const mentions = messageContent.match(fileRegex) || [];
                    let unverifiedFile = "";
                    
                    for (const mention of mentions) {
                        // Check if this file was ever "seen" by a tool
                        // We check both the exact mention and if any verified path ends with this mention
                        const isVerified = Array.from(verifiedFiles).some(vf => vf === mention || vf.endsWith('/' + mention) || vf.endsWith('\\' + mention));
                        
                        if (!isVerified) {
                            unverifiedFile = mention;
                            break;
                        }
                    }
                    
                    if (unverifiedFile && verificationRetryCount < MAX_VERIFICATION_RETRIES) {
                        const feedbackPrompt = `I noticed you mentioned \`${unverifiedFile}\`, but that file was never found in the directory listing. Please list the directory first to verify.`;
                        verificationRetryCount++;
                        
                        // Injection: Add the AI's "guessed" message and our correction to the history
                        if (!currentPayload.chat_history) currentPayload.chat_history = [];
                        currentPayload.chat_history.push({ role: 'user', text: prompt });
                        currentPayload.chat_history.push({ role: 'bot', text: messageContent });
                        
                        // Update current prompt to the feedback
                        prompt = feedbackPrompt; 
                        currentPayload.prompt = prompt;
                        
                        // Log the correction in the UI (optional but helpful)
                        webviewView.webview.postMessage({ type: 'addStep', icon: '⚠️', action: 'Verification failed', target: unverifiedFile });
                        webviewView.webview.postMessage({ type: 'setLoading', text: `Re-verifying filenames (Attempt ${verificationRetryCount})...` });
                        
                        // Do NOT set isDone = true, loop continues
                    } else {
                        if (unverifiedFile && verificationRetryCount >= MAX_VERIFICATION_RETRIES) {
                             console.warn(`Max verification retries reached for ${unverifiedFile}. Finishing anyway.`);
                        }
                        finalResponseText = messageContent || "Empty response from AI.";
                        isDone = true;
                    }
                }
                else {
                    finalResponseText = "Unknown response type from server.";
                    isDone = true;
                }
            }

            // 4. Print the final answer to the screen
            webviewView.webview.postMessage({ type: 'removeLoading' });
            webviewView.webview.postMessage({ type: 'addMessage', text: finalResponseText, isUser: false });

            // 5. Update persistent history for subsequent turns
            this._chatHistory.push({ role: 'user', text: prompt });
            this._chatHistory.push({ role: 'bot', text: finalResponseText });

        } catch (error: any) {
            console.error('Fetch error:', error);
            webviewView.webview.postMessage({ type: 'removeLoading' });
            webviewView.webview.postMessage({ type: 'addMessage', text: `Error: Failed to connect or execute feature.`, isUser: false, isError: true });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net;">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <title>Omrix Chat</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 0;
            margin: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* Header removed - Layout shifted to Copilot-style bottom bar */

        #chat-history {
            flex-grow: 1;
            padding: 16px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .message {
            padding: 10px 14px;
            border-radius: 6px;
            max-width: 90%;
            word-wrap: break-word;
            line-height: 1.5;
        }

        .user-message {
            align-self: flex-end;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            white-space: pre-wrap;
        }

        .bot-message {
            align-self: flex-start;
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-widget-border);
            color: var(--vscode-editorWidget-foreground);
        }

        /* Markdown Styles */
        .bot-message p { margin: 0 0 8px 0; }
        
        /* Agent Steps UI */
        .agent-steps-container {
            margin-bottom: 8px;
            color: var(--vscode-descriptionForeground);
        }
        
        .agent-steps-container summary {
            cursor: pointer;
            font-size: 0.9em;
            font-weight: bold;
            user-select: none;
            outline: none;
            margin-bottom: 4px;
            opacity: 0.8;
            transition: opacity 0.2s;
        }

        .agent-steps-container summary:hover {
            opacity: 1;
        }
        
        .steps-content {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding-left: 12px;
            margin-top: 6px;
            margin-bottom: 8px;
            border-left: 2px solid var(--vscode-widget-border);
        }
        
        .agent-step {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .agent-step code {
            font-size: 1em;
            background: transparent;
            border: 1px solid var(--vscode-widget-border);
            padding: 1px 4px;
        }
        .bot-message p:last-child { margin-bottom: 0; }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
            border: 1px solid var(--vscode-widget-border);
        }
        code {
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 0.9em;
        }
        pre code { padding: 0; background-color: transparent; border: none; }

        .loading { font-style: italic; opacity: 0.7; }

        #input-wrapper {
            padding: 12px 16px;
            background-color: var(--vscode-editor-background);
        }

        #copilot-input-box {
            display: flex;
            flex-direction: column;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 4px;
            /* Copilot shadow effect */
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        }

        #copilot-input-box:focus-within {
            border-color: var(--vscode-focusBorder);
        }

        #prompt-input {
            width: 100%;
            background-color: transparent;
            color: var(--vscode-input-foreground);
            border: none;
            padding: 6px 8px;
            outline: none;
            font-family: inherit;
            font-size: inherit;
            resize: none;
            box-sizing: border-box;
            max-height: 150px;
            min-height: 32px;
            overflow-y: auto;
        }

        #input-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px;
        }

        .toolbar-left, .toolbar-right {
            display: flex;
            gap: 4px;
            align-items: center;
        }

        .icon-button {
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            padding: 4px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            font-size: 14px;
        }
        
        .icon-button:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }

        .send-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .toolbar-select {
            background-color: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid transparent;
            border-radius: 4px;
            padding: 2px;
            font-family: inherit;
            font-size: 11px;
            outline: none;
            cursor: pointer;
        }
        
        .toolbar-select:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        
        .toolbar-select option {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
        }
    </style>
</head>
<body>
    <div id="chat-history">
        <div class="message bot-message">Hello! I am Omrix. How can I assist you today?</div>
    </div>
    
    <div id="input-wrapper">
        <div id="copilot-input-box">
            <textarea id="prompt-input" placeholder="Ask Omrix something..." rows="1"></textarea>
            
            <div id="input-toolbar">
                <div class="toolbar-left">
                    <button class="icon-button" title="Attach context (future)">+</button>
                    <select class="toolbar-select" title="Mode (future)">
                        <option value="chat">Chat</option>
                    </select>
                    <select id="model-selector" class="toolbar-select" title="Model">
                        <option value="gemini">Gemini</option>
                        <option value="grok">Grok</option>
                        <option value="ollama">Ollama</option>
                    </select>
                </div>
                <div class="toolbar-right">
                    <button id="send-button" class="icon-button send-button" title="Send message">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M8.354 1.146a.5.5 0 0 0-.708 0l-6 6a.5.5 0 0 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 1 0V2.707l5.146 5.147a.5.5 0 0 0 .708-.708l-6-6z"/>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const chatHistory = document.getElementById('chat-history');
            const promptInput = document.getElementById('prompt-input');
            const sendButton = document.getElementById('send-button');
            const modelSelector = document.getElementById('model-selector');

            let currentBotContainer = null;
            let currentStepsDetails = null;

            // Listen for messages from the extension context
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'startBotMessage':
                        currentBotContainer = document.createElement('div');
                        currentBotContainer.className = 'message bot-message';
                        
                        currentStepsDetails = document.createElement('details');
                        currentStepsDetails.className = 'agent-steps-container';
                        currentStepsDetails.style.display = 'none';
                        currentStepsDetails.innerHTML = '<summary>View Agent Steps</summary><div class="steps-content"></div>';
                        
                        const finalContent = document.createElement('div');
                        finalContent.className = 'final-content';
                        
                        currentBotContainer.appendChild(currentStepsDetails);
                        currentBotContainer.appendChild(finalContent);
                        
                        chatHistory.appendChild(currentBotContainer);
                        chatHistory.scrollTop = chatHistory.scrollHeight;
                        break;
                    case 'addStep':
                        if (!currentStepsDetails) return;
                        currentStepsDetails.style.display = 'block';
                        const stepDiv = document.createElement('div');
                        stepDiv.className = 'agent-step';
                        stepDiv.innerHTML = \`<span>\${message.icon}</span> <span>\${message.action}:</span> <code>\${message.target}</code>\`;
                        currentStepsDetails.querySelector('.steps-content').appendChild(stepDiv);
                        chatHistory.scrollTop = chatHistory.scrollHeight;
                        break;
                    case 'addMessage':
                        if (message.isUser) {
                            appendMessage(message.text, true, false, message.isError);
                        } else {
                            if (currentBotContainer) {
                                const content = currentBotContainer.querySelector('.final-content');
                                if (message.isError) {
                                    content.style.color = 'var(--vscode-errorForeground)';
                                    content.textContent = message.text;
                                } else {
                                    content.innerHTML = marked.parse(message.text);
                                }
                                currentBotContainer = null;
                                currentStepsDetails = null;
                                chatHistory.scrollTop = chatHistory.scrollHeight;
                            } else {
                                appendMessage(message.text, false, false, message.isError);
                            }
                        }
                        break;
                    case 'setLoading':
                        let existingLoading = document.getElementById('loading-indicator');
                        if (existingLoading) {
                            existingLoading.textContent = message.text;
                        } else {
                            existingLoading = document.createElement('div');
                            existingLoading.id = 'loading-indicator';
                            existingLoading.className = 'message loading bot-message'; // Match styling but italicized
                            existingLoading.textContent = message.text;
                            chatHistory.appendChild(existingLoading);
                        }
                        chatHistory.scrollTop = chatHistory.scrollHeight;
                        break;
                    case 'removeLoading':
                        const loader = document.getElementById('loading-indicator');
                        if (loader) loader.remove();
                        break;
                }
            });

            function appendMessage(text, isUser = false, isLoading = false, isError = false) {
                const msgDiv = document.createElement('div');
                msgDiv.className = 'message ' + (isUser ? 'user-message' : 'bot-message');
                if (isError) {
                    msgDiv.style.color = 'var(--vscode-errorForeground)';
                }
                
                if (isLoading) {
                    msgDiv.classList.add('loading');
                    msgDiv.id = 'loading-indicator'; 
                    msgDiv.textContent = text;
                } else if (!isUser) {
                    msgDiv.innerHTML = marked.parse(text);
                } else {
                    msgDiv.textContent = text;
                }
                
                chatHistory.appendChild(msgDiv);
                chatHistory.scrollTop = chatHistory.scrollHeight;
            }

            function sendPrompt() {
                const text = promptInput.value.trim();
                const model = modelSelector.value;
                if (!text) return;

                promptInput.value = '';
                
                // Send the message to the extension
                vscode.postMessage({
                    type: 'prompt',
                    text: text,
                    model: model
                });
                // Reset height
                promptInput.style.height = 'auto';
            }

            sendButton.addEventListener('click', sendPrompt);
            promptInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendPrompt();
                }
            });
            
            // Auto resize text area
            promptInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = (this.scrollHeight) + 'px';
            });

            promptInput.focus();
        })();
    </script>
</body>
</html>`;
    }
}
