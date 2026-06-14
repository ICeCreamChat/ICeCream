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

const issueGuides = {
    missing_slots: {
        icon: 'calendar-clock',
        title: '缺少节次',
        action: '告诉智能助手要补到周几、第几节，或点推荐按钮让它统一处理。',
        tone: 'warning',
    },
    missing_info: {
        icon: 'help-circle',
        title: '需要补充',
        action: '先补清楚对象、节次或限制值，否则规则不会真正生效。',
        tone: 'warning',
    },
    clarifying_questions: {
        icon: 'help-circle',
        title: '需要回答',
        action: '按问题逐条回答，不需要写排课术语。',
        tone: 'warning',
    },
    out_of_range_slots: {
        icon: 'calendar-x',
        title: '超出范围',
        action: '当前项目没有这些节次，建议让智能助手过滤或改成现有节次。',
        tone: 'danger',
    },
    all_classes_unmatched: {
        icon: 'users',
        title: '全部班级未匹配',
        action: '让智能助手展开为当前项目里的具体班级，避免规则找不到对象。',
        tone: 'warning',
    },
    need_review: {
        icon: 'edit-3',
        title: '需要你确认',
        action: '这些规则能理解，但还需要你确认对象、节次或置信度。',
        tone: 'review',
    },
    unsupported: {
        icon: 'lightbulb',
        title: '暂不支持',
        action: '它们会作为建议保留，不会直接写进排课规则。',
        tone: 'muted',
    },
    warnings: {
        icon: 'info',
        title: '解析提醒',
        action: '这类提示通常不阻塞生效，但建议看一眼是否影响排课。',
        tone: 'info',
    },
    conflicts: {
        icon: 'triangle-alert',
        title: '冲突风险',
        action: '先处理冲突，再确认生效，避免后面排课失败。',
        tone: 'danger',
    },
};

const issueOrder = [
    'conflicts',
    'out_of_range_slots',
    'missing_slots',
    'missing_info',
    'clarifying_questions',
    'all_classes_unmatched',
    'need_review',
    'unsupported',
    'warnings',
];

function guideForGroup(group = {}) {
    return issueGuides[group.type] || {
        icon: 'list-checks',
        title: group.label || '待处理',
        action: '可以直接问智能助手这类问题应该怎么处理。',
        tone: 'info',
    };
}

