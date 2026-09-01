// Main Application
class ClaudeWebApp {
    constructor() {
        this.currentModel = localStorage.getItem('claude_model') || 'claude-3-5-sonnet-20241022';
        this.conversations = [];
        this.currentConversation = null;
        this.streaming = localStorage.getItem('claude_streaming') !== 'false';
        this.api = window.claudeAPI;
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.updateModelHeader();
        this.loadSettings();
        this.checkHealth();
    }

    bindEvents() {
        // New chat button
        document.getElementById('new-chat-btn')?.addEventListener('click', () => {
            this.createNewConversation();
        });

        // Settings button
        document.getElementById('settings-btn')?.addEventListener('click', () => {
            this.openSettings();
        });

        // Close settings
        document.getElementById('close-settings')?.addEventListener('click', () => {
            this.closeSettings();
        });

        // Save settings
        document.getElementById('save-settings')?.addEventListener('click', () => {
            this.saveSettings();
        });

        // Send button
        const sendBtn = document.getElementById('send-btn');
        const messageInput = document.getElementById('message-input');
        
        if (sendBtn && messageInput) {
            messageInput.addEventListener('input', () => {
                sendBtn.disabled = !messageInput.value.trim();
            });

            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey && messageInput.value.trim()) {
                    e.preventDefault();
                    sendBtn.click();
                }
            });

            sendBtn.addEventListener('click', () => {
                this.sendMessage();
            });
        }

        // Model select change
        document.getElementById('model-select')?.addEventListener('change', (e) => {
            this.currentModel = e.target.value;
            localStorage.setItem('claude_model', this.currentModel);
            this.updateModelHeader();
        });

        // Fetch models button
        document.getElementById('fetch-models-btn')?.addEventListener('click', () => {
            this.refreshModels();
        });

        // Modal click outside
        window.addEventListener('click', (e) => {
            if (e.target === document.getElementById('settings-modal')) {
                this.closeSettings();
            }
        });
    }

    async createNewConversation() {
        const conv = {
            id: Date.now().toString(),
            title: '新建对话',
            messages: [],
            createdAt: new Date().toISOString()
        };
        
        this.conversations.unshift(conv);
        this.currentConversation = conv;
        
        this.renderConversationList();
        this.clearMessages();
        this.addWelcomeMessage();
    }

    sendMessage() {
        const input = document.getElementById('message-input');
        const message = input.value.trim();
        
        if (!message) return;
        
        const userMsg = {
            role: 'user',
            content: message,
            timestamp: new Date().toISOString()
        };
        
        this.addMessage(userMsg.role, userMsg.content);
        
        if (this.currentConversation) {
            this.currentConversation.messages.push(userMsg);
        }
        
        input.value = '';
        document.getElementById('send-btn').disabled = true;
        
        this.sendToAPI();
    }

    async sendToAPI() {
        const messagesContainer = document.getElementById('messages-container');
        const typingIndicator = this.addTypingIndicator();
        
        try {
            const messages = this.currentConversation ? 
                this.currentConversation.messages : 
                [{ role: 'user', content: document.querySelector('.message.user:last-child')?.textContent || '' }];
            
            const model = this.currentModel;
            const response = await this.api.sendMessage(messages, model, this.streaming);
            
            if (this.streaming) {
                await this.handleStreamResponse(response, typingIndicator);
            } else {
                const data = await response.json();
                const content = data.choices[0].message.content;
                this.updateMessageElement(typingIndicator, content);
            }
            
        } catch (error) {
            console.error('Error:', error);
            this.updateMessageElement(typingIndicator, '抱歉，我遇到了一些错误，请稍后重试。');
        }
        
        input.value = '';
        document.getElementById('send-btn').disabled = true;
    }

    async handleStreamResponse(response, messageElement) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ') && line.trim() !== 'data: ') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.choices && data.choices[0]) {
                            const delta = data.choices[0].delta;
                            if (delta && delta.content) {
                                content += delta.content;
                                this.updateMessageElement(messageElement, content);
                            }
                        }
                    } catch (e) {
                        // Skip parsing errors
                    }
                }
            }
        }
        
        if (this.currentConversation) {
            this.currentConversation.messages.push({
                role: 'assistant',
                content: content,
                timestamp: new Date().toISOString()
            });
        }
    }

    addMessage(role, content) {
        const messagesContainer = document.getElementById('messages-container');
        const messageDiv = document.createElement('div');
        
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        messageDiv.className = `message ${role}`;
        messageDiv.innerHTML = `
            <div class="message-content">${this.formatContent(content)}</div>
            <div class="message-time">${time}</div>
        `;
        
        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        return messageDiv;
    }

    addTypingIndicator() {
        const messagesContainer = document.getElementById('messages-container');
        const typingDiv = document.createElement('div');
        
        typingDiv.className = 'message assistant';
        typingDiv.id = 'assistant-typing';
        typingDiv.innerHTML = `
            <div class="message-content">
                <div class="typing-indicator">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            </div>
        `;
        
        messagesContainer.appendChild(typingDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        return typingDiv;
    }

    updateMessageElement(element, content) {
        const contentEl = element.querySelector('.message-content');
        if (contentEl) {
            contentEl.innerHTML = `<div class="typing-indicator hidden"></div>`;
            element.classList.remove('typing');
            contentEl.innerHTML = this.formatContent(content);
        }
        
        const messagesContainer = document.getElementById('messages-container');
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    formatContent(content) {
        if (!content) return '';
        
        // Basic markdown-like formatting
        return content
            .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    }

    clearMessages() {
        const container = document.getElementById('messages-container');
        if (container) {
            container.innerHTML = '';
        }
    }

    addWelcomeMessage() {
        const container = document.getElementById('messages-container');
        if (container) {
            container.innerHTML = `
                <div class="welcome-screen">
                    <h3>👋 ${this.currentModel.includes('opus-4') || this.currentModel.includes('sonnet-4') ? 'Claude 4' : 'Claude'}</h3>
                    <p>输入消息开始对话吧~</p>
                    <div class="quick-actions">
                        <button class="quick-action" onclick="quickActions.explainCode()">
                            解释代码
                        </button>
                        <button class="quick-action" onclick="quickActions.translate()">
                            翻译为英文
                        </button>
                        <button class="quick-action" onclick="quickActions.debugCode()">
                            调试代码
                        </button>
                    </div>
                </div>
            `;
        }
    }

    renderConversationList() {
        const list = document.getElementById('conversation-list');
        if (! list) return;
        
        list.innerHTML = '';
        
        this.conversations.forEach(conv => {
            const item = document.createElement('div');
            item.className = `conversation-item ${this.currentConversation && this.currentConversation.id === conv.id ? 'active' : ''}`;
            item.innerHTML = `
                <div class="conversation-title">${conv.title}</div>
                <div class="conversation-date">${new Date(conv.createdAt).toLocaleString()}</div>
            `;
            item.addEventListener('click', () => {
                this.currentConversation = conv;
                this.renderMessages();
                this.renderConversationList();
            });
            list.appendChild(item);
        });
    }

    renderMessages() {
        const container = document.getElementById('messages-container');
        if (!container) return;
        
        container.innerHTML = '';
        
        if (this.currentConversation && this.currentConversation.messages.length > 0) {
            this.currentConversation.messages.forEach(msg => {
                this.addMessage(msg.role, msg.content);
            });
        } else {
            this.addWelcomeMessage();
        }
    }

    updateModelHeader() {
        const header = document.getElementById('current-model');
        if (header) {
            const modelNames = {
                'claude-sonnet-4-20250514': 'Claude 4 Sonnet',
                'claude-opus-4-20250514': 'Claude 4 Opus',
                'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
                'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
                'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
                'claude-3-5-sonnet-20240620': 'Claude 3.5 Sonnet',
                'claude-3-opus-20240229': 'Claude 3 Opus',
                'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
                'claude-3-haiku-20240307': 'Claude 3 Haiku'
            };
            header.textContent = modelNames[this.currentModel] || this.currentModel;
        }
    }

    loadSettings() {
        const apiKey = localStorage.getItem('claude_api_key');
        if (apiKey) {
            document.getElementById('api-key-input').value = apiKey;
        }
        
        document.getElementById('streaming-toggle').checked = this.streaming;
        
        const proxy = localStorage.getItem('claude_proxy');
        if (proxy) {
            document.getElementById('proxy-input').value = proxy;
        }
    }

    saveSettings() {
        const apiKey = document.getElementById('api-key-input')?.value || '';
        const streaming = document.getElementById('streaming-toggle')?.checked || false;
        const proxy = document.getElementById('proxy-input')?.value || '';
        
        localStorage.setItem('claude_api_key', apiKey);
        localStorage.setItem('claude_streaming', String(streaming));
        localStorage.setItem('claude_proxy', proxy);
        
        this.api.apiKey = apiKey;
        this.api.proxy = proxy;
        this.streaming = streaming;
    }

    openSettings() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.classList.remove('hidden');
        }
    }

    closeSettings() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    async refreshModels() {
        const btn = document.getElementById('fetch-models-btn');
        const originalText = btn.textContent;
        btn.textContent = '刷新中...';
        btn.disabled = true;
        
        try {
            const models = await this.api.fetchModels();
            if (models.length > 0) {
                const modelSelect = document.getElementById('model-select');
                if (modelSelect) {
                    modelSelect.innerHTML = '';
                    models.forEach(model => {
                        const opt = document.createElement('option');
                        opt.value = model.id;
                        opt.textContent = model.name || model.id;
                        modelSelect.appendChild(opt);
                    });
                    modelSelect.value = this.currentModel;
                }
                this.showToast('模型列表更新成功');
            }
        } catch (error) {
            this.showToast('刷新模型失败，使用默认列表');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }

    async checkHealth() {
        const isHealthy = await this.api.healthCheck();
        const statusEl = document.querySelector('.status-indicator');
        if (statusEl) {
            statusEl.innerHTML = `
                <span class="status-dot ${isHealthy ? '' : 'offline'}"></span>
                ${isHealthy ? '在线' : '离线'}
            `;
        }
    }

    showToast(message) {
        // Simple toast implementation
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            z-index: 1000;
            font-size: 0.9rem;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 3000);
    }
}

// Quick actions
const quickActions = {
    explainCode: () => {
        const input = document.getElementById('message-input');
        if (input) {
            input.value = '请解释一下这段代码的功能和逻辑';
            document.getElementById('send-btn').disabled = false;
        }
    },
    
    translate: () => {
        const input = document.getElementById('message-input');
        if (input) {
            input.value = '请将以下文本翻译为英文';
            document.getElementById('send-btn').disabled = false;
        }
    },
    
    debugCode: () => {
        const input = document.getElementById('message-input');
        if (input) {
            input.value = '请帮我调试这段代码，找出可能存在的问题';
            document.getElementById('send-btn').disabled = false;
        }
    }
};

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.claudeApp = new ClaudeWebApp();
});