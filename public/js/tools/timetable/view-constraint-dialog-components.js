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

const EDITABLE_RULE_TYPES = [
    { value: 'subject_preferred_periods', label: '课程优先节次' },
    { value: 'subject_avoid_periods', label: '课程避开节次' },
    { value: 'subject_morning', label: '上午优先' },
    { value: 'subject_spread', label: '课程分散' },
    { value: 'teacher_unavailable', label: '教师不可排' },
    { value: 'class_unavailable', label: '班级不可排' },
    { value: 'teacher_daily_limit', label: '教师每日上限' },
    { value: 'teacher_consecutive_limit', label: '教师连续上限' },
];

const STATUS_OPTIONS = [
    { value: 'effective', label: '可应用' },
    { value: 'needs_review', label: '需复核' },
    { value: 'suggestion', label: '建议项' },
];

const PRIORITY_OPTIONS = [
    { value: 'soft', label: '尽量满足' },
    { value: 'hard', label: '必须满足' },
];

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

function activeWeekdays(project = {}) {
    const days = Array.isArray(project.activeWeekdays) && project.activeWeekdays.length
        ? project.activeWeekdays
        : Array.from({ length: Number(project.weekdays) || 5 }, (_, index) => index + 1);
    return days.map(Number).filter(day => Number.isInteger(day) && day > 0);
}

function activePeriods(project = {}) {
    const periods = Array.isArray(project.activePeriods) && project.activePeriods.length
        ? project.activePeriods
        : Array.from({ length: Number(project.periodsPerDay) || 7 }, (_, index) => index + 1);
    return periods.map(Number).filter(period => Number.isInteger(period) && period > 0);
}

function entityLabel(kind, item = {}) {
    if (kind === 'class') return [item.grade, item.name].filter(Boolean).join(' ') || item.name || item.id || '班级';
    return item.name || item.label || item.id || '对象';
}

function selectedTargetValue(constraint = {}) {
    const kind = constraint.targetType || constraint.target?.type || constraint.target?.kind || '';
    const id = constraint.targetId || constraint.target?.id || '';
    if (kind && id) return `${kind}:${id}`;
    return '';
}

function renderTargetOptions(project = {}, constraint = {}) {
    const selectedValue = selectedTargetValue(constraint);
    const groups = [
        { kind: 'subject', label: '课程', items: project.subjects || [] },
        { kind: 'teacher', label: '教师', items: project.teachers || [] },
        { kind: 'class', label: '班级', items: project.classes || [] },
    ];
    const knownValues = new Set();
    const html = groups.map(group => {
        const options = (group.items || []).map(item => {
            const value = `${group.kind}:${item.id}`;
            knownValues.add(value);
            return `<option value="${escapeAttr(value)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(entityLabel(group.kind, item))}</option>`;
        }).join('');
        return options ? `<optgroup label="${escapeAttr(group.label)}">${options}</optgroup>` : '';
    }).join('');

    if (selectedValue && !knownValues.has(selectedValue)) {
        const label = constraint.target?.name || constraint.targetName || selectedValue;
        return `<option value="${escapeAttr(selectedValue)}" selected>${escapeHtml(label)}</option>${html}`;
    }
    return html;
}

function renderSlotCheckboxes(project = {}, constraint = {}) {
    const selectedSlots = new Set(slotsFromConstraint(constraint).map(String));
    return activeWeekdays(project).map(day => `
        <div class="tt-edit-slot-day">
            <span>周${escapeHtml(DAY_LABELS[day] || day)}</span>
            <div class="tt-edit-slot-row">
                ${activePeriods(project).map(period => {
                    const value = `${day}-${period}`;
                    return `
                        <label class="tt-edit-slot-chip">
                            <input type="checkbox" data-edit-slot value="${escapeAttr(value)}" ${selectedSlots.has(value) ? 'checked' : ''}>
                            <span>${period}</span>
                        </label>
                    `;
                }).join('')}
            </div>
        </div>
    `).join('');
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
    const ruleType = String(constraint.type || 'subject_preferred_periods');
    const priority = String(constraint.priority || 'soft');
    const status = String(constraint.status || 'effective');
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
                    <div class="tt-form-grid tt-constraint-edit-grid">
                        <label>
                            <span>规则类型</span>
                            <select id="tt-edit-constraint-type">
                                ${EDITABLE_RULE_TYPES.map(type => `
                                    <option value="${escapeAttr(type.value)}" ${type.value === ruleType ? 'selected' : ''}>${escapeHtml(type.label)}</option>
                                `).join('')}
                            </select>
                        </label>
                        <label>
                            <span>对象</span>
                            <select id="tt-edit-constraint-target">
                                ${renderTargetOptions(project, constraint)}
                            </select>
                        </label>
                        <label>
                            <span>强度</span>
                            <select id="tt-edit-constraint-priority">
                                ${PRIORITY_OPTIONS.map(option => `
                                    <option value="${escapeAttr(option.value)}" ${option.value === priority ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                                `).join('')}
                            </select>
                        </label>
                        <label>
                            <span>状态</span>
                            <select id="tt-edit-constraint-status">
                                ${STATUS_OPTIONS.map(option => `
                                    <option value="${escapeAttr(option.value)}" ${option.value === status ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                                `).join('')}
                            </select>
                        </label>
                        <label>
                            <span>上限节数</span>
                            <input type="number" min="1" id="tt-edit-constraint-limit" value="${escapeAttr(constraint.limit || '')}" placeholder="仅上限规则填写">
                        </label>
                    </div>
                    <div class="tt-constraint-edit-slots">
                        <span class="tt-field-label">节次</span>
                        <div class="tt-edit-slot-grid">
                            ${renderSlotCheckboxes(project, constraint)}
                        </div>
                    </div>
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
