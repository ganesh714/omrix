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
