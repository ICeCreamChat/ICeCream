import {
    CONSTRAINT_RULE_DEFINITIONS,
    getConstraintRuleDefinition,
    getConstraintRuleFormValue,
    getConstraintRuleRange,
    getConstraintRuleTargetOptions,
} from './constraint-rule-form-model.js';

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

const DAY_LABELS = ['', '一', '二', '三', '四', '五', '六', '日'];

function slotsFromConstraint(constraint = {}) {
    return [
        ...(constraint.time?.slots || []),
        ...(constraint.slots || []),
    ].filter(Boolean);
}

function formatSlot(slot = '') {
    const match = String(slot).match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return String(slot || '');
    const day = Number.parseInt(match[1], 10);
    const period = Number.parseInt(match[2], 10);
    return `周${DAY_LABELS[day] || day}第${period}节`;
}

function constraintTimeLabel(constraint = {}) {
    const explicit = constraint.time?.label || constraint.timeLabel;
    if (explicit) return explicit;
    const slots = slotsFromConstraint(constraint);
    if (slots.length) return slots.map(formatSlot).join('、');
    if (constraint.type === 'subject_morning') return '上午时段';
    if (constraint.limit) return `最多 ${constraint.limit} 节`;
    return '未限定时间';
}

function parseSourceLabel(value = '') {
    const key = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return {
        local_xlsx: '本地识别',
        local_text: '本地识别',
        ai_supplement: 'AI 补充',
        ai: 'AI 识别',
        cache: '缓存结果',
        mixed_xlsx: '本地 + AI',
        local_roster_fallback: '本地建议',
    }[key] || '';
}

function constraintSourceLabel(constraint = {}) {
    const sheet = constraint.sourceSheet || constraint.source;
    const row = Number.parseInt(constraint.sourceRow, 10);
    const parseLabel = parseSourceLabel(constraint.parseSource || '');
    const locationLabel = sheet && Number.isFinite(row)
        ? `${sheet} 第 ${row} 行`
        : sheet || (Number.isFinite(row) ? `第 ${row} 行` : '');
    return [locationLabel, parseLabel].filter(Boolean).join(' · ');
}

function renderFieldError(message = '') {
    return message ? `<span class="tt-constraint-rule-error" role="alert">${escapeHtml(message)}</span>` : '';
}

