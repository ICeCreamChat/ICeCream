/**
 * 智能约束对话UI视图
 * 聊天式交互界面
 */

/**
 * 渲染约束对话窗口
 */
export function renderConstraintChatDialog(state = {}) {
    const chat = state.constraintChat;
    if (!chat || !chat.open) return '';

    const messages = chat.messages || [];
    const loading = chat.loading;
    const error = chat.error;
    const completed = chat.completed;

    return `
        <div class="tt-constraint-chat-overlay" onclick="if(event.target === this) controller.closeConstraintChat()">
            <div class="tt-constraint-chat-dialog">
                <div class="tt-constraint-chat-header">
                    <div>
                        <i data-lucide="message-circle"></i>
                        <span>智能约束对话优化</span>
                    </div>
                    <button
                        class="tt-icon-btn"
                        onclick="controller.closeConstraintChat()"
                        aria-label="关闭对话">
                        <i data-lucide="x"></i>
                    </button>
                </div>

                <div class="tt-constraint-chat-messages" id="tt-chat-messages">
                    ${messages.map(msg => renderChatMessage(msg)).join('')}

                    ${loading ? `
                        <div class="tt-chat-message tt-chat-message--assistant tt-chat-message--loading">
                            <div class="tt-chat-avatar">
                                <i data-lucide="bot"></i>
                            </div>
                            <div class="tt-chat-bubble">
                                <div class="tt-typing-indicator">
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                </div>
                            </div>
                        </div>
                    ` : ''}

                    ${error ? `
                        <div class="tt-chat-error">
                            <i data-lucide="alert-circle"></i>
                            <span>${escapeHtml(error)}</span>
                        </div>
                    ` : ''}
                </div>

                <div class="tt-constraint-chat-footer">
                    ${completed ? `
                        <div class="tt-chat-completion-hint">
                            <i data-lucide="check-circle"></i>
                            <span>约束优化已完成！点击"确认导入"应用这些约束。</span>
                        </div>
                    ` : ''}

                    <div class="tt-constraint-chat-input-area">
                        <textarea
                            id="tt-chat-input"
                            class="tt-constraint-chat-input"
                            placeholder="说说你的想法，比如"张老师的课太多了""
                            rows="1"
                            oninput="controller.updateConstraintChatInput(this.value); autoResizeTextarea(this)"
                            onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); controller.sendConstraintChatMessage(); }"
                            ${loading ? 'disabled' : ''}
                        >${escapeHtml(chat.inputText || '')}</textarea>

                        <button
                            class="tt-btn tt-btn--primary tt-btn--icon"
                            onclick="controller.sendConstraintChatMessage()"
                            ${loading || !chat.inputText?.trim() ? 'disabled' : ''}
                            aria-label="发送消息">
                            <i data-lucide="send"></i>
                        </button>
                    </div>

                    <div class="tt-chat-hints">
                        <span class="tt-chat-hint">💡 试试说："能解释一下这些约束吗？"</span>
                        <span class="tt-chat-hint">💡 或者："王老师每天最多4节课"</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 渲染单条聊天消息
 */
function renderChatMessage(message) {
    const isUser = message.role === 'user';
    const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
    });

    return `
        <div class="tt-chat-message tt-chat-message--${escapeAttr(message.role)}">
            ${!isUser ? `
                <div class="tt-chat-avatar">
                    <i data-lucide="bot"></i>
                </div>
            ` : ''}

            <div class="tt-chat-bubble">
                <div class="tt-chat-content">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div>
                <div class="tt-chat-time">${time}</div>
            </div>

            ${isUser ? `
                <div class="tt-chat-avatar tt-chat-avatar--user">
                    <i data-lucide="user"></i>
                </div>
            ` : ''}
        </div>
    `;
}

/**
 * 自动调整textarea高度
 */
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

// 在约束复核界面添加"与AI讨论"按钮
export function renderConstraintOptimizeButton() {
    return `
        <button
            class="tt-btn tt-btn--secondary"
            onclick="controller.startConstraintConversation()"
            title="通过自然语言与AI讨论优化约束">
            <i data-lucide="message-circle"></i>
            <span>💬 与AI讨论优化</span>
        </button>
    `;
}
