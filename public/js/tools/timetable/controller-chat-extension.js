import { normalizeApiError, requestTimetable } from './api.js';

function currentRuleDraftRows(state = {}) {
    const reviewRows = state.ruleReview?.draftRows || [];
    return reviewRows.length ? reviewRows : (state.pendingRules || []);
}

function normalizeChatState(chat = {}) {
    return {
        open: true,
        loading: false,
        conversationId: null,
        inputText: '',
        messages: [],
        error: null,
        completed: false,
        ...chat,
    };
}

function appendChatMessage(chat, role, content) {
    return {
        ...chat,
        messages: [
            ...(chat.messages || []),
            {
                role,
                content,
                timestamp: Date.now(),
            },
        ],
    };
}

function applyConstraintDrafts(state, constraints) {
    if (!Array.isArray(constraints)) return;

    state.ruleReview = {
        ...(state.ruleReview || {}),
        draftRows: constraints,
    };
    state.pendingRules = constraints;
}

export const constraintChatControllerMethods = {
    async startConstraintConversation() {
        const constraints = currentRuleDraftRows(this.state);
        if (!constraints.length) {
            this.setMessage('没有可优化的约束。请先解析约束。');
            return;
        }

        this.state.constraintChat = normalizeChatState({
            loading: true,
            messages: [],
            inputText: '',
            error: null,
            completed: false,
        });
        this.render();

        try {
            const result = await requestTimetable('/constraints/chat/init', {
                method: 'POST',
                body: JSON.stringify({
                    constraints,
                    project: this.state.project || {},
                }),
            });

            this.state.constraintChat = normalizeChatState({
                ...this.state.constraintChat,
                loading: false,
                conversationId: result.conversationId,
                messages: [{
                    role: 'assistant',
                    content: result.welcomeMessage || '我可以帮你解释和优化这些约束。',
                    timestamp: Date.now(),
                }],
                error: null,
            });
            applyConstraintDrafts(this.state, result.constraints);
            this.render();
        } catch (error) {
            const normalized = normalizeApiError(error);
            this.state.constraintChat = normalizeChatState({
                ...this.state.constraintChat,
                loading: false,
                error: normalized.message,
            });
            this.render();
        }
    },

    async sendConstraintChatMessage(messageOverride = null) {
        const chat = normalizeChatState(this.state.constraintChat);
        if (chat.loading) return;

        const message = String(messageOverride ?? chat.inputText ?? '').trim();
        if (!message) return;

        if (!chat.conversationId) {
            this.state.constraintChat = normalizeChatState({
                ...chat,
                error: '对话会话不存在或已过期，请重新开始。',
            });
            this.render();
            return;
        }

        this.state.constraintChat = normalizeChatState({
            ...appendChatMessage(chat, 'user', message),
            inputText: '',
            loading: true,
            error: null,
        });
        this.render();

        try {
            const result = await requestTimetable('/constraints/chat/message', {
                method: 'POST',
                body: JSON.stringify({
                    conversationId: chat.conversationId,
                    message,
                }),
            });

            applyConstraintDrafts(this.state, result.constraints);

            this.state.constraintChat = normalizeChatState({
                ...appendChatMessage(this.state.constraintChat, 'assistant', result.message || '已收到。'),
                loading: false,
                completed: Boolean(result.completed),
                error: null,
            });

            if (result.completed) {
                this.state.message = '约束优化完成，可以确认生效或继续调整。';
            }

            this.render();
        } catch (error) {
            const normalized = normalizeApiError(error);
            this.state.constraintChat = normalizeChatState({
                ...this.state.constraintChat,
                loading: false,
                error: normalized.message,
            });
            this.render();
        }
    },

    closeConstraintChat() {
        const chat = this.state.constraintChat;
        if (chat?.conversationId) {
            requestTimetable(`/constraints/chat/${encodeURIComponent(chat.conversationId)}/finalize`, {
                method: 'POST',
            }).then(result => {
                applyConstraintDrafts(this.state, result.constraints);
            }).catch(() => {});
        }

        this.state.constraintChat = chat ? { ...chat, open: false, loading: false } : null;
        this.render();
    },

    updateConstraintChatInput(text) {
        this.state.constraintChat = normalizeChatState({
            ...(this.state.constraintChat || {}),
            inputText: text,
        });
    },
};
