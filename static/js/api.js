// API Client
class ClaudeAPI {
    constructor() {
        this.baseURL = '/v1';
        this.apiKey = localStorage.getItem('claude_api_key') || '';
        this.proxy = localStorage.getItem('claude_proxy') || '';
        this.responseFormat = localStorage.getItem('claude_response_format') || 'openai';
    }

    async fetchModels() {
        try {
            const response = await fetch(`${this.baseURL}/models`, {
                headers: {
                    'Authorization': this.apiKey ? `Bearer ${this.apiKey}` : ''
                }
            });
            if (!response.ok) throw new Error('Failed to fetch models');
            const data = await response.json();
            return data.data || [];
        } catch (error) {
            console.error('Error fetching models:', error);
            return this.getDefaultModels();
        }
    }

    getDefaultModels() {
        return [
            { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet' },
            { id: 'claude-opus-4-20250514', name: 'Claude 4 Opus' },
            { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
            { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
            { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet' },
            { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' }
        ];
    }

    async sendMessage(messages, model, stream = true) {
        const responseFormat = this.responseFormat || 'openai';
        let endpoint = '/v1/chat/completions';
        let payload = {};

        if (responseFormat === 'claude') {
            // Claude native format
            endpoint = '/v1/messages';
            payload = {
                model: model,
                messages: messages,
                stream: stream,
                max_tokens: 4096
            };
        } else {
            // OpenAI compatible format
            payload = {
                model: model,
                messages: messages,
                stream: stream
            };
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': this.apiKey ? `Bearer ${this.apiKey}` : ''
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'API request failed');
        }

        return { response, format: responseFormat };
    }

    async healthCheck() {
        try {
            const response = await fetch('/health/health');
            return response.ok;
        } catch (error) {
            return false;
        }
    }
}

// Export singleton
const api = new ClaudeAPI();
window.claudeAPI = api;