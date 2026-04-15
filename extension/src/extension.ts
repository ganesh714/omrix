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
    // Stores resolve/reject callbacks for pending file edit approvals
    private _pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
    private _abortRequested = false;

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
            } else if (message.type === 'abortGeneration') {
                this._abortRequested = true;
            } else if (message.type === 'approveEdit' || message.type === 'rejectEdit') {
                const pending = this._pendingApprovals.get(message.id);
                if (pending) {
                    pending.resolve(message.type === 'approveEdit');
                    this._pendingApprovals.delete(message.id);
                }
            }
        });
    }

    private async handlePrompt(prompt: string, model: string, webviewView: vscode.WebviewView) {
        this._abortRequested = false;
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
            let consecutiveToolCalls = 0;
            const MAX_CONSECUTIVE_TOOLS = 15;
            let currentFileEditAttempts = new Map<string, number>();

            // 3. THE AGENTIC LOOP
            while (!isDone) {
                if (this._abortRequested) {
                    finalResponseText = "Generation stopped by user.";
                    break;
                }

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

                            if (!fileContent.includes(oldText)) {
                                toolResultContent = `Error: Exact old_text string not found in ${targetPath}. Consider reading the file again to check whitespace/formatting.`;
                            } else {
                                // --- HUMAN-IN-THE-LOOP APPROVAL ---
                                // Generate a unique ID for this specific edit request
                                const editId = `edit_${Date.now()}`;

                                // Ask the webview to show the diff and pause the loop
                                webviewView.webview.postMessage({
                                    type: 'askApproval',
                                    id: editId,
                                    target: targetPath,
                                    oldText,
                                    newText
                                });

                                // Pause here and wait for the user's decision
                                const approved = await new Promise<boolean>((resolve) => {
                                    this._pendingApprovals.set(editId, { resolve });
                                });

                                if (approved) {
                                    // Apply via WorkspaceEdit so the file is unsaved and Ctrl+Z works
                                    const document = await vscode.workspace.openTextDocument(targetUri);
                                    const idx = document.getText().indexOf(oldText);
                                    const startPos = document.positionAt(idx);
                                    const endPos = document.positionAt(idx + oldText.length);
                                    const range = new vscode.Range(startPos, endPos);

                                    const edit = new vscode.WorkspaceEdit();
                                    edit.replace(targetUri, range, newText);
                                    await vscode.workspace.applyEdit(edit);

                                    // Show the file to the user
                                    await vscode.window.showTextDocument(document, { preview: false });

                                    toolResultContent = `Successfully applied edit to ${targetPath}. The file is unsaved — the user can press Ctrl+Z to undo.`;
                                } else {
                                    toolResultContent = `CRITICAL ALERT: The user EXPLICITLY REJECTED your proposed edit to ${targetPath}. FORBIDDEN: You must abandon this change immediately. DO NOT retry or rephrase the edit. Stop and ask the user for clarification.`;
                                }
                                // -----------------------------------
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

                    // --- LOOP GUARDS ---
                    consecutiveToolCalls++;
                    if (toolName === 'modify_file') {
                        let attempts = currentFileEditAttempts.get(targetPath) || 0;
                        attempts++;
                        currentFileEditAttempts.set(targetPath, attempts);
                        if (attempts >= 4) {
                            finalResponseText = `Error: Agentic Loop Blocked. Refused to allow Omrix to edit ${targetPath} more than 3 times in a single request. Process aborted to protect workspace.`;
                            isDone = true;
                        }
                    }

                    if (consecutiveToolCalls > MAX_CONSECUTIVE_TOOLS) {
                        finalResponseText = `Error: Agentic Loop Blocked. Maximum tool calls (${MAX_CONSECUTIVE_TOOLS}) exceeded. Process aborted to prevent infinite loops.`;
                        isDone = true;
                    }
                    // -------------------

                    if (!isDone) {
                        currentPayload = {
                            prompt: prompt,
                            model: model,
                            workspace: workspacePath,
                            tool_history: toolHistory,
                            chat_history: currentPayload.chat_history // Keep history if any
                        };
                    }
                }
                // Scenario B: AI is finished and gives us the final text
                else if (data.type === 'message') {
                    consecutiveToolCalls = 0; // Reset tool counter if it actually spoke to us
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
            webviewView.webview.postMessage({ type: 'generationFinished' });
            webviewView.webview.postMessage({ type: 'addMessage', text: finalResponseText, isUser: false, isError: this._abortRequested });

            // 5. Update persistent history for subsequent turns
            this._chatHistory.push({ role: 'user', text: prompt });
            this._chatHistory.push({ role: 'bot', text: finalResponseText });

        } catch (error: any) {
            console.error('Fetch error:', error);
            webviewView.webview.postMessage({ type: 'removeLoading' });
            webviewView.webview.postMessage({ type: 'generationFinished' });
            webviewView.webview.postMessage({ type: 'addMessage', text: `Error: Failed to connect or execute feature.`, isUser: false, isError: true });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const fs = require('fs');

        // Path to the webview directory
        const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview');

        // Read the HTML template and CSS separately
        const htmlPath = path.join(webviewPath, 'index.html');
        const cssPath = path.join(webviewPath, 'style.css');
        const scriptPathOnDisk = vscode.Uri.file(path.join(webviewPath, 'main.js'));

        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const cssContent = fs.readFileSync(cssPath, 'utf8');

        // Map the JS file to a Webview-safe URI
        const scriptUri = webview.asWebviewUri(scriptPathOnDisk);

        // Generate a random nonce for CSP
        const nonce = getNonce();

        // Inline the CSS and inject URIs
        htmlContent = htmlContent.replace('{{inlineStyles}}', cssContent);
        htmlContent = htmlContent.replace(/{{scriptUri}}/g, scriptUri.toString());
        htmlContent = htmlContent.replace(/{{nonce}}/g, nonce);

        return htmlContent;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
