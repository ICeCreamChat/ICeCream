/**
 * ICeCream - ApiClient Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles all server communication (DeepSeek, OCR, TTS).
 */
const ApiClient = {
    /**
     * Sends a message to the backend analysis endpoint.
     * @param {FormData} formData - valid FormData object
     * @returns {Promise<object>} API response
     */
    async analyze(formData) {
        const response = await fetch('/api/solve', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    },

    /**
     * Sends a chat message to the backend.
     * @param {Array} messages - Chat history
     * @param {string} model - Model name
     * @returns {Promise<object>} API response
     */
    async chat(messages, model = 'deepseek-chat') {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages,
                model,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`Chat API Error: ${response.status}`);
        }
        return await response.json();
    }
};

// Expose to window
window.ApiClient = ApiClient;
