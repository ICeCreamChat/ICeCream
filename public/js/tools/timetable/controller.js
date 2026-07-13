import {
    normalizeApiError,
    requestTimetable,
    requestTimetableAgent,
} from './api.js';
import {
    buildManualRuleDraftRows,
    exportName,
    readLockedSlotForm,
    readManualRuleBuilderForm,
    readBulkRuleForm,
    readProjectForm,
    readRulePrompt,
    readRulesForm,
    sampleRosterText,
} from './forms.js';
import {
    bindGridInteractions,
    bindRuleReviewInteractions,
    handleTimetableEscape,
    loadInspectorPosition,
} from './grid-interactions.js';
import {
    ensureOwnerSelection,
    getActivePeriods,
    getActiveWeekdays,
    getPublishedScheduleDiff,
    getSavedRuleItems,
    getSlotById,
    getSlotsAt,
    getVisibleSlots,
    removeSavedRuleById,
    getTotalPeriods,
} from './selectors.js';
import {
    cloneValue,
    createTimetablePlannerState,
} from './state.js';
import { buildConstraintReviewContext, constraintChatControllerMethods } from './controller-chat-extension.js';
import { buildRuleReviewTasks } from './rule-review-tasks.js';
import smartHelperMethods from './controller-smart-helper.js';
import * as constraintDialogMethods from './controller-constraint-dialog.js';
import * as constraintDialogAdvancedMethods from './controller-constraint-dialog-advanced.js';
import { dutyTeacherSearchQuery } from './duty-teacher-search.js';
import {
    formatPeriodTimeSegmentMeta,
    renderNonTeachingSegmentPreview,
    renderPeriodTimeTableBody,
    renderWorkbench,
    resolveInspectorIssueLocateTarget,
} from './view.js';
import { PRESET_TEMPLATES } from './preset-templates.js';

function valueList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function createSmartWorkbenchState(overrides = {}) {
    return {
        open: false,
        stage: 'idle',
        sourceMode: 'text',
        selectedSection: 'ready',
        currentPage: 1,
        pageSize: 20,
        busy: false,
        error: '',
        ...overrides,
    };
}

function buildSmartDataAudit(project = {}) {
    const invalidPlans = (project.lessonPlans || []).filter(plan => (
        !plan.classId || !plan.subjectId || !plan.teacherId || Number(plan.weeklyHours || 0) <= 0
    ));
    return {
        canContinue: invalidPlans.length === 0,
        stats: {
            invalidReferenceCount: invalidPlans.filter(plan => !plan.classId || !plan.subjectId).length,
            missingTeacherCount: invalidPlans.filter(plan => !plan.teacherId).length,
            invalidHourCount: invalidPlans.filter(plan => Number(plan.weeklyHours || 0) <= 0).length,
        },
    };
}

function buildClientSolveScaleHint(project = {}) {
    const classCount = (project.classes || []).length;
    if (classCount < 30) return null;
    const lessonCount = (project.lessonPlans || [])
        .reduce((sum, plan) => sum + (Number.parseInt(plan.weeklyHours, 10) || 0), 0);
    return {
        largeProject: true,
        classCount,
        lessonCount,
        timeoutSeconds: 300,
        estimatedSeconds: 300,
        message: `${classCount} 个班，预计需要数分钟；当前 Timefold 超时上限 300 秒。`,
    };
}

function hasExplicitTeacherConsecutiveLimit(project = {}, item = {}) {
    const teacherId = item.teacherId
        || item.raw?.teacherId
        || (item.targetKind === 'teacher' ? item.targetId : '')
        || '';
    const limit = project.rules?.softRules?.teacherLimits?.[teacherId]?.consecutive;
    return Boolean(teacherId)
        && limit !== undefined
        && limit !== null
        && limit !== ''
        && Number.isInteger(Number(limit));
}

function isActionableTimetableSuggestion(item = {}, project = {}) {
    if (item.type === 'teacher_consecutive') {
        return hasExplicitTeacherConsecutiveLimit(project, item);
    }
    return item.type !== 'class_load'
        && item.type !== 'subject_spread'
        && item.type !== 'morning_subject_late';
}

function deriveSmartWorkbenchStage(state = {}) {
    if (state.ruleReview?.loading) return 'parsing_constraints';
    if ((state.ruleReview?.draftRows || []).length) return 'reviewing_constraints';
    return buildSmartDataAudit(state.project || {}).canContinue ? 'ready_for_constraints' : 'data_need_fix';
}

function transitionSmartWorkbench(current = {}, stage = 'idle', patch = {}) {
    return {
        ...createSmartWorkbenchState(current),
        previousStage: current.stage || 'idle',
        stage,
        ...patch,
    };
}

function recoverSmartWorkbench(current = {}) {
    return transitionSmartWorkbench(current, current.recoveryStage || 'ready_for_constraints', { error: '' });
}

function isEarlyStudySegmentLabel(label = '') {
    return /早自习|早读|早修|晨读/.test(String(label || ''));
}

function isEveningStudySegmentLabel(label = '') {
    return /晚自习|晚修/.test(String(label || ''));
}

function defaultSegmentKindForLabel(label = '') {
    return isEarlyStudySegmentLabel(label) || isEveningStudySegmentLabel(label)
        ? 'duty'
        : 'teaching';
}

function positiveLocateInteger(value) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function finiteLocateNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeInspectorLocatePayload(payload = {}) {
    const day = positiveLocateInteger(payload.day ?? payload.inspectorDay);
    const period = positiveLocateInteger(payload.period ?? payload.inspectorPeriod);
    return {
        targetKind: String(payload.targetKind || payload.inspectorTargetKind || '').trim(),
        targetId: String(payload.targetId || payload.inspectorTargetId || '').trim(),
        targetName: String(payload.targetName || payload.inspectorTargetName || '').trim(),
        planId: String(payload.planId || payload.inspectorPlanId || '').trim(),
        slot: String(payload.slot || payload.inspectorSlot || (day && period ? `${day}-${period}` : '')).trim(),
        day,
        period,
        inspectorIssueKey: String(payload.inspectorIssueKey || '').trim(),
        inspectorAnchorScrollTop: finiteLocateNumber(payload.inspectorAnchorScrollTop),
        inspectorAnchorOffsetTop: finiteLocateNumber(payload.inspectorAnchorOffsetTop),
    };
}

