/**
 * 智能约束助手弹窗控制器扩展
 * 处理弹窗打开/关闭、输入模式切换、约束解析和应用
 */

import { requestTimetable } from './api.js';
import { compileConstraintRuleArtifacts } from './constraint-rule-form-model.js';
import {
    buildConstraintApplyPlan,
    buildRequirementReviewViewModel,
    buildUnifiedRequirementItems,
    draftRowApplyItemKey,
    filterUnifiedRequirementItems,
    getDefaultRequirementId,
    getRequirementGroupKey,
    semanticActionApplyItemKey,
} from './constraint-dialog-review-model.js';

const REQUIREMENT_FILTER_KEYS = new Set(['all', 'rule', 'lesson_plan', 'optimization', 'handled', 'review']);
const CONSTRAINT_FLOW_STEPS = ['input', 'understand', 'review', 'apply'];

function valueList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function getConstraintFlowStageFromReview(review = {}) {
    const phase = String(review.phase || '');
    if (review.applying || ['saving', 'save', 'applying', 'apply'].includes(phase)) {
        return 'apply';
    }
    if (review.parsing || review.loading) {
        return 'understand';
    }
    if (
        review.step === 'review'
        || valueList(review.sourceRequirements).length > 0
        || valueList(review.systemSupplements).length > 0
        || valueList(review.draftRows).length > 0
        || valueList(review.requirementItems).length > 0
        || valueList(review.semanticActions).length > 0
    ) {
        return 'review';
    }
    return 'input';
}

function getConstraintFlowStatusText(review = {}) {
    const stage = getConstraintFlowStageFromReview(review);
    if (review.applying || ['saving', 'save', 'applying', 'apply'].includes(String(review.phase || ''))) {
        return '正在写入项目规则和模型设置';
    }
    if (stage === 'review') return '请检查已理解需求和落地结果';
    if (stage === 'understand') {
        return review.phaseText || '正在本地识别需求';
    }
    return '等待输入文本、文件或手动补充';
}

function updateConstraintFlowProgressDom(container, review = {}) {
    const stage = getConstraintFlowStageFromReview(review);
    const currentIndex = Math.max(0, CONSTRAINT_FLOW_STEPS.indexOf(stage));
    const flowPercent = CONSTRAINT_FLOW_STEPS.length > 1
        ? Math.round((currentIndex / (CONSTRAINT_FLOW_STEPS.length - 1)) * 10000) / 100
        : 0;
    const flowFill = Math.round(flowPercent * 0.75 * 100) / 100;
    const wrap = container.querySelector?.('.tt-constraint-flow-wrap');
    if (wrap) wrap.dataset.currentFlowStep = stage;
    const flow = container.querySelector?.('.tt-constraint-flow');
    if (flow) {
        flow.style.setProperty('--tt-flow-percent', `${flowPercent}%`);
        flow.style.setProperty('--tt-flow-fill', `${flowFill}%`);
    }
    const currentIndexElement = container.querySelector?.('[data-constraint-flow-current-index]');
    if (currentIndexElement) {
        currentIndexElement.textContent = `${currentIndex + 1} / ${CONSTRAINT_FLOW_STEPS.length}`;
    }
    const status = container.querySelector?.('[data-constraint-flow-status]');
    if (status) {
        status.textContent = getConstraintFlowStatusText(review);
        status.dataset.currentFlowStep = stage;
    }
    CONSTRAINT_FLOW_STEPS.forEach((step, index) => {
        const element = container.querySelector?.(`[data-flow-step="${step}"]`);
        if (!element) return;
        element.classList.toggle('is-complete', index < currentIndex);
        element.classList.toggle('is-current', index === currentIndex);
        element.classList.toggle('is-upcoming', index > currentIndex);
        if (index === currentIndex) {
            element.setAttribute('aria-current', 'step');
        } else {
            element.removeAttribute('aria-current');
        }
    });
}

function updateConstraintParsingProgressDom(container, review = {}) {
    if (!container) return;
    const statusText = container.querySelector?.('.tt-parsing-info > span');
    if (statusText && review.phaseText) {
        statusText.textContent = review.phaseText;
    }
    const progressFill = container.querySelector?.('.tt-progress-fill');
    if (progressFill && review.parseProgress !== undefined) {
        const progress = Math.max(0, Math.min(100, Number(review.parseProgress) || 0));
        progressFill.style.width = `${progress}%`;
    }
    updateConstraintFlowProgressDom(container, review);
}

function visibleRequirementItems(items = [], filter = 'all') {
    return filterUnifiedRequirementItems(items, filter);
}

function normalizeRequirementReviewState(dialog = {}, items = []) {
    const filter = REQUIREMENT_FILTER_KEYS.has(dialog.requirementFilter) ? dialog.requirementFilter : 'all';
    const visibleItems = visibleRequirementItems(items, filter);
    const selectedItem = visibleItems.find(item => item.id && item.id === dialog.selectedRequirementId) || null;
    const hasOutstandingVisibleItem = visibleItems.some(item => getRequirementGroupKey(item) !== 'handled');
    const canKeepSelection = selectedItem
        && (filter === 'handled' || getRequirementGroupKey(selectedItem) !== 'handled' || !hasOutstandingVisibleItem);
    const selectedId = canKeepSelection
        ? dialog.selectedRequirementId
        : getDefaultRequirementId(items, filter);
    return { filter, selectedId };
}

