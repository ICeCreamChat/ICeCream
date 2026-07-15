import {
    CONSTRAINT_RULE_DEFINITIONS,
    getConstraintRuleDefinition,
    getConstraintRuleFormValue,
    getConstraintRuleRange,
    getConstraintRuleScopeClassOptions,
    getConstraintRuleScopeTeacherOptions,
    getConstraintRuleTargetOptions,
    isCourseScopeRule,
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
        ...(constraint.parameters?.slots || []),
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
    if (constraint.type === 'subject_morning' || constraint.intent === 'subject_morning') return '上午时段';
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

function renderConstraintRuleTypePicker({ idPrefix, type, errors = {} }) {
    const selected = getConstraintRuleDefinition(type);
    const listboxId = `${idPrefix}-type-options`;
    const triggerId = `${idPrefix}-type-trigger`;
    const helpId = `${idPrefix}-type-help`;
    const placeholder = '请选择具体规则类型';
    return `
        <div class="tt-constraint-rule-field tt-constraint-rule-type-field">
            <div class="tt-constraint-rule-label-row">
                <span id="${escapeAttr(idPrefix)}-type-label">规则类型</span>
                <button
                    class="tt-constraint-rule-help-button"
                    type="button"
                    data-constraint-rule-help-toggle
                    aria-label="查看当前规则类型说明"
                    aria-controls="${escapeAttr(helpId)}"
                    aria-expanded="false"
                    ${selected ? '' : 'disabled'}
                >
                    <i data-lucide="circle-help" aria-hidden="true"></i>
                </button>
            </div>
            <div class="tt-constraint-rule-type-picker" data-constraint-rule-type-picker="${escapeAttr(idPrefix)}">
                <input id="${escapeAttr(idPrefix)}-type" data-constraint-rule-type-input type="hidden" value="${escapeAttr(type)}">
                <button
                    id="${escapeAttr(triggerId)}"
                    class="tt-constraint-rule-type-trigger"
                    data-constraint-rule-type-trigger
                    type="button"
                    role="combobox"
                    aria-haspopup="listbox"
                    aria-expanded="false"
                    aria-controls="${escapeAttr(listboxId)}"
                    aria-label="规则类型：${escapeAttr(selected?.label || placeholder)}"
                >
                    <span>${escapeHtml(selected?.label || placeholder)}</span>
                    <i data-lucide="chevron-down" aria-hidden="true"></i>
                </button>
                <div id="${escapeAttr(listboxId)}" class="tt-constraint-rule-type-listbox" data-constraint-rule-type-listbox role="listbox" aria-labelledby="${escapeAttr(idPrefix)}-type-label" hidden>
                    ${CONSTRAINT_RULE_DEFINITIONS.map(item => `
                        <div
                            id="${escapeAttr(idPrefix)}-type-option-${escapeAttr(item.type)}"
                            class="tt-constraint-rule-type-option ${item.type === type ? 'is-selected' : ''}"
                            data-constraint-rule-type-option
                            data-constraint-rule-type="${escapeAttr(item.type)}"
                            role="option"
                            aria-selected="${item.type === type ? 'true' : 'false'}"
                        >
                            <span>${escapeHtml(item.label)}</span>
                            <i data-lucide="check" aria-hidden="true"></i>
                        </div>
                    `).join('')}
                </div>
                <div id="${escapeAttr(helpId)}" class="tt-constraint-rule-type-help" data-constraint-rule-type-help role="tooltip" aria-live="polite" hidden>
                    <strong data-constraint-rule-help-title></strong>
                    <span data-constraint-rule-help-text></span>
                    <em data-constraint-rule-help-strength></em>
                </div>
            </div>
            ${renderFieldError(errors.type)}
        </div>
    `;
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
    const hasCourseScope = definition && isCourseScopeRule(definition.type);
    const selectedSubjectId = definition?.targetKind === 'subject'
        ? String(selectedTargetValue || '').replace(/^subject:/, '').trim()
        : '';
    const selectedScopeClassId = String(value.scopeClassId || '').trim();
    const selectedScopeTeacherId = String(value.scopeTeacherId || '').trim();
    const restrictTeacher = Boolean(value.restrictTeacher || selectedScopeTeacherId);
    const scopeClasses = getConstraintRuleScopeClassOptions(project, type, selectedSubjectId);
    const scopeTeachers = getConstraintRuleScopeTeacherOptions(project, type, selectedSubjectId, selectedScopeClassId);

    return `
        <div class="tt-constraint-rule-form" data-constraint-rule-form="${escapeAttr(idPrefix)}">
            ${legacy ? `
                <div class="tt-constraint-rule-conversion" role="note">
                    <i data-lucide="triangle-alert"></i>
                    <span>旧手动内容需要先选择具体规则类型和项目对象，转换后才能应用。</span>
                </div>
            ` : ''}
            <div class="tt-constraint-rule-main-fields">
                ${renderConstraintRuleTypePicker({ idPrefix, type, errors })}
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
            ${hasCourseScope ? `
                <fieldset class="tt-constraint-rule-course-scope">
                    <legend>适用范围</legend>
                    ${value.legacyCourseGlobal ? `
                        <div class="tt-constraint-rule-conversion tt-constraint-rule-conversion--scope" role="note">
                            <i data-lucide="history"></i>
                            <span>这是一条历史全校课程规则。请选择班级后保存，才会转换为精确范围。</span>
                        </div>
                    ` : ''}
                    <div class="tt-constraint-rule-course-scope-grid">
                        <label class="tt-constraint-rule-field">
                            <span>班级</span>
                            <select id="${escapeAttr(idPrefix)}-scope-class" data-constraint-rule-scope-class ${selectedSubjectId ? '' : 'disabled'}>
                                <option value="">${selectedSubjectId ? '请选择该课程适用的班级' : '请先选择课程'}</option>
                                ${scopeClasses.map(klass => `<option value="${escapeAttr(klass.id)}" ${klass.id === selectedScopeClassId ? 'selected' : ''}>${escapeHtml(klass.name)}</option>`).join('')}
                            </select>
                            ${renderFieldError(errors.scopeClass)}
                        </label>
                        <label class="tt-constraint-rule-scope-toggle">
                            <input id="${escapeAttr(idPrefix)}-scope-limit-teacher" data-constraint-rule-scope-limit-teacher type="checkbox" ${restrictTeacher ? 'checked' : ''} ${selectedScopeClassId ? '' : 'disabled'}>
                            <span>限定教师</span>
                        </label>
                        <label class="tt-constraint-rule-field">
                            <span>教师</span>
                            <select id="${escapeAttr(idPrefix)}-scope-teacher" data-constraint-rule-scope-teacher ${restrictTeacher && selectedScopeClassId ? '' : 'disabled'}>
                                <option value="">${restrictTeacher ? '请选择该班该课程的任课教师' : '不限教师'}</option>
                                ${scopeTeachers.map(teacher => `<option value="${escapeAttr(teacher.id)}" ${teacher.id === selectedScopeTeacherId ? 'selected' : ''}>${escapeHtml(teacher.name)}</option>`).join('')}
                            </select>
                            ${renderFieldError(errors.scopeTeacher)}
                        </label>
                    </div>
                </fieldset>
            ` : ''}
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
    const scopeLabel = constraint.scopeLabel || [
        constraint.scopeClassName,
        constraint.targetName,
        constraint.scopeTeacherName || (constraint.scopeClassId ? '不限教师' : ''),
    ].filter(Boolean).join(' · ');

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
                ${scopeLabel ? `<span><b>范围：</b>${escapeHtml(scopeLabel)}</span>` : ''}
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
    const originalDefinition = getConstraintRuleDefinition(constraint.formType || constraint.intent || constraint.type);
    const formValue = getConstraintRuleFormValue({
        ...constraint,
        type: constraint.formType ?? constraint.intent ?? constraint.type,
    });
    Object.assign(formValue, constraint.formScope || {});
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
