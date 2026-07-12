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
import {
    QUICK_CONSTRAINT_EXAMPLES,
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
                <span class="tt-requirement-status tt-requirement-status--${escapeAttr(requirementStatusTone(item))}">
                    ${escapeHtml(requirementStatusLabel(item))}
                </span>
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
    if (stage === 'apply') return '正在写入项目规则和模型设置';
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
            <div class="tt-constraint-flow-current">
                <span>当前进度</span>
                <b data-constraint-flow-current-index>${escapeHtml(`${currentIndex + 1} / ${steps.length}`)}</b>
                <small data-constraint-flow-status>${escapeHtml(statusText)}</small>
            </div>
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

function renderRequirementReviewSummary(requirements = [], activeFilter = 'all', review = {}) {
    const summary = requirementReviewSummary(requirements, activeFilter, review);
    const executableLabel = summary.usesStatistics ? '可执行规则' : '可应用';
    const executableUnit = summary.usesStatistics ? '条' : '项';
    return `
        <div class="tt-requirement-review-summary" aria-label="需求复核概览">
            <span><b>${executableLabel}</b>${escapeHtml(summary.usesStatistics ? summary.executableRuleCount : summary.applicable)} ${executableUnit}</span>
            <span class="${summary.bindingCount ? 'is-warning' : ''}"><b>待绑定</b>${escapeHtml(summary.bindingCount)} 项</span>
            <span class="${summary.clarificationCount ? 'is-warning' : ''}"><b>待补充</b>${escapeHtml(summary.clarificationCount)} 项</span>
            <span class="${summary.unsupportedCount ? 'is-warning' : ''}"><b>真正不支持</b>${escapeHtml(summary.unsupportedCount)} 项</span>
            <span><b>已处理</b>${escapeHtml(summary.handledCount)} 项</span>
            <span class="${summary.complexCount ? 'is-complex' : ''}"><b>复杂模型</b>${escapeHtml(summary.complexCount)} 项</span>
            <em>当前筛选可应用 ${escapeHtml(summary.applicable)} 项</em>
        </div>
    `;
}

function renderRequirementStatisticsLine(summary = {}) {
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

function renderRequirementRow(item = {}, selectedId = '') {
    const sourceText = requirementRawText(item);
    const objectName = requirementObjectName(item);
    const parameterLabel = requirementParameterLabel(item);
    const isSelected = item.id && item.id === selectedId;
    const hasWarning = (item.warnings || []).length > 0;
    const complexBadges = requirementComplexBadges(item);
    const applyTone = requirementApplyTone(item.applyTo, item.status);
    return `
        <button data-action="select-requirement" data-requirement-id="${escapeAttr(item.id || '')}"
            class="tt-requirement-row ${isSelected ? 'is-selected' : ''} ${hasWarning ? 'has-warning' : ''}" type="button" aria-pressed="${isSelected ? 'true' : 'false'}"
            title="${escapeAttr(sourceText || requirementIntentLabel(item.intent))}">
            <span class="tt-requirement-status tt-requirement-status--${escapeAttr(requirementStatusTone(item))}">
                ${escapeHtml(requirementStatusLabel(item))}
                <small>${escapeHtml(requirementOriginLabel(item))}</small>
            </span>
            <span>${escapeHtml(objectName)}</span>
            <span>${escapeHtml(requirementIntentLabel(item.intent))}</span>
            <span class="tt-requirement-destination tt-requirement-destination--${escapeAttr(applyTone)}">${escapeHtml(requirementApplyLabel(item.applyTo))}</span>
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

function renderRequirementEvidenceSection(item = {}, review = {}) {
    const aiReview = renderRequirementAiReview(item, review);
    const evidenceText = renderRequirementEvidenceText(item, aiReview);
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
                    <button class="tt-example-chip tt-requirement-choice-chip"
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

function renderRequirementDetail(item = null, state = {}) {
    if (!item) {
        return `
            <aside class="tt-requirement-detail tt-requirement-detail--empty">
                <i data-lucide="info"></i>
                <span>当前分组没有需求</span>
            </aside>
        `;
    }
    const warnings = item.warnings || [];
    const review = state.ruleReview?.aiReview || {};
    return `
        <aside class="tt-requirement-detail" data-requirement-detail-id="${escapeAttr(item.id || '')}">
            ${renderRequirementDetailSummary(item)}
            ${renderRequirementClauses(item)}
            ${renderRequirementMachineRules(item, state)}
            ${renderRequirementEvidenceSection(item, review)}
            ${renderRequirementClarification(item)}
            ${renderRequirementModelSupport(item)}
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
    const visibleCandidates = filteredRequirements(requirements, activeFilter);
    const userVisibleRequirements = visibleCandidates.filter(item => item.origin !== 'system_supplement');
    const systemVisibleRequirements = visibleCandidates.filter(item => item.origin === 'system_supplement');
    const systemCollapsed = dialog.systemGroupCollapsed !== false;
    const visibleRequirements = systemCollapsed
        ? userVisibleRequirements
        : [...userVisibleRequirements, ...systemVisibleRequirements];
    const currentSelection = selectedRequirement(visibleRequirements, dialog.selectedRequirementId || '');
    const review = state.ruleReview || {};
    const summary = requirementReviewSummary(requirements, activeFilter, review);
    const systemToggle = systemVisibleRequirements.length ? `
        <div class="tt-system-requirement-group ${systemCollapsed ? 'is-collapsed' : 'is-expanded'}">
            <button class="tt-system-requirement-toggle" data-action="toggle-system-group" type="button">
                <span>${systemCollapsed ? '▸' : '▾'} 系统补充的默认规则 (${systemVisibleRequirements.length} 条)</span>
                <small>时间冲突检查、连堂保护等，系统会自动遵守</small>
                <em>${systemCollapsed ? '展开' : '收起'}</em>
            </button>
        </div>
    ` : '';
    return `
        <div class="tt-requirement-workbench">
            <div class="tt-requirement-workbench-header">
                <div class="tt-requirement-workbench-title">
                    <strong>解析结果</strong>
                    <span>${renderRequirementStatisticsLine(summary)}</span>
                </div>
                <button class="tt-btn-link" data-action="clear-all-constraints" type="button">清空全部</button>
            </div>
            ${renderEntityBindingPanel(review)}
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
                        ${userVisibleRequirements.length
                            ? userVisibleRequirements.map(item => renderRequirementRow(item, currentSelection?.id || '')).join('')
                            : (!systemVisibleRequirements.length ? '<div class="tt-requirement-empty">当前分组没有需求</div>' : '')}
                        ${systemToggle}
                        ${!systemCollapsed && systemVisibleRequirements.length
                            ? systemVisibleRequirements.map(item => renderRequirementRow(item, currentSelection?.id || '')).join('')
                            : ''}
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
                    <small>将写入排课规则，立即参与下次排课</small>
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
                            ${QUICK_CONSTRAINT_EXAMPLES.map(ex => `
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