function hasOwn(object = {}, key = '') {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function mergeArrayField(currentReview = {}, result = {}, key = '', replace = false, aliases = []) {
    const resultKey = [key, ...aliases].find(candidate => hasOwn(result, candidate));
    if (resultKey) return valueList(result[resultKey]);
    return replace ? [] : valueList(currentReview[key]);
}

function mergeSourceRequirementsField(currentReview = {}, result = {}, replace = false) {
    if (hasOwn(result, 'sourceRequirements')) {
        return valueList(result.sourceRequirements);
    }
    if (replace) return undefined;
    return currentReview.sourceRequirements === undefined
        ? undefined
        : valueList(currentReview.sourceRequirements);
}

function mergeValueField(currentReview = {}, result = {}, key = '', replace = false, emptyValue = null) {
    if (hasOwn(result, key)) return result[key] ?? emptyValue;
    return replace ? emptyValue : (currentReview[key] ?? emptyValue);
}

function mergeRuleReviewResult(currentReview = {}, result = {}, { replace = false } = {}) {
    const sourceRequirements = mergeSourceRequirementsField(currentReview, result, replace);
    const merged = {
        ...currentReview,
        schemaVersion: mergeValueField(currentReview, result, 'schemaVersion', replace, ''),
        ...(sourceRequirements === undefined ? {} : { sourceRequirements }),
        systemSupplements: mergeArrayField(currentReview, result, 'systemSupplements', replace),
        manualRequirements: mergeArrayField(currentReview, result, 'manualRequirements', replace),
        constraintIRs: mergeArrayField(currentReview, result, 'constraintIRs', replace),
        entityResolution: mergeValueField(currentReview, result, 'entityResolution', replace, null),
        warningItems: mergeArrayField(currentReview, result, 'warningItems', replace),
        statistics: mergeValueField(currentReview, result, 'statistics', replace, null),
        draftRules: mergeValueField(currentReview, result, 'draftRules', replace, null),
        draftRows: mergeArrayField(currentReview, result, 'draftRows', replace, ['rows']),
        previewItems: mergeArrayField(currentReview, result, 'previewItems', replace),
        requirementItems: mergeArrayField(currentReview, result, 'requirementItems', replace),
        semanticActions: mergeArrayField(currentReview, result, 'semanticActions', replace),
        autoAcceptable: mergeArrayField(currentReview, result, 'autoAcceptable', replace),
        needReview: mergeArrayField(currentReview, result, 'needReview', replace),
        clarifyingQuestions: mergeArrayField(currentReview, result, 'clarifyingQuestions', replace),
        missingInfo: mergeArrayField(currentReview, result, 'missingInfo', replace),
        conflicts: mergeArrayField(currentReview, result, 'conflicts', replace),
        warnings: mergeArrayField(currentReview, result, 'warnings', replace),
        unsupportedItems: mergeArrayField(currentReview, result, 'unsupportedItems', replace),
        ruleReport: mergeValueField(currentReview, result, 'ruleReport', replace, null),
        confidenceSummary: mergeValueField(currentReview, result, 'confidenceSummary', replace, null),
        nextAction: mergeValueField(currentReview, result, 'nextAction', replace, ''),
        source: result.source || (replace ? '' : currentReview.source) || '',
        parseSource: result.parseSource || result.source || (replace ? '' : currentReview.parseSource) || '',
        parserVersion: result.parserVersion || (replace ? '' : currentReview.parserVersion) || '',
        cacheHit: hasOwn(result, 'cacheHit') ? Boolean(result.cacheHit) : (replace ? false : Boolean(currentReview.cacheHit)),
        aiReview: mergeValueField(currentReview, result, 'aiReview', replace, null),
        inputType: result.inputType || currentReview.inputType || 'constraint_dialog',
        contextStats: mergeValueField(currentReview, result, 'contextStats', replace, null),
    };
    if (sourceRequirements === undefined) delete merged.sourceRequirements;
    return merged;
}

function cssAttributeValue(value = '') {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function refreshReviewStatistics(review = {}) {
    const sources = valueList(review.sourceRequirements);
    const systemSupplements = valueList(review.systemSupplements);
    const clauses = sources.flatMap(source => valueList(source?.clauses));
    const rows = valueList(review.draftRows);
    const actions = valueList(review.semanticActions);
    const reviewStatuses = new Set([
        'needs_review',
        'needs_clarification',
        'partially_supported',
        'partially_actionable',
        'understood_not_executable',
        'unsupported',
        'invalid',
    ]);
    const needsReview = source => {
        const hasCanonicalState = Object.prototype.hasOwnProperty.call(source, 'requiresHumanReview')
            || Boolean(source.applicationTarget);
        if (hasCanonicalState) {
            return source.requiresHumanReview === true || source.applicationTarget === 'review';
        }
        return reviewStatuses.has(String(source.reviewStatus || source.status || '').toLowerCase())
            || ['unsupported', 'unsupported_by_solver', 'conflicted', 'partially_executable']
                .includes(String(source.executionStatus || '').toLowerCase());
    };
    const machineRows = rows.filter(row => row.machineRuleId);
    const executableRows = machineRows.filter(row => !reviewStatuses.has(String(row.status || row.executionStatus || '').toLowerCase()));
    const sourceHasExecution = (source, status) => source.executionStatus === status
        || valueList(source.clauses).some(clause => clause?.executionStatus === status);
    review.statistics = {
        ...(review.statistics || {}),
        sourceRequirementCount: sources.length,
        userInputCount: sources.filter(source => source.origin === 'user_input').length,
        manualInputCount: sources.filter(source => source.origin === 'manual').length,
        systemSupplementCount: systemSupplements.length,
        needsReviewCount: sources.filter(needsReview).length,
        blockedReferenceSourceCount: sources.filter(source => sourceHasExecution(source, 'blocked_by_reference')).length,
        blockedClarificationSourceCount: sources.filter(source => sourceHasExecution(source, 'blocked_by_clarification')).length,
        unsupportedSolverSourceCount: sources.filter(source => sourceHasExecution(source, 'unsupported_by_solver')).length,
        clauseCount: clauses.length,
        machineRuleCount: machineRows.length,
        executableMachineRuleCount: executableRows.length,
        draftRowCount: rows.length,
        semanticActionCount: actions.length,
    };
}

function getRequirementOwnersForDraftRow(review = {}, constraintId = '') {
    const targetId = String(constraintId || '');
    if (!targetId) return new Set();

    return new Set(
        buildUnifiedRequirementItems(review)
            .filter(item => valueList(item.machineRules).some(row => String(row?.id || '') === targetId))
            .map(item => item.id)
            .filter(Boolean)
    );
}

function getRequirementOwnersForSemanticAction(review = {}, actionId = '') {
    const targetId = String(actionId || '');
    if (!targetId) return new Set();

    return new Set(
        buildUnifiedRequirementItems(review)
            .filter(item => valueList(item.semanticActions).some(action => String(action?.id || '') === targetId))
            .map(item => item.id)
            .filter(Boolean)
    );
}

function removeEmptyRequirementOwners(review = {}, ownerIds = new Set()) {
    const requirementItems = valueList(review.requirementItems);
    if (!ownerIds.size || !requirementItems.length) return;

    const remainingItems = buildUnifiedRequirementItems(review);
    const removableOwners = new Set(
        remainingItems
            .filter(item => ownerIds.has(item.id))
            .filter(item => !valueList(item.machineRules).length && !valueList(item.semanticActions).length)
            .map(item => item.id)
    );

    if (!removableOwners.size) return;

    review.requirementItems = requirementItems.filter(item => !removableOwners.has(item.id));
}

function sourceNeedsContinuedReview(source = {}) {
    if (Object.prototype.hasOwnProperty.call(source, 'requiresHumanReview') || source.applicationTarget) {
        return source.requiresHumanReview === true || source.applicationTarget === 'review';
    }
    const status = String(source.reviewStatus || source.status || '').trim().toLowerCase();
    const executionStatus = String(source.executionStatus || '').trim().toLowerCase();
    return [
        'needs_clarification',
        'partially_supported',
        'partially_actionable',
        'understood_not_executable',
        'unsupported',
        'invalid',
    ].includes(status)
        || ['unsupported', 'unsupported_by_solver', 'conflicted', 'partially_executable'].includes(executionStatus);
}

function markArtifactHandled(artifact = {}, handledAt = '') {
    return {
        ...artifact,
        status: 'handled',
        reviewStatus: 'handled',
        executionStatus: 'applied',
        handledAt,
    };
}

function markAppliedSourceRequirements(review = {}, appliedSourceIds = new Set()) {
    const sourceRequirements = valueList(review.sourceRequirements);
    if (!appliedSourceIds.size || !sourceRequirements.length) {
        return new Set();
    }
    const itemsById = new Map(buildUnifiedRequirementItems(review).map(item => [item.id, item]));
    const handledSourceIds = new Set();
    const handledAt = new Date().toISOString();

    review.sourceRequirements = sourceRequirements.map(sourceRequirement => {
        const sourceId = sourceRequirement.sourceId;
        if (!appliedSourceIds.has(sourceId)) return sourceRequirement;
        const card = itemsById.get(sourceId);
        const hasRemainingLanding = Boolean(valueList(card?.machineRules).length || valueList(card?.semanticActions).length);
        const needsContinuedReview = sourceNeedsContinuedReview(sourceRequirement)
            || valueList(card?.clauses).some(sourceNeedsContinuedReview);
        if (hasRemainingLanding || needsContinuedReview) return sourceRequirement;
        handledSourceIds.add(sourceId);
        return {
            ...markArtifactHandled(sourceRequirement, handledAt),
            clauses: valueList(sourceRequirement.clauses).map(clause => markArtifactHandled(clause, handledAt)),
        };
    });

    if (!handledSourceIds.size) return handledSourceIds;
    for (const key of ['constraintIRs', 'requirementItems']) {
        const artifacts = valueList(review[key]);
        if (!artifacts.length) continue;
        review[key] = artifacts.map(artifact => {
            const sourceId = artifact.sourceId || artifact.source?.sourceId || '';
            return handledSourceIds.has(sourceId) ? markArtifactHandled(artifact, handledAt) : artifact;
        });
    }
    const manualRequirements = valueList(review.manualRequirements);
    if (manualRequirements.length) {
        review.manualRequirements = manualRequirements.map(source => (
            handledSourceIds.has(source.sourceId) ? markArtifactHandled(source, handledAt) : source
        ));
    }
    return handledSourceIds;
}

function hasOutstandingRequirementReview(review = {}) {
    return buildUnifiedRequirementItems(review).some(item => (
        (item.origin || '') !== 'system_supplement'
        && getRequirementGroupKey(item) !== 'handled'
    ));
}

function normalizeActionKind(action = {}) {
    return String(action.kind || action.type || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function collectSemanticActionRowIds(action = {}) {
    const target = action.target || {};
    const source = action.source || {};
    return [
        action.rowId,
        action.ruleId,
        action.draftRowId,
        target.rowId,
        target.ruleId,
        target.draftRowId,
        source.rowId,
        source.ruleId,
        source.draftRowId,
        ...valueList(action.rowIds),
        ...valueList(action.ruleIds),
        ...valueList(action.draftRowIds),
        ...valueList(target.rowIds),
        ...valueList(target.ruleIds),
        ...valueList(target.draftRowIds),
        ...valueList(source.rowIds),
        ...valueList(source.ruleIds),
        ...valueList(source.draftRowIds),
    ].filter(value => value !== undefined && value !== null && String(value) !== '').map(String);
}

function removeSemanticActionsForDraftRow(review = {}, constraintId = '', ownerIds = new Set()) {
    const semanticActions = valueList(review.semanticActions);
    if (!semanticActions.length) return new Set();

    const targetId = String(constraintId || '');
    const removedKeys = new Set();
    review.semanticActions = semanticActions.filter(action => {
        const rowLinked = collectSemanticActionRowIds(action).includes(targetId);
        const ownerLinkedRulePatch = ['rules_patch', 'rule_patch'].includes(normalizeActionKind(action))
            && action.requirementId
            && ownerIds.has(action.requirementId);
        const shouldRemove = rowLinked || ownerLinkedRulePatch;
        if (shouldRemove) removedKeys.add(semanticActionApplyItemKey(action));
        return !shouldRemove;
    });

    return removedKeys;
}

/**
 * 打开智能约束助手弹窗
 */
export function openConstraintDialog(mode = null) {
    const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : null;
    const currentReview = this.state.ruleReview || {};
    const currentDialog = this.state.constraintDialog || {};
    const reviewState = normalizeRequirementReviewState(currentDialog, buildUnifiedRequirementItems(currentReview));
    this.state.constraintDialog = {
        ...currentDialog,
        open: true,
        requirementFilter: reviewState.filter,
        selectedRequirementId: reviewState.selectedId,
        systemGroupCollapsed: currentDialog.systemGroupCollapsed !== false,
    };
    this.state.smartWorkbench = {
        ...(this.state.smartWorkbench || {}),
        open: false,
    };

    // 确保 ruleReview 状态存在；旧协议缺少 sourceRequirements 时必须真正省略该字段，
    // 否则 review model 会误判为新协议并丢弃 legacy requirementItems fallback。
    const sourceRequirements = currentReview.sourceRequirements === undefined
        ? undefined
        : valueList(currentReview.sourceRequirements);
    this.state.ruleReview = {
        ...currentReview,
        inputMode: nextMode || currentReview.inputMode || 'text',
        mode: nextMode || currentReview.inputMode || 'text',
        text: currentReview.text || '',
        ...(sourceRequirements === undefined ? {} : { sourceRequirements }),
        systemSupplements: valueList(currentReview.systemSupplements),
        manualRequirements: valueList(currentReview.manualRequirements),
        constraintIRs: valueList(currentReview.constraintIRs),
        warningItems: valueList(currentReview.warningItems),
        statistics: currentReview.statistics || null,
        draftRows: valueList(currentReview.draftRows),
        requirementItems: valueList(currentReview.requirementItems),
        semanticActions: valueList(currentReview.semanticActions),
        excludedApplyItemKeys: valueList(currentReview.excludedApplyItemKeys),
        parsing: Boolean(currentReview.parsing),
    };
    if (sourceRequirements === undefined) delete this.state.ruleReview.sourceRequirements;

    this.render();
}

/**
 * 关闭智能约束助手弹窗
 */
export function closeConstraintDialog() {
    this.constraintDialogFile = null;
    if (this.state.ruleReview) {
        this.state.ruleReview.fileName = '';
    }
    this.state.constraintDialog = {
        open: false,
    };
    this.render();
}

export function filterRequirements(filter) {
    const nextFilter = REQUIREMENT_FILTER_KEYS.has(filter) ? filter : 'all';
    const items = buildUnifiedRequirementItems(this.state.ruleReview || {});
    if (!this.state.constraintDialog) {
        this.state.constraintDialog = { open: true };
    }
    this.state.constraintDialog.requirementFilter = nextFilter;
    if (nextFilter === 'handled') {
        this.state.constraintDialog.systemGroupCollapsed = false;
    }
    this.state.constraintDialog.selectedRequirementId = getDefaultRequirementId(items, nextFilter);
    this.render();
}

export function toggleSystemRequirementGroup() {
    if (!this.state.constraintDialog) {
        this.state.constraintDialog = { open: true };
    }
    this.state.constraintDialog.systemGroupCollapsed = this.state.constraintDialog.systemGroupCollapsed === false;
    this.render();
}

export function selectRequirement(requirementId) {
    const items = buildUnifiedRequirementItems(this.state.ruleReview || {});
    if (!items.some(item => item.id && item.id === requirementId)) return;
    const requirementList = this.state.container?.querySelector?.('.tt-requirement-table-body');
    const listScrollTop = Number(requirementList?.scrollTop);
    if (!this.state.constraintDialog) {
        this.state.constraintDialog = { open: true };
    }
    this.state.constraintDialog.selectedRequirementId = requirementId;
    this.render();
    const nextRequirementList = this.state.container?.querySelector?.('.tt-requirement-table-body');
    if (nextRequirementList && Number.isFinite(listScrollTop)) {
        nextRequirementList.scrollTop = Math.max(0, listScrollTop);
    }
}

export function toggleRequirementTechnicalDetails(requirementId) {
    const id = String(requirementId || '').trim();
    if (!id) return;
    const dialog = this.state.constraintDialog || { open: true };
    const viewModel = buildRequirementReviewViewModel(this.state.ruleReview || {}, dialog);
    const requirement = viewModel.items.find(item => item.id === id);
    if (!requirement) return;
    this.state.constraintDialog = {
        ...dialog,
        technicalDetailsExpandedById: {
            ...(dialog.technicalDetailsExpandedById || {}),
            [id]: !requirement.technicalDetailsExpanded,
        },
    };
    this.render();
}

export function toggleConstraintApplyItem(applyItemKey) {
    const key = String(applyItemKey || '').trim();
    if (!key) return;
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    const keys = new Set(valueList(this.state.ruleReview.excludedApplyItemKeys).map(String).filter(Boolean));
    if (keys.has(key)) {
        keys.delete(key);
    } else {
        keys.add(key);
    }
    this.state.ruleReview.excludedApplyItemKeys = [...keys];
    this.render();
}

export async function submitRequirementClarification(requirementId, clarifyValue = undefined) {
    const id = String(requirementId || '').trim();
    if (!id) return;
    const items = buildUnifiedRequirementItems(this.state.ruleReview || {});
    const requirement = items.find(item => item.id === id);
    const clarification = requirement?.clarification;
    if (!requirement || !clarification) return;

    const selector = `[data-requirement-clarify-input="${cssAttributeValue(id)}"]`;
    const input = this.state.container?.querySelector?.(selector)
        || (typeof document !== 'undefined' ? document.querySelector?.(selector) : null);
    const rawValue = clarifyValue !== undefined ? clarifyValue : input?.value;
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        alert('请先填写补充信息');
        return;
    }
    const value = clarification.kind === 'number' ? Number(rawValue) : String(rawValue).trim();
    if (clarification.kind === 'number' && !Number.isFinite(value)) {
        alert('请填写有效数字');
        return;
    }

    try {
        const result = await requestTimetable('/requirements/clarify', {
            method: 'POST',
            body: JSON.stringify({
                project: this.state.project || {},
                previousResult: this.state.ruleReview || {},
                answers: [{
                    requirementId: requirement.primaryRequirementId
                        || requirement.requirementIds?.[0]
                        || id,
                    ...(requirement.sourceId ? { sourceId: requirement.sourceId } : {}),
                    field: clarification.field || input?.dataset?.requirementClarifyField || 'value',
                    value,
                }],
                inputType: this.state.ruleReview?.inputType || 'requirement_clarification',
                contextStats: this.state.ruleReview?.contextStats || null,
            }),
        });
        this.state.ruleReview = mergeRuleReviewResult(this.state.ruleReview || {}, result);
        const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            requirementFilter: reviewState.filter,
            selectedRequirementId: buildUnifiedRequirementItems(this.state.ruleReview || {}).some(item => item.id === id)
                ? id
                : reviewState.selectedId,
        };
        if (typeof this.setMessage === 'function') {
            this.setMessage('已更新需求，请复核后应用。');
        }
        this.render();
    } catch (error) {
        console.error('Submit requirement clarification error:', error);
        alert(`更新失败：${error.message || '未知错误'}`);
    }
}

/**
 * 切换输入模式
 */
export function switchConstraintMode(mode) {
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'text';
    this.state.ruleReview.inputMode = nextMode;
    this.state.ruleReview.mode = nextMode;
    if (nextMode !== 'file') {
        this.constraintDialogFile = null;
        this.state.ruleReview.fileName = '';
    }
    this.render();
}

export function expandConstraintInput() {
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        inputExpanded: true,
    };
    this.render();
}

export function reparseConstraintInput() {
    const mode = this.state.ruleReview?.inputMode || 'text';
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        inputExpanded: true,
    };
    this.render();
    if (mode === 'text') {
        setTimeout(() => {
            if (this.state.constraintDialog?.open && this.state.constraintDialog?.inputExpanded) {
                this.parseConstraintsFromDialog();
            }
        }, 0);
    }
}

