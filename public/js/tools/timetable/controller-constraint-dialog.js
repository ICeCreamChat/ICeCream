/**
 * 智能约束助手弹窗控制器扩展
 * 处理弹窗打开/关闭、输入模式切换、约束解析和应用
 */

import { requestTimetable } from './api.js';
import {
    buildUnifiedRequirementItems,
    draftRowApplyItemKey,
    filterUnifiedRequirementItems,
    getActionableDraftRows,
    getActionableRequirementCount,
    getApplicableSemanticActions,
    getBackendRuleRows,
    getDefaultRequirementId,
    semanticActionApplyItemKey,
} from './constraint-dialog-review-model.js';

const REQUIREMENT_FILTER_KEYS = new Set(['all', 'rule', 'lesson_plan', 'optimization', 'handled', 'review']);
const CONSTRAINT_FLOW_STEPS = ['input', 'understand', 'review', 'apply'];

function getConstraintFlowStageFromReview(review = {}) {
    const phase = String(review.phase || '');
    if (review.applying || phase === 'saving' || phase === 'save' || phase === 'applying' || phase === 'apply') {
        return 'apply';
    }
    if (review.parsing || review.loading) {
        return 'understand';
    }
    if (
        review.step === 'review'
        || (review.draftRows || []).length > 0
        || (review.requirementItems || []).length > 0
        || (review.semanticActions || []).length > 0
    ) {
        return 'review';
    }
    return 'input';
}

function getConstraintFlowStatusText(review = {}) {
    const stage = getConstraintFlowStageFromReview(review);
    if (stage === 'apply') return '正在写入项目规则和模型设置';
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
    const selectedId = visibleItems.some(item => item.id && item.id === dialog.selectedRequirementId)
        ? dialog.selectedRequirementId
        : getDefaultRequirementId(items, filter);
    return { filter, selectedId };
}

function mergeRuleReviewResult(currentReview = {}, result = {}) {
    return {
        ...currentReview,
        draftRules: result.draftRules ?? currentReview.draftRules ?? null,
        draftRows: result.draftRows || [],
        previewItems: result.previewItems || [],
        requirementItems: result.requirementItems || [],
        semanticActions: result.semanticActions || [],
        autoAcceptable: result.autoAcceptable || [],
        needReview: result.needReview || [],
        clarifyingQuestions: result.clarifyingQuestions || [],
        missingInfo: result.missingInfo || [],
        conflicts: result.conflicts || [],
        warnings: result.warnings || [],
        unsupportedItems: result.unsupportedItems || [],
        ruleReport: result.ruleReport || null,
        confidenceSummary: result.confidenceSummary || null,
        nextAction: result.nextAction || '',
        source: result.source || currentReview.source || '',
        parseSource: result.parseSource || result.source || currentReview.parseSource || '',
        parserVersion: result.parserVersion || currentReview.parserVersion || '',
        cacheHit: Boolean(result.cacheHit),
        aiReview: result.aiReview || currentReview.aiReview || null,
        inputType: result.inputType || currentReview.inputType || 'constraint_dialog',
        contextStats: result.contextStats || currentReview.contextStats || null,
    };
}

function cssAttributeValue(value = '') {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function manualRequirementIntent(type = '') {
    return {
        forbid: 'unavailable_periods',
        prefer: 'preferred_periods',
        avoid: 'avoid_periods',
    }[type] || 'manual_requirement';
}

function manualRequirementFromConstraint(constraint = {}) {
    const id = `req_${constraint.id || Date.now()}`;
    return {
        id,
        rowId: constraint.id || '',
        object: {
            kind: 'manual_target',
            name: constraint.targetName || constraint.target?.name || '手动对象',
            matchedIds: [],
            scope: 'manual',
        },
        intent: manualRequirementIntent(constraint.type),
        condition: constraint.timeLabel ? { timeText: constraint.timeLabel } : {},
        parameters: {
            ...(constraint.timeLabel ? { timeText: constraint.timeLabel } : {}),
        },
        strength: constraint.type === 'forbid' ? 'hard' : 'soft',
        status: 'needs_review',
        applyTo: 'review',
        confidence: 0.7,
        source: { rawText: constraint.sourceText || '手动添加' },
        warnings: ['手动填写已进入需求审核，请在应用前确认对象和时间。'],
    };
}

function getRequirementOwnersForDraftRow(review = {}, constraintId = '') {
    const targetId = String(constraintId || '');
    if (!targetId) return new Set();

    return new Set(
        buildUnifiedRequirementItems(review)
            .filter(item => (item.machineRules || []).some(row => String(row?.id || '') === targetId))
            .map(item => item.id)
            .filter(Boolean)
    );
}

function removeEmptyRequirementOwners(review = {}, ownerIds = new Set()) {
    if (!ownerIds.size || !Array.isArray(review.requirementItems)) return;

    const remainingItems = buildUnifiedRequirementItems(review);
    const removableOwners = new Set(
        remainingItems
            .filter(item => ownerIds.has(item.id))
            .filter(item => !(item.machineRules || []).length && !(item.semanticActions || []).length)
            .map(item => item.id)
    );

    if (!removableOwners.size) return;

    review.requirementItems = review.requirementItems.filter(item => !removableOwners.has(item.id));
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
        ...(action.rowIds || []),
        ...(action.ruleIds || []),
        ...(action.draftRowIds || []),
        ...(target.rowIds || []),
        ...(target.ruleIds || []),
        ...(target.draftRowIds || []),
        ...(source.rowIds || []),
        ...(source.ruleIds || []),
        ...(source.draftRowIds || []),
    ].filter(value => value !== undefined && value !== null && String(value) !== '').map(String);
}

