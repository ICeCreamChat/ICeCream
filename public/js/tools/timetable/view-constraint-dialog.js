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
import {
    buildUnifiedRequirementItems,
    draftRowApplyItemKey,
    filterUnifiedRequirementItems,
    getActionableRequirementCount,
    getRequirementGroupKey,
    isApplyItemExcluded,
    semanticActionApplyItemKey,
} from './constraint-dialog-review-model.js';

function renderConstraintCard(constraint, state) {
    return renderCard(constraint, state);
}

const REQUIREMENT_GROUPS = [
    { key: 'rule', title: '可应用到约束规则', icon: 'list-check' },
    { key: 'lesson_plan', title: '可应用到任课计划', icon: 'blocks' },
    { key: 'optimization', title: '可应用到优化目标', icon: 'sliders-horizontal' },
    { key: 'handled', title: '已自动处理', icon: 'check-circle-2' },
    { key: 'review', title: '需复核', icon: 'circle-alert' },
].map((group) => ({
    ...group,
    entryIcon: 'door-open',
}));

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

const RULE_TYPE_LABELS = {
    teacher_unavailable: '教师不可排',
    class_unavailable: '班级不可排',
    locked_slot: '固定课节',
    subject_morning: '上午优先',
    subject_preferred_periods: '课程优先节次',
    subject_avoid_periods: '课程避开节次',
    teacher_daily_limit: '教师每日上限',
    teacher_consecutive_limit: '教师连续上限',
    subject_spread: '课程分散',
    block_protection: '连堂块保护',
    teacher_load_balance: '教师负载均衡',
    forbid: '禁止安排',
    prefer: '优先安排',
    avoid: '尽量避开',
};

function requirementGroupKey(item = {}) {
    return getRequirementGroupKey(item);
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
        forbid: '禁止安排',
        prefer: '优先安排',
        avoid: '尽量避开',
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
    const rule = (item.machineRules || [])[0];
    if (rule) {
        const slots = rule.slots || rule.time?.slots || [];
        if (rule.limit) return `最多 ${rule.limit} 节`;
        if (slots.length) {
            if (slots.length <= 3) return slots.map(slot => requirementSlotLabel(slot)).join('、');
            return `${slots.length} 个节次`;
        }
        if (rule.type === 'subject_morning') return '上午时段';
        if (rule.type === 'subject_spread') return '分散排布';
    }
    const params = item.parameters || {};
    if (params.blockPreference) {
        return blockPreferenceLabel(params.blockPreference);
    }
    if (params.maxConsecutive) return `连续最多 ${params.maxConsecutive} 节`;
    if (params.limit) return `最多 ${params.limit} 节`;
    if (params.slots?.length) {
        if (params.slots.length <= 3) return params.slots.map(slot => requirementSlotLabel(slot)).join('、');
        return `${params.slots.length} 个节次`;
    }
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
        model_extension: '复杂模型',
        complex_model: '复杂模型',
        handled: '系统策略',
        review: '人工复核',
        needs_review: '人工复核',
    }[key] || (/[A-Za-z_]/.test(String(applyTo || '')) ? '复核' : applyTo || '复核');
}