/**
 * 解析约束（优化版：支持进度反馈）
 */
export async function parseConstraintsFromDialog() {
    const review = this.state.ruleReview || {};
    const mode = review.inputMode || 'text';

    // 获取输入内容
    let inputData = {};
    if (mode === 'text') {
        const textarea = document.getElementById('tt-constraint-text-input');
        const text = textarea?.value?.trim();
        if (!text) {
            alert('请输入排课要求');
            return;
        }
        inputData = { text, source: 'text' };
        this.state.ruleReview.text = text;
    } else if (mode === 'file') {
        const fileInput = document.getElementById('tt-constraint-file-input');
        const file = fileInput?.files?.[0] || this.constraintDialogFile;
        if (!file) {
            alert('请选择文件');
            return;
        }
        inputData = { file, source: 'file' };
    } else {
        alert('手动模式请直接添加约束');
        return;
    }

    const project = this.state.project || {};
    const requiredCollections = ['teachers', 'classes', 'subjects', 'lessonPlans'];
    const teacherIds = new Set((project.teachers || []).map(item => item.id).filter(Boolean));
    const classIds = new Set((project.classes || []).map(item => item.id).filter(Boolean));
    const subjectIds = new Set((project.subjects || []).map(item => item.id).filter(Boolean));
    const lessonPlansValid = (project.lessonPlans || []).every(plan => {
        const planTeacherIds = (plan.teacherIds?.length ? plan.teacherIds : [plan.teacherId]).filter(Boolean);
        return plan.id
            && classIds.has(plan.classId)
            && subjectIds.has(plan.subjectId)
            && planTeacherIds.length > 0
            && planTeacherIds.every(id => teacherIds.has(id));
    });
    const rosterReady = requiredCollections.every(key => Array.isArray(project[key]) && project[key].length > 0)
        && lessonPlansValid;
    if (!rosterReady) {
        this.constraintParseResume = { mode, ...inputData };
        this.setMessage?.('请先导入完整任课数据，导入后会继续解析当前约束。');
        this.openRosterImport?.('file');
        return;
    }

    // 设置解析状态
    this.state.ruleReview.parsing = true;
    this.state.ruleReview.parseProgress = 0;
    this.state.ruleReview.phaseText = '正在本地识别需求...';
    this.render();

    // 模拟进度更新
    const progressInterval = setInterval(() => {
        if (this.state.ruleReview.parseProgress < 90) {
            this.state.ruleReview.parseProgress += 10;
            const phases = [
                '正在本地识别需求...',
                '正在让 AI 复审识别结果...',
                '正在校验复审建议...',
                '正在生成审核台...',
            ];
            const phaseIndex = Math.floor(this.state.ruleReview.parseProgress / 25);
            this.state.ruleReview.phaseText = phases[phaseIndex] || phases[phases.length - 1];
            updateConstraintParsingProgressDom(this.state.container, this.state.ruleReview);
        }
    }, 300);

    try {
        // 调用后端解析接口
        const formData = new FormData();
        if (mode === 'text') {
            formData.append('text', inputData.text);
            formData.append('source', 'text');
        } else if (mode === 'file') {
            formData.append('file', inputData.file);
            formData.append('source', 'file');
        }
        formData.append('project', JSON.stringify(this.state.project || {}));

        const result = await requestTimetable('/rules/parse', {
            method: 'POST',
            body: formData,
        });

        clearInterval(progressInterval);

        // 更新状态
        this.state.ruleReview.parsing = false;
        this.state.ruleReview.parseProgress = 100;
        this.state.ruleReview.phaseText = '';

        const newRows = result.draftRows || result.rows || [];
        this.state.ruleReview = {
            ...mergeRuleReviewResult(
                this.state.ruleReview || {},
                { ...result, draftRows: newRows },
                { replace: true },
            ),
            parsing: false,
            parseProgress: 100,
            phaseText: '',
            inputType: result.inputType || this.state.ruleReview.inputType || mode,
            excludedApplyItemKeys: [],
        };
        const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            requirementFilter: reviewState.filter,
            selectedRequirementId: reviewState.selectedId,
            inputExpanded: false,
        };
        if (mode === 'file') {
            this.state.ruleReview.parsedFileName = inputData.file?.name || this.state.ruleReview.fileName || '';
            this.constraintDialogFile = null;
            this.state.ruleReview.fileName = '';
        }

        // 自动检测冲突
        await this.detectConstraintConflicts();

        this.render();
    } catch (error) {
        clearInterval(progressInterval);
        console.error('Parse constraints error:', error);
        this.state.ruleReview.parsing = false;
        this.state.ruleReview.parseProgress = 0;
        this.state.ruleReview.phaseText = '';
        this.render();
        alert(`解析失败：${error.message || '未知错误'}`);
    }
}

