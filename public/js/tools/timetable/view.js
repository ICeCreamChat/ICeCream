import {
    dayName,
    ensureOwnerSelection,
    getActivePeriods,
    getActiveWeekdays,
    getConflictSummary,
    getOwners,
    getPreparedness,
    getPublishedScheduleDiff,
    getRosterStats,
    getRuleSummary,
    getSavedRuleItems,
    getScore,
    getSlotsAt,
    getSolveStatus,
    getSlotDetails,
    isPublishedDraftChanged,
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

function formatSlotTime(slot = null) {
    if (!slot) return '未排入课表';
    return `周${dayName(slot.day)} 第${slot.period}节`;
}

function formatSlotSubject(project = {}, slot = null) {
    if (!slot) return '未知课程';
    const subject = (project.subjects || []).find(item => item.id === slot.subjectId);
    const klass = (project.classes || []).find(item => item.id === slot.classId);
    const teachers = Array.isArray(slot.teacherIds) && slot.teacherIds.length
        ? slot.teacherIds
        : [slot.teacherId].filter(Boolean);
    const teacherNames = teachers
        .map(teacherId => (project.teachers || []).find(item => item.id === teacherId)?.name || teacherId)
        .filter(Boolean)
        .join('、');
    const className = klass ? `${klass.grade}${klass.name}` : slot.classId;
    return [className, subject?.name || slot.subjectId, teacherNames].filter(Boolean).join(' · ');
}

// 规则类型 / 状态的中文标签（value 仍是内部枚举，仅展示中文）
const RULE_TYPE_LABELS = {
    teacher_unavailable: '教师不可排',
    class_unavailable: '班级不可排',
    locked_slot: '锁定课节',
    subject_morning: '课程上午优先',
    subject_preferred_periods: '课程偏好节次',
    subject_avoid_periods: '课程避开节次',
    teacher_daily_limit: '教师每日上限',
    teacher_consecutive_limit: '教师连堂上限',
    subject_spread: '同科分散',
    teacher_load_balance: '教师负载均衡（仅建议）',
    block_protection: '连堂保护（仅建议）',
    class_daily_balance: '班级每日均衡（仅建议）',
    quality_subject_later: '素质课后置（仅建议）',
    subject_spread_suggestion: '同科分散（仅建议）',
};

const RULE_STATUS_LABELS = {
    effective: '已生效',
    ready: '可生效',
    needs_review: '需复核',
    suggestion: '仅建议',
    unsupported: '暂不支持',
    invalid: '无效',
    ignored: '已忽略',
};

const TIMETABLE_REVIEW_LABELS = {
    class_capacity: '班级容量',
    classDailyBalance: '班级日负载',
    class_load: '班级负载',
    hard_conflicts: '硬冲突',
    inactive_slot: '作息范围',
    incomplete_schedule: '未排课时',
    invalid_schedule_refs: '无效引用',
    manual_adjusted: '手动调整',
    manual_review: '教务复核',
    missing_lesson_plans: '任课数据',
    missing_schedule: '课表生成',
    morningSubjects: '主科时段',
    morning_subject_late: '主科时段',
    preferredPeriods: '偏好节次',
    published_snapshot_missing: '发布快照',
    published_snapshot_backfill_needed: '发布快照',
    restored_published_draft: '恢复发布版',
    room_capacity: '教室容量',
    room_load: '教室负载',
    roomUsage: '教室占用',
    subject_avoid_period: '避开节次',
    subjectSpread: '同科分散',
    subject_spread: '同科分散',
    teacher_capacity: '教师容量',
    teacher_consecutive: '教师连续课',
    teacherConsecutive: '教师连续课',
    teacher_daily_limit: '教师日课时',
    teacher_load: '教师负载',
};

function ruleTypeLabel(type) {
    return RULE_TYPE_LABELS[type] || type;
}

function ruleStatusLabel(status) {
    return RULE_STATUS_LABELS[status] || status;
}

function timetableReviewLabel(type = '') {
    return TIMETABLE_REVIEW_LABELS[type] || (type ? '审查项' : '提醒');
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

function renderCheckList({ items, activeValues, dataAttr, disabled = false }) {
    const active = new Set(activeValues.map(Number));
    return `
        <div class="tt-check-list">
            ${items.map(item => `
                <label class="tt-check-chip">
                    <input type="checkbox" ${dataAttr}="${item.value}" value="${item.value}" ${active.has(item.value) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                    <span>${escapeHtml(item.label)}</span>
                </label>
            `).join('')}
        </div>
    `;
}

function isContiguous(values) {
    return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function summarizeWeekdays(values = []) {
    const sorted = [...values].map(Number).sort((left, right) => left - right);
    if (!sorted.length) return '未选择';
    if (sorted.length === 5 && sorted.every((value, index) => value === index + 1)) return '周一-周五';
    if (sorted.length === 7) return '全周';
    if (sorted.length > 2 && isContiguous(sorted)) return `周${dayName(sorted[0])}-周${dayName(sorted[sorted.length - 1])}`;
    if (sorted.length > 4) return `${sorted.length} 天`;
    return sorted.map(value => `周${dayName(value)}`).join('、');
}

function summarizePeriods(values = []) {
    const sorted = [...values].map(Number).sort((left, right) => left - right);
    if (!sorted.length) return '未选择';
    if (sorted.length > 1 && isContiguous(sorted)) return `第${sorted[0]}-${sorted[sorted.length - 1]}节`;
    if (sorted.length > 4) return `${sorted.length} 节`;
    return sorted.map(value => `第${value}节`).join('、');
}

function renderPresetButtons(items, attr) {
    return `
        <div class="tt-preset-row">
            ${items.map(item => `<button type="button" ${attr}="${escapeAttr(item.value)}">${escapeHtml(item.label)}</button>`).join('')}
        </div>
    `;
}

function renderMultiSelect({
    id,
    triggerId,
    title,
    summary,
    items,
    activeValues,
    dataAttr,
    presets = [],
    presetAttr = 'data-range-preset',
    doneAttr = 'data-tt-popover-close',
    summaryOnly = false,
}) {
    const triggerClass = `tt-multi-select-trigger${summaryOnly ? ' tt-multi-select-trigger--summary-only' : ''}`;
    return `
        <details class="tt-multi-select" data-tt-multi-select="${escapeAttr(id)}">
            <summary class="${triggerClass}" id="${escapeAttr(triggerId)}">
                ${summaryOnly ? '' : `<span>${escapeHtml(title)}</span>`}
                <strong>${escapeHtml(summary)}</strong>
                <i data-lucide="chevron-down"></i>
            </summary>
            <div class="tt-multi-select-popover">
                <div class="tt-popover-header">
                    <strong>${escapeHtml(title)}</strong>
                    <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-tt-popover-close title="关闭" aria-label="关闭"><i data-lucide="x"></i></button>
                </div>
                ${presets.length ? renderPresetButtons(presets, presetAttr) : ''}
                ${renderCheckList({ items, activeValues, dataAttr })}
                <div class="tt-popover-actions">
                    <button class="tt-btn" type="button" ${doneAttr}><i data-lucide="check"></i><span>完成</span></button>
                </div>
            </div>
        </details>
    `;
}

function getRangeDraft(state) {
    return {
        activeWeekdays: state.rangeDraft?.activeWeekdays || getActiveWeekdays(state.project),
        activePeriods: state.rangeDraft?.activePeriods || getActivePeriods(state.project),
    };
}

function defaultWorkflowOpenSections(state) {
    if (Array.isArray(state.workflowOpenSections)) return new Set(state.workflowOpenSections);
    if (!(state.project?.lessonPlans || []).length) return new Set(['data']);
    if ((state.ruleDraftPreview || []).length || (state.ruleWarnings || []).length) return new Set(['rules']);
    if ((state.project?.schedule?.slots || []).length) return new Set(['solve']);
    return new Set(['data']);
}

function renderWorkflowPanel({ id, icon, title, chip = '', open, content }) {
    return `
        <section class="tt-section tt-workflow-panel ${open ? 'is-open' : ''}" data-workflow-step="${escapeAttr(id)}">
            <button class="tt-section-title tt-workflow-toggle" type="button" data-tt-section-toggle="${escapeAttr(id)}" aria-expanded="${open ? 'true' : 'false'}">
                <h3><i data-lucide="${escapeAttr(icon)}"></i><span>${escapeHtml(title)}</span></h3>
                <span class="tt-workflow-title-meta">
                    ${chip ? `<span class="tt-chip">${escapeHtml(chip)}</span>` : ''}
                    <i data-lucide="chevron-down"></i>
                </span>
            </button>
            <div class="tt-workflow-body" ${open ? '' : 'hidden'}>
                ${content}
            </div>
        </section>
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
            ${renderRosterImportDialog(state)}
            ${renderRuleReviewDialog(state)}
            ${renderPublishDialog(state)}
            ${renderRestoreDialog(state)}
            ${renderPublicationHistoryDialog(state)}
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
    const openSections = defaultWorkflowOpenSections(state);
    const stats = getRosterStats(state.project);
    const rules = getRuleSummary(state.project);
    const readiness = getPreparedness(state.project);
    return `
        <div class="tt-workflow">
            ${renderWorkflowPanel({
                id: 'data',
                icon: 'database',
                title: '数据准备',
                chip: `${stats.planCount} 条`,
                open: openSections.has('data'),
                content: `${renderProjectSection(state)}${renderImportSection(state)}`,
            })}
            ${renderWorkflowPanel({
                id: 'rules',
                icon: 'brain-circuit',
                title: 'AI 约束',
                chip: `${rules.total} 条`,
                open: openSections.has('rules'),
                content: renderRulesSection(state),
            })}
            ${renderWorkflowPanel({
                id: 'solve',
                icon: 'sparkles',
                title: '生成导出',
                chip: readiness.ready ? '就绪' : '待准备',
                open: openSections.has('solve'),
                content: `${renderSolveSection(state)}${renderExportSection(state)}`,
            })}
        </div>
    `;
}

function renderProjectSection(state) {
    const { project } = state;
    const { activeWeekdays, activePeriods } = getRangeDraft(state);
    return `
        <div class="tt-setup-card" data-workflow-step="data">
            <div class="tt-subsection-title">
                <h4><i data-lucide="calendar-days"></i><span>排课范围</span></h4>
                <span class="tt-chip">${activeWeekdays.length} 天 · ${activePeriods.length} 节</span>
            </div>
            <form id="tt-project-form" class="tt-range-form">
                <div class="tt-range-summary-grid">
                    ${renderMultiSelect({
                        id: 'range-weekdays',
                        triggerId: 'tt-range-weekdays-trigger',
                        title: '可用周几',
                        summary: summarizeWeekdays(activeWeekdays),
                        items: WEEKDAY_OPTIONS,
                        activeValues: activeWeekdays,
                        dataAttr: 'data-active-weekday',
                        presets: [
                            { value: 'weekdays:workdays', label: '工作日' },
                            { value: 'weekdays:all', label: '全周' },
                        ],
                        doneAttr: 'data-range-apply',
                        summaryOnly: true,
                    })}
                    ${renderMultiSelect({
                        id: 'range-periods',
                        triggerId: 'tt-range-periods-trigger',
                        title: '可用节次',
                        summary: summarizePeriods(activePeriods),
                        items: PERIOD_OPTIONS,
                        activeValues: activePeriods,
                        dataAttr: 'data-active-period',
                        presets: [
                            { value: 'periods:first7', label: '第1-7节' },
                            { value: 'periods:all', label: '全部节次' },
                        ],
                        doneAttr: 'data-range-apply',
                        summaryOnly: true,
                    })}
                </div>
            </form>
        </div>
    `;
}

function renderImportSection(state) {
    const { project } = state;
    const stats = getRosterStats(project);
    const hasRoster = stats.planCount > 0;
    return `
        <div class="tt-setup-card" data-workflow-step="data">
            <div class="tt-subsection-title">
                <h4><i data-lucide="file-input"></i><span>任课数据</span></h4>
                <span class="tt-chip">${stats.planCount} 条</span>
            </div>
            ${hasRoster ? `
                ${renderRosterStats(stats)}
                <div class="tt-action-row">
                    <button class="tt-btn" id="tt-reopen-roster-import" type="button"><i data-lucide="refresh-cw"></i><span>重新导入</span></button>
                    <button class="tt-btn" id="tt-edit-roster" type="button"><i data-lucide="pencil"></i><span>编辑任课</span></button>
                    <button class="tt-btn tt-btn--danger" id="tt-clear-roster" type="button"><i data-lucide="trash-2"></i><span>清空</span></button>
                </div>
            ` : `
                <button class="tt-empty-card tt-roster-entry" id="tt-open-roster-import" data-roster-import-trigger type="button">
                    <i data-lucide="file-input"></i>
                    <strong>导入任课数据</strong>
                    <span>导入年级、班级、课程、教师和周课时后再生成统计。</span>
                </button>
            `}
        </div>
    `;
}

function renderRosterImportDialog(state) {
    const dialog = state.rosterImport || {};
    if (!dialog.open) return '';
    const mode = dialog.mode === 'text' ? 'text' : 'file';
    const fileName = dialog.fileName || '选择 CSV / TXT / Excel 文件';
    const isReview = dialog.step === 'review';
    return `
        <div class="tt-dialog-overlay" data-roster-import-close>
            <section class="tt-roster-import-dialog" id="tt-roster-import-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-roster-import-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">任课数据</span>
                        <h3 id="tt-roster-import-title">${isReview ? '复核任课数据' : '导入任课数据'}</h3>
                        <p>${isReview ? '检查解析后的任课表，可以增删改；确认后才会写入项目并清空旧课表。' : '上传文件、粘贴文本，或直接手动新增任课表。'}</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-cancel-roster-import" type="button" title="关闭导入" aria-label="关闭导入"><i data-lucide="x"></i></button>
                </div>
                ${isReview ? renderRosterReview(dialog) : renderRosterImportInput(dialog, mode, fileName)}
            </section>
        </div>
    `;
}

function renderRosterImportInput(dialog, mode, fileName) {
    return `
        <div class="tt-segment tt-import-mode-tabs" role="group" aria-label="导入方式">
            <button class="${mode === 'file' ? 'is-active' : ''}" type="button" data-roster-import-mode="file">上传文件</button>
            <button class="${mode === 'text' ? 'is-active' : ''}" type="button" data-roster-import-mode="text">粘贴文本</button>
        </div>
        <label class="tt-import-dropzone ${mode === 'file' ? 'is-active' : ''}">
            <i data-lucide="upload-cloud"></i>
            <strong>${escapeHtml(fileName)}</strong>
            <span>.csv / .txt / .xlsx / .xls</span>
            <input id="tt-roster-import-file" type="file" accept=".csv,.txt,.xlsx,.xls">
        </label>
        <div class="tt-rule-block ${mode === 'text' ? 'is-active' : ''}">
            <span class="tt-rule-title">粘贴任课数据</span>
            <textarea id="tt-roster-import-text" class="tt-import-text" spellcheck="false" placeholder="年级,班级,课程,教师,周课时,连堂,教室">${escapeHtml(dialog.text || '')}</textarea>
        </div>
        <div class="tt-dialog-actions">
            <button class="tt-btn" id="tt-fill-roster-sample" type="button"><i data-lucide="wand-sparkles"></i><span>示例</span></button>
            <button class="tt-btn" id="tt-start-empty-roster-review" type="button"><i data-lucide="plus"></i><span>手动新增</span></button>
            <button class="tt-btn" id="tt-cancel-roster-import-secondary" type="button"><i data-lucide="x"></i><span>取消</span></button>
            <button class="tt-btn tt-btn--primary" id="tt-preview-roster-import" type="button"><i data-lucide="file-search"></i><span>解析复核</span></button>
        </div>
    `;
}

function renderRosterReview(dialog) {
    const rows = dialog.draftRows || [];
    const issues = dialog.issues || [];
    const blocking = Boolean(dialog.hasBlockingIssues || issues.some(issue => issue.severity === 'error'));
    return `
        ${dialog.stats ? renderRosterStats(dialog.stats) : ''}
        ${issues.length ? `
            <div class="tt-roster-review-issues">
                ${issues.slice(0, 4).map(issue => `
                    <div class="tt-rule-warning ${issue.severity === 'error' ? 'tt-rule-warning--error' : ''}">
                        <i data-lucide="${issue.severity === 'error' ? 'alert-triangle' : 'info'}"></i>
                        <span>${escapeHtml(issue.message)}</span>
                    </div>
                `).join('')}
            </div>
        ` : ''}
        <div class="tt-roster-review-wrap">
            <table class="tt-roster-review-table" id="tt-roster-review-table">
                <thead>
                    <tr>
                        <th>年级</th>
                        <th>班级</th>
                        <th>课程</th>
                        <th>类型</th>
                        <th>标签</th>
                        <th>教师</th>
                        <th>周课时</th>
                        <th>连堂</th>
                        <th>教室</th>
                        <th>问题</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(row => renderRosterReviewRow(row)).join('')}
                </tbody>
            </table>
        </div>
        <div class="tt-roster-bulk-panel">
            <textarea id="tt-roster-bulk-text" class="tt-import-text" spellcheck="false" placeholder="可粘贴多行任课数据并追加到复核表"></textarea>
            <div class="tt-action-row tt-action-row--end">
                <button class="tt-btn" id="tt-add-roster-review-row" type="button"><i data-lucide="plus"></i><span>新增行</span></button>
                <button class="tt-btn" id="tt-append-roster-rows" type="button"><i data-lucide="list-plus"></i><span>追加粘贴</span></button>
            </div>
        </div>
        <div class="tt-dialog-actions">
            <button class="tt-btn" id="tt-cancel-roster-import-secondary" type="button"><i data-lucide="x"></i><span>取消</span></button>
            <button class="tt-btn tt-btn--primary" id="tt-confirm-roster-import" type="button" ${blocking ? 'disabled' : ''}><i data-lucide="check"></i><span>确认导入</span></button>
        </div>
    `;
}

function renderRosterReviewRow(row) {
    const issues = row.issues || [];
    const hasError = issues.some(issue => issue.severity === 'error');
    const issueText = issues.map(issue => issue.message).join('；') || '无';
    const input = (field, value, type = 'text') => `
        <input class="tt-roster-review-field" data-roster-field="${escapeAttr(field)}" type="${escapeAttr(type)}" value="${escapeAttr(value ?? '')}">
    `;
    return `
        <tr class="tt-roster-review-row ${hasError ? 'tt-roster-review-row--error' : ''}" data-roster-review-row="${escapeAttr(row.id)}">
            <td>${input('grade', row.grade)}</td>
            <td>${input('className', row.className)}</td>
            <td>${input('subjectName', row.subjectName)}</td>
            <td>
                <select class="tt-roster-review-field" data-roster-field="subjectCategory">
                    <option value="normal" ${row.subjectCategory === 'normal' ? 'selected' : ''}>普通</option>
                    <option value="main" ${row.subjectCategory === 'main' ? 'selected' : ''}>主科</option>
                    <option value="quality" ${row.subjectCategory === 'quality' ? 'selected' : ''}>素质</option>
                    <option value="lab" ${row.subjectCategory === 'lab' ? 'selected' : ''}>实验</option>
                </select>
            </td>
            <td>${input('subjectTags', Array.isArray(row.subjectTags) ? row.subjectTags.join('、') : row.subjectTags)}</td>
            <td>${input('teacherName', row.teacherName)}</td>
            <td>${input('weeklyHours', row.weeklyHours, 'number')}</td>
            <td>
                <select class="tt-roster-review-field" data-roster-field="blockPreference">
                    <option value="single" ${row.blockPreference === 'single' ? 'selected' : ''}>单节</option>
                    <option value="double" ${row.blockPreference === 'double' ? 'selected' : ''}>双连堂</option>
                    <option value="mixed" ${row.blockPreference === 'mixed' ? 'selected' : ''}>混合</option>
                </select>
            </td>
            <td>${input('roomName', row.roomName)}</td>
            <td><span class="tt-roster-review-issue">${escapeHtml(issueText)}</span></td>
            <td>
                <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-roster-delete-row="${escapeAttr(row.id)}" title="删除此行" aria-label="删除此行"><i data-lucide="trash-2"></i></button>
            </td>
        </tr>
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
    const savedItems = getSavedRuleItems(project);
    const review = state.ruleReview || {};
    const draftRows = (review.draftRows || []).length ? (review.draftRows || []) : (state.pendingRules || []);
    const savedCount = savedItems.length;
    const draftCount = draftRows.length;
    const warningCount = (review.warnings || state.ruleWarnings || []).length + (review.unsupportedItems || []).length;
    const cardTitle = draftCount ? '继续复核 AI 约束' : savedCount ? '查看 AI 约束' : '导入 AI 约束';
    const cardDescription = draftCount
        ? `${draftCount} 条草稿${warningCount ? ` / ${warningCount} 条警告` : ''}，进入复核表后确认生效。`
        : savedCount
            ? `已保存 ${savedCount} 条规则，可查看、删除或重新解析。`
            : '上传 TXT/XLSX 或粘贴自然语言，复核后生效。';

    return `
        <div class="tt-rule-stack" data-workflow-step="rules">
            <button class="tt-empty-card tt-roster-entry tt-rule-entry" id="tt-open-rule-review" type="button">
                <i data-lucide="brain-circuit"></i>
                <strong>${escapeHtml(cardTitle)}</strong>
                <span>${escapeHtml(cardDescription)}</span>
            </button>
            ${renderRuleReviewStatus({ savedCount, draftCount, warningCount })}
            ${(savedCount || draftCount || warningCount) ? `
                <div class="tt-action-row tt-action-row--compact">
                    <button class="tt-btn" id="tt-reparse-rule-review" type="button"><i data-lucide="upload"></i><span>重新解析</span></button>
                    <button class="tt-btn tt-btn--danger" id="tt-clear-rules" type="button"><i data-lucide="trash-2"></i><span>清空规则</span></button>
                </div>
            ` : ''}
        </div>
    `;
}

function renderRuleInputArea(ruleInput = {}) {
    const loading = ruleInput.loading;
    return `
        <div class="tt-rule-input-area" id="tt-rule-input-area">
            <textarea id="tt-rule-input-text" class="tt-rule-input-text" spellcheck="false"
                placeholder="描述排课约束，例如：王老师周三下午不排课，数学尽量上午"
                ${loading ? 'disabled' : ''}>${escapeHtml(ruleInput.text || '')}</textarea>
            <div class="tt-rule-input-actions">
                <label class="tt-rule-file-label" ${loading ? 'disabled' : ''}>
                    <i data-lucide="paperclip"></i>
                    <span>${ruleInput.fileName ? escapeHtml(ruleInput.fileName) : '上传文件'}</span>
                    <input id="tt-rule-input-file" type="file" accept=".txt,.csv,.xlsx,.xls" ${loading ? 'disabled' : ''}>
                </label>
                <button class="tt-btn tt-btn--primary tt-btn--sm" id="tt-rule-parse-btn" type="button" ${loading ? 'disabled' : ''}>
                    <i data-lucide="${loading ? 'loader-2' : 'sparkles'}"></i>
                    <span>${loading ? '解析中…' : 'AI 解析'}</span>
                </button>
                <button class="tt-btn tt-btn--sm" id="tt-rule-manual-add-btn" type="button" ${loading ? 'disabled' : ''}>
                    <i data-lucide="plus"></i>
                    <span>手动添加</span>
                </button>
            </div>
            <div class="tt-rule-examples" aria-label="示例约束">
                ${[
                    '王老师周三下午不要排课',
                    '语数英尽量排上午',
                    '李老师每天最多上3节',
                    '体育课分散开',
                ].map(example => `<button type="button" class="tt-rule-example-chip" data-rule-example="${escapeAttr(example)}">${escapeHtml(example)}</button>`).join('')}
            </div>
        </div>
    `;
}

function renderPendingCards(pending = [], expandedId = null, project = {}) {
    return `
        <div class="tt-pending-rules" id="tt-pending-rules">
            <div class="tt-pending-header">
                <strong>待确认 (${pending.length})</strong>
                <div class="tt-pending-batch">
                    <button class="tt-btn tt-btn--sm" id="tt-rule-accept-all" type="button"><i data-lucide="check-check"></i><span>全部接受</span></button>
                    <button class="tt-btn tt-btn--sm tt-btn--ghost" id="tt-rule-reject-all" type="button"><i data-lucide="x"></i><span>全部拒绝</span></button>
                </div>
            </div>
            ${pending.map(rule => renderRuleCard(rule, expandedId === rule.id, project)).join('')}
        </div>
    `;
}

function renderRuleCard(rule = {}, expanded = false, project = {}) {
    const priority = rule.priority || 'soft';
    const status = rule.status || 'needs_review';
    const type = rule.type || '';
    const isSuggestion = ['suggestion', 'unsupported'].includes(status);
    const borderClass = priority === 'hard' ? 'tt-rule-card--hard' : isSuggestion ? 'tt-rule-card--suggestion' : 'tt-rule-card--soft';
    const confidence = rule.confidence !== null && rule.confidence !== undefined
        ? `<span class="tt-confidence-badge">${Math.round(Number(rule.confidence) * 100)}%</span>` : '';

    if (expanded) {
        return `
            <div class="tt-rule-card ${borderClass} tt-rule-card--expanded" data-rule-card="${escapeAttr(rule.id)}">
                <div class="tt-rule-card-head">
                    <span class="tt-rule-card-type">${escapeHtml(ruleTypeLabel(type))}</span>
                    ${confidence}
                </div>
                <div class="tt-rule-card-edit">
                    <label><span>对象</span>${renderRuleTargetField(rule, project)}</label>
                    <label><span>节次</span><input class="tt-roster-review-field" data-pending-field="slots" type="text" value="${escapeAttr((rule.slots || []).join(', '))}" placeholder="如 3-4, 3-5"></label>
                    <label><span>强弱</span>
                        <select class="tt-roster-review-field" data-pending-field="priority">
                            <option value="hard" ${priority === 'hard' ? 'selected' : ''}>硬性（必须）</option>
                            <option value="soft" ${priority === 'soft' ? 'selected' : ''}>软性（尽量）</option>
                        </select>
                    </label>
                    ${rule.rawText ? `<div class="tt-rule-card-raw"><small>原始：${escapeHtml(rule.rawText)}</small></div>` : ''}
                </div>
                <div class="tt-rule-card-actions">
                    <button class="tt-btn tt-btn--primary tt-btn--sm" type="button" data-rule-accept="${escapeAttr(rule.id)}"><i data-lucide="check"></i><span>接受</span></button>
                    <button class="tt-btn tt-btn--sm tt-btn--ghost" type="button" data-rule-reject="${escapeAttr(rule.id)}"><i data-lucide="x"></i><span>拒绝</span></button>
                    <button class="tt-btn tt-btn--sm" type="button" data-rule-collapse="${escapeAttr(rule.id)}"><i data-lucide="chevron-up"></i><span>收起</span></button>
                </div>
            </div>
        `;
    }

    return `
        <div class="tt-rule-card ${borderClass}" data-rule-card="${escapeAttr(rule.id)}">
            <div class="tt-rule-card-head" data-rule-expand="${escapeAttr(rule.id)}">
                <span class="tt-rule-card-type">${escapeHtml(ruleTypeLabel(type))}</span>
                ${confidence}
            </div>
            <div class="tt-rule-card-body" data-rule-expand="${escapeAttr(rule.id)}">
                <strong>${escapeHtml(rule.targetName || rule.targetId || '-')}</strong>
                ${(rule.slots || []).length ? `<span class="tt-rule-card-slots">${escapeHtml(rule.slots.join(', '))}</span>` : ''}
                ${isSuggestion ? `<em class="tt-muted">${escapeHtml(ruleStatusLabel(status))}</em>` : ''}
            </div>
            <div class="tt-rule-card-actions">
                ${isSuggestion
                    ? `<button class="tt-btn tt-btn--sm tt-btn--ghost" type="button" data-rule-reject="${escapeAttr(rule.id)}">忽略</button>`
                    : `<button class="tt-btn tt-btn--primary tt-btn--sm" type="button" data-rule-accept="${escapeAttr(rule.id)}"><i data-lucide="check"></i></button>
                       <button class="tt-btn tt-btn--sm tt-btn--ghost" type="button" data-rule-reject="${escapeAttr(rule.id)}"><i data-lucide="x"></i></button>`
                }
            </div>
        </div>
    `;
}

function renderSavedRuleList(items = []) {
    if (!items.length) {
        return `<div class="tt-saved-rules-empty"><span class="tt-muted">暂无已生效约束</span></div>`;
    }
    return `
        <div class="tt-saved-rules" id="tt-saved-rules">
            <div class="tt-saved-header">
                <strong>已生效 (${items.length})</strong>
                <button class="tt-btn tt-btn--sm tt-btn--ghost tt-btn--danger" id="tt-clear-rules" type="button">清空</button>
            </div>
            ${items.map(item => `
                <div class="tt-saved-rule-row" data-saved-rule="${escapeAttr(item.id)}">
                    <span class="tt-saved-rule-target">${escapeHtml(item.targetName || '-')}</span>
                    <span class="tt-saved-rule-desc">${escapeHtml(ruleTypeLabel(item.type))}</span>
                    <span class="tt-saved-rule-badge tt-saved-rule-badge--${item.priority === 'hard' ? 'hard' : 'soft'}">${item.priority === 'hard' ? '硬' : '软'}</span>
                    <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-saved-rule-delete="${escapeAttr(item.id)}" title="删除" aria-label="删除"><i data-lucide="x"></i></button>
                </div>
            `).join('')}
        </div>
    `;
}

function renderNumberSelect(id, values, labelFor) {
    return `
        <select id="${escapeAttr(id)}">
            ${values.map(value => `<option value="${value}">${escapeHtml(labelFor(value))}</option>`).join('')}
        </select>
    `;
}

function renderRuleReviewStatus({ savedCount = 0, draftCount = 0, warningCount = 0 } = {}) {
    const status = draftCount
        ? `${draftCount} 条待复核`
        : savedCount
            ? '规则已生效'
            : '等待解析';
    return `
        <div class="tt-rule-summary">
            <span><b>已保存</b>${escapeHtml(savedCount)} 条</span>
            <span><b>待复核</b>${escapeHtml(draftCount)} 条</span>
            <span class="${warningCount ? 'is-warning' : ''}"><b>警告</b>${escapeHtml(warningCount)} 条</span>
            <em>${escapeHtml(status)}</em>
        </div>
    `;
}

function renderRulePreview(state) {
    const items = state.ruleDraftPreview || [];
    const warnings = state.ruleWarnings || [];
    const inputType = state.ruleDraftInputType || '';
    const stats = state.ruleContextStats || null;
    if (!items.length && !warnings.length) {
        return '<div class="tt-rule-preview"><span class="tt-muted">AI 解析后会在这里预览，确认后才会保存。</span></div>';
    }
    return `
        <div class="tt-rule-preview">
            ${inputType || stats ? `
                <div class="tt-rule-preview-meta">
                    ${inputType ? `<span class="tt-chip">${escapeHtml(inputType)}</span>` : ''}
                    ${stats?.classCount !== undefined ? `<span>${escapeHtml(stats.classCount)} 班</span>` : ''}
                    ${stats?.teacherCount !== undefined ? `<span>${escapeHtml(stats.teacherCount)} 教师</span>` : ''}
                    ${stats?.subjectCount !== undefined ? `<span>${escapeHtml(stats.subjectCount)} 课程</span>` : ''}
                    ${stats?.totalLessons !== undefined ? `<span>${escapeHtml(stats.totalLessons)} 课时</span>` : ''}
                    ${stats?.rowCount !== undefined ? `<span>${escapeHtml(stats.rowCount)} 条</span>` : ''}
                </div>
            ` : ''}
            ${items.map(item => `
                <div class="tt-rule-preview-item">
                    <strong>${escapeHtml(item.targetName || item.targetId || item.type)}</strong>
                    <span>${escapeHtml(item.type)} · ${escapeHtml(item.priority || 'hard')} · ${escapeHtml(item.status || 'ready')} · ${escapeHtml((item.slots || []).join(', ') || '全局')}</span>
                    ${item.description ? `<em>${escapeHtml(item.description)}</em>` : ''}
                </div>
            `).join('')}
            ${warnings.map(warning => `<div class="tt-rule-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(warning)}</span></div>`).join('')}
        </div>
    `;
}

function renderRuleReviewDialog(state) {
    const dialog = state.ruleReview || {};
    if (!dialog.open) return '';
    const mode = dialog.mode || 'text';
    const isReview = dialog.step === 'review';
    const isSaved = dialog.step === 'saved';
    return `
        <div class="tt-dialog-overlay" data-rule-review-close>
            <section class="tt-rule-review-dialog" id="tt-rule-review-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-rule-review-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">AI 约束</span>
                        <h3 id="tt-rule-review-title">${isSaved ? '已生效规则' : isReview ? '复核约束草稿' : '约束复核中心'}</h3>
                        <p>${isSaved ? '这些规则已经写入项目，并会参与下一次排课。' : isReview ? '只会保存状态为可生效的规则；建议项和未支持项仅供审查。' : '上传 TXT/XLSX、粘贴自然语言，或手动批量新增规则，全部先进入复核表。'}</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-rule-review-cancel" type="button" title="关闭约束复核" aria-label="关闭约束复核"><i data-lucide="x"></i></button>
                </div>
                ${renderRuleReviewProcess(dialog)}
                ${isSaved ? renderSavedRulesTable(state.project) : isReview ? renderRuleReviewTable(dialog, state.project) : renderRuleReviewInput(state, dialog, mode)}
            </section>
        </div>
    `;
}

function renderRuleReviewProcess(dialog = {}) {
    const rows = dialog.draftRows || [];
    const sourceLabel = dialog.fileName
        || dialog.inputType
        || (dialog.mode === 'manual' ? '手动新增' : dialog.mode === 'text' ? '自然语言' : '上传文件');
    if (!dialog.loading && !dialog.phaseText && !dialog.fileName && !dialog.inputType && !rows.length) return '';
    const toneClass = dialog.phaseTone === 'warning' ? 'tt-process-chip--warning' : '';
    const phaseText = dialog.phaseText || (dialog.loading ? '处理中...' : '等待复核');
    return `
        <div class="tt-process-strip" aria-live="polite">
            <span class="tt-process-chip ${toneClass}">
                <i data-lucide="${dialog.loading ? 'loader-2' : dialog.phaseTone === 'warning' ? 'triangle-alert' : 'activity'}" class="${dialog.loading ? 'tt-spin' : ''}"></i>
                <strong>${escapeHtml(phaseText)}</strong>
            </span>
            <span class="tt-process-chip tt-process-chip--muted">${escapeHtml(sourceLabel)}</span>
            <span class="tt-process-chip tt-process-chip--muted">${rows.length} 条草稿</span>
        </div>
    `;
}

function renderSavedRulesTable(project = {}) {
    const items = getSavedRuleItems(project);
    if (!items.length) {
        return `
            <div class="tt-empty-panel">
                <i data-lucide="clipboard-check"></i>
                <strong>暂无已生效规则</strong>
                <span>上传或粘贴 AI 约束，复核确认后会显示在这里。</span>
            </div>
            <div class="tt-dialog-actions">
                <button class="tt-btn" id="tt-saved-rule-add" type="button"><i data-lucide="plus"></i><span>新增约束</span></button>
                <button class="tt-btn" id="tt-rule-review-cancel-secondary" type="button"><i data-lucide="x"></i><span>关闭</span></button>
            </div>
        `;
    }
    return `
        <div class="tt-roster-review-wrap">
            <table class="tt-rule-review-table tt-saved-rule-table" id="tt-saved-rule-table">
                <colgroup class="tt-saved-rule-cols">
                    <col class="tt-saved-rule-col-type">
                    <col class="tt-saved-rule-col-target">
                    <col class="tt-saved-rule-col-slots">
                    <col class="tt-saved-rule-col-priority">
                    <col class="tt-saved-rule-col-description">
                    <col class="tt-saved-rule-col-action">
                </colgroup>
                <thead>
                    <tr>
                        <th>类型</th>
                        <th>对象</th>
                        <th>节次</th>
                        <th>强弱</th>
                        <th>说明</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map(item => `
                        <tr class="tt-saved-rule-table-row" data-saved-rule-row="${escapeAttr(item.id)}">
                            <td>
                                <span class="tt-saved-rule-cell tt-saved-rule-cell--type">
                                    <strong>${escapeHtml(ruleTypeLabel(item.type))}</strong>
                                    <small>${escapeHtml(item.type)}</small>
                                </span>
                            </td>
                            <td><span class="tt-saved-rule-cell">${escapeHtml(item.targetName || '-')}</span></td>
                            <td><span class="tt-saved-rule-cell">${escapeHtml((item.slots || []).join(', ') || '全局')}</span></td>
                            <td><span class="tt-saved-rule-cell">${escapeHtml(item.priority === 'hard' ? '硬性' : '软性')}</span></td>
                            <td><span class="tt-saved-rule-cell tt-saved-rule-cell--description">${escapeHtml(item.description || item.source || '')}</span></td>
                            <td>
                                <div class="tt-saved-rule-action-cell">
                                    <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-saved-rule-delete="${escapeAttr(item.id)}" title="删除已生效规则" aria-label="删除已生效规则"><i data-lucide="trash-2"></i></button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        <div class="tt-dialog-actions">
            <button class="tt-btn" id="tt-saved-rule-add" type="button"><i data-lucide="plus"></i><span>新增约束</span></button>
            <button class="tt-btn" id="tt-rule-review-cancel-secondary" type="button"><i data-lucide="x"></i><span>关闭</span></button>
        </div>
    `;
}

function renderPublishDialog(state) {
    const dialog = state.publishDialog || {};
    if (!dialog.open) return '';
    const schedule = state.project?.schedule || {};
    const publication = schedule.publication || {};
    const summary = publication.summary || schedule.score || {};
    const isBusy = Boolean(dialog.loading);
    const reviewEntries = publishReviewEntries(publication);
    return `
        <div class="tt-dialog-overlay" data-publish-dialog-overlay>
            <section class="tt-publish-dialog" id="tt-publish-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-publish-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">发布确认</span>
                        <h3 id="tt-publish-title">发布课表</h3>
                        <p>发布后可导出正式课表；后续手动调整会让发布版进入草稿已变化状态。</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-cancel-publish" type="button" title="关闭发布确认" aria-label="关闭发布确认" ${isBusy ? 'disabled' : ''}><i data-lucide="x"></i></button>
                </div>
                <div class="tt-publish-summary">
                    <span><b>课时</b>${escapeHtml(`${summary.placedLessons ?? 0}/${summary.totalLessons ?? 0}`)}</span>
                    <span><b>硬冲突</b>${escapeHtml(summary.hardConflicts ?? 0)}</span>
                    <span><b>未排</b>${escapeHtml(summary.unplacedLessons ?? 0)}</span>
                </div>
                ${reviewEntries.length ? `
                    <div class="tt-publish-review">
                        <div class="tt-subsection-title">
                            <h4><i data-lucide="triangle-alert"></i><span>发布提醒</span></h4>
                            <span class="tt-chip tt-chip--warn">${escapeHtml(reviewEntries.length)} 条</span>
                        </div>
                        <div class="tt-rule-warning-list">
                            ${reviewEntries.map(item => `
                                <div class="tt-rule-warning ${item.severity === 'error' ? 'tt-rule-warning--error' : ''}">
                                    <i data-lucide="${item.severity === 'error' ? 'alert-triangle' : 'info'}"></i>
                                    <strong>${escapeHtml(item.title)}</strong>
                                    <span>${escapeHtml(item.message)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
                <label class="tt-rule-block is-active">
                    <span class="tt-rule-title">发布备注</span>
                    <textarea id="tt-publish-note" class="tt-import-text" maxlength="200" placeholder="例如：教务处确认发布，供本周执行。" ${isBusy ? 'disabled' : ''}>${escapeHtml(dialog.note || '')}</textarea>
                </label>
                <div class="tt-dialog-actions">
                    <button class="tt-btn" id="tt-cancel-publish-secondary" type="button" ${isBusy ? 'disabled' : ''}><i data-lucide="x"></i><span>取消</span></button>
                    <button class="tt-btn tt-btn--primary" id="tt-confirm-publish" type="button" ${isBusy ? 'disabled' : ''}>
                        <i data-lucide="${isBusy ? 'loader-2' : 'send'}" class="${isBusy ? 'tt-spin' : ''}"></i><span>${isBusy ? '发布中' : '确认发布'}</span>
                    </button>
                </div>
            </section>
        </div>
    `;
}

function publishReviewEntries(publication = {}, limit = 5) {
    const entries = [];
    const seen = new Set();
    const add = item => {
        if (!item || item.type === 'quality_review') return;
        const title = publicationItemTitle(item);
        const message = item.message || publicationIssueLabel(item.type);
        const key = `${title}|${message}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({
            title,
            message,
            severity: item.severity || 'warning',
        });
    };
    (publication.warnings || []).forEach(add);
    (publication.reviewItems || []).forEach(add);
    return entries.slice(0, limit);
}

function renderRestoreDialog(state) {
    const dialog = state.restoreDialog || {};
    if (!dialog.open) return '';
    const summary = dialog.summary || {};
    const isBusy = Boolean(dialog.loading);
    const hasChanges = Number(summary.total || 0) > 0;
    return `
        <div class="tt-dialog-overlay" data-restore-dialog-overlay>
            <section class="tt-publish-dialog" id="tt-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-restore-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">恢复确认</span>
                        <h3 id="tt-restore-title">恢复发布版</h3>
                        <p>当前草稿将被覆盖，恢复后请复核并重新发布。</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-cancel-restore" type="button" title="关闭恢复确认" aria-label="关闭恢复确认" ${isBusy ? 'disabled' : ''}><i data-lucide="x"></i></button>
                </div>
                <div class="tt-publish-summary">
                    <span><b>目标</b>${escapeHtml(dialog.targetLabel || '发布版')}</span>
                    <span><b>变更数</b>${escapeHtml(summary.total ?? 0)}</span>
                    <span><b>移动</b>${escapeHtml(summary.moved ?? 0)}</span>
                </div>
                <div class="tt-publish-review">
                    <div class="tt-subsection-title">
                        <h4><i data-lucide="history"></i><span>覆盖摘要</span></h4>
                        <span class="tt-chip tt-chip--warn">${escapeHtml(summary.total ?? 0)} 项</span>
                    </div>
                    <div class="tt-detail-list">
                        <span><b>移动</b>${escapeHtml(summary.moved ?? 0)}</span>
                        <span><b>修改</b>${escapeHtml(summary.changed ?? 0)}</span>
                        <span><b>新增</b>${escapeHtml(summary.added ?? 0)}</span>
                        <span><b>移除</b>${escapeHtml(summary.removed ?? 0)}</span>
                        ${hasChanges
                            ? '<span class="is-warning"><b>提醒</b>当前草稿将被覆盖</span>'
                            : '<span><b>提醒</b>当前草稿与发布快照一致</span>'}
                    </div>
                </div>
                <div class="tt-dialog-actions">
                    <button class="tt-btn" id="tt-cancel-restore-secondary" type="button" ${isBusy ? 'disabled' : ''}><i data-lucide="x"></i><span>取消</span></button>
                    <button class="tt-btn tt-btn--primary" id="tt-confirm-restore" type="button" ${isBusy ? 'disabled' : ''}>
                        <i data-lucide="${isBusy ? 'loader-2' : 'history'}" class="${isBusy ? 'tt-spin' : ''}"></i><span>${isBusy ? '恢复中' : '确认恢复'}</span>
                    </button>
                </div>
            </section>
        </div>
    `;
}

function publicationHistoryEntry(state = {}) {
    const dialog = state.publicationHistoryDialog || {};
    const version = Number.parseInt(dialog.version, 10);
    const history = state.project?.schedule?.published?.history || [];
    if (!Number.isInteger(version)) return null;
    return history.find(item => Number.parseInt(item.version, 10) === version) || null;
}

function renderPublicationHistoryDialog(state) {
    const dialog = state.publicationHistoryDialog || {};
    if (!dialog.open) return '';
    const item = publicationHistoryEntry(state);
    if (!item) return '';
    const snapshot = item.snapshot || {};
    const summary = snapshot.publicationSummary || {};
    const fingerprint = item.fingerprint || snapshot.fingerprint || '';
    const slots = Array.isArray(snapshot.slots) ? snapshot.slots : [];
    const publication = state.project?.schedule?.publication || null;
    const historyTargetName = publicationHistoryTargetName(item.version);
    const fingerprintMismatch = hasPublicationFingerprintMismatch(publication, historyTargetName);
    const blockedActionAttrs = fingerprintMismatch
        ? `disabled title="${escapeAttr(PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE)}"`
        : '';
    const slotRows = slots.slice(0, 8).map(slot => `
        <div class="tt-publication-history-slot">
            <strong>${escapeHtml(formatSlotSubject(state.project, slot))}</strong>
            <span>${escapeHtml(formatSlotTime(slot))}</span>
            <em>${escapeHtml(`${slot.day || '-'}-${slot.period || '-'}`)}</em>
        </div>
    `).join('');
    return `
        <div class="tt-dialog-overlay" data-publication-history-overlay>
            <section class="tt-publish-dialog tt-publication-history-dialog" id="tt-publication-history-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-publication-history-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">发布历史</span>
                        <h3 id="tt-publication-history-title">发布版本 V${escapeHtml(item.version || '')}</h3>
                        <p>查看该版本的发布备注、快照摘要和部分课节，用于教务复核。</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-close-publication-history" type="button" title="关闭发布历史" aria-label="关闭发布历史"><i data-lucide="x"></i></button>
                </div>
                <div class="tt-publication-history-detail">
                    <span><b>发布时间</b>${escapeHtml(item.publishedAt || '-')}</span>
                    <span><b>发布备注</b>${escapeHtml(item.note || '-')}</span>
                    <span><b>课表编号</b>${escapeHtml(item.scheduleId || snapshot.scheduleId || '-')}</span>
                    ${fingerprint ? `<span class="tt-fingerprint" title="${escapeAttr(fingerprint)}"><b>发布指纹</b>${escapeHtml(shortPublicationFingerprint(fingerprint))}</span>` : ''}
                    <span><b>快照课时</b>${escapeHtml(snapshot.slotCount ?? slots.length ?? 0)} 节</span>
                    <span><b>完成率</b>${escapeHtml(snapshot.score?.completeness ?? '-')}%</span>
                    <span><b>硬冲突</b>${escapeHtml(summary.hardConflicts ?? 0)}</span>
                </div>
                ${fingerprintMismatch ? `
                    <div class="tt-rule-warning">
                        <i data-lucide="triangle-alert"></i>
                        <strong>${escapeHtml(historyTargetName)}</strong>
                        <span>${escapeHtml(PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE)}</span>
                    </div>
                ` : ''}
                <div class="tt-publication-history-slots">
                    <div class="tt-publication-history-head">
                        <strong>快照课节</strong>
                        <span>${escapeHtml(`${slots.length} 条`)}</span>
                    </div>
                    ${slotRows || '<span class="tt-muted">该历史版本没有可展示的课节明细。</span>'}
                </div>
                <div class="tt-publication-history-exports">
                    <span class="tt-muted">导出该历史版本</span>
                    <div class="tt-export-grid">
                        <button class="tt-export-btn" data-export-history-type="published_class" data-export-history-version="${escapeAttr(item.version || '')}" type="button" ${blockedActionAttrs}><i data-lucide="archive"></i><span>班级</span></button>
                        <button class="tt-export-btn" data-export-history-type="published_teacher" data-export-history-version="${escapeAttr(item.version || '')}" type="button" ${blockedActionAttrs}><i data-lucide="archive"></i><span>教师</span></button>
                        <button class="tt-export-btn" data-export-history-type="published_master" data-export-history-version="${escapeAttr(item.version || '')}" type="button" ${blockedActionAttrs}><i data-lucide="archive"></i><span>总表</span></button>
                    </div>
                </div>
                <div class="tt-dialog-actions">
                    <button class="tt-btn tt-btn--ghost" id="tt-restore-publication-history" type="button" data-restore-publication-version="${escapeAttr(item.version || '')}" ${blockedActionAttrs}><i data-lucide="history"></i><span>恢复为草稿</span></button>
                    <button class="tt-btn" id="tt-close-publication-history-secondary" type="button"><i data-lucide="x"></i><span>关闭</span></button>
                </div>
            </section>
        </div>
    `;
}

function renderRuleReviewInput(state, dialog, mode) {
    const fileName = dialog.fileName || '选择 TXT / XLSX 约束文件';
    const isBusy = Boolean(dialog.loading);
    const disabled = isBusy ? 'disabled' : '';
    const parseIcon = isBusy ? 'loader-2' : 'sparkles';
    const manualIcon = isBusy ? 'loader-2' : 'list-plus';
    const actionIconClass = isBusy ? ' class="tt-spin"' : '';
    const parseText = isBusy ? 'AI 解析中' : 'AI 解析';
    const manualText = isBusy ? '生成中' : '生成复核行';
    return `
        <div class="tt-segment tt-import-mode-tabs" role="group" aria-label="约束来源">
            <button class="${mode === 'text' ? 'is-active' : ''}" type="button" data-rule-review-mode="text" ${disabled}>自然语言</button>
            <button class="${mode === 'file' ? 'is-active' : ''}" type="button" data-rule-review-mode="file" ${disabled}>上传文件</button>
            <button class="${mode === 'manual' ? 'is-active' : ''}" type="button" data-rule-review-mode="manual" ${disabled}>手动批量</button>
        </div>
        <div class="tt-rule-block ${mode === 'text' ? 'is-active' : ''}">
            <span class="tt-rule-title">自然语言描述</span>
            <textarea id="tt-rule-review-text" class="tt-import-text tt-rule-prompt" spellcheck="false" placeholder="例如：王老师周三下午不要排课，语数英尽量上午，七年级1班周五第7节不要排" ${disabled}>${escapeHtml(dialog.text || '')}</textarea>
            <div class="tt-rule-examples" aria-label="示例约束">
                <span class="tt-muted">点此填入示例：</span>
                ${[
                    '王老师周三下午不要排课',
                    '语文数学英语尽量排上午',
                    '李老师每天最多上3节课',
                    '体育课一周内分散开',
                ].map(example => `<button type="button" class="tt-rule-example-chip" data-rule-example="${escapeAttr(example)}">${escapeHtml(example)}</button>`).join('')}
            </div>
        </div>
        <label class="tt-import-dropzone ${mode === 'file' ? 'is-active' : ''}">
            <i data-lucide="upload-cloud"></i>
            <strong>${escapeHtml(fileName)}</strong>
            <span>.txt / .csv / .xlsx / .xls</span>
            <input id="tt-rule-review-file" type="file" accept=".txt,.csv,.xlsx,.xls" ${disabled}>
            ${dialog.fileName ? '<span class="tt-field-hint">已选择文件，点击「AI 解析」开始识别</span>' : ''}
        </label>
        <div class="tt-rule-block ${mode === 'manual' ? 'is-active' : ''}">
            <span class="tt-rule-title">手动批量新增</span>
            ${renderManualRuleBuilder(state, isBusy)}
        </div>
        <div class="tt-dialog-actions">
            <button class="tt-btn" id="tt-rule-review-cancel-secondary" type="button"><i data-lucide="x"></i><span>取消</span></button>
            ${mode === 'manual'
                ? `<button class="tt-btn tt-btn--primary" id="tt-add-manual-rule-rows" type="button" ${disabled}><i data-lucide="${manualIcon}"${actionIconClass}></i><span>${escapeHtml(manualText)}</span></button>`
                : `<button class="tt-btn tt-btn--primary" id="tt-rule-review-parse" type="button" ${disabled}><i data-lucide="${parseIcon}"${actionIconClass}></i><span>${escapeHtml(parseText)}</span></button>`}
        </div>
    `;
}

function renderManualRuleBuilder(state, disabled = false) {
    const project = state.project;
    const days = getActiveWeekdays(project).map(value => ({ value, label: `周${dayName(value)}` }));
    const periods = getActivePeriods(project).map(value => ({ value, label: `第${value}节` }));
    const disabledAttr = disabled ? 'disabled' : '';
    return `
        <div class="tt-form-grid">
            <label><span>规则类型</span>
                <select id="tt-manual-rule-type" ${disabledAttr}>
                    <option value="teacher_unavailable">教师不可排</option>
                    <option value="class_unavailable">班级不可排</option>
                    <option value="locked_slot">锁定课节</option>
                    <option value="subject_morning">课程上午优先</option>
                    <option value="subject_preferred_periods">课程偏好节次</option>
                    <option value="subject_avoid_periods">课程避开节次</option>
                    <option value="subject_spread">同科分散</option>
                </select>
            </label>
        </div>
        <p class="tt-muted">锁定课节会按所选班级、课程、教师和节次生成复核行，确认后才生效。</p>
        ${renderManualTargets(project, disabled)}
        <div class="tt-range-summary-grid">
            ${renderManualCheckGroup('适用周几', days, 'data-manual-rule-day', disabled)}
            ${renderManualCheckGroup('适用节次', periods, 'data-manual-rule-period', disabled)}
        </div>
    `;
}

function renderManualTargets(project, disabled = false) {
    const groups = [
        ['teacher', '教师', project.teachers || [], item => item.name],
        ['class', '班级', project.classes || [], ownerLabel],
        ['subject', '课程', project.subjects || [], item => item.name],
    ];
    return groups.map(([type, label, items, labelFor]) => `
        <div class="tt-bulk-target-group">
            <span>${label}</span>
            <div class="tt-chip-grid">
                ${items.map(item => {
                    const labelText = labelFor(item);
                    return `
                        <label class="tt-check-chip">
                            <input type="checkbox" data-manual-rule-target data-manual-rule-target-type="${type}" data-target-name="${escapeAttr(labelText)}" value="${escapeAttr(item.id)}" ${disabled ? 'disabled' : ''}>
                            <span>${escapeHtml(labelText)}</span>
                        </label>
                    `;
                }).join('') || '<span class="tt-muted">暂无数据</span>'}
            </div>
        </div>
    `).join('');
}

function renderManualCheckGroup(title, items, attr, disabled = false) {
    return `
        <div class="tt-rule-manual-checks">
            <span>${escapeHtml(title)}</span>
            ${renderCheckList({ items, activeValues: items.map(item => item.value), dataAttr: attr, disabled })}
        </div>
    `;
}

function renderRuleReviewTable(dialog, project = {}) {
    const rows = dialog.draftRows || [];
    const warnings = dialog.warnings || [];
    const stats = dialog.contextStats || null;
    const isBusy = Boolean(dialog.loading);
    const disabled = isBusy ? 'disabled' : '';
    return `
        ${stats ? `
            <div class="tt-rule-preview-meta">
                ${dialog.inputType ? `<span class="tt-chip">${escapeHtml(dialog.inputType)}</span>` : ''}
                ${dialog.fileName ? `<span>${escapeHtml(dialog.fileName)}</span>` : ''}
                ${stats.sheetName ? `<span>${escapeHtml(stats.sheetName)}</span>` : ''}
                ${stats.rowCount !== undefined ? `<span>${escapeHtml(stats.rowCount)} 行</span>` : ''}
                ${stats.classCount !== undefined ? `<span>${escapeHtml(stats.classCount)} 班</span>` : ''}
                ${stats.teacherCount !== undefined ? `<span>${escapeHtml(stats.teacherCount)} 教师</span>` : ''}
                ${stats.totalLessons !== undefined ? `<span>${escapeHtml(stats.totalLessons)} 课时</span>` : ''}
            </div>
        ` : ''}
        ${warnings.length ? `
            <div class="tt-roster-review-issues">
                ${warnings.slice(0, 5).map(warning => `
                    <div class="tt-rule-warning">
                        <i data-lucide="triangle-alert"></i>
                        <span>${escapeHtml(warning)}</span>
                    </div>
                `).join('')}
            </div>
        ` : ''}
        <div class="tt-roster-review-wrap">
            <table class="tt-rule-review-table" id="tt-rule-review-table">
                <colgroup class="tt-rule-review-cols">
                    <col class="tt-rule-review-col-raw">
                    <col class="tt-rule-review-col-type">
                    <col class="tt-rule-review-col-target">
                    <col class="tt-rule-review-col-slots">
                    <col class="tt-rule-review-col-priority">
                    <col class="tt-rule-review-col-status">
                    <col class="tt-rule-review-col-description">
                    <col class="tt-rule-review-col-action">
                </colgroup>
                <thead>
                    <tr>
                        <th>原始内容</th>
                        <th>类型</th>
                        <th>对象</th>
                        <th>节次</th>
                        <th>强弱</th>
                        <th>状态</th>
                        <th>说明</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(row => renderRuleReviewRow(row, project, isBusy)).join('')}
                </tbody>
            </table>
        </div>
        <div class="tt-dialog-actions">
            <button class="tt-btn" id="tt-add-rule-review-row" type="button" ${disabled}><i data-lucide="plus"></i><span>新增行</span></button>
            <button class="tt-btn" id="tt-rule-review-cancel-secondary" type="button"><i data-lucide="x"></i><span>取消</span></button>
            <button class="tt-btn tt-btn--primary" id="tt-confirm-rule-review" type="button" ${isBusy || !rows.length ? 'disabled' : ''}><i data-lucide="${isBusy ? 'loader-2' : 'check'}" class="${isBusy ? 'tt-spin' : ''}"></i><span>${isBusy ? '确认中' : '确认生效'}</span></button>
        </div>
    `;
}

function ruleTargetEntities(project = {}, targetType) {
    if (targetType === 'teacher') return (project.teachers || []).map(item => ({ id: item.id, name: item.name }));
    if (targetType === 'class') return (project.classes || []).map(item => ({ id: item.id, name: ownerLabel(item) }));
    if (targetType === 'subject') return (project.subjects || []).map(item => ({ id: item.id, name: item.name }));
    return [];
}

function renderRuleTargetField(row, project, disabled = false) {
    const entities = ruleTargetEntities(project, row.targetType);
    const disabledAttr = disabled ? 'disabled' : '';
    // locked_slot / global rules keep a free-text target; others get a bound dropdown
    if (!entities.length || row.targetType === 'locked_slot' || row.targetType === 'global') {
        return `<input class="tt-roster-review-field" data-rule-review-field="targetName" type="text" value="${escapeAttr(row.targetName || row.targetId || '')}" ${disabledAttr}>`;
    }
    const matchesId = entities.some(item => item.id === row.targetId);
    const matchesName = entities.find(item => item.name === row.targetName);
    const selectedId = matchesId ? row.targetId : (matchesName?.id || '');
    return `
        <select class="tt-roster-review-field tt-rule-target-select" data-rule-review-field="targetName" data-rule-target-select ${disabledAttr}>
            <option value="">未选择</option>
            ${entities.map(item => `<option value="${escapeAttr(item.name)}" data-target-id="${escapeAttr(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
    `;
}

function renderRuleReviewRow(row = {}, project = {}, disabled = false) {
    const warnings = row.warnings || [];
    const status = row.status || 'needs_review';
    const statusOptions = ['effective', 'needs_review', 'suggestion', 'unsupported', 'invalid', 'ignored'];
    const typeOptions = ['teacher_unavailable', 'class_unavailable', 'locked_slot', 'subject_morning', 'subject_preferred_periods', 'subject_avoid_periods', 'teacher_daily_limit', 'teacher_consecutive_limit', 'subject_spread', 'teacher_load_balance', 'block_protection'];
    const disabledAttr = disabled ? 'disabled' : '';
    const input = (field, value, type = 'text') => `
        <input class="tt-roster-review-field" data-rule-review-field="${escapeAttr(field)}" type="${escapeAttr(type)}" value="${escapeAttr(value ?? '')}" ${disabledAttr}>
    `;
    const cell = (main, helper = '') => `
        <div class="tt-rule-review-cell">
            <div class="tt-rule-review-cell-main">${main}</div>
            <div class="tt-rule-review-cell-helper">${helper || '&nbsp;'}</div>
        </div>
    `;
    const slotHint = '<span class="tt-field-hint">格式：周-节，如 3-4；多个用逗号</span>';
    const confidence = row.confidence !== null && row.confidence !== undefined
        ? `<span class="tt-confidence">${Math.round(Number(row.confidence) * 100)}%</span>` : '';
    const warningText = warnings.join('；');
    const warning = warnings.length
        ? `<span class="tt-rule-row-warning" title="${escapeAttr(warningText)}">${escapeHtml(warningText)}</span>` : '';
    return `
        <tr class="tt-rule-review-row tt-rule-review-row--${escapeAttr(status)}" data-rule-review-row="${escapeAttr(row.id)}">
            <td>${cell(input('rawText', row.rawText || row.description || ''))}</td>
            <td>${cell(`
                <select class="tt-roster-review-field" data-rule-review-field="type" ${disabledAttr}>
                    ${typeOptions.map(type => `<option value="${type}" ${row.type === type ? 'selected' : ''}>${escapeHtml(ruleTypeLabel(type))}</option>`).join('')}
                </select>
                <input type="hidden" data-rule-review-field="targetType" value="${escapeAttr(row.targetType || '')}">
                <input type="hidden" data-rule-review-field="targetId" value="${escapeAttr(row.targetId || '')}">
                <input type="hidden" data-rule-review-field="classId" value="${escapeAttr(row.classId || '')}">
                <input type="hidden" data-rule-review-field="className" value="${escapeAttr(row.className || '')}">
                <input type="hidden" data-rule-review-field="subjectId" value="${escapeAttr(row.subjectId || '')}">
                <input type="hidden" data-rule-review-field="subjectName" value="${escapeAttr(row.subjectName || '')}">
                <input type="hidden" data-rule-review-field="teacherId" value="${escapeAttr(row.teacherId || '')}">
                <input type="hidden" data-rule-review-field="teacherName" value="${escapeAttr(row.teacherName || '')}">
            `)}</td>
            <td>${cell(renderRuleTargetField(row, project, disabled))}</td>
            <td>${cell(input('slots', (row.slots || []).join(', ')), slotHint)}</td>
            <td>${cell(`
                <select class="tt-roster-review-field" data-rule-review-field="priority" ${disabledAttr}>
                    <option value="hard" ${row.priority === 'hard' ? 'selected' : ''}>硬性（必须）</option>
                    <option value="soft" ${row.priority === 'soft' ? 'selected' : ''}>软性（尽量）</option>
                </select>
            `)}</td>
            <td>${cell(`
                <select class="tt-roster-review-field" data-rule-review-field="status" ${disabledAttr}>
                    ${statusOptions.map(item => `<option value="${item}" ${status === item ? 'selected' : ''}>${escapeHtml(ruleStatusLabel(item))}</option>`).join('')}
                </select>
            `, confidence)}</td>
            <td>${cell(input('description', row.description || warningText), warning)}</td>
            <td>
                <div class="tt-rule-review-action-cell">
                    <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-rule-review-delete-row="${escapeAttr(row.id)}" title="删除规则行" aria-label="删除规则行" ${disabledAttr}><i data-lucide="trash-2"></i></button>
                </div>
            </td>
        </tr>
    `;
}

function renderSolveSection(state) {
    const { project } = state;
    const readiness = getPreparedness(project);
    const score = getScore(project);
    const placed = score.placedLessons ?? 0;
    const total = score.totalLessons ?? totalPlannedLessons(project);
    const scaleMessage = solveScaleMessage(project);
    const runLabel = state.loading ? (state.solvePhaseText || '快速生成中') : '';
    return `
        <section class="tt-section tt-section--solve" data-workflow-step="solve">
            <div class="tt-section-title">
                <h3><i data-lucide="sparkles"></i><span>求解</span></h3>
                <span class="tt-chip ${readiness.ready ? 'tt-chip--ok' : 'tt-chip--warn'}">${readiness.ready ? '就绪' : '待准备'}</span>
            </div>
            <p class="tt-compact-copy">${placed}/${total} 已排 · ${score.hardConflicts ?? 0} 硬冲突</p>
            <p class="tt-compact-copy">${escapeHtml(readiness.message)}</p>
            ${scaleMessage ? `<p class="tt-compact-copy tt-compact-copy--warn">${escapeHtml(scaleMessage)}</p>` : ''}
            ${runLabel ? `<p class="tt-compact-copy">${escapeHtml(runLabel)}</p>` : ''}
            <button class="tt-btn tt-btn--primary" data-run-schedule type="button" ${state.loading || !readiness.ready ? 'disabled' : ''}>
                <i data-lucide="${state.loading ? 'loader-2' : 'play'}"></i><span>${state.loading ? '快速生成中' : '快速生成'}</span>
            </button>
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

function solverReasonLabel(reason = '') {
    return ({
        not_better: '优化结果没有更好',
        stale_schedule: '课表已被更新，旧优化结果已作废',
        published_schedule: '课表已经发布，后台优化不会覆盖发布版',
        pinned_slot_moved: '锁定课节被移动，优化结果已拒绝',
        hard_score_violation: '优化结果存在硬约束冲突',
        incomplete_solution: '优化结果未排满全部课时',
        hard_conflicts: '优化结果存在硬冲突',
        timeout: '后台优化超时',
        endpoint_missing: 'Timefold 服务版本不匹配',
        not_configured: 'Timefold 服务未配置',
        missing_fetch: '后台请求能力不可用',
        http_error: 'Timefold 服务返回错误',
        failed: '后台优化失败',
    })[reason] || (reason ? '后台优化未采纳' : '');
}

function publicationIssueLabel(type = '') {
    return ({
        published_snapshot_missing: '发布快照',
        published_snapshot_backfill_needed: '发布快照',
        quality_review: '质量建议',
        subject_preferred_period: '偏好节次',
    })[type] || timetableReviewLabel(type);
}

function publicationItemTitle(item = {}) {
    return item.targetName || publicationIssueLabel(item.type);
}

const PUBLICATION_FINGERPRINT_MISMATCH = 'publication_fingerprint_mismatch';
const PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE = '发布快照校验失败，请重新发布后再导出或恢复。';

function publicationHistoryTargetName(version) {
    const parsed = Number.parseInt(version, 10);
    return Number.isInteger(parsed) ? `发布历史 V${parsed}` : '发布历史';
}

function hasPublicationFingerprintMismatch(publication = null, targetName = '') {
    const entries = [
        ...(publication?.warnings || []),
        ...(publication?.reviewItems || []),
    ];
    return entries.some(item => (
        item?.type === PUBLICATION_FINGERPRINT_MISMATCH
        && (!targetName || publicationItemTitle(item) === targetName)
    ));
}

function publishedDraftChanged(project = {}) {
    return isPublishedDraftChanged(project);
}

function shortPublicationFingerprint(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > 12 ? `${text.slice(0, 12)}...` : text;
}

function getSolverDetail(state = {}) {
    const scheduleStats = state.project?.schedule?.solverStats || {};
    const jobStats = state.solverJob?.solverStats || {};
    const failureStats = state.lastFailure?.solverStats || {};
    const stats = { ...scheduleStats, ...jobStats, ...failureStats };
    const hasInitialSolutionInfo = Object.prototype.hasOwnProperty.call(stats, 'initialSolutionUsed');
    const hasPinnedCount = Object.prototype.hasOwnProperty.call(stats, 'pinnedCount');
    const reason = state.solverJob?.reason || stats.reason || state.lastFailure?.reason || '';
    const accepted = state.solverJob ? state.solverJob.accepted : stats.accepted;
    const kept = Boolean(state.lastFailure)
        || state.solverJob?.status === 'failed'
        || state.solverJob?.status === 'skipped'
        || (reason && accepted === false);
    return {
        stats,
        reason,
        reasonLabel: solverReasonLabel(reason),
        accepted,
        kept,
        hasInitialSolutionInfo,
        initialSolutionText: stats.initialSolutionUsed ? '\u5df2\u4f7f\u7528' : '\u672a\u4f7f\u7528',
        hasPinnedCount,
        pinnedCount: Number(stats.pinnedCount || 0),
        staleRejected: Boolean(stats.staleRejected),
    };
}

function renderPublicationPanel(state) {
    const publication = state.project?.schedule?.publication || state.lastFailure?.publication || null;
    if (!publication) return '';
    const summary = publication.summary || {};
    const blocking = publication.blockingIssues || [];
    const warnings = publication.warnings || [];
    const reviewItems = publication.reviewItems || [];
    const published = state.project?.schedule?.published || null;
    const snapshot = published?.snapshot || null;
    const fingerprint = published?.fingerprint || snapshot?.fingerprint || '';
    const fingerprintMismatch = hasPublicationFingerprintMismatch(publication, '发布快照');
    const restorePublishedAttrs = fingerprintMismatch
        ? `disabled title="${escapeAttr(PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE)}"`
        : '';
    const diff = getPublishedScheduleDiff(state.project);
    const draftChanged = publishedDraftChanged(state.project);
    const placed = Number(summary.placedLessons ?? 0);
    const total = Number(summary.totalLessons ?? 0);
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="shield-check"></i><span>发布前校验</span></h3>
                <span class="tt-chip ${publication.ok ? 'tt-chip--ok' : 'tt-chip--warn'}">${publication.ok ? '可发布' : '不可发布'}</span>
            </div>
            <div class="tt-detail-list">
                ${published ? `<span class="${draftChanged ? 'is-warning' : ''}"><b>发布状态</b>${escapeHtml(draftChanged ? '草稿已变化' : `已发布 V${published.version || 1}`)}</span>` : '<span><b>发布状态</b>未发布</span>'}
                ${draftChanged ? '<span class="is-warning"><b>发布已失效</b>当前课表改动后需要重新发布</span>' : ''}
                ${published?.note ? `<span><b>发布备注</b>${escapeHtml(published.note)}</span>` : ''}
                ${fingerprint ? `<span class="tt-fingerprint" title="${escapeAttr(fingerprint)}"><b>发布指纹</b>${escapeHtml(shortPublicationFingerprint(fingerprint))}</span>` : ''}
                ${snapshot ? `<span><b>发布快照</b>${escapeHtml(`${snapshot.slotCount ?? snapshot.slots?.length ?? 0} 节`)}</span>` : ''}
                ${snapshot?.score ? `<span><b>快照完成率</b>${escapeHtml(`${snapshot.score.completeness ?? '-'}%`)}</span>` : ''}
                <span><b>课时</b>${escapeHtml(`${placed}/${total}`)}</span>
                <span><b>硬冲突</b>${escapeHtml(summary.hardConflicts ?? 0)}</span>
                <span><b>未排课时</b>${escapeHtml(summary.unplacedLessons ?? 0)}</span>
                <span><b>提醒</b>${escapeHtml(warnings.length)}</span>
                ${blocking.slice(0, 4).map(item => `<span class="is-warning"><b>${escapeHtml(publicationItemTitle(item))}</b>${escapeHtml(item.message || publicationIssueLabel(item.type))}</span>`).join('')}
                ${warnings.slice(0, 2).map(item => `<span class="is-warning"><b>${escapeHtml(publicationItemTitle(item))}</b>${escapeHtml(item.message || publicationIssueLabel(item.type))}</span>`).join('')}
                ${reviewItems.slice(0, 5).map(item => `<span class="${item.severity === 'error' || item.severity === 'warning' ? 'is-warning' : ''}"><b>${escapeHtml(publicationItemTitle(item))}</b>${escapeHtml(item.message || publicationIssueLabel(item.type))}</span>`).join('')}
            </div>
            ${draftChanged && snapshot?.slots?.length ? `
                <div class="tt-publication-actions tt-publication-actions--published">
                    <button class="tt-btn tt-btn--ghost" id="tt-restore-published-snapshot" type="button" data-restore-published-version="${escapeAttr(published.version || '')}" ${restorePublishedAttrs}>
                        <i data-lucide="history"></i><span>恢复发布版</span>
                    </button>
                </div>
            ` : ''}
            ${renderPublishedDiff(state.project, diff)}
            ${renderPublishedHistory(published)}
        </section>
    `;
}

function renderPublishedHistory(published = null) {
    const history = Array.isArray(published?.history) ? published.history : [];
    if (!history.length) return '';
    const rows = history.slice(-3).reverse().map(item => {
        const slotCount = item.snapshot?.slotCount ?? item.snapshot?.slots?.length ?? 0;
        const note = item.note ? ` · ${item.note}` : '';
        return `
            <button class="tt-publication-history-item" type="button" data-publication-history-version="${escapeAttr(item.version || '')}">
                <strong>V${escapeHtml(item.version || '')}</strong>
                <span>${escapeHtml(`${slotCount} 节${note}`)}</span>
            </button>
        `;
    }).join('');
    return `
        <div class="tt-publication-history">
            <div class="tt-publication-history-head">
                <strong>发布历史</strong>
                <span>${escapeHtml(`${history.length} 版`)}</span>
            </div>
            ${rows}
        </div>
    `;
}

function publishedDiffTypeLabel(type = '') {
    return ({
        moved: '移动',
        changed: '修改',
        added: '新增',
        removed: '移除',
    })[type] || '变化';
}

function renderPublishedDiff(project = {}, diff = {}) {
    const published = project.schedule?.published || null;
    if (!publishedDraftChanged(project) || !diff.hasSnapshot) return '';
    const summary = `移动 ${diff.moved} · 修改 ${diff.changed} · 新增 ${diff.added} · 移除 ${diff.removed}`;
    const rows = (diff.items || []).slice(0, 5).map(item => {
        const slot = item.afterSlot || item.beforeSlot;
        const beforeText = item.beforeSlot ? formatSlotTime(item.beforeSlot) : '无';
        const afterText = item.afterSlot ? formatSlotTime(item.afterSlot) : '无';
        return `
            <div class="tt-publication-diff-item">
                <strong>${escapeHtml(publishedDiffTypeLabel(item.type))}</strong>
                <span>${escapeHtml(formatSlotSubject(project, slot))}</span>
                <em>${escapeHtml(beforeText)} → ${escapeHtml(afterText)}</em>
            </div>
        `;
    }).join('');
    return `
        <div class="tt-publication-diff">
            <div class="tt-publication-diff-head">
                <strong>发布差异</strong>
                <span>${escapeHtml(summary)}</span>
            </div>
            ${rows || '<span class="tt-muted">当前草稿和发布快照一致。</span>'}
        </div>
    `;
}

function publishStatusLabel(schedule = {}) {
    const published = schedule?.published || null;
    if (!published) return '未发布';
    if (publishedDraftChanged({ schedule })) return `草稿已变化 · V${published.version || 1}`;
    return `已发布 V${published.version || 1}`;
}

function publishStatusTone(schedule = {}) {
    if (!schedule?.published) return '';
    return publishedDraftChanged({ schedule }) ? 'tt-chip--warn' : 'tt-chip--ok';
}

function renderExportSection(state) {
    const schedule = state.project?.schedule || null;
    const publication = schedule?.publication || null;
    const canPublish = Boolean(schedule?.slots?.length && publication?.ok);
    const officialExportDisabled = publishedDraftChanged(state.project);
    const officialExportRequiresPublish = schedule?.published?.status !== 'published';
    const hasPublishedSnapshot = Boolean(schedule?.published?.snapshot?.slots?.length);
    const publishedSnapshotMismatch = hasPublicationFingerprintMismatch(publication, '发布快照');
    const officialExportBlocked = officialExportDisabled || officialExportRequiresPublish || publishedSnapshotMismatch;
    const publishedExportTitle = publishedSnapshotMismatch
        ? PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE
        : '导出已发布课表';
    const publishedExportAttrs = publishedSnapshotMismatch
        ? 'disabled'
        : '';
    const publishTitle = canPublish
        ? '发布当前课表'
        : publication
            ? '发布前校验未通过'
            : '请先生成并校验课表';
    const officialExportTitle = publishedSnapshotMismatch
        ? PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE
        : officialExportDisabled
            ? '请重新发布后导出正式课表'
            : officialExportRequiresPublish
                ? '请先发布课表后导出正式课表'
            : '导出正式课表';
    const officialExportCopy = publishedSnapshotMismatch
        ? PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE
        : officialExportDisabled
            ? '当前草稿已变化，请重新发布后导出正式课表。'
            : publication?.ok && officialExportRequiresPublish
                ? '请先发布课表后导出正式课表。'
            : publication?.ok
                ? '发布前校验已通过，可确认发布后导出。'
                : '发布前校验通过后才能发布正式课表。';
    return `
        <section class="tt-section" data-workflow-step="review">
            <div class="tt-section-title">
                <h3><i data-lucide="download"></i><span>发布导出</span></h3>
                <span class="tt-chip ${publishStatusTone(schedule)}">${escapeHtml(publishStatusLabel(schedule))}</span>
            </div>
            <div class="tt-publication-actions">
                <p class="tt-compact-copy">${escapeHtml(officialExportCopy)}</p>
                <button class="tt-btn tt-btn--primary" id="tt-publish-schedule" data-publish-schedule type="button" title="${escapeAttr(publishTitle)}" ${canPublish ? '' : 'disabled'}>
                    <i data-lucide="send"></i><span>发布课表</span>
                </button>
            </div>
            <div class="tt-export-grid">
                <button class="tt-export-btn" data-export-type="class" type="button" title="${escapeAttr(officialExportBlocked ? officialExportTitle : '导出班级课表')}" ${officialExportBlocked ? 'disabled' : ''}><i data-lucide="table"></i><span>班级</span></button>
                <button class="tt-export-btn" data-export-type="teacher" type="button" title="${escapeAttr(officialExportBlocked ? officialExportTitle : '导出教师课表')}" ${officialExportBlocked ? 'disabled' : ''}><i data-lucide="users"></i><span>教师</span></button>
                <button class="tt-export-btn" data-export-type="master" type="button" title="${escapeAttr(officialExportBlocked ? officialExportTitle : '导出总课表')}" ${officialExportBlocked ? 'disabled' : ''}><i data-lucide="layout-grid"></i><span>总表</span></button>
                <button class="tt-export-btn" data-export-type="plans" type="button" title="导出任课信息"><i data-lucide="file-spreadsheet"></i><span>任课</span></button>
            </div>
            ${officialExportDisabled && hasPublishedSnapshot ? `
                <div class="tt-publication-actions tt-publication-actions--published">
                    <p class="tt-compact-copy">${publishedSnapshotMismatch ? escapeHtml(PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE) : '导出发布版'}</p>
                    <div class="tt-export-grid">
                        <button class="tt-export-btn" data-export-type="published_class" type="button" title="${escapeAttr(publishedExportTitle)}" ${publishedExportAttrs}><i data-lucide="archive"></i><span>班级</span></button>
                        <button class="tt-export-btn" data-export-type="published_teacher" type="button" title="${escapeAttr(publishedExportTitle)}" ${publishedExportAttrs}><i data-lucide="archive"></i><span>教师</span></button>
                        <button class="tt-export-btn" data-export-type="published_master" type="button" title="${escapeAttr(publishedExportTitle)}" ${publishedExportAttrs}><i data-lucide="archive"></i><span>总表</span></button>
                    </div>
                </div>
            ` : ''}
        </section>
    `;
}

export function renderSchedulePanel(state) {
    const owners = getOwners(state.project, state.viewMode);
    const readiness = getPreparedness(state.project);
    const optimizationLabel = optimizationStatusLabel(state.solverJob);
    const runLabel = state.loading ? (state.solvePhaseText || '快速生成中') : '';
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
                ${runLabel ? `<span class="tt-chip tt-chip--ok">${escapeHtml(runLabel)}</span>` : ''}
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
    const solverDetail = getSolverDetail(state);
    return `
        <div class="tt-inspector-stack">
            ${selectedDetail ? renderSlotInspector(state) : renderPlanningInspector(state)}
            ${selectedDetail ? '' : renderUnscheduledPlanQueue(state)}
            ${renderAuditPanel(state)}
            ${renderScheduleDiagnosticsPanel(state)}
            ${renderPublicationPanel(state)}
            ${renderQualityPanel(state)}
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
                    ${solverDetail.hasInitialSolutionInfo ? `<span><b>\u521d\u59cb\u89e3</b>${escapeHtml(solverDetail.initialSolutionText)}</span>` : ''}
                    ${solverDetail.hasPinnedCount ? `<span><b>\u9501\u5b9a\u8bfe\u8282</b>${escapeHtml(solverDetail.pinnedCount)}</span>` : ''}
                    ${solverDetail.reasonLabel ? `<span class="${solverDetail.kept ? 'is-warning' : ''}"><b>\u4f18\u5316\u539f\u56e0</b>${escapeHtml(solverDetail.reasonLabel)}</span>` : ''}
                    ${solverDetail.kept ? `<span class="is-warning"><b>\u4f18\u5316\u5904\u7406</b>\u5df2\u4fdd\u7559\u5f53\u524d\u8bfe\u8868${solverDetail.reasonLabel ? `：${escapeHtml(solverDetail.reasonLabel)}。` : ''}</span>` : ''}
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

function renderScheduleDiagnosticsPanel(state) {
    const audit = state.project?.schedule?.audit || state.lastFailure?.audit || null;
    if (!audit) return '';
    const blocking = audit.blockingIssues || [];
    const warnings = audit.warnings || [];
    const teachers = audit.bottlenecks?.teachers || [];
    const classes = audit.bottlenecks?.classes || [];
    const capacity = audit.capacity || {};
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="stethoscope"></i><span>排课诊断</span></h3>
                <span class="tt-chip ${blocking.length ? 'tt-chip--warn' : 'tt-chip--ok'}">${blocking.length ? `${blocking.length} 项` : '正常'}</span>
            </div>
            <div class="tt-detail-list">
                <span><b>容量</b>${escapeHtml(`${capacity.totalLessons ?? 0}/${capacity.classCapacity ?? capacity.availableSlots ?? 0}`)}</span>
                ${teachers[0] ? `<span><b>瓶颈教师</b>${escapeHtml(`${teachers[0].name || teachers[0].id} ${teachers[0].utilization || 0}%`)}</span>` : ''}
                ${classes[0] ? `<span><b>瓶颈班级</b>${escapeHtml(`${classes[0].name || classes[0].id} ${classes[0].utilization || 0}%`)}</span>` : ''}
                ${blocking.slice(0, 3).map(item => `<span class="is-warning"><b>${escapeHtml(timetableReviewLabel(item.type))}</b>${escapeHtml(item.message || timetableReviewLabel(item.type))}</span>`).join('')}
                ${warnings.slice(0, 3).map(item => `<span class="is-warning"><b>${escapeHtml(timetableReviewLabel(item.type))}</b>${escapeHtml(item.message || timetableReviewLabel(item.type))}</span>`).join('')}
            </div>
        </section>
    `;
}

function renderQualityPanel(state) {
    const schedule = state.project?.schedule || {};
    const issues = schedule.qualityIssues || [];
    const breakdown = schedule.score?.softBreakdown || {};
    if (!issues.length && !Object.keys(breakdown).length) return '';
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="line-chart"></i><span>质量建议</span></h3>
                <span class="tt-chip ${issues.length ? 'tt-chip--warn' : 'tt-chip--ok'}">${issues.length}</span>
            </div>
            <div class="tt-audit-grid tt-audit-grid--quality">
                ${Object.entries(breakdown).slice(0, 6).map(([key, value]) => `<span><b>${escapeHtml(timetableReviewLabel(key))}</b>${escapeHtml(value)}</span>`).join('')}
            </div>
            <div class="tt-conflict-list">
                ${issues.slice(0, 5).map(item => `
                    <div class="tt-conflict">
                        <i data-lucide="${item.severity === 'info' ? 'info' : 'alert-circle'}"></i>
                        <span>${escapeHtml(item.message || timetableReviewLabel(item.type))}</span>
                    </div>
                `).join('') || '<span class="tt-muted">当前课表质量良好。</span>'}
            </div>
        </section>
    `;
}

function renderOptimizationPanel(state) {
    const job = state.solverJob;
    const schedule = state.project?.schedule || null;
    if (!job && schedule?.source !== 'fast_constructed') return '';
    const label = optimizationStatusLabel(job);
    const reasonLabel = solverReasonLabel(job?.reason || job?.solverStats?.reason || '');
    const statusText = job
        ? label
        : '等待下一次 Timefold 优化';
    const sourceText = schedule?.source === 'fast_constructed'
        ? '快速课表'
        : schedule?.source === 'timefold_solver'
            ? 'Timefold'
            : schedule?.source === 'manual_adjusted'
                ? '手动调整'
                : schedule?.source === 'published_history_restored'
                    ? '恢复发布版'
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
                ${reasonLabel ? `<span class="is-warning"><b>处理结果</b>${escapeHtml(reasonLabel)}</span>` : ''}
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
