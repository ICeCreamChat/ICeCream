/**
 * 智能约束助手弹窗视图组件
 * 简化版：合并原工作台的输入、解析、预览功能为单一弹窗
 */

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

// 导入组件渲染函数
import {
    renderConstraintCard as renderCard,
    renderConstraintEditForm,
    renderAIChatPanel,
} from './view-constraint-dialog-components.js';

function renderConstraintCard(constraint, state) {
    return renderCard(constraint, state);
}

const REQUIREMENT_GROUPS = [
    { key: 'rule', title: '可应用到约束规则', icon: 'list-check' },
    { key: 'lesson_plan', title: '可应用到任课计划', icon: 'blocks' },
    { key: 'optimization', title: '可应用到优化目标', icon: 'sliders-horizontal' },
    { key: 'handled', title: '已自动处理', icon: 'check-circle-2' },
    { key: 'review', title: '需复核', icon: 'circle-alert' },
];

const REQUIREMENT_FILTERS = [
    { key: 'all', title: '全部', icon: 'list-filter' },
    ...REQUIREMENT_GROUPS,
];

const BLOCK_PREFERENCE_LABELS = {
    single: '单节',
    double: '双连堂',
    mixed: '混合连堂',
};

const DAY_PART_LABELS = {
    morning: '上午',
    afternoon: '下午',
    evening: '晚上',
    night: '晚上',
};

function requirementGroupKey(item = {}) {
    if (item.status === 'handled') return 'handled';
    if (item.status === 'needs_review' || item.status === 'candidate' || item.applyTo === 'review') return 'review';
    if (item.applyTo === 'lesson_plan') return 'lesson_plan';
    if (item.applyTo === 'optimization') return 'optimization';
    if (item.applyTo === 'rule' || item.applyTo === 'constraint_rule') return 'rule';
    return item.status === 'actionable' ? 'review' : 'handled';
}

function requirementIntentLabel(intent = '') {
    const key = String(intent || '').trim().toLowerCase().replace(/-/g, '_');
    const label = {
        preferred_periods: '优先节次',
        subject_preferred_periods: '优先节次',
        subject_prefer_periods: '优先节次',
        subject_preferred_slots: '优先节次',
        preferred_day_part: '优先时段',
        subject_morning: '上午优先',
        morning_subject: '上午优先',
        morning_preference: '上午优先',
        morning: '上午时段',
        period_preference: '优先节次',
        avoid_periods: '避开节次',
        subject_avoid_periods: '避开节次',
        subject_avoid_slots: '避开节次',
        unavailable_periods: '不可排时间',
        teacher_unavailable: '教师不可排',
        class_unavailable: '班级不可排',
        locked_slot: '固定课节',
        teacher_daily_limit: '每日课时上限',
        teacher_consecutive_limit: '连续课时上限',
        subject_spread: '课程分散',
        course_spread: '课程分散',
        spread: '课程分散',
        block_preference: '连堂设置',
        block_protection: '连堂块保护',
        default_block_policy: '默认课时块策略',
        block_integrity: '连堂块保护',
        teacher_load_balance: '教师负载均衡',
        teacher_load_protection: '高负载教师保护',
        teacher_time_conflict: '教师时间冲突',
        class_time_conflict: '班级时间冲突',
        class_daily_balance: '班级每日均衡',
        class_subject_spread: '班级课程分散',
        quality_subject_later: '素质课时段建议',
    }[key];
    if (label) return label;
    return /[A-Za-z_]/.test(String(intent || '')) ? '排课需求' : intent || '排课需求';
}

function requirementStatusLabel(item = {}) {
    const key = String(item.status || '').trim().toLowerCase().replace(/-/g, '_');
    return {
        handled: '已处理',
        ignored: '已处理',
        suggestion: '建议',
        actionable: '可应用',
        ready: '可应用',
        effective: '可应用',
        needs_review: '需复核',
        review: '需复核',
        candidate: '待确认',
        pending: '待确认',
        unsupported: '暂不支持',
        invalid: '需修正',
    }[key] || '待确认';
}

function blockPreferenceLabel(value = '') {
    return BLOCK_PREFERENCE_LABELS[String(value || '').trim()] || String(value || '');
}

