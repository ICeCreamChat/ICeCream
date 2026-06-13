function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function formatMessageTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
    });
}

function renderChatMessage(message = {}) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const isUser = role === 'user';
    const time = formatMessageTime(message.timestamp);

    return `
        <div class="tt-chat-message tt-chat-message--${escapeAttr(role)}">
            ${!isUser ? `
                <div class="tt-chat-avatar" aria-hidden="true">
                    <i data-lucide="bot"></i>
                </div>
            ` : ''}
            <div class="tt-chat-bubble">
                <div class="tt-chat-content">${escapeHtml(message.content || '').replace(/\n/g, '<br>')}</div>
                ${time ? `<div class="tt-chat-time">${escapeHtml(time)}</div>` : ''}
            </div>
            ${isUser ? `
                <div class="tt-chat-avatar tt-chat-avatar--user" aria-hidden="true">
                    <i data-lucide="user"></i>
                </div>
            ` : ''}
        </div>
    `;
}

function renderReviewContext(context = {}) {
    const groups = context.groups || [];
    if (!groups.length) return '';
    const prompts = context.suggestedPrompts || [];
    return `
        <section class="tt-chat-review-context" aria-label="当前复核重点">
            <div class="tt-chat-review-title">
                <i data-lucide="list-checks"></i>
                <strong>当前复核重点</strong>
            </div>
            <div class="tt-chat-context-grid">
                ${groups.slice(0, 5).map(group => `
                    <article class="tt-chat-context-item tt-chat-context-item--${escapeAttr(group.type || 'issue')}">
                        <div>
                            <strong>${escapeHtml(group.label || '待处理')}</strong>
                            <b>${escapeHtml(group.count || 0)}</b>
                        </div>
                        ${(group.examples || []).length ? `
                            <p>${escapeHtml(group.examples[0])}</p>
                        ` : ''}
                    </article>
                `).join('')}
            </div>
            ${prompts.length ? `
                <div class="tt-chat-suggested-prompts" aria-label="建议讨论动作">
                    ${prompts.slice(0, 4).map(prompt => `
                        <button
                            class="tt-chat-suggested-prompt"
                            type="button"
                            data-action="constraint-chat-suggest"
                            data-constraint-chat-suggest="${escapeAttr(prompt)}">
                            ${escapeHtml(prompt)}
                        </button>
                    `).join('')}
                </div>
            ` : ''}
        </section>
    `;
}

export function renderConstraintChatDialog(state = {}) {
    const chat = state.constraintChat;
    if (!chat?.open) return '';

    const messages = chat.messages || [];
    const loading = Boolean(chat.loading);
    const inputText = chat.inputText || '';
    const canSend = !loading && inputText.trim().length > 0;
    const reviewContext = chat.reviewContext || {};

    return `
        <div class="tt-constraint-chat-overlay" data-constraint-chat-overlay>
            <section class="tt-constraint-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-constraint-chat-title">
                <header class="tt-constraint-chat-header">
                    <div>
                        <i data-lucide="message-circle"></i>
                        <span id="tt-constraint-chat-title">智能约束对话优化</span>
                    </div>
                    <button class="tt-icon-btn" type="button" data-action="constraint-chat-close" aria-label="关闭对话">
                        <i data-lucide="x"></i>
                    </button>
                </header>

                <div class="tt-constraint-chat-messages" id="tt-chat-messages" aria-live="polite">
                    ${renderReviewContext({
                        ...reviewContext,
                        suggestedPrompts: chat.suggestedPrompts?.length ? chat.suggestedPrompts : reviewContext.suggestedPrompts,
                    })}
                    ${messages.map(message => renderChatMessage(message)).join('')}
                    ${loading ? `
                        <div class="tt-chat-message tt-chat-message--assistant tt-chat-message--loading">
                            <div class="tt-chat-avatar" aria-hidden="true">
                                <i data-lucide="bot"></i>
                            </div>
                            <div class="tt-chat-bubble">
                                <div class="tt-typing-indicator" aria-label="正在生成回复">
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                </div>
                            </div>
                        </div>
                    ` : ''}
                    ${chat.error ? `
                        <div class="tt-chat-error">
                            <i data-lucide="alert-circle"></i>
                            <span>${escapeHtml(chat.error)}</span>
                        </div>
                    ` : ''}
                </div>

                <footer class="tt-constraint-chat-footer">
                    ${chat.completed ? `
                        <div class="tt-chat-completion-hint">
                            <i data-lucide="check-circle"></i>
                            <span>约束优化已完成，可以确认生效或继续调整。</span>
                        </div>
                    ` : ''}

                    <div class="tt-constraint-chat-input-area">
                        <textarea
                            id="tt-chat-input"
                            class="tt-constraint-chat-input"
                            data-constraint-chat-input
                            data-action="constraint-chat-input"
                            placeholder="说说你的想法，例如：解释这些约束，或把王老师每天最多改成 4 节"
                            rows="1"
                            ${loading ? 'disabled' : ''}
                        >${escapeHtml(inputText)}</textarea>
                        <button
                            class="tt-btn tt-btn--primary tt-btn--icon"
                            type="button"
                            data-action="constraint-chat-send"
                            ${canSend ? '' : 'disabled'}
                            aria-label="发送消息">
                            <i data-lucide="send"></i>
                        </button>
                    </div>

                    <div class="tt-chat-hints">
                        <span class="tt-chat-hint">优先回答当前复核重点，例如统一节次、过滤超出范围节次、展开全部班级。</span>
                        <span class="tt-chat-hint">也可以直接说：把缺少节次的约束统一设为周一到周五第7节。</span>
                    </div>
                </footer>
            </section>
        </div>
    `;
}

export function renderConstraintOptimizeButton({ disabled = false } = {}) {
    return `
        <button
            class="tt-btn tt-btn--secondary"
            type="button"
            data-action="constraint-chat-start"
            ${disabled ? 'disabled' : ''}
            title="通过对话解释和优化当前约束">
            <i data-lucide="message-circle"></i>
            <span>AI 讨论优化</span>
        </button>
    `;
}
