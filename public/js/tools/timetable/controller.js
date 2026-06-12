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
import { bindGridInteractions } from './grid-interactions.js';
import {
    ensureOwnerSelection,
    getActivePeriods,
    getActiveWeekdays,
    getPublishedScheduleDiff,
    getSavedRuleItems,
    getVisibleSlots,
    removeSavedRuleById,
} from './selectors.js';
import {
    cloneValue,
    createTimetablePlannerState,
} from './state.js';
import { renderWorkbench } from './view.js';

export class TimetablePlannerController {
    constructor() {
        this.state = createTimetablePlannerState();
        this.jobPollTimer = null;
        this.rosterImportFile = null;
        this.ruleReviewFile = null;
        this.rosterDraftCounter = 0;
        this.ruleDraftCounter = 0;
    }

    async init(container) {
        this.state.container = container;
        await this.load();
    }

    destroy() {
        this.clearOptimizationPolling();
        this.state.container = null;
    }

    render() {
        const { container } = this.state;
        if (!container) return;
        if (this.state.project) {
            this.state.selectedOwnerId = ensureOwnerSelection(this.state);
        }
        container.innerHTML = renderWorkbench(this.state);
        bindGridInteractions(container, this, this.state);
        window.lucide?.createIcons();
    }

    setMessage(message, failure = null) {
        this.state.message = message || '';
        this.state.lastFailure = failure;
        this.render();
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
        this.render();
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
        return ['data'];
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

    syncRangeDraftFromProject() {
        if (!this.state.project) {
            this.state.rangeDraft = null;
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
        this.state.rangeDraft = {
            activeWeekdays: payload.activeWeekdays,
            activePeriods: payload.activePeriods,
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
        this.readPeriodTimesFromDom();
        await this.saveProject(this.rangePayloadFromDraft());
    }

    autoFillPeriodTimes() {
        const activePeriods = this.state.rangeDraft?.activePeriods || getActivePeriods(this.state.project);
        const startHour = 8;
        const durationMinutes = 40;
        const breakMinutes = 10;
        const lunchMinutes = 60;
        const lunchAfterPeriod = Math.ceil(activePeriods.length / 2);
        let minutes = startHour * 60;
        const times = activePeriods.map((period, index) => {
            if (period > activePeriods[0] && index === activePeriods.filter(p => p <= activePeriods[lunchAfterPeriod - 1]).length) {
                const morningEnd = startHour * 60 + lunchAfterPeriod * durationMinutes + (lunchAfterPeriod - 1) * breakMinutes;
                minutes = morningEnd + lunchMinutes;
            }
            const start = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
            minutes += durationMinutes;
            const end = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
            minutes += breakMinutes;
            return { period, start, end };
        });
        this.state.rangeDraft = { ...(this.state.rangeDraft || {}), periodTimes: times };
        this.render();
        this.setMessage('已填充默认时间模板。');
    }

    readPeriodTimesFromDom() {
        if (!this.state.container) return;
        const rows = this.state.container.querySelectorAll('[data-period-time-row]');
        if (!rows.length) return;
        const times = [];
        rows.forEach(row => {
            const period = Number(row.dataset.periodTimeRow);
            const startInput = row.querySelector('[data-period-time-start]');
            const endInput = row.querySelector('[data-period-time-end]');
            const start = startInput?.value || '';
            const end = endInput?.value || '';
            if (start || end) times.push({ period, start, end });
        });
        this.state.rangeDraft = { ...(this.state.rangeDraft || {}), periodTimes: times };
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

    openRuleReview(mode = 'file') {
        const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'file';
        const current = this.state.ruleReview || {};
        const draftRows = (current.draftRows || []).length ? (current.draftRows || []) : (this.state.pendingRules || []);
        if (draftRows.length) {
            this.state.ruleReview = {
                ...current,
                open: true,
                step: 'review',
                draftRows,
            };
            this.render();
            return;
        }
        if (getSavedRuleItems(this.state.project).length) {
            this.state.ruleReview = {
                ...createTimetablePlannerState().ruleReview,
                open: true,
                step: 'saved',
                mode: nextMode,
            };
            this.render();
            return;
        }
        this.state.ruleReview = {
            ...createTimetablePlannerState().ruleReview,
            open: true,
            step: nextMode === 'manual' ? 'manual' : 'input',
            mode: nextMode,
        };
        this.render();
    }

    startRuleReviewInput(mode = 'file') {
        const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'file';
        const current = this.state.ruleReview || {};
        this.state.ruleReview = {
            ...current,
            open: true,
            step: nextMode === 'manual' ? 'manual' : 'input',
            mode: nextMode,
            text: this.readRuleReviewText(),
        };
        this.render();
    }

    closeRuleReview() {
        this.state.ruleReview = {
            ...(this.state.ruleReview || createTimetablePlannerState().ruleReview),
            open: false,
        };
        this.render();
    }

    setRuleReviewProgress(phase, phaseText, { tone = '', step = null, mode = null } = {}) {
        this.state.ruleReview = {
            ...createTimetablePlannerState().ruleReview,
            ...(this.state.ruleReview || {}),
            open: true,
            step: step || this.state.ruleReview?.step || 'input',
            mode: mode || this.state.ruleReview?.mode || 'file',
            loading: true,
            phase,
            phaseText,
            phaseTone: tone,
            text: this.state.ruleReview?.text ?? this.readRuleReviewText(),
        };
        this.render();
    }

    stopRuleReviewProgress(phaseText = '', tone = '') {
        this.state.ruleReview = {
            ...createTimetablePlannerState().ruleReview,
            ...(this.state.ruleReview || {}),
            loading: false,
            phase: tone ? 'error' : '',
            phaseText,
            phaseTone: tone,
        };
        this.render();
    }

    async waitForRuleReviewFrame() {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
        await new Promise(resolve => window.requestAnimationFrame(resolve));
    }

    setRuleReviewMode(mode) {
        const nextMode = ['text', 'file', 'manual'].includes(mode) ? mode : 'text';
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            open: true,
            step: nextMode === 'manual' ? 'manual' : 'input',
            mode: nextMode,
            text: this.readRuleReviewText(),
        };
        this.render();
    }

    selectRuleReviewFile(file) {
        this.ruleReviewFile = file || null;
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            open: true,
            step: 'input',
            mode: 'file',
            fileName: file?.name || '',
            text: this.readRuleReviewText(),
        };
        this.state.ruleFileName = file?.name || '';
        this.render();
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
            mode: 'text',
            text: next,
        };
        this.render();
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
                review: `已解析 ${rows.length} 条约束，其中 ${reviewCount} 条需要复核。`,
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
            this.setMessage('没有可一键应用的高置信度约束；存在歧义、冲突或需要复核的规则请先处理。');
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
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            open: true,
            step: 'review',
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
            confidenceSummary: payload.confidenceSummary || { high: 0, medium: 0, low: 0 },
            nextAction: payload.nextAction || '',
            diagnosis: payload.diagnosis || this.state.ruleReview?.diagnosis || null,
            hasBlockingIssues,
            loading: false,
            phase: '',
            phaseText: '',
            phaseTone: '',
        };
        this.state.ruleDraft = payload.draftRules || this.state.ruleDraft;
        this.state.ruleDraftPreview = payload.previewItems || draftRows;
        this.state.ruleWarnings = warnings;
        this.state.ruleDraftInputType = payload.inputType || '';
        this.state.ruleContextStats = payload.contextStats || null;
        this.state.ruleUnsupportedItems = payload.unsupportedItems || [];
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
        this.render();
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
            stats: null,
            warnings: [],
            issues: [],
            hasBlockingIssues: false,
        };
    }

    openRosterImport(mode = 'file') {
        const nextMode = mode === 'text' ? 'text' : 'file';
        const current = this.state.rosterImport || createTimetablePlannerState().rosterImport;
        const hasDraftRows = Array.isArray(current.draftRows) && current.draftRows.length > 0;
        const hasInputDraft = Boolean(current.text || current.fileName || this.rosterImportFile);
        if (hasDraftRows) {
            this.state.rosterImport = {
                ...current,
                open: true,
                step: 'review',
                mode: current.mode || nextMode,
            };
        } else if (hasInputDraft) {
            this.state.rosterImport = {
                ...createTimetablePlannerState().rosterImport,
                ...current,
                open: true,
                step: 'input',
                mode: current.mode || nextMode,
            };
        } else {
            this.state.rosterImport = {
                ...createTimetablePlannerState().rosterImport,
                open: true,
                mode: nextMode,
            };
        }
        this.render();
    }

    closeRosterImport() {
        this.state.rosterImport = {
            ...(this.state.rosterImport || createTimetablePlannerState().rosterImport),
            open: false,
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
                issues: [],
            };
        });
    }

    normalizeRosterDraftRow(row = {}, index = 0) {
        return {
            id: row.id || this.nextRosterDraftId(),
            grade: String(row.grade ?? '').trim(),
            className: String(row.className ?? '').trim(),
            subjectName: String(row.subjectName ?? '').trim(),
            subjectCategory: ['main', 'quality', 'lab', 'normal'].includes(row.subjectCategory) ? row.subjectCategory : 'normal',
            subjectTags: Array.isArray(row.subjectTags) ? row.subjectTags.join('、') : String(row.subjectTags ?? '').trim(),
            teacherName: String(row.teacherName ?? '').trim(),
            weeklyHours: String(row.weeklyHours ?? '').trim(),
            blockPreference: ['single', 'double', 'mixed'].includes(row.blockPreference) ? row.blockPreference : 'single',
            roomName: String(row.roomName ?? '').trim(),
            manual: Boolean(row.manual),
            issues: Array.isArray(row.issues) ? row.issues : [],
        };
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
            const issue = { rowId: row.id, severity, field, message };
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
        const analyzed = this.analyzeRosterDraftRows(payload.draftRows || []);
        const issues = Array.isArray(payload.issues) && payload.issues.length ? payload.issues : analyzed.issues;
        const warnings = Array.isArray(payload.warnings) && payload.warnings.length ? payload.warnings : analyzed.warnings;
        this.state.rosterImport = {
            ...(this.state.rosterImport || {}),
            open: true,
            step: 'review',
            source: payload.source || this.state.rosterImport?.source || null,
            draftRows: (payload.draftRows || analyzed.draftRows).map((row, index) => this.normalizeRosterDraftRow(row, index)),
            stats: payload.stats || analyzed.stats,
            warnings,
            issues,
            hasBlockingIssues: Boolean(payload.hasBlockingIssues) || issues.some(issue => issue.severity === 'error'),
        };
    }

    readRosterReviewRows() {
        return [...(this.state.container?.querySelectorAll('[data-roster-review-row]') || [])].map(row => {
            const value = field => row.querySelector(`[data-roster-field="${field}"]`)?.value?.trim() || '';
            return {
                id: row.dataset.rosterReviewRow || this.nextRosterDraftId(),
                grade: value('grade'),
                className: value('className'),
                subjectName: value('subjectName'),
                subjectCategory: value('subjectCategory') || 'normal',
                subjectTags: value('subjectTags'),
                teacherName: value('teacherName'),
                weeklyHours: value('weeklyHours'),
                blockPreference: value('blockPreference') || 'single',
                roomName: value('roomName'),
            };
        });
    }

    refreshRosterReviewFromRows(rows) {
        this.setRosterReviewState(this.analyzeRosterDraftRows(rows));
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
            const result = await requestTimetable('/roster/preview', {
                method: 'POST',
                body: JSON.stringify({ text }),
            });
            this.refreshRosterReviewFromRows([...this.readRosterReviewRows(), ...(result.draftRows || [])]);
        } catch (error) {
            this.handleError(error);
        }
    }

    async previewRosterImport() {
        try {
            const text = this.readRosterImportText();
            let options;
            if (this.state.rosterImport?.mode === 'file' && this.rosterImportFile) {
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
            this.handleError(error);
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
        } catch (error) {
            this.handleError(error);
        }
    }

    async clearRoster() {
        try {
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
                review: `已解析 ${total} 条约束，其中 ${reviewCount} 条需要复核。`,
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
            this.render();
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
            this.setMessage('智能诊断已更新。');
        } catch (error) {
            this.stopRuleReviewProgress('诊断失败，请稍后重试。', 'warning');
            this.handleError(error);
        }
    }

    async confirmRuleDraft() {
        const rows = this.state.ruleReview?.step === 'review'
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
                this.clearOptimizationPolling();
                this.state.solverJob = null;
                this.state.lastFailure = null;
                this.state.selectedSlotId = '';
                this.clearRuleDraft();
                this.state.ruleReview = {
                    ...createTimetablePlannerState().ruleReview,
                    open: true,
                    step: 'saved',
                    mode: 'file',
                };
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
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.state.lastFailure = null;
            this.state.selectedSlotId = '';
            this.clearRuleDraft();
            this.state.ruleReview = {
                ...createTimetablePlannerState().ruleReview,
                open: true,
                step: 'saved',
                mode: 'file',
            };
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
        this.state.solvePhaseText = '检查数据中';
        const phaseTimers = [
            setTimeout(() => {
                if (!this.state.loading) return;
                this.state.solvePhaseText = '快速生成中';
                this.render();
            }, 80),
            setTimeout(() => {
                if (!this.state.loading) return;
                this.state.solvePhaseText = '局部优化中';
                this.render();
            }, 500),
        ];
        this.render();
        try {
            const result = await requestTimetable('/schedule/run', { method: 'POST' });
            this.applyProject(result.project);
            this.state.viewMode = 'class';
            this.state.selectedOwnerId = this.state.project.classes[0]?.id || this.state.project.teachers[0]?.id || '';
            this.state.selectedSlotId = '';
            this.state.solverJob = result.solverJob || null;
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
            this.render();
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
                body: JSON.stringify({ type, ...(options.publishedVersion ? { publishedVersion: options.publishedVersion } : {}) }),
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
        this.render();
    }
}
