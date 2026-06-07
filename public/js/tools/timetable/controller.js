import {
    normalizeApiError,
    requestTimetable,
} from './api.js';
import {
    exportName,
    readLockedSlotForm,
    readProjectForm,
    readRulesForm,
    sampleRosterText,
} from './forms.js';
import { bindGridInteractions } from './grid-interactions.js';
import {
    ensureOwnerSelection,
} from './selectors.js';
import {
    cloneValue,
    createTimetablePlannerState,
} from './state.js';
import { renderWorkbench } from './view.js';

export class TimetablePlannerController {
    constructor() {
        this.state = createTimetablePlannerState();
    }

    async init(container) {
        this.state.container = container;
        await this.load();
    }

    destroy() {
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

    async saveProject() {
        try {
            const result = await requestTimetable('/project', {
                method: 'POST',
                body: JSON.stringify(readProjectForm(this.state.container)),
            });
            this.applyProject(result.project);
            this.setMessage('项目已保存。');
        } catch (error) {
            this.handleError(error);
        }
    }

    fillSample() {
        const textarea = this.state.container.querySelector('#tt-import-text');
        if (textarea) textarea.value = sampleRosterText();
    }

    async importRoster() {
        try {
            const file = this.state.container.querySelector('#tt-import-file')?.files?.[0];
            let options;
            if (file) {
                const body = new FormData();
                body.append('file', file);
                options = { method: 'POST', body };
            } else {
                const text = this.state.container.querySelector('#tt-import-text')?.value || '';
                options = { method: 'POST', body: JSON.stringify({ text }) };
            }
            const result = await requestTimetable('/roster/import', options);
            this.applyProject(result.project);
            this.state.viewMode = 'class';
            this.state.selectedSlotId = '';
            this.setMessage(`已导入 ${result.import.count} 条任课信息。`);
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
            this.setMessage('约束已保存。');
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
            this.state.message = result.schedule.score.unplacedLessons
                ? `生成完成，还有 ${result.schedule.score.unplacedLessons} 节未排。`
                : '课表已生成。';
            this.state.lastFailure = null;
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
