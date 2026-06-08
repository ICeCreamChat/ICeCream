import {
    dayName,
    ensureOwnerSelection,
    getActivePeriods,
    getActiveWeekdays,
    getConflictSummary,
    getOwners,
    getPreparedness,
    getRosterStats,
    getRuleSummary,
    getScore,
    getSlotsAt,
    getSolveStatus,
    getSlotDetails,
    ownerLabel,
    slotHasConflict,
    totalPlannedLessons,
} from './selectors.js';

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

function renderSelect(id, items, labelFor, selectedValue = '') {
    return `
        <select id="${escapeAttr(id)}">
            ${items.map(item => `
                <option value="${escapeAttr(item.id)}" ${item.id === selectedValue ? 'selected' : ''}>${escapeHtml(labelFor(item))}</option>
            `).join('')}
        </select>
    `;
}

function renderOwnerSelect(owners, selectedOwnerId) {
    return `
        <select id="tt-owner-select">
            ${owners.map(owner => `
                <option value="${escapeAttr(owner.id)}" ${owner.id === selectedOwnerId ? 'selected' : ''}>${escapeHtml(ownerLabel(owner))}</option>
            `).join('')}
        </select>
    `;
}

function renderMetric(label, value, tone = '') {
    return `<div class="tt-metric ${tone ? `tt-metric--${tone}` : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

const WEEKDAY_OPTIONS = [
    { value: 1, label: '周一' },
    { value: 2, label: '周二' },
    { value: 3, label: '周三' },
    { value: 4, label: '周四' },
    { value: 5, label: '周五' },
    { value: 6, label: '周六' },
    { value: 7, label: '周日' },
];

const PERIOD_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
    value: index + 1,
    label: `第${index + 1}节`,
}));

function renderRangeChips({ items, activeValues, dataAttr }) {
    const active = new Set(activeValues.map(Number));
    return `
        <div class="tt-chip-grid tt-chip-grid--range">
            ${items.map(item => `
                <label class="tt-check-chip">
                    <input type="checkbox" ${dataAttr}="${item.value}" value="${item.value}" ${active.has(item.value) ? 'checked' : ''}>
                    <span>${escapeHtml(item.label)}</span>
                </label>
            `).join('')}
        </div>
    `;
}

export function renderWorkbench(state) {
    if (!state.project) {
        return `<div class="tt-loading">${state.loading ? '正在加载排课项目...' : escapeHtml(state.message || '暂无排课数据')}</div>`;
    }

    state.selectedOwnerId = ensureOwnerSelection(state);
    return `
        <div class="tt-workbench">
            ${renderTopbar(state)}
            <aside class="tt-sidebar">
                ${renderWorkflow(state)}
            </aside>
            <section class="tt-schedule-panel">
                ${renderSchedulePanel(state)}
            </section>
            <aside class="tt-inspector">
                ${renderInspector(state)}
            </aside>
        </div>
    `;
}

function renderTopbar(state) {
    const { project } = state;
    const status = getSolveStatus(project, state.lastFailure);
    const preparedness = getPreparedness(project);
    const message = state.message || preparedness.message;
    const activeWeekdays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    return `
        <header class="tt-topbar">
            <div class="tt-title-block">
                <span class="tt-eyebrow">智能排课</span>
                <h2>排课工作台</h2>
                <p>${activeWeekdays.length} 天 · ${activePeriods.length} 节 · ${preparedness.ready ? '数据已就绪' : '待导入任课'}</p>
            </div>
            <div class="tt-topbar-metrics" aria-label="排课状态">
                ${renderMetric('来源', status.sourceLabel, status.source === 'timefold_solver' ? 'ok' : '')}
                ${renderMetric('已排', `${status.placed}/${status.total}`)}
                ${renderMetric('硬冲突', status.hardConflicts, status.hardConflicts ? 'warn' : 'ok')}
                ${renderMetric('未排', status.unplaced, status.unplaced ? 'warn' : 'ok')}
            </div>
            <div class="tt-message ${state.lastFailure ? 'tt-message--warn' : ''}">
                ${state.lastFailure ? '<i data-lucide="shield-alert"></i><span>旧课表已保留</span>' : '<i data-lucide="info"></i>'}
                <span>${escapeHtml(message)}</span>
            </div>
        </header>
    `;
}

function renderWorkflow(state) {
    return `
        <div class="tt-workflow">
            ${renderProjectSection(state)}
            ${renderImportSection(state)}
            ${renderRulesSection(state)}
            ${renderSolveSection(state)}
            ${renderExportSection()}
        </div>
    `;
}

function renderProjectSection(state) {
    const { project } = state;
    const activeWeekdays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    return `
        <section class="tt-section" data-workflow-step="data">
            <div class="tt-section-title">
                <h3><i data-lucide="calendar-days"></i><span>排课范围</span></h3>
                <button class="tt-icon-btn" id="tt-save-project" type="button" title="保存范围" aria-label="保存范围"><i data-lucide="save"></i></button>
            </div>
            <form id="tt-project-form" class="tt-range-form">
                <div class="tt-rule-block">
                    <span class="tt-rule-title">可用周几</span>
                    ${renderRangeChips({ items: WEEKDAY_OPTIONS, activeValues: activeWeekdays, dataAttr: 'data-active-weekday' })}
                </div>
                <div class="tt-rule-block">
                    <span class="tt-rule-title">可用节次</span>
                    ${renderRangeChips({ items: PERIOD_OPTIONS, activeValues: activePeriods, dataAttr: 'data-active-period' })}
                </div>
            </form>
        </section>
    `;
}

function renderImportSection(state) {
    const { project } = state;
    const stats = getRosterStats(project);
    const hasRoster = stats.planCount > 0;
    return `
        <section class="tt-section" data-workflow-step="data">
            <div class="tt-section-title">
                <h3><i data-lucide="database"></i><span>任课数据</span></h3>
                <span class="tt-chip">${stats.planCount} 条</span>
            </div>
            ${hasRoster ? renderRosterStats(stats) : `
                <div class="tt-empty-card">
                    <i data-lucide="file-input"></i>
                    <strong>等待导入任课数据</strong>
                    <span>导入年级、班级、课程、教师和周课时后再生成统计。</span>
                </div>
            `}
            <textarea id="tt-import-text" class="tt-import-text" spellcheck="false" placeholder="年级,班级,课程,教师,周课时,连堂"></textarea>
            <div class="tt-action-row">
                <label class="tt-file-btn" title="选择任课文件">
                    <i data-lucide="paperclip"></i>
                    <span>文件</span>
                    <input id="tt-import-file" type="file" accept=".csv,.txt,.xlsx,.xls">
                </label>
                <button class="tt-btn" id="tt-fill-sample" type="button"><i data-lucide="wand-sparkles"></i><span>示例</span></button>
                <button class="tt-btn tt-btn--primary" id="tt-import-roster" type="button"><i data-lucide="upload"></i><span>导入</span></button>
                ${hasRoster ? '<button class="tt-btn tt-btn--danger" id="tt-clear-roster" type="button"><i data-lucide="trash-2"></i><span>清空</span></button>' : ''}
            </div>
        </section>
    `;
}

function renderRosterStats(stats) {
    const metrics = [
        ['班级', stats.classCount],
        ['教师', stats.teacherCount],
        ['课程', stats.subjectCount],
        ['任课', stats.planCount],
        ['总课时', stats.totalLessons],
        ['连堂课时', stats.blockLessons],
        ['固定教室', stats.fixedRoomCount],
        ['潜在问题', stats.issueCount],
    ];
    return `
        <div class="tt-roster-stats">
            ${metrics.map(([label, value]) => `
                <div class="tt-stat-card ${label === '潜在问题' && value ? 'tt-stat-card--warn' : ''}">
                    <span>${escapeHtml(label)}</span>
                    <strong>${escapeHtml(value)}</strong>
                </div>
            `).join('')}
        </div>
    `;
}

function renderRulesSection(state) {
    const { project } = state;
    const hard = project.rules?.hardRules || {};
    const soft = project.rules?.softRules || {};
    const ruleSummary = getRuleSummary(project);
    return `
        <section class="tt-section" data-workflow-step="rules">
            <div class="tt-section-title">
                <h3><i data-lucide="brain-circuit"></i><span>AI 约束</span></h3>
                <span class="tt-chip">${ruleSummary.total} 条</span>
            </div>
            <div class="tt-rule-block">
                <span class="tt-rule-title">自然语言描述</span>
                <textarea id="tt-rule-prompt" class="tt-import-text tt-rule-prompt" spellcheck="false" placeholder="例如：王老师周三下午不要排课，语数英尽量上午，七年级1班周五第7节不要排"></textarea>
                <div class="tt-action-row">
                    <button class="tt-btn tt-btn--primary" id="tt-parse-rules" type="button"><i data-lucide="sparkles"></i><span>AI 解析</span></button>
                    <button class="tt-btn" id="tt-confirm-rule-draft" type="button" ${state.ruleDraft ? '' : 'disabled'}><i data-lucide="check"></i><span>确认草稿</span></button>
                    <button class="tt-btn tt-btn--danger" id="tt-clear-rules" type="button"><i data-lucide="trash-2"></i><span>清空规则</span></button>
                </div>
                ${renderRulePreview(state)}
            </div>
            <div class="tt-rule-block">
                <span class="tt-rule-title">批量手动编辑</span>
                ${renderBulkRuleEditor(project)}
            </div>
            <div class="tt-rule-block">
                <span class="tt-rule-title">锁定课节</span>
                <div class="tt-form-grid">
                    <label><span>班级</span>${renderSelect('tt-lock-class', project.classes, ownerLabel)}</label>
                    <label><span>课程</span>${renderSelect('tt-lock-subject', project.subjects, item => item.name)}</label>
                    <label><span>教师</span>${renderSelect('tt-lock-teacher', project.teachers, item => item.name)}</label>
                    <label><span>周几</span>${renderNumberSelect('tt-lock-day', getActiveWeekdays(project), day => `周${dayName(day)}`)}</label>
                    <label><span>第几节</span>${renderNumberSelect('tt-lock-period', getActivePeriods(project), period => `第${period}节`)}</label>
                </div>
                <button class="tt-btn" id="tt-add-lock" type="button"><i data-lucide="lock"></i><span>添加锁定</span></button>
                <div class="tt-lock-list">${(hard.lockedSlots || []).map((slot, index) => renderLockedSlot(project, slot, index)).join('') || '<span class="tt-muted">暂无锁定课节</span>'}</div>
            </div>
        </section>
    `;
}

function renderNumberSelect(id, values, labelFor) {
    return `
        <select id="${escapeAttr(id)}">
            ${values.map(value => `<option value="${value}">${escapeHtml(labelFor(value))}</option>`).join('')}
        </select>
    `;
}

function renderRulePreview(state) {
    const items = state.ruleDraftPreview || [];
    const warnings = state.ruleWarnings || [];
    if (!items.length && !warnings.length) {
        return '<div class="tt-rule-preview"><span class="tt-muted">AI 解析后会在这里预览，确认后才会保存。</span></div>';
    }
    return `
        <div class="tt-rule-preview">
            ${items.map(item => `
                <div class="tt-rule-preview-item">
                    <strong>${escapeHtml(item.targetName || item.targetId || item.type)}</strong>
                    <span>${escapeHtml(item.type)} · ${escapeHtml(item.priority || 'hard')} · ${escapeHtml((item.slots || []).join(', ') || '全局')}</span>
                    ${item.description ? `<em>${escapeHtml(item.description)}</em>` : ''}
                </div>
            `).join('')}
            ${warnings.map(warning => `<div class="tt-rule-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(warning)}</span></div>`).join('')}
        </div>
    `;
}

function renderBulkTargets(project) {
    const groups = [
        ['teacher', '教师', project.teachers || [], item => item.name],
        ['class', '班级', project.classes || [], ownerLabel],
        ['subject', '课程', project.subjects || [], item => item.name],
    ];
    return groups.map(([type, label, items, labelFor]) => `
        <div class="tt-bulk-target-group">
            <span>${label}</span>
            <div class="tt-chip-grid">
                ${items.map(item => `
                    <label class="tt-check-chip">
                        <input type="checkbox" data-bulk-target data-bulk-target-type="${type}" value="${escapeAttr(item.id)}">
                        <span>${escapeHtml(labelFor(item))}</span>
                    </label>
                `).join('') || '<span class="tt-muted">暂无数据</span>'}
            </div>
        </div>
    `).join('');
}

function renderBulkRuleEditor(project) {
    return `
        <div class="tt-form-grid">
            <label><span>规则类型</span>
                <select id="tt-bulk-rule-type">
                    <option value="teacher_unavailable">教师不可排</option>
                    <option value="class_unavailable">班级不可排</option>
                    <option value="subject_morning">课程上午优先</option>
                </select>
            </label>
        </div>
        ${renderBulkTargets(project)}
        <div class="tt-bulk-range">
            <span class="tt-rule-title">周几</span>
            ${renderRangeChips({ items: getActiveWeekdays(project).map(value => ({ value, label: `周${dayName(value)}` })), activeValues: [], dataAttr: 'data-bulk-day' })}
            <span class="tt-rule-title">节次</span>
            ${renderRangeChips({ items: getActivePeriods(project).map(value => ({ value, label: `第${value}节` })), activeValues: [], dataAttr: 'data-bulk-period' })}
        </div>
        <button class="tt-btn" id="tt-add-bulk-rule" type="button"><i data-lucide="list-plus"></i><span>添加批量规则</span></button>
    `;
}

function renderSolveSection(state) {
    const { project } = state;
    const readiness = getPreparedness(project);
    const score = getScore(project);
    const placed = score.placedLessons ?? 0;
    const total = score.totalLessons ?? totalPlannedLessons(project);
    const scaleMessage = solveScaleMessage(project);
    return `
        <section class="tt-section tt-section--solve" data-workflow-step="solve">
            <div class="tt-section-title">
                <h3><i data-lucide="sparkles"></i><span>求解</span></h3>
                <span class="tt-chip ${readiness.ready ? 'tt-chip--ok' : 'tt-chip--warn'}">${readiness.ready ? '就绪' : '待准备'}</span>
            </div>
            <p class="tt-compact-copy">${placed}/${total} 已排 · ${score.hardConflicts ?? 0} 硬冲突</p>
            <p class="tt-compact-copy">${escapeHtml(readiness.message)}</p>
            ${scaleMessage ? `<p class="tt-compact-copy tt-compact-copy--warn">${escapeHtml(scaleMessage)}</p>` : ''}
        </section>
    `;
}

function solveScaleMessage(project) {
    const total = totalPlannedLessons(project);
    if (total >= 300) return `${total} 课时，可能需要数分钟。`;
    return '';
}

function optimizationStatusLabel(job) {
    if (!job) return '';
    if (job.status === 'queued' || job.status === 'running') return 'Timefold 优化中';
    if (job.status === 'completed' && job.accepted) return 'Timefold 已优化';
    if (job.status === 'completed') return '已保留快速课表';
    if (job.status === 'failed') return 'Timefold 未完成';
    if (job.status === 'skipped') return '已保留当前课表';
    return '后台优化';
}

function renderExportSection() {
    return `
        <section class="tt-section" data-workflow-step="review">
            <div class="tt-section-title">
                <h3><i data-lucide="download"></i><span>导出</span></h3>
            </div>
            <div class="tt-export-grid">
                <button class="tt-export-btn" data-export-type="class" type="button" title="导出班级课表"><i data-lucide="table"></i><span>班级</span></button>
                <button class="tt-export-btn" data-export-type="teacher" type="button" title="导出教师课表"><i data-lucide="users"></i><span>教师</span></button>
                <button class="tt-export-btn" data-export-type="master" type="button" title="导出总课表"><i data-lucide="layout-grid"></i><span>总表</span></button>
                <button class="tt-export-btn" data-export-type="plans" type="button" title="导出任课信息"><i data-lucide="file-spreadsheet"></i><span>任课</span></button>
            </div>
        </section>
    `;
}

export function renderSchedulePanel(state) {
    const owners = getOwners(state.project, state.viewMode);
    const readiness = getPreparedness(state.project);
    const optimizationLabel = optimizationStatusLabel(state.solverJob);
    return `
        <div class="tt-schedule-toolbar">
            <div class="tt-schedule-view-controls">
                <div class="tt-segment" role="group" aria-label="课表视图">
                    <button class="${state.viewMode === 'class' ? 'is-active' : ''}" type="button" data-view-mode="class">班级</button>
                    <button class="${state.viewMode === 'teacher' ? 'is-active' : ''}" type="button" data-view-mode="teacher">教师</button>
                    <button class="${state.viewMode === 'master' ? 'is-active' : ''}" type="button" data-view-mode="master">总表</button>
                </div>
                ${state.viewMode === 'master'
                    ? '<span class="tt-board-title">全校总课表</span>'
                    : renderOwnerSelect(owners, state.selectedOwnerId)}
            </div>
            <div class="tt-schedule-actions">
                ${optimizationLabel ? `<span class="tt-chip ${state.solverJob?.status === 'failed' ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(optimizationLabel)}</span>` : ''}
                ${solveScaleMessage(state.project) ? `<span class="tt-chip tt-chip--warn">${escapeHtml(solveScaleMessage(state.project))}</span>` : ''}
                <span class="tt-chip ${readiness.ready ? 'tt-chip--ok' : 'tt-chip--warn'}">${readiness.ready ? '可生成' : '待准备'}</span>
                <button class="tt-run-btn" id="tt-run-schedule" type="button" ${state.loading || !readiness.ready ? 'disabled' : ''}>
                    <i data-lucide="${state.loading ? 'loader-2' : 'play'}"></i><span>${state.loading ? '快速生成中' : '快速生成'}</span>
                </button>
            </div>
        </div>
        <div class="tt-schedule-scroll">
            ${renderScheduleGrid(state)}
        </div>
    `;
}

function renderScheduleGrid(state) {
    const slots = state.project.schedule?.slots || [];
    if (!slots.length) {
        if ((state.project.lessonPlans || []).length) {
            return renderEmptyScheduleGrid(state);
        }
        return `
            <div class="tt-empty">
                <i data-lucide="calendar-plus"></i>
                <strong>等待任课数据</strong>
                <span>先在左侧导入课程、教师、班级和周课时。</span>
            </div>
        `;
    }

    const days = getActiveWeekdays(state.project);
    const periods = getActivePeriods(state.project);
    return `
        <div class="tt-schedule-body">
            <div class="tt-schedule-grid" style="--tt-days:${days.length}">
                <div class="tt-grid-head">节次</div>
                ${days.map(day => `<div class="tt-grid-head">周${dayName(day)}</div>`).join('')}
                ${periods.map(period => `
                    <div class="tt-period">第${period}节</div>
                    ${days.map(day => renderScheduleCell(state, day, period)).join('')}
                `).join('')}
            </div>
        </div>
    `;
}

function renderEmptyScheduleGrid(state) {
    const days = getActiveWeekdays(state.project);
    const periods = getActivePeriods(state.project);
    return `
        <div class="tt-schedule-body">
            <div class="tt-schedule-grid" style="--tt-days:${days.length}">
                <div class="tt-grid-head">节次</div>
                ${days.map(day => `<div class="tt-grid-head">周${dayName(day)}</div>`).join('')}
                ${periods.map(period => `
                    <div class="tt-period">第${period}节</div>
                    ${days.map(day => `
                        <div class="tt-cell tt-main-empty-cell" data-day="${day}" data-period="${period}">
                            <span>待排</span>
                        </div>
                    `).join('')}
                `).join('')}
            </div>
        </div>
    `;
}

function renderUnscheduledPlanQueue(state) {
    const project = state.project;
    const scheduledPlanIds = new Set((project.schedule?.slots || []).map(slot => slot.lessonPlanId).filter(Boolean));
    const plans = (project.lessonPlans || []).filter(plan => !scheduledPlanIds.has(plan.id));
    const rows = plans.slice(0, 18).map(plan => {
        const klass = project.classes.find(item => item.id === plan.classId);
        const subject = project.subjects.find(item => item.id === plan.subjectId);
        const teacher = project.teachers.find(item => item.id === plan.teacherId);
        return `
            <div class="tt-plan-queue-item" style="--subject-color:${escapeAttr(subject?.color || '#2563eb')}">
                <strong>${escapeHtml(subject?.name || plan.subjectName || plan.subjectId)}</strong>
                <span>${escapeHtml(klass ? `${klass.grade}${klass.name}` : plan.className || plan.classId)} · ${escapeHtml(teacher?.name || plan.teacherName || plan.teacherId)}</span>
                <em>${plan.weeklyHours} 节${plan.blockPreference === 'double' ? ' · 双连堂' : plan.blockPreference === 'mixed' ? ' · 混合连堂' : ''}</em>
            </div>
        `;
    }).join('');
    return `
        <section class="tt-plan-queue" aria-label="待排课程">
            <div class="tt-plan-queue-header">
                <span>待排课程</span>
                <strong>${plans.length}</strong>
            </div>
            <div class="tt-plan-queue-list">
                ${rows || '<span class="tt-muted">所有课程已进入课表。</span>'}
            </div>
        </section>
    `;
}

function renderScheduleCell(state, day, period) {
    const slots = getSlotsAt(state.project, state.viewMode, state.selectedOwnerId, day, period);
    return `
        <div class="tt-cell" data-day="${day}" data-period="${period}">
            ${slots.map(slot => renderSlot(state, slot)).join('')}
        </div>
    `;
}

function renderSlot(state, slot) {
    const detail = getSlotDetails(state.project, slot.id);
    const subject = detail?.subject;
    const blockId = slot.blockId || '';
    const conflict = slotHasConflict(state.project, slot);
    const primary = state.viewMode === 'teacher'
        ? `${subject?.name || slot.subjectId} · ${detail?.classLabel || slot.classId}`
        : state.viewMode === 'master'
            ? `${detail?.classLabel || slot.classId} · ${subject?.name || slot.subjectId}`
            : `${subject?.name || slot.subjectId} · ${detail?.teacherNames || slot.teacherId}`;
    const secondary = state.viewMode === 'master'
        ? detail?.teacherNames || slot.teacherId
        : detail?.timeLabel || `周${dayName(slot.day)} 第${slot.period}节`;
    return `
        <button class="tt-slot ${slot.locked ? 'is-locked' : ''} ${conflict ? 'has-conflict' : ''} ${state.selectedSlotId === slot.id ? 'is-selected' : ''}"
            draggable="true"
            data-slot-id="${escapeAttr(slot.id)}"
            data-block-id="${escapeAttr(blockId)}"
            type="button"
            style="--subject-color:${escapeAttr(subject?.color || '#2563eb')}">
            <strong>${escapeHtml(primary)}</strong>
            <span>${escapeHtml(secondary)}</span>
            <em>${slot.blockId ? `连堂 ${Number(slot.blockIndex || 0) + 1}/${slot.blockSize}` : '单节'}${slot.locked ? ' · 锁定' : ''}</em>
        </button>
    `;
}

export function renderInspector(state) {
    const status = getSolveStatus(state.project, state.lastFailure);
    const selectedDetail = getSlotDetails(state.project, state.selectedSlotId);
    return `
        <div class="tt-inspector-stack">
            ${selectedDetail ? renderSlotInspector(state) : renderPlanningInspector(state)}
            ${selectedDetail ? '' : renderUnscheduledPlanQueue(state)}
            ${renderAuditPanel(state)}
            ${renderConflictPanel(state)}
            ${renderOptimizationPanel(state)}
            <section class="tt-inspector-section">
                <div class="tt-section-title">
                    <h3><i data-lucide="activity"></i><span>求解详情</span></h3>
                </div>
                <div class="tt-detail-list">
                    <span><b>来源</b>${escapeHtml(status.sourceLabel)}</span>
                    <span><b>完成率</b>${escapeHtml(status.completeness)}</span>
                    <span><b>硬冲突</b>${escapeHtml(status.hardConflicts)}</span>
                    <span><b>未排课时</b>${escapeHtml(status.unplaced)}</span>
                    ${state.lastFailure?.solverStats?.lessonCount ? `<span><b>课时数</b>${escapeHtml(state.lastFailure.solverStats.lessonCount)}</span>` : ''}
                    ${state.lastFailure?.solverStats?.timeoutSeconds ? `<span><b>超时上限</b>${escapeHtml(state.lastFailure.solverStats.timeoutSeconds)} 秒</span>` : ''}
                    ${state.lastFailure ? `<span class="is-warning"><b>失败处理</b>旧课表已保留</span>` : ''}
                </div>
            </section>
        </div>
    `;
}

function renderAuditPanel(state) {
    const stats = getRosterStats(state.project);
    const rules = getRuleSummary(state.project);
    const preview = state.ruleDraftPreview || [];
    const warnings = state.ruleWarnings || [];
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="clipboard-check"></i><span>数据审查</span></h3>
            </div>
            <div class="tt-audit-grid">
                <span><b>班级</b>${stats.classCount}</span>
                <span><b>教师</b>${stats.teacherCount}</span>
                <span><b>课程</b>${stats.subjectCount}</span>
                <span><b>总课时</b>${stats.totalLessons}</span>
                <span><b>规则</b>${rules.total}</span>
                <span><b>问题</b>${stats.issueCount}</span>
            </div>
            ${preview.length ? `
                <div class="tt-rule-preview tt-rule-preview--compact">
                    ${preview.slice(0, 4).map(item => `
                        <div class="tt-rule-preview-item">
                            <strong>${escapeHtml(item.targetName || item.targetId || item.type)}</strong>
                            <span>${escapeHtml(item.type)} · ${escapeHtml((item.slots || []).join(', ') || '全局')}</span>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
            ${warnings.length ? `
                <div class="tt-rule-warning-list">
                    ${warnings.slice(0, 3).map(warning => `<div class="tt-rule-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(warning)}</span></div>`).join('')}
                </div>
            ` : ''}
        </section>
    `;
}

function renderOptimizationPanel(state) {
    const job = state.solverJob;
    const schedule = state.project?.schedule || null;
    if (!job && schedule?.source !== 'fast_constructed') return '';
    const label = optimizationStatusLabel(job);
    const statusText = job
        ? label
        : '等待下一次 Timefold 优化';
    const sourceText = schedule?.source === 'fast_constructed'
        ? '快速课表'
        : schedule?.source === 'timefold_solver'
            ? 'Timefold'
            : '未生成';
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="refresh-cw"></i><span>后台优化</span></h3>
                ${job ? `<span class="tt-chip ${job.status === 'failed' ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(job.status)}</span>` : ''}
            </div>
            <div class="tt-detail-list">
                <span><b>当前课表</b>${escapeHtml(sourceText)}</span>
                <span><b>优化状态</b>${escapeHtml(statusText)}</span>
                ${job?.reason ? `<span class="is-warning"><b>处理结果</b>${escapeHtml(job.reason)}</span>` : ''}
                ${job?.solverStats?.lessonCount ? `<span><b>课时数</b>${escapeHtml(job.solverStats.lessonCount)}</span>` : ''}
            </div>
        </section>
    `;
}

function renderPlanningInspector(state) {
    const status = getSolveStatus(state.project, state.lastFailure);
    const owners = getOwners(state.project, state.viewMode);
    const selectedOwner = owners.find(owner => owner.id === state.selectedOwnerId) || owners[0] || {};
    const viewLabel = state.viewMode === 'teacher' ? '教师视图' : state.viewMode === 'master' ? '总表视图' : '班级视图';
    const scaleMessage = solveScaleMessage(state.project);
    return `
        <section class="tt-inspector-section tt-inspector-overview">
            <div class="tt-section-title">
                <h3><i data-lucide="mouse-pointer-click"></i><span>审查入口</span></h3>
            </div>
            <div class="tt-detail-list">
                <span><b>当前视图</b>${escapeHtml(viewLabel)}</span>
                <span><b>当前对象</b>${escapeHtml(ownerLabel(selectedOwner) || '全校')}</span>
                <span><b>已排课时</b>${escapeHtml(`${status.placed}/${status.total}`)}</span>
                <span><b>状态</b>${escapeHtml(state.loading ? '快速生成中' : status.sourceLabel)}</span>
                ${scaleMessage ? `<span class="is-warning"><b>规模提示</b>${escapeHtml(scaleMessage)}</span>` : ''}
                ${state.lastFailure ? `<span class="is-warning"><b>失败原因</b>${escapeHtml(state.lastFailure.message || 'Timefold 求解失败，旧课表已保留。')}</span>` : ''}
            </div>
        </section>
    `;
}

function renderSlotInspector(state) {
    const detail = getSlotDetails(state.project, state.selectedSlotId);
    if (!detail) {
        return `
            <section class="tt-inspector-section tt-inspector-empty">
                <i data-lucide="mouse-pointer-click"></i>
                <span>选择课节后查看教师、教室、连堂、锁定与冲突状态。</span>
            </section>
        `;
    }

    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="panel-right"></i><span>课节检查</span></h3>
            </div>
            <div class="tt-slot-detail">
                <strong>${escapeHtml(detail.subject?.name || detail.slot.subjectId)}</strong>
                <span>${escapeHtml(detail.classLabel)} · ${escapeHtml(detail.teacherNames)} · ${escapeHtml(detail.timeLabel)}</span>
                <span>${escapeHtml(detail.blockLabel)} · ${detail.slot.locked ? '已锁定' : '可调整'} · ${detail.hasConflict ? '有冲突' : '无冲突'}</span>
                ${detail.slot.roomId ? `<span>教室：${escapeHtml(detail.slot.roomId)}</span>` : ''}
            </div>
            <div class="tt-action-row">
                <button class="tt-btn" id="tt-lock-selected" type="button">
                    <i data-lucide="${detail.slot.locked ? 'unlock' : 'lock'}"></i><span>${detail.slot.locked ? '解锁整段' : '锁定整段'}</span>
                </button>
                <button class="tt-btn tt-btn--danger" id="tt-clear-selected" type="button">
                    <i data-lucide="trash-2"></i><span>清空整段</span>
                </button>
            </div>
        </section>
    `;
}

function renderConflictPanel(state) {
    const schedule = state.project.schedule || {};
    const summary = getConflictSummary(schedule);
    const conflicts = schedule.conflicts || [];
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="triangle-alert"></i><span>冲突</span></h3>
                <span class="tt-chip ${summary.total ? 'tt-chip--warn' : 'tt-chip--ok'}">${summary.total}</span>
            </div>
            <div class="tt-conflict-summary">
                ${summary.items.map(item => `<span>${escapeHtml(item.label)} ${item.count}</span>`).join('') || '<span>无硬冲突</span>'}
            </div>
            <div class="tt-conflict-list">
                ${conflicts.slice(0, 5).map(conflict => `
                    <div class="tt-conflict">
                        <i data-lucide="alert-circle"></i>
                        <span>${escapeHtml(conflict.message || conflict.reason || conflict.type)}</span>
                    </div>
                `).join('') || '<span class="tt-muted">当前课表没有冲突。</span>'}
            </div>
        </section>
    `;
}

function renderPlanTable(project) {
    const rows = (project.lessonPlans || []).slice(0, 12).map(plan => {
        const klass = project.classes.find(item => item.id === plan.classId);
        const subject = project.subjects.find(item => item.id === plan.subjectId);
        const teacher = project.teachers.find(item => item.id === plan.teacherId);
        return `
            <div class="tt-plan-row">
                <span>${escapeHtml(klass ? `${klass.grade}${klass.name}` : plan.className || plan.classId)}</span>
                <span class="tt-subject-dot" style="--subject-color:${escapeAttr(subject?.color || '#2563eb')}">${escapeHtml(subject?.name || plan.subjectName || plan.subjectId)}</span>
                <span>${escapeHtml(teacher?.name || plan.teacherName || plan.teacherId)}</span>
                <strong>${plan.weeklyHours}</strong>
            </div>
        `;
    }).join('');
    return `<div class="tt-plan-list">${rows || '<span class="tt-muted">暂无任课信息</span>'}</div>`;
}

function renderLockedSlot(project, slot, index) {
    const klass = project.classes.find(item => item.id === slot.classId);
    const subject = project.subjects.find(item => item.id === slot.subjectId);
    const teacher = project.teachers.find(item => item.id === slot.teacherId);
    return `
        <div class="tt-lock-item">
            <span>${escapeHtml(klass ? `${klass.grade}${klass.name}` : slot.classId)} · ${escapeHtml(subject?.name || slot.subjectId)} · ${escapeHtml(teacher?.name || slot.teacherId)} · ${slot.day}-${slot.period}</span>
            <button type="button" data-remove-lock="${index}" title="移除锁定" aria-label="移除锁定课节"><i data-lucide="x"></i></button>
        </div>
    `;
}
