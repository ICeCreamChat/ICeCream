class TimetablePlanner {
    constructor() {
        this.container = null;
        this.project = null;
        this.viewMode = 'class';
        this.selectedOwnerId = '';
        this.selectedSlotId = '';
        this.loading = false;
        this.message = '';
        this.dragSlotId = '';
    }

    async init(container) {
        this.container = container;
        await this.load();
    }

    destroy() {
        this.container = null;
    }

    async request(path, options = {}) {
        const response = await fetch(`/api/tools/timetable${path}`, {
            ...options,
            headers: {
                ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
                ...(options.headers || {}),
            },
        });
        if (options.raw) return response;
        const payload = await response.json();
        if (!response.ok || payload.success === false) {
            const error = new Error(payload.error || 'Request failed');
            error.payload = payload;
            error.status = response.status;
            throw error;
        }
        return payload.data;
    }

    async load() {
        this.loading = true;
        this.renderShell();
        try {
            const data = await this.request('/bootstrap');
            this.project = data.project;
            this.ensureOwnerSelection();
            this.message = '';
        } catch (error) {
            this.message = error.message || '加载失败';
        } finally {
            this.loading = false;
            this.renderShell();
        }
    }

    get owners() {
        if (!this.project) return [];
        if (this.viewMode === 'teacher') return this.project.teachers;
        if (this.viewMode === 'master') return [{ id: 'master', name: '总表' }];
        return this.project.classes;
    }

    ensureOwnerSelection() {
        if (!this.project) return;
        if (this.viewMode === 'master') {
            this.selectedOwnerId = 'master';
            return;
        }
        const owners = this.owners;
        if (!owners.some(owner => owner.id === this.selectedOwnerId)) {
            this.selectedOwnerId = owners[0]?.id || '';
        }
    }

    setMessage(message) {
        this.message = message || '';
        this.renderShell();
    }

    getScore() {
        return this.project?.schedule?.score || {};
    }

    totalPlannedLessons() {
        return (this.project?.lessonPlans || []).reduce((sum, plan) => sum + Number(plan.weeklyHours || 0), 0);
    }

    async saveProject() {
        try {
            const form = this.container.querySelector('#tt-project-form');
            const data = new FormData(form);
            const result = await this.request('/project', {
                method: 'POST',
                body: JSON.stringify({
                    schoolName: data.get('schoolName'),
                    term: data.get('term'),
                    weekdays: Number(data.get('weekdays')),
                    periodsPerDay: Number(data.get('periodsPerDay')),
                }),
            });
            this.project = result.project;
            this.ensureOwnerSelection();
            this.setMessage('项目已保存');
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    sampleText() {
        return [
            '年级,班级,课程,教师,周课时,连堂',
            '七年级,1班,数学,陈老师,4,单节',
            '七年级,1班,语文,林老师,5,混合',
            '七年级,1班,英语,周老师,4,单节',
            '七年级,1班,体育,许老师,2,双连堂',
            '七年级,2班,数学,陈老师,4,单节',
            '七年级,2班,语文,赵老师,5,混合',
            '七年级,2班,英语,周老师,4,单节',
            '七年级,2班,音乐,钱老师,1,单节',
        ].join('\n');
    }

    fillSample() {
        const textarea = this.container.querySelector('#tt-import-text');
        if (textarea) textarea.value = this.sampleText();
    }

    async importRoster() {
        try {
            const file = this.container.querySelector('#tt-import-file')?.files?.[0];
            let options;
            if (file) {
                const body = new FormData();
                body.append('file', file);
                options = { method: 'POST', body };
            } else {
                const text = this.container.querySelector('#tt-import-text')?.value || '';
                options = { method: 'POST', body: JSON.stringify({ text }) };
            }
            const result = await this.request('/roster/import', options);
            this.project = result.project;
            this.viewMode = 'class';
            this.selectedOwnerId = this.project.classes[0]?.id || '';
            this.selectedSlotId = '';
            this.setMessage(`已导入 ${result.import.count} 条任课信息`);
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    async saveRules() {
        try {
            const teacherId = this.container.querySelector('#tt-rule-teacher')?.value;
            const teacherSlots = this.parseSlotInput(this.container.querySelector('#tt-rule-teacher-slots')?.value);
            const classId = this.container.querySelector('#tt-rule-class')?.value;
            const classSlots = this.parseSlotInput(this.container.querySelector('#tt-rule-class-slots')?.value);
            const morningSubjects = [...this.container.querySelectorAll('[data-morning-subject]:checked')].map(item => item.value);
            const rules = structuredClone(this.project.rules || { hardRules: {}, softRules: {} });
            rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
            rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
            if (teacherId) rules.hardRules.teacherUnavailable[teacherId] = teacherSlots;
            if (classId) rules.hardRules.classUnavailable[classId] = classSlots;
            rules.softRules = { ...(rules.softRules || {}), morningSubjects };

            const result = await this.request('/rules', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });
            this.project = result.project;
            this.setMessage('规则已保存');
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    async addLockedSlot() {
        try {
            const rules = structuredClone(this.project.rules || { hardRules: {}, softRules: {} });
            rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
            const locked = {
                day: Number(this.container.querySelector('#tt-lock-day')?.value),
                period: Number(this.container.querySelector('#tt-lock-period')?.value),
                classId: this.container.querySelector('#tt-lock-class')?.value,
                subjectId: this.container.querySelector('#tt-lock-subject')?.value,
                teacherId: this.container.querySelector('#tt-lock-teacher')?.value,
            };
            const plan = this.project.lessonPlans.find(item => (
                item.classId === locked.classId
                && item.subjectId === locked.subjectId
                && item.teacherId === locked.teacherId
            ));
            if (plan) locked.lessonPlanId = plan.id;
            rules.hardRules.lockedSlots.push(locked);
            const result = await this.request('/rules', { method: 'POST', body: JSON.stringify({ rules }) });
            this.project = result.project;
            this.setMessage('锁定课节已添加');
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    async removeLockedSlot(index) {
        try {
            const rules = structuredClone(this.project.rules || { hardRules: {}, softRules: {} });
            rules.hardRules.lockedSlots = (rules.hardRules.lockedSlots || []).filter((_, itemIndex) => itemIndex !== index);
            const result = await this.request('/rules', { method: 'POST', body: JSON.stringify({ rules }) });
            this.project = result.project;
            this.setMessage('锁定课节已移除');
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    parseSlotInput(value = '') {
        return String(value)
            .split(/[,，;；\s]+/)
            .map(item => item.trim())
            .filter(item => /^\d+-\d+$/.test(item));
    }

    async runSchedule() {
        this.loading = true;
        this.renderShell();
        try {
            const result = await this.request('/schedule/run', { method: 'POST' });
            this.project = result.project;
            this.viewMode = 'class';
            this.selectedOwnerId = this.project.classes[0]?.id || this.project.teachers[0]?.id || '';
            this.selectedSlotId = '';
            this.message = result.schedule.score.unplacedLessons
                ? `生成完成，还有 ${result.schedule.score.unplacedLessons} 节未排`
                : '课表已生成';
        } catch (error) {
            if (error.payload?.data?.project) {
                this.project = error.payload.data.project;
                this.ensureOwnerSelection();
            }
            this.message = error.payload?.data?.reason === 'not_configured'
                ? 'Timefold solver is not available; previous schedule was kept'
                : `Timefold scheduling failed; previous schedule was kept${error.message ? `: ${error.message}` : ''}`;
        } finally {
            this.loading = false;
            this.renderShell();
        }
    }

    async adjustSlot(payload) {
        try {
            const result = await this.request('/schedule/adjust', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            this.project = result.project;
            if (payload.type === 'clear') this.selectedSlotId = '';
            this.message = result.schedule.conflicts.length ? '已调整，存在冲突' : '已调整';
            this.renderShell();
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    async export(type) {
        try {
            const response = await this.request('/export', {
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
            const name = type === 'teacher' ? '教师课表' : type === 'plans' ? '任课信息' : type === 'master' ? '总课表' : '班级课表';
            link.href = url;
            link.download = `${name}_${new Date().toISOString().slice(0, 10)}.xlsx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            this.setMessage(error.message);
        }
    }

    renderShell() {
        if (!this.container) return;
        if (!this.project) {
            this.container.innerHTML = `<div class="tt-loading">${this.loading ? '正在加载...' : this.escape(this.message || '暂无数据')}</div>`;
            return;
        }
        this.ensureOwnerSelection();

        this.container.innerHTML = `
            <div class="tt-app">
                <main class="tt-main">
                    <aside class="tt-panel">
                        ${this.renderControlPanel()}
                    </aside>
                    <section class="tt-board">
                        ${this.renderBoard()}
                        ${this.renderStatusBar()}
                    </section>
                </main>
            </div>
        `;
        this.bindEvents();
        window.lucide?.createIcons();
    }

    renderControlPanel() {
        return `
            <div class="tt-project-card">
                <div>
                    <span class="tt-eyebrow">当前项目</span>
                    <h2>${this.escape(this.project.schoolName)}</h2>
                    <p>${this.escape(this.project.term)} · ${this.project.weekdays} 天 × ${this.project.periodsPerDay} 节</p>
                </div>
                ${this.renderStats()}
            </div>
            ${this.renderProjectSection()}
            ${this.renderImportSection()}
            ${this.renderRulesSection()}
            ${this.renderGenerateSection()}
            ${this.renderExportSection()}
        `;
    }

    renderProjectSection() {
        return `
            <section class="tt-section">
                <div class="tt-section-header">
                    <h3><i data-lucide="school"></i><span>项目</span></h3>
                    <button class="tt-icon-btn" id="tt-save-project" type="button" title="保存项目" aria-label="保存项目"><i data-lucide="save"></i></button>
                </div>
                <form id="tt-project-form" class="tt-form-grid">
                    <label><span>学校</span><input name="schoolName" value="${this.escapeAttr(this.project.schoolName)}"></label>
                    <label><span>学期</span><input name="term" value="${this.escapeAttr(this.project.term)}"></label>
                    <label><span>周天数</span><input name="weekdays" type="number" min="1" max="7" value="${this.project.weekdays}"></label>
                    <label><span>日节数</span><input name="periodsPerDay" type="number" min="1" max="12" value="${this.project.periodsPerDay}"></label>
                </form>
            </section>
        `;
    }

    renderImportSection() {
        return `
            <section class="tt-section">
                <div class="tt-section-header">
                    <h3><i data-lucide="database"></i><span>任课数据</span></h3>
                    <span class="tt-count-chip">${this.project.lessonPlans.length} 条</span>
                </div>
                <textarea id="tt-import-text" class="tt-import-text" spellcheck="false" placeholder="年级,班级,课程,教师,周课时,连堂"></textarea>
                <div class="tt-actions">
                    <label class="tt-file-btn">
                        <i data-lucide="paperclip"></i>
                        <span>文件</span>
                        <input id="tt-import-file" type="file" accept=".csv,.txt,.xlsx,.xls">
                    </label>
                    <button class="tt-btn" id="tt-fill-sample" type="button"><i data-lucide="wand-sparkles"></i><span>示例</span></button>
                    <button class="tt-btn tt-btn--primary" id="tt-import-roster" type="button"><i data-lucide="upload"></i><span>导入</span></button>
                </div>
                ${this.renderPlanTable()}
            </section>
        `;
    }

    renderRulesSection() {
        const hard = this.project.rules?.hardRules || {};
        const soft = this.project.rules?.softRules || {};
        return `
            <section class="tt-section">
                <div class="tt-section-header">
                    <h3><i data-lucide="sliders-horizontal"></i><span>规则</span></h3>
                    <button class="tt-icon-btn" id="tt-save-rules" type="button" title="保存规则" aria-label="保存规则"><i data-lucide="save"></i></button>
                </div>
                <div class="tt-form-grid">
                    <label><span>教师不可排</span>${this.renderSelect('tt-rule-teacher', this.project.teachers, 'name')}</label>
                    <label><span>节次</span><input id="tt-rule-teacher-slots" placeholder="1-1, 3-5"></label>
                    <label><span>班级不可排</span>${this.renderSelect('tt-rule-class', this.project.classes, item => `${item.grade}${item.name}`)}</label>
                    <label><span>节次</span><input id="tt-rule-class-slots" placeholder="2-4, 5-7"></label>
                </div>
                <div class="tt-rule-block">
                    <span class="tt-rule-title">上午优先</span>
                    <div class="tt-chip-grid">
                        ${this.project.subjects.map(subject => `
                            <label class="tt-check-chip">
                                <input type="checkbox" data-morning-subject value="${this.escapeAttr(subject.id)}" ${soft.morningSubjects?.includes(subject.id) ? 'checked' : ''}>
                                <span>${this.escape(subject.name)}</span>
                            </label>
                        `).join('') || '<span class="tt-muted">导入课程后可设置</span>'}
                    </div>
                </div>
                <div class="tt-rule-block">
                    <span class="tt-rule-title">锁定课节</span>
                    <div class="tt-form-grid tt-form-grid--lock">
                        <label><span>班级</span>${this.renderSelect('tt-lock-class', this.project.classes, item => `${item.grade}${item.name}`)}</label>
                        <label><span>课程</span>${this.renderSelect('tt-lock-subject', this.project.subjects, 'name')}</label>
                        <label><span>教师</span>${this.renderSelect('tt-lock-teacher', this.project.teachers, 'name')}</label>
                        <label><span>周几</span><input id="tt-lock-day" type="number" min="1" max="${this.project.weekdays}" value="1"></label>
                        <label><span>第几节</span><input id="tt-lock-period" type="number" min="1" max="${this.project.periodsPerDay}" value="1"></label>
                    </div>
                    <button class="tt-btn" id="tt-add-lock" type="button"><i data-lucide="lock"></i><span>添加锁定</span></button>
                    <div class="tt-lock-list">${(hard.lockedSlots || []).map((slot, index) => this.renderLockedSlot(slot, index)).join('') || '<span class="tt-muted">暂无锁定课节</span>'}</div>
                </div>
            </section>
        `;
    }

    renderGenerateSection() {
        const score = this.getScore();
        const placed = score.placedLessons ?? 0;
        const total = score.totalLessons ?? this.totalPlannedLessons();
        return `
            <section class="tt-section tt-section--generate">
                <div class="tt-generate-copy">
                    <h3><i data-lucide="sparkles"></i><span>生成</span></h3>
                    <p>${placed}/${total} 已排 · ${score.hardConflicts ?? 0} 冲突</p>
                </div>
                <button class="tt-run-btn" id="tt-run-schedule" type="button" ${this.loading ? 'disabled' : ''}>
                    <i data-lucide="${this.loading ? 'loader-2' : 'play'}"></i><span>${this.loading ? '生成中' : '一键生成'}</span>
                </button>
            </section>
        `;
    }

    renderExportSection() {
        return `
            <section class="tt-section">
                <div class="tt-section-header">
                    <h3><i data-lucide="download"></i><span>导出</span></h3>
                </div>
                <div class="tt-export-grid">
                    <button class="tt-export-btn" data-export-type="class" type="button"><i data-lucide="table"></i><span>班级</span></button>
                    <button class="tt-export-btn" data-export-type="teacher" type="button"><i data-lucide="users"></i><span>教师</span></button>
                    <button class="tt-export-btn" data-export-type="master" type="button"><i data-lucide="layout-grid"></i><span>总表</span></button>
                    <button class="tt-export-btn" data-export-type="plans" type="button"><i data-lucide="file-spreadsheet"></i><span>任课</span></button>
                </div>
            </section>
        `;
    }

    renderBoard() {
        return `
            <div class="tt-board-toolbar">
                <div class="tt-segment" role="group" aria-label="课表视图">
                    <button class="${this.viewMode === 'class' ? 'is-active' : ''}" type="button" data-view-mode="class">班级</button>
                    <button class="${this.viewMode === 'teacher' ? 'is-active' : ''}" type="button" data-view-mode="teacher">教师</button>
                    <button class="${this.viewMode === 'master' ? 'is-active' : ''}" type="button" data-view-mode="master">总表</button>
                </div>
                ${this.viewMode === 'master' ? '<span class="tt-board-title">全校总课表</span>' : this.renderOwnerSelect()}
            </div>
            <div class="tt-board-view">
                ${this.renderScheduleGrid()}
            </div>
            <div class="tt-board-details">
                ${this.renderSlotInspector()}
                ${this.renderConflicts()}
            </div>
        `;
    }

    renderStatusBar() {
        const score = this.getScore();
        const conflicts = this.project.schedule?.conflicts || [];
        const placed = score.placedLessons ?? 0;
        const total = score.totalLessons ?? this.totalPlannedLessons();
        const completeness = score.completeness == null ? '-' : `${score.completeness}%`;
        return `
            <div class="tt-status-bar" id="tt-status-bar">
                <div class="tt-status-left">
                    <span class="tt-status-item ${conflicts.length ? 'tt-status-item--warning' : 'tt-status-item--success'}">
                        <i data-lucide="${conflicts.length ? 'alert-triangle' : 'badge-check'}"></i>
                        完成率 ${completeness}
                    </span>
                    <span class="tt-status-item">
                        <i data-lucide="calendar-check"></i>
                        已排 ${placed}/${total}
                    </span>
                </div>
                <div class="tt-status-middle">
                    <span class="tt-status-chip">
                        <i data-lucide="users"></i>
                        ${this.project.teachers.length} 教师 · ${this.project.classes.length} 班级
                    </span>
                    <span class="tt-status-chip ${score.unplacedLessons ? 'tt-status-chip--warning' : ''}">
                        <i data-lucide="list-x"></i>
                        未排 ${score.unplacedLessons ?? 0}
                    </span>
                    <span class="tt-status-chip ${conflicts.length ? 'tt-status-chip--warning' : ''}">
                        <i data-lucide="triangle-alert"></i>
                        冲突 ${conflicts.length}
                    </span>
                </div>
                <div class="tt-status-right">${this.escape(this.message)}</div>
            </div>
        `;
    }

    renderStats() {
        const score = this.getScore();
        const stats = [
            ['教师', this.project.teachers.length],
            ['班级', this.project.classes.length],
            ['课程', this.project.subjects.length],
            ['任课', this.project.lessonPlans.length],
            ['完成', score.completeness == null ? '-' : `${score.completeness}%`],
        ];
        return `<div class="tt-stat-row">${stats.map(([label, value]) => `<div class="tt-stat"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>`;
    }

    renderPlanTable() {
        const classMap = new Map(this.project.classes.map(item => [item.id, item]));
        const subjectMap = new Map(this.project.subjects.map(item => [item.id, item]));
        const teacherMap = new Map(this.project.teachers.map(item => [item.id, item]));
        const rows = this.project.lessonPlans.slice(0, 10).map(plan => {
            const klass = classMap.get(plan.classId);
            const subject = subjectMap.get(plan.subjectId);
            const teacher = teacherMap.get(plan.teacherId);
            return `
                <div class="tt-plan-row">
                    <span>${this.escape(klass ? `${klass.grade}${klass.name}` : plan.className || '')}</span>
                    ${this.subjectBadge(subject)}
                    <span>${this.escape(teacher?.name || plan.teacherName || '')}</span>
                    <strong>${plan.weeklyHours}</strong>
                </div>
            `;
        }).join('');
        return `
            <div class="tt-plan-list">
                ${rows || '<span class="tt-muted">暂无任课信息</span>'}
            </div>
        `;
    }

    renderOwnerSelect() {
        return `
            <select id="tt-owner-select">
                ${this.owners.map(owner => `<option value="${this.escapeAttr(owner.id)}" ${owner.id === this.selectedOwnerId ? 'selected' : ''}>${this.escape(owner.grade ? `${owner.grade}${owner.name}` : owner.name)}</option>`).join('')}
            </select>
        `;
    }

    renderScheduleGrid() {
        const slots = this.project.schedule?.slots || [];
        if (!slots.length) {
            return `
                <div class="tt-empty">
                    <i data-lucide="calendar-plus"></i>
                    <span>导入任课数据后点击“一键生成”</span>
                </div>
            `;
        }
        const days = Array.from({ length: this.project.weekdays }, (_, index) => index + 1);
        const periods = Array.from({ length: this.project.periodsPerDay }, (_, index) => index + 1);
        return `
            <div class="tt-schedule-grid" style="--tt-days:${this.project.weekdays}">
                <div class="tt-grid-head">节次</div>
                ${days.map(day => `<div class="tt-grid-head">周${this.dayName(day)}</div>`).join('')}
                ${periods.map(period => `
                    <div class="tt-period">第${period}节</div>
                    ${days.map(day => this.renderScheduleCell(slots, day, period)).join('')}
                `).join('')}
            </div>
        `;
    }

    renderScheduleCell(slots, day, period) {
        const filtered = slots.filter(slot => slot.day === day && slot.period === period)
            .filter(slot => {
                if (this.viewMode === 'teacher') return slot.teacherId === this.selectedOwnerId;
                if (this.viewMode === 'master') return true;
                return slot.classId === this.selectedOwnerId;
            });
        return `
            <div class="tt-cell" data-day="${day}" data-period="${period}">
                ${filtered.map(slot => this.renderSlot(slot)).join('')}
            </div>
        `;
    }

    renderSlot(slot) {
        const subject = this.project.subjects.find(item => item.id === slot.subjectId);
        const teacher = this.project.teachers.find(item => item.id === slot.teacherId);
        const klass = this.project.classes.find(item => item.id === slot.classId);
        const primary = this.viewMode === 'teacher'
            ? `${subject?.name || ''} · ${klass?.name || ''}`
            : this.viewMode === 'master'
                ? `${klass?.name || ''} · ${subject?.name || ''}`
                : `${subject?.name || ''} · ${teacher?.name || ''}`;
        const secondary = this.viewMode === 'master'
            ? teacher?.name || ''
            : klass ? `${klass.grade}${klass.name}` : '';
        return `
            <button class="tt-slot ${slot.locked ? 'is-locked' : ''} ${this.selectedSlotId === slot.id ? 'is-selected' : ''}" draggable="true" data-slot-id="${this.escapeAttr(slot.id)}" type="button" style="--subject-color:${subject?.color || '#14b8a6'}">
                <strong>${this.escape(primary)}</strong>
                <span>${this.escape(secondary)}</span>
            </button>
        `;
    }

    renderSlotInspector() {
        const slot = this.project.schedule?.slots?.find(item => item.id === this.selectedSlotId);
        if (!slot) {
            return `
                <div class="tt-slot-inspector tt-slot-inspector--empty">
                    <i data-lucide="mouse-pointer-click"></i>
                    <span>点击课节查看详情，拖拽课节可调整时间</span>
                </div>
            `;
        }
        const subject = this.project.subjects.find(item => item.id === slot.subjectId);
        const teacher = this.project.teachers.find(item => item.id === slot.teacherId);
        const klass = this.project.classes.find(item => item.id === slot.classId);
        return `
            <div class="tt-slot-inspector">
                <div>
                    <strong>${this.escape(subject?.name || '')}</strong>
                    <span>${this.escape(klass ? `${klass.grade}${klass.name}` : '')} · ${this.escape(teacher?.name || '')} · 周${this.dayName(slot.day)}第${slot.period}节</span>
                </div>
                <div class="tt-actions">
                    <button class="tt-btn" id="tt-lock-selected" type="button"><i data-lucide="${slot.locked ? 'unlock' : 'lock'}"></i><span>${slot.locked ? '解锁' : '锁定'}</span></button>
                    <button class="tt-btn tt-btn--danger" id="tt-clear-selected" type="button"><i data-lucide="trash-2"></i><span>清空</span></button>
                </div>
            </div>
        `;
    }

    renderConflicts() {
        const conflicts = this.project.schedule?.conflicts || [];
        return `
            <div class="tt-conflict-list">
                ${conflicts.length
                    ? conflicts.slice(0, 3).map(conflict => `<div class="tt-conflict"><i data-lucide="triangle-alert"></i><span>${this.escape(conflict.message || conflict.reason || conflict.type)}</span></div>`).join('')
                    : '<span class="tt-muted">无冲突</span>'}
            </div>
        `;
    }

    renderSelect(id, items, labelKey) {
        const labelFor = item => typeof labelKey === 'function' ? labelKey(item) : item[labelKey];
        return `<select id="${id}">${items.map(item => `<option value="${this.escapeAttr(item.id)}">${this.escape(labelFor(item))}</option>`).join('')}</select>`;
    }

    renderLockedSlot(slot, index) {
        const klass = this.project.classes.find(item => item.id === slot.classId);
        const subject = this.project.subjects.find(item => item.id === slot.subjectId);
        const teacher = this.project.teachers.find(item => item.id === slot.teacherId);
        return `
            <div class="tt-lock-item">
                <span>${this.escape(klass ? `${klass.grade}${klass.name}` : slot.classId)} · ${this.escape(subject?.name || slot.subjectId)} · ${this.escape(teacher?.name || slot.teacherId)} · ${slot.day}-${slot.period}</span>
                <button type="button" data-remove-lock="${index}" title="移除" aria-label="移除锁定课节"><i data-lucide="x"></i></button>
            </div>
        `;
    }

    subjectBadge(subject) {
        if (!subject) return '<span class="tt-subject-badge">-</span>';
        return `<span class="tt-subject-badge" style="--subject-color:${subject.color}">${this.escape(subject.name)}</span>`;
    }

    bindEvents() {
        this.container.querySelector('#tt-save-project')?.addEventListener('click', () => this.saveProject());
        this.container.querySelector('#tt-fill-sample')?.addEventListener('click', () => this.fillSample());
        this.container.querySelector('#tt-import-roster')?.addEventListener('click', () => this.importRoster());
        this.container.querySelector('#tt-save-rules')?.addEventListener('click', () => this.saveRules());
        this.container.querySelector('#tt-add-lock')?.addEventListener('click', () => this.addLockedSlot());
        this.container.querySelector('#tt-run-schedule')?.addEventListener('click', () => this.runSchedule());
        this.container.querySelector('#tt-owner-select')?.addEventListener('change', event => {
            this.selectedOwnerId = event.target.value;
            this.renderShell();
        });
        this.container.querySelectorAll('[data-view-mode]').forEach(button => button.addEventListener('click', () => {
            this.viewMode = button.dataset.viewMode;
            this.ensureOwnerSelection();
            this.selectedSlotId = '';
            this.renderShell();
        }));
        this.container.querySelectorAll('[data-remove-lock]').forEach(button => button.addEventListener('click', () => this.removeLockedSlot(Number(button.dataset.removeLock))));
        this.container.querySelectorAll('[data-export-type]').forEach(button => button.addEventListener('click', () => this.export(button.dataset.exportType)));
        this.container.querySelectorAll('.tt-slot').forEach(slot => {
            slot.addEventListener('click', () => {
                this.selectedSlotId = slot.dataset.slotId;
                this.renderShell();
            });
            slot.addEventListener('dragstart', event => {
                this.dragSlotId = slot.dataset.slotId;
                event.dataTransfer.effectAllowed = 'move';
            });
        });
        this.container.querySelectorAll('.tt-cell').forEach(cell => {
            cell.addEventListener('dragover', event => event.preventDefault());
            cell.addEventListener('dragenter', () => cell.classList.add('is-drop-target'));
            cell.addEventListener('dragleave', () => cell.classList.remove('is-drop-target'));
            cell.addEventListener('drop', event => {
                event.preventDefault();
                cell.classList.remove('is-drop-target');
                if (this.dragSlotId) {
                    this.adjustSlot({
                        type: 'move',
                        slotId: this.dragSlotId,
                        day: Number(cell.dataset.day),
                        period: Number(cell.dataset.period),
                    });
                    this.dragSlotId = '';
                }
            });
        });
        this.container.querySelector('#tt-lock-selected')?.addEventListener('click', () => {
            const slot = this.project.schedule?.slots?.find(item => item.id === this.selectedSlotId);
            this.adjustSlot({ type: 'lock', slotId: this.selectedSlotId, locked: !slot?.locked });
        });
        this.container.querySelector('#tt-clear-selected')?.addEventListener('click', () => this.adjustSlot({ type: 'clear', slotId: this.selectedSlotId }));
    }

    dayName(day) {
        return '一二三四五六日'[day - 1] || day;
    }

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    escapeAttr(value) {
        return this.escape(value);
    }
}

const planner = new TimetablePlanner();
export default planner;