export async function rebindConstraintEntities() {
    const nodes = [...(this.state.container?.querySelectorAll?.('[data-constraint-binding]') || [])];
    const bindings = nodes.map(node => ({
        kind: node.dataset.bindingKind || '',
        sourceName: node.dataset.bindingSource || '',
        targetId: node.value || '',
    })).filter(binding => binding.kind && binding.sourceName && binding.targetId);
    if (!bindings.length) {
        this.setMessage?.('请选择需要绑定的现有实体。');
        return;
    }
    try {
        const result = await requestTimetable('/rules/rebind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bindings, previousResult: this.state.ruleReview || {} }),
        });
        if (result.project) this.state.project = result.project;
        this.state.ruleReview = mergeRuleReviewResult(this.state.ruleReview || {}, result, { replace: true });
        this.setMessage?.(`已绑定 ${bindings.length} 个名称，并完成本地重新编译。`);
        this.render();
    } catch (error) {
        this.handleError?.(error);
    }
}

/**
 * 添加手动约束
 */
export function addManualConstraint() {
    const type = document.getElementById('tt-manual-rule-type')?.value || '';
    const targetValue = document.getElementById('tt-manual-rule-target')?.value || '';
    const limit = document.getElementById('tt-manual-rule-limit')?.value || '';
    const scopeClassId = document.getElementById('tt-manual-rule-scope-class')?.value || '';
    const restrictTeacher = Boolean(document.getElementById('tt-manual-rule-scope-limit-teacher')?.checked);
    const scopeTeacherId = restrictTeacher
        ? (document.getElementById('tt-manual-rule-scope-teacher')?.value || '')
        : '';
    const slots = Array.from(document.querySelectorAll?.('[data-manual-rule-slot]:checked') || [])
        .map(input => String(input.value || '').trim())
        .filter(Boolean);
    const formScope = { targetValue, scopeClassId, restrictTeacher, scopeTeacherId };
    const result = compileConstraintRuleArtifacts({ type, targetValue, slots, limit, ...formScope }, this.state.project || {});

    if (!result.ok) {
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            manualRuleType: type,
            manualRuleScope: formScope,
            manualRuleErrors: result.errors,
        };
        this.render();
        return;
    }

    if (!this.state.ruleReview) {
        this.state.ruleReview = { draftRows: [] };
    }
    this.state.ruleReview.draftRows = valueList(this.state.ruleReview.draftRows);
    this.state.ruleReview.requirementItems = valueList(this.state.ruleReview.requirementItems);
    this.state.ruleReview.sourceRequirements = valueList(this.state.ruleReview.sourceRequirements);
    this.state.ruleReview.manualRequirements = valueList(this.state.ruleReview.manualRequirements);
    this.state.ruleReview.constraintIRs = valueList(this.state.ruleReview.constraintIRs);

    this.state.ruleReview.draftRows.push(result.draftRow);
    this.state.ruleReview.requirementItems.push(result.requirementItem);
    this.state.ruleReview.sourceRequirements.push(result.sourceRequirement);
    this.state.ruleReview.manualRequirements.push(result.sourceRequirement);
    this.state.ruleReview.constraintIRs.push(result.constraintIR);
    refreshReviewStatistics(this.state.ruleReview);
    const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        requirementFilter: reviewState.filter,
        selectedRequirementId: result.sourceRequirement.sourceId,
        manualRuleType: type,
        manualRuleScope: {},
        manualRuleErrors: {},
        inputExpanded: false,
    };
    this.render();
}