function requirementParameterLabel(item = {}) {
    const params = item.parameters || {};
    if (params.blockPreference) {
        return blockPreferenceLabel(params.blockPreference);
    }
    if (params.maxConsecutive) return `连续最多 ${params.maxConsecutive} 节`;
    if (params.limit) return `最多 ${params.limit} 节`;
    if (params.slots?.length) return `${params.slots.length} 个节次`;
    if (params.balancedTeacherLoad) return '启用负载均衡';
    return '';
}

function requirementApplyLabel(applyTo = '') {
    const key = String(applyTo || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    return {
        rule: '约束规则',
        rules: '约束规则',
        constraint: '约束规则',
        constraint_rule: '约束规则',
        lesson_plan: '任课计划',
        lesson_plans: '任课计划',
        lessonplan: '任课计划',
        optimization: '优化目标',
        optimize: '优化目标',
        solver_policy: '系统策略',
        system_policy: '系统策略',
        handled: '系统策略',
        review: '人工复核',
        needs_review: '人工复核',
    }[key] || (/[A-Za-z_]/.test(String(applyTo || '')) ? '复核' : applyTo || '复核');
}

function requirementStatusTone(item = {}) {
    const status = String(item.status || '').trim().toLowerCase().replace(/-/g, '_');
    if (status === 'handled' || status === 'ignored') return 'handled';
    if (status === 'needs_review' || status === 'review') return 'review';
    if (status === 'candidate' || status === 'pending') return 'warning';
    if ((item.warnings || []).length) return 'warning';
    return 'actionable';
}

function requirementObjectName(item = {}) {
    return item.object?.name || item.targetName || '全局';
}

function requirementRawText(item = {}) {
    return item.source?.rawText || item.rawText || '';
}

function requirementSourceLabel(item = {}) {
    const source = item.source || {};
    const sheet = source.sourceSheet || source.sheet || item.sourceSheet || '';
    const row = source.sourceRow || source.row || item.sourceRow || '';
    if (sheet && row) return `${sheet} 第 ${row} 行`;
    if (row) return `第 ${row} 行`;
    if (sheet) return sheet;
    if (requirementRawText(item)) return '输入文本';
    return '识别结果';
}

function requirementConfidenceLabel(item = {}) {
    if (typeof item.confidence !== 'number') return '未提供';
    const normalized = item.confidence <= 1 ? item.confidence * 100 : item.confidence;
    return `${Math.round(normalized)}%`;
}

function requirementStrengthLabel(strength = '') {
    const key = String(strength || '').trim().toLowerCase().replace(/-/g, '_');
    return {
        hard: '硬约束',
        soft: '软约束',
        preference: '偏好',
        required: '必守',
        optional: '可选',
    }[key] || strength || '软约束';
}

function requirementDayLabel(value) {
    return {
        1: '周一',
        2: '周二',
        3: '周三',
        4: '周四',
        5: '周五',
        6: '周六',
        7: '周日',
    }[String(value)] || String(value);
}

function requirementSlotLabel(value = '') {
    const match = String(value || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return String(value || '');
    return `${requirementDayLabel(match[1])}第${match[2]}节`;
}

function requirementParameterKeyLabel(key = '') {
    return {
        blockPreference: '连堂方式',
        maxConsecutive: '连续最多',
        limit: '最多节数',
        slots: '节次',
        days: '周几',
        periods: '课节',
        dayPart: '时段',
        weekPattern: '单双周',
        balancedTeacherLoad: '教师负载均衡',
        teacherLimits: '教师连续保护',
        lessonPlanIds: '任课计划',
        subjectIds: '课程',
        weight: '权重',
    }[key] || key;
}

function requirementParameterValueLabel(key = '', value) {
    if (Array.isArray(value)) {
        const formatted = value.map(item => requirementParameterValueLabel(key, item)).filter(Boolean);
        return formatted.join('、');
    }
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (key === 'blockPreference') return blockPreferenceLabel(value);
    if (key === 'dayPart') return DAY_PART_LABELS[String(value || '').trim()] || String(value || '');
    if (key === 'slots') return requirementSlotLabel(value);
    if (key === 'days') return requirementDayLabel(value);
    if (key === 'periods') return `第${value}节`;
    if (key === 'weekPattern') {
        return {
            odd: '单周',
            even: '双周',
            both: '单双周',
            alternate: '隔周',
        }[String(value || '').trim()] || String(value || '');
    }
    if (key === 'teacherLimits' && value && typeof value === 'object') {
        const parts = [];
        if (value.consecutive) parts.push(`连续最多 ${value.consecutive} 节`);
        if (value.daily) parts.push(`每天最多 ${value.daily} 节`);
        return parts.join('，') || '已配置';
    }
    if (value && typeof value === 'object') return '已配置';
    return String(value ?? '');
}

function renderRequirementParameterDetails(item = {}) {
    const params = item.parameters || {};
    const primary = requirementParameterLabel(item);
    const primaryKeys = new Set();
    if (params.blockPreference) primaryKeys.add('blockPreference');
    else if (params.maxConsecutive) primaryKeys.add('maxConsecutive');
    else if (params.limit) primaryKeys.add('limit');
    else if (params.slots?.length) primaryKeys.add('slots');
    else if (params.balancedTeacherLoad) primaryKeys.add('balancedTeacherLoad');
    const entries = Object.entries(params).filter(([key, value]) => (
        !primaryKeys.has(key)
        && value !== undefined
        && value !== null
        && value !== ''
    ));
    if (!entries.length && !primary) return '<span>无额外参数</span>';
    const rendered = [];
    if (primary) rendered.push(`<span>${escapeHtml(primary)}</span>`);
    entries.forEach(([key, value]) => {
        const keyText = requirementParameterKeyLabel(key);
        const valueText = requirementParameterValueLabel(key, value);
        rendered.push(`<span>${escapeHtml(keyText)}：${escapeHtml(valueText)}</span>`);
    });
    return rendered.join('');
}

function requirementCounts(requirements = []) {
    const counts = new Map(REQUIREMENT_FILTERS.map(filter => [filter.key, 0]));
    counts.set('all', requirements.length);
    requirements.forEach(item => {
        const key = requirementGroupKey(item);
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
}

function filteredRequirements(requirements = [], filter = 'all') {
    if (!filter || filter === 'all') return requirements;
    return requirements.filter(item => requirementGroupKey(item) === filter);
}

function defaultRequirementSelection(requirements = []) {
    return requirements.find(item => item.status === 'needs_review')
        || requirements.find(item => item.status === 'actionable')
        || requirements[0]
        || null;
}

function selectedRequirement(requirements = [], selectedId = '') {
    return requirements.find(item => item.id && item.id === selectedId) || defaultRequirementSelection(requirements);
}

function renderRequirementFilterBar(requirements = [], activeFilter = 'all') {
    const counts = requirementCounts(requirements);
    return `
        <div class="tt-requirement-filter-bar" role="toolbar" aria-label="需求分组筛选">
            ${REQUIREMENT_FILTERS.map(filter => {
                const isActive = (activeFilter || 'all') === filter.key;
                return `
                    <button class="tt-requirement-filter ${isActive ? 'is-active' : ''}" type="button"
                        data-action="filter-requirements" data-requirement-filter="${escapeAttr(filter.key)}" aria-pressed="${isActive ? 'true' : 'false'}">
                        <i data-lucide="${escapeAttr(filter.icon)}"></i>
                        <span>${escapeHtml(filter.title)}</span>
                        <b>${counts.get(filter.key) || 0}</b>
                    </button>
                `;
            }).join('')}
        </div>
    `;
}

function renderRequirementRow(item = {}, selectedId = '') {
    const sourceText = item.source?.rawText || item.rawText || '';
    const objectName = requirementObjectName(item);
    const parameterLabel = requirementParameterLabel(item);
    const isSelected = item.id && item.id === selectedId;
    const hasWarning = (item.warnings || []).length > 0;
    return `
        <button data-action="select-requirement" data-requirement-id="${escapeAttr(item.id || '')}"
            class="tt-requirement-row ${isSelected ? 'is-selected' : ''} ${hasWarning ? 'has-warning' : ''}" type="button" aria-pressed="${isSelected ? 'true' : 'false'}"
            title="${escapeAttr(sourceText || requirementIntentLabel(item.intent))}">
            <span class="tt-requirement-status tt-requirement-status--${escapeAttr(requirementStatusTone(item))}">
                ${escapeHtml(requirementStatusLabel(item))}
            </span>
            <span>${escapeHtml(objectName)}</span>
            <span>${escapeHtml(requirementIntentLabel(item.intent))}</span>
            <span>${escapeHtml(requirementApplyLabel(item.applyTo))}</span>
            <span>${escapeHtml(parameterLabel || '-')}</span>
            <span>${escapeHtml(requirementSourceLabel(item))}</span>
        </button>
    `;
}

function renderRequirementDetail(item = null) {
    if (!item) {
        return `
            <aside class="tt-requirement-detail tt-requirement-detail--empty">
                <i data-lucide="info"></i>
                <span>当前分组没有需求</span>
            </aside>
        `;
    }
    const objectName = requirementObjectName(item);
    const sourceText = requirementRawText(item);
    const warnings = item.warnings || [];
    return `
        <aside class="tt-requirement-detail" data-requirement-detail-id="${escapeAttr(item.id || '')}">
            <div class="tt-requirement-detail-header">
                <span class="tt-requirement-status tt-requirement-status--${escapeAttr(requirementStatusTone(item))}">
                    ${escapeHtml(requirementStatusLabel(item))}
                </span>
                <strong>${escapeHtml(objectName)}</strong>
            </div>
            <dl class="tt-requirement-detail-list">
                <div>
                    <dt>需求</dt>
                    <dd>${escapeHtml(requirementIntentLabel(item.intent))}</dd>
                </div>
                <div>
                    <dt>落点</dt>
                    <dd>${escapeHtml(requirementApplyLabel(item.applyTo))}</dd>
                </div>
                <div>
                    <dt>强度</dt>
                    <dd>${escapeHtml(requirementStrengthLabel(item.strength))}</dd>
                </div>
                <div>
                    <dt>置信度</dt>
                    <dd>${escapeHtml(requirementConfidenceLabel(item))}</dd>
                </div>
                <div>
                    <dt>来源</dt>
                    <dd>${escapeHtml(requirementSourceLabel(item))}</dd>
                </div>
            </dl>
            <div class="tt-requirement-params">
                <span class="tt-requirement-detail-label">参数</span>
                <div>${renderRequirementParameterDetails(item)}</div>
            </div>
            ${sourceText ? `
                <div class="tt-requirement-raw">
                    <span class="tt-requirement-detail-label">原文</span>
                    <p>${escapeHtml(sourceText)}</p>
                </div>
            ` : ''}
            ${warnings.length ? `
                <div class="tt-constraint-warning">
                    <i data-lucide="alert-circle"></i>
                    <span>${escapeHtml(warnings[0])}</span>
                </div>
            ` : ''}
        </aside>
    `;
}

function renderRequirementGroups(requirements = [], dialog = {}) {
    if (!requirements.length) return '';
    const activeFilter = REQUIREMENT_FILTERS.some(filter => filter.key === dialog.requirementFilter)
        ? dialog.requirementFilter
        : 'all';
    const visibleRequirements = filteredRequirements(requirements, activeFilter);
    const currentSelection = selectedRequirement(visibleRequirements, dialog.selectedRequirementId || '');
    return `
        <div class="tt-requirement-workbench">
            <div class="tt-requirement-workbench-header">
                <strong>已理解需求 (${requirements.length})</strong>
                <span>${visibleRequirements.length} 条正在显示</span>
            </div>
            ${renderRequirementFilterBar(requirements, activeFilter)}
            <div class="tt-requirement-review-layout">
                <div class="tt-requirement-table" role="table" aria-label="已理解需求">
                    <div class="tt-requirement-table-head" role="row">
                        <span>状态</span>
                        <span>对象</span>
                        <span>需求</span>
                        <span>落点</span>
                        <span>参数</span>
                        <span>来源</span>
                    </div>
                    <div class="tt-requirement-table-body" role="rowgroup">
                        ${visibleRequirements.length
                            ? visibleRequirements.map(item => renderRequirementRow(item, currentSelection?.id || '')).join('')
                            : '<div class="tt-requirement-empty">当前分组没有需求</div>'}
                    </div>
                </div>
                ${renderRequirementDetail(currentSelection)}
            </div>
        </div>
    `;
}

/**
 * 渲染智能约束助手弹窗
 */
export function renderConstraintDialog(state) {
    const dialog = state.constraintDialog || {};
    if (!dialog.open) return '';

    const review = state.ruleReview || {};
    const mode = review.inputMode || 'text';
    const constraints = review.draftRows || [];
    const requirements = review.requirementItems || [];
    const readySemanticActions = (review.semanticActions || []).filter(action => ['ready', 'actionable'].includes(action.status || 'ready') && action.kind !== 'handled_notice');
    const parsing = review.parsing || false;
    const editingConstraint = dialog.editingConstraint;
    const aiChat = dialog.aiChat;
    const hasBlockingConflict = constraints.some(c => c.hasConflict)
        || (review.conflicts || []).some(item => item.level === 'blocking');
    const aiActive = Boolean(aiChat?.active);
    const bodyHtml = aiActive ? `
        <div class="tt-constraint-dialog-body tt-constraint-dialog-body--ai">
            ${renderAIChatPanel(state, aiChat)}
        </div>
    ` : `
        <div class="tt-constraint-dialog-body tt-constraint-dialog-body--intake">
            <div class="tt-constraint-intake-panel">
                <div class="tt-constraint-mode-row">
                    <span class="tt-field-label">规则来源</span>
                    <div class="tt-constraint-input-tabs" role="tablist" aria-label="规则来源">
                        ${renderInputTabs(mode, parsing)}
                    </div>
                </div>

                <div class="tt-constraint-input-area">
                    ${renderInputArea(state, mode, parsing, review)}
                </div>
            </div>
            ${editingConstraint ? renderConstraintEditForm(editingConstraint) : ''}
            ${requirements.length > 0 ? renderRequirementGroups(requirements, dialog) : ''}
            ${constraints.length > 0 ? `
                <div class="tt-constraint-preview">
                    <div class="tt-preview-header">
                        <strong>已识别约束 (${constraints.length})</strong>
                        ${review.conflictCheckDone && constraints.some(c => c.hasConflict) ? `
                            <span class="tt-conflict-badge">
                                <i data-lucide="alert-triangle"></i>
                                ${constraints.filter(c => c.hasConflict).length} 条冲突
                            </span>
                        ` : ''}
                        <button class="tt-btn-link" data-action="clear-all-constraints" type="button">清空全部</button>
                    </div>
                    <div class="tt-constraint-list">
                        ${constraints.map(c => renderConstraintCard(c, state)).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    const actionsHtml = aiActive ? '' : `
        <!-- 操作按钮 -->
        <div class="tt-dialog-actions">
            <button class="tt-btn" data-action="close-constraint-dialog" type="button">取消</button>
            ${constraints.length > 0 || readySemanticActions.length > 0 ? `
                <button class="tt-btn tt-btn--primary" data-action="apply-constraints" type="button" ${parsing || hasBlockingConflict ? 'disabled' : ''}>
                    <i data-lucide="check"></i>
                    <span>应用需求 (${constraints.length + readySemanticActions.length})</span>
                </button>
            ` : ''}
        </div>
    `;

    return `
        <div class="tt-dialog-overlay" data-constraint-dialog-overlay>
            <section class="tt-constraint-dialog ${aiActive ? 'tt-constraint-dialog--with-ai' : ''} ${requirements.length > 0 && !aiActive ? 'tt-constraint-dialog--semantic-review' : ''}" role="dialog" aria-modal="true" aria-labelledby="constraint-dialog-title">
                <!-- 标题栏 -->
                <div class="tt-dialog-header">
                    <div class="tt-dialog-title">
                        <span class="tt-dialog-title-icon"><i data-lucide="brain-circuit"></i></span>
                        <div class="tt-dialog-title-copy">
                            <h3 id="constraint-dialog-title">智能约束助手</h3>
                            <p>把排课要求整理成可复核规则</p>
                        </div>
                    </div>
                    <div class="tt-dialog-header-actions">
                        ${constraints.length > 0 && !aiActive ? `
                            <button class="tt-btn tt-btn--sm tt-btn--ghost" data-action="start-ai-chat" type="button" title="AI 优化约束">
                                <i data-lucide="sparkles"></i>
                                <span>AI 优化</span>
                            </button>
                        ` : ''}
                        <button class="tt-icon-btn" data-action="close-constraint-dialog" aria-label="关闭" type="button">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                </div>
                ${bodyHtml}
                ${actionsHtml}
            </section>
        </div>
    `;
}

function renderInputTabs(mode, parsing) {
    const tabs = [
        { key: 'text', icon: 'message-square', label: '对话输入' },
        { key: 'file', icon: 'upload', label: '上传文件' },
        { key: 'manual', icon: 'list-plus', label: '手动填写' },
    ];

    return tabs.map(tab => `
        <button
            class="tt-tab-btn ${mode === tab.key ? 'is-active' : ''}"
            role="tab"
            aria-selected="${mode === tab.key}"
            data-action="switch-constraint-mode"
            data-mode="${tab.key}"
            type="button"
            ${parsing ? 'disabled' : ''}
        >
            <i data-lucide="${tab.icon}"></i>
            <span>${tab.label}</span>
        </button>
    `).join('');
}

function renderInputArea(state, mode, parsing, review) {
    if (mode === 'text') {
        return `
            <div class="tt-text-input tt-constraint-form-surface">
                <label class="tt-constraint-field">
                    <span>排课要求</span>
                    <textarea
                        id="tt-constraint-text-input"
                        rows="5"
                        placeholder="例如：张老师周一上午不排课；数学尽量安排在上午；体育避开第一节"
                        ${parsing ? 'disabled' : ''}
                    >${escapeHtml(review?.text || '')}</textarea>
                </label>
                ${parsing ? `
                    <div class="tt-parsing-status">
                        <i data-lucide="loader-2" class="tt-spin"></i>
                        <div class="tt-parsing-info">
                            <span>${escapeHtml(review?.phaseText || '正在理解您的要求...')}</span>
                            ${review?.parseProgress !== undefined ? `
                                <div class="tt-progress-bar">
                                    <div class="tt-progress-fill" style="width: ${review.parseProgress}%"></div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                ` : `
                    <div class="tt-constraint-command-row">
                        <div class="tt-quick-examples" aria-label="常用示例">
                            ${['张老师周一不排课', '数学尽量排上午', '体育避开第一节'].map(ex => `
                                <button class="tt-example-chip" data-action="use-example" data-text="${escapeAttr(ex)}" type="button">
                                    ${escapeHtml(ex)}
                                </button>
                            `).join('')}
                        </div>
                        <button class="tt-btn tt-btn--primary" data-action="parse-constraints" type="button">
                            <i data-lucide="wand-sparkles"></i>
                            <span>理解要求</span>
                        </button>
                    </div>
                `}
            </div>
        `;
    }

    if (mode === 'file') {
        return `
            <div class="tt-file-input tt-constraint-form-surface">
                <label class="tt-file-upload-area" for="tt-constraint-file-input">
                    <input type="file" id="tt-constraint-file-input" accept=".txt,.csv,.xlsx,.xls" hidden ${parsing ? 'disabled' : ''}>
                    <i data-lucide="upload-cloud"></i>
                    <strong>${escapeHtml(review.fileName || '点击选择文件')}</strong>
                    <span>支持 TXT / CSV / XLSX 格式</span>
                </label>
                ${review.fileName ? `
                    <div class="tt-constraint-command-row tt-constraint-command-row--end">
                        <button class="tt-btn tt-btn--primary" data-action="parse-constraints" type="button" ${parsing ? 'disabled' : ''}>
                            <i data-lucide="${parsing ? 'loader-2' : 'file-text'}" ${parsing ? 'class="tt-spin"' : ''}></i>
                            <span>${parsing ? '正在解析...' : '解析文件'}</span>
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    if (mode === 'manual') {
        return `
            <div class="tt-manual-input tt-constraint-form-surface">
                <div class="tt-form-grid">
                    <label>
                        <span>约束类型</span>
                        <select id="tt-manual-type">
                            <option value="forbid">禁止安排</option>
                            <option value="prefer">优先安排</option>
                            <option value="avoid">尽量避开</option>
                        </select>
                    </label>
                    <label>
                        <span>对象</span>
                        <input type="text" id="tt-manual-target" placeholder="教师名或课程名">
                    </label>
                    <label>
                        <span>时间</span>
                        <input type="text" id="tt-manual-time" placeholder="周一上午 或 第1-2节">
                    </label>
                </div>
                <div class="tt-constraint-command-row tt-constraint-command-row--end">
                    <button class="tt-btn tt-btn--primary" data-action="add-manual-constraint" type="button">
                        <i data-lucide="plus"></i>
                        <span>添加约束</span>
                    </button>
                </div>
            </div>
        `;
    }

    return '';
}
