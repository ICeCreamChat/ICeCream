import {
    normalizeApiError,
    requestTimetable,
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
    getSavedRuleItems,
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

    applyProject(project) {
        this.state.project = project;
        this.state.selectedOwnerId = ensureOwnerSelection(this.state);
        this.syncRangeDraftFromProject();
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
            weekdays: activeWeekdays.length ? Math.max(...activeWeekdays) : 5,
            periodsPerDay: activePeriods.length ? Math.max(...activePeriods) : 7,
        };
    }

    async applyRangeDraft() {
        this.updateRangeDraftFromForm();
        await this.saveProject(this.rangePayloadFromDraft());
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
        this.state.ruleDraft = null;
        this.state.ruleDraftPreview = [];
        this.state.ruleWarnings = [];
        this.state.ruleDraftInputType = '';
        this.state.ruleContextStats = null;
        this.state.ruleUnsupportedItems = [];
        this.state.ruleFileName = '';
        this.resetRuleReview();
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

    // ── 新卡片式 AI 约束交互 ──

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
            this.state.pendingRules = [...rows, ...(this.state.pendingRules || [])];
            this.state.ruleInput = { text: '', fileName: '', loading: false };
            this.ruleReviewFile = null;
            // legacy sync
            this.setRuleReviewState(result);
            this.setMessage(rows.length
                ? `已解析 ${rows.length} 条约束，请逐条确认。`
                : '未能解析出可用约束，请调整描述后重试。');
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
            await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: normalized.draftRules }),
            });
            await this.refreshProject();
            this.state.pendingRules = pending.filter(item => item.id !== ruleId);
            if (this.state.expandedRuleId === ruleId) this.state.expandedRuleId = null;
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.setMessage('约束已生效。');
        } catch (error) {
            this.handleError(error);
        }
    }

    rejectRule(ruleId) {
        this.state.pendingRules = (this.state.pendingRules || []).filter(item => item.id !== ruleId);
        if (this.state.expandedRuleId === ruleId) this.state.expandedRuleId = null;
        this.render();
    }

    async acceptAllRules() {
        const pending = (this.state.pendingRules || []).filter(
            item => !['suggestion', 'unsupported'].includes(item.status),
        );
        if (!pending.length) {
            this.setMessage('没有可直接接受的约束。');
            return;
        }
        try {
            const normalized = await requestTimetable('/rules/normalize', {
                method: 'POST',
                body: JSON.stringify({ draftRows: pending }),
            });
            const effectiveCount = (normalized.draftRows || []).filter(row => row.status === 'effective').length;
            if (!effectiveCount) {
                this.setMessage('这些约束都无法自动生效，请逐条编辑。');
                return;
            }
            await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: normalized.draftRules }),
            });
            await this.refreshProject();
            const acceptedIds = new Set(pending.map(item => item.id));
            this.state.pendingRules = (this.state.pendingRules || []).filter(item => !acceptedIds.has(item.id));
            this.state.expandedRuleId = null;
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.setMessage(`已接受 ${effectiveCount} 条约束。`);
        } catch (error) {
            this.handleError(error);
        }
    }

    rejectAllRules() {
        this.state.pendingRules = [];
        this.state.expandedRuleId = null;
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
        const hasBlockingIssues = draftRows.some(row => ['invalid'].includes(row.status));
        this.state.ruleReview = {
            ...(this.state.ruleReview || {}),
            open: true,
            step: 'review',
            mode: this.state.ruleReview?.mode || 'text',
            fileName: this.state.ruleReview?.fileName || this.state.ruleFileName || '',
            text: this.readRuleReviewText(),
            draftRows,
            inputType: payload.inputType || this.state.ruleReview?.inputType || '',
            contextStats: payload.contextStats || null,
            warnings,
            unsupportedItems: payload.unsupportedItems || [],
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
        this.state.rosterImport = {
            ...createTimetablePlannerState().rosterImport,
            open: true,
            mode: mode === 'text' ? 'text' : 'file',
        };
        this.render();
    }

    closeRosterImport() {
        this.resetRosterImport();
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

    async refreshOptimizationJob(jobId) {
        try {
            const result = await requestTimetable(`/schedule/jobs/${encodeURIComponent(jobId)}`);
            this.state.solverJob = result.job;
            if (result.job.status === 'completed' && result.job.accepted) {
                const data = await requestTimetable('/bootstrap');
                this.applyProject(data.project);
                this.state.message = 'Timefold 优化已应用。';
            } else if (result.job.status === 'completed') {
                this.state.message = '快速课表已保留。';
            } else if (result.job.status === 'failed') {
                this.state.message = 'Timefold 优化未完成，快速课表已保留。';
            }
            this.render();
            this.startOptimizationPolling(result.job);
        } catch {
            this.clearOptimizationPolling();
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
            teacherName: String(row.teacherName ?? '').trim(),
            weeklyHours: String(row.weeklyHours ?? '').trim(),
            blockPreference: ['single', 'double', 'mixed'].includes(row.blockPreference) ? row.blockPreference : 'single',
            roomName: String(row.roomName ?? '').trim(),
            manual: Boolean(row.manual),
            issues: Array.isArray(row.issues) ? row.issues : [],
        };
    }

    rosterDraftRowHasValue(row) {
        return Boolean(row.manual) || ['grade', 'className', 'subjectName', 'teacherName', 'weeklyHours', 'roomName']
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
                this.setRuleReviewProgress('parse_ai', 'AI 解析约束中...', { step: 'input', mode: 'file' });
            } else {
                this.setRuleReviewProgress('parse_text', 'AI 理解自然语言中...', { step: 'input', mode: 'text' });
                await this.waitForRuleReviewFrame();
                options = {
                    method: 'POST',
                    body: JSON.stringify({ text }),
                };
            }
            const result = await requestTimetable('/rules/parse', options);
            this.setRuleReviewProgress('build_review', '生成复核表中...', { step: 'input', mode: hasFile ? 'file' : 'text' });
            this.setRuleReviewState(result);
            const total = (result.draftRows || []).length;
            const effective = (result.draftRows || []).filter(row => row.status === 'effective').length;
            this.setMessage(total
                ? `已解析 ${total} 条约束（${effective} 条可直接生效），请在复核表确认。`
                : '未能解析出可用约束，请调整描述后重试。');
        } catch (error) {
            this.stopRuleReviewProgress('解析失败，请调整后重试。', 'warning');
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
            this.clearRuleDraft();
            this.state.ruleReview = {
                ...createTimetablePlannerState().ruleReview,
                open: true,
                step: 'saved',
                mode: 'file',
            };
            this.setMessage('AI 约束已确认。');
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
            this.clearRuleDraft();
            this.setMessage('锁定课节已移除。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async runSchedule() {
        this.state.loading = true;
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
            this.state.loading = false;
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
            this.clearRuleDraft();
            if (payload.type === 'clear') this.state.selectedSlotId = '';
            this.setMessage(result.schedule.conflicts.length ? '已调整，当前仍有冲突。' : '已调整。');
        } catch (error) {
            this.handleError(error, { keepFailure: true });
        }
    }

    async export(type) {
        try {
            const response = await requestTimetable('/export', {
                method: 'POST',
                body: JSON.stringify({ type }),
                raw: true,
            });
            if (!response.ok) {
                const payload = await response.json();
                throw new Error(payload.error || '导出失败');
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${exportName(type)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            this.setMessage('导出已开始。');
        } catch (error) {
            this.handleError(error);
        }
    }

    handleError(error, options = {}) {
        const normalized = normalizeApiError(error);
        if (normalized.project) {
            this.applyProject(normalized.project);
        }
        this.state.message = normalized.message;
        this.state.lastFailure = options.keepFailure ? normalized : null;
        this.render();
    }
}