function selectorAttributeValue(value = '') {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findInspectorLocateSlot(project = {}, target = {}) {
    if (target.slotId) {
        const slot = getSlotById(project, target.slotId);
        if (slot) return slot;
    }
    const visibleSlots = getVisibleSlots(project, target.viewMode, target.ownerId);
    if (target.planId) {
        const planSlot = visibleSlots.find(slot => slot.lessonPlanId === target.planId);
        if (planSlot) return planSlot;
    }
    if (target.day && target.period) {
        return getSlotsAt(project, target.viewMode, target.ownerId, target.day, target.period)[0] || null;
    }
    return null;
}

function buildRuleChangePreview({ currentItems = [], nextItems = [], draftRows = [] } = {}) {
    const currentIds = new Set(currentItems.map(item => item.id));
    const nextIds = new Set(nextItems.map(item => item.id));
    return {
        added: nextItems.filter(item => !currentIds.has(item.id)),
        updated: nextItems.filter(item => currentIds.has(item.id)),
        removed: currentItems.filter(item => !nextIds.has(item.id)),
        ignored: draftRows.filter(row => row.status === 'unsupported' || row.status === 'ignored'),
    };
}

export class TimetablePlannerController {
    constructor() {
        this.state = createTimetablePlannerState();
        this.jobPollTimer = null;
        this.rosterImportFile = null;
        this.ruleReviewFile = null;
        this.constraintDialogFile = null;
        this.inspectorLocatePulseTimer = null;
        this.constraintFulfillmentRequestSeq = 0;
        this.rosterDraftCounter = 0;
        this.ruleDraftCounter = 0;
        this.rangePopoverViewportHandler = () => this.repositionRangePopover();
        this.rangePopoverViewportWindow = null;
    }

    async init(container) {
        this.state.container = container;
        this.state.inspectorPosition = loadInspectorPosition();
        this.timetableToolHost = container?.closest?.('.tool-container') || null;
        this.timetableToolHost?.classList?.add('tool-container--timetable');
        await this.load();
    }

    destroy() {
        if (this.inspectorLocatePulseTimer) {
            clearTimeout(this.inspectorLocatePulseTimer);
            this.inspectorLocatePulseTimer = null;
        }
        this.clearOptimizationPolling();
        this.cleanupRangePopoverViewportListeners();
        this.timetableToolHost?.classList?.remove('tool-container--timetable');
        this.timetableToolHost = null;
        this.state.container = null;
    }

    handleEscape(event) {
        return handleTimetableEscape(event, this.state.container, this, this.state);
    }

    render() {
        const { container } = this.state;
        if (!container) return;
        if (this.state.project) {
            this.state.selectedOwnerId = ensureOwnerSelection(this.state);
        }
        const periodTimeFocus = this.capturePeriodTimeFocus(container);
        const rosterImportDialog = container.querySelector?.('#tt-roster-import-dialog');
        const rosterImportDialogScroll = rosterImportDialog
            ? { left: rosterImportDialog.scrollLeft, top: rosterImportDialog.scrollTop }
            : null;
        const rosterReviewWrap = container.querySelector?.('.tt-roster-review-wrap');
        const rosterReviewScroll = rosterReviewWrap
            ? { left: rosterReviewWrap.scrollLeft, top: rosterReviewWrap.scrollTop }
            : null;
        container.innerHTML = renderWorkbench(this.state);
        bindGridInteractions(container, this, this.state);
        this.syncRangePopoverViewportListeners();
        const nextRosterImportDialog = container.querySelector?.('#tt-roster-import-dialog');
        if (nextRosterImportDialog && rosterImportDialogScroll) {
            nextRosterImportDialog.scrollLeft = rosterImportDialogScroll.left;
            nextRosterImportDialog.scrollTop = rosterImportDialogScroll.top;
        }
        const nextRosterReviewWrap = container.querySelector?.('.tt-roster-review-wrap');
        if (nextRosterReviewWrap && rosterReviewScroll) {
            nextRosterReviewWrap.scrollLeft = rosterReviewScroll.left;
            nextRosterReviewWrap.scrollTop = rosterReviewScroll.top;
        }
        this.restorePeriodTimeFocus(container, periodTimeFocus);
        window.lucide?.createIcons();
    }

    flushSmartWorkbenchRender(scopes = []) {
        this.render();
    }

    requestSmartRender(scope = 'smart-stage') {
        this.render();
    }

    renderSmartWorkbenchSurface() {
        this.render();
    }

    renderRuleReviewSurface() {
        this.state.constraintDialog = {
            ...(this.state.constraintDialog || {}),
            open: true,
        };
        this.state.smartWorkbench = { ...(this.state.smartWorkbench || {}), open: false };
        this.render();
    }

    scrollSmartWorkbenchToTop() {
        if (typeof requestAnimationFrame !== 'function' || !this.state.container) return;
        requestAnimationFrame(() => {
            const root = this.state.container?.querySelector?.('[data-constraint-dialog-overlay]');
            root?.scrollIntoView?.({ block: 'start', inline: 'nearest' });
        });
    }

    capturePeriodTimeFocus(container) {
        if (typeof document === 'undefined' || !this.state.periodTimeDialog?.open) return null;
        const active = document.activeElement;
        if (!active || !container.contains(active) || !active.closest?.('#tt-period-time-dialog')) return null;
        let selector = '';
        if (active.id) {
            selector = `#${active.id}`;
        } else if (active.dataset?.periodTimeDraftStart) {
            selector = `[data-period-time-draft-start="${active.dataset.periodTimeDraftStart}"]`;
        } else if (active.dataset?.periodTimeDraftEnd) {
            selector = `[data-period-time-draft-end="${active.dataset.periodTimeDraftEnd}"]`;
        } else if (active.dataset?.periodTimeGapAfter) {
            selector = `[data-period-time-gap-after="${active.dataset.periodTimeGapAfter}"]`;
        } else if (active.dataset?.periodTimeBlockStart) {
            selector = `[data-period-time-block-start="${active.dataset.periodTimeBlockStart}"]`;
        } else if (active.dataset?.periodTimeBlockEnd) {
            selector = `[data-period-time-block-end="${active.dataset.periodTimeBlockEnd}"]`;
        } else if (active.dataset?.periodTimeBlockGapAfter) {
            selector = `[data-period-time-block-gap-after="${active.dataset.periodTimeBlockGapAfter}"]`;
        }
        if (!selector) return null;
        return {
            selector,
            start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
            end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
        };
    }

    restorePeriodTimeFocus(container, focusInfo) {
        if (!focusInfo?.selector) return;
        const target = container.querySelector(focusInfo.selector);
        if (!target || typeof target.focus !== 'function') return;
        target.focus({ preventScroll: true });
        if (focusInfo.start !== null && typeof target.setSelectionRange === 'function') {
            try {
                target.setSelectionRange(focusInfo.start, focusInfo.end ?? focusInfo.start);
            } catch {
                // Some input types, notably time, do not support selection ranges.
            }
        }
    }

    captureInspectorScrollAnchor(issueKey = '') {
        const body = this.state.container?.querySelector?.('.tt-inspector-body');
        if (!body) return null;
        const scrollTop = finiteLocateNumber(body.scrollTop) ?? 0;
        const anchor = {
            issueKey: String(issueKey || this.state.inspectorLocatedIssueKey || '').trim(),
            scrollTop,
            offsetTop: null,
        };
        if (!anchor.issueKey || typeof body.querySelector !== 'function') return anchor;
        const issue = body.querySelector(`[data-inspector-issue-key="${selectorAttributeValue(anchor.issueKey)}"]`);
        if (!issue || typeof issue.getBoundingClientRect !== 'function' || typeof body.getBoundingClientRect !== 'function') {
            return anchor;
        }
        const issueRect = issue.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const offsetTop = finiteLocateNumber(Number(issueRect.top) - Number(bodyRect.top));
        if (offsetTop !== null) anchor.offsetTop = offsetTop;
        return anchor;
    }

    restoreInspectorScrollAnchor(anchor = null) {
        if (!anchor) return;
        const body = this.state.container?.querySelector?.('.tt-inspector-body');
        if (!body) return;
        const offsetTop = finiteLocateNumber(anchor.offsetTop);
        if (anchor.issueKey && offsetTop !== null && typeof body.querySelector === 'function') {
            const issue = body.querySelector(`[data-inspector-issue-key="${selectorAttributeValue(anchor.issueKey)}"]`);
            if (issue && typeof issue.getBoundingClientRect === 'function' && typeof body.getBoundingClientRect === 'function') {
                const issueRect = issue.getBoundingClientRect();
                const bodyRect = body.getBoundingClientRect();
                const currentOffset = finiteLocateNumber(Number(issueRect.top) - Number(bodyRect.top));
                if (currentOffset !== null) {
                    const currentScrollTop = finiteLocateNumber(body.scrollTop) ?? 0;
                    body.scrollTop = Math.max(0, currentScrollTop + currentOffset - offsetTop);
                    return;
                }
            }
        }
        const scrollTop = finiteLocateNumber(anchor.scrollTop);
        if (scrollTop !== null) body.scrollTop = Math.max(0, scrollTop);
    }

    setMessage(message, failure = null) {
        this.state.message = message || '';
        this.state.lastFailure = failure;
        if (this.state.smartWorkbench?.open) {
            this.renderSmartWorkbenchSurface();
        } else if (this.state.ruleReview?.open) {
            this.renderRuleReviewSurface();
        } else {
            this.render();
        }
    }

    locateInspectorIssue(rawPayload = {}) {
        const payload = normalizeInspectorLocatePayload(rawPayload);
        const inspectorAnchor = {
            issueKey: payload.inspectorIssueKey,
            scrollTop: payload.inspectorAnchorScrollTop,
            offsetTop: payload.inspectorAnchorOffsetTop,
        };
        const project = this.state.project || {};
        const target = resolveInspectorIssueLocateTarget(project, {
            targetKind: payload.targetKind,
            targetId: payload.targetId || payload.planId,
            targetName: payload.targetName,
            slot: payload.slot || {
                day: payload.day,
                period: payload.period,
            },
        });
        if (!target) {
            this.state.message = '暂时无法定位该项';
            this.state.inspectorLocatePulse = null;
            this.state.inspectorLocatedIssueKey = '';
            this.render();
            return false;
        }

        this.state.viewMode = target.viewMode;
        this.state.selectedOwnerId = target.ownerId || ensureOwnerSelection(this.state);
        const slot = findInspectorLocateSlot(project, {
            ...target,
            planId: target.planId || payload.planId,
        });
        this.state.selectedSlotId = slot?.id || '';
        const day = positiveLocateInteger(slot?.day ?? target.day);
        const period = positiveLocateInteger(slot?.period ?? target.period);
        const pulse = {
            kind: slot?.id ? 'slot' : day && period ? 'cell' : 'owner',
            slotId: slot?.id || '',
            day,
            period,
            ownerId: target.ownerId || '',
            viewMode: target.viewMode || this.state.viewMode,
            sourceIssueKey: payload.inspectorIssueKey,
            token: Date.now(),
        };
        this.state.inspectorLocatePulse = pulse;
        this.state.inspectorLocatedIssueKey = payload.inspectorIssueKey || '';
        this.state.message = `已定位到 ${target.label || target.targetName || '对应位置'}`;
        this.render();
        this.restoreInspectorScrollAnchor(inspectorAnchor);
        this.scrollToInspectorLocateTarget(pulse);
        this.scheduleInspectorLocatePulseClear(pulse);
        return true;
    }

    scrollToInspectorLocateTarget(pulse = {}) {
        const { container } = this.state;
        if (!container) return;
        const run = () => {
            const slotSelector = pulse.slotId
                ? `.tt-slot[data-slot-id="${selectorAttributeValue(pulse.slotId)}"]`
                : '';
            const cellSelector = pulse.day && pulse.period
                ? `.tt-cell[data-day="${selectorAttributeValue(pulse.day)}"][data-period="${selectorAttributeValue(pulse.period)}"]`
                : '';
            const target = (slotSelector ? container.querySelector?.(slotSelector) : null)
                || (cellSelector ? container.querySelector?.(cellSelector) : null)
                || container.querySelector?.('.tt-schedule-scroll');
            target?.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'smooth' });
            if (target?.classList?.contains?.('tt-slot') && typeof target.focus === 'function') {
                target.focus({ preventScroll: true });
            }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else if (typeof setTimeout === 'function') setTimeout(run, 0);
        else run();
    }

    scheduleInspectorLocatePulseClear(pulse = {}) {
        if (!this.state.container || typeof setTimeout !== 'function') return;
        if (this.inspectorLocatePulseTimer) clearTimeout(this.inspectorLocatePulseTimer);
        this.inspectorLocatePulseTimer = setTimeout(() => {
            if (this.state.inspectorLocatePulse?.token !== pulse.token) return;
            const inspectorAnchor = this.captureInspectorScrollAnchor(pulse.sourceIssueKey || this.state.inspectorLocatedIssueKey);
            this.state.inspectorLocatePulse = null;
            if (!pulse.sourceIssueKey || this.state.inspectorLocatedIssueKey === pulse.sourceIssueKey) {
                this.state.inspectorLocatedIssueKey = '';
            }
            this.inspectorLocatePulseTimer = null;
            this.render();
            this.restoreInspectorScrollAnchor(inspectorAnchor);
        }, 1600);
    }

    applyAgentResponse(response = {}, userMessage = '') {
        const agent = this.state.agent || {};
        const messages = [...(agent.messages || [])];
        if (userMessage) {
            messages.push({ role: 'user', content: userMessage });
        }
        if (response.reply) {
            messages.push({ role: 'assistant', content: response.reply });
        }
        if (response.project) {
            this.applyProject(response.project);
        }
        this.state.agent = {
            ...agent,
            sessionId: response.sessionId || agent.sessionId || null,
            stage: response.stage || agent.stage || 'idle',
            plan: response.plan || agent.plan || [],
            questions: response.questions || [],
            approvalQueue: response.approvalQueue || [],
            artifacts: response.artifacts || agent.artifacts || [],
            currentArtifactId: response.artifacts?.at?.(-1)?.id || agent.currentArtifactId || null,
            nextAction: response.nextAction || '',
            messages,
            loading: false,
            error: null,
        };
        this.state.message = response.reply || this.state.message;
        if (this.state.smartWorkbench?.open) {
            this.renderSmartWorkbenchSurface();
        } else {
            this.render();
        }
    }

    async startTimetableAgentSession() {
        this.state.agent = {
            ...(this.state.agent || {}),
            loading: true,
            error: null,
        };
        this.render();
        try {
            const result = await requestTimetableAgent('/session', {
                method: 'POST',
                body: JSON.stringify({
                    project: this.state.project,
                    mode: this.state.agent?.mode || 'assistant',
                }),
            });
            this.state.agent = {
                ...(this.state.agent || {}),
                ...(result.state || {}),
                sessionId: result.sessionId || result.state?.sessionId || null,
                loading: false,
                error: null,
                messages: [{ role: 'assistant', content: '智能主导排课已准备好，可以检查数据、解析约束或生成求解计划。' }],
            };
            this.setMessage('智能主导排课已启动。');
        } catch (error) {
            this.state.agent = {
                ...(this.state.agent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async sendTimetableAgentMessage(message = '') {
        const input = message || this.state.container?.querySelector('#tt-agent-message')?.value || '';
        const content = String(input || '').trim();
        if (!content) {
            this.setMessage('请先输入要交给智能排课助手处理的任务。');
            return;
        }
        this.state.agent = {
            ...(this.state.agent || {}),
            loading: true,
            error: null,
            input: content,
        };
        this.render();
        try {
            let sessionId = this.state.agent?.sessionId || null;
            if (!sessionId) {
                const session = await requestTimetableAgent('/session', {
                    method: 'POST',
                    body: JSON.stringify({ project: this.state.project, mode: 'assistant' }),
                });
                sessionId = session.sessionId;
            }
            const response = await requestTimetableAgent('/message', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId,
                    message: content,
                    project: this.state.project,
                }),
            });
            this.applyAgentResponse(response, content);
        } catch (error) {
            this.state.agent = {
                ...(this.state.agent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async runTimetableAgent() {
        if (!this.state.agent?.sessionId) {
            await this.startTimetableAgentSession();
            return;
        }
        this.state.agent = { ...(this.state.agent || {}), loading: true, error: null };
        this.render();
        try {
            const response = await requestTimetableAgent('/run', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: this.state.agent.sessionId,
                    project: this.state.project,
                }),
            });
            this.applyAgentResponse(response);
        } catch (error) {
            this.state.agent = {
                ...(this.state.agent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    readTimetableAgentAnswers() {
        return [...(this.state.container?.querySelectorAll('[data-agent-question]') || [])].map(node => {
            const selected = node.querySelector('[data-agent-answer]:checked')
                || node.querySelector('select[data-agent-answer]')
                || node.querySelector('input[data-agent-answer], textarea[data-agent-answer]');
            return {
                questionId: node.dataset.agentQuestion,
                value: selected?.value || '',
                label: selected?.selectedOptions?.[0]?.textContent?.trim() || selected?.dataset.label || selected?.value || '',
            };
        }).filter(answer => answer.questionId && answer.value);
    }

    async answerTimetableAgentQuestions() {
        const answers = this.readTimetableAgentAnswers();
        if (!answers.length) {
            this.setMessage('请先填写智能排课助手提出的问题。');
            return;
        }
        this.state.agent = { ...(this.state.agent || {}), loading: true, error: null };
        this.render();
        try {
            const response = await requestTimetableAgent('/answer', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: this.state.agent.sessionId,
                    answers,
                    project: this.state.project,
                }),
            });
            this.applyAgentResponse(response);
        } catch (error) {
            this.state.agent = {
                ...(this.state.agent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async approveTimetableAgentAction(actionId, approved = true) {
        if (!actionId || !this.state.agent?.sessionId) return;
        this.state.agent = { ...(this.state.agent || {}), loading: true, error: null };
        this.render();
        try {
            const response = await requestTimetableAgent('/approve', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: this.state.agent.sessionId,
                    actionId,
                    approved,
                    project: this.state.project,
                }),
            });
            this.applyAgentResponse(response);
        } catch (error) {
            this.state.agent = {
                ...(this.state.agent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async resetTimetableAgentSession() {
        this.state.agent = { ...(this.state.agent || {}), loading: true, error: null };
        this.render();
        try {
            const result = await requestTimetableAgent('/reset', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: this.state.agent?.sessionId || null,
                    project: this.state.project,
                    mode: 'assistant',
                }),
            });
            this.state.agent = {
                ...(result.state || {}),
                sessionId: result.sessionId || result.state?.sessionId || null,
                loading: false,
                error: null,
                messages: [{ role: 'assistant', content: '智能主导排课会话已重置。' }],
            };
            this.setMessage('智能主导排课已重置。');
        } catch (error) {
            this.state.agent = {
                ...(this.state.agent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    syncConstraintAgentReview(response = {}) {
        const review = response.review || response.state?.review || null;
        if (!review) return;
        const current = this.state.ruleReview || {};
        const hasSourceRequirements = Object.prototype.hasOwnProperty.call(review, 'sourceRequirements');
        const sourceRequirements = hasSourceRequirements ? valueList(review.sourceRequirements) : undefined;
        const hasReviewItems = [
            review.sourceRequirements,
            review.systemSupplements,
            review.constraintIRs,
            review.draftRows,
            review.requirementItems,
            review.semanticActions,
        ].some(items => valueList(items).length > 0);
        this.state.ruleReview = {
            ...current,
            open: Boolean(current.open),
            step: 'review',
            uiStep: hasReviewItems ? 'issues' : current.uiStep || 'input',
            mode: current.mode || 'text',
            inputMode: current.inputMode || 'text',
            text: current.text || response.originalText || '',
            schemaVersion: review.schemaVersion || '',
            ...(sourceRequirements === undefined ? {} : { sourceRequirements }),
            systemSupplements: valueList(review.systemSupplements),
            manualRequirements: valueList(review.manualRequirements),
            constraintIRs: valueList(review.constraintIRs),
            warningItems: valueList(review.warningItems),
            statistics: review.statistics || null,
            draftRules: review.draftRules || current.draftRules || null,
            draftRows: valueList(review.draftRows),
            previewItems: valueList(review.previewItems),
            requirementItems: valueList(review.requirementItems),
            semanticActions: valueList(review.semanticActions),
            autoAcceptable: valueList(review.autoAcceptable),
            needReview: valueList(review.needReview),
            clarifyingQuestions: valueList(review.clarifyingQuestions),
            missingInfo: valueList(review.missingInfo),
            conflicts: valueList(review.conflicts),
            warnings: valueList(review.warnings),
            unsupportedItems: valueList(review.unsupportedItems),
            ruleReport: review.ruleReport || null,
            confidenceSummary: review.confidenceSummary || { high: 0, medium: 0, low: 0 },
            nextAction: review.nextAction || '',
            inputType: review.inputType || current.inputType || 'constraint_intake',
            contextStats: review.contextStats || current.contextStats || null,
            excludedApplyItemKeys: valueList(response.excludedApplyItemKeys ?? current.excludedApplyItemKeys),
        };
        if (!hasSourceRequirements) delete this.state.ruleReview.sourceRequirements;
    }

    applyConstraintAgentResponse(response = {}, userMessage = '') {
        const current = this.state.constraintAgent || {};
        const messages = [...(current.messages || [])];
        if (userMessage) messages.push({ role: 'user', content: userMessage });
        if (response.reply) messages.push({ role: 'assistant', content: response.reply });
        if (response.project) {
            this.applyProject(response.project);
        }
        this.syncConstraintAgentReview(response);
        this.state.constraintAgent = {
            ...current,
            sessionId: response.sessionId || current.sessionId || null,
            stage: response.stage || current.stage || 'INTAKE',
            messages,
            statusLine: response.statusLine || current.statusLine || '[已理解 0 · 待澄清 0 · 待确认 0]',
            review: response.review || current.review || null,
            questions: response.questions || [],
            confirmationToken: response.confirmationToken || current.confirmationToken || '',
            highRiskToken: response.highRiskToken || current.highRiskToken || '',
            highRiskAction: response.highRiskAction || current.highRiskAction || null,
            confirmed: Boolean(response.confirmed),
            highRiskConfirmed: Boolean(response.highRiskConfirmed),
            appliedSummary: response.appliedSummary || current.appliedSummary || null,
            solveResult: response.solveResult || current.solveResult || null,
            fulfillment: response.fulfillment || current.fulfillment || null,
            nextAction: response.nextAction || '',
            input: '',
            loading: false,
            error: '',
        };
        if (response.fulfillment) {
            this.state.constraintFulfillment = response.fulfillment;
            this.state.constraintFulfillmentFilter = 'attention';
        }
        this.state.message = response.reply || this.state.message;
        this.render();
    }

    async startConstraintIntakeAgentSession() {
        this.state.constraintAgent = {
            ...(this.state.constraintAgent || {}),
            loading: true,
            error: '',
        };
        this.render();
        try {
            const result = await requestTimetableAgent('/constraint-intake/session', {
                method: 'POST',
                body: JSON.stringify({ project: this.state.project, mode: 'constraint_intake' }),
            });
            this.state.constraintAgent = {
                ...(this.state.constraintAgent || {}),
                ...(result.state || {}),
                sessionId: result.sessionId || result.state?.sessionId || null,
                messages: [{ role: 'assistant', content: '对话排课已准备好。' }],
                loading: false,
                error: '',
            };
            this.setMessage('对话排课已启动。');
        } catch (error) {
            this.state.constraintAgent = {
                ...(this.state.constraintAgent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    constraintAgentClarificationAnswers(content = '') {
        const questions = this.state.constraintAgent?.questions || [];
        return questions.map(question => ({
            questionId: question.id || question.questionId || question.field || 'answer',
            requirementId: question.requirementId || question.source?.requirementId || '',
            field: question.field || question.param || 'value',
            value: content,
            label: content,
        }));
    }

    async sendConstraintIntakeAgentMessage(message = '') {
        const input = message || this.state.container?.querySelector('#tt-constraint-agent-message')?.value || '';
        const content = String(input || '').trim();
        if (!content) {
            this.setMessage('请先输入排课要求。');
            return;
        }
        this.state.constraintAgent = {
            ...(this.state.constraintAgent || {}),
            loading: true,
            error: '',
            input: content,
        };
        this.render();
        try {
            let sessionId = this.state.constraintAgent?.sessionId || null;
            if (!sessionId) {
                const session = await requestTimetableAgent('/constraint-intake/session', {
                    method: 'POST',
                    body: JSON.stringify({ project: this.state.project, mode: 'constraint_intake' }),
                });
                sessionId = session.sessionId;
            }
            const isClarifying = this.state.constraintAgent?.stage === 'CLARIFY'
                && (this.state.constraintAgent?.questions || []).length > 0;
            const response = await requestTimetableAgent(isClarifying ? '/constraint-intake/answer' : '/constraint-intake/message', {
                method: 'POST',
                body: JSON.stringify(isClarifying
                    ? {
                        sessionId,
                        answers: this.constraintAgentClarificationAnswers(content),
                        project: this.state.project,
                    }
                    : {
                        sessionId,
                        message: content,
                        project: this.state.project,
                    }),
            });
            this.applyConstraintAgentResponse(response, content);
        } catch (error) {
            this.state.constraintAgent = {
                ...(this.state.constraintAgent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async confirmConstraintIntakeAgent() {
        const agent = this.state.constraintAgent || {};
        if (!agent.sessionId) return;
        this.state.constraintAgent = { ...agent, loading: true, error: '' };
        this.render();
        try {
            const response = await requestTimetableAgent('/constraint-intake/confirm', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: agent.sessionId,
                    confirmationToken: agent.confirmationToken || '',
                    highRiskToken: agent.highRiskToken || '',
                    excludedApplyItemKeys: this.state.ruleReview?.excludedApplyItemKeys || [],
                }),
            });
            this.applyConstraintAgentResponse(response);
        } catch (error) {
            this.state.constraintAgent = {
                ...(this.state.constraintAgent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async applyConstraintIntakeAgent() {
        const agent = this.state.constraintAgent || {};
        if (!agent.sessionId) return;
        this.state.constraintAgent = { ...agent, loading: true, error: '' };
        this.render();
        try {
            const response = await requestTimetableAgent('/constraint-intake/apply', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: agent.sessionId,
                    confirmationToken: agent.confirmationToken || '',
                    highRiskToken: agent.highRiskToken || '',
                    excludedApplyItemKeys: this.state.ruleReview?.excludedApplyItemKeys || [],
                    project: this.state.project,
                }),
            });
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.applyConstraintAgentResponse(response);
        } catch (error) {
            this.state.constraintAgent = {
                ...(this.state.constraintAgent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    async solveConstraintIntakeAgent() {
        const agent = this.state.constraintAgent || {};
        if (!agent.sessionId) return;
        this.state.constraintAgent = { ...agent, loading: true, error: '' };
        this.render();
        try {
            const response = await requestTimetableAgent('/constraint-intake/solve', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId: agent.sessionId,
                    project: this.state.project,
                }),
            });
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.applyConstraintAgentResponse(response);
        } catch (error) {
            this.state.constraintAgent = {
                ...(this.state.constraintAgent || {}),
                loading: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    applyProject(project) {
        this.state.project = project;
        this.state.selectedOwnerId = ensureOwnerSelection(this.state);
        const visibleSlotIds = new Set(
            getVisibleSlots(project, this.state.viewMode, this.state.selectedOwnerId)
                .map(item => item.id)
                .filter(Boolean),
        );
        if (this.state.selectedSlotId && !visibleSlotIds.has(this.state.selectedSlotId)) {
            this.state.selectedSlotId = '';
        }
        if (this.state.dragSlotId && !visibleSlotIds.has(this.state.dragSlotId)) {
            this.state.dragSlotId = '';
            this.state.dragBlockId = '';
        }
        this.syncPublicationDialogState();
        this.syncPublishDialogState();
        this.syncRangeDraftFromProject();
        if (
            this.state.smartWorkbench?.open
            && ['solving', 'solution_review', 'finished'].includes(this.state.smartWorkbench.stage)
            && (project?.schedule?.slots || []).length
        ) {
            const candidate = this.smartCandidateFromProject();
            if (candidate) this.mergeSmartWorkbenchCandidate(candidate);
        }
        this.refreshConstraintFulfillmentAfterProjectChange(project);
    }

    shouldRefreshConstraintFulfillment() {
        return Boolean(
            this.state.container
            && typeof window !== 'undefined'
            && typeof fetch === 'function'
        );
    }

    refreshConstraintFulfillmentAfterProjectChange(project) {
        if (!this.shouldRefreshConstraintFulfillment()) return;
        this.refreshConstraintFulfillment(project).catch(() => {});
    }

    async refreshConstraintFulfillment(project = this.state.project) {
        const requestSeq = ++this.constraintFulfillmentRequestSeq;
        if (!project) {
            this.state.constraintFulfillment = null;
            this.state.constraintFulfillmentLoading = false;
            this.state.constraintFulfillmentError = '';
            return null;
        }
        this.state.constraintFulfillmentLoading = true;
        this.state.constraintFulfillmentError = '';
        try {
            const result = await requestTimetable('/rules/fulfillment', {
                method: 'POST',
                body: JSON.stringify({ project }),
            });
            if (requestSeq !== this.constraintFulfillmentRequestSeq) return null;
            this.state.constraintFulfillment = result.fulfillment || null;
            this.state.constraintFulfillmentLoading = false;
            this.state.constraintFulfillmentError = '';
            this.render();
            return this.state.constraintFulfillment;
        } catch (error) {
            if (requestSeq !== this.constraintFulfillmentRequestSeq) return null;
            const normalized = normalizeApiError(error);
            this.state.constraintFulfillmentLoading = false;
            this.state.constraintFulfillmentError = normalized.message || '约束达成度暂时无法评估。';
            this.render();
            return null;
        }
    }

    async handleConstraintFulfillmentSuggestion(ruleId = '', kind = '') {
        const fulfillment = this.state.constraintFulfillment || {};
        const item = (fulfillment.items || []).find(entry => (entry.ruleId || entry.id) === ruleId);
        if (!item) {
            this.setMessage('没有找到要处理的约束。');
            return;
        }
        if (kind !== 'delete_rule') {
            this.setMessage('这个建议需要人工处理，系统不会自动修改规则。');
            return;
        }
        const strengthLabel = (item.strength || item.priority) === 'hard' ? '硬约束' : '软约束';
        const message = [
            `确定删除这条${strengthLabel}吗？`,
            item.title || item.typeLabel || item.type || '排课约束',
            '删除后会保存到项目规则，并建议重新排课查看满足度。',
        ].join('\n');
        if (!confirm(message)) return;

        this.state.constraintFulfillmentLoading = true;
        this.render();
        try {
            const result = await requestTimetable('/rules/fulfillment/action', {
                method: 'POST',
                body: JSON.stringify({
                    project: this.state.project,
                    action: { ruleId, kind },
                }),
            });
            if (result.project) this.applyProject(result.project);
            this.state.constraintFulfillment = result.fulfillment || null;
            this.state.constraintFulfillmentFilter = 'attention';
            this.state.constraintFulfillmentOpen = true;
            this.setMessage('已删除该约束。请重新排课查看新的满足度报告。');
        } catch (error) {
            const normalized = normalizeApiError(error);
            this.setMessage(normalized.message || '约束处理失败，请稍后重试。');
        } finally {
            this.state.constraintFulfillmentLoading = false;
            this.render();
        }
    }

    resetPublishDialog() {
        this.state.publishDialog = { open: false, note: '', loading: false };
    }

    isSchedulePublicationReady(project = this.state.project) {
        const schedule = project?.schedule || null;
        if (!schedule || !(schedule.slots || []).length) return false;
        const publication = schedule.publication || null;
        if (publication && publication.ok === false) return false;
        const summary = publication?.summary || schedule.score || {};
        const hardConflicts = Number(summary.hardConflicts ?? schedule.score?.hardConflicts ?? (schedule.conflicts || []).length ?? 0);
        const unplacedLessons = Number(summary.unplacedLessons ?? schedule.score?.unplacedLessons ?? (schedule.unplaced || []).length ?? 0);
        return hardConflicts === 0 && unplacedLessons === 0;
    }

    smartScheduleDiagnosis(project = this.state.project) {
        const schedule = project?.schedule || null;
        if (!schedule || !(schedule.slots || []).length) {
            return {
                summary: '还没有生成可检查的课表。',
                suggestions: [{ label: '先返回求解计划，重新生成课表。' }],
            };
        }
        const publication = schedule.publication || null;
        const summary = publication?.summary || schedule.score || {};
        const hardConflicts = Number(summary.hardConflicts ?? schedule.score?.hardConflicts ?? (schedule.conflicts || []).length ?? 0);
        const unplacedLessons = Number(summary.unplacedLessons ?? schedule.score?.unplacedLessons ?? (schedule.unplaced || []).length ?? 0);
        const issues = [];
        if (hardConflicts > 0) issues.push(`还有 ${hardConflicts} 个硬冲突`);
        if (unplacedLessons > 0) issues.push(`还有 ${unplacedLessons} 节课未排`);
        if (publication?.ok === false) issues.push('发布前校验没有通过');
        const publicationIssues = (Array.isArray(publication?.issueEntries) && publication.issueEntries.length)
            ? publication.issueEntries
            : (Array.isArray(publication?.reviewItems) && publication.reviewItems.length)
                ? publication.reviewItems
                : [
                    ...(publication?.blockingIssues || []).map(item => ({ ...item, severity: item?.severity || 'error' })),
                    ...(publication?.warnings || []).map(item => ({ ...item, severity: item?.severity || 'warning' })),
                ];
        const rawSuggestions = [
            ...publicationIssues,
            ...(schedule.audit?.blockingIssues || []),
            ...(schedule.audit?.warnings || []),
            ...(schedule.qualityIssues || []).filter(item => item.severity === 'high').slice(0, 3),
        ].filter(item => isActionableTimetableSuggestion(item, this.state.project));
        const suggestions = rawSuggestions.map(item => ({
            label: item.label || item.message || item.type || String(item),
            message: item.message || item.label || String(item),
        }));
        if (!suggestions.length) {
            suggestions.push({ label: '返回调整规则，减少互相冲突的必须满足条件后再生成。' });
        }
        return {
            summary: issues.length
                ? `当前课表不能保存为正式课表：${issues.join('，')}。`
                : '当前课表还不能保存为正式课表，请先处理发布前校验提示。',
            suggestions,
        };
    }

    syncPublishDialogState() {
        if (!this.state.publishDialog?.open) return;
        if (!this.isSchedulePublicationReady()) {
            this.resetPublishDialog();
        }
    }

    syncPublicationDialogState() {
        const published = this.state.project?.schedule?.published || null;
        const historyVersions = new Set(
            (published?.history || [])
                .map(item => Number.parseInt(item?.version, 10))
                .filter(Number.isInteger),
        );
        const latestVersion = Number.parseInt(published?.version, 10);
        const resetHistoryDialog = () => {
            this.state.publicationHistoryDialog = { open: false, version: null };
        };
        const resetRestoreDialog = () => {
            this.state.restoreDialog = {
                open: false,
                mode: '',
                version: null,
                targetLabel: '',
                summary: null,
                loading: false,
            };
        };

        const historyDialog = this.state.publicationHistoryDialog || {};
        if (historyDialog.open) {
            const historyVersion = Number.parseInt(historyDialog.version, 10);
            if (!Number.isInteger(historyVersion) || !historyVersions.has(historyVersion)) {
                resetHistoryDialog();
            } else {
                this.state.publicationHistoryDialog = {
                    ...historyDialog,
                    version: historyVersion,
                };
            }
        }

        const restoreDialog = this.state.restoreDialog || {};
        if (!restoreDialog.open) return;
        const restoreVersion = Number.parseInt(restoreDialog.version, 10);
        const isValidHistoryRestore = restoreDialog.mode === 'history'
            && Number.isInteger(restoreVersion)
            && historyVersions.has(restoreVersion);
        const canBackfillLatestSnapshot = published?.status === 'published';
        const isValidLatestRestore = restoreDialog.mode === 'latest'
            && Number.isInteger(latestVersion)
            && (!Number.isInteger(restoreVersion) || restoreVersion === latestVersion)
            && (Boolean(published?.snapshot) || canBackfillLatestSnapshot);
        if (isValidHistoryRestore || isValidLatestRestore) {
            this.state.restoreDialog = {
                ...restoreDialog,
                version: Number.isInteger(restoreVersion) ? restoreVersion : latestVersion,
            };
            return;
        }
        resetRestoreDialog();
    }

    defaultWorkflowOpenSections() {
        if (!this.state.project) return ['data'];
        if (!(this.state.project.lessonPlans || []).length) return ['data'];
        if ((this.state.ruleDraftPreview || []).length || (this.state.ruleWarnings || []).length) return ['rules'];
        if ((this.state.project.schedule?.slots || []).length) return ['solve'];
        return ['rules'];
    }

    toggleWorkflowSection(section) {
        const current = new Set(Array.isArray(this.state.workflowOpenSections)
            ? this.state.workflowOpenSections
            : this.defaultWorkflowOpenSections());
        if (current.has(section)) {
            current.delete(section);
        } else {
            current.add(section);
        }
        this.state.workflowOpenSections = [...current];
        this.render();
    }

    rangePopoverRectFromTrigger(trigger) {
        const rect = trigger?.getBoundingClientRect?.();
        const ownerWindow = this.state.container?.ownerDocument?.defaultView || globalThis.window || {};
        const viewportWidth = Number(ownerWindow.innerWidth)
            || Number(this.state.container?.ownerDocument?.documentElement?.clientWidth)
            || 1024;
        const viewportHeight = Number(ownerWindow.innerHeight)
            || Number(this.state.container?.ownerDocument?.documentElement?.clientHeight)
            || 768;
        const rawLeft = Number(rect?.left) || 0;
        const rawTop = Number(rect?.bottom) || ((Number(rect?.top) || 0) + (Number(rect?.height) || 0));
        const popoverWidth = Math.min(260, Math.max(180, viewportWidth - 32));
        const popoverHeight = Math.min(330, Math.max(240, viewportHeight - 32));
        const left = Math.max(16, Math.min(rawLeft, viewportWidth - popoverWidth - 16));
        const top = Math.max(16, Math.min(rawTop + 6, viewportHeight - popoverHeight - 16));
        return {
            top,
            left,
            width: popoverWidth,
            height: popoverHeight,
            triggerWidth: Number(rect?.width) || popoverWidth,
        };
    }

    toggleRangePopover(id, trigger) {
        if (!['activeWeekdays', 'activePeriods'].includes(id)) return false;
        if (this.state.rangePopover?.id === id) {
            this.closeRangePopover();
            return true;
        }
        this.state.rangePopover = {
            id,
            rect: this.rangePopoverRectFromTrigger(trigger),
        };
        this.render();
        return true;
    }

    closeRangePopover({ render = true } = {}) {
        if (!this.state.rangePopover) return false;
        this.state.rangePopover = null;
        this.cleanupRangePopoverViewportListeners();
        if (render) this.render();
        return true;
    }

    repositionRangePopover() {
        const id = this.state.rangePopover?.id;
        if (!id || !this.state.container) return false;
        const trigger = this.state.container.querySelector(`[data-range-popover-trigger="${selectorAttributeValue(id)}"]`);
        if (!trigger) return this.closeRangePopover();
        this.state.rangePopover = {
            id,
            rect: this.rangePopoverRectFromTrigger(trigger),
        };
        this.render();
        return true;
    }

    syncRangePopoverViewportListeners() {
        const ownerWindow = this.state.container?.ownerDocument?.defaultView || globalThis.window;
        if (!ownerWindow || typeof ownerWindow.addEventListener !== 'function') return;
        if (!this.state.rangePopover) {
            this.cleanupRangePopoverViewportListeners();
            return;
        }
        if (this.rangePopoverViewportWindow === ownerWindow) return;
        this.cleanupRangePopoverViewportListeners();
        ownerWindow.addEventListener('resize', this.rangePopoverViewportHandler);
        ownerWindow.addEventListener('scroll', this.rangePopoverViewportHandler, true);
        this.rangePopoverViewportWindow = ownerWindow;
    }

    cleanupRangePopoverViewportListeners() {
        const ownerWindow = this.rangePopoverViewportWindow;
        if (!ownerWindow || typeof ownerWindow.removeEventListener !== 'function') {
            this.rangePopoverViewportWindow = null;
            return;
        }
        ownerWindow.removeEventListener('resize', this.rangePopoverViewportHandler);
        ownerWindow.removeEventListener('scroll', this.rangePopoverViewportHandler, true);
        this.rangePopoverViewportWindow = null;
    }

    syncRangeDraftFromProject() {
        if (!this.state.project) {
            this.state.rangeDraft = null;
            this.state.rangePopover = null;
            return;
        }
        this.state.rangeDraft = {
            activeWeekdays: getActiveWeekdays(this.state.project),
            activePeriods: getActivePeriods(this.state.project),
            periodTimes: this.state.project.periodTimes || [],
        };
    }

    updateRangeDraftFromForm() {
        if (!this.state.container) return;
        const payload = readProjectForm(this.state.container);
        const currentDraft = {
            activeWeekdays: this.state.rangeDraft?.activeWeekdays || getActiveWeekdays(this.state.project),
            activePeriods: this.state.rangeDraft?.activePeriods || getActivePeriods(this.state.project),
        };
        const hasWeekdayInputs = Boolean(this.state.container.querySelector('[data-active-weekday]'));
        const hasPeriodInputs = Boolean(this.state.container.querySelector('[data-active-period]'));
        this.state.rangeDraft = {
            ...(this.state.rangeDraft || {}),
            activeWeekdays: hasWeekdayInputs ? payload.activeWeekdays : currentDraft.activeWeekdays,
            activePeriods: hasPeriodInputs ? payload.activePeriods : currentDraft.activePeriods,
        };
    }

    rangePayloadFromDraft() {
        const activeWeekdays = [...(this.state.rangeDraft?.activeWeekdays || getActiveWeekdays(this.state.project))].sort((left, right) => left - right);
        const activePeriods = [...(this.state.rangeDraft?.activePeriods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        return {
            activeWeekdays,
            activePeriods,
            periodTimes: this.state.rangeDraft?.periodTimes || this.state.project?.periodTimes || [],
            weekdays: activeWeekdays.length ? Math.max(...activeWeekdays) : 5,
            periodsPerDay: activePeriods.length ? Math.max(...activePeriods) : 7,
        };
    }

    async applyRangeDraft() {
        this.updateRangeDraftFromForm();
        this.closeRangePopover({ render: false });
        await this.saveProject(this.rangePayloadFromDraft());
    }

    timeToMinutes(value) {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
        return hours * 60 + minutes;
    }

    minutesToTime(minutes) {
        const bounded = Math.max(0, Math.min(23 * 60 + 59, Math.round(Number(minutes) || 0)));
        return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
    }

    splitAdditionalSegmentId(id = '', index = 0) {
        return `${id || 'seg'}__p${index + 1}`;
    }

    splitAdditionalSegmentLabel(label = '', index = 0, total = 1) {
        if (total <= 1) return label || '附加时段';
        return `${label || '附加时段'}${index + 1}`;
    }

    expandPeriodTimeSegment(segment = {}, globalDefaults = {}) {
        const kind = ['teaching', 'duty', 'display'].includes(segment.kind)
            ? segment.kind
            : defaultSegmentKindForLabel(segment.label);
        const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
        if (kind === 'teaching' || periodCount <= 1) return [segment];
        const startMinutes = this.timeToMinutes(segment.startTime);
        const classMinutes = Math.max(1, Math.min(180, Number.parseInt(segment.classMinutes ?? globalDefaults.classMinutes, 10) || 45));
        const breakMinutes = Math.max(0, Math.min(120, Number.parseInt(segment.breakMinutes ?? globalDefaults.breakMinutes, 10) || 0));
        return Array.from({ length: periodCount }, (_, index) => ({
            ...segment,
            id: this.splitAdditionalSegmentId(segment.id, index),
            label: this.splitAdditionalSegmentLabel(segment.label, index, periodCount),
            startTime: startMinutes === null ? segment.startTime : this.minutesToTime(startMinutes + index * (classMinutes + breakMinutes)),
            periodCount: 1,
            classMinutes,
            breakMinutes,
            kind,
        }));
    }

    buildDutyTimeBlockMigration(rawConfig = null, normalizedConfig = null) {
        const rawSegments = Array.isArray(rawConfig?.segments) ? rawConfig.segments : [];
        const normalizedIds = new Set((normalizedConfig?.segments || []).map(segment => segment.id));
        const migration = new Map();
        const globalDefaults = normalizedConfig?.globalDefaults || rawConfig?.globalDefaults || {};
        rawSegments.forEach((segment, index) => {
            const id = String(segment.id || `seg-${index + 1}`);
            const label = String(segment.label || `时段${index + 1}`).trim().slice(0, 40) || `时段${index + 1}`;
            const kind = ['teaching', 'duty', 'display'].includes(segment.kind)
                ? segment.kind
                : defaultSegmentKindForLabel(label);
            const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
            if (kind === 'teaching' || periodCount <= 1) return;
            const targets = Array.from({ length: periodCount }, (_, itemIndex) => this.splitAdditionalSegmentId(id, itemIndex))
                .filter(targetId => normalizedIds.has(targetId));
            if (targets.length > 1) migration.set(id, targets);
        });
        return migration;
    }

    migrateDutyAssignmentsForSplitTimeBlocks(assignments = [], rawConfig = null, normalizedConfig = null) {
        const migration = this.buildDutyTimeBlockMigration(rawConfig, normalizedConfig);
        if (!migration.size || !Array.isArray(assignments) || !assignments.length) {
            return { assignments: Array.isArray(assignments) ? assignments : [], changed: false };
        }
        let changed = false;
        const migrated = assignments.flatMap(item => {
            const timeBlockId = String(item?.timeBlockId || item?.segmentId || '');
            const targets = migration.get(timeBlockId);
            if (!targets?.length) return [item];
            changed = true;
            return targets.map((targetId, index) => ({
                ...item,
                id: item?.id ? `${item.id}__p${index + 1}` : undefined,
                timeBlockId: targetId,
            }));
        });
        return { assignments: migrated, changed };
    }

    getDefaultSegmentConfig(periods = null) {
        const activePeriods = periods ? [...periods].sort((left, right) => left - right) : getActivePeriods(this.state.project);
        const halfPoint = Math.floor(activePeriods.length / 2);
        return {
            globalDefaults: {
                classMinutes: 45,
                breakMinutes: 10,
            },
            segments: [
                {
                    id: 'seg-1',
                    label: '上午时段',
                    startTime: '08:00',
                    periodCount: halfPoint || activePeriods.length || 4,
                    classMinutes: null,
                    breakMinutes: null,
                    kind: 'teaching',
                },
                ...(activePeriods.length - halfPoint > 0 ? [{
                    id: 'seg-2',
                    label: '下午时段',
                    startTime: '14:00',
                    periodCount: activePeriods.length - halfPoint,
                    classMinutes: null,
                    breakMinutes: null,
                    kind: 'teaching',
                }] : []),
            ],
        };
    }

    normalizeSegmentConfig(config = {}, periods = null) {
        const activePeriods = Array.isArray(periods)
            ? [...periods].sort((left, right) => left - right)
            : getActivePeriods(this.state.project);
        const defaults = this.getDefaultSegmentConfig(activePeriods);
        const toInteger = (value, fallback, min, max) => {
            const number = Number(value);
            if (!Number.isFinite(number)) return fallback;
            return Math.max(min, Math.min(max, Math.round(number)));
        };
        const normalizeTime = (value, fallback) => {
            const minutes = this.timeToMinutes(value);
            return minutes === null ? fallback : this.minutesToTime(minutes);
        };
        const normalizeKind = (value, id, label) => {
            return ['teaching', 'duty', 'display'].includes(value)
                ? value
                : defaultSegmentKindForLabel(label);
        };
        const globalDefaults = {
            classMinutes: toInteger(config.globalDefaults?.classMinutes, defaults.globalDefaults.classMinutes, 1, 180),
            breakMinutes: toInteger(config.globalDefaults?.breakMinutes, defaults.globalDefaults.breakMinutes, 0, 120),
        };
        const segments = (Array.isArray(config.segments) ? config.segments : [])
            .map((seg, index) => {
                const id = String(seg.id || `seg-${index + 1}`);
                const label = String(seg.label || `时段${index + 1}`).trim().slice(0, 40) || `时段${index + 1}`;
                const startTime = normalizeTime(seg.startTime, index === 0 ? '08:00' : '14:00');
                const periodCount = toInteger(seg.periodCount, 1, 1, 12);
                const classMinutes = seg.classMinutes === null || seg.classMinutes === undefined
                    ? null
                    : toInteger(seg.classMinutes, globalDefaults.classMinutes, 1, 180);
                const breakMinutes = seg.breakMinutes === null || seg.breakMinutes === undefined
                    ? null
                    : toInteger(seg.breakMinutes, globalDefaults.breakMinutes, 0, 120);
                return { id, label, startTime, periodCount, classMinutes, breakMinutes, kind: normalizeKind(seg.kind, id, label) };
            })
            .flatMap(segment => this.expandPeriodTimeSegment(segment, globalDefaults))
            .slice(0, 10);
        return { globalDefaults, segments: segments.length ? segments : defaults.segments };
    }

    deriveTeachingPeriodsFromSegmentConfig(config = {}) {
        const segments = Array.isArray(config?.segments) ? config.segments : [];
        const resolveKind = segment => {
            const label = String(segment?.label || '');
            const kind = ['teaching', 'duty', 'display'].includes(segment?.kind)
                ? segment.kind
                : defaultSegmentKindForLabel(label);
            return kind;
        };
        const count = segments
            .filter(segment => resolveKind(segment) === 'teaching')
            .reduce((sum, segment) => sum + (Math.max(0, Number.parseInt(segment.periodCount, 10) || 0)), 0);
        return Array.from({ length: Math.min(12, count) }, (_, index) => index + 1);
    }

    getFormalPeriodsForSegmentConfig(config = {}) {
        const hasSegments = Array.isArray(config?.segments) && config.segments.length > 0;
        return hasSegments
            ? this.deriveTeachingPeriodsFromSegmentConfig(config)
            : getActivePeriods(this.state.project);
    }

    getNonTeachingSegmentPreviewSignature(config = {}) {
        const defaults = config?.globalDefaults || {};
        const segments = Array.isArray(config?.segments) ? config.segments : [];
        const previewSegments = segments
            .map(segment => {
                const label = String(segment.label || '');
                const kind = ['teaching', 'duty', 'display'].includes(segment.kind)
                    ? segment.kind
                    : defaultSegmentKindForLabel(label);
                if (kind === 'teaching') return null;
                return {
                    id: segment.id || '',
                    label: segment.label || '',
                    startTime: segment.startTime || '',
                    periodCount: Number.parseInt(segment.periodCount, 10) || 0,
                    classMinutes: segment.classMinutes ?? null,
                    breakMinutes: segment.breakMinutes ?? null,
                    kind,
                };
            })
            .filter(Boolean);
        if (!previewSegments.length) return '';
        return JSON.stringify({
            classMinutes: defaults.classMinutes ?? null,
            breakMinutes: defaults.breakMinutes ?? null,
            segments: previewSegments,
        });
    }

    buildPeriodTimesFromSegments(config = {}, periods = null, existingTimes = []) {
        const hasSegments = Array.isArray(config?.segments) && config.segments.length > 0;
        const derivedPeriods = hasSegments ? this.deriveTeachingPeriodsFromSegmentConfig(config) : [];
        const activePeriods = periods && periods.length > 0
            ? [...periods].sort((left, right) => left - right)
            : hasSegments
                ? derivedPeriods
                : getActivePeriods(this.state.project);
        const safeConfig = this.normalizeSegmentConfig(config, activePeriods);

        // 构建手动覆盖映射
        const manualOverrides = new Map(
            (existingTimes || [])
                .filter(t => t.manualOverride)
                .map(t => [t.period, { start: t.start, end: t.end }])
        );

        const times = [];
        let periodIndex = 0;

        for (const segment of safeConfig.segments) {
            if (segment.kind !== 'teaching') continue;
            const classMinutes = segment.classMinutes ?? safeConfig.globalDefaults.classMinutes;
            const breakMinutes = segment.breakMinutes ?? safeConfig.globalDefaults.breakMinutes;
            let currentMinutes = this.timeToMinutes(segment.startTime) ?? this.timeToMinutes('08:00');

            for (let i = 0; i < segment.periodCount && periodIndex < activePeriods.length; i++) {
                const period = activePeriods[periodIndex];

                // 检查是否有手动覆盖
                if (manualOverrides.has(period)) {
                    const override = manualOverrides.get(period);
                    times.push({
                        period,
                        start: override.start,
                        end: override.end,
                        manualOverride: true,
                        segmentLabel: segment.label,
                    });
                    // 更新 currentMinutes 以基于手动调整的结束时间
                    currentMinutes = this.timeToMinutes(override.end) + breakMinutes;
                } else {
                    const start = this.minutesToTime(currentMinutes);
                    currentMinutes += classMinutes;
                    const end = this.minutesToTime(currentMinutes);
                    times.push({ period, start, end, manualOverride: false, segmentLabel: segment.label });

                    if (i < segment.periodCount - 1) {
                        currentMinutes += breakMinutes;
                    }
                }

                periodIndex++;
            }
        }

        return times;
    }

    buildSegmentLabelMap(config = null, periods = null) {
        if (!config || !Array.isArray(config.segments)) return new Map();
        const activePeriods = periods && periods.length > 0
            ? [...periods].sort((left, right) => left - right)
            : getActivePeriods(this.state.project);
        const safeConfig = this.normalizeSegmentConfig(config, activePeriods);
        const labels = new Map();
        let periodIndex = 0;
        for (const segment of safeConfig.segments) {
            if (segment.kind !== 'teaching') continue;
            for (let index = 0; index < segment.periodCount && periodIndex < activePeriods.length; index += 1) {
                labels.set(activePeriods[periodIndex], segment.label);
                periodIndex += 1;
            }
        }
        return labels;
    }

    getDefaultPeriodTimeSettings(periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const splitIndex = Math.ceil(activePeriods.length / 2);
        return {
            startTime: '08:00',
            classMinutes: 40,
            breakMinutes: 10,
            afternoonStartPeriod: activePeriods.length >= 5 && splitIndex < activePeriods.length ? activePeriods[splitIndex] : null,
            afternoonStartTime: '14:00',
            eveningStartPeriod: null,
            eveningStartTime: '19:00',
        };
    }

    normalizePeriodTimeSettings(settings = {}, periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const defaults = this.getDefaultPeriodTimeSettings(activePeriods);
        const periodIndex = new Map(activePeriods.map((period, index) => [period, index]));
        const toInteger = (value, fallback, min, max) => {
            const number = Number(value);
            if (!Number.isFinite(number)) return fallback;
            return Math.max(min, Math.min(max, Math.round(number)));
        };
        const normalizeTime = (value, fallback) => {
            const minutes = this.timeToMinutes(value);
            return minutes === null ? fallback : this.minutesToTime(minutes);
        };
        const normalizeBoundary = (value, fallback = null, emptyValue = null) => {
            if (value === undefined) return fallback;
            if (value === null) return emptyValue;
            const raw = String(value).trim();
            if (!raw) return emptyValue;
            const number = Number.parseInt(raw, 10);
            if (!Number.isInteger(number) || !periodIndex.has(number)) return fallback;
            return number;
        };
        let afternoonStartPeriod = normalizeBoundary(settings.afternoonStartPeriod, defaults.afternoonStartPeriod, null);
        if (afternoonStartPeriod !== null && periodIndex.get(afternoonStartPeriod) <= 0) {
            afternoonStartPeriod = defaults.afternoonStartPeriod;
        }
        let eveningStartPeriod = null;
        if (String(settings.eveningStartPeriod ?? '').trim() !== '') {
            eveningStartPeriod = normalizeBoundary(settings.eveningStartPeriod, defaults.eveningStartPeriod, null);
        }
        if (
            eveningStartPeriod !== null
            && (periodIndex.get(eveningStartPeriod) <= 0
                || (afternoonStartPeriod !== null && periodIndex.get(eveningStartPeriod) <= periodIndex.get(afternoonStartPeriod)))
        ) {
            eveningStartPeriod = null;
        }
        return {
            startTime: normalizeTime(settings.startTime, defaults.startTime),
            classMinutes: toInteger(settings.classMinutes, defaults.classMinutes, 1, 180),
            breakMinutes: toInteger(settings.breakMinutes, defaults.breakMinutes, 0, 120),
            afternoonStartPeriod,
            afternoonStartTime: normalizeTime(settings.afternoonStartTime, defaults.afternoonStartTime),
            eveningStartPeriod,
            eveningStartTime: normalizeTime(settings.eveningStartTime, defaults.eveningStartTime),
        };
    }

    buildPeriodTimeSelectOptions(values = [], selectedValue = '', blankLabel = '') {
        const optionValues = [];
        if (blankLabel !== null && blankLabel !== undefined) {
            optionValues.push({ value: '', label: blankLabel });
        }
        values.forEach(value => {
            optionValues.push({ value: String(value), label: `第${value}节` });
        });
        return optionValues.map(option => ({
            value: String(option.value ?? ''),
            label: option.label,
        }));
    }

    syncPeriodTimeSelectOptions(selector, values = [], selectedValue = '', blankLabel = '') {
        if (!this.state.container) return;
        const select = this.state.container.querySelector(selector);
        if (!select) return;
        const optionSpecs = this.buildPeriodTimeSelectOptions(values, selectedValue, blankLabel);
        const optionNodes = optionSpecs.map(spec => {
            if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
                const option = document.createElement('option');
                option.value = spec.value;
                option.textContent = spec.label;
                return option;
            }
            return {
                value: spec.value,
                textContent: spec.label,
                label: spec.label,
            };
        });
        if (typeof select.replaceChildren === 'function') {
            select.replaceChildren(...optionNodes);
        } else {
            select.options = optionNodes;
        }
        const allowedValues = new Set(optionSpecs.map(option => option.value));
        const nextValue = selectedValue === undefined || selectedValue === null ? '' : String(selectedValue);
        select.value = allowedValues.has(nextValue) ? nextValue : '';
    }

    buildPeriodTimesFromGapMap(settings = {}, periods = null, gapByPeriod = new Map()) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const safeSettings = this.normalizePeriodTimeSettings(settings, activePeriods);
        let minutes = this.timeToMinutes(safeSettings.startTime) ?? this.timeToMinutes('08:00');
        return activePeriods.map((period, index) => {
            const start = this.minutesToTime(minutes);
            minutes += safeSettings.classMinutes;
            const end = this.minutesToTime(minutes);
            if (index < activePeriods.length - 1) {
                const gap = Number(gapByPeriod instanceof Map ? gapByPeriod.get(period) : gapByPeriod?.[period]);
                minutes += Number.isFinite(gap) ? Math.max(0, Math.round(gap)) : safeSettings.breakMinutes;
            }
            return { period, start, end };
        });
    }

    buildPeriodTimesFromSettings(settings = {}, periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const safeSettings = this.normalizePeriodTimeSettings(settings, activePeriods);
        const anchorMinutesByPeriod = new Map();
        if (activePeriods.length) {
            anchorMinutesByPeriod.set(activePeriods[0], this.timeToMinutes(safeSettings.startTime) ?? this.timeToMinutes('08:00'));
        }
        if (safeSettings.afternoonStartPeriod !== null) {
            anchorMinutesByPeriod.set(
                safeSettings.afternoonStartPeriod,
                this.timeToMinutes(safeSettings.afternoonStartTime) ?? this.timeToMinutes('14:00'),
            );
        }
        if (safeSettings.eveningStartPeriod !== null) {
            anchorMinutesByPeriod.set(
                safeSettings.eveningStartPeriod,
                this.timeToMinutes(safeSettings.eveningStartTime) ?? this.timeToMinutes('19:00'),
            );
        }

        let currentMinutes = anchorMinutesByPeriod.get(activePeriods[0]) ?? this.timeToMinutes('08:00');
        return activePeriods.map((period, index) => {
            if (anchorMinutesByPeriod.has(period)) {
                currentMinutes = anchorMinutesByPeriod.get(period);
            }
            const start = this.minutesToTime(currentMinutes);
            currentMinutes += safeSettings.classMinutes;
            const end = this.minutesToTime(currentMinutes);
            if (index < activePeriods.length - 1) {
                currentMinutes += safeSettings.breakMinutes;
            }
            return { period, start, end };
        });
    }

    buildDefaultPeriodTimes(periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const settings = this.getDefaultPeriodTimeSettings(activePeriods);
        return this.buildPeriodTimesFromSettings(settings, activePeriods);
    }

    mostCommonNumber(values = [], fallback = 0) {
        const counts = new Map();
        values.filter(value => Number.isFinite(value)).forEach(value => {
            counts.set(value, (counts.get(value) || 0) + 1);
        });
        let best = fallback;
        let bestCount = 0;
        counts.forEach((count, value) => {
            if (count > bestCount) {
                best = value;
                bestCount = count;
            }
        });
        return best;
    }

    inferSegmentsFromTimes(times = [], periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const defaults = this.getDefaultSegmentConfig(activePeriods);
        const activeSet = new Set(activePeriods);
        const entries = (Array.isArray(times) ? times : [])
            .map(item => ({
                period: Number(item.period),
                start: item.start || '',
                end: item.end || '',
                startMinutes: this.timeToMinutes(item.start),
                endMinutes: this.timeToMinutes(item.end),
            }))
            .filter(item => activeSet.has(item.period) && item.startMinutes !== null && item.endMinutes !== null && item.endMinutes > item.startMinutes)
            .sort((left, right) => left.period - right.period);

        if (!entries.length) {
            return defaults;
        }

        const durations = entries.map(item => item.endMinutes - item.startMinutes).filter(value => value > 0);
        const gaps = [];
        entries.forEach((entry, index) => {
            const next = entries[index + 1];
            if (!next) return;
            const minutes = next.startMinutes - entry.endMinutes;
            if (minutes >= 0) gaps.push({ period: entry.period, nextPeriod: next.period, minutes });
        });

        const classMinutes = this.mostCommonNumber(durations, defaults.globalDefaults.classMinutes);
        const regularBreakMinutes = gaps.length ? this.mostCommonNumber(gaps.map(g => g.minutes).filter(m => m < 30), defaults.globalDefaults.breakMinutes) : defaults.globalDefaults.breakMinutes;

        const globalDefaults = {
            classMinutes,
            breakMinutes: regularBreakMinutes,
        };

        const threshold = Math.max(30, regularBreakMinutes + 20);
        const segmentBoundaries = gaps
            .filter(gap => gap.minutes >= threshold)
            .map(gap => gap.nextPeriod)
            .sort((a, b) => a - b);

        const segments = [];
        let segmentStart = 0;

        segmentBoundaries.forEach((boundaryPeriod, index) => {
            const segmentPeriods = activePeriods.slice(segmentStart, activePeriods.indexOf(boundaryPeriod));
            if (segmentPeriods.length > 0) {
                const firstEntry = entries.find(e => e.period === segmentPeriods[0]);
                segments.push({
                    id: `seg-${segments.length + 1}`,
                    label: index === 0 ? '上午时段' : index === 1 ? '下午时段' : `时段${segments.length + 1}`,
                    startTime: firstEntry?.start || '08:00',
                    periodCount: segmentPeriods.length,
                    classMinutes: null,
                    breakMinutes: null,
                });
            }
            segmentStart = activePeriods.indexOf(boundaryPeriod);
        });

        const remainingPeriods = activePeriods.slice(segmentStart);
        if (remainingPeriods.length > 0) {
            const firstEntry = entries.find(e => e.period === remainingPeriods[0]);
            segments.push({
                id: `seg-${segments.length + 1}`,
                label: segments.length === 0 ? '上午时段' : segments.length === 1 ? '下午时段' : segmentBoundaries.length >= 2 ? '晚间时段' : `时段${segments.length + 1}`,
                startTime: firstEntry?.start || (segments.length === 0 ? '08:00' : segments.length === 1 ? '14:00' : '19:00'),
                periodCount: remainingPeriods.length,
                classMinutes: null,
                breakMinutes: null,
            });
        }

        return {
            globalDefaults,
            segments: segments.length ? segments : defaults.segments,
        };
    }

    inferPeriodTimeSettings(times = [], periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const defaults = this.getDefaultPeriodTimeSettings(activePeriods);
        const activeSet = new Set(activePeriods);
        const entries = (Array.isArray(times) ? times : [])
            .map(item => ({
                period: Number(item.period),
                start: item.start || '',
                end: item.end || '',
                startMinutes: this.timeToMinutes(item.start),
                endMinutes: this.timeToMinutes(item.end),
            }))
            .filter(item => activeSet.has(item.period) && item.startMinutes !== null && item.endMinutes !== null && item.endMinutes > item.startMinutes)
            .sort((left, right) => left.period - right.period);
        const storedBoundaries = this.state.project?.dayPartBoundaries || {};
        if (!entries.length) {
            return this.normalizePeriodTimeSettings({
                ...defaults,
                afternoonStartPeriod: storedBoundaries.afternoonStartPeriod ?? defaults.afternoonStartPeriod,
                eveningStartPeriod: storedBoundaries.eveningStartPeriod ?? defaults.eveningStartPeriod,
            }, activePeriods);
        }

        const durations = entries.map(item => item.endMinutes - item.startMinutes).filter(value => value > 0);
        const gaps = [];
        entries.forEach((entry, index) => {
            const next = entries[index + 1];
            if (!next) return;
            const minutes = next.startMinutes - entry.endMinutes;
            if (minutes >= 0) gaps.push({ period: entry.period, nextPeriod: next.period, minutes });
        });

        let breakMinutes = defaults.breakMinutes;
        if (gaps.length) {
            const largest = gaps.reduce((best, item) => item.minutes > best.minutes ? item : best, gaps[0]);
            const likelyLunch = largest.minutes >= 30;
            const regularGaps = likelyLunch ? gaps.filter(item => item !== largest).map(item => item.minutes) : gaps.map(item => item.minutes);
            breakMinutes = this.mostCommonNumber(regularGaps, likelyLunch ? defaults.breakMinutes : gaps[0].minutes);
        }

        const inferredBoundaries = (() => {
            if (!gaps.length) return { afternoonStartPeriod: null, eveningStartPeriod: null };
            const threshold = Math.max(30, breakMinutes + 20, breakMinutes * 2);
            const candidates = gaps
                .filter(item => item.minutes >= threshold)
                .map(item => item.nextPeriod)
                .filter(period => Number.isInteger(period))
                .sort((left, right) => left - right);
            return {
                afternoonStartPeriod: candidates[0] ?? null,
                eveningStartPeriod: candidates.find(period => period > (candidates[0] ?? Number.POSITIVE_INFINITY)) ?? null,
            };
        })();
        const entryMap = new Map(entries.map(item => [item.period, item]));
        const afternoonStartPeriod = storedBoundaries.afternoonStartPeriod ?? inferredBoundaries.afternoonStartPeriod ?? defaults.afternoonStartPeriod;
        const eveningStartPeriod = storedBoundaries.eveningStartPeriod ?? inferredBoundaries.eveningStartPeriod ?? defaults.eveningStartPeriod;

        return this.normalizePeriodTimeSettings({
            ...defaults,
            startTime: entries[0].start,
            classMinutes: this.mostCommonNumber(durations, defaults.classMinutes),
            breakMinutes,
            afternoonStartPeriod,
            afternoonStartTime: entryMap.get(afternoonStartPeriod)?.start || defaults.afternoonStartTime,
            eveningStartPeriod,
            eveningStartTime: entryMap.get(eveningStartPeriod)?.start || defaults.eveningStartTime,
        }, activePeriods);
    }

    getPeriodTimeDraftSource() {
        return this.state.rangeDraft?.periodTimes || this.state.project?.periodTimes || [];
    }

    normalizePeriodTimeDraft(times = [], periods = null) {
        const activePeriods = new Set(periods || getActivePeriods(this.state.project));
        return (Array.isArray(times) ? times : [])
            .map(item => ({
                period: Number(item.period),
                start: item.start || '',
                end: item.end || '',
            }))
            .filter(item => activePeriods.has(item.period) && (item.start || item.end))
            .sort((left, right) => left.period - right.period);
    }

    completePeriodTimeDraft(times = [], periods = null, config = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))].sort((left, right) => left - right);
        const normalized = this.normalizePeriodTimeDraft(times, activePeriods);
        const segmentConfig = config || this.inferSegmentsFromTimes(normalized, activePeriods);
        if (!normalized.length) return this.buildPeriodTimesFromSegments(segmentConfig, activePeriods);
        if (normalized.length >= activePeriods.length) return normalized;
        const existing = new Map(normalized.map(item => [Number(item.period), item]));
        const generated = new Map(this.buildPeriodTimesFromSegments(segmentConfig, activePeriods)
            .map(item => [Number(item.period), item]));
        return activePeriods
            .map(period => existing.get(period) || generated.get(period))
            .filter(Boolean);
    }

    openPeriodTimeDialog() {
        const projectActivePeriods = getActivePeriods(this.state.project);
        const initialDraftTimes = this.normalizePeriodTimeDraft(this.getPeriodTimeDraftSource(), projectActivePeriods);
        const rawSegmentConfig = this.state.project?.periodTimeSegments || this.inferSegmentsFromTimes(initialDraftTimes, projectActivePeriods);
        const segmentConfig = this.normalizeSegmentConfig(rawSegmentConfig, []);
        const activePeriods = this.getFormalPeriodsForSegmentConfig(segmentConfig);
        const draftTimes = this.normalizePeriodTimeDraft(this.getPeriodTimeDraftSource(), activePeriods);
        const wasCleared = Boolean(this.state.periodTimeDialog?.cleared);
        this.state.periodTimeDialog = {
            open: true,
            segmentConfig,
            errors: [],
            cleared: wasCleared && draftTimes.length === 0,
            draftTimes: wasCleared && draftTimes.length === 0 ? [] : this.completePeriodTimeDraft(draftTimes, activePeriods, segmentConfig),
        };
        this.render();
    }

    closePeriodTimeDialog() {
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: false,
            saving: false,
            cleared: false,
            errors: [],
            draftTimes: this.normalizePeriodTimeDraft(this.state.project?.periodTimes || [], getActivePeriods(this.state.project)),
            segmentConfig: this.state.project?.periodTimeSegments || this.inferSegmentsFromTimes(this.state.project?.periodTimes || [], getActivePeriods(this.state.project)),
        };
        this.render();
    }

    dutyAssignmentKey(item = {}) {
        return `${Number(item.day)}|${item.classId || ''}|${item.timeBlockId || ''}`;
    }

    openDutyAssignmentDialog(day, timeBlockId, classId = '') {
        const project = this.state.project || {};
        const explicitClassId = classId || (this.state.viewMode === 'class' ? this.state.selectedOwnerId : '');
        const selectedClassId = classId
            || (this.state.viewMode === 'class' ? this.state.selectedOwnerId : '')
            || project.classes?.[0]?.id
            || '';
        const existing = (project.dutyAssignments || []).find(item => (
            Number(item.day) === Number(day)
            && item.classId === selectedClassId
            && item.timeBlockId === timeBlockId
            && item.status !== 'paused'
        ));
        this.state.dutyDialog = {
            open: true,
            day: Number(day),
            classId: selectedClassId,
            classLocked: this.state.viewMode === 'class' && Boolean(explicitClassId),
            timeBlockId,
            teacherId: existing?.teacherId || '',
            saving: false,
            error: '',
        };
        this.render();
    }

    closeDutyAssignmentDialog() {
        this.state.dutyDialog = {
            ...(this.state.dutyDialog || {}),
            open: false,
            saving: false,
            error: '',
        };
        this.render();
    }

    dutyTeacherPicker() {
        return this.state.container?.querySelector?.('[data-duty-teacher-picker]') || null;
    }

    dutyTeacherOptions() {
        return Array.from(this.dutyTeacherPicker()?.querySelectorAll?.('[data-duty-teacher-option]') || []);
    }

    openDutyTeacherOptions() {
        const picker = this.dutyTeacherPicker();
        if (!picker) return;
        picker.classList.remove('is-closed');
        picker.querySelector('[data-duty-teacher-search]')?.setAttribute('aria-expanded', 'true');
    }

    closeDutyTeacherOptions() {
        const picker = this.dutyTeacherPicker();
        if (!picker) return;
        picker.classList.add('is-closed');
        picker.querySelector('[data-duty-teacher-search]')?.setAttribute('aria-expanded', 'false');
    }

    setDutyTeacherActiveOption(option = null) {
        const picker = this.dutyTeacherPicker();
        if (!picker) return;
        this.dutyTeacherOptions().forEach(item => {
            const active = item === option;
            item.classList.toggle('is-active', active);
            if (active) item.setAttribute('data-duty-teacher-active', 'true');
            else item.removeAttribute('data-duty-teacher-active');
        });
        const search = picker.querySelector('[data-duty-teacher-search]');
        if (search) {
            if (option?.id) search.setAttribute('aria-activedescendant', option.id);
            else search.removeAttribute('aria-activedescendant');
        }
        option?.scrollIntoView?.({ block: 'nearest' });
    }

    visibleDutyTeacherOptions() {
        return this.dutyTeacherOptions().filter(option => {
            if (option.hidden || option.disabled) return false;
            return true;
        });
    }

    filterDutyTeacherOptions(query = '') {
        const picker = this.dutyTeacherPicker();
        if (!picker) return;
        const normalizedQuery = dutyTeacherSearchQuery(query);
        let teacherMatchCount = 0;
        this.dutyTeacherOptions().forEach(option => {
            const searchText = dutyTeacherSearchQuery(option.dataset.dutyTeacherSearchText || '');
            const visible = !normalizedQuery || searchText.includes(normalizedQuery);
            option.hidden = !visible;
            if (visible) teacherMatchCount += 1;
        });
        picker.querySelector('[data-duty-teacher-empty-message]')?.toggleAttribute('hidden', teacherMatchCount > 0 || !normalizedQuery);
        this.openDutyTeacherOptions();
        this.setDutyTeacherActiveOption(this.visibleDutyTeacherOptions()[0] || null);
    }

    moveDutyTeacherActive(delta = 1) {
        this.openDutyTeacherOptions();
        const options = this.visibleDutyTeacherOptions();
        if (!options.length) return;
        const current = options.findIndex(option => option.dataset.dutyTeacherActive === 'true');
        const nextIndex = current >= 0
            ? (current + delta + options.length) % options.length
            : (delta < 0 ? options.length - 1 : 0);
        this.setDutyTeacherActiveOption(options[nextIndex]);
    }

    confirmDutyTeacherActive() {
        const active = this.dutyTeacherOptions().find(option => option.dataset.dutyTeacherActive === 'true' && !option.hidden && !option.disabled)
            || this.visibleDutyTeacherOptions()[0];
        if (!active) return false;
        return this.selectDutyTeacherOption(active.dataset.dutyTeacherOption || '', active);
    }

    selectDutyTeacherOption(teacherId = '', optionNode = null) {
        const picker = this.dutyTeacherPicker();
        if (!picker) return false;
        const option = optionNode || this.dutyTeacherOptions()
            .find(item => (item.dataset.dutyTeacherOption || '') === String(teacherId || ''));
        if (!option || option.disabled) return false;
        const value = option.dataset.dutyTeacherOption || '';
        const label = option.dataset.dutyTeacherLabel || '未安排';
        picker.querySelector('#tt-duty-assignment-teacher')?.setAttribute('value', value);
        const hidden = picker.querySelector('#tt-duty-assignment-teacher');
        if (hidden) hidden.value = value;
        const current = picker.querySelector('[data-duty-teacher-current] strong');
        if (current) current.textContent = label || '未安排';
        const search = picker.querySelector('[data-duty-teacher-search]');
        if (search) search.value = '';
        this.state.dutyDialog = {
            ...(this.state.dutyDialog || {}),
            teacherId: value,
        };
        this.dutyTeacherOptions().forEach(item => {
            const selected = item === option;
            item.classList.toggle('is-selected', selected);
            item.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        this.filterDutyTeacherOptions('');
        this.closeDutyTeacherOptions();
        return true;
    }

    readDutyAssignmentDialogValues() {
        const dialog = this.state.dutyDialog || {};
        const container = this.state.container;
        return {
            day: Number(dialog.day),
            classId: container?.querySelector?.('#tt-duty-assignment-class')?.value || dialog.classId || '',
            timeBlockId: dialog.timeBlockId || '',
            teacherId: container?.querySelector?.('#tt-duty-assignment-teacher')?.value || dialog.teacherId || '',
        };
    }

    async saveDutyAssignmentDialog() {
        const values = this.readDutyAssignmentDialogValues();
        if (!values.day || !values.classId || !values.timeBlockId) {
            this.state.dutyDialog = { ...(this.state.dutyDialog || {}), error: '值班班级和时段不完整。' };
            this.render();
            return;
        }
        if (!values.teacherId) {
            await this.clearDutyAssignmentDialog();
            return;
        }
        const current = this.state.project?.dutyAssignments || [];
        const key = this.dutyAssignmentKey(values);
        const existing = current.find(item => this.dutyAssignmentKey(item) === key);
        const preserved = existing
            ? Object.fromEntries(Object.entries(existing).filter(([field]) => !['day', 'classId', 'timeBlockId', 'teacherId'].includes(field)))
            : {};
        const updatedAssignment = {
            id: existing?.id || `duty-${values.day}-${values.classId}-${values.timeBlockId}`,
            ...preserved,
            day: values.day,
            classId: values.classId,
            timeBlockId: values.timeBlockId,
            teacherId: values.teacherId,
            source: existing?.source || preserved.source || 'manual',
            status: existing?.status || preserved.status || 'active',
        };
        const dutyAssignments = [
            ...current.filter(item => this.dutyAssignmentKey(item) !== key),
            updatedAssignment,
        ];
        this.state.dutyDialog = { ...(this.state.dutyDialog || {}), saving: true, error: '' };
        this.render();
        await this.saveProject({ dutyAssignments });
        this.state.dutyDialog = { open: false, day: null, classId: '', classLocked: false, timeBlockId: '', teacherId: '', saving: false, error: '' };
        this.render();
    }

    async clearDutyAssignmentDialog() {
        const values = this.readDutyAssignmentDialogValues();
        const key = this.dutyAssignmentKey(values);
        const dutyAssignments = (this.state.project?.dutyAssignments || [])
            .filter(item => this.dutyAssignmentKey(item) !== key);
        this.state.dutyDialog = { ...(this.state.dutyDialog || {}), saving: true, error: '' };
        this.render();
        await this.saveProject({ dutyAssignments });
        this.state.dutyDialog = { open: false, day: null, classId: '', classLocked: false, timeBlockId: '', teacherId: '', saving: false, error: '' };
        this.render();
    }

    autoFillPeriodTimes() {
        const activePeriods = getActivePeriods(this.state.project);
        const segmentConfig = this.getDefaultSegmentConfig(activePeriods);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig,
            errors: [],
            cleared: false,
            draftTimes: this.buildPeriodTimesFromSegments(segmentConfig, activePeriods),
        };
        this.render();
        this.setMessage('已恢复默认节次时间，保存后生效。');
    }

    clearPeriodTimes() {
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: this.state.periodTimeDialog?.segmentConfig || this.getDefaultSegmentConfig(),
            errors: [],
            cleared: true,
            draftTimes: [],
        };
        this.render();
    }

    readSegmentConfigFromDom({ includePeriodTimeBlockInputs = false } = {}) {
        if (!this.state.container) return null;
        const globalClassMinutes = this.state.container.querySelector('#tt-segment-global-class-minutes')?.value;
        const globalBreakMinutes = this.state.container.querySelector('#tt-segment-global-break-minutes')?.value;
        const segmentCards = [...this.state.container.querySelectorAll('.tt-segment-card[data-segment-id]')];
        const segments = segmentCards.map(card => {
            const id = card.dataset.segmentId;
            const classMinutesValue = card.querySelector(`[data-segment-field="${id}-classMinutes"]`)?.value;
            const breakMinutesValue = card.querySelector(`[data-segment-field="${id}-breakMinutes"]`)?.value;
            const kindInput = card.querySelector(`[data-segment-field="${id}-kind"]`);
            const dutyInput = card.querySelector(`[data-segment-field="${id}-dutyEnabled"]`);
            const label = card.querySelector(`[data-segment-field="${id}-label"]`)?.value || '时段';
            const kindValue = kindInput ? kindInput.value : (card.dataset.segmentKind || '');
            const kind = (() => {
                if (kindValue === 'teaching') return 'teaching';
                if (kindValue === 'additional') {
                    const checked = dutyInput
                        ? Boolean(dutyInput.checked)
                        : card.dataset.segmentKind === 'duty' || defaultSegmentKindForLabel(label) === 'duty';
                    return checked ? 'duty' : 'display';
                }
                return ['duty', 'display'].includes(kindValue)
                    ? kindValue
                    : defaultSegmentKindForLabel(label);
            })();
            return {
                id,
                label,
                startTime: card.querySelector(`[data-segment-field="${id}-startTime"]`)?.value || '08:00',
                periodCount: card.querySelector(`[data-segment-field="${id}-periodCount"]`)?.value || '1',
                classMinutes: classMinutesValue === '' ? null : classMinutesValue,
                breakMinutes: breakMinutesValue === '' ? null : breakMinutesValue,
                kind,
            };
        });
        const config = {
            globalDefaults: {
                classMinutes: globalClassMinutes,
                breakMinutes: globalBreakMinutes,
            },
            segments,
        };
        return includePeriodTimeBlockInputs
            ? this.applyPeriodTimeBlockInputsToSegmentConfig(config)
            : config;
    }

    applyPeriodTimeBlockInputsToSegmentConfig(config = {}) {
        if (!this.state.container || typeof this.state.container.querySelectorAll !== 'function') return config;
        const blockRows = [...this.state.container.querySelectorAll('[data-period-time-block-row]')];
        if (!blockRows.length || !Array.isArray(config.segments)) return config;
        const normalizedConfig = this.normalizeSegmentConfig(config, []);
        const rowById = new Map(blockRows
            .map(row => [row.dataset?.periodTimeBlockRow || '', row])
            .filter(([id]) => id));
        const toMinutes = value => this.timeToMinutes(value);
        const defaultBreakMinutes = Number(normalizedConfig.globalDefaults?.breakMinutes);
        const segments = normalizedConfig.segments.map(segment => {
            const row = rowById.get(segment.id);
            if (!row) return segment;
            const startValue = row.querySelector('[data-period-time-block-start]')?.value || '';
            const endValue = row.querySelector('[data-period-time-block-end]')?.value || '';
            const startMinutes = toMinutes(startValue);
            const endMinutes = toMinutes(endValue);
            const updated = { ...segment };
            if (startMinutes !== null) {
                updated.startTime = this.minutesToTime(startMinutes);
            }
            if (startMinutes !== null && endMinutes !== null && endMinutes > startMinutes) {
                const periodCount = Math.max(1, Number.parseInt(updated.periodCount, 10) || 1);
                const breakMinutes = Number.isFinite(Number(updated.breakMinutes))
                    ? Number(updated.breakMinutes)
                    : (Number.isFinite(defaultBreakMinutes) ? defaultBreakMinutes : 0);
                const totalBreakMinutes = Math.max(0, periodCount - 1) * breakMinutes;
                const classMinutes = Math.max(1, Math.round((endMinutes - startMinutes - totalBreakMinutes) / periodCount));
                updated.classMinutes = classMinutes;
            }
            return updated;
        });
        return { ...normalizedConfig, segments };
    }

    syncSegmentCardSummariesToDom(segmentConfig = {}) {
        if (!this.state.container || typeof this.state.container.querySelectorAll !== 'function') return;
        const segments = Array.isArray(segmentConfig.segments) ? segmentConfig.segments : [];
        const segmentById = new Map(segments.map((segment, index) => [segment.id, { segment, index }]));
        const cards = [...this.state.container.querySelectorAll('[data-period-time-segment-card]')];
        cards.forEach(card => {
            const id = card.dataset?.segmentId || '';
            const entry = segmentById.get(id);
            if (!entry) return;
            const { segment, index } = entry;
            if (card.dataset) card.dataset.segmentKind = segment.kind || '';
            const meta = card.querySelector?.('.tt-segment-index');
            if (meta) meta.textContent = formatPeriodTimeSegmentMeta(segment, index);
            const dutyStatus = card.querySelector?.('[data-segment-duty-status]');
            if (dutyStatus) dutyStatus.textContent = segment.kind === 'duty' ? '开启' : '关闭';
        });
    }

    syncPeriodTimeBlockSegmentFieldsToDom(segmentConfig = {}) {
        if (!this.state.container || typeof this.state.container.querySelector !== 'function') return;
        (segmentConfig.segments || []).forEach(segment => {
            const id = segment.id || '';
            if (!id) return;
            const startInput = this.state.container.querySelector(`[data-segment-field="${id}-startTime"]`);
            const classMinutesInput = this.state.container.querySelector(`[data-segment-field="${id}-classMinutes"]`);
            if (startInput) startInput.value = segment.startTime || '';
            if (classMinutesInput && segment.classMinutes !== null && segment.classMinutes !== undefined) {
                classMinutesInput.value = String(segment.classMinutes);
            }
        });
    }

    updatePeriodTimeBlockFromDom(input) {
        if (!input || !this.state.container) return null;
        const config = this.readSegmentConfigFromDom({ includePeriodTimeBlockInputs: true });
        if (!config) return null;
        const normalized = this.normalizeSegmentConfig(config, []);
        const existingTimes = this.state.periodTimeDialog?.draftTimes || [];
        const draftTimes = this.buildPeriodTimesFromSegments(normalized, null, existingTimes);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: normalized,
            errors: [],
            cleared: false,
            draftTimes,
        };
        this.syncPeriodTimeBlockSegmentFieldsToDom(normalized);
        this.refreshPeriodTimeGapInputsFromDom();
        return normalized;
    }

    updateSegmentConfigFromForm() {
        const config = this.readSegmentConfigFromDom();
        if (!config) {
            console.warn('updateSegmentConfigFromForm: No config read from DOM');
            return;
        }

        // 新逻辑：不再受外层 activePeriods 限制
        const normalized = this.normalizeSegmentConfig(config, []);
        const existingTimes = this.state.periodTimeDialog?.draftTimes || [];
        const draftTimes = this.buildPeriodTimesFromSegments(normalized, null, existingTimes);

        // Check if total period count changed (requires full render to update table rows)
        const previousConfig = this.state.periodTimeDialog?.segmentConfig;
        const previousTotal = this.deriveTeachingPeriodsFromSegmentConfig(previousConfig).length;
        const newTotal = this.deriveTeachingPeriodsFromSegmentConfig(normalized).length;
        const totalPeriodCountChanged = previousTotal !== newTotal;
        const nonTeachingPreviewChanged = this.getNonTeachingSegmentPreviewSignature(previousConfig)
            !== this.getNonTeachingSegmentPreviewSignature(normalized);

        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: normalized,
            errors: [],
            cleared: false,
            draftTimes,
        };

        if (totalPeriodCountChanged) {
            this.render();
        } else {
            this.syncSegmentCardSummariesToDom(normalized);
            this.writePeriodTimesToDom(draftTimes);
            this.refreshPeriodTimeGapInputsFromDom();
            if (nonTeachingPreviewChanged) {
                const previewUpdated = this.refreshNonTeachingSegmentPreviewFromDom(normalized);
                const timelineUpdated = this.refreshPeriodTimeTimelineFromDom(normalized, draftTimes);
                if (!previewUpdated || !timelineUpdated) {
                    this.render();
                }
            }
        }
    }

    addPeriodTimeSegment() {
        const current = this.state.periodTimeDialog?.segmentConfig || this.getDefaultSegmentConfig();
        const newId = `seg-${current.segments.length + 1}`;
        const newSegment = {
            id: newId,
            label: `时段${current.segments.length + 1}`,
            startTime: current.segments.length === 0 ? '08:00' : current.segments.length === 1 ? '14:00' : '19:00',
            periodCount: 2,
            classMinutes: null,
            breakMinutes: null,
            kind: 'teaching',
        };
        const updated = {
            ...current,
            segments: [...current.segments, newSegment],
        };
        const existingTimes = this.state.periodTimeDialog?.draftTimes || [];
        const draftTimes = this.buildPeriodTimesFromSegments(updated, null, existingTimes);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: updated,
            draftTimes,
            errors: [],
            cleared: false,
        };
        this.render();
    }

    removePeriodTimeSegment(id) {
        const current = this.state.periodTimeDialog?.segmentConfig || this.getDefaultSegmentConfig();
        const updated = {
            ...current,
            segments: current.segments.filter(seg => seg.id !== id),
        };
        if (updated.segments.length === 0) {
            this.setMessage('至少保留一个时段');
            return;
        }
        const existingTimes = this.state.periodTimeDialog?.draftTimes || [];
        const draftTimes = this.buildPeriodTimesFromSegments(updated, null, existingTimes);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: updated,
            draftTimes,
        };
        this.render();
    }

    applySegmentTemplate(templateName) {
        const template = PRESET_TEMPLATES[templateName];
        if (!template) {
            console.warn(`Unknown template: ${templateName}`);
            return;
        }

        const normalized = this.normalizeSegmentConfig(template, []);
        const existingTimes = this.state.periodTimeDialog?.draftTimes || [];
        const draftTimes = this.buildPeriodTimesFromSegments(normalized, null, existingTimes);

        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: normalized,
            errors: [],
            cleared: false,
            draftTimes,
        };
        this.render();
        this.setMessage(`已应用"${template.name}"模板`);
    }

    readPeriodTimeSettingsFromDom() {
        if (!this.state.container) return null;
        const startInput = this.state.container.querySelector('#tt-period-start-time');
        if (!startInput) return null;
        return this.normalizePeriodTimeSettings({
            startTime: startInput.value,
            classMinutes: this.state.container.querySelector('#tt-period-class-minutes')?.value,
            breakMinutes: this.state.container.querySelector('#tt-period-break-minutes')?.value,
            afternoonStartPeriod: this.state.container.querySelector('#tt-period-afternoon-start-period')?.value,
            afternoonStartTime: this.state.container.querySelector('#tt-period-afternoon-start-time')?.value,
            eveningStartPeriod: this.state.container.querySelector('#tt-period-evening-start-period')?.value,
            eveningStartTime: this.state.container.querySelector('#tt-period-evening-start-time')?.value,
        });
    }

    syncPeriodTimeSettingsToDom(settings = {}) {
        if (!this.state.container) return;
        const fields = [
            ['#tt-period-start-time', settings.startTime],
            ['#tt-period-class-minutes', String(settings.classMinutes ?? '')],
            ['#tt-period-break-minutes', String(settings.breakMinutes ?? '')],
            ['#tt-period-afternoon-start-period', settings.afternoonStartPeriod === null ? '' : String(settings.afternoonStartPeriod)],
            ['#tt-period-afternoon-start-time', settings.afternoonStartTime || ''],
            ['#tt-period-evening-start-period', settings.eveningStartPeriod === null ? '' : String(settings.eveningStartPeriod)],
            ['#tt-period-evening-start-time', settings.eveningStartTime || ''],
        ];
        fields.forEach(([selector, value]) => {
            const input = this.state.container.querySelector(selector);
            if (input) input.value = value;
        });
        const activePeriods = getActivePeriods(this.state.project);
        const afternoonPeriods = activePeriods.slice(1);
        const eveningPeriods = activePeriods.filter(period => {
            if (settings.afternoonStartPeriod === null) {
                return period > activePeriods[0];
            }
            return period > Number(settings.afternoonStartPeriod);
        });
        this.syncPeriodTimeSelectOptions('#tt-period-afternoon-start-period', afternoonPeriods, settings.afternoonStartPeriod, '不单独拆分下午');
        this.syncPeriodTimeSelectOptions('#tt-period-evening-start-period', eveningPeriods, settings.eveningStartPeriod, '不启用晚间');
        const afternoonTimeInput = this.state.container.querySelector('#tt-period-afternoon-start-time');
        if (afternoonTimeInput) afternoonTimeInput.disabled = !settings.afternoonStartPeriod;
        const eveningTimeInput = this.state.container.querySelector('#tt-period-evening-start-time');
        if (eveningTimeInput) eveningTimeInput.disabled = !settings.eveningStartPeriod;
    }

    updatePeriodTimeSettingsFromForm() {
        const settings = this.readPeriodTimeSettingsFromDom();
        if (!settings) return;
        const activePeriods = getActivePeriods(this.state.project);
        const normalizedSettings = this.normalizePeriodTimeSettings(settings, activePeriods);
        const draftTimes = this.buildPeriodTimesFromSettings(normalizedSettings, activePeriods);
        this.syncPeriodTimeSettingsToDom(normalizedSettings);
        this.writePeriodTimesToDom(draftTimes);
        this.refreshPeriodTimeGapInputsFromDom();
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            settings: normalizedSettings,
            errors: [],
            cleared: false,
            draftTimes,
        };
    }

    generatePeriodTimesFromSettings() {
        const activePeriods = getActivePeriods(this.state.project);
        const settings = this.readPeriodTimeSettingsFromDom() || this.state.periodTimeDialog?.settings || this.getDefaultPeriodTimeSettings(activePeriods);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            settings,
            errors: [],
            cleared: false,
            draftTimes: this.buildPeriodTimesFromSettings(settings, activePeriods),
        };
        this.render();
    }

    collectPeriodTimesFromDom() {
        if (!this.state.container) return null;
        const rows = [...this.state.container.querySelectorAll('[data-period-time-row]')];
        if (!rows.length) return null;
        return rows.map(row => {
            const period = Number(row.dataset.periodTimeRow);
            const startInput = row.querySelector('[data-period-time-draft-start], [data-period-time-start]');
            const endInput = row.querySelector('[data-period-time-draft-end], [data-period-time-end]');
            return {
                period,
                start: startInput?.value || '',
                end: endInput?.value || '',
            };
        });
    }

    writePeriodTimesToDom(times = []) {
        if (!this.state.container || typeof this.state.container.querySelectorAll !== 'function') return;
        const timeMap = new Map((Array.isArray(times) ? times : [])
            .map(item => [Number(item.period), item]));
        const rows = this.state.container.querySelectorAll('[data-period-time-row]');
        if (rows.length === 0) {
            console.warn('writePeriodTimesToDom: No rows found');
            return;
        }
        rows.forEach(row => {
            const period = Number(row.dataset.periodTimeRow);
            const entry = timeMap.get(period) || {};
            const startInput = row.querySelector(`[data-period-time-draft-start="${period}"], [data-period-time-start="${period}"]`);
            const endInput = row.querySelector(`[data-period-time-draft-end="${period}"], [data-period-time-end="${period}"]`);
            if (startInput) {
                startInput.value = entry.start || '';
            }
            if (endInput) {
                endInput.value = entry.end || '';
            }
        });
        this.syncPeriodTimeSegmentHeadersToDom(times);
        this.refreshPeriodTimeGapInputsFromDom();
    }

    syncPeriodTimeSegmentHeadersToDom(times = []) {
        if (!this.state.container || typeof this.state.container.querySelector !== 'function') return;
        const tbody = this.state.container.querySelector('.tt-period-time-table tbody');
        const rows = [...(this.state.container.querySelectorAll?.('[data-period-time-row]') || [])];
        if (!tbody || !rows.length || typeof tbody.insertBefore !== 'function') return;
        const ownerDocument = tbody.ownerDocument || this.state.container.ownerDocument || globalThis.document;
        if (!ownerDocument || typeof ownerDocument.createElement !== 'function') return;

        const timeMap = new Map((Array.isArray(times) ? times : [])
            .map(item => [Number(item.period), item]));
        const rowPeriods = rows.map(row => Number(row.dataset.periodTimeRow)).filter(Number.isFinite);
        const labelMap = this.buildSegmentLabelMap(this.state.periodTimeDialog?.segmentConfig, rowPeriods);

        tbody.querySelectorAll?.('.tt-period-time-segment-header')
            ?.forEach(header => header.remove?.());

        rows.forEach((row, index) => {
            const period = Number(row.dataset.periodTimeRow);
            const previousPeriod = Number(rows[index - 1]?.dataset.periodTimeRow);
            const label = timeMap.get(period)?.segmentLabel || labelMap.get(period) || '';
            const previousLabel = index > 0
                ? (timeMap.get(previousPeriod)?.segmentLabel || labelMap.get(previousPeriod) || '')
                : '';
            if (!label || (index > 0 && label === previousLabel)) return;

            const header = ownerDocument.createElement('tr');
            header.className = 'tt-period-time-segment-header';
            const cell = ownerDocument.createElement('td');
            cell.colSpan = 4;
            const title = ownerDocument.createElement('strong');
            title.textContent = label;
            cell.appendChild(title);
            header.appendChild(cell);
            tbody.insertBefore(header, row);
        });
    }

    refreshNonTeachingSegmentPreviewFromDom(segmentConfig = {}) {
        if (!this.state.container || typeof this.state.container.querySelector !== 'function') return false;
        const slot = this.state.container.querySelector('[data-nonformal-time-preview-slot]');
        if (!slot) return true;
        slot.innerHTML = renderNonTeachingSegmentPreview(segmentConfig);
        return true;
    }

    refreshPeriodTimeTimelineFromDom(segmentConfig = {}, draftTimes = []) {
        if (!this.state.container || typeof this.state.container.querySelector !== 'function') return false;
        const slot = this.state.container.querySelector('[data-period-time-table-body-slot]');
        if (!slot) return false;
        slot.innerHTML = renderPeriodTimeTableBody({
            activePeriods: this.getFormalPeriodsForSegmentConfig(segmentConfig),
            draftTimes,
            errors: this.state.periodTimeDialog?.errors || [],
            segmentConfig,
            saving: Boolean(this.state.periodTimeDialog?.saving),
        });
        return true;
    }

    calculatePeriodGap(current = {}, next = {}) {
        const end = this.timeToMinutes(current.end);
        const start = this.timeToMinutes(next.start);
        if (end === null || start === null) return '';
        return start - end;
    }

    refreshPeriodTimeGapInputsFromDom() {
        if (!this.state.container) return;
        const rows = [...this.state.container.querySelectorAll('[data-period-time-row]')];
        rows.forEach((row, index) => {
            const gapInput = row.querySelector('[data-period-time-gap-after]');
            if (!gapInput) return;
            const current = {
                end: row.querySelector('[data-period-time-draft-end], [data-period-time-end]')?.value || '',
            };
            const nextRow = rows[index + 1];
            const next = {
                start: nextRow?.querySelector('[data-period-time-draft-start], [data-period-time-start]')?.value || '',
            };
            gapInput.value = String(this.calculatePeriodGap(current, next));
        });
        const timelineRows = [...this.state.container.querySelectorAll('[data-period-time-row], [data-period-time-block-row]')];
        timelineRows.forEach((row, index) => {
            const gapInput = row.querySelector('[data-period-time-block-gap-after]');
            if (!gapInput) return;
            const current = {
                end: row.querySelector('[data-period-time-draft-end], [data-period-time-end], [data-period-time-block-end]')?.value || '',
            };
            const nextRow = timelineRows[index + 1];
            const next = {
                start: nextRow?.querySelector('[data-period-time-draft-start], [data-period-time-start], [data-period-time-block-start]')?.value || '',
            };
            gapInput.value = String(this.calculatePeriodGap(current, next));
        });
    }

    updatePeriodTimeBlockGapFromDom(input) {
        if (!input || !this.state.container) return;
        const rows = [...this.state.container.querySelectorAll('[data-period-time-row], [data-period-time-block-row]')];
        const blockId = input.dataset.periodTimeBlockGapAfter;
        const rowIndex = rows.findIndex(row => row.dataset?.periodTimeBlockRow === blockId);
        if (rowIndex < 0 || rowIndex >= rows.length - 1) return;
        const currentEnd = this.timeToMinutes(rows[rowIndex].querySelector('[data-period-time-block-end]')?.value);
        if (currentEnd === null || String(input.value || '').trim() === '') {
            this.updatePeriodTimeBlockFromDom(input);
            return;
        }
        const toGap = value => {
            const number = Number(value);
            return Number.isFinite(number) ? Math.max(0, Math.min(240, Math.round(number))) : 0;
        };
        let nextStart = currentEnd + toGap(input.value);
        for (let index = rowIndex + 1; index < rows.length; index += 1) {
            const row = rows[index];
            const startInput = row.querySelector('[data-period-time-draft-start], [data-period-time-start], [data-period-time-block-start]');
            const endInput = row.querySelector('[data-period-time-draft-end], [data-period-time-end], [data-period-time-block-end]');
            const existingStart = this.timeToMinutes(startInput?.value);
            const existingEnd = this.timeToMinutes(endInput?.value);
            const duration = existingStart !== null && existingEnd !== null && existingEnd > existingStart
                ? existingEnd - existingStart
                : 45;
            if (startInput) startInput.value = this.minutesToTime(nextStart);
            if (endInput) endInput.value = this.minutesToTime(nextStart + duration);
            const gapInput = row.querySelector('[data-period-time-gap-after], [data-period-time-block-gap-after]');
            nextStart += duration + (gapInput ? toGap(gapInput.value) : 0);
        }
        const config = this.readSegmentConfigFromDom({ includePeriodTimeBlockInputs: true });
        const normalized = this.normalizeSegmentConfig(config, []);
        const draftTimes = this.normalizePeriodTimeDraft(this.collectPeriodTimesFromDom() || [], this.getFormalPeriodsForSegmentConfig(normalized));
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: normalized,
            draftTimes,
            errors: [],
            cleared: false,
        };
        this.syncPeriodTimeBlockSegmentFieldsToDom(normalized);
        this.refreshPeriodTimeGapInputsFromDom();
    }

    updatePeriodTimeGapFromDom(input) {
        if (!input || !this.state.container) return;
        const rows = [...this.state.container.querySelectorAll('[data-period-time-row]')];
        const period = Number(input.dataset.periodTimeGapAfter);
        const rowIndex = rows.findIndex(row => Number(row.dataset.periodTimeRow) === period);
        if (rowIndex < 0 || rowIndex >= rows.length - 1) return;
        const currentEnd = this.timeToMinutes(rows[rowIndex].querySelector('[data-period-time-draft-end], [data-period-time-end]')?.value);
        if (currentEnd === null) {
            this.readPeriodTimesFromDom();
            return;
        }
        if (String(input.value || '').trim() === '') {
            this.readPeriodTimesFromDom();
            return;
        }
        const settings = this.readPeriodTimeSettingsFromDom() || this.state.periodTimeDialog?.settings || this.getDefaultPeriodTimeSettings();
        const toGap = value => {
            const number = Number(value);
            if (!Number.isFinite(number)) return settings.breakMinutes;
            return Math.max(0, Math.min(240, Math.round(number)));
        };
        let nextStart = currentEnd + toGap(input.value);
        for (let index = rowIndex + 1; index < rows.length; index += 1) {
            const row = rows[index];
            const startInput = row.querySelector('[data-period-time-draft-start], [data-period-time-start]');
            const endInput = row.querySelector('[data-period-time-draft-end], [data-period-time-end]');
            const existingStart = this.timeToMinutes(startInput?.value);
            const existingEnd = this.timeToMinutes(endInput?.value);
            const duration = existingStart !== null && existingEnd !== null && existingEnd > existingStart
                ? existingEnd - existingStart
                : settings.classMinutes;
            if (startInput) startInput.value = this.minutesToTime(nextStart);
            if (endInput) endInput.value = this.minutesToTime(nextStart + duration);
            const gapInput = row.querySelector('[data-period-time-gap-after]');
            nextStart += duration + (gapInput ? toGap(gapInput.value) : 0);
        }
        this.readPeriodTimesFromDom();
        this.refreshPeriodTimeGapInputsFromDom();
    }

    readPeriodTimesFromDom() {
        const times = this.collectPeriodTimesFromDom();
        if (!times) return;
        const segmentConfig = this.state.periodTimeDialog?.segmentConfig;
        const activePeriods = segmentConfig
            ? this.getFormalPeriodsForSegmentConfig(segmentConfig)
            : getActivePeriods(this.state.project);
        const draftTimes = this.normalizePeriodTimeDraft(times, activePeriods);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            draftTimes,
            errors: [],
            cleared: draftTimes.length === 0,
        };
        return draftTimes;
    }

    validatePeriodTimes(times = [], periods = null) {
        const activePeriods = [...(periods || getActivePeriods(this.state.project))]
            .map(period => Number(period))
            .filter(period => Number.isInteger(period))
            .sort((left, right) => left - right);
        const activeSet = new Set(activePeriods);
        const rows = activePeriods.map(period => {
            const item = (Array.isArray(times) ? times : []).find(row => Number(row.period) === Number(period)) || {};
            return {
                period,
                start: item.start || '',
                end: item.end || '',
                startMinutes: this.timeToMinutes(item.start),
                endMinutes: this.timeToMinutes(item.end),
            };
        }).filter(row => activeSet.has(row.period));
        const anyFilled = rows.some(row => row.start || row.end);
        if (!anyFilled) return [];
        const errors = [];
        rows.forEach(row => {
            if (!row.start || !row.end) {
                errors.push({ period: row.period, message: '请补齐开始和结束时间' });
            } else if (row.startMinutes === null || row.endMinutes === null) {
                errors.push({ period: row.period, message: '时间格式无效' });
            } else if (row.endMinutes <= row.startMinutes) {
                errors.push({ period: row.period, message: '结束时间必须晚于开始时间' });
            }
        });
        rows.forEach((row, index) => {
            const next = rows[index + 1];
            if (!next || row.endMinutes === null || next.startMinutes === null) return;
            if (next.startMinutes < row.endMinutes) {
                errors.push({ period: next.period, message: '后一节不能早于前一节结束' });
            }
        });
        return errors;
    }

    async savePeriodTimes() {
        const rawTimes = this.collectPeriodTimesFromDom() || this.state.periodTimeDialog?.draftTimes || [];
        const segmentConfig = this.readSegmentConfigFromDom({ includePeriodTimeBlockInputs: true })
            || this.state.periodTimeDialog?.segmentConfig
            || this.getDefaultSegmentConfig(getActivePeriods(this.state.project));
        const inputActivePeriods = this.getFormalPeriodsForSegmentConfig(segmentConfig);
        const normalizedSegmentConfig = this.normalizeSegmentConfig(segmentConfig, inputActivePeriods);
        const activePeriods = this.getFormalPeriodsForSegmentConfig(normalizedSegmentConfig);
        const errors = this.validatePeriodTimes(rawTimes, activePeriods);
        if (errors.length) {
            this.state.periodTimeDialog = {
                ...(this.state.periodTimeDialog || {}),
                open: true,
                segmentConfig: normalizedSegmentConfig,
                errors,
                draftTimes: this.normalizePeriodTimeDraft(rawTimes, activePeriods),
            };
            this.state.message = errors[0].message || '请修正节次时间后再保存。';
            this.render();
            return;
        }
        const draftTimes = this.normalizePeriodTimeDraft(rawTimes, activePeriods);
        this.state.periodTimeDialog = {
            ...(this.state.periodTimeDialog || {}),
            open: true,
            segmentConfig: normalizedSegmentConfig,
            saving: true,
            errors: [],
            cleared: draftTimes.length === 0,
            draftTimes,
        };
        this.render();
        try {
            const teachingSegments = normalizedSegmentConfig.segments.filter(segment => segment.kind === 'teaching');
            let periodOffset = 0;
            let afternoonBoundary = null;
            let eveningBoundary = null;
            for (const segment of teachingSegments) {
                const label = String(segment.label || '');
                if (afternoonBoundary === null && /下午/.test(label)) {
                    afternoonBoundary = activePeriods[periodOffset] || null;
                }
                if (eveningBoundary === null && /晚自习|晚修|晚间|晚/.test(label)) {
                    eveningBoundary = activePeriods[periodOffset] || null;
                }
                periodOffset += Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
            }
            if (afternoonBoundary === null && teachingSegments.length >= 2) {
                afternoonBoundary = activePeriods[teachingSegments[0].periodCount] || null;
            }
            if (eveningBoundary === null && teachingSegments.length >= 3) {
                eveningBoundary = activePeriods[teachingSegments.slice(0, 2).reduce((sum, seg) => sum + seg.periodCount, 0)] || null;
            }
            const dutyMigration = this.migrateDutyAssignmentsForSplitTimeBlocks(
                this.state.project?.dutyAssignments || [],
                this.state.project?.periodTimeSegments,
                normalizedSegmentConfig,
            );
            const payload = {
                periodTimes: draftTimes,
                periodTimeSegments: normalizedSegmentConfig,
                dayPartBoundaries: {
                    afternoonStartPeriod: afternoonBoundary,
                    eveningStartPeriod: eveningBoundary,
                },
            };
            if (dutyMigration.changed) {
                payload.dutyAssignments = dutyMigration.assignments;
            }
            const result = await requestTimetable('/project', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            this.applyProject(result.project);
            this.state.lastFailure = null;
            this.state.periodTimeDialog = {
                ...(this.state.periodTimeDialog || {}),
                open: false,
                saving: false,
                errors: [],
                cleared: draftTimes.length === 0,
                draftTimes: this.state.project?.periodTimes || draftTimes,
                segmentConfig: this.state.project?.periodTimeSegments || normalizedSegmentConfig,
            };
            this.setMessage('节次时间已保存。');
        } catch (error) {
            this.state.periodTimeDialog = {
                ...(this.state.periodTimeDialog || {}),
                open: true,
                segmentConfig,
                saving: false,
                cleared: draftTimes.length === 0,
                draftTimes,
            };
            this.handleError(error);
        }
    }

    updateBulkRuleDraftFromForm() {
        if (!this.state.container) return;
        const form = readBulkRuleForm(this.state.container);
        this.state.bulkRuleDraft = {
            ...(this.state.bulkRuleDraft || {}),
            days: form.days,
            periods: form.periods,
        };
    }

    setCheckedValues(selector, values) {
        const selected = new Set(values.map(Number));
        this.state.container?.querySelectorAll(selector).forEach(input => {
            input.checked = selected.has(Number(input.value));
        });
    }

    applyRangePreset(kind, preset) {
        const values = kind === 'weekdays'
            ? preset === 'workdays'
                ? [1, 2, 3, 4, 5]
                : preset === 'all'
                    ? [1, 2, 3, 4, 5, 6, 7]
                    : getActiveWeekdays(this.state.project)
            : preset === 'first7'
                ? [1, 2, 3, 4, 5, 6, 7]
                : preset === 'all'
                    ? Array.from({ length: 12 }, (_, index) => index + 1)
                    : getActivePeriods(this.state.project);
        this.setCheckedValues(kind === 'weekdays' ? '[data-active-weekday]' : '[data-active-period]', values);
        this.updateRangeDraftFromForm();
    }

    applyBulkPreset(kind, preset) {
        const activeValues = kind === 'days' ? getActiveWeekdays(this.state.project) : getActivePeriods(this.state.project);
        const values = preset === 'clear'
            ? []
            : kind === 'days'
                ? preset === 'workdays'
                    ? activeValues.filter(value => value <= 5)
                    : activeValues
                : preset === 'first7'
                    ? activeValues.filter(value => value <= 7)
                    : activeValues;
        this.setCheckedValues(kind === 'days' ? '[data-bulk-day]' : '[data-bulk-period]', values);
        this.updateBulkRuleDraftFromForm();
    }

    clearOptimizationPolling() {
        if (this.jobPollTimer) {
            clearTimeout(this.jobPollTimer);
            this.jobPollTimer = null;
        }
    }

    clearRuleDraft() {
        this.state.pendingRules = [];
        this.state.expandedRuleId = null;
        this.state.ruleDraft = null;
        this.state.ruleDraftPreview = [];
        this.state.ruleWarnings = [];
        this.state.ruleDraftInputType = '';
        this.state.ruleContextStats = null;
        this.state.ruleUnsupportedItems = [];
        this.state.ruleFileName = '';
        this.resetRuleReview();
    }

    syncPendingRuleDraftState(nextRows = [], options = {}) {
        const rows = Array.isArray(nextRows) ? [...nextRows] : [];
        const current = this.state.ruleReview || createTimetablePlannerState().ruleReview;
        const rowIds = new Set(rows.map(item => item?.id).filter(Boolean));
        const existingUnsupported = [
            ...(current.unsupportedItems || []),
            ...(this.state.ruleUnsupportedItems || []),
        ];
        const unsupportedById = new Map(
            existingUnsupported
                .filter(item => item?.id && rowIds.has(item.id))
                .map(item => [item.id, item]),
        );
        const syncedUnsupportedItems = rows
            .filter(item => ['suggestion', 'unsupported'].includes(item?.status))
            .map(item => unsupportedById.get(item.id) || {
                id: item.id,
                type: item.type || '',
                targetId: item.targetId || '',
                targetName: item.targetName || '',
                slots: Array.isArray(item.slots) ? item.slots : [],
                priority: item.priority || 'soft',
                description: item.description || item.rawText || '',
                status: item.status,
                effective: false,
                confidence: item.confidence ?? null,
            });
        this.state.pendingRules = rows;
        this.state.expandedRuleId = rows.some(item => item.id === this.state.expandedRuleId)
            ? this.state.expandedRuleId
            : null;
        this.state.ruleDraft = null;

        if (rows.length) {
            this.setRuleReviewState({
                draftRows: rows,
                inputType: current.inputType || this.state.ruleDraftInputType || 'review',
                contextStats: current.contextStats || this.state.ruleContextStats || null,
                warnings: current.warnings || this.state.ruleWarnings || [],
                unsupportedItems: syncedUnsupportedItems,
                previewItems: rows,
            });
            return;
        }

        this.clearRuleDraft();
        if (options.keepDialogOpen) {
            this.state.ruleReview = {
                ...createTimetablePlannerState().ruleReview,
                open: true,
                step: getSavedRuleItems(this.state.project).length ? 'saved' : 'input',
                mode: current.mode || 'file',
            };
        }
    }

    selectRuleParseFile(file) {
        this.selectRuleReviewFile(file);
    }

    resetRuleReview() {
        this.ruleReviewFile = null;
        this.state.ruleReview = createTimetablePlannerState().ruleReview;
    }

    smartDataAudit() {
        return buildSmartDataAudit(this.state.project || {});
    }

    openSmartWorkbench(mode = 'text') {
        this.openConstraintDialog(mode);
        this.scrollSmartWorkbenchToTop();
    }

    closeSmartWorkbench() {
        this.state.smartWorkbench = {
            ...createSmartWorkbenchState(),
            ...(this.state.smartWorkbench || {}),
            open: false,
            busy: false,
        };
        if (this.state.constraintChat) {
            this.state.constraintChat = {
                ...this.state.constraintChat,
                open: false,
                loading: false,
            };
        }
        this.render();
    }

    recheckSmartWorkbenchData() {
        this.state.smartWorkbench = transitionSmartWorkbench(
            this.state.smartWorkbench,
            'checking_data',
            { dataAudit: null },
        );
        this.renderSmartWorkbenchSurface();
        const finish = () => {
            const dataAudit = this.smartDataAudit();
            this.state.smartWorkbench = {
                ...this.state.smartWorkbench,
                dataAudit,
                previousStage: 'checking_data',
                stage: dataAudit.canContinue ? 'ready_for_constraints' : 'data_need_fix',
                busy: false,
                error: '',
            };
            this.renderSmartWorkbenchSurface();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(finish);
        } else {
            setTimeout(finish, 0);
        }
    }

    continueSmartWorkbenchToInput() {
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            stage: 'ready_for_constraints',
            busy: false,
            error: '',
        };
        this.renderSmartWorkbenchSurface();
    }

    setSmartWorkbenchSection(section = 'ready') {
        if (!['ready', 'review', 'conflict', 'unsupported', 'saved'].includes(section)) return;
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            selectedSection: section,
            currentPage: 1,
        };
        this.renderSmartWorkbenchSurface();
    }

    setSmartWorkbenchPage(page = 1) {
        const currentPage = Math.max(1, parseInt(page, 10) || 1);
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            currentPage,
        };
        this.renderSmartWorkbenchSurface();
        const listEl = this.state.container?.querySelector('.tt-smart-rule-list');
        if (listEl) {
            listEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    navigateSmartWorkbenchStep(step = '') {
        const target = {
            data: 'checking_data',
            input: 'ready_for_constraints',
            review: 'reviewing_constraints',
            plan: 'waiting_solve_approval',
            solve: 'solution_review',
            finish: this.state.smartWorkbench?.diagnosis ? 'diagnosing' : 'finished',
        }[step];
        if (!target) return;
        const currentIndex = [
            'idle',
            'checking_data',
            'data_need_fix',
            'ready_for_constraints',
            'parsing_constraints',
            'reviewing_constraints',
            'waiting_user_confirmation',
            'building_solve_plan',
            'waiting_solve_approval',
            'solving',
            'solution_review',
            'diagnosing',
            'finished',
            'failed',
        ].indexOf(this.state.smartWorkbench?.stage || 'idle');
        const targetIndex = [
            'checking_data',
            'ready_for_constraints',
            'reviewing_constraints',
            'waiting_solve_approval',
            'solution_review',
            'finished',
        ].indexOf(target);
        if (targetIndex > currentIndex && !['data', 'input'].includes(step)) return;
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            stage: target,
            busy: target === 'checking_data',
            error: '',
        };
        if (target === 'checking_data') {
            this.recheckSmartWorkbenchData();
        } else {
            this.renderSmartWorkbenchSurface();
        }
    }

    setSmartWorkbenchMode(mode = 'text') {
        const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'text';
        this.state.ruleReview = {
            ...(this.state.ruleReview || createTimetablePlannerState().ruleReview),
            mode: nextMode,
            text: this.readRuleReviewText(),
        };
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            sourceMode: nextMode,
            stage: 'ready_for_constraints',
        };
        this.renderSmartWorkbenchSurface();
    }

    openRuleReview(mode = 'file') {
        // 改为打开新的弹窗，而不是全屏工作台
        this.openConstraintDialog(mode);
    }

    startRuleReviewInput(mode = 'file') {
        const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'file';
        const current = this.state.ruleReview || {};
        this.state.ruleReview = {
            ...current,
            open: false,
            step: nextMode === 'manual' ? 'manual' : 'input',
            uiStep: 'input',
            mode: nextMode,
            text: this.readRuleReviewText(),
        };
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            open: true,
            sourceMode: nextMode,
            stage: 'ready_for_constraints',
            ruleChangePreview: null,
        };
        this.render();
        this.scrollSmartWorkbenchToTop();
    }

    closeRuleReview() {
        if (this.state.smartWorkbench?.open) {
            this.closeSmartWorkbench();
            return;
        }
        this.state.ruleReview = {
            ...(this.state.ruleReview || createTimetablePlannerState().ruleReview),
            open: false,
        };
        this.renderRuleReviewSurface();
    }

    setRuleReviewProgress(phase, phaseText, { tone = '', step = null, mode = null } = {}) {
        this.state.ruleReview = {
            ...createTimetablePlannerState().ruleReview,
            ...(this.state.ruleReview || {}),
            open: !this.state.smartWorkbench?.open,
            step: step || this.state.ruleReview?.step || 'input',
            uiStep: 'understanding',
            mode: mode || this.state.ruleReview?.mode || 'file',
            loading: true,
            phase,
            phaseText,
            phaseTone: tone,
            text: this.state.ruleReview?.text ?? this.readRuleReviewText(),
        };
        if (this.state.smartWorkbench?.open) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: phase === 'save' || phase === 'save_auto'
                    ? 'waiting_user_confirmation'
                    : 'parsing_constraints',
                busy: true,
                error: '',
            };
        }
        this.renderRuleReviewSurface();
    }

    stopRuleReviewProgress(phaseText = '', tone = '') {
        this.state.ruleReview = {
            ...createTimetablePlannerState().ruleReview,
            ...(this.state.ruleReview || {}),
            loading: false,
            phase: tone ? 'error' : '',
            phaseText,
            phaseTone: tone,
            uiStep: this.state.ruleReview?.draftRows?.length ? 'issues' : 'input',
        };
        if (this.state.smartWorkbench?.open) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: tone
                    ? 'ready_for_constraints'
                    : deriveSmartWorkbenchStage(this.state),
                busy: false,
                error: tone ? phaseText : '',
            };
        }
        this.renderRuleReviewSurface();
    }

    async waitForRuleReviewFrame() {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
        await new Promise(resolve => window.requestAnimationFrame(resolve));
    }

    setRuleReviewMode(mode) {
        if (this.state.smartWorkbench?.open) {
            this.setSmartWorkbenchMode(mode);
            return;
        }
        const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'text';
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            open: true,
            step: nextMode === 'manual' ? 'manual' : 'input',
            uiStep: 'input',
            mode: nextMode,
            text: this.readRuleReviewText(),
        };
        this.renderRuleReviewSurface();
    }

    selectRuleReviewFile(file) {
        this.ruleReviewFile = file || null;
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            open: !this.state.smartWorkbench?.open,
            step: 'input',
            uiStep: 'input',
            mode: 'file',
            fileName: file?.name || '',
            text: this.readRuleReviewText(),
        };
        this.state.ruleFileName = file?.name || '';
        this.renderRuleReviewSurface();
    }

    readRuleReviewText() {
        return this.state.container?.querySelector('#tt-rule-review-text')?.value ?? this.state.ruleReview?.text ?? '';
    }

    fillRuleExample(example = '') {
        if (!example) return;
        const current = this.readRuleReviewText().trim();
        const next = current ? `${current}\n${example}` : example;
        this.state.ruleInput = { ...(this.state.ruleInput || {}), text: next };
        this.state.ruleReview = {
            ...(this.state.ruleReview || createTimetablePlannerState().ruleReview),
            open: true,
            step: 'input',
            uiStep: 'input',
            mode: 'text',
            text: next,
        };
        this.renderRuleReviewSurface();
    }

    getRuleInputText() {
        return this.state.container?.querySelector('#tt-rule-input-text')?.value ?? this.state.ruleInput?.text ?? '';
    }

    // ── 新卡片式智能约束交互 ──

    async parseRulesInline() {
        const text = this.getRuleInputText().trim();
        if (!text && !this.ruleReviewFile) {
            this.setMessage('请输入约束描述或上传文件。');
            return;
        }
        this.state.ruleInput = { ...(this.state.ruleInput || {}), loading: true };
        this.render();
        try {
            let options;
            if (this.ruleReviewFile) {
                const body = new FormData();
                body.append('file', this.ruleReviewFile);
                if (text) body.append('text', text);
                options = { method: 'POST', body };
            } else {
                options = { method: 'POST', body: JSON.stringify({ text }) };
            }
            const result = await requestTimetable('/rules/parse', options);
            const rows = result.draftRows || [];
            this.state.pendingRules = rows;
            this.state.ruleInput = { text: '', fileName: '', loading: false };
            this.ruleReviewFile = null;
            // legacy sync
            this.setRuleReviewState(result);
            const autoCount = (result.autoAcceptable || []).length;
            const reviewCount = (result.needReview || []).length;
            const questionCount = (result.clarifyingQuestions || []).length;
            const message = {
                ask_user: '需要补充信息后才能继续。',
                ready_to_apply: `已找到 ${autoCount} 条高置信度约束，可一键生效。`,
                review: `已解析 ${rows.length} 条约束，其中 ${reviewCount} 条需要你确认。`,
                no_result: '未解析出可用约束，请换一种说法。',
            }[result.nextAction] || (rows.length ? `已解析 ${rows.length} 条约束，请在复核表确认。` : '未能解析出可用约束，请调整描述后重试。');
            this.setMessage(questionCount ? `${message} 有 ${questionCount} 个问题需要确认。` : message);
        } catch (error) {
            this.state.ruleInput = { ...(this.state.ruleInput || {}), loading: false };
            this.handleError(error);
        }
    }

    selectRuleInputFile(file) {
        this.ruleReviewFile = file || null;
        this.state.ruleInput = {
            ...(this.state.ruleInput || {}),
            fileName: file?.name || '',
        };
        this.render();
    }

    expandRuleCard(ruleId) {
        this.state.expandedRuleId = this.state.expandedRuleId === ruleId ? null : ruleId;
        this.render();
    }

    collapseRuleCard() {
        this.state.expandedRuleId = null;
        this.render();
    }

    async acceptRule(ruleId) {
        const pending = this.state.pendingRules || [];
        const rule = pending.find(item => item.id === ruleId);
        if (!rule) return;
        if (['unsupported', 'invalid', 'suggestion', 'ignored'].includes(rule.status)) {
            this.setMessage('该约束不能直接生效，请作为建议查看或重新解析。');
            return;
        }
        if (this.blockingConflictRuleIds().has(ruleId)) {
            this.setMessage('该约束存在阻塞冲突，请先处理冲突后再应用。');
            return;
        }
        try {
            const normalized = await requestTimetable('/rules/normalize', {
                method: 'POST',
                body: JSON.stringify({ draftRows: [rule] }),
            });
            const effectiveRows = (normalized.draftRows || []).filter(row => row.status === 'effective');
            if (!effectiveRows.length) {
                this.setMessage('该条规则无法生效，请展开编辑后重试。');
                return;
            }
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: normalized.draftRules }),
            });
            this.applyProject(result.project);
            this.syncPendingRuleDraftState(
                pending.filter(item => item.id !== ruleId),
                { keepDialogOpen: Boolean(this.state.ruleReview?.open) },
            );
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.setMessage('约束已生效。');
        } catch (error) {
            this.handleError(error);
        }
    }

    rejectRule(ruleId) {
        this.syncPendingRuleDraftState(
            (this.state.pendingRules || []).filter(item => item.id !== ruleId),
            { keepDialogOpen: Boolean(this.state.ruleReview?.open) },
        );
        this.render();
    }

    blockingConflictRuleIds() {
        return new Set(
            (this.state.ruleReview?.conflicts || [])
                .filter(item => item.level === 'blocking')
                .flatMap(item => item.relatedRuleIds || []),
        );
    }

    isSafeAutoAcceptableRule(rule = {}) {
        const supportedTypes = new Set([
            'teacher_unavailable',
            'class_unavailable',
            'locked_slot',
            'subject_morning',
            'subject_preferred_periods',
            'subject_avoid_periods',
            'teacher_daily_limit',
            'teacher_consecutive_limit',
            'subject_spread',
        ]);
        return rule.status === 'effective'
            && supportedTypes.has(rule.type)
            && Number(rule.confidence || 0) >= 0.85
            && !(rule.warnings || []).length
            && !rule.ambiguity
            && !(rule.ambiguities || []).length;
    }

    isAutoAcceptablePendingRule(rule = {}) {
        return this.isSafeAutoAcceptableRule(rule);
    }

    async acceptAllRules() {
        const blockingRuleIds = this.blockingConflictRuleIds();
        const sourceRows = (this.state.ruleReview?.autoAcceptable || []).length
            ? this.state.ruleReview.autoAcceptable
            : (this.state.pendingRules || []);
        const pending = sourceRows
            .filter(item => this.isAutoAcceptablePendingRule(item))
            .filter(item => !blockingRuleIds.has(item.id));
        if (!pending.length) {
            this.setMessage('没有可一键应用的高置信度约束；存在歧义、冲突或需要你确认的规则请先处理。');
            return;
        }
        try {
            const normalized = await requestTimetable('/rules/normalize', {
                method: 'POST',
                body: JSON.stringify({ draftRows: pending }),
            });
            const effectiveRows = (normalized.draftRows || []).filter(row => row.status === 'effective');
            const effectiveCount = effectiveRows.length;
            if (!effectiveCount) {
                this.setMessage('这些约束都无法自动生效，请逐条编辑。');
                return;
            }
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: normalized.draftRules }),
            });
            this.applyProject(result.project);
            const acceptedIds = new Set(effectiveRows.map(item => item.id));
            this.syncPendingRuleDraftState(
                (this.state.pendingRules || []).filter(item => !acceptedIds.has(item.id)),
                { keepDialogOpen: Boolean(this.state.ruleReview?.open) },
            );
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.setMessage(`已接受 ${effectiveCount} 条约束。`);
        } catch (error) {
            this.handleError(error);
        }
    }

    rejectAllRules() {
        this.syncPendingRuleDraftState([], { keepDialogOpen: Boolean(this.state.ruleReview?.open) });
        this.render();
    }

    addManualRule() {
        const rule = this.emptyRuleDraftRow();
        this.state.pendingRules = [rule, ...(this.state.pendingRules || [])];
        this.state.expandedRuleId = rule.id;
        this.render();
    }

    async refreshProject() {
        try {
            const result = await requestTimetable('/bootstrap');
            this.applyProject(result.project);
        } catch { /* silent */ }
    }


    setRuleReviewState(payload = {}) {
        const draftRows = Array.isArray(payload.draftRows) ? payload.draftRows : [];
        const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
        const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
        const hasBlockingIssues = draftRows.some(row => ['invalid'].includes(row.status)) || conflicts.some(item => item.level === 'blocking');
        const nextReview = {
            ...(this.state.ruleReview || {}),
            open: !this.state.smartWorkbench?.open,
            step: 'review',
            uiStep: payload.uiStep
                || (draftRows.length ? 'issues' : (this.state.ruleReview?.uiStep || 'input')),
            mode: this.state.ruleReview?.mode || 'text',
            fileName: this.state.ruleReview?.fileName || this.state.ruleFileName || '',
            text: this.readRuleReviewText(),
            originalText: payload.originalText
                || this.state.ruleReview?.originalText
                || this.readRuleReviewText()
                || this.getRuleInputText?.()
                || '',
            answers: payload.answers || this.state.ruleReview?.answers || [],
            previousResult: payload.previousResult || null,
            draftRows,
            inputType: payload.inputType || this.state.ruleReview?.inputType || '',
            contextStats: payload.contextStats || null,
            warnings,
            unsupportedItems: payload.unsupportedItems || [],
            autoAcceptable: payload.autoAcceptable || [],
            needReview: payload.needReview || [],
            clarifyingQuestions: payload.clarifyingQuestions || [],
            missingInfo: payload.missingInfo || [],
            conflicts,
            ruleReport: payload.ruleReport || null,
            confidenceSummary: payload.confidenceSummary || { high: 0, medium: 0, low: 0 },
            nextAction: payload.nextAction || '',
            diagnosis: payload.diagnosis || this.state.ruleReview?.diagnosis || null,
            hasBlockingIssues,
            advancedOpen: Boolean(payload.advancedOpen ?? this.state.ruleReview?.advancedOpen),
            selectedSection: payload.selectedSection || this.state.ruleReview?.selectedSection || '',
            selectedRuleId: payload.selectedRuleId || this.state.ruleReview?.selectedRuleId || '',
            loading: false,
            phase: '',
            phaseText: '',
            phaseTone: '',
        };
        const taskList = buildRuleReviewTasks(nextReview);
        this.state.ruleReview = {
            ...nextReview,
            taskList,
            activeTaskId: payload.activeTaskId
                || nextReview.activeTaskId
                || taskList[0]?.id
                || '',
        };
        this.state.ruleDraft = payload.draftRules || this.state.ruleDraft;
        this.state.ruleDraftPreview = payload.previewItems || draftRows;
        this.state.ruleWarnings = warnings;
        this.state.ruleDraftInputType = payload.inputType || '';
        this.state.ruleContextStats = payload.contextStats || null;
        this.state.ruleUnsupportedItems = payload.unsupportedItems || [];
        if (this.state.smartWorkbench?.open) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: deriveSmartWorkbenchStage({
                    ...this.state,
                    ruleReview: this.state.ruleReview,
                }),
                busy: false,
                error: '',
                ruleChangePreview: null,
            };
        }
    }

    nextRuleDraftId() {
        this.ruleDraftCounter += 1;
        return `rule_${Date.now()}_${this.ruleDraftCounter}`;
    }

    emptyRuleDraftRow() {
        return {
            id: this.nextRuleDraftId(),
            rawText: '',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: '',
            targetName: '',
            slots: [],
            priority: 'hard',
            status: 'needs_review',
            confidence: null,
            description: '',
            warnings: [],
        };
    }

    readRuleReviewRows() {
        return [...(this.state.container?.querySelectorAll('[data-rule-review-row]') || [])].map(row => {
            const value = field => row.querySelector(`[data-rule-review-field="${field}"]`)?.value?.trim() || '';
            const slots = value('slots').split(/[,，;；、\s]+/).map(item => item.trim()).filter(Boolean);
            // When the target is a bound dropdown, sync targetId from the selected option
            // so the saved id always matches the displayed name.
            const targetSelect = row.querySelector('[data-rule-target-select]');
            let targetId = value('targetId');
            if (targetSelect) {
                const option = targetSelect.options[targetSelect.selectedIndex];
                targetId = option?.dataset?.targetId || '';
            }
            return {
                id: row.dataset.ruleReviewRow || this.nextRuleDraftId(),
                rawText: value('rawText'),
                type: value('type') || 'teacher_unavailable',
                targetType: value('targetType'),
                targetId,
                targetName: value('targetName'),
                classId: value('classId'),
                className: value('className'),
                subjectId: value('subjectId'),
                subjectName: value('subjectName'),
                teacherId: value('teacherId'),
                teacherName: value('teacherName'),
                slots,
                priority: value('priority') || 'hard',
                status: value('status') || 'needs_review',
                description: value('description'),
            };
        });
    }

    refreshRuleReviewFromRows(rows = []) {
        this.setRuleReviewState({
            draftRows: rows,
            inputType: this.state.ruleReview?.inputType || 'manual',
            contextStats: this.state.ruleReview?.contextStats || null,
            warnings: this.state.ruleReview?.warnings || [],
            unsupportedItems: this.state.ruleReview?.unsupportedItems || [],
            draftRules: this.state.ruleDraft,
            previewItems: rows,
        });
        this.renderRuleReviewSurface();
    }

    updateRuleReviewField() {
        this.refreshRuleReviewFromRows(this.readRuleReviewRows());
    }

    deleteRuleReviewRow(rowId) {
        this.refreshRuleReviewFromRows(this.readRuleReviewRows().filter(row => row.id !== rowId));
    }

    addRuleReviewRow() {
        this.refreshRuleReviewFromRows([...this.readRuleReviewRows(), this.emptyRuleDraftRow()]);
    }

    updateRuleReviewRowsFromCards(transform, extraState = {}) {
        const current = this.state.ruleReview || {};
        const rows = Array.isArray(current.draftRows) ? current.draftRows : [];
        const nextRows = rows.map(row => ({ ...row }));
        const transformed = typeof transform === 'function' ? transform(nextRows) : nextRows;
        const finalRows = Array.isArray(transformed) ? transformed : nextRows;
        this.setRuleReviewState({
            ...current,
            draftRows: finalRows,
            inputType: current.inputType || 'review',
            contextStats: current.contextStats || null,
            warnings: current.warnings || [],
            autoAcceptable: finalRows.filter(row => row.status === 'effective'),
            needReview: finalRows.filter(row => ['needs_review', 'invalid'].includes(row.status)),
            unsupportedItems: [
                ...(current.unsupportedItems || []).filter(item => finalRows.some(row => row.id === item.id)),
                ...finalRows.filter(row => ['suggestion', 'unsupported'].includes(row.status)),
            ],
            draftRules: this.state.ruleDraft,
            previewItems: finalRows,
            ...extraState,
        });
        this.renderRuleReviewSurface();
    }

    editRuleReviewRow(rowId) {
        this.state.ruleReview = {
            ...(this.state.ruleReview || createTimetablePlannerState().ruleReview),
            advancedOpen: true,
            selectedRuleId: rowId || '',
        };
        this.renderRuleReviewSurface();
    }

    toggleRuleReviewAdvanced() {
        this.state.ruleReview = {
            ...(this.state.ruleReview || createTimetablePlannerState().ruleReview),
            advancedOpen: !this.state.ruleReview?.advancedOpen,
        };
        this.renderRuleReviewSurface();
    }

    ignoreRuleReviewRow(rowId) {
        this.updateRuleReviewRowsFromCards(rows => rows.map(row => (
            row.id === rowId ? { ...row, status: 'ignored' } : row
        )));
    }

    markRuleReviewRowEffective(rowId) {
        this.updateRuleReviewRowsFromCards(rows => rows.map(row => (
            row.id === rowId
                ? {
                    ...row,
                    status: 'effective',
                    priority: row.priority || 'hard',
                    warnings: (row.warnings || []).filter(warning => !/需要人工确认|请人工复核/.test(warning)),
                }
                : row
        )));
    }

    deleteRuleReviewCard(rowId) {
        this.updateRuleReviewRowsFromCards(rows => rows.filter(row => row.id !== rowId));
    }

    addManualRuleRows() {
        try {
            const form = readManualRuleBuilderForm(this.state.container);
            if (form.type === 'locked_slot') {
                if (!form.targetGroups?.class?.length || !form.targetGroups?.subject?.length || !form.targetGroups?.teacher?.length) {
                    throw new Error('请为锁定课节选择班级、课程和教师。');
                }
            } else if (!form.targets.length) {
                throw new Error('请先选择规则对象。');
            }
            if (form.type !== 'subject_morning' && (!form.days.length || !form.periods.length)) {
                throw new Error('请先选择周几和节次。');
            }
            this.setRuleReviewProgress('manual_rows', '生成复核行中...', { step: 'manual', mode: 'manual' });
            const rows = buildManualRuleDraftRows(form);
            this.setRuleReviewState({
                draftRows: [...(this.state.ruleReview?.draftRows || []), ...rows],
                inputType: 'manual',
                source: 'manual',
            });
            this.setMessage('手动规则已加入复核表。');
        } catch (error) {
            if (this.state.ruleReview?.loading) {
                this.stopRuleReviewProgress('生成复核行失败，请检查选择。', 'warning');
            }
            this.handleError(error);
        }
    }

    readRosterImportText() {
        return this.state.container?.querySelector('#tt-roster-import-text')?.value ?? this.state.rosterImport?.text ?? '';
    }

    resetRosterImport() {
        this.rosterImportFile = null;
        this.state.rosterImport = {
            open: false,
            step: 'input',
            mode: 'file',
            fileName: '',
            text: '',
            draftRows: [],
            allDraftRows: [],
            sheetReviews: [],
            parseSummary: null,
            source: null,
            stats: null,
            warnings: [],
            issues: [],
            importReport: null,
            hasBlockingIssues: false,
            issueListExpanded: false,
            issueEditor: null,
            loading: false,
            phaseText: '',
            phaseTone: '',
        };
    }

    openRosterImport(mode = 'file') {
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        const hasDraftRows = this.hasRecoverableRosterReviewDraft(current.draftRows)
            || this.hasRecoverableRosterReviewDraft(current.allDraftRows);
        const hasTextDraft = Boolean(String(current.text || '').trim());
        const hasFileDraft = Boolean(this.rosterImportFile);
        if (hasDraftRows) {
            this.state.rosterImport = {
                ...current,
                open: true,
                step: 'review',
                mode: current.mode === 'text' ? 'text' : 'file',
            };
        } else if (hasTextDraft || hasFileDraft) {
            const draftMode = hasFileDraft && current.mode !== 'text' ? 'file' : 'text';
            this.state.rosterImport = {
                ...createTimetablePlannerState().rosterImport,
                ...current,
                open: true,
                step: 'input',
                mode: draftMode,
                fileName: hasFileDraft ? current.fileName : '',
            };
        } else {
            this.rosterImportFile = null;
            this.state.rosterImport = {
                ...createTimetablePlannerState().rosterImport,
                open: true,
                mode: 'file',
            };
        }
        this.render();
    }

    closeRosterImport() {
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        this.state.rosterImport = {
            ...current,
            open: false,
            text: current.step === 'input' ? this.readRosterImportText() : current.text || '',
            issueEditor: null,
        };
        this.render();
    }

    setRosterImportMode(mode) {
        this.state.rosterImport = {
            ...(this.state.rosterImport || {}),
            open: true,
            step: 'input',
            mode: mode === 'text' ? 'text' : 'file',
            text: this.readRosterImportText(),
        };
        this.render();
    }

    selectRosterImportFile(file) {
        this.rosterImportFile = file || null;
        this.state.rosterImport = {
            ...(this.state.rosterImport || {}),
            open: true,
            step: 'input',
            mode: 'file',
            fileName: file?.name || '',
            text: this.readRosterImportText(),
        };
        this.render();
    }

    startOptimizationPolling(job) {
        this.clearOptimizationPolling();
        if (!job?.jobId || !['queued', 'running'].includes(job.status)) return;
        this.jobPollTimer = setTimeout(() => {
            this.refreshOptimizationJob(job.jobId);
        }, 1200);
    }

    isCurrentOptimizationJob(jobId) {
        return Boolean(jobId && this.state.solverJob?.jobId === jobId);
    }

    async refreshOptimizationJob(jobId) {
        if (!this.isCurrentOptimizationJob(jobId)) return;
        try {
            const result = await requestTimetable(`/schedule/jobs/${encodeURIComponent(jobId)}`);
            if (!this.isCurrentOptimizationJob(jobId) || result.job?.jobId !== jobId) return;
            this.state.solverJob = result.job;
            if (result.job.status === 'completed' && result.job.accepted) {
                const data = await requestTimetable('/bootstrap');
                if (!this.isCurrentOptimizationJob(jobId)) return;
                this.applyProject(data.project);
                this.state.message = 'Timefold 优化已应用。';
                this.state.lastFailure = null;
            } else if (result.job.status === 'completed') {
                this.state.message = '快速课表已保留。';
                this.state.lastFailure = null;
            } else if (result.job.status === 'failed') {
                this.state.message = 'Timefold 优化未完成，快速课表已保留。';
                this.state.lastFailure = null;
            } else if (result.job.status === 'skipped') {
                this.state.message = result.job.reason === 'stale_schedule'
                    ? '课表已变化，已丢弃旧优化结果。'
                    : '后台优化已跳过，当前课表已保留。';
                this.state.lastFailure = null;
            }
            this.render();
            this.startOptimizationPolling(result.job);
        } catch {
            if (this.isCurrentOptimizationJob(jobId)) {
                this.clearOptimizationPolling();
            }
        }
    }

    async load() {
        this.state.loading = true;
        this.render();
        try {
            const data = await requestTimetable('/bootstrap');
            this.applyProject(data.project);
            this.state.message = '';
            this.state.lastFailure = null;
        } catch (error) {
            const normalized = normalizeApiError(error);
            this.state.message = normalized.message || '加载失败';
            this.state.lastFailure = normalized;
        } finally {
            this.state.loading = false;
            this.render();
        }
    }

    async saveProject(payload = null) {
        try {
            const result = await requestTimetable('/project', {
                method: 'POST',
                body: JSON.stringify(payload || readProjectForm(this.state.container)),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.setMessage('项目已保存。');
        } catch (error) {
            this.handleError(error);
        }
    }

    fillSample() {
        this.state.rosterImport = {
            ...(this.state.rosterImport || {}),
            open: true,
            step: 'input',
            mode: 'text',
            text: sampleRosterText(),
        };
        this.render();
    }

    nextRosterDraftId() {
        this.rosterDraftCounter += 1;
        return `draft_${Date.now()}_${this.rosterDraftCounter}`;
    }

    emptyRosterDraftRow() {
        return {
            id: this.nextRosterDraftId(),
            grade: '',
            className: '',
            subjectName: '',
            subjectCategory: 'normal',
            subjectTags: '',
            teacherName: '',
            weeklyHours: '',
            blockPreference: 'single',
            roomName: '',
            activityTypes: '',
            requiredResourceTypes: '',
            manual: true,
            issues: [],
        };
    }

    rosterRowsFromProject() {
        const project = this.state.project || {};
        const classes = new Map((project.classes || []).map(item => [item.id, item]));
        const subjects = new Map((project.subjects || []).map(item => [item.id, item]));
        const teachers = new Map((project.teachers || []).map(item => [item.id, item]));
        return (project.lessonPlans || []).map(plan => {
            const classItem = classes.get(plan.classId) || {};
            const subject = subjects.get(plan.subjectId) || {};
            const teacherIds = Array.isArray(plan.teacherIds) && plan.teacherIds.length ? plan.teacherIds : [plan.teacherId].filter(Boolean);
            const roomNames = Array.isArray(plan.allowedRoomIds) && plan.allowedRoomIds.length ? plan.allowedRoomIds : [plan.roomId].filter(Boolean);
            return {
                id: plan.id || this.nextRosterDraftId(),
                grade: plan.grade || classItem.grade || '',
                className: plan.className || classItem.name || '',
                subjectName: plan.subjectName || subject.name || '',
                subjectCategory: subject.category || 'normal',
                subjectTags: Array.isArray(subject.tags) ? subject.tags.join('、') : '',
                teacherName: teacherIds.map(id => teachers.get(id)?.name || id).filter(Boolean).join('、'),
                weeklyHours: plan.weeklyHours || '',
                blockPreference: plan.blockPreference || 'single',
                roomName: roomNames.join('、'),
                activityTypes: Array.isArray(plan.activityTypes) ? plan.activityTypes.join('、') : '',
                requiredResourceTypes: Array.isArray(plan.requiredResourceTypes) ? plan.requiredResourceTypes.join('、') : '',
                issues: [],
            };
        });
    }

    normalizeRosterDraftRow(row = {}, index = 0) {
        return {
            id: row.id || this.nextRosterDraftId(),
            sourceSheetId: String(row.sourceSheetId ?? row.source?.sheetId ?? '').trim(),
            sourceRow: String(row.sourceRow ?? row.source?.row ?? '').trim(),
            sourceSheet: String(row.sourceSheet ?? row.source?.sheet ?? '').trim(),
            parseSource: row.parseSource === 'ai' ? 'ai' : 'local',
            grade: String(row.grade ?? '').trim(),
            className: String(row.className ?? '').trim(),
            subjectName: String(row.subjectName ?? '').trim(),
            subjectCategory: ['main', 'quality', 'lab', 'normal'].includes(row.subjectCategory) ? row.subjectCategory : 'normal',
            subjectTags: Array.isArray(row.subjectTags) ? row.subjectTags.join('、') : String(row.subjectTags ?? '').trim(),
            teacherName: String(row.teacherName ?? '').trim(),
            weeklyHours: String(row.weeklyHours ?? '').trim(),
            blockPreference: ['single', 'double', 'mixed'].includes(row.blockPreference) ? row.blockPreference : 'single',
            roomName: String(row.roomName ?? '').trim(),
            activityTypes: Array.isArray(row.activityTypes) ? row.activityTypes.join('、') : String(row.activityTypes ?? '').trim(),
            requiredResourceTypes: Array.isArray(row.requiredResourceTypes) ? row.requiredResourceTypes.join('、') : String(row.requiredResourceTypes ?? '').trim(),
            manual: Boolean(row.manual),
            issues: Array.isArray(row.issues) ? row.issues : [],
        };
    }

    rosterDraftRowHasCoreContent(row = {}) {
        return ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'roomName', 'subjectTags']
            .some(field => String(row[field] ?? '').trim());
    }

    hasRecoverableRosterReviewDraft(rows = []) {
        return (Array.isArray(rows) ? rows : []).some(row => {
            if (!row || typeof row !== 'object') return false;
            if (!row.manual) return true;
            return this.rosterDraftRowHasCoreContent(row);
        });
    }

    rosterDraftRowHasValue(row) {
        return Boolean(row.manual) || ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'roomName', 'subjectTags']
            .some(field => String(row[field] ?? '').trim());
    }

    analyzeRosterDraftRows(rows = []) {
        const draftRows = rows.map((row, index) => this.normalizeRosterDraftRow(row, index))
            .filter(row => this.rosterDraftRowHasValue(row));
        const issues = [];
        const warnings = [];
        const duplicateKeys = new Map();
        const rowIssues = new Map();
        const addIssue = (row, severity, field, message) => {
            const issue = {
                rowId: row.id,
                sourceRow: row.sourceRow || null,
                sourceSheet: row.sourceSheet || '',
                severity,
                field,
                message,
                grade: row.grade,
                className: row.className,
                subjectName: row.subjectName,
                teacherName: row.teacherName,
                weeklyHours: row.weeklyHours,
                blockPreference: row.blockPreference,
            };
            issues.push(issue);
            if (severity !== 'error') warnings.push(message);
            if (!rowIssues.has(row.id)) rowIssues.set(row.id, []);
            rowIssues.get(row.id).push(issue);
        };
        const split = value => String(value || '').split(/[、,，/／;；|]+/).map(item => item.trim()).filter(Boolean);

        draftRows.forEach(row => {
            const hours = Number(row.weeklyHours);
            if (!row.className) addIssue(row, 'error', 'className', '请填写班级。');
            if (!row.subjectName) addIssue(row, 'error', 'subjectName', '请填写课程。');
            if (!row.teacherName) addIssue(row, 'error', 'teacherName', '请填写教师。');
            if (!Number.isInteger(hours) || hours < 1 || hours > 60) addIssue(row, 'error', 'weeklyHours', '周课时需要在 1-60 之间。');
            if (row.blockPreference === 'double' && Number.isInteger(hours) && hours > 0 && hours % 2 !== 0) {
                addIssue(row, 'warning', 'blockPreference', '双连堂课时建议使用偶数。');
            }
            const key = [row.grade, row.className, row.subjectName, row.teacherName].join('|');
            if (duplicateKeys.has(key)) addIssue(row, 'warning', 'subjectName', '存在重复任课，请确认是否需要合并。');
            else duplicateKeys.set(key, row);
        });

        const classSet = new Set();
        const teacherSet = new Set();
        const subjectSet = new Set();
        const roomSet = new Set();
        let totalLessons = 0;
        let blockLessons = 0;
        draftRows.forEach(row => {
            if (row.className) classSet.add(`${row.grade}-${row.className}`);
            if (row.subjectName) subjectSet.add(row.subjectName);
            split(row.teacherName).forEach(name => teacherSet.add(name));
            split(row.roomName).forEach(name => roomSet.add(name));
            const hours = Number(row.weeklyHours);
            if (Number.isFinite(hours) && hours > 0) totalLessons += hours;
            if (row.blockPreference === 'double') blockLessons += Number.isFinite(hours) && hours > 0 ? hours : 0;
            if (row.blockPreference === 'mixed') blockLessons += Number.isFinite(hours) && hours > 0 ? Math.min(2, hours) : 0;
        });

        return {
            draftRows: draftRows.map(row => ({ ...row, issues: rowIssues.get(row.id) || [] })),
            stats: {
                classCount: classSet.size,
                teacherCount: teacherSet.size,
                subjectCount: subjectSet.size,
                planCount: draftRows.length,
                totalLessons,
                blockLessons,
                fixedRoomCount: roomSet.size,
                issueCount: issues.length,
            },
            warnings: [...new Set(warnings)],
            issues,
            hasBlockingIssues: issues.some(issue => issue.severity === 'error'),
        };
    }

    setRosterReviewState(payload = {}) {
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        const analyzed = this.analyzeRosterDraftRows(payload.draftRows || []);
        const issues = Array.isArray(payload.issues) && payload.issues.length ? payload.issues : analyzed.issues;
        const warnings = Array.isArray(payload.warnings) && payload.warnings.length ? payload.warnings : analyzed.warnings;
        const draftRows = (payload.draftRows || analyzed.draftRows).map((row, index) => this.normalizeRosterDraftRow(row, index));
        const hasIssueEditor = Object.prototype.hasOwnProperty.call(payload, 'issueEditor');
        const issueEditor = hasIssueEditor ? payload.issueEditor : this.state.rosterImport?.issueEditor || null;
        const editorRowId = String(issueEditor?.rowId || '').trim();
        const visibleIssueEditor = editorRowId && draftRows.some(row => String(row.id || '') === editorRowId)
            ? issueEditor
            : null;
        const hasSheetReviews = Object.prototype.hasOwnProperty.call(payload, 'sheetReviews');
        const sheetReviews = hasSheetReviews ? payload.sheetReviews || [] : current.sheetReviews || [];
        const hasAllDraftRows = Object.prototype.hasOwnProperty.call(payload, 'allDraftRows');
        const selectedSheetIds = new Set(sheetReviews.filter(sheet => sheet.selected).map(sheet => String(sheet.id || '')));
        const preservedUnselectedRows = (current.allDraftRows || []).filter(row => {
            const sourceSheetId = String(row.sourceSheetId || '');
            return sourceSheetId && !selectedSheetIds.has(sourceSheetId);
        });
        const allDraftRowsSource = hasAllDraftRows
            ? payload.allDraftRows || []
            : hasSheetReviews
                ? payload.draftRows || []
                : sheetReviews.length && payload.draftRows
                    ? [...preservedUnselectedRows, ...draftRows]
                    : current.allDraftRows?.length
                        ? current.allDraftRows
                    : draftRows;
        this.state.rosterImport = {
            ...current,
            open: true,
            step: 'review',
            source: payload.source || current.source || null,
            draftRows,
            allDraftRows: allDraftRowsSource.map((row, index) => this.normalizeRosterDraftRow(row, index)),
            sheetReviews,
            parseSummary: Object.prototype.hasOwnProperty.call(payload, 'parseSummary') ? payload.parseSummary : current.parseSummary,
            stats: payload.stats || analyzed.stats,
            warnings,
            issues,
            importReport: payload.importReport || null,
            hasBlockingIssues: Boolean(payload.hasBlockingIssues) || issues.some(issue => issue.severity === 'error'),
            issueListExpanded: Boolean(payload.issueListExpanded ?? this.state.rosterImport?.issueListExpanded),
            issueEditor: visibleIssueEditor,
            loading: false,
            phaseText: '',
            phaseTone: '',
        };
    }

    readRosterReviewRows() {
        return [...(this.state.container?.querySelectorAll('[data-roster-review-row]') || [])].map(row => {
            const value = field => row.querySelector(`[data-roster-field="${field}"]`)?.value?.trim() || '';
            return {
                id: row.dataset.rosterReviewRow || this.nextRosterDraftId(),
                sourceSheetId: row.dataset.rosterSourceSheetId || '',
                sourceRow: row.dataset.rosterSourceRow || '',
                sourceSheet: row.dataset.rosterSourceSheet || '',
                parseSource: row.dataset.rosterParseSource || 'local',
                grade: value('grade'),
                className: value('className'),
                subjectName: value('subjectName'),
                subjectCategory: value('subjectCategory') || 'normal',
                subjectTags: value('subjectTags'),
                teacherName: value('teacherName'),
                weeklyHours: value('weeklyHours'),
                blockPreference: value('blockPreference') || 'single',
                roomName: value('roomName'),
                activityTypes: value('activityTypes'),
                requiredResourceTypes: value('requiredResourceTypes'),
            };
        });
    }

    toggleRosterIssueList() {
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            issueListExpanded: !this.state.rosterImport?.issueListExpanded,
        };
        this.render();
    }

    locateRosterIssue(rowId = '', field = '') {
        const container = this.state.container;
        const normalizedRowId = String(rowId || '').trim();
        if (!container || !normalizedRowId) return false;
        const row = container.querySelector?.(`[data-roster-review-row="${selectorAttributeValue(normalizedRowId)}"]`);
        if (!row) return false;
        const normalizedField = String(field || '').trim();
        const fieldTarget = normalizedField
            ? row.querySelector?.(`[data-roster-field="${selectorAttributeValue(normalizedField)}"]`)
            : null;
        const run = () => {
            row.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
            row.classList?.add?.('tt-roster-review-row--focused');
            if (typeof fieldTarget?.focus === 'function') {
                fieldTarget.focus({ preventScroll: true });
            }
            if (this.rosterIssueFocusTimer) clearTimeout(this.rosterIssueFocusTimer);
            if (typeof setTimeout === 'function') {
                this.rosterIssueFocusTimer = setTimeout(() => {
                    row.classList?.remove?.('tt-roster-review-row--focused');
                }, 1800);
            }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
        return true;
    }

    findRosterIssueForEditor(rowId = '', field = '') {
        const normalizedRowId = String(rowId || '').trim();
        const normalizedField = String(field || '').trim();
        if (!normalizedRowId) return null;
        const matchesRow = issue => String(issue?.rowId || '').trim() === normalizedRowId;
        const matchesField = issue => !normalizedField || String(issue?.field || '').trim() === normalizedField;
        const issues = Array.isArray(this.state.rosterImport?.issues) ? this.state.rosterImport.issues : [];
        const direct = issues.find(issue => matchesRow(issue) && matchesField(issue));
        if (direct) return direct;
        const draftRow = (this.state.rosterImport?.draftRows || []).find(row => String(row.id || '') === normalizedRowId);
        return (draftRow?.issues || []).find(issue => matchesRow(issue) && matchesField(issue))
            || issues.find(matchesRow)
            || draftRow?.issues?.[0]
            || null;
    }

    rosterIssueIdentity(issue = {}) {
        return [
            String(issue.rowId || '').trim(),
            String(issue.field || '').trim(),
            String(issue.message || '').trim(),
        ].join('|');
    }

    currentRosterReviewRows() {
        const reviewRows = this.readRosterReviewRows();
        return reviewRows.length ? reviewRows : this.state.rosterImport?.draftRows || [];
    }

    editableRosterIssues(issues = this.state.rosterImport?.issues || [], rows = this.currentRosterReviewRows()) {
        const rowIds = new Set((rows || []).map(row => String(row.id || '').trim()).filter(Boolean));
        return (issues || []).filter(issue => {
            const rowId = String(issue?.rowId || '').trim();
            return rowId && rowIds.has(rowId);
        });
    }

    createRosterIssueEditor(issue = {}, rows = this.currentRosterReviewRows()) {
        const normalizedRowId = String(issue.rowId || '').trim();
        if (!normalizedRowId) return null;
        const row = (rows || []).find(item => String(item.id || '') === normalizedRowId);
        if (!row) return null;
        const normalizedField = String(issue.field || '').trim();
        const draft = this.normalizeRosterDraftRow(row, 0);
        return {
            rowId: draft.id,
            field: normalizedField,
            issue,
            draft,
        };
    }

    getRosterIssueEditorNavigation(issueEditor = this.state.rosterImport?.issueEditor) {
        const editor = issueEditor || null;
        const rows = this.currentRosterReviewRows();
        const issues = this.editableRosterIssues(this.state.rosterImport?.issues || [], rows);
        if (!issues.length) {
            return { index: editor ? 0 : -1, total: editor ? 1 : 0, previous: null, next: null };
        }
        const currentIssue = {
            ...(editor?.issue || {}),
            rowId: editor?.rowId || editor?.issue?.rowId || '',
            field: editor?.field || editor?.issue?.field || '',
        };
        const currentKey = this.rosterIssueIdentity(currentIssue);
        let index = issues.findIndex(issue => this.rosterIssueIdentity(issue) === currentKey);
        if (index < 0) {
            index = issues.findIndex(issue => (
                String(issue.rowId || '').trim() === String(currentIssue.rowId || '').trim()
                && String(issue.field || '').trim() === String(currentIssue.field || '').trim()
            ));
        }
        if (index < 0) {
            index = issues.findIndex(issue => String(issue.rowId || '').trim() === String(currentIssue.rowId || '').trim());
        }
        return {
            index,
            total: issues.length,
            previous: index > 0 ? issues[index - 1] : null,
            next: index >= 0 && index < issues.length - 1 ? issues[index + 1] : null,
        };
    }

    focusRosterIssueEditorField(field = '') {
        const container = this.state.container;
        if (!container) return;
        const normalizedField = String(field || '').trim();
        const run = () => {
            const target = normalizedField
                ? container.querySelector?.(`[data-roster-issue-field="${selectorAttributeValue(normalizedField)}"]`)
                : null;
            const fallback = container.querySelector?.('[data-roster-issue-field]');
            const focusTarget = target || fallback;
            if (typeof focusTarget?.focus === 'function') {
                focusTarget.focus({ preventScroll: true });
            }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
    }

    openRosterIssueEditor(rowId = '', field = '', issueOverride = null) {
        const normalizedRowId = String(rowId || '').trim();
        if (!normalizedRowId) return false;
        const rows = this.currentRosterReviewRows();
        if (!rows.some(item => String(item.id || '') === normalizedRowId)) return false;
        const issue = issueOverride || this.findRosterIssueForEditor(normalizedRowId, field) || { rowId: normalizedRowId, field };
        const normalizedField = String(field || issue.field || '').trim();
        const editor = this.createRosterIssueEditor({ ...issue, rowId: normalizedRowId, field: normalizedField }, rows);
        if (!editor) return false;
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            issueEditor: editor,
        };
        this.render();
        this.focusRosterIssueEditorField(normalizedField || 'weeklyHours');
        return true;
    }

    openAdjacentRosterIssue(direction = 'next') {
        const navigation = this.getRosterIssueEditorNavigation();
        const target = direction === 'previous' ? navigation.previous : navigation.next;
        if (!target) return false;
        return this.openRosterIssueEditor(target.rowId, target.field, target);
    }

    closeRosterIssueEditor() {
        if (!this.state.rosterImport?.issueEditor) return false;
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            issueEditor: null,
        };
        this.render();
        return true;
    }

    readRosterIssueEditorDraft() {
        const editor = this.state.rosterImport?.issueEditor;
        if (!editor) return null;
        const draft = { ...(editor.draft || {}), id: editor.rowId || editor.draft?.id || '' };
        this.state.container?.querySelectorAll?.('[data-roster-issue-field]')?.forEach(input => {
            const field = input.dataset?.rosterIssueField;
            if (field) draft[field] = input.value?.trim?.() ?? input.value ?? '';
        });
        return this.normalizeRosterDraftRow(draft, 0);
    }

    applyRosterIssueQuickFix(kind = '') {
        const editor = this.state.rosterImport?.issueEditor;
        if (!editor) return false;
        const draft = this.readRosterIssueEditorDraft() || { ...(editor.draft || {}) };
        if (kind === 'mixed') {
            draft.blockPreference = 'mixed';
        } else if (kind === 'single') {
            draft.blockPreference = 'single';
        } else if (kind === 'nextEven') {
            const hours = Number(draft.weeklyHours);
            if (Number.isFinite(hours) && hours > 0) {
                const wholeHours = Math.ceil(hours);
                draft.weeklyHours = String(wholeHours % 2 === 0 ? wholeHours : wholeHours + 1);
            }
        }
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            issueEditor: {
                ...editor,
                draft,
            },
        };
        this.render();
        this.focusRosterIssueEditorField(editor.field || 'weeklyHours');
        return true;
    }

    applyRosterIssueEditor(options = {}) {
        const editor = this.state.rosterImport?.issueEditor;
        if (!editor) return false;
        const advance = Boolean(options?.advance);
        const navigation = this.getRosterIssueEditorNavigation(editor);
        const cursorIndex = navigation.index >= 0 ? navigation.index : 0;
        const currentIssueKey = this.rosterIssueIdentity({
            ...(editor.issue || {}),
            rowId: editor.rowId || editor.issue?.rowId || '',
            field: editor.field || editor.issue?.field || '',
        });
        const draft = this.readRosterIssueEditorDraft();
        if (!draft) return false;
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        const rows = this.currentRosterReviewRows();
        let replaced = false;
        const nextRows = rows.map(row => {
            if (String(row.id || '') !== String(editor.rowId || '')) return row;
            replaced = true;
            return {
                ...row,
                ...draft,
                id: row.id || draft.id || editor.rowId,
                sourceRow: row.sourceRow || draft.sourceRow || '',
                sourceSheet: row.sourceSheet || draft.sourceSheet || '',
            };
        });
        if (!replaced) return false;
        const analyzed = this.analyzeRosterDraftRows(nextRows);
        let nextIssueEditor = null;
        if (advance) {
            const remainingIssues = this.editableRosterIssues(analyzed.issues, analyzed.draftRows);
            const currentStillOpen = remainingIssues.find(issue => this.rosterIssueIdentity(issue) === currentIssueKey);
            const targetIssue = currentStillOpen || remainingIssues[cursorIndex] || null;
            nextIssueEditor = targetIssue ? this.createRosterIssueEditor(targetIssue, analyzed.draftRows) : null;
        }
        this.setRosterReviewState({
            ...analyzed,
            source: current.source,
            importReport: current.importReport,
            issueListExpanded: current.issueListExpanded,
            issueEditor: nextIssueEditor,
        });
        this.render();
        if (nextIssueEditor) {
            this.focusRosterIssueEditorField(nextIssueEditor.field || 'weeklyHours');
        }
        return true;
    }

    locateRosterIssueFromEditor() {
        const editor = this.state.rosterImport?.issueEditor;
        if (!editor) return false;
        const rowId = editor.rowId;
        const field = editor.field || editor.issue?.field || '';
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            issueEditor: null,
        };
        this.render();
        return this.locateRosterIssue(rowId, field);
    }

    buildRosterReviewImportReport(analyzed = {}) {
        const issuesByRow = new Map();
        (analyzed.issues || []).forEach(issue => {
            const rowId = String(issue.rowId || '').trim();
            if (!rowId) return;
            if (!issuesByRow.has(rowId)) issuesByRow.set(rowId, []);
            issuesByRow.get(rowId).push(issue);
        });
        const entries = [];
        (analyzed.draftRows || []).forEach(row => {
            const rowIssues = issuesByRow.get(String(row.id || '')) || [];
            const category = rowIssues.some(issue => issue.severity === 'error')
                ? 'dropped'
                : rowIssues.length ? 'review' : 'kept';
            entries.push({
                category,
                source: { sheet: row.sourceSheet || null, row: row.sourceRow || null, rowId: row.id || null },
                field: rowIssues[0]?.field || 'row',
                reason: rowIssues[0]?.message || '任课行已保留。',
            });
        });
        const summary = { total: entries.length, kept: 0, degraded: 0, dropped: 0, review: 0 };
        entries.forEach(entry => { summary[entry.category] += 1; });
        return { sourceKind: 'roster', summary, entries, hasIssues: entries.some(entry => entry.category !== 'kept') };
    }

    reconcileRosterAllRows(visibleRows = []) {
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        const selectedSheetIds = new Set((current.sheetReviews || []).filter(sheet => sheet.selected).map(sheet => String(sheet.id || '')));
        const currentAll = current.allDraftRows?.length ? current.allDraftRows : current.draftRows || [];
        const preserved = currentAll.filter(row => {
            const sheetId = String(row.sourceSheetId || '');
            return sheetId && !selectedSheetIds.has(sheetId);
        });
        return [...preserved, ...visibleRows].map((row, index) => this.normalizeRosterDraftRow(row, index));
    }

    updateRosterParseSummary(sheetReviews = [], rows = []) {
        const current = this.state.rosterImport?.parseSummary;
        if (!current) return null;
        const selected = sheetReviews.filter(sheet => sheet.selected);
        return {
            ...current,
            includedSheetCount: selected.length,
            includedSheetNames: selected.map(sheet => sheet.name),
            localRowCount: rows.filter(row => row.parseSource !== 'ai').length,
            aiRowCount: rows.filter(row => row.parseSource === 'ai').length,
        };
    }

    toggleRosterSheet(sheetId = '', selected = false) {
        const normalizedSheetId = String(sheetId || '').trim();
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        if (!normalizedSheetId || !(current.sheetReviews || []).some(sheet => sheet.id === normalizedSheetId && sheet.rowCount > 0)) return false;
        const visibleRows = this.readRosterReviewRows();
        const allDraftRows = this.reconcileRosterAllRows(visibleRows);
        const sheetReviews = (current.sheetReviews || []).map(sheet => (
            sheet.id === normalizedSheetId ? { ...sheet, selected: Boolean(selected) } : sheet
        ));
        const selectedIds = new Set(sheetReviews.filter(sheet => sheet.selected).map(sheet => sheet.id));
        const nextRows = allDraftRows.filter(row => !row.sourceSheetId || selectedIds.has(row.sourceSheetId));
        const analyzed = this.analyzeRosterDraftRows(nextRows);
        const hasLocalRows = analyzed.draftRows.some(row => row.parseSource !== 'ai');
        const hasAiRows = analyzed.draftRows.some(row => row.parseSource === 'ai');
        const source = hasLocalRows && hasAiRows ? 'mixed' : hasAiRows ? 'ai' : hasLocalRows ? 'local' : current.source;
        this.setRosterReviewState({
            ...analyzed,
            source,
            allDraftRows,
            sheetReviews,
            parseSummary: this.updateRosterParseSummary(sheetReviews, analyzed.draftRows),
            importReport: this.buildRosterReviewImportReport(analyzed),
            issueListExpanded: current.issueListExpanded,
            issueEditor: null,
        });
        this.render();
        return true;
    }

    refreshRosterReviewFromRows(rows) {
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        const analyzed = this.analyzeRosterDraftRows(rows);
        const allDraftRows = this.reconcileRosterAllRows(analyzed.draftRows);
        this.setRosterReviewState({
            ...analyzed,
            source: current.source,
            allDraftRows,
            sheetReviews: current.sheetReviews || [],
            parseSummary: this.updateRosterParseSummary(current.sheetReviews || [], analyzed.draftRows),
            importReport: this.buildRosterReviewImportReport(analyzed),
            issueListExpanded: current.issueListExpanded,
        });
        this.render();
    }

    updateRosterReviewField() {
        this.refreshRosterReviewFromRows(this.readRosterReviewRows());
    }

    addRosterReviewRow() {
        this.refreshRosterReviewFromRows([...this.readRosterReviewRows(), this.emptyRosterDraftRow()]);
    }

    deleteRosterReviewRow(rowId) {
        this.refreshRosterReviewFromRows(this.readRosterReviewRows().filter(row => row.id !== rowId));
    }

    async appendRosterReviewRows() {
        const text = this.state.container?.querySelector('#tt-roster-bulk-text')?.value?.trim() || '';
        if (!text) {
            this.setMessage('请先粘贴要追加的任课数据。');
            return;
        }
        try {
            this.state.loading = true;
            this.render();
            const result = await requestTimetable('/roster/preview', {
                method: 'POST',
                body: JSON.stringify({ text }),
            });
            this.refreshRosterReviewFromRows([...this.readRosterReviewRows(), ...(result.draftRows || [])]);
        } catch (error) {
            this.handleError(error);
        } finally {
            this.state.loading = false;
            this.render();
        }
    }

    async previewRosterImport(modeOverride = '') {
        const text = this.readRosterImportText();
        const mode = modeOverride === 'text' || modeOverride === 'file'
            ? modeOverride
            : this.state.rosterImport?.mode === 'text' ? 'text' : 'file';
        const hasFile = mode === 'file' && this.rosterImportFile;
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            open: true,
            step: 'input',
            mode,
            text,
            loading: true,
            phaseText: mode === 'file' ? '读取并解析任课文件中...' : '解析任课文本中...',
            phaseTone: '',
        };
        this.state.loading = true;
        this.state.message = '解析任课数据中...';
        this.render();
        try {
            let options;
            if (hasFile) {
                const body = new FormData();
                body.append('file', this.rosterImportFile);
                options = { method: 'POST', body };
            } else {
                options = { method: 'POST', body: JSON.stringify({ text }) };
            }
            const result = await requestTimetable('/roster/preview', options);
            this.setRosterReviewState(result);
            this.setMessage('任课数据已解析，请复核后确认导入。');
        } catch (error) {
            this.state.rosterImport = {
                ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
                loading: false,
                phaseText: '解析失败，请检查文件或文本后重试。',
                phaseTone: 'warning',
            };
            this.handleError(error);
        } finally {
            this.state.loading = false;
            if (this.state.rosterImport?.loading) {
                this.state.rosterImport = {
                    ...this.state.rosterImport,
                    loading: false,
                };
            }
            this.render();
        }
    }

    startEmptyRosterReview() {
        this.setRosterReviewState({ draftRows: [this.emptyRosterDraftRow()] });
        this.render();
    }

    openRosterEditor() {
        this.setRosterReviewState({ draftRows: this.rosterRowsFromProject() });
        this.render();
    }

    async confirmRosterImport() {
        if (this.state.rosterImport?.step !== 'review') {
            await this.previewRosterImport();
            return;
        }
        const analyzed = this.analyzeRosterDraftRows(this.readRosterReviewRows());
        if (!analyzed.draftRows.length) {
            this.setMessage('请至少保留一条任课数据。');
            return;
        }
        if (analyzed.hasBlockingIssues) {
            this.setRosterReviewState(analyzed);
            this.render();
            this.setMessage('请先修正任课复核表里的红色问题。');
            return;
        }
        await this.importRoster({ rows: analyzed.draftRows });
    }

    async importRoster({ file = null, text = '', rows = null } = {}) {
        try {
            this.state.loading = true;
            this.setMessage('导入任课数据中...');
            this.render();
            let options;
            if (Array.isArray(rows)) {
                options = { method: 'POST', body: JSON.stringify({ rows }) };
            } else if (file) {
                const body = new FormData();
                body.append('file', file);
                options = { method: 'POST', body };
            } else {
                options = { method: 'POST', body: JSON.stringify({ text }) };
            }
            const result = await requestTimetable('/roster/import', options);
            this.applyProject(result.project);
            this.state.viewMode = 'class';
            this.state.selectedSlotId = '';
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.clearRuleDraft();
            this.resetRosterImport();
            this.setMessage(`已导入 ${result.import.count} 条任课信息。`);
            const resume = this.constraintParseResume || null;
            if (resume) {
                this.constraintParseResume = null;
                this.state.ruleReview = {
                    ...createTimetablePlannerState().ruleReview,
                    open: true,
                    step: 'input',
                    inputMode: resume.mode,
                    text: resume.text || '',
                };
                if (resume.file) this.constraintDialogFile = resume.file;
                setTimeout(() => this.parseConstraintsFromDialog?.(), 0);
            }
        } catch (error) {
            this.handleError(error);
        } finally {
            this.state.loading = false;
            this.render();
        }
    }

    async clearRoster() {
        try {
            this.state.loading = true;
            this.setMessage('清空任课数据中...');
            this.render();
            const result = await requestTimetable('/roster/clear', { method: 'POST' });
            this.applyProject(result.project);
            this.state.viewMode = 'class';
            this.state.selectedSlotId = '';
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.clearRuleDraft();
            this.setMessage('任课数据已清空。');
        } catch (error) {
            this.handleError(error);
        } finally {
            this.state.loading = false;
            this.render();
        }
    }

    async saveRules() {
        try {
            const rules = readRulesForm(this.state.container, this.state.project);
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.setMessage('约束已保存。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async parseRules() {
        const review = this.state.ruleReview || {};
        const text = readRulePrompt(this.state.container);
        const hasFile = review.mode === 'file' && this.ruleReviewFile;
        if (!text && !hasFile) {
            this.setMessage('请输入约束描述或上传约束文件。');
            return;
        }
        this.state.ruleReview = {
            ...review,
            open: true,
            text,
        };
        this.renderRuleReviewSurface();
        try {
            let options;
            if (hasFile) {
                this.setRuleReviewProgress('read_file', '读取约束文件中...', { step: 'input', mode: 'file' });
                await this.waitForRuleReviewFrame();
                const body = new FormData();
                body.append('file', this.ruleReviewFile);
                if (text) body.append('text', text);
                options = { method: 'POST', body };
                this.setRuleReviewProgress('parse_ai', '智能解析约束中...', { step: 'input', mode: 'file' });
            } else {
                this.setRuleReviewProgress('parse_text', '智能理解自然语言中...', { step: 'input', mode: 'text' });
                await this.waitForRuleReviewFrame();
                options = {
                    method: 'POST',
                    body: JSON.stringify({ text }),
                };
            }
            const result = await requestTimetable('/rules/parse', options);
            this.setRuleReviewProgress('build_review', '生成复核表中...', { step: 'input', mode: hasFile ? 'file' : 'text' });
            this.setRuleReviewState(result);
            this.state.pendingRules = result.draftRows || [];
            const total = (result.draftRows || []).length;
            const autoCount = (result.autoAcceptable || []).length;
            const reviewCount = (result.needReview || []).length;
            const questionCount = (result.clarifyingQuestions || []).length;
            const message = {
                ask_user: '需要补充信息后才能继续。',
                ready_to_apply: `已找到 ${autoCount} 条高置信度约束，可一键生效。`,
                review: `已解析 ${total} 条约束，其中 ${reviewCount} 条需要你确认。`,
                no_result: '未解析出可用约束，请换一种说法。',
            }[result.nextAction] || (total ? `已解析 ${total} 条约束，请在复核表确认。` : '未能解析出可用约束，请调整描述后重试。');
            this.setMessage(questionCount ? `${message} 有 ${questionCount} 个问题需要确认。` : message);
        } catch (error) {
            this.stopRuleReviewProgress('解析失败，请调整后重试。', 'warning');
            this.handleError(error);
        }
    }

    readClarifyingAnswers() {
        const questionNodes = [...(this.state.container?.querySelectorAll('[data-rule-clarify-question]') || [])];
        if (questionNodes.length) {
            return questionNodes.map(node => {
                const questionId = node.dataset.ruleClarifyQuestion || '';
                const checkedOption = [...(node.querySelectorAll('[data-rule-clarify-option]') || [])]
                    .find(option => option.checked
                        || option.selected
                        || option.getAttribute?.('aria-pressed') === 'true'
                        || option.classList?.contains('is-active'));
                const input = node.querySelector('[data-rule-clarify-input]');
                const selectedOption = input?.options ? input.options[input.selectedIndex] : null;
                const value = checkedOption?.value || input?.value || '';
                const label = checkedOption?.dataset?.label
                    || selectedOption?.dataset?.label
                    || selectedOption?.textContent
                    || input?.dataset?.label
                    || input?.value
                    || value;
                return {
                    questionId,
                    value,
                    label,
                    targetType: node.dataset.targetType || '',
                    targetText: node.dataset.targetText || '',
                };
            }).filter(item => item.questionId && item.value);
        }
        return [...(this.state.container?.querySelectorAll('[data-rule-question-answer]') || [])]
            .map(input => ({
                questionId: input.dataset.ruleQuestionAnswer || '',
                value: input.value || '',
                label: input.options ? input.options[input.selectedIndex]?.textContent || input.value : input.value,
                targetType: input.dataset.targetType || '',
                targetText: input.dataset.targetText || '',
            }))
            .filter(item => item.questionId && item.value);
    }

    async submitClarifyingAnswers() {
        const review = this.state.ruleReview || {};
        const questions = review.clarifyingQuestions || [];
        if (!questions.length) {
            this.setMessage('当前没有需要补充的问题。');
            return;
        }
        const answers = this.readClarifyingAnswers();
        if (answers.length < questions.length) {
            this.setMessage('请先回答所有需要补充的问题。');
            return;
        }
        try {
            this.state.ruleReview = {
                ...review,
                loading: true,
                phase: 'clarify',
                phaseText: '正在根据补充信息继续解析……',
                phaseTone: '',
            };
            this.renderRuleReviewSurface();
            const result = await requestTimetable('/rules/clarify', {
                method: 'POST',
                body: JSON.stringify({
                    project: this.state.project,
                    originalText: review.originalText || review.text || '',
                    previousResult: review,
                    answers,
                    inputType: review.inputType || 'clarification',
                    contextStats: review.contextStats || null,
                }),
            });
            this.setRuleReviewState(result);
            this.state.pendingRules = result.draftRows || [];
            const autoCount = (result.autoAcceptable || []).length;
            const message = {
                ask_user: '还有信息需要补充，请继续确认。',
                ready_to_apply: `歧义已解决，已找到 ${autoCount} 条可直接生效的高置信度约束。`,
                review: '已更新解析结果，请复核后应用。',
                no_result: '仍未解析出可用约束，请换一种说法。',
            }[result.nextAction] || '已根据补充信息更新解析结果。';
            this.setMessage(message);
        } catch (error) {
            this.handleError(error);
        }
    }

    async continueRuleConversation() {
        return this.submitClarifyingAnswers();
    }

    async applyAutoAcceptableRules() {
        const hasBlockingConflict = (this.state.ruleReview?.conflicts || []).some(item => item.level === 'blocking');
        if (hasBlockingConflict) {
            this.setMessage('存在阻塞冲突，请先处理冲突后再一键生效。');
            return;
        }
        const rows = (this.state.ruleReview?.autoAcceptable || []).filter(row => this.isSafeAutoAcceptableRule(row));
        if (!rows.length) {
            this.setMessage('没有可一键生效的高置信度约束。');
            return;
        }
        try {
            this.setRuleReviewProgress('save_auto', '写入高置信度约束中...', { step: 'review', mode: this.state.ruleReview?.mode || 'text' });
            const normalized = await requestTimetable('/rules/normalize', {
                method: 'POST',
                body: JSON.stringify({
                    draftRows: rows,
                    inputType: this.state.ruleReview?.inputType || 'review',
                    contextStats: this.state.ruleReview?.contextStats || null,
                }),
            });
            const effectiveCount = (normalized.draftRows || []).filter(row => row.status === 'effective').length;
            if (effectiveCount !== rows.length) {
                this.setRuleReviewState(normalized);
                this.setMessage('部分高置信度约束未通过校验，请复核后再生效。');
                return;
            }
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: normalized.draftRules }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            const acceptedIds = new Set(rows.map(row => row.id));
            const remaining = (this.state.ruleReview?.draftRows || []).filter(row => !acceptedIds.has(row.id));
            this.setRuleReviewState({
                ...(this.state.ruleReview || {}),
                draftRows: remaining,
                autoAcceptable: [],
                needReview: remaining.filter(row => ['needs_review', 'invalid'].includes(row.status)),
                unsupportedItems: this.state.ruleReview?.unsupportedItems || [],
                warnings: this.state.ruleReview?.warnings || [],
                nextAction: remaining.length ? 'review' : 'ready_to_apply',
            });
            this.setMessage(`已生效 ${effectiveCount} 条高置信度约束。`);
        } catch (error) {
            this.stopRuleReviewProgress('写入失败，请稍后重试。', 'warning');
            this.handleError(error);
        }
    }

    async diagnoseRules() {
        const review = this.state.ruleReview || {};
        try {
            this.setRuleReviewProgress('diagnose', '诊断约束风险中...', { step: review.step || 'review', mode: review.mode || 'text' });
            const result = await requestTimetable('/rules/diagnose', {
                method: 'POST',
                body: JSON.stringify({
                    project: this.state.project,
                    activeRules: getSavedRuleItems(this.state.project),
                    recentDraftRows: review.draftRows || [],
                    draftRows: review.draftRows || [],
                    solverFailure: this.state.lastFailure || this.state.project?.schedule?.solverStats || null,
                }),
            });
            this.state.ruleReview = {
                ...(this.state.ruleReview || {}),
                loading: false,
                phase: '',
                phaseText: '',
                phaseTone: '',
                diagnosis: result.diagnosis || null,
            };
            if (this.state.smartWorkbench?.open) {
                this.state.smartWorkbench = {
                    ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                    stage: 'diagnosing',
                    busy: false,
                    diagnosis: result.diagnosis || null,
                    error: '',
                };
                this.renderSmartWorkbenchSurface();
            }
            this.setMessage('智能诊断已更新。');
        } catch (error) {
            this.stopRuleReviewProgress('诊断失败，请稍后重试。', 'warning');
            this.handleError(error);
        }
    }

    async previewSmartRuleChanges() {
        const rows = this.state.ruleReview?.advancedOpen
            ? this.readRuleReviewRows()
            : this.state.ruleReview?.draftRows || [];
        if (!rows.length) {
            this.setMessage('当前没有可以核对的约束草稿。');
            return;
        }
        try {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: 'waiting_user_confirmation',
                busy: true,
                error: '',
            };
            this.renderSmartWorkbenchSurface();
            const normalized = await requestTimetable('/rules/normalize', {
                method: 'POST',
                body: JSON.stringify({
                    draftRows: rows,
                    inputType: this.state.ruleReview?.inputType || 'review',
                    contextStats: this.state.ruleReview?.contextStats || null,
                }),
            });
            this.setRuleReviewState(normalized);
            const currentItems = getSavedRuleItems(this.state.project);
            const nextItems = getSavedRuleItems({
                ...this.state.project,
                rules: normalized.draftRules,
            });
            this.state.ruleDraft = normalized.draftRules;
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: 'waiting_user_confirmation',
                busy: false,
                ruleChangePreview: buildRuleChangePreview({
                    currentItems,
                    nextItems,
                    draftRows: normalized.draftRows || rows,
                }),
            };
            this.renderSmartWorkbenchSurface();
        } catch (error) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: 'reviewing_constraints',
                busy: false,
                error: normalizeApiError(error).message,
            };
            this.handleError(error);
        }
    }

    backToSmartRuleReview() {
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            stage: (this.state.ruleReview?.draftRows || []).length
                ? 'reviewing_constraints'
                : 'ready_for_constraints',
            ruleChangePreview: null,
            solvePlan: null,
            busy: false,
            error: '',
        };
        this.renderSmartWorkbenchSurface();
    }

    async refreshSmartWorkbenchRuleScan(constraints = null) {
        if (!this.state.smartWorkbench?.open) return null;
        const reviewRows = Array.isArray(constraints)
            ? constraints
            : (this.state.ruleReview?.draftRows || getSavedRuleItems(this.state.project));
        this.state.constraintScan = {
            ...(this.state.constraintScan || {}),
            open: true,
            scanning: true,
            phase: '正在重新检查规则冲突...',
            error: '',
        };
        this.renderSmartWorkbenchSurface();
        try {
            const result = await requestTimetable('/constraints/scan', {
                method: 'POST',
                body: JSON.stringify({
                    constraints: reviewRows,
                    project: this.state.project,
                }),
            });
            this.state.constraintScan = {
                open: true,
                scanning: false,
                completed: true,
                problems: result.problems || [],
                stats: result.stats || {},
                error: '',
            };
            return result;
        } catch (error) {
            this.state.constraintScan = {
                ...(this.state.constraintScan || {}),
                open: true,
                scanning: false,
                completed: false,
                error: normalizeApiError(error).message,
            };
            return null;
        }
    }

    async buildSmartSolvePlan() {
        const items = getSavedRuleItems(this.state.project);
        const hardCount = items.filter(item => item.priority === 'hard').length;
        const softCount = items.length - hardCount;
        const audit = this.state.project?.schedule?.audit || null;
        const auditWarnings = (audit?.warnings || []).filter(item => isActionableTimetableSuggestion(item, this.state.project));
        const fallbackPlan = {
            hardCount,
            softCount,
            hardSummary: hardCount
                ? `优先满足 ${hardCount} 条必须条件，以及教师、班级和教室不冲突`
                : '先保证教师、班级、教室不冲突，并满足固定课节',
            softSummary: softCount
                ? `在可行课表上继续优化 ${softCount} 条偏好`
                : '继续优化课程分散、教师负载和班级日课时均衡',
            strategySummary: '先用本地算法快速生成可用课表，再由 Timefold 在后台寻找更优结果',
            riskSummary: auditWarnings.length
                ? `当前有 ${auditWarnings.length} 项风险，生成后会再次校验`
                : '当前没有发现阻断风险，生成后仍会再次校验',
        };
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            stage: 'building_solve_plan',
            busy: true,
            ruleChangePreview: null,
            solvePlan: fallbackPlan,
        };
        this.renderSmartWorkbenchSurface();
        try {
            let sessionId = this.state.agent?.sessionId || null;
            if (!sessionId) {
                const session = await requestTimetableAgent('/session', {
                    method: 'POST',
                    body: JSON.stringify({
                        project: this.state.project,
                        mode: 'assistant',
                    }),
                });
                sessionId = session.sessionId || session.state?.sessionId || null;
            }
            const response = await requestTimetableAgent('/message', {
                method: 'POST',
                body: JSON.stringify({
                    sessionId,
                    message: '开始生成课表',
                    project: this.state.project,
                }),
            });
            const solveArtifact = [...(response.artifacts || [])].reverse().find(item => item.type === 'solve_plan') || {};
            const executeApproval = (response.approvalQueue || []).find(item => item.type === 'execute_solve');
            this.state.agent = {
                ...(this.state.agent || {}),
                sessionId: response.sessionId || sessionId,
                stage: response.stage || 'solve_planning',
                planner: response.planner || null,
                ui: response.ui || null,
                artifacts: response.artifacts || [],
                approvalQueue: response.approvalQueue || [],
                loading: false,
                error: null,
            };
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: response.stage === 'diagnosis' ? 'diagnosing' : 'waiting_solve_approval',
                busy: false,
                solvePlan: {
                    ...fallbackPlan,
                    solverPreference: solveArtifact.solverPreference || executeApproval?.payload?.solvePlan?.solverPreference || '',
                    strategy: solveArtifact.strategy || executeApproval?.payload?.solvePlan?.strategy || 'balanced',
                    planner: response.planner || null,
                    agentApprovalId: executeApproval?.id || '',
                },
                diagnosis: response.stage === 'diagnosis'
                    ? {
                        summary: response.reply || '求解前检查发现需要先处理的问题。',
                        suggestions: response.warnings || [],
                    }
                    : null,
            };
        } catch (error) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: 'waiting_solve_approval',
                busy: false,
                solvePlan: fallbackPlan,
                error: '',
            };
        }
        this.renderSmartWorkbenchSurface();
    }

    smartCandidateFromProject() {
        const schedule = this.state.project?.schedule;
        if (!schedule) return null;
        const score = schedule.score || {};
        return {
            id: schedule.id || schedule.generatedAt || 'current',
            label: schedule.source === 'timefold_solver' ? 'Timefold 优化方案' : '本地快速方案',
            source: schedule.source || 'fast_constructed',
            sourceLabel: schedule.source === 'timefold_solver' ? 'Timefold 后台优化' : '本地快速生成',
            hardConflicts: Number(score.hardConflicts ?? (schedule.conflicts || []).length ?? 0),
            softScore: Number(score.softScore ?? score.qualityScore ?? 0),
            completeness: score.completeness
                || `${Math.max(0, Number(score.totalLessons || 0) - Number(score.unplacedLessons || 0))}/${Number(score.totalLessons || 0)}`,
        };
    }

    mergeSmartWorkbenchCandidate(candidate) {
        if (!candidate) return;
        const current = this.state.smartWorkbench?.candidates || [];
        const key = item => `${item.source || ''}:${item.id || ''}`;
        const byKey = new Map(current.map(item => [key(item), item]));
        byKey.set(key(candidate), candidate);
        const candidates = [...byKey.values()].sort((left, right) => {
            const hardDelta = Number(left.hardConflicts || 0) - Number(right.hardConflicts || 0);
            if (hardDelta) return hardDelta;
            const leftCompleteness = Number.parseFloat(String(left.completeness || '0').replace('%', ''));
            const rightCompleteness = Number.parseFloat(String(right.completeness || '0').replace('%', ''));
            if (leftCompleteness !== rightCompleteness) return rightCompleteness - leftCompleteness;
            return Number(right.softScore || 0) - Number(left.softScore || 0);
        });
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            candidates,
            activeCandidateId: candidates[0]?.id || candidate.id,
        };
    }

    async runSmartSchedule() {
        this.state.smartWorkbench = {
            ...(this.state.smartWorkbench || createSmartWorkbenchState()),
            stage: 'solving',
            busy: true,
            error: '',
        };
        this.renderSmartWorkbenchSurface();
        await this.runSchedule();
        const candidate = this.smartCandidateFromProject();
        if (candidate) {
            this.mergeSmartWorkbenchCandidate(candidate);
        }
        if (candidate && !this.state.lastFailure && this.isSchedulePublicationReady()) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: 'solution_review',
                busy: false,
                diagnosis: null,
            };
        } else {
            const failure = this.state.lastFailure || {};
            const scheduleDiagnosis = this.smartScheduleDiagnosis();
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                stage: 'diagnosing',
                busy: false,
                diagnosis: failure.message
                    ? {
                        summary: failure.message || '这次没有得到可保存的课表。',
                        suggestions: failure.audit?.warnings
                            || failure.warnings
                            || scheduleDiagnosis.suggestions,
                    }
                    : scheduleDiagnosis,
            };
        }
        this.renderSmartWorkbenchSurface();
    }

    openSmartPublish() {
        if (!this.isSchedulePublicationReady()) {
            this.state.smartWorkbench = {
                ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                open: true,
                stage: 'diagnosing',
                busy: false,
                diagnosis: this.smartScheduleDiagnosis(),
                error: '',
            };
            this.renderSmartWorkbenchSurface();
            return;
        }
        this.closeSmartWorkbench();
        this.openPublishDialog();
    }

    previewSmartRelaxation(index = 0) {
        const suggestions = this.state.smartWorkbench?.diagnosis?.suggestions || [];
        const suggestion = suggestions[Number(index)] || suggestions[0];
        this.state.message = suggestion
            ? `建议调整：${suggestion.label || suggestion.message || suggestion}`
            : '当前没有可以自动应用的调整方案。';
        this.backToSmartRuleReview();
    }

    async confirmRuleDraft() {
        const rows = this.state.ruleReview?.step === 'review' && this.state.ruleReview?.advancedOpen
            ? this.readRuleReviewRows()
            : this.state.ruleReview?.draftRows || [];
        if (rows.length) {
            try {
                this.setRuleReviewProgress('normalize', '校验规则中...', { step: 'review', mode: this.state.ruleReview?.mode || 'file' });
                const normalized = await requestTimetable('/rules/normalize', {
                    method: 'POST',
                    body: JSON.stringify({
                        draftRows: rows,
                        inputType: this.state.ruleReview?.inputType || 'review',
                        contextStats: this.state.ruleReview?.contextStats || null,
                    }),
                });
                this.setRuleReviewState(normalized);
                const effectiveCount = (normalized.draftRows || []).filter(row => row.status === 'effective').length;
                if (!effectiveCount) {
                    this.setMessage('复核表里没有可生效规则，请先修正对象或节次。');
                    return;
                }
                this.setRuleReviewProgress('save', '写入项目中...', { step: 'review', mode: this.state.ruleReview?.mode || 'file' });
                const result = await requestTimetable('/rules', {
                    method: 'POST',
                    body: JSON.stringify({ rules: normalized.draftRules }),
                });
                this.applyProject(result.project);
                await this.refreshSmartWorkbenchRuleScan(getSavedRuleItems(result.project));
                this.clearOptimizationPolling();
                this.state.solverJob = null;
                this.state.lastFailure = null;
                this.state.selectedSlotId = '';
                this.clearRuleDraft();
                this.state.ruleReview = {
                    ...createTimetablePlannerState().ruleReview,
                    open: false,
                    step: 'saved',
                    uiStep: 'saved',
                    mode: 'file',
                };
                if (this.state.smartWorkbench?.open) {
                    this.state.smartWorkbench = {
                        ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                        stage: 'building_solve_plan',
                        ruleChangePreview: null,
                        busy: false,
                    };
                    await this.buildSmartSolvePlan();
                }
                this.setMessage('约束已确认生效。');
                return;
            } catch (error) {
                this.stopRuleReviewProgress('写入失败，请稍后重试。', 'warning');
                this.handleError(error);
                return;
            }
        }
        if (!this.state.ruleDraft) {
            this.setMessage('请先解析约束草稿。');
            return;
        }
        try {
            this.setRuleReviewProgress('save', '写入项目中...', { step: this.state.ruleReview?.step || 'review', mode: this.state.ruleReview?.mode || 'file' });
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: this.state.ruleDraft }),
            });
            this.applyProject(result.project);
            await this.refreshSmartWorkbenchRuleScan(getSavedRuleItems(result.project));
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.state.ruleReview = {
                ...createTimetablePlannerState().ruleReview,
                open: false,
                step: 'saved',
                uiStep: 'saved',
                mode: 'file',
            };
            if (this.state.smartWorkbench?.open) {
                this.state.smartWorkbench = {
                    ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                    stage: 'building_solve_plan',
                    ruleChangePreview: null,
                    busy: false,
                };
                await this.buildSmartSolvePlan();
            }
            this.setMessage('智能约束已确认。');
        } catch (error) {
            this.stopRuleReviewProgress('写入失败，请稍后重试。', 'warning');
            this.handleError(error);
        }
    }

    async removeSavedRule(ruleId) {
        try {
            const rules = removeSavedRuleById(this.state.project, ruleId);
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.state.ruleDraft = null;
            this.state.ruleDraftPreview = [];
            this.state.ruleWarnings = [];
            this.state.ruleDraftInputType = '';
            this.state.ruleContextStats = null;
            this.state.ruleUnsupportedItems = [];
            this.state.ruleReview = {
                ...createTimetablePlannerState().ruleReview,
                open: true,
                step: 'saved',
                uiStep: 'saved',
                mode: 'file',
            };
            this.setMessage('已删除一条约束。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async clearRules() {
        try {
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: { hardRules: {}, softRules: {} } }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.setMessage('约束已清空。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async addLockedSlot() {
        try {
            const rules = cloneValue(this.state.project.rules || { hardRules: {}, softRules: {} });
            rules.hardRules = rules.hardRules || {};
            rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
            rules.hardRules.lockedSlots.push(readLockedSlotForm(this.state.container, this.state.project));
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.setMessage('锁定课节已添加。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async removeLockedSlot(index) {
        try {
            const rules = cloneValue(this.state.project.rules || { hardRules: {}, softRules: {} });
            rules.hardRules = rules.hardRules || {};
            rules.hardRules.lockedSlots = (rules.hardRules.lockedSlots || []).filter((_, itemIndex) => itemIndex !== index);
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.setMessage('锁定课节已移除。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async runSchedule() {
        this.state.loading = true;
        this.state.solveScaleHint = buildClientSolveScaleHint(this.state.project);
        this.state.solvePhaseText = this.state.solveScaleHint?.message || '检查数据中';
        const phaseTimers = [
            setTimeout(() => {
                if (!this.state.loading) return;
                this.state.solvePhaseText = this.state.solveScaleHint?.largeProject
                    ? `快速生成中 · ${this.state.solveScaleHint.message}`
                    : '快速生成中';
                if (this.state.smartWorkbench?.open) this.renderSmartWorkbenchSurface();
                else this.render();
            }, 80),
            setTimeout(() => {
                if (!this.state.loading) return;
                this.state.solvePhaseText = this.state.solveScaleHint?.largeProject
                    ? `局部优化中 · ${this.state.solveScaleHint.message}`
                    : '局部优化中';
                if (this.state.smartWorkbench?.open) this.renderSmartWorkbenchSurface();
                else this.render();
            }, 500),
        ];
        if (this.state.smartWorkbench?.open) this.renderSmartWorkbenchSurface();
        else this.render();
        try {
            const result = await requestTimetable('/schedule/run', { method: 'POST' });
            this.applyProject(result.project);
            this.state.viewMode = 'class';
            this.state.selectedOwnerId = this.state.project.classes[0]?.id || this.state.project.teachers[0]?.id || '';
            this.state.selectedSlotId = '';
            this.state.solverJob = result.solverJob || null;
            this.state.solveScaleHint = result.solverScaleHint || this.state.solveScaleHint || null;
            this.state.message = result.schedule.score.unplacedLessons
                ? `快速生成完成，还有 ${result.schedule.score.unplacedLessons} 节未排。`
                : result.solverJob
                    ? '快速课表已生成，Timefold 正在后台优化。'
                    : '快速课表已生成。';
            this.state.lastFailure = null;
            this.startOptimizationPolling(result.solverJob);
        } catch (error) {
            this.handleError(error, { keepFailure: true });
        } finally {
            phaseTimers.forEach(timer => clearTimeout(timer));
            this.state.loading = false;
            this.state.solvePhaseText = '';
            if (this.state.smartWorkbench?.open) this.renderSmartWorkbenchSurface();
            else this.render();
        }
    }

    async adjustSlot(payload) {
        try {
            const result = await requestTimetable('/schedule/adjust', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.clearRuleDraft();
            if (payload.type === 'clear') this.state.selectedSlotId = '';
            this.setMessage(result.schedule.conflicts.length ? '已调整，当前仍有冲突。' : '已调整。');
        } catch (error) {
            this.handleError(error, { keepFailure: true });
        }
    }

    async export(type, options = {}) {
        try {
            const response = await requestTimetable('/export', {
                method: 'POST',
                body: JSON.stringify({
                    type,
                    ...(options.publishedVersion ? { publishedVersion: options.publishedVersion } : {}),
                    ...(options.weekView ? { weekView: options.weekView } : {}),
                }),
                raw: true,
            });
            if (!response.ok) {
                const payload = await response.json();
                const error = new Error(payload.error || '导出失败');
                error.payload = payload;
                error.status = response.status;
                throw error;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            const versionSuffix = options.publishedVersion ? `_V${options.publishedVersion}` : '';
            link.download = `${exportName(type)}${versionSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            this.setMessage('导出已开始。');
        } catch (error) {
            this.handleError(error);
        }
    }

    openPublishDialog() {
        if (!this.isSchedulePublicationReady()) {
            this.resetPublishDialog();
            this.setMessage('当前课表还不能发布，请先处理未排课时或硬冲突。');
            return;
        }
        this.state.publishDialog = {
            open: true,
            note: this.state.project?.schedule?.published?.note || '',
            loading: false,
        };
        this.render();
    }

    closePublishDialog() {
        this.state.publishDialog = {
            ...(this.state.publishDialog || {}),
            open: false,
            loading: false,
        };
        this.render();
    }

    openPublicationHistoryDialog(version) {
        const parsedVersion = Number.parseInt(version, 10);
        const historyEntry = (this.state.project?.schedule?.published?.history || [])
            .find(item => Number.parseInt(item?.version, 10) === parsedVersion);
        if (!Number.isInteger(parsedVersion) || !historyEntry) {
            this.state.publicationHistoryDialog = { open: false, version: null };
            this.setMessage(Number.isInteger(parsedVersion)
                ? `发布历史 V${parsedVersion} 不存在，无法查看。`
                : '请选择要查看的发布历史版本。');
            return;
        }
        this.state.publicationHistoryDialog = {
            open: true,
            version: parsedVersion,
        };
        this.render();
    }

    closePublicationHistoryDialog() {
        this.state.publicationHistoryDialog = {
            ...(this.state.publicationHistoryDialog || {}),
            open: false,
        };
        this.render();
    }

    openRestoreDialog(mode = 'latest', version = null) {
        const parsedVersion = Number.parseInt(version ?? this.state.publicationHistoryDialog?.version, 10);
        const published = this.state.project?.schedule?.published || null;
        const historyEntry = mode === 'history' && Number.isInteger(parsedVersion)
            ? (published?.history || []).find(item => Number.parseInt(item.version, 10) === parsedVersion) || null
            : null;
        if (mode === 'history' && (!Number.isInteger(parsedVersion) || !historyEntry)) {
            this.state.restoreDialog = {
                open: false,
                mode: '',
                version: null,
                targetLabel: '',
                summary: null,
                loading: false,
            };
            this.setMessage(Number.isInteger(parsedVersion)
                ? `发布历史 V${parsedVersion} 不存在，无法恢复。`
                : '请选择要恢复的发布历史版本。');
            return;
        }
        if (mode !== 'history') {
            const latestVersion = Number.parseInt(published?.version, 10);
            const requestedVersion = Number.isInteger(parsedVersion) ? parsedVersion : latestVersion;
            const canBackfillLatestSnapshot = published?.status === 'published';
            if (
                !Number.isInteger(latestVersion)
                || requestedVersion !== latestVersion
                || (!published?.snapshot && !canBackfillLatestSnapshot)
            ) {
                this.state.restoreDialog = {
                    open: false,
                    mode: '',
                    version: null,
                    targetLabel: '',
                    summary: null,
                    loading: false,
                };
                this.setMessage('当前没有可恢复的发布版本。');
                return;
            }
        }
        const diffProject = historyEntry?.snapshot
            ? {
                ...this.state.project,
                schedule: {
                    ...this.state.project?.schedule,
                    published: {
                        ...published,
                        snapshot: historyEntry.snapshot,
                    },
                },
            }
            : this.state.project;
        const diff = getPublishedScheduleDiff(diffProject);
        const summary = diff.hasSnapshot && diff.total
            ? {
                moved: diff.moved || 0,
                changed: diff.changed || 0,
                added: diff.added || 0,
                removed: diff.removed || 0,
                total: diff.total || 0,
            }
            : {
                moved: 0,
                changed: 0,
                added: 0,
                removed: 0,
                total: 0,
            };
        const targetLabel = mode === 'history'
            ? `发布历史 V${parsedVersion || ''}`
            : `发布版 V${published?.version || parsedVersion || ''}`;
        this.state.restoreDialog = {
            open: true,
            mode,
            version: Number.isInteger(parsedVersion) ? parsedVersion : null,
            targetLabel,
            summary,
            loading: false,
        };
        this.render();
    }

    closeRestoreDialog() {
        this.state.restoreDialog = {
            ...(this.state.restoreDialog || {}),
            open: false,
            loading: false,
        };
        this.render();
    }

    async restorePublicationHistoryVersion(version = this.state.publicationHistoryDialog?.version) {
        this.openRestoreDialog('history', version);
    }

    async restoreLatestPublishedSnapshot() {
        this.openRestoreDialog('latest', this.state.project?.schedule?.published?.version);
    }

    async confirmRestoreSchedule() {
        const dialog = this.state.restoreDialog || {};
        const requestedVersion = Number.parseInt(dialog.version, 10);
        const isHistory = dialog.mode === 'history';
        if (isHistory && !Number.isInteger(requestedVersion)) {
            this.setMessage('请选择要恢复的发布版本。');
            return;
        }
        this.state.restoreDialog = {
            ...dialog,
            loading: true,
        };
        this.render();
        try {
            const result = await requestTimetable('/schedule/published/restore', {
                method: 'POST',
                body: JSON.stringify(isHistory ? { version: requestedVersion } : {}),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.state.restoreDialog = { open: false, mode: '', version: null, targetLabel: '', summary: null, loading: false };
            this.state.publicationHistoryDialog = { open: false, version: null };
            if (isHistory) {
                this.setMessage(`已恢复发布历史 V${result.restoredVersion || requestedVersion} 为当前草稿，请复核后重新发布。`);
            } else {
                const publishedVersion = Number.parseInt(this.state.project?.schedule?.published?.version, 10);
                this.setMessage(`已恢复发布版 V${result.restoredVersion || publishedVersion || ''} 为当前草稿，请复核后重新发布。`);
            }
        } catch (error) {
            this.state.restoreDialog = {
                ...(this.state.restoreDialog || {}),
                loading: false,
            };
            this.handleError(error, { keepFailure: true });
        }
    }

    updatePublishNote() {
        const textarea = this.state.container?.querySelector('#tt-publish-note');
        this.state.publishDialog = {
            ...(this.state.publishDialog || {}),
            note: textarea?.value || '',
        };
    }

    async confirmPublishSchedule() {
        this.updatePublishNote();
        if (!this.isSchedulePublicationReady()) {
            this.resetPublishDialog();
            this.setMessage('当前课表还不能发布，请先处理未排课时或硬冲突。');
            return;
        }
        this.state.publishDialog = {
            ...(this.state.publishDialog || {}),
            loading: true,
        };
        this.render();
        try {
            const result = await requestTimetable('/schedule/publish', {
                method: 'POST',
                body: JSON.stringify({ note: this.state.publishDialog?.note || '' }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.publishDialog = { open: false, note: '', loading: false };
            const version = result.schedule?.published?.version || result.project?.schedule?.published?.version || 1;
            this.setMessage(`课表已发布 V${version}。`);
        } catch (error) {
            this.state.publishDialog = {
                ...(this.state.publishDialog || {}),
                loading: false,
            };
            this.handleError(error);
        }
    }

    async publishSchedule() {
        await this.confirmPublishSchedule();
    }

    handleError(error, options = {}) {
        const normalized = normalizeApiError(error);

        // 处理版本冲突特殊情况（409状态码）
        if (normalized.status === 409 || normalized.reason === 'VERSION_CONFLICT') {
            const shouldRefresh = confirm(
                `${normalized.message}\n\n` +
                '点击"确定"刷新页面加载最新数据，点击"取消"继续编辑（可能导致数据冲突）。'
            );
            if (shouldRefresh) {
                window.location.reload();
                return;
            }
            // 用户选择继续编辑，显示警告
            this.state.message = `⚠️ 版本冲突警告：${normalized.message}`;
            this.state.lastFailure = options.keepFailure ? normalized : null;
            this.render();
            return;
        }

        // 原有错误处理逻辑
        if (normalized.project) {
            this.applyProject(normalized.project);
        } else if (normalized.publication && this.state.project?.schedule) {
            this.state.project = {
                ...this.state.project,
                schedule: {
                    ...this.state.project.schedule,
                    publication: normalized.publication,
                },
            };
        }
        this.state.message = normalized.message;
        this.state.lastFailure = options.keepFailure ? normalized : null;
        if (this.state.smartWorkbench?.open) {
            if (options.keepFailure) {
                this.state.smartWorkbench = {
                    ...(this.state.smartWorkbench || createSmartWorkbenchState()),
                    stage: 'diagnosing',
                    busy: false,
                    error: normalized.message,
                    diagnosis: {
                        summary: normalized.message,
                        suggestions: normalized.warnings || normalized.audit?.warnings || [],
                    },
                };
            }
            this.renderSmartWorkbenchSurface();
        } else {
            this.render();
        }
    }

    setManualPeriodTime(period, start, end) {
        const draftTimes = this.state.periodTimeDialog?.draftTimes || [];
        const updated = draftTimes.map(t =>
            t.period === period
                ? { ...t, start, end, manualOverride: true }
                : t
        );

        this.state.periodTimeDialog.draftTimes = updated;
        this.render();
    }

    clearManualOverride(period) {
        const config = this.state.periodTimeDialog?.segmentConfig;
        const draftTimes = this.buildPeriodTimesFromSegments(config, null, []);

        this.state.periodTimeDialog.draftTimes = draftTimes;
        this.render();
    }

    togglePeriodEnabled(period) {
        const disabledSet = new Set(this.state.project.disabledPeriods || []);

        if (disabledSet.has(period)) {
            disabledSet.delete(period);
        } else {
            disabledSet.add(period);
        }

        this.state.project.disabledPeriods = Array.from(disabledSet).sort((a, b) => a - b);
        this.render();
    }
}

TimetablePlannerController.reviewContextBuilder = buildConstraintReviewContext;
Object.assign(TimetablePlannerController.prototype, constraintChatControllerMethods);
Object.assign(TimetablePlannerController.prototype, smartHelperMethods);
Object.assign(TimetablePlannerController.prototype, constraintDialogMethods);
Object.assign(TimetablePlannerController.prototype, constraintDialogAdvancedMethods);
