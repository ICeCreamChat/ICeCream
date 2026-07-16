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
    renderConstraintRuleFormFields,
    renderAIChatPanel,
} from './view-constraint-dialog-components.js';
import {
    buildRequirementReviewViewModel,
    buildUnifiedRequirementItems,
    draftRowApplyItemKey,
    filterUnifiedRequirementItems,
    getActionableRequirementCount,
    getRequirementGroupKey,
    isApplyItemExcluded,
    semanticActionApplyItemKey,
} from './constraint-dialog-review-model.js';
import {
    RULE_TYPE_LABELS,
    normalizeStatusKey,
    requirementApplyExplanation,
    requirementApplyLabel,
    requirementApplyTone,
    requirementIntentLabel,
    requirementStatusLabel,
    semanticActionStatusLabel,
} from './constraint-status-dict.js';

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

function requirementGroupKey(item = {}) {
    return getRequirementGroupKey(item);
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

function normalizedRequirementApplyTo(applyTo = '') {
    return normalizeStatusKey(applyTo);
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
    if (item.sourceRequirement && item.source && typeof item.source === 'object') {
        return {
            ...item.source,
            rawText: item.source.rawText || item.rawText || '',
        };
    }

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
    const status = normalizeStatusKey(item.status || item.reviewStatus || '');
    if (status === 'handled' || status === 'ignored' || status === 'applied') return 'handled';
    if (['needs_clarification', 'needs_review', 'review', 'invalid'].includes(status)) return 'review';
    if (['candidate', 'pending', 'partially_parsed', 'partially_supported', 'partially_actionable', 'partially_executable', 'understood_not_executable', 'unsupported_by_solver', 'unsupported'].includes(status)) return 'warning';
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

function requirementParsedByLabel(item = {}) {
    const parsedBy = Array.isArray(item.parsedBy)
        ? item.parsedBy
        : item.parsedBy
            ? [item.parsedBy]
            : [];
    const labels = [...new Set(parsedBy.map(value => {
        const key = normalizeStatusKey(value);
        if (key.startsWith('local')) return '本地';
        if (key.startsWith('ai')) return 'AI';
        if (key === 'manual') return '手动';
        if (key === 'cache') return '缓存';
        return value ? String(value) : '';
    }).filter(Boolean))];
    return labels.length ? `${labels.join(' + ')} 解析` : '';
}

function requirementSourceLabel(item = {}) {
    const source = requirementSourceRecord(item);
    const sheet = source.sourceSheet || source.sheet || '';
    const row = source.sourceRow || source.row || '';
    const parseLabel = parseSourceLabel(source.parseSource || '') || requirementParsedByLabel(item);
    const locationLabel = sheet && row
        ? `${sheet} 第 ${row} 行`
        : row
            ? `第 ${row} 行`
            : sheet || '';
    const origin = item.origin || source.origin || 'unknown';
    const originFallback = origin === 'system_supplement'
        ? '系统补充'
        : origin === 'manual'
            ? '手动添加'
            : origin === 'user_input'
                ? (requirementRawText(item) ? '输入文本' : '我的输入')
                : '来源未知';
    const baseLabel = locationLabel || originFallback;
    return [baseLabel, parseLabel].filter(Boolean).join(' · ');
}

function requirementOriginLabel(item = {}) {
    if (item.origin === 'system_supplement') return '系统';
    if (item.origin === 'manual') return '手动';
    if (item.origin === 'user_input') return '我的输入';
    return '来源未知';
}

function requirementConfidenceLabel(item = {}) {
    if (typeof item.confidence !== 'number') return '未提供';
    const normalized = item.confidence <= 1 ? item.confidence * 100 : item.confidence;
    return `${Math.round(normalized)}%`;
}

function aiReviewStatusLabel(status = '') {
    const key = String(status || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return {
        accepted: 'AI 已理解',
        reviewed: 'AI 已理解',
        flagged: 'AI 建议',
        unsupported: 'AI 建议',
        patched: 'AI 已修正',
        patch_rejected: 'AI 建议未采纳',
        missed: 'AI 发现漏识别',
    }[key] || '';
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanizeAiReviewMessage(value = '') {
    let message = String(value || '');
    Object.entries(RULE_TYPE_LABELS).forEach(([type, label]) => {
        if (!type || !label) return;
        const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(type)}(?:规则)?(?=$|[^A-Za-z0-9_])`, 'g');
        message = message.replace(pattern, `$1${label}规则`);
    });
    return message;
}

function renderRequirementAiReview(item = {}, review = {}) {
    const artifacts = [item, ...(Array.isArray(item.clauses) ? item.clauses : [])];
    const artifact = artifacts.find(value => value?.aiReviewValidationStatus || value?.aiReviewStatus) || item;
    const validationStatus = String(artifact.aiReviewValidationStatus || '').trim().toLowerCase();
    const status = artifact.aiReviewStatus || (review?.status === 'reviewed' ? 'reviewed' : '');
    const label = artifact.aiReviewBlocking === true && validationStatus === 'blocking'
        ? '已验证阻断'
        : status === 'patched'
            ? 'AI 已修正'
            : validationStatus === 'advisory'
                ? 'AI 建议'
                : aiReviewStatusLabel(status);
    const warnings = Array.isArray(artifact.aiReviewWarnings) ? artifact.aiReviewWarnings.filter(Boolean) : [];
    const evidence = artifact.reviewEvidence || {};
    const reviewStatus = String(review?.status || '').trim().toLowerCase();
    if (!label && reviewStatus !== 'unavailable' && reviewStatus !== 'skipped') return '';
    const unavailableMessage = reviewStatus === 'unavailable'
        ? 'AI 复审未完成，当前展示本地识别结果。'
        : reviewStatus === 'skipped'
            ? 'AI 复审已跳过，当前展示本地识别结果。'
            : '';
    const rawMessage = warnings[0] || evidence.reason || unavailableMessage || '';
    const defaultMessage = rawMessage || '此项识别结果已通过 AI 复审。';
    const quote = evidence.quote || '';
    const normalizedStatus = String(status || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    const tone = (artifact.aiReviewBlocking === true && validationStatus === 'blocking') || reviewStatus === 'unavailable'
        ? 'warning'
        : 'info';
    const title = label || 'AI 复审说明';
    return `
        <div class="tt-requirement-ai-review tt-requirement-ai-review--${tone}">
            <span class="tt-requirement-ai-review-label">${escapeHtml(title)}</span>
            <p>${escapeHtml(humanizeAiReviewMessage(defaultMessage))}</p>
            ${quote ? `<small>${escapeHtml(humanizeAiReviewMessage(quote))}</small>` : ''}
        </div>
    `;
}

function renderRequirementEvidenceText(item = {}, aiReview = '') {
    const evidence = item.reviewEvidence || {};
    const quote = evidence.quote || '';
    if (aiReview && quote) return '';
    const sourceText = quote || requirementRawText(item);
    if (!sourceText) return '';
    return `<p class="tt-requirement-evidence-source">${escapeHtml(humanizeAiReviewMessage(sourceText))}</p>`;
}

function renderRequirementDetailSummary(item = {}) {
    const objectName = requirementObjectName(item);
    const parameterLabel = requirementParameterLabel(item);
    const intentLabel = requirementIntentLabel(item.intent);
    const summaryLine = [intentLabel, parameterLabel].filter(Boolean).join(' · ');
    const metaLine = [
        requirementStrengthLabel(item.strength),
        `置信度 ${requirementConfidenceLabel(item)}`,
    ].filter(Boolean).join(' · ');
    return `
        <div class="tt-requirement-detail-summary">
            <div class="tt-requirement-detail-summary-title">
                <strong>${escapeHtml(objectName)}</strong>
            </div>
            <p>${escapeHtml(summaryLine || intentLabel || '已理解需求')}</p>
            <small>${escapeHtml(metaLine)}</small>
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

function constraintFlowStage(review = {}, requirements = []) {
    const phase = String(review.phase || '');
    if (review.applying || ['saving', 'save', 'applying', 'apply'].includes(phase)) {
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
    if (review.applying || ['saving', 'save', 'applying', 'apply'].includes(String(review.phase || ''))) {
        return '正在写入项目规则和模型设置';
    }
    if (stage === 'review') return '请检查已理解需求和落地结果';
    if (stage === 'understand') {
        return review.phaseText || '正在本地识别需求';
    }
    return '等待输入文本、文件或手动补充';
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
    const flowPercent = steps.length > 1 ? Math.round((currentIndex / (steps.length - 1)) * 10000) / 100 : 0;
    const flowFill = Math.round(flowPercent * 0.75 * 100) / 100;
    const statusText = constraintFlowStatusText(review, currentStage);
    return `
        <div class="tt-constraint-flow-wrap" data-current-flow-step="${escapeAttr(currentStage)}">
            <span class="tt-constraint-flow-status-sr" aria-live="polite">
                <b data-constraint-flow-current-index>${escapeHtml(`${currentIndex + 1} / ${steps.length}`)}</b>
                <span data-constraint-flow-status>${escapeHtml(statusText)}</span>
            </span>
            <div class="tt-constraint-flow ${compact ? 'tt-constraint-flow--compact' : ''}" aria-label="智能约束处理流程" style="--tt-flow-percent: ${flowPercent}%; --tt-flow-fill: ${flowFill}%">
                ${steps.map((step, index) => {
                    const stepState = index < currentIndex ? 'is-complete' : index === currentIndex ? 'is-current' : 'is-upcoming';
                    const ariaCurrent = stepState === 'is-current' ? ' aria-current="step"' : '';
                    return `
                <span data-flow-step="${escapeAttr(step.key)}" class="tt-constraint-flow-step ${stepState}"${ariaCurrent}>
                    <b>${index < currentIndex ? '<i data-lucide="check"></i>' : escapeHtml(index + 1)}</b>
                    <em>${escapeHtml(step.label)}</em>
                </span>
            `;
                }).join('')}
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

const REVIEW_STATISTIC_KEYS = [
    'userInputCount',
    'systemSupplementCount',
    'clauseCount',
    'executableMachineRuleCount',
    'needsReviewCount',
];

function finiteReviewStatistic(statistics = {}, key = '', fallback = 0) {
    const value = Number(statistics?.[key]);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function reviewHasExplicitStatistics(review = {}) {
    const statistics = review.statistics;
    return Boolean(statistics && typeof statistics === 'object'
        && REVIEW_STATISTIC_KEYS.some(key => Number.isFinite(Number(statistics[key]))));
}

function requirementReviewSummary(requirements = [], activeFilter = 'all', review = {}) {
    const counts = requirementCounts(requirements);
    const userItems = requirements.filter(item => item.origin === 'user_input');
    const nonSystemItems = requirements.filter(item => item.origin !== 'system_supplement');
    const systemItems = requirements.filter(item => item.origin === 'system_supplement');
    const derivedClauseCount = nonSystemItems.reduce((total, item) => {
        const clauses = Array.isArray(item.clauses) ? item.clauses.length : 0;
        return total + (clauses || 1);
    }, 0);
    const explicitStatistics = reviewHasExplicitStatistics(review);
    const statistics = review.statistics || {};
    const applicable = getActionableRequirementCount(review, activeFilter);
    return {
        applicable,
        usesStatistics: explicitStatistics,
        userInputCount: finiteReviewStatistic(statistics, 'userInputCount', userItems.length),
        systemSupplementCount: finiteReviewStatistic(statistics, 'systemSupplementCount', systemItems.length),
        clauseCount: finiteReviewStatistic(statistics, 'clauseCount', derivedClauseCount),
        executableRuleCount: finiteReviewStatistic(statistics, 'executableMachineRuleCount', applicable),
        reviewCount: finiteReviewStatistic(statistics, 'needsReviewCount', counts.get('review') || 0),
        bindingCount: finiteReviewStatistic(statistics, 'blockedReferenceSourceCount', 0),
        clarificationCount: finiteReviewStatistic(statistics, 'blockedClarificationSourceCount', 0),
        unsupportedCount: finiteReviewStatistic(statistics, 'unsupportedSolverSourceCount', 0),
        handledCount: counts.get('handled') || 0,
        complexCount: requirements.filter(requirementHasComplexSignal).length,
    };
}

function renderRequirementReviewSummary(viewModel = {}) {
    const counts = viewModel.counts || {};
    return `
        <div class="tt-requirement-review-summary" aria-label="需求复核概览">
            <span class="is-applicable"><b>可直接应用</b><strong>${escapeHtml(counts.applicable || 0)}</strong><small>项</small></span>
            <span class="${counts.attention ? 'is-warning' : ''}"><b>需要确认</b><strong>${escapeHtml(counts.attention || 0)}</strong><small>项</small></span>
            <span class="is-handled"><b>系统已自动处理</b><strong>${escapeHtml(counts.handled || 0)}</strong><small>项</small></span>
        </div>
    `;
}

function renderRequirementDetailField(label, value, className = '') {
    return `
        <section class="tt-requirement-detail-section ${className}">
            <span class="tt-requirement-detail-label">${escapeHtml(label)}</span>
            <strong class="tt-requirement-detail-value">${escapeHtml(value || '-')}</strong>
        </section>
    `;
}

function renderRequirementComplexSection(item = {}) {
    const badges = requirementComplexBadges(item);
    const support = item.modelSupport;
    const supportLabel = support?.supported === true
        ? '已启用'
        : support?.supported === false
            ? '待启用'
            : '';
    const value = badges.length ? badges.join(' · ') : '常规排课规则';
    return `
        <section class="tt-requirement-detail-section tt-requirement-detail-complex">
            <span class="tt-requirement-detail-label">复杂能力</span>
            <div class="tt-requirement-complex-detail">
                <strong class="tt-requirement-detail-value">${escapeHtml(value)}</strong>
                ${supportLabel ? `<span class="tt-requirement-complex-state">${escapeHtml(supportLabel)}</span>` : ''}
            </div>
        </section>
    `;
}

function renderRequirementStatisticsLine(summary = {}) {
    if (!summary.usesStatistics) {
        return `用户输入 ${summary.userInputCount} 条 · 系统补充 ${summary.systemSupplementCount} 条 · 本次可写入排课 ${summary.applicable} 条`;
    }
    return `用户输入 ${summary.userInputCount} 条 · 系统补充 ${summary.systemSupplementCount} 条 · 子约束 ${summary.clauseCount} 条 · 可执行规则 ${summary.executableRuleCount} 条 · 待绑定 ${summary.bindingCount} 条 · 待补充 ${summary.clarificationCount} 条 · 真正不支持 ${summary.unsupportedCount} 条`;
}

function renderLegacyRequirementStatisticsLine(summary = {}) {
    if (!summary.usesStatistics) {
        return `来自你的输入 ${summary.userInputCount} 条 · 系统补充 ${summary.systemSupplementCount} 条 · 本次可写入排课 ${summary.applicable} 条`;
    }
    return `用户输入 ${summary.userInputCount} 条 · 系统补充 ${summary.systemSupplementCount} 条 · 子约束 ${summary.clauseCount} 条 · 可执行规则 ${summary.executableRuleCount} 条 · 待绑定 ${summary.bindingCount} 条 · 待补充 ${summary.clarificationCount} 条 · 真正不支持 ${summary.unsupportedCount} 条`;
}

function renderEntityBindingPanel(review = {}) {
    const unresolved = Array.isArray(review.entityResolution?.unresolved) ? review.entityResolution.unresolved : [];
    if (!unresolved.length) return '';
    const kindLabels = { teacher: '教师', class: '班级', subject: '学科', room: '教室' };
    const bindable = unresolved.filter(item => Array.isArray(item.candidates) && item.candidates.length);
    return `
        <section class="tt-constraint-binding-panel" aria-label="实体绑定">
            <div class="tt-constraint-binding-header">
                <strong>待绑定对象</strong>
                <span>${escapeHtml(unresolved.length)} 个名称未绑定到当前任课数据</span>
            </div>
            <div class="tt-constraint-binding-list">
                ${unresolved.map(item => `
                    <label class="tt-constraint-binding-row">
                        <span>${escapeHtml(kindLabels[item.kind] || item.kind)} · ${escapeHtml(item.sourceName)}</span>
                        ${item.candidates?.length ? `
                            <select data-constraint-binding data-binding-kind="${escapeAttr(item.kind)}" data-binding-source="${escapeAttr(item.sourceName)}">
                                <option value="">选择现有对象</option>
                                ${item.candidates.map(candidate => `<option value="${escapeAttr(candidate.id)}">${escapeHtml(candidate.label || candidate.name || candidate.id)}</option>`).join('')}
                            </select>
                        ` : '<em>当前没有可绑定对象</em>'}
                    </label>
                `).join('')}
            </div>
            <div class="tt-constraint-binding-actions">
                ${bindable.length ? '<button class="tt-btn tt-btn--primary" data-action="rebind-constraint-entities" type="button"><i data-lucide="link"></i>重新绑定并编译</button>' : ''}
                ${unresolved.some(item => !item.candidates?.length) ? '<button class="tt-btn" data-action="open-roster-for-constraint-binding" type="button"><i data-lucide="sheet"></i>进入任课数据导入</button>' : ''}
            </div>
        </section>
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

function renderRequirementRow(viewItem = {}, selectedId = '') {
    const item = viewItem.item || {};
    const parameterLabel = requirementParameterLabel(item);
    const isSelected = viewItem.id && viewItem.id === selectedId;
    const hasWarning = viewItem.bucket === 'attention';
    const title = [viewItem.objectLabel, viewItem.title].filter(Boolean).join('｜');
    const effectLabel = String(viewItem.destinationLabel || '').replace(/^[→✓⚠○]\s*/, '');
    return `
        <button data-action="select-requirement" data-requirement-id="${escapeAttr(viewItem.id || '')}"
            class="tt-requirement-row ${isSelected ? 'is-selected' : ''} ${hasWarning ? 'has-warning' : ''}" type="button" aria-pressed="${isSelected ? 'true' : 'false'}"
            title="${escapeAttr(viewItem.rawText || title)}">
            <span class="tt-requirement-status tt-requirement-status--${escapeAttr(viewItem.statusTone)}">
                ${escapeHtml(viewItem.statusLabel)}
            </span>
            <span class="tt-requirement-row-main">
                <strong>${escapeHtml(title || '排课需求')}</strong>
                <small>${escapeHtml(parameterLabel || viewItem.destinationExplanation)}</small>
            </span>
            <span class="tt-requirement-row-effect tt-requirement-destination--${escapeAttr(viewItem.destinationTone)}">
                <small>将应用到</small>
                <strong>${escapeHtml(effectLabel || '待确认')}</strong>
            </span>
            <span class="tt-requirement-row-source">${escapeHtml(viewItem.sourceLabel)}</span>
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

function clauseUnderstandingStatusKey(clause = {}) {
    const explicit = normalizeStatusKey(clause.understandingStatus || '');
    if (explicit) return explicit;
    const reviewStatus = normalizeStatusKey(clause.reviewStatus || clause.status || '');
    if (reviewStatus === 'needs_clarification') return 'needs_clarification';
    if (reviewStatus === 'invalid') return 'partially_parsed';
    return 'parsed';
}

function clauseExecutionStatusKey(clause = {}) {
    const explicit = normalizeStatusKey(clause.executionStatus || '');
    if (explicit) return explicit;
    if ((clause.machineRuleIds || []).length) return 'executable';
    const reviewStatus = normalizeStatusKey(clause.reviewStatus || clause.status || '');
    if (['unsupported', 'unsupported_by_solver'].includes(reviewStatus)) return 'unsupported_by_solver';
    if (reviewStatus === 'needs_clarification') return 'needs_clarification';
    if (reviewStatus === 'needs_review' || reviewStatus === 'review') return 'needs_review';
    if (reviewStatus === 'handled') return 'handled';
    return reviewStatus || 'understood_not_executable';
}

function renderRequirementClause(clause = {}, index = 0) {
    const understandingStatus = clauseUnderstandingStatusKey(clause);
    const executionStatus = clauseExecutionStatusKey(clause);
    const parameterLabel = requirementParameterLabel(clause);
    const warnings = Array.isArray(clause.warnings) ? clause.warnings.filter(Boolean) : [];
    const executionExplanation = requirementApplyExplanation(clause.applyTo, executionStatus);
    const showExecutionExplanation = ['blocked_by_reference', 'blocked_by_clarification', 'partially_supported', 'partially_actionable', 'partially_executable', 'understood_not_executable', 'unsupported_by_solver', 'unsupported']
        .includes(executionStatus);
    return `
        <li class="tt-requirement-clause-item" data-clause-id="${escapeAttr(clause.clauseId || clause.constraintId || clause.id || '')}">
            <div class="tt-requirement-clause-header">
                <strong>${escapeHtml(index + 1)}. ${escapeHtml(requirementIntentLabel(clause.intent || clause.capabilityId))}</strong>
                <span>${escapeHtml(requirementObjectName(clause))}</span>
            </div>
            <div class="tt-requirement-clause-statuses">
                <span class="tt-requirement-clause-status tt-requirement-clause-status--${escapeAttr(requirementStatusTone({ ...clause, status: understandingStatus }))}">
                    <b>理解</b>${escapeHtml(requirementStatusLabel({ status: understandingStatus }))}
                </span>
                <span class="tt-requirement-clause-status tt-requirement-clause-status--${escapeAttr(requirementStatusTone({ ...clause, status: executionStatus }))}">
                    <b>执行</b>${escapeHtml(requirementStatusLabel({ status: executionStatus }))}
                </span>
            </div>
            ${parameterLabel ? `<p class="tt-requirement-clause-parameter"><b>参数</b>${escapeHtml(parameterLabel)}</p>` : ''}
            ${showExecutionExplanation ? `<p class="tt-requirement-clause-explanation">${escapeHtml(executionExplanation)}</p>` : ''}
            ${warnings.length ? `<p class="tt-requirement-clause-warning"><b>提示</b>${escapeHtml(warnings[0])}</p>` : ''}
        </li>
    `;
}

function renderRequirementClauses(item = {}) {
    const clauses = Array.isArray(item.clauses) ? item.clauses.filter(Boolean) : [];
    if (!clauses.length) return '';
    return `
        <details class="tt-requirement-clauses" open>
            <summary>
                <span>理解为 ${escapeHtml(clauses.length)} 个子约束</span>
                <em>展开/收起查看语义拆分</em>
            </summary>
            <ol class="tt-requirement-clause-list">
                ${clauses.map((clause, index) => renderRequirementClause(clause, index)).join('')}
            </ol>
        </details>
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
                <span class="tt-requirement-detail-label">将应用的规则</span>
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

function renderRequirementEvidenceSection(item = {}, review = {}, includeSourceText = true) {
    const aiReview = renderRequirementAiReview(item, review);
    const evidenceText = includeSourceText ? renderRequirementEvidenceText(item, aiReview) : '';
    if (!aiReview && !evidenceText) return '';
    return `
        <section class="tt-requirement-detail-section tt-requirement-detail-evidence">
            <span class="tt-requirement-detail-label">识别依据</span>
            ${aiReview}
            ${evidenceText}
        </section>
    `;
}

function renderRequirementClarification(item = {}) {
    const clarification = item.clarification;
    const history = Array.isArray(item.clarificationHistory) ? item.clarificationHistory.filter(Boolean) : [];
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
    const options = Array.isArray(clarification.options) ? clarification.options.filter(option => option && (option.value || option.label)) : [];
    const historyHtml = history.length ? `
        <div class="tt-requirement-clarification-history">
            ${history.map(entry => `
                <div class="tt-clarify-bubble tt-clarify-bubble--question">
                    <span>系统</span>
                    <p>${escapeHtml(entry.question || '请补充信息')}</p>
                </div>
                <div class="tt-clarify-bubble tt-clarify-bubble--answer">
                    <span>你</span>
                    <p>${escapeHtml(entry.answerLabel || entry.answer || '')}</p>
                </div>
            `).join('')}
        </div>
    ` : '';
    const inputHtml = kind === 'choice' && options.length
        ? `<div class="tt-requirement-choice-list">
                ${options.map(option => `
                    <button class="tt-requirement-choice-chip"
                        data-action="submit-requirement-clarification"
                        data-requirement-id="${escapeAttr(requirementId)}"
                        data-clarify-value="${escapeAttr(option.value ?? option.id ?? option.label)}"
                        type="button">${escapeHtml(option.label || option.name || option.value)}</button>
                `).join('')}
            </div>`
        : kind === 'number'
        ? `<input class="tt-input" type="number"${minAttr}${maxAttr} value="${escapeAttr(defaultValue)}"
                data-requirement-clarify-input="${escapeAttr(requirementId)}"
                data-requirement-clarify-field="${escapeAttr(field)}">`
        : `<input class="tt-input" type="text" value="${escapeAttr(defaultValue)}"
                data-requirement-clarify-input="${escapeAttr(requirementId)}"
                data-requirement-clarify-field="${escapeAttr(field)}">`;
    const submitHtml = kind === 'choice' && options.length
        ? ''
        : `<button class="tt-btn tt-btn--sm tt-btn--primary" data-action="submit-requirement-clarification"
                data-requirement-id="${escapeAttr(requirementId)}" type="button">更新需求</button>`;
    return `
        <div class="tt-requirement-clarification">
            <div class="tt-requirement-clarification-header">
                <span class="tt-requirement-detail-label">待补充信息</span>
            </div>
            ${historyHtml}
            <label class="tt-constraint-field">
                <span>${escapeHtml(clarification.question || '请补充这个需求的必要参数')}</span>
                <div class="tt-requirement-clarification-control">
                    ${inputHtml}
                    ${submitHtml}
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

function renderRequirementActions(viewItem = {}, state = {}) {
    const item = viewItem.item || {};
    const rules = (item.machineRules || []).filter(Boolean);
    const actions = (item.semanticActions || []).filter(action => !isRulePatchBridgeAction(action));
    const primaryRule = rules[0] || null;
    const primaryAction = !primaryRule ? (actions[0] || null) : null;
    const applyItem = primaryRule || primaryAction;
    if (!applyItem) return '';
    const applyItemKey = primaryRule ? draftRowApplyItemKey(primaryRule) : semanticActionApplyItemKey(primaryAction);
    const excluded = isApplyItemExcluded(state.ruleReview || {}, applyItemKey);
    return `
        <div class="tt-requirement-detail-actions" aria-label="需求操作">
            <button class="tt-btn tt-btn--sm tt-btn--ghost" data-action="toggle-constraint-apply-item"
                data-apply-item-key="${escapeAttr(applyItemKey)}" type="button">
                <i data-lucide="${excluded ? 'rotate-ccw' : 'pause'}"></i>
                <span>${escapeHtml(excluded ? '恢复应用' : '暂不应用')}</span>
            </button>
            ${primaryRule ? `
                <button class="tt-btn tt-btn--sm tt-btn--ghost" data-action="edit-constraint" data-constraint-id="${escapeAttr(primaryRule.id || '')}" type="button">
                    <i data-lucide="pencil"></i><span>编辑规则</span>
                </button>
                <button class="tt-btn tt-btn--sm tt-btn--ghost tt-btn--danger" data-action="delete-constraint" data-constraint-id="${escapeAttr(primaryRule.id || '')}" type="button">
                    <i data-lucide="trash-2"></i><span>删除规则</span>
                </button>
            ` : ''}
        </div>
    `;
}

function renderRequirementAttention(viewItem = {}) {
    if (viewItem.bucket !== 'attention') return '';
    const item = viewItem.item || {};
    const messages = viewItem.attentionItems || [];
    return `
        <section class="tt-requirement-attention" aria-label="需要你处理的问题">
            <div class="tt-requirement-section-heading">
                <i data-lucide="circle-alert"></i>
                <strong>需要你处理的问题</strong>
            </div>
            ${messages.length ? `<ul>${messages.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>` : ''}
            ${renderRequirementClarification(item)}
            ${renderRequirementModelSupport(item)}
        </section>
    `;
}

function renderRequirementTechnicalDetails(viewItem = {}, state = {}) {
    const item = viewItem.item || {};
    const expanded = viewItem.technicalDetailsExpanded === true;
    const review = state.ruleReview?.aiReview || {};
    return `
        <section class="tt-requirement-technical ${expanded ? 'is-expanded' : ''}">
            <button class="tt-requirement-technical-toggle" data-action="toggle-technical-details"
                data-requirement-id="${escapeAttr(viewItem.id)}" type="button" aria-expanded="${expanded ? 'true' : 'false'}">
                <span><i data-lucide="code-2"></i>技术细节</span>
                <small>${expanded ? '收起' : '查看子约束、机器规则和解析依据'}</small>
                <i data-lucide="chevron-down"></i>
            </button>
            ${expanded ? `
                <div class="tt-requirement-technical-body">
                    ${viewItem.technicalDetails.warnings.length
                        ? renderRequirementDetailField('解析提示', viewItem.technicalDetails.warnings.join('；'), 'tt-requirement-detail-warning')
                        : ''}
                    ${renderRequirementComplexSection(item)}
                    ${renderRequirementClauses(item)}
                    ${renderRequirementMachineRules(item, state)}
                    ${renderRequirementEvidenceSection(item, review, false)}
                    ${viewItem.technicalDetails.parsedBy.length ? renderRequirementDetailField('解析方式', requirementParsedByLabel(item)) : ''}
                </div>
            ` : ''}
        </section>
    `;
}

function renderRequirementDetail(viewItem = null, state = {}) {
    if (!viewItem) {
        return `
            <aside class="tt-requirement-detail tt-requirement-detail--empty">
                <i data-lucide="info"></i>
                <span>当前分组没有需求</span>
            </aside>
        `;
    }
    const item = viewItem.item || {};
    const parameterLabel = requirementParameterLabel(item);
    const sourceText = viewItem.rawText || '未保留原始输入文本';
    const effectLabel = String(viewItem.destinationLabel || '').replace(/^[→✓⚠○]\s*/, '');
    return `
        <aside class="tt-requirement-detail" data-requirement-detail-id="${escapeAttr(viewItem.id || '')}">
            <div class="tt-requirement-detail-header">
                <div>
                    <span class="tt-requirement-status tt-requirement-status--${escapeAttr(viewItem.statusTone)}">${escapeHtml(viewItem.statusLabel)}</span>
                    <strong>${escapeHtml(viewItem.objectLabel)}｜${escapeHtml(viewItem.title)}</strong>
                </div>
                <span class="tt-requirement-detail-source">${escapeHtml(viewItem.sourceLabel)}</span>
            </div>
            <section class="tt-requirement-user-section">
                <span class="tt-requirement-detail-label">系统理解</span>
                <strong>${escapeHtml([viewItem.objectLabel, viewItem.title, parameterLabel].filter(Boolean).join(' · '))}</strong>
            </section>
            <section class="tt-requirement-user-section tt-requirement-user-section--effect">
                <span class="tt-requirement-detail-label">将如何生效</span>
                <div>
                    <strong class="tt-requirement-destination--${escapeAttr(viewItem.destinationTone)}">${escapeHtml(effectLabel || '待确认')}</strong>
                    <p>${escapeHtml(viewItem.destinationExplanation)}</p>
                </div>
            </section>
            ${renderRequirementAttention(viewItem)}
            <section class="tt-requirement-source-evidence">
                <span class="tt-requirement-detail-label">原文依据</span>
                <blockquote>${escapeHtml(sourceText)}</blockquote>
            </section>
            ${renderRequirementActions(viewItem, state)}
            ${renderRequirementTechnicalDetails(viewItem, state)}
        </aside>
    `;
}

function renderRequirementBucket(title, description, items = [], selectedId = '', tone = '') {
    if (!items.length) return '';
    return `
        <section class="tt-requirement-bucket tt-requirement-bucket--${escapeAttr(tone || 'default')}">
            <header class="tt-requirement-bucket-header">
                <div>
                    <strong>${escapeHtml(title)}</strong>
                    <small>${escapeHtml(description)}</small>
                </div>
                <span>${escapeHtml(items.length)}</span>
            </header>
            <div class="tt-requirement-bucket-list">
                ${items.map(item => renderRequirementRow(item, selectedId)).join('')}
            </div>
        </section>
    `;
}

function renderRequirementGroups(requirements = [], dialog = {}, state = {}) {
    if (!requirements.length) return '';
    const activeFilter = REQUIREMENT_FILTERS.some(filter => filter.key === dialog.requirementFilter)
        ? dialog.requirementFilter
        : 'all';
    const viewModel = buildRequirementReviewViewModel(state.ruleReview || {}, {
        ...dialog,
        requirementFilter: activeFilter,
    });
    const userAttention = viewModel.groups.attention.filter(item => !item.isSystemSupplement);
    const userApplicable = viewModel.groups.applicable.filter(item => !item.isSystemSupplement);
    const userHandled = viewModel.groups.handled.filter(item => !item.isSystemSupplement);
    const systemVisibleRequirements = viewModel.groups.handled.filter(item => item.isSystemSupplement);
    const systemCollapsed = dialog.systemGroupCollapsed !== false;
    const review = state.ruleReview || {};
    const summary = requirementReviewSummary(requirements, activeFilter, review);
    const systemToggle = systemVisibleRequirements.length ? `
        <div class="tt-system-requirement-group ${systemCollapsed ? 'is-collapsed' : 'is-expanded'}">
            <button class="tt-system-requirement-toggle" data-action="toggle-system-group" type="button" aria-expanded="${systemCollapsed ? 'false' : 'true'}">
                <span><i data-lucide="shield-check"></i>系统补充需求 <b>${systemVisibleRequirements.length}</b></span>
                <small>冲突检查、连堂保护等默认规则</small>
                <em>${systemCollapsed ? '展开' : '收起'} <i data-lucide="chevron-down"></i></em>
            </button>
            ${!systemCollapsed ? `<div class="tt-system-requirement-list">${systemVisibleRequirements.map(item => renderRequirementRow(item, viewModel.selectedId)).join('')}</div>` : ''}
        </div>
    ` : '';
    const hasUserRows = userAttention.length || userApplicable.length || userHandled.length;
    return `
        <div class="tt-requirement-workbench">
            <div class="tt-requirement-workbench-header">
                <div class="tt-requirement-workbench-title">
                    <span class="tt-constraint-section-kicker">复核</span>
                    <strong>解析结果</strong>
                </div>
                <div class="tt-requirement-workbench-meta">
                    <span class="tt-requirement-statistics" title="${escapeAttr(renderLegacyRequirementStatisticsLine(summary))}">共 ${escapeHtml(viewModel.visibleItems.length)} 条需求</span>
                    ${renderRequirementReviewSummary(viewModel)}
                    <button class="tt-btn-link" data-action="clear-all-constraints" type="button">清空全部</button>
                </div>
            </div>
            ${renderEntityBindingPanel(review)}
            ${renderRequirementFilterBar(requirements, activeFilter)}
            <div class="tt-requirement-review-layout">
                <div class="tt-requirement-table tt-requirement-review-main" aria-label="已理解需求">
                    <div class="tt-requirement-table-body">
                        ${renderRequirementBucket('需要确认', '补充信息或确认范围后再应用', userAttention, viewModel.selectedId, 'attention')}
                        ${renderRequirementBucket('可直接应用', '这些需求已准备好写入项目', userApplicable, viewModel.selectedId, 'applicable')}
                        ${renderRequirementBucket('系统已自动处理', '排课引擎已内置处理，无需重复应用', userHandled, viewModel.selectedId, 'handled')}
                        ${!hasUserRows && !systemVisibleRequirements.length ? '<div class="tt-requirement-empty">当前分类没有需求</div>' : ''}
                        ${systemToggle}
                    </div>
                </div>
                ${renderRequirementDetail(viewModel.selectedItem, state)}
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
    const mode = ['text', 'file', 'manual'].includes(review.inputMode) ? review.inputMode : 'text';
    const constraints = review.draftRows || [];
    const requirements = buildUnifiedRequirementItems(review);
    const activeFilter = REQUIREMENT_FILTERS.some(filter => filter.key === dialog.requirementFilter)
        ? dialog.requirementFilter
        : 'all';
    const actionableRequirementCount = getActionableRequirementCount(review, activeFilter);
    const applyButtonLabel = activeFilter === 'all' ? '应用需求' : '应用当前分类';
    const parsing = review.parsing || false;
    const hasResults = requirements.length > 0;
    const inputExpanded = !hasResults || dialog.inputExpanded === true;
    const inputStatusHtml = inputExpanded ? renderConstraintInputStatus(mode, review, requirements) : '';
    const editingConstraint = dialog.editingConstraint;
    const aiChat = dialog.aiChat;
    const hasBlockingConflict = constraints.some(c => c.hasConflict)
        || (review.conflicts || []).some(item => item.level === 'blocking');
    const aiActive = Boolean(aiChat?.active);
    const bodyHtml = aiActive ? `
        <div class="tt-constraint-dialog-body tt-constraint-dialog-body--ai">
            <div class="tt-constraint-stagebar">
                ${renderConstraintFlow(true, review, requirements)}
            </div>
            ${renderAIChatPanel(state, aiChat)}
        </div>
    ` : `
        <div class="tt-constraint-dialog-body tt-constraint-dialog-body--intake ${hasResults && !inputExpanded ? 'tt-constraint-dialog-body--review' : ''}">
            <div class="tt-constraint-stagebar">
                ${renderConstraintFlow(true, review, requirements)}
            </div>
            ${inputExpanded ? `
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
                    ${inputStatusHtml ? `<div class="tt-constraint-input-footer">${inputStatusHtml}</div>` : ''}
                </div>
            ` : renderConstraintInputSummary(mode, review, requirements)}
            ${hasResults ? renderRequirementGroups(requirements, dialog, state) : ''}
        </div>
    `;
    const actionsHtml = aiActive ? '' : `
        <!-- 操作按钮 -->
        <div class="tt-dialog-actions tt-constraint-dialog-actions">
            <button class="tt-btn" data-action="close-constraint-dialog" type="button">取消</button>
            ${inputExpanded ? renderInputModeAction(mode, parsing, review, hasResults, actionableRequirementCount === 0) : ''}
            ${actionableRequirementCount > 0 ? `
                <button class="tt-btn tt-btn--primary" data-action="apply-constraints" type="button" title="将写入排课规则，立即参与下次排课" ${parsing || hasBlockingConflict ? 'disabled' : ''}>
                    <i data-lucide="check"></i>
                    <span>${applyButtonLabel} (${actionableRequirementCount})</span>
                </button>
            ` : ''}
        </div>
    `;

    return `
        <div class="tt-dialog-overlay" data-constraint-dialog-overlay>
            <section class="tt-constraint-dialog ${aiActive ? 'tt-constraint-dialog--with-ai' : ''} ${hasResults && !aiActive ? 'tt-constraint-dialog--semantic-review' : ''}" role="dialog" aria-modal="true" aria-labelledby="constraint-dialog-title">
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
        { key: 'manual', icon: 'sliders-horizontal', label: '手动规则' },
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

function renderConstraintInputStatus(mode, review = {}, requirements = []) {
    const userRequirementCount = requirements.filter(item => item.origin !== 'system_supplement').length;
    const textLineCount = String(review.text || '').split(/\r?\n/).filter(line => line.trim()).length;
    const inputCount = userRequirementCount || (mode === 'file' ? Number(Boolean(review.fileName)) : textLineCount);
    if (inputCount === 0 && requirements.length === 0) return '';
    return `
        <div class="tt-constraint-input-status" aria-live="polite">
            <span>输入状态</span>
            <b>已输入 ${escapeHtml(inputCount)} 条</b>
            <i aria-hidden="true"></i>
            <b>已识别 ${escapeHtml(requirements.length)} 条规则</b>
        </div>
    `;
}

function renderConstraintInputSummary(mode, review = {}, requirements = []) {
    const source = mode === 'file'
        ? (review.parsedFileName || review.fileName || '上传文件')
        : mode === 'manual'
            ? '手动填写'
            : '对话输入';
    const icon = mode === 'file' ? 'file-spreadsheet' : mode === 'manual' ? 'sliders-horizontal' : 'message-square';
    const editLabel = mode === 'file' ? '重新选择文件' : mode === 'manual' ? '继续填写' : '编辑输入';
    return `
        <div class="tt-constraint-input-summary" data-constraint-input-summary aria-live="polite">
            <div class="tt-constraint-input-summary-main">
                <span class="tt-constraint-input-summary-icon" aria-hidden="true"><i data-lucide="${icon}"></i></span>
                <div class="tt-constraint-input-summary-copy">
                    <span>解析完成</span>
                    <strong>已解析 ${escapeHtml(requirements.length)} 条需求</strong>
                    <small title="${escapeAttr(source)}">来源 · ${escapeHtml(source)}</small>
                </div>
            </div>
            <div class="tt-constraint-input-summary-actions">
                <button class="tt-btn tt-btn--sm" data-action="expand-constraint-input" type="button">
                    <i data-lucide="${mode === 'file' ? 'upload' : 'pencil'}"></i>
                    <span>${editLabel}</span>
                </button>
                ${mode === 'text' ? `
                    <button class="tt-btn tt-btn--sm" data-action="reparse-constraint-input" type="button">
                        <i data-lucide="refresh-cw"></i>
                        <span>重新解析</span>
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

function renderInputModeAction(mode, parsing, review, hasResults, isPrimary) {
    const primaryClass = isPrimary ? ' tt-btn--primary' : '';
    if (mode === 'file') {
        const hasFile = Boolean(review.fileName);
        const label = parsing ? '正在解析...' : hasResults ? '重新解析文件' : '解析文件';
        const icon = parsing ? 'loader-2' : hasResults ? 'refresh-cw' : 'file-text';
        return `
            <button class="tt-btn${primaryClass}" data-action="parse-constraints" type="button" ${parsing || !hasFile ? 'disabled' : ''}>
                <i data-lucide="${icon}" ${parsing ? 'class="tt-spin"' : ''}></i>
                <span>${label}</span>
            </button>
        `;
    }
    if (mode === 'manual') {
        return `
            <button class="tt-btn${primaryClass}" data-action="add-manual-constraint" type="button" ${parsing ? 'disabled' : ''}>
                <i data-lucide="${parsing ? 'loader-2' : 'plus'}" ${parsing ? 'class="tt-spin"' : ''}></i>
                <span>${parsing ? '正在添加...' : '添加约束'}</span>
            </button>
        `;
    }
    const label = parsing ? '正在理解...' : hasResults ? '重新理解' : '开始理解';
    const icon = parsing ? 'loader-2' : hasResults ? 'refresh-cw' : 'wand-sparkles';
    return `
        <button class="tt-btn${primaryClass}" data-action="parse-constraints" type="button" ${parsing ? 'disabled' : ''}>
            <i data-lucide="${icon}" ${parsing ? 'class="tt-spin"' : ''}></i>
            <span>${label}</span>
        </button>
    `;
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
                ` : ''}
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
            </div>
        `;
    }

    if (mode === 'manual') {
        const manualType = state.constraintDialog?.manualRuleType || 'teacher_unavailable';
        const manualScope = state.constraintDialog?.manualRuleScope || {};
        return `
            <div class="tt-manual-input tt-constraint-form-surface">
                ${renderConstraintRuleFormFields({
                    project: state.project || {},
                    value: { type: manualType, targetId: '', slots: [], limit: '', ...manualScope },
                    idPrefix: 'tt-manual-rule',
                    slotAttribute: 'data-manual-rule-slot',
                    errors: state.constraintDialog?.manualRuleErrors || {},
                })}
            </div>
        `;
    }

    return '';
}