function sortedContextGroups(groups = []) {
    return [...groups].sort((left, right) => {
        const leftIndex = issueOrder.indexOf(left.type);
        const rightIndex = issueOrder.indexOf(right.type);
        const normalizedLeft = leftIndex === -1 ? issueOrder.length : leftIndex;
        const normalizedRight = rightIndex === -1 ? issueOrder.length : rightIndex;
        return normalizedLeft - normalizedRight;
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

function renderConstraintChatSteps(context = {}, { completed = false } = {}) {
    const counts = context.counts || {};
    const needsInput = counts.needsInput || 0;
    const needReview = counts.needReview || 0;
    const warnings = counts.warnings || 0;
    const primaryCount = needsInput || needReview || warnings || counts.total || 0;
    return `
        <section class="tt-chat-step-guide" aria-label="新手操作步骤">
            <div class="tt-chat-guide-kicker">
                <i data-lucide="sparkles"></i>
                <span>今天要处理的复核任务</span>
            </div>
            <ol>
                <li class="${primaryCount ? 'is-active' : ''}">
                    <b>1</b>
                    <span><strong>先看问题</strong><em>${primaryCount ? `已整理 ${escapeHtml(primaryCount)} 条重点` : '等待复核结果'}</em></span>
                </li>
                <li>
                    <b>2</b>
                    <span><strong>点推荐操作</strong><em>不用自己写复杂 prompt</em></span>
                </li>
                <li class="${completed ? 'is-done' : ''}">
                    <b>3</b>
                    <span><strong>回表格确认</strong><em>确认后才会写入排课规则</em></span>
                </li>
            </ol>
        </section>
    `;
}

function renderSuggestedPrompts(prompts = [], { disabled = false } = {}) {
    if (!prompts.length) return '';
    return `
        <div class="tt-chat-suggested-prompts" aria-label="推荐操作">
            ${prompts.slice(0, 5).map((prompt, index) => `
                <button
                    class="tt-chat-suggested-prompt ${index === 0 ? 'is-primary' : ''}"
                    type="button"
                    data-action="constraint-chat-suggest"
                    data-constraint-chat-suggest="${escapeAttr(prompt)}"
                    ${disabled ? 'disabled' : ''}>
                    <i data-lucide="${index === 0 ? 'wand-sparkles' : 'message-circle'}"></i>
                    <span>${escapeHtml(prompt)}</span>
                </button>
            `).join('')}
        </div>
    `;
}

function renderReviewContext(context = {}, { disabled = false } = {}) {
    const groups = sortedContextGroups(context.groups || []);
    const prompts = context.suggestedPrompts || [];
    return `
        <section class="tt-chat-review-context" aria-label="当前复核重点">
            <div class="tt-chat-review-title">
                <i data-lucide="list-checks"></i>
                <div>
                    <strong>当前复核重点</strong>
                    <span>我已按复核表整理，先处理排在前面的项目。</span>
                </div>
            </div>
            ${groups.length ? `
                <div class="tt-chat-context-grid">
                    ${groups.slice(0, 6).map(group => {
                        const guide = guideForGroup(group);
                        return `
                            <article class="tt-chat-context-item tt-chat-context-item--${escapeAttr(guide.tone)}">
                                <div class="tt-chat-context-item-head">
                                    <i data-lucide="${escapeAttr(guide.icon)}"></i>
                                    <strong>${escapeHtml(group.label || guide.title)}</strong>
                                    <b>${escapeHtml(group.count || 0)} 条</b>
                                </div>
                                ${(group.examples || []).length ? `
                                    <p>${escapeHtml(group.examples[0])}</p>
                                ` : ''}
                                <em>${escapeHtml(guide.action)}</em>
                            </article>
                        `;
                    }).join('')}
                </div>
            ` : `
                <div class="tt-chat-empty-guide">
                    <i data-lucide="badge-check"></i>
                    <strong>暂时没有明显待处理项</strong>
                    <span>你仍然可以让智能助手解释当前规则，或要求它检查是否有遗漏。</span>
                </div>
            `}
            ${renderSuggestedPrompts(prompts, { disabled })}
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
    const contextForGuide = {
        ...reviewContext,
        suggestedPrompts: chat.suggestedPrompts?.length ? chat.suggestedPrompts : reviewContext.suggestedPrompts,
    };

    return `
        <div class="tt-constraint-chat-overlay" data-constraint-chat-overlay>
            <section class="tt-constraint-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-constraint-chat-title" aria-describedby="tt-constraint-chat-description">
                <header class="tt-constraint-chat-header">
                    <div class="tt-constraint-chat-titleblock">
                        <span class="tt-chat-eyebrow"><i data-lucide="bot"></i> 智能约束助手</span>
                        <h3 id="tt-constraint-chat-title">先处理当前复核表里的问题</h3>
                        <p id="tt-constraint-chat-description">不需要懂排课规则，按左侧推荐操作点选，或用白话告诉智能助手你想怎么改。</p>
                    </div>
                    <button class="tt-icon-btn" type="button" data-action="constraint-chat-close" aria-label="关闭对话">
                        <i data-lucide="x"></i>
                    </button>
                </header>

                <div class="tt-constraint-chat-body">
                    <aside class="tt-constraint-chat-guide">
                        ${renderConstraintChatSteps(contextForGuide, { completed: chat.completed })}
                        ${renderReviewContext(contextForGuide, { disabled: loading })}
                    </aside>

                    <section class="tt-constraint-chat-conversation" aria-label="对话与输入">
                        <div class="tt-constraint-chat-messages" id="tt-chat-messages" aria-live="polite">
                            ${messages.length ? messages.map(message => renderChatMessage(message)).join('') : `
                                <div class="tt-chat-empty-message">
                                    <i data-lucide="mouse-pointer-click"></i>
                                    <strong>建议先点左侧推荐操作</strong>
                                    <span>智能助手会围绕当前复核表回答，不会开启无关闲聊。</span>
                                </div>
                            `}
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
                                    <span>约束优化已完成，回到复核表确认生效；也可以继续追问。</span>
                                </div>
                            ` : ''}

                            <div class="tt-constraint-chat-input-area">
                                <textarea
                                    id="tt-chat-input"
                                    class="tt-constraint-chat-input"
                                    data-constraint-chat-input
                                    data-action="constraint-chat-input"
                                    placeholder="可以这样说：把缺少节次的都设为周一到周五第7节"
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
                                <span class="tt-chat-hint">推荐：先处理左侧高亮问题，再回到复核表确认生效。</span>
                                <span class="tt-chat-hint">Shift + Enter 可换行。</span>
                            </div>
                        </footer>
                    </section>
                </div>
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
            <span>智能帮我处理</span>
        </button>
    `;
}
