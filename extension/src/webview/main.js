(function() {
    const vscode = acquireVsCodeApi();
    const chatHistory = document.getElementById('chat-history');
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const modelSelector = document.getElementById('model-selector');

    let currentBotContainer = null;
    let currentStepsDetails = null;
    let isGenerating = false;

    const SEND_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.354 1.146a.5.5 0 0 0-.708 0l-6 6a.5.5 0 0 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 1 0V2.707l5.146 5.147a.5.5 0 0 0 .708-.708l-6-6z"/></svg>`;
    const STOP_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;

    // Listen for messages from the extension context
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'askApproval':
                showDiffApproval(message.id, message.target, message.oldText, message.newText);
                chatHistory.scrollTop = chatHistory.scrollHeight;
                break;
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
                stepDiv.innerHTML = `<span>${message.icon}</span> <span>${message.action}:</span> <code>${message.target}</code>`;
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
            case 'generationFinished':
                setGeneratingState(false);
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

    function showDiffApproval(id, target, oldText, newText) {
        const block = document.createElement('div');
        block.className = 'diff-approval-block';
        block.dataset.id = id;

        // Header showing which file is being changed
        const label = document.createElement('div');
        label.className = 'diff-file-label';
        label.innerHTML = `<span>✏️</span> <code>${target}</code>`;
        block.appendChild(label);

        // Diff body: show removed lines (old) then added lines (new)
        const body = document.createElement('div');
        body.className = 'diff-body';

        const renderLines = (text, cssClass, marker) => {
            text.split('\n').forEach(line => {
                const lineEl = document.createElement('div');
                lineEl.className = `diff-line ${cssClass}`;
                lineEl.innerHTML = `<span class="diff-line-marker">${marker}</span><span>${escapeHtml(line)}</span>`;
                body.appendChild(lineEl);
            });
        };

        renderLines(oldText, 'diff-line-removed', '-');
        renderLines(newText, 'diff-line-added', '+');
        block.appendChild(body);

        // Action buttons row
        const actions = document.createElement('div');
        actions.className = 'diff-actions';

        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'diff-btn diff-btn-accept';
        acceptBtn.textContent = 'Accept';

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'diff-btn diff-btn-reject';
        rejectBtn.textContent = 'Reject';

        const resolveBlock = (accepted) => {
            acceptBtn.disabled = true;
            rejectBtn.disabled = true;
            // Replace action row with resolved label
            actions.innerHTML = '';
            const resolved = document.createElement('div');
            resolved.className = 'diff-resolved-label';
            resolved.textContent = accepted ? '✅ Edit accepted' : '❌ Edit rejected';
            block.appendChild(resolved);

            vscode.postMessage({ type: accepted ? 'approveEdit' : 'rejectEdit', id });
        };

        acceptBtn.addEventListener('click', () => resolveBlock(true));
        rejectBtn.addEventListener('click', () => resolveBlock(false));

        actions.appendChild(acceptBtn);
        actions.appendChild(rejectBtn);
        block.appendChild(actions);

        chatHistory.appendChild(block);
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function setGeneratingState(generating) {
        isGenerating = generating;
        if (generating) {
            sendButton.innerHTML = STOP_ICON;
            sendButton.title = "Stop generating";
            sendButton.classList.add('stop-button');
        } else {
            sendButton.innerHTML = SEND_ICON;
            sendButton.title = "Send message";
            sendButton.classList.remove('stop-button');
        }
    }

    function handleSendOrStop() {
        if (isGenerating) {
            vscode.postMessage({ type: 'abortGeneration' });
            setGeneratingState(false);
        } else {
            sendPrompt();
        }
    }

    function sendPrompt() {
        const text = promptInput.value.trim();
        const model = modelSelector.value;
        if (!text || isGenerating) return;

        setGeneratingState(true);
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

    sendButton.addEventListener('click', handleSendOrStop);
    promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isGenerating) {
                sendPrompt();
            }
        }
    });
    
    // Auto resize text area
    promptInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    promptInput.focus();
})();
