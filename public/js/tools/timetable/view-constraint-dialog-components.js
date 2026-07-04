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

export function renderConstraintCard(constraint, state) {
    const isEditing = state?.constraintDialog?.editingConstraint?.originalId === constraint.id;

    return `
        <div class="tt-constraint-card ${constraint.hasConflict ? 'tt-constraint-card--conflict' : ''}" data-constraint-id="${escapeAttr(constraint.id)}">
            <div class="tt-constraint-card-header">
                <span class="tt-constraint-type">${escapeHtml(constraint.typeLabel || constraint.type)}</span>
                <span class="tt-constraint-confidence tt-confidence--${escapeAttr(constraint.confidenceTone || 'medium')}">
                    ${escapeHtml(constraint.confidenceLabel || '中')}
                </span>
                ${constraint.hasConflict ? `
                    <span class="tt-constraint-conflict-badge" title="${constraint.conflicts?.length || 0} 个冲突">
                        <i data-lucide="alert-triangle"></i>
                    </span>
                ` : ''}
            </div>
            <div class="tt-constraint-content">
                <strong>${escapeHtml(constraint.understanding || constraint.description || '约束规则')}</strong>
                <p class="tt-constraint-source">原文：${escapeHtml(constraint.sourceText || constraint.rawText || '手动添加')}</p>
            </div>
            <div class="tt-constraint-meta">
                <span><b>对象：</b>${escapeHtml(constraint.target?.name || constraint.targetName || '-')}</span>
                <span><b>时间：</b>${escapeHtml(constraint.time?.label || constraint.timeLabel || '-')}</span>
            </div>
            ${(constraint.warnings || []).length > 0 ? `
                <div class="tt-constraint-warning">
                    <i data-lucide="alert-circle"></i>
                    <span>${escapeHtml(constraint.warnings[0])}</span>
                </div>
            ` : ''}
            ${constraint.hasConflict && constraint.conflicts?.length > 0 ? `
                <div class="tt-constraint-conflicts">
                    <strong>冲突详情：</strong>
                    ${constraint.conflicts.slice(0, 2).map(c => `
                        <p>${escapeHtml(c.description || c.message || '存在冲突')}</p>
                    `).join('')}
                    ${constraint.conflicts.length > 2 ? `<p class="tt-more-conflicts">还有 ${constraint.conflicts.length - 2} 个冲突...</p>` : ''}
                </div>
            ` : ''}
            <div class="tt-constraint-actions">
                <button class="tt-btn-icon" data-action="edit-constraint" title="编辑" type="button">
                    <i data-lucide="pencil"></i>
                </button>
                <button class="tt-btn-icon" data-action="delete-constraint" title="删除" type="button">
                    <i data-lucide="trash-2"></i>
                </button>
            </div>
        </div>
    `;
}

export function renderConstraintEditForm(constraint) {
    return `
        <div class="tt-constraint-edit-form">
            <div class="tt-edit-form-header">
                <strong>编辑约束</strong>
                <button class="tt-btn-icon" data-action="cancel-edit-constraint" title="取消" type="button">
                    <i data-lucide="x"></i>
                </button>
            </div>
            <div class="tt-form-grid">
                <label>
                    <span>约束类型</span>
                    <select id="tt-edit-constraint-type">
                        <option value="forbid" ${constraint.type === 'forbid' ? 'selected' : ''}>禁止安排</option>
                        <option value="prefer" ${constraint.type === 'prefer' ? 'selected' : ''}>优先安排</option>
                        <option value="avoid" ${constraint.type === 'avoid' ? 'selected' : ''}>尽量避开</option>
                    </select>
                </label>
                <label>
                    <span>对象</span>
                    <input type="text" id="tt-edit-constraint-target" value="${escapeAttr(constraint.target?.name || constraint.targetName || '')}" placeholder="教师名或课程名">
                </label>
                <label>
                    <span>时间</span>
                    <input type="text" id="tt-edit-constraint-time" value="${escapeAttr(constraint.time?.label || constraint.timeLabel || '')}" placeholder="周一上午 或 第1-2节">
                </label>
            </div>
            <label>
                <span>理解描述</span>
                <input type="text" id="tt-edit-constraint-understanding" value="${escapeAttr(constraint.understanding || '')}" placeholder="自动生成">
            </label>
            <div class="tt-edit-form-actions">
                <button class="tt-btn" data-action="cancel-edit-constraint" type="button">取消</button>
                <button class="tt-btn tt-btn--primary" data-action="save-edit-constraint" type="button">
                    <i data-lucide="check"></i>
                    <span>保存修改</span>
                </button>
            </div>
        </div>
    `;
}

export function renderAIChatPanel(state, aiChat) {
    return `
        <div class="tt-ai-chat-panel">
            <div class="tt-ai-chat-toolbar tt-ai-chat-header">
                <div class="tt-ai-chat-title">
                    <span class="tt-ai-message-icon tt-ai-message-icon--assistant" aria-hidden="true">
                        <i data-lucide="sparkles"></i>
                    </span>
                    <strong>AI 约束优化助手</strong>
                </div>
                <button class="tt-btn-icon" data-action="close-ai-chat" title="关闭 AI" type="button">
                    <i data-lucide="x"></i>
                </button>
            </div>

            <div class="tt-ai-chat-stream">
                <div class="tt-ai-chat-messages">
                    ${(aiChat.messages || []).map(msg => `
                        <div class="tt-ai-message tt-ai-message--${msg.role}">
                            <span class="tt-ai-message-icon tt-ai-message-icon--${msg.role}" aria-hidden="true">
                                <i data-lucide="${msg.role === 'assistant' ? 'bot' : 'user'}"></i>
                            </span>
                            <div class="tt-message-content">${escapeHtml(msg.content)}</div>
                        </div>
                    `).join('')}
                    ${aiChat.loading ? `
                        <div class="tt-ai-message tt-ai-message--assistant tt-ai-message--loading">
                            <span class="tt-ai-message-icon tt-ai-message-icon--assistant" aria-hidden="true">
                                <i data-lucide="bot"></i>
                            </span>
                            <div class="tt-message-content">
                                <i data-lucide="loader-2" class="tt-spin"></i>
                                <span>正在思考...</span>
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>

            ${aiChat.suggestedPrompts && aiChat.suggestedPrompts.length > 0 ? `
                <div class="tt-ai-suggested-prompts">
                    ${aiChat.suggestedPrompts.map(prompt => `
                        <button class="tt-suggested-prompt-chip" data-action="use-ai-prompt" data-prompt="${escapeAttr(prompt)}" type="button">
                            ${escapeHtml(prompt)}
                        </button>
                    `).join('')}
                </div>
            ` : ''}

            <div class="tt-ai-chat-input">
                <input
                    type="text"
                    id="tt-ai-chat-input"
                    placeholder="输入您的问题..."
                    ${aiChat.loading ? 'disabled' : ''}
                >
                <button class="tt-btn tt-btn--primary" data-action="send-ai-message" type="button" ${aiChat.loading ? 'disabled' : ''}>
                    <i data-lucide="send"></i>
                </button>
            </div>
        </div>
    `;
}
