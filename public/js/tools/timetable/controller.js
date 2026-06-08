import {
    normalizeApiError,
    requestTimetable,
} from './api.js';
import {
    buildBulkRules,
    exportName,
    readLockedSlotForm,
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

    resetRangeDraft() {
        this.syncRangeDraftFromProject();
        this.render();
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
    }

    readRosterImportText() {
        return this.state.container?.querySelector('#tt-roster-import-text')?.value ?? this.state.rosterImport?.text ?? '';
    }

    resetRosterImport() {
        this.rosterImportFile = null;
        this.state.rosterImport = {
            open: false,
            mode: 'file',
            fileName: '',
            text: '',
        };
    }

    openRosterImport(mode = 'file') {
        this.state.rosterImport = {
            ...(this.state.rosterImport || {}),
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
            mode: 'text',
            text: sampleRosterText(),
        };
        this.render();
    }

    async confirmRosterImport() {
        const text = this.readRosterImportText();
        await this.importRoster({
            file: this.state.rosterImport?.mode === 'file' ? this.rosterImportFile : null,
            text,
        });
    }

    async importRoster({ file = null, text = '' } = {}) {
        try {
            let options;
            if (file) {
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
        try {
            const result = await requestTimetable('/rules/parse', {
                method: 'POST',
                body: JSON.stringify({ text: readRulePrompt(this.state.container) }),
            });
            this.state.ruleDraft = result.draftRules;
            this.state.ruleDraftPreview = result.previewItems || [];
            this.state.ruleWarnings = result.warnings || [];
            this.setMessage('AI 约束已解析，请确认草稿。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async confirmRuleDraft() {
        if (!this.state.ruleDraft) {
            this.setMessage('请先解析约束草稿。');
            return;
        }
        try {
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules: this.state.ruleDraft }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.clearRuleDraft();
            this.setMessage('AI 约束已确认。');
        } catch (error) {
            this.handleError(error);
        }
    }

    async addBulkRule() {
        try {
            const form = readBulkRuleForm(this.state.container);
            if (!form.targetIds.length) throw new Error('请先选择规则对象。');
            if (form.type !== 'subject_morning' && (!form.days.length || !form.periods.length)) {
                throw new Error('请先选择周几和节次。');
            }
            const rules = buildBulkRules(this.state.project, form);
            const result = await requestTimetable('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });
            this.applyProject(result.project);
            this.clearOptimizationPolling();
            this.state.solverJob = null;
            this.clearRuleDraft();
            this.setMessage('批量规则已添加。');
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