export function renderConstraintRuleFormFields({
    project = {},
    value = {},
    idPrefix = 'tt-edit-constraint',
    slotAttribute = 'data-edit-slot',
    errors = {},
    legacy = false,
} = {}) {
    const type = getConstraintRuleDefinition(value.type)?.type || '';
    const definition = getConstraintRuleDefinition(type);
    const targets = getConstraintRuleTargetOptions(project, type);
    const selectedTargetValue = value.targetValue
        || (value.targetKind && value.targetId ? `${value.targetKind}:${value.targetId}` : '');
    const selectedSlots = new Set((value.slots || []).map(String));
    const range = getConstraintRuleRange(project);
    const strengthLabel = definition?.strength === 'hard' ? '硬约束 · 必须遵守' : '软约束 · 尽量满足';

    return `
        <div class="tt-constraint-rule-form" data-constraint-rule-form="${escapeAttr(idPrefix)}">
            ${legacy ? `
                <div class="tt-constraint-rule-conversion" role="note">
                    <i data-lucide="triangle-alert"></i>
                    <span>旧手动内容需要先选择具体规则类型和项目对象，转换后才能应用。</span>
                </div>
            ` : ''}
            <div class="tt-constraint-rule-main-fields">
                <label class="tt-constraint-rule-field">
                    <span>规则类型</span>
                    <select id="${escapeAttr(idPrefix)}-type" data-constraint-rule-type-select>
                        <option value="" ${type ? '' : 'selected'}>请选择具体规则类型</option>
                        ${CONSTRAINT_RULE_DEFINITIONS.map(item => `
                            <option value="${escapeAttr(item.type)}" ${item.type === type ? 'selected' : ''}>${escapeHtml(item.label)}</option>
                        `).join('')}
                    </select>
                    ${renderFieldError(errors.type)}
                </label>
                <label class="tt-constraint-rule-field">
                    <span>${escapeHtml(definition?.targetLabel || '项目对象')}</span>
                    <select id="${escapeAttr(idPrefix)}-target" ${definition ? '' : 'disabled'}>
                        <option value="">${definition ? `请选择项目中的${escapeHtml(definition.targetLabel)}` : '请先选择规则类型'}</option>
                        ${targets.map(target => {
                            const optionValue = `${target.kind}:${target.id}`;
                            return `<option value="${escapeAttr(optionValue)}" ${optionValue === selectedTargetValue ? 'selected' : ''}>${escapeHtml(target.name)}</option>`;
                        }).join('')}
                    </select>
                    ${renderFieldError(errors.target)}
                </label>
                ${definition ? `
                    <div class="tt-constraint-rule-strength tt-constraint-rule-strength--${escapeAttr(definition.strength)}">
                        <span>规则强度</span>
                        <strong>${escapeHtml(strengthLabel)}</strong>
                    </div>
                ` : ''}
            </div>
            ${definition?.parameterKind === 'slots' ? `
                <fieldset class="tt-constraint-rule-parameter tt-constraint-rule-slots">
                    <legend>${escapeHtml(definition.parameterLabel)}</legend>
                    <div class="tt-constraint-rule-slot-grid">
                        ${range.weekdays.map(day => `
                            <div class="tt-constraint-rule-slot-day">
                                <span>周${escapeHtml(DAY_LABELS[day] || day)}</span>
                                <div class="tt-constraint-rule-slot-row">
                                    ${range.periods.map(period => {
                                        const slot = `${day}-${period}`;
                                        return `
                                            <label class="tt-constraint-rule-slot-chip" title="周${escapeAttr(DAY_LABELS[day] || day)}第${escapeAttr(period)}节">
                                                <input type="checkbox" ${slotAttribute} value="${escapeAttr(slot)}" ${selectedSlots.has(slot) ? 'checked' : ''}>
                                                <span>${escapeHtml(period)}</span>
                                            </label>
                                        `;
                                    }).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    ${renderFieldError(errors.slots)}
                </fieldset>
            ` : ''}
            ${definition?.parameterKind === 'limit' ? `
                <label class="tt-constraint-rule-field tt-constraint-rule-limit">
                    <span>${escapeHtml(definition.parameterLabel)}</span>
                    <input id="${escapeAttr(idPrefix)}-limit" type="number" min="1" max="${escapeAttr(range.periods.length)}" step="1" value="${escapeAttr(value.limit ?? '')}">
                    ${renderFieldError(errors.limit)}
                </label>
            ` : `<input id="${escapeAttr(idPrefix)}-limit" type="hidden" value="">`}
        </div>
    `;
}

export function renderConstraintCard(constraint, state) {
    const isEditing = state?.constraintDialog?.editingConstraint?.originalId === constraint.id;
    const timeLabel = constraintTimeLabel(constraint);
    const sourceLabel = constraintSourceLabel(constraint);
    const applyItemKey = constraint.applyItemKey || '';
    const applyExcluded = Boolean(constraint.applyExcluded);

    return `
        <div class="tt-constraint-card ${constraint.hasConflict ? 'tt-constraint-card--conflict' : ''} ${applyExcluded ? 'tt-constraint-card--excluded' : ''}" data-constraint-id="${escapeAttr(constraint.id)}" ${applyItemKey ? `data-apply-item-key="${escapeAttr(applyItemKey)}"` : ''}>
            <div class="tt-constraint-card-header">
                <span class="tt-constraint-type">${escapeHtml(constraint.typeLabel || constraint.type)}</span>
                <span class="tt-constraint-confidence tt-confidence--${escapeAttr(constraint.confidenceTone || 'medium')}">
                    ${escapeHtml(applyExcluded ? '暂不应用' : (constraint.confidenceLabel || '中'))}
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
                ${sourceLabel ? `<p class="tt-constraint-source">来源：${escapeHtml(sourceLabel)}</p>` : ''}
            </div>
            <div class="tt-constraint-meta">
                <span><b>对象：</b>${escapeHtml(constraint.target?.name || constraint.targetName || '-')}</span>
                <span><b>时间：</b>${escapeHtml(timeLabel)}</span>
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
                ${applyItemKey ? `
                    <button class="tt-btn tt-btn--sm tt-btn--ghost tt-apply-toggle ${applyExcluded ? 'is-excluded' : ''}" data-action="toggle-constraint-apply-item" data-apply-item-key="${escapeAttr(applyItemKey)}" type="button">
                        ${escapeHtml(applyExcluded ? '恢复应用' : '暂停应用')}
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

export function renderConstraintEditForm(constraint, state = {}) {
    const project = state.project || {};
    const sourceLabel = constraintSourceLabel(constraint);
    const originalDefinition = getConstraintRuleDefinition(constraint.type);
    const formValue = getConstraintRuleFormValue({
        ...constraint,
        type: constraint.formType ?? constraint.type,
    });
    return `
        <div class="tt-constraint-edit-backdrop" data-constraint-edit-backdrop>
            <section class="tt-constraint-edit-modal" role="dialog" aria-modal="true" aria-labelledby="constraint-edit-title">
                <div class="tt-dialog-header">
                    <div class="tt-dialog-title">
                        <span class="tt-dialog-title-icon"><i data-lucide="pencil"></i></span>
                        <div class="tt-dialog-title-copy">
                            <h3 id="constraint-edit-title">编辑将应用规则</h3>
                            <p>人工校正这条机器规则，保存后仍需应用需求才会写入项目。</p>
                        </div>
                    </div>
                    <button class="tt-icon-btn" data-action="cancel-edit-constraint" aria-label="关闭编辑" type="button">
                        <i data-lucide="x"></i>
                    </button>
                </div>
                <div class="tt-constraint-edit-body">
                    ${renderConstraintRuleFormFields({
                        project,
                        value: formValue,
                        idPrefix: 'tt-edit-constraint',
                        slotAttribute: 'data-edit-slot',
                        errors: constraint.formErrors || {},
                        legacy: !originalDefinition,
                    })}
                    <div class="tt-constraint-edit-readonly">
                        <div>
                            <span>原文</span>
                            <p>${escapeHtml(constraint.sourceText || constraint.rawText || '手动添加')}</p>
                        </div>
                        ${sourceLabel ? `
                            <div>
                                <span>来源</span>
                                <p>${escapeHtml(sourceLabel)}</p>
                            </div>
                        ` : ''}
                    </div>
                </div>
                <div class="tt-dialog-actions">
                    <button class="tt-btn" data-action="cancel-edit-constraint" type="button">取消</button>
                    <button class="tt-btn tt-btn--primary" data-action="save-edit-constraint" type="button">
                        <i data-lucide="check"></i>
                        <span>保存修改</span>
                    </button>
                </div>
            </section>
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
