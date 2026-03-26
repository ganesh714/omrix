import * as vscode from 'vscode';

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
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src http://localhost:8000;">
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
        .bot-message p {
            margin: 0 0 8px 0;
        }
        
        .bot-message p:last-child {
            margin-bottom: 0;
        }

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

        pre code {
            padding: 0;
            background-color: transparent;
            border: none;
        }

        .loading {
            font-style: italic;
            opacity: 0.7;
        }

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

        #prompt-input:focus {
            border-color: var(--vscode-focusBorder);
        }

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

        #send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        #send-button:active {
            opacity: 0.8;
        }
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
            const chatHistory = document.getElementById('chat-history');
            const promptInput = document.getElementById('prompt-input');
            const sendButton = document.getElementById('send-button');
            const modelSelector = document.getElementById('model-selector');

            const API_URL = 'http://localhost:8000/chat';

            function appendMessage(text, isUser = false, isLoading = false) {
                const msgDiv = document.createElement('div');
                msgDiv.className = 'message ' + (isUser ? 'user-message' : 'bot-message');
                
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

            async function sendPrompt() {
                const text = promptInput.value.trim();
                const model = modelSelector.value;
                if (!text) return;

                promptInput.value = '';
                appendMessage(text, true);
                appendMessage('Thinking...', false, true);

                try {
                    const response = await fetch(API_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ prompt: text, model: model })
                    });

                    if (!response.ok) throw new Error('Server error');

                    const data = await response.json();
                    document.getElementById('loading-indicator')?.remove();
                    appendMessage(data.response || "No response.", false);

                } catch (error) {
                    console.error('Fetch error:', error);
                    document.getElementById('loading-indicator')?.remove();
                    appendMessage('Error: Failed to connect.', false);
                }
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