function normalizedRequirementApplyTo(applyTo = '') {
    return String(applyTo || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function primaryMachineRule(item = {}) {
    return (item.machineRules || []).find(rule => rule && typeof rule === 'object') || null;
}

function shouldPreferMachineRuleSource(item = {}) {
    const applyTo = normalizedRequirementApplyTo(item.applyTo || '');
    if (['rule', 'rules', 'constraint', 'constraint_rule'].includes(applyTo)) return true;
    const visibleActions = (item.semanticActions || []).filter(action => !isRulePatchBridgeAction(action));
    return Boolean((item.machineRules || []).length && !visibleActions.length);
}

function requirementSourceRecord(item = {}) {
    const rule = shouldPreferMachineRuleSource(item) ? primaryMachineRule(item) : null;
    if (rule) {
        return {
            rawText: rule.sourceText || rule.rawText || rule.description || '',
            sourceSheet: rule.sourceSheet || rule.source || '',
            sourceRow: rule.sourceRow || '',
            parseSource: rule.reviewedParseSource || rule.parseSource || '',
            stableKey: rule.stableKey || '',
        };
    }
    return {
        ...(item.source || {}),
        rawText: item.source?.rawText || item.rawText || '',
        sourceSheet: item.source?.sourceSheet || item.source?.sheet || item.sourceSheet || '',
        sourceRow: item.source?.sourceRow || item.source?.row || item.sourceRow || '',
        parseSource: item.reviewedParseSource || item.source?.parseSource || item.parseSource || '',
    };
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
    const rule = (item.machineRules || [])[0];
    if (rule?.targetName) return rule.targetName;
    if (rule?.target?.name) return rule.target.name;
    return item.object?.name || item.targetName || '全局';
}

function requirementRawText(item = {}) {
    return requirementSourceRecord(item).rawText || '';
}

function parseSourceLabel(value = '') {
    const key = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return {
        local_xlsx: '本地识别',
        local_xlsx_ai_reviewed: '本地识别 · AI 已复审',
        local_text: '本地识别',
        local_text_ai_reviewed: '本地识别 · AI 已复审',
        ai_supplement: 'AI 补充',
        ai_supplement_ai_reviewed: 'AI 补充 · AI 已复审',
        ai: 'AI 识别',
        ai_ai_reviewed: 'AI 识别 · AI 已复审',
        cache: '缓存结果',
        mixed_xlsx: '本地 + AI',
        mixed_xlsx_ai_reviewed: '本地 + AI · AI 已复审',
        local_roster_fallback: '本地建议',
        local_roster_fallback_ai_reviewed: '本地建议 · AI 已复审',
    }[key] || '';
}

function requirementSourceLabel(item = {}) {
    const source = requirementSourceRecord(item);
    const sheet = source.sourceSheet || source.sheet || '';
    const row = source.sourceRow || source.row || '';
    const parseLabel = parseSourceLabel(source.parseSource || '');
    const locationLabel = sheet && row
        ? `${sheet} 第 ${row} 行`
        : row
            ? `第 ${row} 行`
            : sheet || '';
    const baseLabel = locationLabel || (requirementRawText(item) ? '输入文本' : '识别结果');
    return [baseLabel, parseLabel].filter(Boolean).join(' · ');
}

function requirementConfidenceLabel(item = {}) {
    if (typeof item.confidence !== 'number') return '未提供';
    const normalized = item.confidence <= 1 ? item.confidence * 100 : item.confidence;
    return `${Math.round(normalized)}%`;
}

function aiReviewStatusLabel(status = '') {
    const key = String(status || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return {
        accepted: 'AI 已复审',
        reviewed: 'AI 已复审',
        flagged: 'AI 复审提示',
        unsupported: 'AI 复审提示',
        patched: 'AI 已修正',
        patch_rejected: 'AI 建议未采纳',
        missed: 'AI 发现漏识别',
    }[key] || '';
}

function renderRequirementAiReview(item = {}, review = {}) {
    const status = item.aiReviewStatus || (review?.status === 'reviewed' ? 'reviewed' : '');
    const label = aiReviewStatusLabel(status);
    const warnings = Array.isArray(item.aiReviewWarnings) ? item.aiReviewWarnings.filter(Boolean) : [];
    const evidence = item.reviewEvidence || {};
    const reviewStatus = String(review?.status || '').trim().toLowerCase();
    if (!label && reviewStatus !== 'unavailable' && reviewStatus !== 'skipped') return '';
    const unavailableMessage = reviewStatus === 'unavailable'
        ? 'AI 复审未完成，当前展示本地识别结果。'
        : reviewStatus === 'skipped'
            ? 'AI 复审已跳过，当前展示本地识别结果。'
            : '';
    const message = warnings[0] || evidence.reason || unavailableMessage || 'AI 已复审此项识别结果。';
    const quote = evidence.quote || '';
    const toneClass = ['flagged', 'unsupported', 'patch_rejected', 'missed'].includes(String(status || '').toLowerCase())
        || reviewStatus === 'unavailable'
        ? 'tt-constraint-warning'
        : 'tt-constraint-info';
    return `
        <div class="${toneClass} tt-requirement-ai-review">
            <i data-lucide="${toneClass === 'tt-constraint-warning' ? 'alert-circle' : 'check-circle-2'}"></i>
            <span>
                <b>${escapeHtml(label || 'AI 复审')}</b>
                ${escapeHtml(message)}
                ${quote ? `<em>${escapeHtml(quote)}</em>` : ''}
            </span>
        </div>
    `;
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

function requirementHasComplexSignal(item = {}) {
    const applyTo = normalizedRequirementApplyTo(item.applyTo || '');
    const params = item.parameters || {};
    const support = item.modelSupport || {};
    const actions = item.semanticActions || [];
    if (applyTo === 'model_extension' || applyTo === 'complex_model') return true;
    if (support.requiredModel || support.capability) return true;
    if (params.weekPattern || params.campusId || params.roomId || params.roomRequirement || params.teachingGroupId) return true;
    return actions.some(action => semanticActionKindKey(action) === 'complex_model_patch');
}

function requirementComplexBadges(item = {}) {
    const params = item.parameters || {};
    const support = item.modelSupport || {};
    const text = [
        item.intent,
        item.applyTo,
        support.capability,
        support.requiredModel,
        ...Object.keys(params),
        ...Object.values(params).filter(value => typeof value === 'string'),
    ].filter(Boolean).join(' ').toLowerCase();
    const badges = [];
    if (params.weekPattern || /week|单双|单周|双周/.test(text)) badges.push('单双周');
    if (params.campusId || /campus|校区|commute/.test(text)) badges.push('多校区');
    if (params.teachingGroupId || /teaching[_-]?group|教学组/.test(text)) badges.push('教学组');
    if (params.roomId || params.roomRequirement || /room|教室|场地/.test(text)) badges.push('教室要求');
    if (!badges.length && requirementHasComplexSignal(item)) badges.push('复杂模型');
    return [...new Set(badges)];
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

function constraintFlowStage(review = {}, requirements = []) {
    const phase = String(review.phase || '');
    if (review.applying || phase === 'saving' || phase === 'save' || phase === 'applying' || phase === 'apply') {
        return 'apply';
    }
    if (review.parsing || review.loading) {
        return 'understand';
    }
    if (
        review.step === 'review'
        || requirements.length > 0
        || (review.draftRows || []).length > 0
        || (review.semanticActions || []).length > 0
    ) {
        return 'review';
    }
    return 'input';
}

function constraintFlowStatusText(review = {}, stage = 'input') {
    if (stage === 'apply') return '当前：正在应用到项目';
    if (stage === 'review') return '当前：请复核已理解需求';
    if (stage === 'understand') {
        return `当前：智能理解中，${review.phaseText || '正在本地识别需求'}`;
    }
    return '当前：输入排课需求';
}

function renderConstraintFlow(compact = false, review = {}, requirements = []) {
    const steps = [
        { key: 'input', label: '输入需求' },
        { key: 'understand', label: '智能理解' },
        { key: 'review', label: '人工复核' },
        { key: 'apply', label: '应用到项目' },
    ];
    const currentStage = constraintFlowStage(review, requirements);
    const currentIndex = Math.max(0, steps.findIndex(step => step.key === currentStage));
    const statusText = constraintFlowStatusText(review, currentStage);
    return `
        <div class="tt-constraint-flow-wrap">
            <div class="tt-constraint-flow ${compact ? 'tt-constraint-flow--compact' : ''}" aria-label="智能约束处理流程">
                ${steps.map((step, index) => {
                    const stepState = index < currentIndex ? 'is-complete' : index === currentIndex ? 'is-current' : 'is-upcoming';
                    const ariaCurrent = stepState === 'is-current' ? ' aria-current="step"' : '';
                    return `
                <span data-flow-step="${escapeAttr(step.key)}" class="tt-constraint-flow-step ${stepState}"${ariaCurrent}>
                    <b>${escapeHtml(index + 1)}</b>
                    <em>${escapeHtml(step.label)}</em>
                </span>
            `;
                }).join('')}
            </div>
            <div class="tt-constraint-flow-status" data-constraint-flow-status data-current-flow-step="${escapeAttr(currentStage)}">
                ${escapeHtml(statusText)}
            </div>
        </div>
    `;
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

function requirementReviewSummary(requirements = [], activeFilter = 'all', review = {}) {
    return {
        applicable: getActionableRequirementCount(review, activeFilter),
        reviewCount: requirementCounts(requirements).get('review') || 0,
        handledCount: requirementCounts(requirements).get('handled') || 0,
        complexCount: requirements.filter(requirementHasComplexSignal).length,
    };
}

function renderRequirementReviewSummary(requirements = [], activeFilter = 'all', review = {}) {
    const summary = requirementReviewSummary(requirements, activeFilter, review);
    return `
        <div class="tt-requirement-review-summary" aria-label="需求复核概览">
            <span><b>可应用</b>${escapeHtml(summary.applicable)} 项</span>
            <span class="${summary.reviewCount ? 'is-warning' : ''}"><b>需复核</b>${escapeHtml(summary.reviewCount)} 项</span>
            <span><b>已处理</b>${escapeHtml(summary.handledCount)} 项</span>
            <span class="${summary.complexCount ? 'is-complex' : ''}"><b>复杂模型</b>${escapeHtml(summary.complexCount)} 项</span>
            <em>当前筛选可应用 ${escapeHtml(summary.applicable)} 项</em>
        </div>
    `;
}

function filteredRequirements(requirements = [], filter = 'all') {
    return filterUnifiedRequirementItems(requirements, filter);
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
    const renderFilterButton = (filter, extraClass = '') => {
        const isActive = (activeFilter || 'all') === filter.key;
        const icon = filter.entryIcon
            ? `
                <span class="tt-requirement-filter-entry" aria-hidden="true">
                    <i data-lucide="${escapeAttr(filter.entryIcon || 'door-open')}"></i>
                </span>
            `
            : `<i class="tt-requirement-filter-icon" data-lucide="${escapeAttr(filter.icon)}"></i>`;
        return `
            <button class="tt-requirement-filter ${extraClass} ${isActive ? 'is-active' : ''}" type="button"
                data-action="filter-requirements" data-requirement-filter="${escapeAttr(filter.key)}" aria-pressed="${isActive ? 'true' : 'false'}">
                ${icon}
                <span>${escapeHtml(filter.title)}</span>
                <b>${counts.get(filter.key) || 0}</b>
            </button>
        `;
    };
    const allFilter = REQUIREMENT_FILTERS.find(filter => filter.key === 'all');
    const childFilters = REQUIREMENT_FILTERS.filter(filter => filter.key !== 'all');
    return `
        <div class="tt-requirement-filter-bar" role="toolbar" aria-label="需求分组筛选">
            ${allFilter ? renderFilterButton(allFilter, 'tt-requirement-filter--all') : ''}
            <div class="tt-requirement-filter-children" role="group" aria-label="需求子分类">
                <span class="tt-requirement-filter-children-label">分类</span>
                ${childFilters.map(filter => renderFilterButton(filter, 'tt-requirement-filter--child')).join('')}
            </div>
        </div>
    `;
}

function renderRequirementRow(item = {}, selectedId = '') {
    const sourceText = requirementRawText(item);
    const objectName = requirementObjectName(item);
    const parameterLabel = requirementParameterLabel(item);
    const isSelected = item.id && item.id === selectedId;
    const hasWarning = (item.warnings || []).length > 0;
    const complexBadges = requirementComplexBadges(item);
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
            <span>
                ${escapeHtml(parameterLabel || '-')}
                ${complexBadges.length ? `<small>${complexBadges.map(badge => escapeHtml(badge)).join(' · ')}</small>` : ''}
            </span>
            <span>${escapeHtml(requirementSourceLabel(item))}</span>
        </button>
    `;
}

function normalizeMachineRuleForRender(rule = {}, state = {}) {
    const typeKey = String(rule.type || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    const confidence = typeof rule.confidence === 'number'
        ? (rule.confidence <= 1 ? rule.confidence * 100 : rule.confidence)
        : null;
    const confidenceTone = rule.confidenceTone
        || (confidence === null ? 'medium' : confidence >= 85 ? 'high' : confidence >= 60 ? 'medium' : 'low');
    const confidenceLabel = rule.confidenceLabel
        || (confidence === null ? '中' : confidence >= 85 ? '高' : confidence >= 60 ? '中' : '低');
    const applyItemKey = draftRowApplyItemKey(rule);
    return {
        ...rule,
        typeLabel: rule.typeLabel || RULE_TYPE_LABELS[typeKey] || '约束规则',
        confidenceTone,
        confidenceLabel,
        understanding: rule.understanding || rule.description || requirementIntentLabel(rule.intent || rule.type),
        applyItemKey,
        applyExcluded: isApplyItemExcluded(state.ruleReview || {}, applyItemKey),
    };
}

function semanticActionKindKey(action = {}) {
    return String(action.kind || action.type || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function isRulePatchBridgeAction(action = {}) {
    const key = semanticActionKindKey(action);
    return key === 'rules_patch' || key === 'rule_patch';
}

function semanticActionLabel(action = {}) {
    const key = semanticActionKindKey(action);
    return {
        lesson_plan_patch: '任课计划修改',
        soft_rules_patch: '优化目标修改',
        optimization_patch: '优化目标修改',
        complex_model_patch: '复杂模型写入',
        rules_patch: '约束规则补丁',
        rule_patch: '约束规则补丁',
        handled_notice: '系统已处理',
    }[key] || '语义动作';
}

function semanticActionStatusLabel(action = {}) {
    const key = String(action.status || 'ready').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return {
        ready: '可应用',
        actionable: '可应用',
        effective: '可应用',
        handled: '已处理',
        needs_review: '需复核',
        review: '需复核',
        skipped: '已跳过',
    }[key] || '待确认';
}

function renderSemanticActionSummary(action = {}, state = {}) {
    const targetLabel = action.target?.name || action.targetName || action.object?.name || '';
    const applyItemKey = semanticActionApplyItemKey(action);
    const applyExcluded = isApplyItemExcluded(state.ruleReview || {}, applyItemKey);
    return `
        <div class="tt-semantic-action-item ${applyExcluded ? 'tt-semantic-action-item--excluded' : ''}" data-apply-item-key="${escapeAttr(applyItemKey)}">
            <span class="tt-constraint-type">${escapeHtml(semanticActionLabel(action))}</span>
            <strong>${escapeHtml(targetLabel || semanticActionLabel(action))}</strong>
            <span>${escapeHtml(applyExcluded ? '暂不应用' : semanticActionStatusLabel(action))}</span>
            <div class="tt-constraint-actions tt-semantic-action-actions">
                <button class="tt-btn tt-btn--sm tt-btn--ghost tt-apply-toggle ${applyExcluded ? 'is-excluded' : ''}" data-action="toggle-constraint-apply-item" data-apply-item-key="${escapeAttr(applyItemKey)}" type="button">
                    ${escapeHtml(applyExcluded ? '恢复应用' : '暂停应用')}
                </button>
            </div>
        </div>
    `;
}

function renderRequirementMachineRules(item = {}, state = {}) {
    const rules = item.machineRules || [];
    const actions = (item.semanticActions || []).filter(action => !isRulePatchBridgeAction(action));
    const itemCount = rules.length + actions.length;
    const outcomeLabels = [];
    if (rules.length) outcomeLabels.push('规则草稿');
    actions.forEach(action => {
        const key = semanticActionKindKey(action);
        if (key === 'lesson_plan_patch') outcomeLabels.push('任课计划');
        else if (key === 'soft_rules_patch' || key === 'optimization_patch') outcomeLabels.push('优化策略');
        else if (key === 'complex_model_patch') outcomeLabels.push('模型设置');
    });
    return `
        <div class="tt-requirement-machine-rules tt-requirement-outcome">
            <div class="tt-requirement-machine-header">
                <span class="tt-requirement-detail-label">落地结果</span>
                ${itemCount ? `<em>${itemCount} 项</em>` : ''}
            </div>
            ${outcomeLabels.length ? `
                <div class="tt-requirement-outcome-tags">
                    ${[...new Set(outcomeLabels)].map(label => `<span>${escapeHtml(label)}</span>`).join('')}
                </div>
            ` : ''}
            ${itemCount ? `
                ${rules.length ? `
                    <div class="tt-machine-rule-list">
                        ${rules.map(rule => renderConstraintCard(normalizeMachineRuleForRender(rule, state), state)).join('')}
                    </div>
                ` : ''}
                ${actions.length ? `
                    <div class="tt-semantic-action-list">
                        ${actions.map(action => renderSemanticActionSummary(action, state)).join('')}
                    </div>
                ` : ''}
            ` : '<p class="tt-requirement-machine-empty">暂无可直接写入的机器规则</p>'}
        </div>
    `;
}

function renderRequirementClarification(item = {}) {
    const clarification = item.clarification;
    const warnings = Array.isArray(item.warnings) ? item.warnings.filter(Boolean) : [];
    const statusKey = String(item.status || item.reviewStatus || '').toLowerCase();
    const requiresReview = statusKey === 'needs_review' || statusKey === 'review' || statusKey === 'pending_review';
    if (!clarification || typeof clarification !== 'object') {
        if (!requiresReview && !warnings.length) return '';
        const message = warnings[0] || '请根据复核原因补充必要信息后再应用。';
        return `
            <div class="tt-requirement-clarification tt-requirement-clarification--readonly">
                <div class="tt-requirement-clarification-header">
                    <span class="tt-requirement-detail-label">待补充信息</span>
                </div>
                <p>${escapeHtml(message)}</p>
            </div>
        `;
    }
    const requirementId = item.id || '';
    const field = clarification.field || 'value';
    const kind = clarification.kind || 'text';
    const defaultValue = clarification.value ?? clarification.defaultValue ?? '';
    const minAttr = Number.isFinite(Number(clarification.min)) ? ` min="${escapeAttr(clarification.min)}"` : '';
    const maxAttr = Number.isFinite(Number(clarification.max)) ? ` max="${escapeAttr(clarification.max)}"` : '';
    const inputHtml = kind === 'number'
        ? `<input class="tt-input" type="number"${minAttr}${maxAttr} value="${escapeAttr(defaultValue)}"
                data-requirement-clarify-input="${escapeAttr(requirementId)}"
                data-requirement-clarify-field="${escapeAttr(field)}">`
        : `<input class="tt-input" type="text" value="${escapeAttr(defaultValue)}"
                data-requirement-clarify-input="${escapeAttr(requirementId)}"
                data-requirement-clarify-field="${escapeAttr(field)}">`;
    return `
        <div class="tt-requirement-clarification">
            <div class="tt-requirement-clarification-header">
                <span class="tt-requirement-detail-label">待补充信息</span>
            </div>
            <label class="tt-constraint-field">
                <span>${escapeHtml(clarification.question || '请补充这个需求的必要参数')}</span>
                <div class="tt-requirement-clarification-control">
                    ${inputHtml}
                    <button class="tt-btn tt-btn--sm tt-btn--primary" data-action="submit-requirement-clarification"
                        data-requirement-id="${escapeAttr(requirementId)}" type="button">更新需求</button>
                </div>
            </label>
        </div>
    `;
}

function renderRequirementComplexBadges(item = {}) {
    const badges = requirementComplexBadges(item);
    if (!badges.length) return '';
    const support = item.modelSupport || {};
    const supportLabel = support.supported === true
        ? '复杂模型已启用'
        : support.supported === false
            ? '复杂模型待启用'
            : '';
    return `
        <div class="tt-requirement-complex-badges" aria-label="复杂排课能力">
            ${badges.map(label => `<span>${escapeHtml(label)}</span>`).join('')}
            ${supportLabel ? `<em>${escapeHtml(supportLabel)}</em>` : ''}
        </div>
    `;
}

function renderRequirementModelSupport(item = {}) {
    const support = item.modelSupport;
    if (!support || typeof support !== 'object') return '';
    const required = support.requiredModel || 'complex_v1';
    const supported = support.supported === true;
    const message = support.message || (supported
        ? '已启用复杂排课模型，可写入对应模型字段。'
        : '当前需求需要复杂排课模型支持，暂不会自动生效。');
    return `
        <div class="${supported ? 'tt-constraint-info' : 'tt-constraint-warning'} tt-requirement-model-support">
            <i data-lucide="layers"></i>
            <span><b>模型支持</b> ${escapeHtml(required)} · ${escapeHtml(supported ? '已支持' : '待启用')} · ${escapeHtml(message)}</span>
        </div>
    `;
}

function renderRequirementDetail(item = null, state = {}) {
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
    const review = state.ruleReview?.aiReview || {};
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
            ${renderRequirementAiReview(item, review)}
            <div class="tt-requirement-params">
                <span class="tt-requirement-detail-label">参数</span>
                <div>${renderRequirementParameterDetails(item)}</div>
            </div>
            ${renderRequirementComplexBadges(item)}
            ${renderRequirementModelSupport(item)}
            ${renderRequirementClarification(item)}
            ${sourceText ? `
                <div class="tt-requirement-raw">
                    <span class="tt-requirement-detail-label">原文</span>
                    <p>${escapeHtml(sourceText)}</p>
                </div>
            ` : ''}
            ${renderRequirementMachineRules(item, state)}
            ${warnings.length ? `
                <div class="tt-constraint-warning">
                    <i data-lucide="alert-circle"></i>
                    <span>${escapeHtml(warnings[0])}</span>
                </div>
            ` : ''}
        </aside>
    `;
}

function renderRequirementGroups(requirements = [], dialog = {}, state = {}) {
    if (!requirements.length) return '';
    const activeFilter = REQUIREMENT_FILTERS.some(filter => filter.key === dialog.requirementFilter)
        ? dialog.requirementFilter
        : 'all';
    const visibleRequirements = filteredRequirements(requirements, activeFilter);
    const currentSelection = selectedRequirement(visibleRequirements, dialog.selectedRequirementId || '');
    const review = state.ruleReview || {};
    const summary = requirementReviewSummary(requirements, activeFilter, review);
    return `
        <div class="tt-requirement-workbench">
            <div class="tt-requirement-workbench-header">
                <div class="tt-requirement-workbench-title">
                    <strong>已理解需求 (${requirements.length})</strong>
                    <span>${visibleRequirements.length} 条正在显示 · 当前筛选可应用 ${summary.applicable} 项</span>
                </div>
                <button class="tt-btn-link" data-action="clear-all-constraints" type="button">清空全部</button>
            </div>
            ${renderRequirementReviewSummary(requirements, activeFilter, review)}
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
                ${renderRequirementDetail(currentSelection, state)}
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
    const requirements = buildUnifiedRequirementItems(review);
    const activeFilter = REQUIREMENT_FILTERS.some(filter => filter.key === dialog.requirementFilter)
        ? dialog.requirementFilter
        : 'all';
    const actionableRequirementCount = getActionableRequirementCount(review, activeFilter);
    const applyButtonLabel = activeFilter === 'all' ? '应用需求' : '应用当前分类';
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
            <div class="tt-constraint-intake-panel ${requirements.length > 0 ? 'tt-constraint-intake-panel--compact' : ''}">
                ${renderConstraintFlow(requirements.length > 0, review, requirements)}
                <div class="tt-constraint-mode-row">
                    <span class="tt-field-label">规则来源</span>
                    <div class="tt-constraint-input-tabs" role="tablist" aria-label="规则来源">
                        ${renderInputTabs(mode, parsing)}
                    </div>
                </div>

                <div class="tt-constraint-input-area">
                    ${renderInputArea(state, mode, parsing, review)}
                </div>
                <p class="tt-constraint-intake-note">文本、文件、手动补充会进入同一套需求理解与人工复核流程。</p>
            </div>
            ${requirements.length > 0 ? renderRequirementGroups(requirements, dialog, state) : ''}
        </div>
    `;
    const actionsHtml = aiActive ? '' : `
        <!-- 操作按钮 -->
        <div class="tt-dialog-actions">
            <button class="tt-btn" data-action="close-constraint-dialog" type="button">取消</button>
            ${actionableRequirementCount > 0 ? `
                <button class="tt-btn tt-btn--primary" data-action="apply-constraints" type="button" ${parsing || hasBlockingConflict ? 'disabled' : ''}>
                    <i data-lucide="check"></i>
                    <span>${applyButtonLabel} (${actionableRequirementCount})</span>
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
                            <p>把自然语言排课需求转换为可复核、可应用的规则和模型设置</p>
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
                ${editingConstraint && !aiActive ? renderConstraintEditForm(editingConstraint, state) : ''}
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
