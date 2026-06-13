/**
 * 智能约束对话优化 - 前端控制器扩展
 * 支持用户通过自然语言与AI讨论优化约束
 */

// 在controller.js中添加以下方法：

/**
 * 开启约束对话优化
 */
async startConstraintConversation() {
    const constraints = this.state.ruleReview?.draftRows || [];
    if (!constraints.length) {
        this.setMessage('没有可优化的约束。请先解析约束。');
        return;
    }

    try {
        this.state.constraintChat = {
            loading: true,
            open: true,
            messages: [],
            conversationId: null,
            inputText: ''
        };
        this.render();

        const result = await requestTimetable('/constraints/chat/init', {
            method: 'POST',
            body: JSON.stringify({
                constraints,
                project: this.state.project
            })
        });

        this.state.constraintChat = {
            ...this.state.constraintChat,
            loading: false,
            conversationId: result.conversationId,
            messages: [{
                role: 'assistant',
                content: result.welcomeMessage,
                timestamp: Date.now()
            }]
        };
        this.render();
    } catch (error) {
        this.state.constraintChat = {
            ...this.state.constraintChat,
            loading: false,
            error: normalizeApiError(error).message
        };
        this.render();
    }
}

/**
 * 发送对话消息
 */
async sendConstraintChatMessage() {
    const chat = this.state.constraintChat || {};
    const message = (chat.inputText || '').trim();

    if (!message) {
        return;
    }

    if (!chat.conversationId) {
        this.setMessage('对话会话已过期，请重新开始。');
        return;
    }

    // 添加用户消息到界面
    this.state.constraintChat = {
        ...chat,
        inputText: '',
        messages: [
            ...(chat.messages || []),
            {
                role: 'user',
                content: message,
                timestamp: Date.now()
            }
        ],
        loading: true
    };
    this.render();

    try {
        const result = await requestTimetable('/constraints/chat/message', {
            method: 'POST',
            body: JSON.stringify({
                conversationId: chat.conversationId,
                message
            })
        });

        // 更新约束
        if (result.constraints) {
            this.state.ruleReview = {
                ...this.state.ruleReview,
                draftRows: result.constraints
            };
        }

        // 添加AI响应
        this.state.constraintChat = {
            ...this.state.constraintChat,
            loading: false,
            messages: [
                ...this.state.constraintChat.messages,
                {
                    role: 'assistant',
                    content: result.message,
                    timestamp: Date.now()
                }
            ],
            completed: result.completed
        };

        // 如果对话完成，显示提示
        if (result.completed) {
            this.setMessage('约束优化完成！您可以查看并确认导入。');
        }

        this.render();
    } catch (error) {
        this.state.constraintChat = {
            ...this.state.constraintChat,
            loading: false,
            error: normalizeApiError(error).message
        };
        this.render();
    }
}

/**
 * 关闭约束对话
 */
closeConstraintChat() {
    if (this.state.constraintChat?.conversationId) {
        // 可选：调用finalize端点
        requestTimetable(`/constraints/chat/${this.state.constraintChat.conversationId}/finalize`, {
            method: 'POST'
        }).catch(() => {});
    }

    this.state.constraintChat = null;
    this.render();
}

/**
 * 更新对话输入
 */
updateConstraintChatInput(text) {
    this.state.constraintChat = {
        ...this.state.constraintChat,
        inputText: text
    };
}

// 添加到controller类的导出
export {
    // ... 现有方法
    startConstraintConversation,
    sendConstraintChatMessage,
    closeConstraintChat,
    updateConstraintChatInput
};