function removeSemanticActionsForDraftRow(review = {}, constraintId = '', ownerIds = new Set()) {
    if (!Array.isArray(review.semanticActions)) return new Set();

    const targetId = String(constraintId || '');
    const removedKeys = new Set();
    review.semanticActions = review.semanticActions.filter(action => {
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
    };
    this.state.smartWorkbench = {
        ...(this.state.smartWorkbench || {}),
        open: false,
    };

    // 确保 ruleReview 状态存在
    this.state.ruleReview = {
        ...currentReview,
        inputMode: nextMode || currentReview.inputMode || 'text',
        mode: nextMode || currentReview.inputMode || 'text',
        text: currentReview.text || '',
        draftRows: currentReview.draftRows || [],
        requirementItems: currentReview.requirementItems || [],
        semanticActions: currentReview.semanticActions || [],
        excludedApplyItemKeys: currentReview.excludedApplyItemKeys || [],
        parsing: Boolean(currentReview.parsing),
    };

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
    this.state.constraintDialog.selectedRequirementId = getDefaultRequirementId(items, nextFilter);
    this.render();
}

export function selectRequirement(requirementId) {
    const items = buildUnifiedRequirementItems(this.state.ruleReview || {});
    if (!items.some(item => item.id && item.id === requirementId)) return;
    if (!this.state.constraintDialog) {
        this.state.constraintDialog = { open: true };
    }
    this.state.constraintDialog.selectedRequirementId = requirementId;
    this.render();
}

export function toggleConstraintApplyItem(applyItemKey) {
    const key = String(applyItemKey || '').trim();
    if (!key) return;
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    const keys = new Set((this.state.ruleReview.excludedApplyItemKeys || []).map(String).filter(Boolean));
    if (keys.has(key)) {
        keys.delete(key);
    } else {
        keys.add(key);
    }
    this.state.ruleReview.excludedApplyItemKeys = [...keys];
    this.render();
}

export async function submitRequirementClarification(requirementId) {
    const id = String(requirementId || '').trim();
    if (!id) return;
    const items = buildUnifiedRequirementItems(this.state.ruleReview || {});
    const requirement = items.find(item => item.id === id);
    const clarification = requirement?.clarification;
    if (!requirement || !clarification) return;

    const selector = `[data-requirement-clarify-input="${cssAttributeValue(id)}"]`;
    const input = this.state.container?.querySelector?.(selector)
        || (typeof document !== 'undefined' ? document.querySelector?.(selector) : null);
    const rawValue = input?.value;
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
                    requirementId: id,
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

/**
 * 使用示例文本
 */
export function useConstraintExample(text) {
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    const currentText = this.state.ruleReview.text || '';
    this.state.ruleReview.text = currentText ? `${currentText}\n${text}` : text;
    this.render();

    // 聚焦到文本框末尾
    setTimeout(() => {
        const textarea = document.getElementById('tt-constraint-text-input');
        if (textarea) {
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        }
    }, 0);
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
            ...this.state.ruleReview,
            draftRules: result.draftRules || null,
            draftRows: newRows,
            previewItems: result.previewItems || [],
            requirementItems: result.requirementItems || [],
            semanticActions: result.semanticActions || [],
            autoAcceptable: result.autoAcceptable || [],
            needReview: result.needReview || [],
            clarifyingQuestions: result.clarifyingQuestions || [],
            missingInfo: result.missingInfo || [],
            conflicts: result.conflicts || [],
            warnings: result.warnings || [],
            unsupportedItems: result.unsupportedItems || [],
            ruleReport: result.ruleReport || null,
            confidenceSummary: result.confidenceSummary || null,
            nextAction: result.nextAction || '',
            source: result.source || '',
            parseSource: result.parseSource || result.source || '',
            parserVersion: result.parserVersion || '',
            cacheHit: Boolean(result.cacheHit),
            aiReview: result.aiReview || null,
            inputType: result.inputType || this.state.ruleReview.inputType || mode,
            contextStats: result.contextStats || null,
            excludedApplyItemKeys: [],
        };
        const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            requirementFilter: reviewState.filter,
            selectedRequirementId: reviewState.selectedId,
        };
        if (mode === 'file') {
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

/**
 * 添加手动约束
 */
export function addManualConstraint() {
    const type = document.getElementById('tt-manual-type')?.value;
    const target = document.getElementById('tt-manual-target')?.value?.trim();
    const time = document.getElementById('tt-manual-time')?.value?.trim();

    if (!target || !time) {
        alert('请填写对象和时间');
        return;
    }

    const constraint = {
        id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        typeLabel: { forbid: '禁止', prefer: '优先', avoid: '尽量避开' }[type] || type,
        targetName: target,
        timeLabel: time,
        target: { name: target },
        time: { label: time },
        understanding: `${target} ${time} ${{ forbid: '不排课', prefer: '优先排课', avoid: '尽量避开' }[type]}`,
        sourceText: '手动添加',
        confidenceTone: 'high',
        confidenceLabel: '高',
        status: 'ready',
    };
    const requirement = manualRequirementFromConstraint(constraint);
    constraint.requirementId = requirement.id;

    if (!this.state.ruleReview) {
        this.state.ruleReview = { draftRows: [] };
    }
    if (!this.state.ruleReview.draftRows) {
        this.state.ruleReview.draftRows = [];
    }
    if (!this.state.ruleReview.requirementItems) {
        this.state.ruleReview.requirementItems = [];
    }

    this.state.ruleReview.draftRows.push(constraint);
    this.state.ruleReview.requirementItems.push(requirement);
    const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
    this.state.constraintDialog = {
        ...(this.state.constraintDialog || {}),
        requirementFilter: reviewState.filter,
        selectedRequirementId: requirement.id,
    };
    this.render();

    // 清空表单
    setTimeout(() => {
        const targetInput = document.getElementById('tt-manual-target');
        const timeInput = document.getElementById('tt-manual-time');
        if (targetInput) targetInput.value = '';
        if (timeInput) timeInput.value = '';
    }, 0);
}

/**
 * 删除约束
 */
export function deleteConstraint(constraintId) {
    if (!this.state.ruleReview?.draftRows) return;
    if (typeof confirm === 'function' && !confirm('确定要删除这条规则吗？删除后需要重新识别或手动添加。')) {
        return;
    }

    const ownerIds = getRequirementOwnersForDraftRow(this.state.ruleReview, constraintId);
    this.state.ruleReview.draftRows = this.state.ruleReview.draftRows.filter(
        c => c.id !== constraintId
    );
    const removedActionKeys = removeSemanticActionsForDraftRow(this.state.ruleReview, constraintId, ownerIds);
    removeEmptyRequirementOwners(this.state.ruleReview, ownerIds);
    this.state.ruleReview.excludedApplyItemKeys = (this.state.ruleReview.excludedApplyItemKeys || [])
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
        this.state.ruleReview.draftRows = [];
        this.state.ruleReview.requirementItems = [];
        this.state.ruleReview.semanticActions = [];
        this.state.ruleReview.excludedApplyItemKeys = [];
    }
    if (this.state.constraintDialog) {
        this.state.constraintDialog.requirementFilter = 'all';
        this.state.constraintDialog.selectedRequirementId = '';
    }
    this.render();
}

/**
 * 应用约束
 */
export async function applyConstraintsFromDialog() {
    const constraints = this.state.ruleReview?.draftRows || [];
    const activeFilter = REQUIREMENT_FILTER_KEYS.has(this.state.constraintDialog?.requirementFilter)
        ? this.state.constraintDialog.requirementFilter
        : 'all';
    const actionableDraftRows = getActionableDraftRows(this.state.ruleReview || {}, activeFilter);
    const backendRuleRows = getBackendRuleRows(this.state.ruleReview || {}, activeFilter);
    const semanticActions = getApplicableSemanticActions(this.state.ruleReview || {}, activeFilter);
    const applyCount = getActionableRequirementCount(this.state.ruleReview || {}, activeFilter);
    if (applyCount === 0) {
        alert('没有可应用的需求');
        return;
    }
    const hasBlockingConflict = constraints.some(c => c.hasConflict)
        || (this.state.ruleReview?.conflicts || []).some(item => item.level === 'blocking');
    if (hasBlockingConflict) {
        alert('存在阻断冲突，请先处理后再应用约束');
        return;
    }

    const confirmMessage = activeFilter === 'all'
        ? `确定要应用 ${applyCount} 条需求吗？`
        : `确定要应用当前分类的 ${applyCount} 条需求吗？`;
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
        if (backendRuleRows.length) {
            const normalized = await requestTimetable('/rules/normalize', {
                method: 'POST',
                body: JSON.stringify({
                    draftRows: backendRuleRows,
                    inputType: this.state.ruleReview?.inputType || 'constraint_dialog',
                    contextStats: this.state.ruleReview?.contextStats || null,
                }),
            });
            const effectiveCount = (normalized.draftRows || []).filter(row => row.status === 'effective').length;
            if (effectiveCount !== backendRuleRows.length) {
                this.state.ruleReview = {
                    ...(this.state.ruleReview || {}),
                    ...normalized,
                    open: true,
                    loading: false,
                    parsing: false,
                    applying: false,
                    phase: '',
                    phaseText: '',
                };
                this.render();
                alert('部分约束需要复核后才能应用');
                return;
            }
            const savedRules = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: normalized.draftRules }),
            });
            if (savedRules.project) {
                if (typeof this.applyProject === 'function') {
                    this.applyProject(savedRules.project);
                } else {
                    this.state.project = savedRules.project;
                }
            }
        }

        const appliedActionIds = new Set();
        const appliedRequirementIds = new Set();
        if (semanticActions.length) {
            const result = await requestTimetable('/requirements/apply', {
                method: 'POST',
                body: JSON.stringify({ actions: semanticActions }),
            });
            if (result.project) {
                if (typeof this.applyProject === 'function') {
                    this.applyProject(result.project);
                } else {
                    this.state.project = result.project;
                }
            }
            (result.applied || []).forEach(item => appliedActionIds.add(item.id));
            semanticActions
                .filter(action => appliedActionIds.has(action.id))
                .forEach(action => {
                    if (action.requirementId) appliedRequirementIds.add(action.requirementId);
                });
            if ((result.needsReview || []).length && typeof this.setMessage === 'function') {
                this.setMessage(`${result.needsReview.length} 条需求需要复核后再应用。`);
            }
        }

        // 将约束标记为已应用
        actionableDraftRows.forEach(c => {
            c.status = 'effective';
        });

        // 合并到已保存的约束
        if (!this.state.ruleReview.savedItems) {
            this.state.ruleReview.savedItems = [];
        }
        this.state.ruleReview.savedItems = [
            ...this.state.ruleReview.savedItems,
            ...actionableDraftRows,
        ];

        // 清空草稿
        const appliedRuleIds = new Set(actionableDraftRows.map(row => row.id));
        actionableDraftRows.forEach(row => {
            getRequirementOwnersForDraftRow(this.state.ruleReview || {}, row.id)
                .forEach(ownerId => appliedRequirementIds.add(ownerId));
        });
        const appliedApplyItemKeys = new Set([
            ...actionableDraftRows.map(row => draftRowApplyItemKey(row)),
            ...semanticActions.map(action => semanticActionApplyItemKey(action)),
        ]);
        this.state.ruleReview.draftRows = (this.state.ruleReview.draftRows || [])
            .filter(row => !appliedRuleIds.has(row.id));
        this.state.ruleReview.semanticActions = (this.state.ruleReview.semanticActions || [])
            .filter(action => !appliedActionIds.has(action.id));
        this.state.ruleReview.excludedApplyItemKeys = (this.state.ruleReview.excludedApplyItemKeys || [])
            .filter(key => !appliedApplyItemKeys.has(key));
        this.state.ruleReview.requirementItems = (this.state.ruleReview.requirementItems || [])
            .filter(item => !appliedRequirementIds.has(item.id) && item.status !== 'handled');
        const reviewState = normalizeRequirementReviewState(this.state.constraintDialog || {}, buildUnifiedRequirementItems(this.state.ruleReview || {}));
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            loading: false,
            parsing: false,
            applying: false,
            phase: '',
            phaseText: '',
        };
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            requirementFilter: reviewState.filter,
            selectedRequirementId: reviewState.selectedId,
        };

        // 关闭弹窗
        if (!this.state.ruleReview.draftRows.length && !this.state.ruleReview.requirementItems.length) {
            this.closeConstraintDialog();
        } else {
            this.render();
        }

        // 重新渲染主界面
        this.render();

        alert(semanticActions.length
            ? `成功应用 ${applyCount} 条需求`
            : `成功应用 ${actionableDraftRows.length} 条约束`);
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
