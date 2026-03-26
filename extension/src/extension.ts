import * as vscode from 'vscode';
import * as path from 'path';

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
            // Echo back user's prompt immediately
            webviewView.webview.postMessage({ type: 'addMessage', text: prompt, isUser: true });
            webviewView.webview.postMessage({ type: 'setLoading', text: 'Thinking...' });

            let response = await globalFetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, model, workspace: workspacePath })
            });

            if (!response.ok) {
                throw new Error('Server responded with an error');
            }

            let data: any = await response.json();

            // Handle the potential for a 'read_file' tool call
            if (data.type === 'tool_call' && data.tool_name === 'read_file') {
                const filePath = data.file_path;
                let fileContent = '';
                
                webviewView.webview.postMessage({ type: 'setLoading', text: `Reading file ${filePath}...` });

                try {
                    const absolutePath = path.isAbsolute(filePath) 
                        ? filePath 
                        : path.join(workspacePath, filePath);
                        
                    const fileUri = vscode.Uri.file(absolutePath);
                    const uint8Array = await vscode.workspace.fs.readFile(fileUri);
                    fileContent = new TextDecoder().decode(uint8Array);
                } catch (err: any) {
                    fileContent = `Error reading file: ${err.message}`;
                }

                webviewView.webview.postMessage({ type: 'setLoading', text: 'Analyzing file...' });

                // Make a second fetch POST request with the file's contents
                response = await globalFetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        prompt: prompt,
                        model: model,
                        workspace: workspacePath,
                        tool_response: {
                           tool_name: 'read_file',
                           content: fileContent
                        }
                    })
                });

                if (!response.ok) {
                    throw new Error('Server error on tool response');
                }
                data = await response.json();
            }

            // Remove loading and post the final response text
            webviewView.webview.postMessage({ type: 'removeLoading' });
            
            const responseText = data.response || "No response field returned.";
            webviewView.webview.postMessage({ type: 'addMessage', text: responseText, isUser: false });

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

        #header {
            padding: 8px 16px;
            background-color: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky;
            top: 0;
            z-index: 10;
        }

        #model-selector {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 8px;
            border-radius: 4px;
            font-family: inherit;
            font-size: 11px;
            outline: none;
            width: 100%;
        }

        #model-selector:focus {
            border-color: var(--vscode-focusBorder);
        }

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

        #input-container {
            display: flex;
            padding: 12px 16px;
            background-color: var(--vscode-editorWidget-background);
            border-top: 1px solid var(--vscode-widget-border);
            gap: 8px;
        }

        #prompt-input {
            flex-grow: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            border-radius: 4px;
            outline: none;
            font-family: inherit;
            font-size: inherit;
        }

        #prompt-input:focus { border-color: var(--vscode-focusBorder); }

        #send-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            font-weight: bold;
        }

        #send-button:hover { background-color: var(--vscode-button-hoverBackground); }
    </style>
</head>
<body>
    <div id="header">
        <select id="model-selector">
            <option value="omrix">Omrix (Gemini)</option>
            <option value="expert">Local Expert</option>
        </select>
    </div>

    <div id="chat-history">
        <div class="message bot-message">Hello! I am Omrix. How can I assist you today?</div>
    </div>
    
    <div id="input-container">
        <input type="text" id="prompt-input" placeholder="Ask Omrix something..." autocomplete="off">
        <button id="send-button">Send</button>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            const chatHistory = document.getElementById('chat-history');
            const promptInput = document.getElementById('prompt-input');
            const sendButton = document.getElementById('send-button');
            const modelSelector = document.getElementById('model-selector');

            // Listen for messages from the extension context
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'addMessage':
                        appendMessage(message.text, message.isUser, false, message.isError);
                        break;
                    case 'setLoading':
                        const existingLoading = document.getElementById('loading-indicator');
                        if (existingLoading) {
                            existingLoading.textContent = message.text;
                        } else {
                            appendMessage(message.text, false, true);
                        }
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
            }

            sendButton.addEventListener('click', sendPrompt);
            promptInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendPrompt();
                }
            });

            promptInput.focus();
        })();
    </script>
</body>
</html>`;
    }
}