export function updateManualConstraintType(type = '') {
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        manualRuleType: type,
        manualRuleScope: {},
        manualRuleErrors: {},
    };
    this.render();
}

export function updateManualConstraintScope(scope = {}) {
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        manualRuleScope: {
            ...(this.state.constraintDialog?.manualRuleScope || {}),
            ...scope,
        },
        manualRuleErrors: {},
    };
    this.render();
}

/**
 * 删除约束
 */
export function deleteConstraint(constraintId) {
    if (!valueList(this.state.ruleReview?.draftRows).length) return;
    if (typeof confirm === 'function' && !confirm('确定要删除这条规则吗？删除后需要重新识别或手动添加。')) {
        return;
    }

    const ownerIds = getRequirementOwnersForDraftRow(this.state.ruleReview, constraintId);
    this.state.ruleReview.draftRows = valueList(this.state.ruleReview.draftRows).filter(
        c => c.id !== constraintId
    );
    const removedActionKeys = removeSemanticActionsForDraftRow(this.state.ruleReview, constraintId, ownerIds);
    removeEmptyRequirementOwners(this.state.ruleReview, ownerIds);
    this.state.ruleReview.excludedApplyItemKeys = valueList(this.state.ruleReview.excludedApplyItemKeys)
        .filter(key => key !== `rule:${constraintId}` && !removedActionKeys.has(key));
    const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        requirementFilter: reviewState.filter,
        selectedRequirementId: reviewState.selectedId,
    };
    this.render();
}

/**
 * 清空所有约束
 */
export function clearAllConstraints() {
    if (!confirm('确定要清空所有已识别的约束吗？')) return;

    if (this.state.ruleReview) {
        [
            'sourceRequirements',
            'systemSupplements',
            'manualRequirements',
            'constraintIRs',
            'warningItems',
            'draftRows',
            'previewItems',
            'requirementItems',
            'semanticActions',
            'autoAcceptable',
            'needReview',
            'clarifyingQuestions',
            'missingInfo',
            'conflicts',
            'warnings',
            'unsupportedItems',
            'excludedApplyItemKeys',
        ].forEach(key => {
            this.state.ruleReview[key] = [];
        });
        this.state.ruleReview.draftRules = null;
        this.state.ruleReview.ruleReport = null;
        this.state.ruleReview.confidenceSummary = null;
        this.state.ruleReview.statistics = null;
        this.state.ruleReview.nextAction = '';
    }
    if (this.state.constraintDialog) {
        this.state.constraintDialog.requirementFilter = 'all';
        this.state.constraintDialog.selectedRequirementId = '';
        this.state.constraintDialog.inputExpanded = true;
    }
    this.render();
}

/**
 * 应用约束
 */
export async function applyConstraintsFromDialog() {
    const constraints = valueList(this.state.ruleReview?.draftRows);
    const activeFilter = REQUIREMENT_FILTER_KEYS.has(this.state.constraintDialog?.requirementFilter)
        ? this.state.constraintDialog.requirementFilter
        : 'all';
    const plan = buildConstraintApplyPlan(this.state.ruleReview || {}, activeFilter);
    const { backendRuleRows, semanticActions } = plan;
    if (plan.requirementCount === 0 || plan.effectCount === 0) {
        alert('没有可应用的需求');
        return;
    }
    const hasBlockingConflict = constraints.some(c => c.hasConflict)
        || valueList(this.state.ruleReview?.conflicts).some(item => item.level === 'blocking');
    if (hasBlockingConflict) {
        alert('存在阻断冲突，请先处理后再应用约束');
        return;
    }

    const confirmMessage = [
        activeFilter === 'all'
            ? `确定应用这 ${plan.requirementCount} 条需求吗？`
            : `确定应用当前分类的 ${plan.requirementCount} 条需求吗？`,
        `${plan.hardRuleCount} 条 → 排课硬规则（必须遵守）`,
        `${plan.softRuleCount} 条 → 排课软规则（尽量满足）`,
        `${plan.lessonPlanActionCount} 条 → 任课计划调整（连堂设置）`,
        '应用后立刻生效，下次排课就会使用。',
    ].join('\n');
    if (!confirm(confirmMessage)) {
        return;
    }

    this.state.ruleReview = {
        ...(this.state.ruleReview || {}),
        loading: true,
        parsing: true,
        applying: true,
        phase: 'saving',
        phaseText: '正在应用到项目...',
        parseProgress: 100,
    };
    this.render();

    try {
        const applyErrors = [];
        const savedRuleIds = new Set();
        const appliedActionIds = new Set();
        const ruleOwnerIds = new Map(backendRuleRows.map(row => [
            row.id,
            getRequirementOwnersForDraftRow(this.state.ruleReview || {}, row.id),
        ]));
        const actionOwnerIds = new Map(semanticActions.map(action => [
            action.id,
            getRequirementOwnersForSemanticAction(this.state.ruleReview || {}, action.id),
        ]));
        const applyReturnedProject = project => {
            if (!project) return;
            if (typeof this.applyProject === 'function') this.applyProject(project);
            else this.state.project = project;
        };

        if (backendRuleRows.length) {
            try {
                const normalized = await requestTimetable('/rules/normalize', {
                    method: 'POST',
                    body: JSON.stringify({
                        draftRows: backendRuleRows,
                        inputType: this.state.ruleReview?.inputType || 'constraint_dialog',
                        contextStats: this.state.ruleReview?.contextStats || null,
                    }),
                });
                const plannedById = new Map(backendRuleRows.map(row => [row.id, row]));
                const normalizedById = new Map(valueList(normalized.draftRows)
                    .filter(row => row?.id && plannedById.has(row.id))
                    .map(row => [row.id, row]));
                this.state.ruleReview.draftRows = valueList(this.state.ruleReview.draftRows).map(row => (
                    normalizedById.has(row.id) ? { ...row, ...normalizedById.get(row.id), id: row.id } : row
                ));
                const effectiveRows = valueList(normalized.draftRows)
                    .filter(row => row?.status === 'effective' && plannedById.has(row.id));

                if (effectiveRows.length) {
                    const savedRules = await requestTimetable('/rules', {
                        method: 'POST',
                        body: JSON.stringify({ rules: normalized.draftRules }),
                    });
                    if (!savedRules?.project) throw new Error('规则接口未返回更新后的项目');
                    applyReturnedProject(savedRules.project);
                    effectiveRows.forEach(row => savedRuleIds.add(row.id));
                }
                const pendingRuleCount = backendRuleRows.length - effectiveRows.length;
                if (pendingRuleCount > 0) {
                    applyErrors.push(`${pendingRuleCount} 条规则未通过规范化校验，已保留复核草稿`);
                }
            } catch (error) {
                applyErrors.push(`规则写入失败：${error.message || '未知错误'}`);
            }
        }

        if (semanticActions.length) {
            try {
                const result = await requestTimetable('/requirements/apply', {
                    method: 'POST',
                    body: JSON.stringify({ actions: semanticActions }),
                });
                const requestedActionIds = new Set(semanticActions.map(action => action.id));
                valueList(result.applied).forEach(item => {
                    const id = typeof item === 'string' ? item : item?.id;
                    if (requestedActionIds.has(id)) appliedActionIds.add(id);
                });
                if (appliedActionIds.size && result.project) applyReturnedProject(result.project);
                const pendingActionCount = semanticActions.length - appliedActionIds.size;
                if (pendingActionCount > 0) {
                    applyErrors.push(`${pendingActionCount} 个模型动作未实际生效，已保留复核草稿`);
                }
                const needsReview = valueList(result.needsReview);
                if (needsReview.length && typeof this.setMessage === 'function') {
                    this.setMessage(`${needsReview.length} 条需求需要复核后再应用。`);
                }
            } catch (error) {
                applyErrors.push(`模型动作应用失败：${error.message || '未知错误'}`);
            }
        }

        const savedRuleRows = backendRuleRows.filter(row => savedRuleIds.has(row.id));
        const appliedActions = semanticActions.filter(action => appliedActionIds.has(action.id));
        const successfulEffectCount = savedRuleRows.length + appliedActions.length;
        if (successfulEffectCount === 0) {
            this.state.ruleReview = {
                ...(this.state.ruleReview || {}),
                loading: false,
                parsing: false,
                applying: false,
                phase: '',
                phaseText: '',
                applyErrors,
            };
            this.state.constraintDialog = {
                ...(this.state.constraintDialog || {}),
                open: true,
            };
            this.render();
            const reason = applyErrors.length ? `\n${applyErrors.join('\n')}` : '';
            alert(`没有需求实际生效，所有草稿均已保留。${reason}`);
            return;
        }

        const appliedOwnerIds = new Set();
        savedRuleRows.forEach(row => {
            const owners = ruleOwnerIds.get(row.id) || new Set();
            if (owners.size) owners.forEach(id => appliedOwnerIds.add(id));
            else if (row.requirementId) appliedOwnerIds.add(row.requirementId);
        });
        appliedActions.forEach(action => {
            const owners = actionOwnerIds.get(action.id) || new Set();
            if (owners.size) owners.forEach(id => appliedOwnerIds.add(id));
            else if (action.requirementId) appliedOwnerIds.add(action.requirementId);
        });

        this.state.ruleReview.savedItems = valueList(this.state.ruleReview.savedItems);
        this.state.ruleReview.savedItems = [
            ...this.state.ruleReview.savedItems,
            ...savedRuleRows,
        ];
        const appliedApplyItemKeys = new Set([
            ...savedRuleRows.map(row => draftRowApplyItemKey(row)),
            ...appliedActions.map(action => semanticActionApplyItemKey(action)),
        ]);
        this.state.ruleReview.draftRows = valueList(this.state.ruleReview.draftRows)
            .filter(row => !savedRuleIds.has(row.id));
        this.state.ruleReview.semanticActions = valueList(this.state.ruleReview.semanticActions)
            .filter(action => !appliedActionIds.has(action.id));
        this.state.ruleReview.excludedApplyItemKeys = valueList(this.state.ruleReview.excludedApplyItemKeys)
            .filter(key => !appliedApplyItemKeys.has(key));
        if (valueList(this.state.ruleReview.sourceRequirements).length) {
            markAppliedSourceRequirements(this.state.ruleReview, appliedOwnerIds);
        } else {
            const remainingById = new Map(buildUnifiedRequirementItems(this.state.ruleReview || {})
                .map(item => [item.id, item]));
            this.state.ruleReview.requirementItems = valueList(this.state.ruleReview.requirementItems)
                .filter(item => {
                    if (item.status === 'handled') return false;
                    if (!appliedOwnerIds.has(item.id)) return true;
                    const remaining = remainingById.get(item.id);
                    return Boolean(valueList(remaining?.machineRules).length || valueList(remaining?.semanticActions).length);
                });
        }
        refreshReviewStatistics(this.state.ruleReview);
        const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
        let postApplyDiagnosis = null;
        let blockingCount = 0;
        try {
            const diagnosisResult = await requestTimetable('/rules/diagnose', {
                method: 'POST',
                body: JSON.stringify({
                    project: this.state.project,
                    recentDraftRows: savedRuleRows,
                    draftRows: savedRuleRows,
                    solverFailure: this.state.lastFailure || this.state.project?.schedule?.solverStats || null,
                }),
            });
            postApplyDiagnosis = diagnosisResult.diagnosis || null;
            blockingCount = valueList(postApplyDiagnosis?.blockingRules).length
                + valueList(postApplyDiagnosis?.conflicts).filter(item => item.level === 'blocking' || item.blocking).length;
        } catch (diagnosisError) {
            postApplyDiagnosis = {
                summary: '约束已应用，但应用后预检暂时不可用。',
                blockingRules: [],
                suggestedRelaxations: ['请生成课表后查看约束满足度报告。'],
                conflicts: [],
                warning: diagnosisError.message || 'diagnose_failed',
            };
        }
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            loading: false,
            parsing: false,
            applying: false,
            phase: '',
            phaseText: '',
            diagnosis: postApplyDiagnosis,
            postApplyBlockingCount: blockingCount,
            applyErrors,
        };
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            requirementFilter: reviewState.filter,
            selectedRequirementId: reviewState.selectedId,
        };

        // 关闭弹窗
        if (!hasOutstandingRequirementReview(this.state.ruleReview || {})) {
            this.closeConstraintDialog();
        } else {
            this.render();
        }

        // 重新渲染主界面
        this.render();

        const actualHardRuleCount = savedRuleRows.filter(row => (
            String(row.priority || row.strength || '').toLowerCase() === 'hard'
        )).length;
        const actualSoftRuleCount = savedRuleRows.length - actualHardRuleCount;
        const actualLessonPlanCount = appliedActions.filter(action => (
            String(action.kind || action.type || '').toLowerCase() === 'lesson_plan_patch'
        )).length;
        const actualRequirementCount = appliedOwnerIds.size || successfulEffectCount;
        const warningText = blockingCount
            ? `\n\n预检发现 ${blockingCount} 个阻塞风险，请先查看诊断建议再排课。`
            : '\n\n预检未发现明显阻塞风险，可以重新排课查看满足度报告。';
        const partial = successfulEffectCount < plan.effectCount || applyErrors.length > 0;
        const prefix = partial ? '部分应用成功：' : '';
        const errorText = applyErrors.length ? `\n\n未生效内容：\n${applyErrors.join('\n')}` : '';
        if (partial && typeof this.setMessage === 'function') {
            this.setMessage(`已应用 ${successfulEffectCount} 个效果，${plan.effectCount - successfulEffectCount} 个效果仍待处理。`);
        }
        alert(`${prefix}已写入 ${actualHardRuleCount} 条硬规则、${actualSoftRuleCount} 条软规则，更新 ${actualLessonPlanCount} 个任课计划。共 ${actualRequirementCount} 条已生效。${errorText}${warningText}`);
    } catch (error) {
        console.error('Apply constraints error:', error);
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            loading: false,
            parsing: false,
            applying: false,
            phase: '',
            phaseText: '',
        };
        this.render();
        alert(`应用失败：${error.message || '未知错误'}`);
    }
}

/**
 * 处理文件选择
 */
export function handleConstraintFileSelect(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    this.constraintDialogFile = file;
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    this.state.ruleReview.inputMode = 'file';
    this.state.ruleReview.mode = 'file';
    this.state.ruleReview.fileName = file.name;
    this.render();
}
