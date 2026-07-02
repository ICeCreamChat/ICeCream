import {
    dayName,
    entityMaps,
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
    getSolveStatus,
    getSlotDetails,
    getVisibleSlots,
    isPublishedDraftChanged,
    ownerLabel,
    totalPlannedLessons,
    getTotalPeriods,
} from './selectors.js';
import { buildRuleReviewTasks, getActiveRuleReviewTask } from './rule-review-tasks.js';
import { renderConstraintChatDock } from './view-chat.js';
import { renderFixPreview } from './view-smart-helper.js';
import { renderSmartWorkbench } from './smart-workbench/workbench-view.js';

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
    const publishedContext = project.schedule?.published?.snapshot?.projectContext || {};
    const subjects = (project.subjects || []).length ? (project.subjects || []) : (publishedContext.subjects || []);
    const classes = (project.classes || []).length ? (project.classes || []) : (publishedContext.classes || []);
    const teacherPool = (project.teachers || []).length ? (project.teachers || []) : (publishedContext.teachers || []);
    const subject = subjects.find(item => item.id === slot.subjectId);
    const klass = classes.find(item => item.id === slot.classId);
    const teacherIds = Array.isArray(slot.teacherIds) && slot.teacherIds.length
        ? slot.teacherIds
        : [slot.teacherId].filter(Boolean);
    const teacherNames = teacherIds
        .map(teacherId => teacherPool.find(item => item.id === teacherId)?.name || teacherId)
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
    effective: '已应用',
    ready: '可应用',
    needs_review: '需要检查',
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
    return new Set(['rules']);
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
    const inspectorOpen = Boolean(state.inspectorOpen || state.selectedSlotId || state.lastFailure || state.solverJob);
    // @deprecated state.ruleReview.open 保留用于向后兼容，实际已切换到 state.smartWorkbench.open
    const smartOpen = Boolean(state.smartWorkbench?.open || state.ruleReview?.open);
    return `
        <div class="tt-workbench ${smartOpen ? 'is-smart-workbench-open' : ''}">
            ${renderTopbar(state)}
            ${smartOpen ? renderSmartWorkbench(state) : `
                <aside class="tt-sidebar">
                    ${renderWorkflow(state)}
                </aside>
                <section class="tt-schedule-panel">
                    ${renderSchedulePanel(state)}
                </section>
                <aside class="tt-inspector">
                    <details class="tt-inspector-drawer" id="tt-inspector-drawer" ${inspectorOpen ? 'open' : ''}>
                        <summary class="tt-inspector-summary">
                            <span><i data-lucide="panel-right-open"></i><strong>排课审查</strong></span>
                            <em>诊断 / 质量 / 发布</em>
                        </summary>
                        <div class="tt-inspector-body">
                            ${renderInspector(state)}
                        </div>
                    </details>
                </aside>
            `}
            ${renderRosterImportDialog(state)}
            ${renderPeriodTimeDialog(state)}
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
    const message = state.message || (isArchiveOnlyReadyState(project)
        ? '当前草稿已清空，可恢复或导出已发布版本。'
        : preparedness.message);
    const activeWeekdays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    return `
        <header class="tt-topbar">
            <div class="tt-title-block">
                <span class="tt-eyebrow">智能排课</span>
                <h2>排课工作台</h2>
                <p>${activeWeekdays.length} 天 · ${activePeriods.length} 节 · ${preparednessSummaryLabel(project, preparedness)}</p>
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
                title: '智能约束',
                chip: `${rules.total} 条`,
                open: openSections.has('rules'),
                content: renderRulesSection(state),
            })}
            ${renderWorkflowPanel({
                id: 'solve',
                icon: 'sparkles',
                title: '生成导出',
                chip: readinessChipLabel(state.project, readiness),
                open: openSections.has('solve'),
                content: `${renderSolveSection(state)}${renderExportSection(state)}`,
            })}
        </div>
    `;
}

function renderPeriodTimesConfig(state) {
    const activePeriods = getActivePeriods(state.project);
    const periodTimes = state.rangeDraft?.periodTimes || state.project?.periodTimes || [];
    const validTimes = periodTimes.filter(item => activePeriods.includes(Number(item.period)) && (item.start || item.end));
    const configuredCount = validTimes.length;
    const firstStart = validTimes.find(item => item.start)?.start || '';
    const lastEnd = [...validTimes].reverse().find(item => item.end)?.end || '';
    const summary = configuredCount
        ? `${firstStart && lastEnd ? `${firstStart}-${lastEnd} · ` : ''}已配置 ${configuredCount} 节`
        : '未配置';
    return `
        <button class="tt-period-time-entry" id="tt-open-period-time-dialog" type="button">
            <span class="tt-period-time-entry-icon">
                <i data-lucide="clock"></i>
            </span>
            <span class="tt-period-time-entry-copy">
                <strong>节次时间</strong>
                <em>${escapeHtml(summary)}</em>
            </span>
            <span class="tt-chip">配置时间</span>
        </button>
    `;
}

function renderSegmentCard(segment, index, totalSegments, activePeriods, saving) {
    const canDelete = totalSegments > 1;
    const usedCount = segment.periodCount || 0;
    const maxCount = 12;
    const escapeAttr = value => String(value ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const escapeHtml = value => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `
        <div class="tt-segment-card" data-segment-id="${escapeAttr(segment.id)}">
            <div class="tt-segment-card-header">
                <input type="text"
                    class="tt-roster-review-field tt-segment-label-input"
                    data-segment-field="${escapeAttr(segment.id)}-label"
                    value="${escapeAttr(segment.label)}"
                    placeholder="时段名称"
                    maxlength="40"
                    ${saving ? 'disabled' : ''}>
                <span class="tt-segment-index">时段 ${index + 1} · 将生成 ${usedCount} 节</span>
                ${canDelete ? `
                    <button type="button"
                        class="tt-icon-btn tt-segment-remove-btn"
                        data-remove-segment="${escapeAttr(segment.id)}"
                        title="删除此时段"
                        ${saving ? 'disabled' : ''}>
                        <i data-lucide="x"></i>
                    </button>
                ` : ''}
            </div>
            <div class="tt-segment-fields">
                <label class="tt-segment-field">
                    <span>首节开始</span>
                    <input type="time"
                        class="tt-roster-review-field"
                        data-segment-field="${escapeAttr(segment.id)}-startTime"
                        value="${escapeAttr(segment.startTime)}"
                        ${saving ? 'disabled' : ''}>
                </label>
                <label class="tt-segment-field">
                    <span>节次数量</span>
                    <input type="number"
                        class="tt-roster-review-field"
                        data-segment-field="${escapeAttr(segment.id)}-periodCount"
                        value="${escapeAttr(segment.periodCount)}"
                        min="1"
                        max="${maxCount}"
                        step="1"
                        ${saving ? 'disabled' : ''}>
                </label>
                <label class="tt-segment-field">
                    <span>课时（分钟）</span>
                    <select class="tt-roster-review-field"
                        data-segment-field="${escapeAttr(segment.id)}-classMinutes"
                        ${saving ? 'disabled' : ''}>
                        <option value="">继承全局</option>
                        <option value="30" ${segment.classMinutes === 30 ? 'selected' : ''}>30</option>
                        <option value="40" ${segment.classMinutes === 40 ? 'selected' : ''}>40</option>
                        <option value="45" ${segment.classMinutes === 45 ? 'selected' : ''}>45</option>
                        <option value="50" ${segment.classMinutes === 50 ? 'selected' : ''}>50</option>
                        <option value="60" ${segment.classMinutes === 60 ? 'selected' : ''}>60</option>
                    </select>
                </label>
                <label class="tt-segment-field">
                    <span>课间（分钟）</span>
                    <select class="tt-roster-review-field"
                        data-segment-field="${escapeAttr(segment.id)}-breakMinutes"
                        ${saving ? 'disabled' : ''}>
                        <option value="">继承全局</option>
                        <option value="5" ${segment.breakMinutes === 5 ? 'selected' : ''}>5</option>
                        <option value="10" ${segment.breakMinutes === 10 ? 'selected' : ''}>10</option>
                        <option value="15" ${segment.breakMinutes === 15 ? 'selected' : ''}>15</option>
                        <option value="20" ${segment.breakMinutes === 20 ? 'selected' : ''}>20</option>
                    </select>
                </label>
            </div>
        </div>
    `;
}

function renderPeriodTimeDialog(state) {
    const dialog = state.periodTimeDialog || {};
    if (!dialog.open) return '';

    // 优先从 dialog.segmentConfig 计算实际节次数，否则回退到 project
    const segmentConfig = dialog.segmentConfig || {
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
            { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: Math.floor(getActivePeriods(state.project).length / 2), classMinutes: null, breakMinutes: null },
            { id: 'seg-2', label: '下午时段', startTime: '14:00', periodCount: getActivePeriods(state.project).length - Math.floor(getActivePeriods(state.project).length / 2), classMinutes: null, breakMinutes: null },
        ],
    };

    // 基于 segmentConfig 计算当前配置的总节次数
    const totalConfiguredPeriods = segmentConfig.segments.reduce((sum, seg) => sum + seg.periodCount, 0);
    const activePeriods = totalConfiguredPeriods > 0
        ? Array.from({ length: totalConfiguredPeriods }, (_, i) => i + 1)
        : [...getActivePeriods(state.project)].sort((left, right) => left - right);
    const segmentLabelMap = new Map();
    let segmentPeriodIndex = 0;
    segmentConfig.segments.forEach(segment => {
        for (let index = 0; index < segment.periodCount && segmentPeriodIndex < activePeriods.length; index += 1) {
            segmentLabelMap.set(activePeriods[segmentPeriodIndex], segment.label);
            segmentPeriodIndex += 1;
        }
    });

    const saving = Boolean(dialog.saving);
    const draftTimes = Array.isArray(dialog.draftTimes) ? dialog.draftTimes : state.rangeDraft?.periodTimes || state.project?.periodTimes || [];
    const timeMap = new Map(draftTimes.map(item => [Number(item.period), item]));
    const errorMap = new Map((dialog.errors || []).map(item => [Number(item.period), item.message || '时间配置有误']));
    const timeToMinutes = value => {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
        return hours * 60 + minutes;
    };
    const gapBetween = (current = {}, next = {}) => {
        const end = timeToMinutes(current.end);
        const start = timeToMinutes(next.start);
        if (end === null || start === null) return '';
        return start - end;
    };
    const errorSummary = [...errorMap.entries()]
        .map(([period, message]) => `第${period}节：${message}`)
        .join('；');
    const escapeAttr = value => String(value ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const escapeHtml = value => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
        <div class="tt-dialog-overlay" data-period-time-dialog-overlay>
            <section class="tt-period-time-dialog" id="tt-period-time-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-period-time-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">排课范围</span>
                        <h3 id="tt-period-time-title">节次时间配置</h3>
                        <p>配置每节课的开始和结束时间，用于课表展示与导出，不会单独改变已生成课表。</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-cancel-period-times" type="button" title="关闭节次时间配置" aria-label="关闭节次时间配置"><i data-lucide="x"></i></button>
                </div>
                <div class="tt-period-time-settings" aria-label="快速生成节次时间">
                    <div class="tt-period-time-settings-head">
                        <strong>快速生成</strong>
                        <span>按真实作息时段配置，系统自动计算节次时间轴；手工改表格后，以时间轴实际值为准。</span>
                    </div>
                    <div class="tt-global-defaults">
                        <label class="tt-segment-field">
                            <span>默认课时（分钟）</span>
                            <input type="number" class="tt-roster-review-field" id="tt-segment-global-class-minutes" data-global-default-field="classMinutes" min="1" max="180" step="1" value="${escapeAttr(segmentConfig.globalDefaults.classMinutes)}" ${saving ? 'disabled' : ''}>
                        </label>
                        <label class="tt-segment-field">
                            <span>默认课间（分钟）</span>
                            <input type="number" class="tt-roster-review-field" id="tt-segment-global-break-minutes" data-global-default-field="breakMinutes" min="0" max="120" step="1" value="${escapeAttr(segmentConfig.globalDefaults.breakMinutes)}" ${saving ? 'disabled' : ''}>
                        </label>
                    </div>
                    <div class="tt-template-selector">
                        <span class="tt-template-label">预设模板：</span>
                        <button type="button" class="tt-btn tt-btn--sm" data-segment-template="standard" ${saving ? 'disabled' : ''}>标准作息</button>
                        <button type="button" class="tt-btn tt-btn--sm" data-segment-template="elementary" ${saving ? 'disabled' : ''}>小学作息</button>
                        <button type="button" class="tt-btn tt-btn--sm" data-segment-template="juniorHigh" ${saving ? 'disabled' : ''}>初中作息</button>
                        <button type="button" class="tt-btn tt-btn--sm" data-segment-template="seniorHigh" ${saving ? 'disabled' : ''}>高中作息</button>
                        <button type="button" class="tt-btn tt-btn--sm" data-segment-template="withMorningEvening" ${saving ? 'disabled' : ''}>含早晚自习</button>
                    </div>
                    <div class="tt-segment-list">
                        ${segmentConfig.segments.map((segment, index) => renderSegmentCard(segment, index, segmentConfig.segments.length, activePeriods, saving)).join('')}
                    </div>
                    <div class="tt-segment-actions">
                        <button type="button" class="tt-btn" id="tt-add-segment" data-add-segment ${saving ? 'disabled' : ''}>
                            <i data-lucide="plus"></i>
                            <span>添加时段</span>
                        </button>
                    </div>
                </div>
                <div class="tt-period-time-preview-head">
                    <strong>节次时间轴</strong>
                    <span>下方时间表由时段配置自动生成,可单独微调。标记🔒的为手动锁定时间。</span>
                </div>
                ${errorSummary ? `<div class="tt-period-time-error-summary" role="alert">${escapeHtml(errorSummary)}</div>` : ''}
                <div class="tt-period-time-review">
                    <table class="tt-period-time-table">
                        <colgroup>
                            <col class="tt-period-time-col-label">
                            <col class="tt-period-time-col-time">
                            <col class="tt-period-time-col-time">
                            <col class="tt-period-time-col-gap">
                        </colgroup>
                        <thead><tr><th>节次</th><th>开始时间</th><th>结束时间</th><th>本节后间隔</th></tr></thead>
                        <tbody>
                            ${activePeriods.map((period, index) => {
                                const entry = timeMap.get(period) || {};
                                const next = timeMap.get(activePeriods[index + 1]) || {};
                                const error = errorMap.get(period) || '';
                                const isManual = entry.manualOverride;
                                const segmentLabel = entry.segmentLabel || segmentLabelMap.get(period) || '';
                                const previousSegmentLabel = timeMap.get(activePeriods[index - 1])?.segmentLabel || segmentLabelMap.get(activePeriods[index - 1]) || '';
                                const showSegmentLabel = index === 0 || segmentLabel !== previousSegmentLabel;
                                return `${showSegmentLabel && segmentLabel ? `<tr class="tt-period-time-segment-header"><td colspan="4"><strong>${escapeHtml(segmentLabel)}</strong></td></tr>` : ''}<tr data-period-time-row="${period}" class="${error ? 'is-error' : ''} ${isManual ? 'is-manual-override' : ''}">
                                    <td class="tt-period-time-label" data-label="节次">第${period}节${isManual ? ' 🔒' : ''}</td>
                                    <td data-label="开始时间"><input type="time" class="tt-roster-review-field tt-period-time-input" data-period-time-draft-start="${period}" value="${escapeAttr(entry.start || '')}" ${error ? 'aria-invalid="true"' : ''} ${saving ? 'disabled' : ''}></td>
                                    <td data-label="结束时间"><input type="time" class="tt-roster-review-field tt-period-time-input" data-period-time-draft-end="${period}" value="${escapeAttr(entry.end || '')}" ${error ? 'aria-invalid="true"' : ''} ${saving ? 'disabled' : ''}></td>
                                    <td data-label="本节后间隔">
                                        ${index < activePeriods.length - 1
                                            ? `<input type="number" class="tt-roster-review-field tt-period-time-gap-input" data-period-time-gap-after="${period}" min="0" max="240" step="1" value="${escapeAttr(gapBetween(entry, next))}" ${saving ? 'disabled' : ''}>`
                                            : '<span class="tt-period-time-gap-empty">无课后间隔</span>'}
                                    </td>
                                </tr>${error ? `<tr class="tt-period-time-error-row"><td colspan="4">${escapeHtml(error)}</td></tr>` : ''}`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="tt-dialog-actions">
                    <button class="tt-btn tt-btn--ghost" id="tt-clear-period-times" type="button" ${saving ? 'disabled' : ''}><i data-lucide="eraser"></i><span>清空时间</span></button>
                    <button class="tt-btn tt-btn--ghost" id="tt-cancel-period-times-secondary" type="button" ${saving ? 'disabled' : ''}><i data-lucide="x"></i><span>取消</span></button>
                    <button class="tt-btn tt-btn--primary" id="tt-save-period-times" type="button" ${saving ? 'disabled' : ''}><i data-lucide="${saving ? 'loader-2' : 'save'}" class="${saving ? 'tt-spin' : ''}"></i><span>${saving ? '保存中' : '保存时间'}</span></button>
                </div>
            </section>
        </div>
    `;
}

function renderProjectSection(state) {
    const { project } = state;
    const { activeWeekdays, activePeriods } = getRangeDraft(state);
    const totalPeriods = getTotalPeriods(project);
    const periodsFromSegments = totalPeriods > 0;

    return `
        <div class="tt-setup-card tt-range-setup-card" data-workflow-step="data">
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
                    ${periodsFromSegments ? `
                        <div class="tt-range-summary-card tt-range-summary-card--readonly">
                            <div class="tt-range-summary-trigger" data-range-label="可用节次">
                                <strong>${summarizePeriods(activePeriods)}</strong>
                                <small>由时段配置自动生成，共 ${totalPeriods} 节</small>
                                <span class="tt-range-summary-icon"><i data-lucide="lock-keyhole"></i></span>
                            </div>
                        </div>
                    ` : renderMultiSelect({
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
                ${renderPeriodTimesConfig(state)}
            </form>
        </div>
    `;
}

function renderImportSection(state) {
    const { project } = state;
    const stats = getRosterStats(project);
    const hasRoster = stats.planCount > 0;
    return `
        <div class="tt-setup-card tt-import-setup-card" data-workflow-step="data">
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
                        <span class="tt-eyebrow">任课数据${isReview && dialog.source ? ` · <span class="tt-badge tt-badge--${dialog.source === 'ai' ? 'success' : 'neutral'}">${dialog.source === 'ai' ? '智能辅助解析' : '本地解析'}</span>` : ''}</span>
                        <h3 id="tt-roster-import-title">${isReview ? '检查任课数据' : '导入任课数据'}</h3>
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
    const isBusy = Boolean(dialog.loading);
    const disabled = isBusy ? 'disabled' : '';
    const previewIcon = isBusy ? 'loader-2' : 'file-search';
    const previewIconClass = isBusy ? ' class="tt-spin"' : '';
    const previewText = isBusy ? '解析中' : '解析检查';
    const phaseText = dialog.phaseText || '解析任课数据中...';
    const phaseTone = dialog.phaseTone === 'warning' ? ' tt-process-chip--warning' : '';
    return `
        <div class="tt-segment tt-import-mode-tabs" role="group" aria-label="导入方式">
            <button class="${mode === 'file' ? 'is-active' : ''}" type="button" data-roster-import-mode="file" ${disabled}>上传文件</button>
            <button class="${mode === 'text' ? 'is-active' : ''}" type="button" data-roster-import-mode="text" ${disabled}>粘贴文本</button>
        </div>
        <label class="tt-import-dropzone ${mode === 'file' ? 'is-active' : ''}">
            <i data-lucide="${isBusy ? 'loader-2' : 'upload-cloud'}" class="${isBusy ? 'tt-spin' : ''}"></i>
            <strong>${escapeHtml(fileName)}</strong>
            <span>.csv / .txt / .xlsx / .xls</span>
            <input id="tt-roster-import-file" type="file" accept=".csv,.txt,.xlsx,.xls" ${disabled}>
        </label>
        <div class="tt-rule-block ${mode === 'text' ? 'is-active' : ''}">
            <span class="tt-rule-title">粘贴任课数据</span>
            <textarea id="tt-roster-import-text" class="tt-import-text" spellcheck="false" placeholder="年级,班级,课程,教师,周课时,连堂,教室" ${disabled}>${escapeHtml(dialog.text || '')}</textarea>
        </div>
        ${isBusy || dialog.phaseText ? `
            <div class="tt-process-strip tt-roster-import-process" aria-live="polite">
                <span class="tt-process-chip${phaseTone}">
                    <i data-lucide="${isBusy ? 'loader-2' : dialog.phaseTone === 'warning' ? 'triangle-alert' : 'activity'}" class="${isBusy ? 'tt-spin' : ''}"></i>
                    <strong>${escapeHtml(phaseText)}</strong>
                </span>
                <span class="tt-process-chip tt-process-chip--muted">任课数据</span>
            </div>
        ` : ''}
        <div class="tt-dialog-actions">
            <button class="tt-btn" id="tt-fill-roster-sample" type="button" ${disabled}><i data-lucide="wand-sparkles"></i><span>示例</span></button>
            <button class="tt-btn" id="tt-start-empty-roster-review" type="button" ${disabled}><i data-lucide="plus"></i><span>手动新增</span></button>
            <button class="tt-btn" id="tt-cancel-roster-import-secondary" type="button"><i data-lucide="x"></i><span>取消</span></button>
            <button class="tt-btn tt-btn--primary" id="tt-preview-roster-import" type="button" ${disabled}><i data-lucide="${previewIcon}"${previewIconClass}></i><span>${escapeHtml(previewText)}</span></button>
        </div>
    `;
}

function renderRosterReview(dialog) {
    const rows = dialog.draftRows || [];
    const issues = dialog.issues || [];
    const blocking = Boolean(dialog.hasBlockingIssues || issues.some(issue => issue.severity === 'error'));
    return `
        ${dialog.stats ? renderRosterStats(dialog.stats) : ''}
        ${renderRosterImportReport(dialog.importReport)}
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
            <textarea id="tt-roster-bulk-text" class="tt-import-text" spellcheck="false" placeholder="可粘贴多行任课数据并追加到检查表"></textarea>
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

function renderRosterImportReport(report) {
    if (!report || !report.summary) return '';
    const summary = report.summary || {};
    const entries = Array.isArray(report.entries) ? report.entries : [];
    const focusEntries = entries.filter(item => item.category !== 'kept').slice(0, 4);
    const visibleEntries = focusEntries.length ? focusEntries : entries.slice(0, 3);
    const categoryIcon = category => (
        category === 'dropped' ? 'alert-triangle'
            : category === 'review' ? 'circle-help'
                : category === 'degraded' ? 'git-compare-arrows'
                    : 'check-circle-2'
    );
    const categoryClass = category => (category === 'dropped' ? 'tt-rule-warning--error' : '');
    return `
        <section class="tt-roster-review-issues tt-roster-import-report" aria-label="导入报告">
            <div class="tt-section-title">
                <h3><i data-lucide="clipboard-check"></i><span>导入报告</span></h3>
                <span class="tt-chip ${report.hasIssues ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(summary.total || entries.length || 0)}</span>
            </div>
            <div class="tt-audit-grid tt-audit-grid--quality">
                <span><b>保留</b>${escapeHtml(summary.kept || 0)}</span>
                <span><b>降级</b>${escapeHtml(summary.degraded || 0)}</span>
                <span><b>丢弃</b>${escapeHtml(summary.dropped || 0)}</span>
                <span><b>待审</b>${escapeHtml(summary.review || 0)}</span>
            </div>
            ${visibleEntries.length ? `
                <div class="tt-rule-warning-list">
                    ${visibleEntries.map(item => `
                        <div class="tt-rule-warning ${categoryClass(item.category)}">
                            <i data-lucide="${categoryIcon(item.category)}"></i>
                            <span>${escapeHtml(item.reason || item.field || item.category)}</span>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        </section>
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
            <td data-label="年级">${input('grade', row.grade)}</td>
            <td data-label="班级">${input('className', row.className)}</td>
            <td data-label="课程">${input('subjectName', row.subjectName)}</td>
            <td data-label="类型">
                <select class="tt-roster-review-field" data-roster-field="subjectCategory">
                    <option value="normal" ${row.subjectCategory === 'normal' ? 'selected' : ''}>普通</option>
                    <option value="main" ${row.subjectCategory === 'main' ? 'selected' : ''}>主科</option>
                    <option value="quality" ${row.subjectCategory === 'quality' ? 'selected' : ''}>素质</option>
                    <option value="lab" ${row.subjectCategory === 'lab' ? 'selected' : ''}>实验</option>
                </select>
            </td>
            <td data-label="标签">${input('subjectTags', Array.isArray(row.subjectTags) ? row.subjectTags.join('、') : row.subjectTags)}</td>
            <td data-label="教师">${input('teacherName', row.teacherName)}</td>
            <td data-label="周课时">${input('weeklyHours', row.weeklyHours, 'number')}</td>
            <td data-label="连堂">
                <select class="tt-roster-review-field" data-roster-field="blockPreference">
                    <option value="single" ${row.blockPreference === 'single' ? 'selected' : ''}>单节</option>
                    <option value="double" ${row.blockPreference === 'double' ? 'selected' : ''}>双连堂</option>
                    <option value="mixed" ${row.blockPreference === 'mixed' ? 'selected' : ''}>混合</option>
                </select>
            </td>
            <td data-label="教室">${input('roomName', row.roomName)}</td>
            <td data-label="问题"><span class="tt-roster-review-issue">${escapeHtml(issueText)}</span></td>
            <td data-label="操作">
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
    const cardTitle = draftCount
        ? '继续智能排课'
        : savedCount
            ? '查看已应用约束'
            : '打开智能排课助手';
    const cardDescription = draftCount
        ? `${draftCount} 条要求待处理${warningCount ? ` / ${warningCount} 条需注意` : ''}，继续完成确认和排课。`
        : savedCount
            ? `已有 ${savedCount} 条要求应用，可继续检查、调整并生成课表。`
            : '告诉我排课要求，我会检查数据、整理规则并生成课表。';

    return `
        <div class="tt-rule-stack tt-rules-setup-card" data-workflow-step="rules">
            <div class="tt-rules-setup-body">
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
        ? `${draftCount} 条待检查`
        : savedCount
            ? '规则已应用'
            : '等待解析';
    return `
        <div class="tt-rule-summary">
            <span><b>已应用</b>${escapeHtml(savedCount)} 条</span>
            <span><b>待处理</b>${escapeHtml(draftCount)} 条</span>
            <span class="${warningCount ? 'is-warning' : ''}"><b>需注意</b>${escapeHtml(warningCount)} 条</span>
            <em>${escapeHtml(status)}</em>
        </div>
    `;
}

// 已删除的废弃函数：renderRuleReviewBeginnerGuide、ruleReviewWizardStep、renderRuleWizard
// 这些函数仅用于旧弹窗，已不再需要

// 旧弹窗函数 renderRuleReviewDialog 及其13个子函数（约450行）已完全删除
// 主入口已切换到 smart-workbench/workbench-view.js 的 renderSmartWorkbench()
// 以下保留的共享函数（renderRuleCardList、renderRuleReviewCard 等）已被 smart-workbench 使用

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
    const issueSource = publicationIssueEntriesForView(publication);
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
    issueSource.forEach(add);
    return entries.slice(0, limit);
}

function publicationIssueEntriesForView(publication = null) {
    if (!publication || typeof publication !== 'object') return [];
    const combined = (Array.isArray(publication.issueEntries) && publication.issueEntries.length)
        ? [...publication.issueEntries]
        : (Array.isArray(publication.reviewItems) && publication.reviewItems.length)
            ? [...publication.reviewItems]
            : [
                ...(Array.isArray(publication.blockingIssues) ? publication.blockingIssues.map(item => ({ ...item, severity: item?.severity || 'error' })) : []),
                ...(Array.isArray(publication.warnings) ? publication.warnings.map(item => ({ ...item, severity: item?.severity || 'warning' })) : []),
            ];
    const seen = new Set();
    return combined.filter(item => {
        if (!item) return false;
        const slot = item.slot?.day && item.slot?.period ? `${item.slot.day}-${item.slot.period}` : (item.slot || '');
        const key = [
            item.type || '',
            item.severity || '',
            item.targetKind || '',
            item.targetId || '',
            item.targetName || '',
            slot,
            item.message || '',
        ].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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
                        <p>当前草稿将被覆盖，恢复后请检查并重新发布。</p>
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
                        <p>查看该版本的发布备注、快照摘要和部分课节，用于教务检查。</p>
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

// 已删除：renderRuleReviewInput、renderManualRuleBuilder、renderManualTargets、renderManualCheckGroup
// 这些函数仅用于旧弹窗的输入界面，已不再需要

// 已删除：renderRuleReviewTable 及相关子函数
// 旧弹窗的表格渲染已不再需要

// 已删除：renderRuleReviewOverview、renderClarifyingQuestions、renderRuleDiagnosis
// 这些死代码函数已不再被调用

// 以下共享函数保留，供 smart-workbench 使用：
// - renderRuleCardList
// - renderRuleReviewCard
// - renderAutoAcceptableRules
// - renderNeedReviewRules
// - renderRuleConflictSection
// - renderUnsupportedRuleItems

// 保留共享函数供 smart-workbench 使用

function ruleDisplayTarget(row = {}) {
    return row.targetName || row.className || row.teacherName || row.subjectName || row.targetId || '还没确定对象';
}

function ruleSlotsLabel(row = {}) {
    const slots = Array.isArray(row.slots) ? row.slots : [];
    return slots.length ? slots.join('、') : '未指定节次';
}

function rulePriorityText(row = {}) {
    return row.priority === 'hard' ? '必须满足' : '尽量满足';
}

function renderRuleCardList(rows = [], project = {}, { disabled = false, allowEffective = true } = {}) {
    if (!rows.length) return '';
    return `
        <div class="tt-rule-card-list">
            ${rows.map(row => renderRuleReviewCard(row, project, { disabled, allowEffective })).join('')}
        </div>
    `;
}

function renderRuleReviewCard(row = {}, project = {}, { disabled = false, allowEffective = true } = {}) {
    const status = row.status || 'needs_review';
    const warnings = row.warnings || [];
    const disabledAttr = disabled ? 'disabled' : '';
    const canEffective = allowEffective && !['unsupported', 'suggestion'].includes(status);
    const confidence = row.confidence !== null && row.confidence !== undefined
        ? `${Math.round(Number(row.confidence) * 100)}%`
        : '待确认';
    return `
        <article class="tt-rule-review-card tt-rule-review-card--${escapeAttr(status)}" data-rule-id="${escapeAttr(row.id || '')}">
            <div class="tt-rule-review-card-head">
                <span class="tt-chip">${escapeHtml(ruleStatusLabel(status))}</span>
                <strong>${escapeHtml(ruleTypeLabel(row.type || '') || row.type || '约束')}</strong>
                <em>${escapeHtml(confidence)}</em>
            </div>
            <p>我理解为：<b>${escapeHtml(ruleDisplayTarget(row))}</b>，${escapeHtml(ruleTypeLabel(row.type || '') || row.type || '约束')}，时间是 <b>${escapeHtml(ruleSlotsLabel(row))}</b>，${escapeHtml(rulePriorityText(row))}。</p>
            ${row.rawText || row.description ? `<span class="tt-rule-card-raw">${escapeHtml(row.rawText || row.description)}</span>` : ''}
            ${warnings.length ? `
                <div class="tt-rule-card-warning">
                    <i data-lucide="triangle-alert"></i>
                    <span>${escapeHtml(warnings.join('；'))}</span>
                </div>
            ` : ''}
            <div class="tt-rule-card-actions">
                <button class="tt-btn tt-btn--sm" type="button" data-action="rule-card-edit" data-rule-id="${escapeAttr(row.id || '')}" ${disabledAttr}>
                    <i data-lucide="pencil"></i><span>编辑</span>
                </button>
                ${canEffective ? `
                    <button class="tt-btn tt-btn--sm tt-btn--primary" type="button" data-action="rule-card-effective" data-rule-id="${escapeAttr(row.id || '')}" ${disabledAttr}>
                        <i data-lucide="check"></i><span>确认应用</span>
                    </button>
                ` : ''}
                <button class="tt-btn tt-btn--sm" type="button" data-action="rule-card-ignore" data-rule-id="${escapeAttr(row.id || '')}" ${disabledAttr}>
                    <i data-lucide="eye-off"></i><span>忽略</span>
                </button>
                <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-action="rule-card-delete" data-rule-id="${escapeAttr(row.id || '')}" title="删除这条草稿" aria-label="删除这条草稿" ${disabledAttr}>
                    <i data-lucide="trash-2"></i>
                </button>
            </div>
        </article>
    `;
}

function renderAutoAcceptableRules(dialog = {}) {
    const rows = dialog.autoAcceptable || [];
    if (!rows.length) return '';
    const blocked = (dialog.conflicts || []).some(item => item.level === 'blocking');
    return `
        <section class="tt-rule-review-group tt-rule-review-group--auto">
            <div class="tt-rule-review-group-title">
                <i data-lucide="badge-check"></i>
                <strong>可直接应用</strong>
                <span>${rows.length} 条</span>
            </div>
            ${renderRuleCardList(rows.slice(0, 5), {}, { allowEffective: true })}
            ${rows.length > 5 ? `<span class="tt-muted">还有 ${escapeHtml(rows.length - 5)} 条可在高级编辑里查看。</span>` : ''}
            <button class="tt-btn tt-btn--primary tt-btn--sm" id="tt-apply-auto-rules" type="button" ${blocked ? 'disabled' : ''}>
                <i data-lucide="check-check"></i><span>一键应用这些高置信度约束</span>
            </button>
        </section>
    `;
}

function renderNeedReviewRules(dialog = {}) {
    const rows = (dialog.needReview || []).length
        ? dialog.needReview
        : (dialog.draftRows || []).filter(row => ['needs_review', 'invalid', 'ignored'].includes(row.status));
    if (!rows.length) return '';
    return `
        <section class="tt-rule-review-group tt-rule-review-group--review">
            <div class="tt-rule-review-group-title">
                <i data-lucide="edit-3"></i>
                <strong>需要你确认</strong>
                <span>${rows.length} 条</span>
            </div>
            <p class="tt-muted">这些约束需要你看一眼对象、节次或强弱，再决定是否应用。</p>
            ${renderRuleCardList(rows.slice(0, 6), {}, { allowEffective: true })}
            ${rows.length > 6 ? `<span class="tt-muted">还有 ${escapeHtml(rows.length - 6)} 条可在高级编辑里查看。</span>` : ''}
        </section>
    `;
}

function renderRuleConflictSection(dialog = {}) {
    const conflicts = dialog.conflicts || [];
    if (!conflicts.length) return '';
    return `
        <section class="tt-rule-review-group tt-rule-review-group--conflict">
            <div class="tt-rule-review-group-title">
                <i data-lucide="triangle-alert"></i>
                <strong>冲突风险</strong>
                <span>${conflicts.length} 条</span>
            </div>
            ${conflicts.map(conflict => `
                <div class="tt-rule-conflict tt-rule-conflict--${escapeAttr(conflict.level || 'warning')}">
                    <strong>${escapeHtml(conflict.level === 'blocking' ? '阻塞风险' : '普通风险')}</strong>
                    <span>${escapeHtml(conflict.message || '')}</span>
                    ${conflict.suggestion ? `<em>${escapeHtml(conflict.suggestion)}</em>` : ''}
                </div>
            `).join('')}
        </section>
    `;
}

function renderUnsupportedRuleItems(dialog = {}) {
    const items = dialog.unsupportedItems || [];
    if (!items.length) return '';
    return `
        <section class="tt-rule-review-group tt-rule-review-group--unsupported">
            <div class="tt-rule-review-group-title">
                <i data-lucide="lightbulb"></i>
                <strong>暂不支持</strong>
                <span>${items.length} 条</span>
            </div>
            <p class="tt-muted">当前版本只能作为建议，不会写入排课规则。</p>
            ${renderRuleCardList(items.slice(0, 6), {}, { allowEffective: false })}
        </section>
    `;
}

// 已删除：renderRuleTargetField、renderRuleReviewRow、ruleReviewRowSourceLabel
// 这些函数仅用于旧弹窗的高级编辑表格，已不再需要

function ruleReviewWarningInsight(warning = '') {
    const text = String(warning || '');
    if (/已自动处理|无需额外|基础规则|默认规则|系统内置|已经处理/.test(text)) {
        return { group: 'handled', title: '已自动处理', icon: 'check-circle-2', tone: 'info' };
    }
    if (/缺少|未指定|未写入|请人工|人工补充|人工在|手动调整|无法.*表达|无法用|精确表达/.test(text)) {
        return { group: 'review', title: '需要人工补充', icon: 'circle-alert', tone: 'review' };
    }
    if (/不支持|暂不支持|仅作建议|建议作为|优化目标|供审查|建议项/.test(text)) {
        return { group: 'suggestion', title: '暂不支持 / 仅作建议', icon: 'lightbulb', tone: 'suggestion' };
    }
    return { group: 'notice', title: '解析提醒', icon: 'triangle-alert', tone: 'warning' };
}

function renderRuleReviewReport(warnings = []) {
    if (!warnings.length) return '';
    const order = ['handled', 'review', 'suggestion', 'notice'];
    const groups = new Map();
    warnings.forEach(warning => {
        const insight = ruleReviewWarningInsight(warning);
        if (!groups.has(insight.group)) groups.set(insight.group, { ...insight, items: [] });
        groups.get(insight.group).items.push(String(warning || ''));
    });
    return `
        <div class="tt-rule-review-report" aria-label="智能解析报告">
            ${order.map(key => {
                const group = groups.get(key);
                if (!group) return '';
                const visible = group.items.slice(0, 4);
                const rest = group.items.length - visible.length;
                return `
                    <div class="tt-rule-report-group tt-rule-report-group--${escapeAttr(group.tone)}">
                        <div class="tt-rule-report-title">
                            <i data-lucide="${escapeAttr(group.icon)}"></i>
                            <strong>${escapeHtml(group.title)}</strong>
                            <span>${escapeHtml(group.items.length)} 条</span>
                        </div>
                        <div class="tt-roster-review-issues">
                            ${visible.map(warning => `
                                <div class="tt-rule-warning tt-rule-warning--${escapeAttr(group.tone)}">
                                    <i data-lucide="${escapeAttr(group.icon)}"></i>
                                    <span>${escapeHtml(warning)}</span>
                                </div>
                            `).join('')}
                            ${rest > 0 ? `
                                <div class="tt-rule-warning tt-rule-warning--${escapeAttr(group.tone)}">
                                    <i data-lucide="more-horizontal"></i>
                                    <span>还有 ${escapeHtml(rest)} 条同类提示，可继续检查下方草稿。</span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function ruleTargetEntities(project = {}, targetType) {
    if (targetType === 'teacher') return (project.teachers || []).map(item => ({ id: item.id, name: item.name }));
    if (targetType === 'class') return (project.classes || []).map(item => ({ id: item.id, name: ownerLabel(item) }));
    if (targetType === 'subject') return (project.subjects || []).map(item => ({ id: item.id, name: item.name }));
    return [];
}

function isAllTeachersRuleTarget(row = {}) {
    if (row.targetType === 'all_teachers' || row.targetId === '__all_teachers') return true;
    if (!['teacher_daily_limit', 'teacher_consecutive_limit'].includes(row.type)) return false;
    const text = [
        row.targetName,
        row.targetId,
        row.teacherName,
        row.teacherId,
        row.rawText,
        row.description,
    ].map(value => String(value || '')).join(' ');
    return /(全部|全体|所有|每位|每个|各位|任课|任意)\s*(教师|老师)|all\s+teachers?/i.test(text);
}

function normalizeRuleReviewTargetForDisplay(row = {}) {
    if (!isAllTeachersRuleTarget(row)) return row;
    return {
        ...row,
        targetType: 'all_teachers',
        targetId: '__all_teachers',
        targetName: '全部教师',
    };
}

function renderRuleTargetField(row, project, disabled = false) {
    const normalizedRow = normalizeRuleReviewTargetForDisplay(row);
    const entities = ruleTargetEntities(project, normalizedRow.targetType);
    const disabledAttr = disabled ? 'disabled' : '';
    if (normalizedRow.targetType === 'all_teachers') {
        return `<input class="tt-roster-review-field" data-rule-review-field="targetName" type="text" value="全部教师" readonly ${disabledAttr}>`;
    }
    // locked_slot / global rules keep a free-text target; others get a bound dropdown
    if (!entities.length || normalizedRow.targetType === 'locked_slot' || normalizedRow.targetType === 'global') {
        return `<input class="tt-roster-review-field" data-rule-review-field="targetName" type="text" value="${escapeAttr(normalizedRow.targetName || normalizedRow.targetId || '')}" ${disabledAttr}>`;
    }
    const matchesId = entities.some(item => item.id === normalizedRow.targetId);
    const matchesName = entities.find(item => item.name === normalizedRow.targetName);
    const selectedId = matchesId ? normalizedRow.targetId : (matchesName?.id || '');
    return `
        <select class="tt-roster-review-field tt-rule-target-select" data-rule-review-field="targetName" data-rule-target-select ${disabledAttr}>
            <option value="">未选择</option>
            ${entities.map(item => `<option value="${escapeAttr(item.name)}" data-target-id="${escapeAttr(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>
    `;
}

function renderRuleReviewRow(row = {}, project = {}, disabled = false) {
    const displayRow = normalizeRuleReviewTargetForDisplay(row);
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
    const rawHelper = ruleReviewRowSourceLabel(row, status);
    return `
        <tr class="tt-rule-review-row tt-rule-review-row--${escapeAttr(status)}" data-rule-review-row="${escapeAttr(row.id)}">
            <td data-label="原始内容">${cell(input('rawText', row.rawText || row.description || ''), rawHelper)}</td>
            <td data-label="类型">${cell(`
                <select class="tt-roster-review-field" data-rule-review-field="type" ${disabledAttr}>
                    ${typeOptions.map(type => `<option value="${type}" ${row.type === type ? 'selected' : ''}>${escapeHtml(ruleTypeLabel(type))}</option>`).join('')}
                </select>
                <input type="hidden" data-rule-review-field="targetType" value="${escapeAttr(displayRow.targetType || '')}">
                <input type="hidden" data-rule-review-field="targetId" value="${escapeAttr(displayRow.targetId || '')}">
                <input type="hidden" data-rule-review-field="classId" value="${escapeAttr(row.classId || '')}">
                <input type="hidden" data-rule-review-field="className" value="${escapeAttr(row.className || '')}">
                <input type="hidden" data-rule-review-field="subjectId" value="${escapeAttr(row.subjectId || '')}">
                <input type="hidden" data-rule-review-field="subjectName" value="${escapeAttr(row.subjectName || '')}">
                <input type="hidden" data-rule-review-field="teacherId" value="${escapeAttr(row.teacherId || '')}">
                <input type="hidden" data-rule-review-field="teacherName" value="${escapeAttr(row.teacherName || '')}">
            `)}</td>
            <td data-label="对象">${cell(renderRuleTargetField(displayRow, project, disabled))}</td>
            <td data-label="节次">${cell(input('slots', (row.slots || []).join(', ')), slotHint)}</td>
            <td data-label="强弱">${cell(`
                <select class="tt-roster-review-field" data-rule-review-field="priority" ${disabledAttr}>
                    <option value="hard" ${row.priority === 'hard' ? 'selected' : ''}>硬性（必须）</option>
                    <option value="soft" ${row.priority === 'soft' ? 'selected' : ''}>软性（尽量）</option>
                </select>
            `)}</td>
            <td data-label="状态">${cell(`
                <select class="tt-roster-review-field" data-rule-review-field="status" ${disabledAttr}>
                    ${statusOptions.map(item => `<option value="${item}" ${status === item ? 'selected' : ''}>${escapeHtml(ruleStatusLabel(item))}</option>`).join('')}
                </select>
            `, confidence)}</td>
            <td data-label="说明">${cell(input('description', row.description || warningText), warning)}</td>
            <td data-label="操作">
                <div class="tt-rule-review-action-cell">
                    <button class="tt-icon-btn tt-icon-btn--sm" type="button" data-rule-review-delete-row="${escapeAttr(row.id)}" title="删除规则行" aria-label="删除规则行" ${disabledAttr}><i data-lucide="trash-2"></i></button>
                </div>
            </td>
        </tr>
    `;
}

function ruleReviewRowSourceLabel(row = {}, status = '') {
    const source = String(row.source || '').trim();
    const sourceRow = Number.parseInt(row.sourceRow, 10);
    const sourceLabel = Number.isFinite(sourceRow)
        ? `来自第 ${sourceRow} 条`
        : source === 'manual'
            ? '手动新增'
            : source
                ? `来自 ${source}`
                : row.rawText
                    ? '来自原始描述'
                    : '新建草稿';
    const stateLabel = ({
        effective: '智能已转换',
        needs_review: '需人工确认',
        suggestion: '建议项',
        unsupported: '暂不生效',
        invalid: '需修正',
        ignored: '已忽略',
    })[status] || '待复核';
    return `<span class="tt-rule-row-source" title="${escapeAttr(`${sourceLabel} · ${stateLabel}`)}">${escapeHtml(`${sourceLabel} · ${stateLabel}`)}</span>`;
}

function renderSolveSection(state) {
    const { project } = state;
    const readiness = getPreparedness(project);
    const readinessMessage = isArchiveOnlyReadyState(project)
        ? '当前草稿已清空，可恢复或导出已发布版本。'
        : readiness.message;
    const score = getScore(project);
    const placed = score.placedLessons ?? 0;
    const total = score.totalLessons ?? totalPlannedLessons(project);
    const scaleMessage = solveScaleMessage(project);
    const runLabel = state.loading ? (state.solvePhaseText || '快速生成中') : '';
    return `
        <section class="tt-section tt-section--solve tt-solve-setup-card" data-workflow-step="solve">
            <div class="tt-section-title">
                <h3><i data-lucide="sparkles"></i><span>求解</span></h3>
                <span class="tt-chip ${readiness.ready || isArchiveOnlyReadyState(project) ? 'tt-chip--ok' : 'tt-chip--warn'}">${readinessChipLabel(project, readiness)}</span>
            </div>
            <div class="tt-solve-setup-body">
                <p class="tt-compact-copy">${placed}/${total} 已排 · ${score.hardConflicts ?? 0} 硬冲突</p>
                <p class="tt-compact-copy">${escapeHtml(readinessMessage)}</p>
                ${scaleMessage ? `<p class="tt-compact-copy tt-compact-copy--warn">${escapeHtml(scaleMessage)}</p>` : ''}
            </div>
            ${runLabel ? `
                <div class="tt-process-strip tt-solve-process" aria-live="polite">
                    <span class="tt-process-chip">
                        <i data-lucide="loader-2" class="tt-spin"></i>
                        <strong>${escapeHtml(runLabel)}</strong>
                    </span>
                    <span class="tt-process-chip tt-process-chip--muted">生成课表</span>
                </div>
            ` : ''}
            <button class="tt-btn tt-btn--primary" data-run-schedule type="button" ${state.loading || !readiness.ready ? 'disabled' : ''}>
                <i data-lucide="${state.loading ? 'loader-2' : 'play'}" class="${state.loading ? 'tt-spin' : ''}"></i><span>${state.loading ? '快速生成中' : '快速生成'}</span>
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
        manual_adjustment_conflicts: '手动调整后仍有冲突',
        manual_adjustment_unplaced: '手动调整后仍有未排课时',
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

const INSPECTOR_ISSUE_SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function inspectorIssueSectionLabel(panel = 'diagnostic', severity = 'warning') {
    if (severity === 'error') return panel === 'publication' ? '必须先处理' : '建议先处理';
    if (severity === 'info') return '说明';
    return panel === 'publication' ? '建议发布前复核' : '持续关注';
}

function inspectorIssueSeverityClass(severity = 'warning') {
    return severity === 'error' ? 'is-error' : severity === 'warning' ? 'is-warning' : '';
}

function publicationIssueSeverityIcon(severity = 'warning') {
    return severity === 'error' ? 'alert-circle' : severity === 'info' ? 'info' : 'triangle-alert';
}

function normalizeInspectorIssueSeverity(item = {}, fallbackSeverity = 'warning') {
    if (item.severity === 'error' || item.severity === 'hard') return 'error';
    if (item.severity === 'info') return 'info';
    if (item.type?.endsWith?.('_capacity')) return 'error';
    return fallbackSeverity;
}

function normalizeInspectorIssueEntries(items = [], options = {}) {
    const entries = [];
    const seen = new Set();
    const {
        fallbackSeverity = 'warning',
        filter = null,
        labelOf = timetableReviewLabel,
        titleOf = null,
    } = options;
    const add = item => {
        if (!item || (filter && !filter(item))) return;
        const severity = normalizeInspectorIssueSeverity(item, fallbackSeverity);
        const title = (titleOf ? titleOf(item) : '') || item.title || item.targetName || labelOf(item.type);
        const message = item.message || item.reason || labelOf(item.type);
        const slot = item.slot?.day && item.slot?.period ? `${item.slot.day}-${item.slot.period}` : (item.slot || '');
        const key = [
            severity,
            item.category || '',
            item.type || '',
            item.targetKind || '',
            item.targetId || '',
            item.targetName || '',
            slot,
            title,
            message,
        ].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({
            severity,
            category: item.category || '',
            type: item.type || '',
            title,
            message,
            targetKind: item.targetKind || '',
            targetId: item.targetId || '',
            targetName: item.targetName || '',
            slot,
        });
    };
    items.forEach(add);
    return entries.sort((left, right) => {
        return (INSPECTOR_ISSUE_SEVERITY_ORDER[left.severity] ?? 3) - (INSPECTOR_ISSUE_SEVERITY_ORDER[right.severity] ?? 3)
            || left.title.localeCompare(right.title, 'zh-Hans-CN')
            || left.message.localeCompare(right.message, 'zh-Hans-CN');
    });
}

function summarizeInspectorIssueEntries(entries = []) {
    return entries.reduce((summary, item) => {
        summary.total += 1;
        summary[item.severity] = (summary[item.severity] || 0) + 1;
        return summary;
    }, { error: 0, warning: 0, info: 0, total: 0 });
}

function inspectorIssueTargetKindLabel(targetKind = '') {
    return ({
        class: '班级',
        teacher: '教师',
        subject: '课程',
        room: '教室',
        plan: '计划',
        schedule: '课表',
    })[targetKind] || '';
}

function inspectorIssueMeta(entry = {}) {
    const parts = [];
    const kindLabel = inspectorIssueTargetKindLabel(entry.targetKind);
    if (kindLabel && entry.targetName && entry.targetKind !== 'schedule' && entry.targetName !== entry.title) {
        parts.push(`${kindLabel} · ${entry.targetName}`);
    } else if (!kindLabel && entry.targetName && entry.targetName !== entry.title && entry.targetName !== '课表') {
        parts.push(entry.targetName);
    }
    if (entry.slot) parts.push(`课节 ${entry.slot}`);
    return parts.join(' · ');
}

function buildInspectorIssueSections(entries = [], panel = 'diagnostic') {
    return ['error', 'warning', 'info']
        .map(severity => ({
            severity,
            label: inspectorIssueSectionLabel(panel, severity),
            icon: publicationIssueSeverityIcon(severity),
            entries: entries.filter(item => item.severity === severity),
        }))
        .filter(section => section.entries.length);
}

function renderInspectorIssueGroups({ title, entries, panel = 'diagnostic', legacyItemClass = '' }) {
    if (!entries.length) return '';
    const sections = buildInspectorIssueSections(entries, panel);
    const summary = summarizeInspectorIssueEntries(entries);
    const chipTone = summary.error ? 'tt-chip--warn' : 'tt-chip--ok';
    return `
        <div class="tt-inspector-issues">
            <div class="tt-subsection-title">
                <h4><i data-lucide="list-tree"></i><span>${escapeHtml(title)}</span></h4>
                <span class="tt-chip ${chipTone}">${escapeHtml(entries.length)} 条</span>
            </div>
            <div class="tt-inspector-issue-groups">
                ${sections.map(section => `
                    <div class="tt-diagnostics-group">
                        <div class="tt-rule-report-title">
                            <span><i data-lucide="${section.icon}"></i>${escapeHtml(section.label)}</span>
                            <span>${escapeHtml(section.entries.length)}</span>
                        </div>
                        <div class="tt-rule-preview tt-rule-preview--compact">
                            ${section.entries.slice(0, 4).map(item => `
                                <div class="tt-rule-preview-item tt-inspector-issue-item ${legacyItemClass} ${inspectorIssueSeverityClass(item.severity)}">
                                    <strong>${escapeHtml(item.title)}</strong>
                                    <span>${escapeHtml(item.message)}</span>
                                    ${inspectorIssueMeta(item) ? `<em>${escapeHtml(inspectorIssueMeta(item))}</em>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function normalizePublicationPanelIssues(state) {
    const publication = state.project?.schedule?.publication || state.lastFailure?.publication || null;
    const diagnosticsItems = state.project?.schedule?.diagnostics?.items || state.lastFailure?.diagnostics?.items || [];
    const publicationDiagnostics = diagnosticsItems.filter(item => item.category === 'publication');
    if (publicationDiagnostics.length) {
        return normalizeInspectorIssueEntries(publicationDiagnostics, {
            fallbackSeverity: 'warning',
            filter: item => item.type !== 'quality_review',
            labelOf: publicationIssueLabel,
            titleOf: publicationItemTitle,
        });
    }
    return normalizeInspectorIssueEntries(publicationIssueEntriesForView(publication), {
        fallbackSeverity: 'warning',
        filter: item => item.type !== 'quality_review',
        labelOf: publicationIssueLabel,
        titleOf: publicationItemTitle,
    });
}

function normalizeAuditFallbackIssue(item = {}, fallbackSeverity = 'warning') {
    const targetKind = item.targetKind || (
        item.teacherId ? 'teacher'
            : item.classId ? 'class'
                : item.roomId || item.rooms ? 'room'
                    : 'schedule'
    );
    const targetId = item.targetId || item.teacherId || item.classId || item.roomId || '';
    return {
        ...item,
        severity: item.severity || fallbackSeverity,
        targetKind,
        targetId,
        targetName: item.targetName || item.name || targetId || '',
        slot: item.slot?.day && item.slot?.period ? `${item.slot.day}-${item.slot.period}` : (item.slot || ''),
    };
}

function normalizeScheduleDiagnosticIssues(state) {
    const diagnosticsItems = state.project?.schedule?.diagnostics?.items || state.lastFailure?.diagnostics?.items || [];
    const scheduleDiagnostics = diagnosticsItems.filter(item => item.category !== 'publication');
    if (scheduleDiagnostics.length) {
        return normalizeInspectorIssueEntries(scheduleDiagnostics, {
            fallbackSeverity: 'warning',
            labelOf: timetableReviewLabel,
            titleOf: item => item.targetName || timetableReviewLabel(item.type) || item.type || '排课问题',
        });
    }
    const audit = state.project?.schedule?.audit || state.lastFailure?.audit || null;
    return normalizeInspectorIssueEntries([
        ...(audit?.blockingIssues || []).map(item => normalizeAuditFallbackIssue(item, 'error')),
        ...(audit?.warnings || []).map(item => normalizeAuditFallbackIssue(item, 'warning')),
    ], {
        fallbackSeverity: 'warning',
        labelOf: timetableReviewLabel,
        titleOf: item => item.targetName || item.name || timetableReviewLabel(item.type) || item.type || '排课问题',
    });
}

const PUBLICATION_FINGERPRINT_MISMATCH = 'publication_fingerprint_mismatch';
const PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE = '发布快照校验失败，请重新发布后再导出或恢复。';

function publicationHistoryTargetName(version) {
    const parsed = Number.parseInt(version, 10);
    return Number.isInteger(parsed) ? `发布历史 V${parsed}` : '发布历史';
}

function hasPublicationFingerprintMismatch(publication = null, targetName = '') {
    const entries = publicationIssueEntriesForView(publication);
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

function hasPublishedArchive(project = {}) {
    return Boolean(project.schedule?.published);
}

function hasPublishedSnapshot(project = {}) {
    return Boolean(project.schedule?.published?.snapshot?.slots?.length);
}

function archiveOnlyDraftState(project = {}) {
    return hasPublishedArchive(project) && !(project.schedule?.slots || []).length;
}

function isArchiveOnlyReadyState(project = {}) {
    return archiveOnlyDraftState(project) && hasPublishedSnapshot(project);
}

function preparednessSummaryLabel(project = {}, preparedness = {}) {
    if (preparedness.ready) return '数据已就绪';
    if (isArchiveOnlyReadyState(project)) return '发布归档已保留';
    return '待导入任课';
}

function readinessChipLabel(project = {}, preparedness = {}) {
    if (preparedness.ready) return '就绪';
    if (isArchiveOnlyReadyState(project)) return '归档可恢复';
    return '待准备';
}

function getSolverDetail(state = {}) {
    if (state.project?.schedule?.published?.status === 'published' && !state.solverJob && !state.lastFailure) {
        return {
            stats: {},
            reason: '',
            reasonLabel: '',
            accepted: undefined,
            kept: false,
            isManualReview: false,
            hasInitialSolutionInfo: false,
            initialSolutionText: '',
            hasPinnedCount: false,
            pinnedCount: 0,
            staleRejected: false,
        };
    }
    const scheduleStats = state.project?.schedule?.solverStats || {};
    const jobStats = state.solverJob?.solverStats || {};
    const failureStats = state.lastFailure?.solverStats || {};
    const stats = { ...scheduleStats, ...jobStats, ...failureStats };
    const hasInitialSolutionInfo = Object.prototype.hasOwnProperty.call(stats, 'initialSolutionUsed');
    const hasPinnedCount = Object.prototype.hasOwnProperty.call(stats, 'pinnedCount');
    const reason = state.solverJob?.reason || stats.reason || state.lastFailure?.reason || '';
    const accepted = state.solverJob ? state.solverJob.accepted : stats.accepted;
    const isManualReview = stats.phase === 'manual_adjustment'
        && accepted === false
        && (reason === 'manual_adjustment_conflicts' || reason === 'manual_adjustment_unplaced');
    const kept = Boolean(state.lastFailure)
        || state.solverJob?.status === 'failed'
        || state.solverJob?.status === 'skipped'
        || ((reason && accepted === false) && !isManualReview);
    return {
        stats,
        reason,
        reasonLabel: solverReasonLabel(reason),
        accepted,
        kept,
        isManualReview,
        hasInitialSolutionInfo,
        initialSolutionText: stats.initialSolutionUsed ? '\u5df2\u4f7f\u7528' : '\u672a\u4f7f\u7528',
        hasPinnedCount,
        pinnedCount: Number(stats.pinnedCount || 0),
        staleRejected: Boolean(stats.staleRejected),
    };
}

function renderPublicationPanel(state) {
    const project = state.project || {};
    const publication = state.project?.schedule?.publication || state.lastFailure?.publication || null;
    const published = project.schedule?.published || null;
    if (!publication && !published) return '';
    const archiveOnly = !publication && archiveOnlyDraftState(project);
    const publishedCurrent = published?.status === 'published' && !archiveOnly;
    const summary = publication?.summary || published?.snapshot?.publicationSummary || {};
    const snapshot = published?.snapshot || null;
    const fingerprint = published?.fingerprint || snapshot?.fingerprint || '';
    const fingerprintMismatch = hasPublicationFingerprintMismatch(publication, '发布快照');
    const restorePublishedAttrs = fingerprintMismatch
        ? `disabled title="${escapeAttr(PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE)}"`
        : '';
    const diff = getPublishedScheduleDiff(project);
    const draftChanged = publishedDraftChanged(project);
    const placed = Number(summary.placedLessons ?? 0);
    const total = Number(summary.totalLessons ?? 0);
    const issueEntries = normalizePublicationPanelIssues(state);
    const reminderCount = issueEntries.filter(item => item.severity !== 'error').length;
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="shield-check"></i><span>${archiveOnly || publishedCurrent ? '发布归档' : '发布前校验'}</span></h3>
                <span class="tt-chip ${archiveOnly || publishedCurrent ? 'tt-chip--ok' : publication.ok ? 'tt-chip--ok' : 'tt-chip--warn'}">${archiveOnly ? '已保留' : publishedCurrent ? '已发布' : publication.ok ? '可发布' : '不可发布'}</span>
            </div>
            <div class="tt-detail-list">
                ${published ? `<span class="${draftChanged ? 'is-warning' : ''}"><b>发布状态</b>${escapeHtml(draftChanged ? '草稿已变化' : `已发布 V${published.version || 1}`)}</span>` : '<span><b>发布状态</b>未发布</span>'}
                ${archiveOnly
                    ? '<span class="is-warning"><b>当前草稿</b>已清空，仍可恢复或导出已发布版本</span>'
                    : draftChanged
                        ? '<span class="is-warning"><b>发布已失效</b>当前课表改动后需要重新发布</span>'
                        : ''}
                ${published?.note ? `<span><b>发布备注</b>${escapeHtml(published.note)}</span>` : ''}
                ${fingerprint ? `<span class="tt-fingerprint" title="${escapeAttr(fingerprint)}"><b>发布指纹</b>${escapeHtml(shortPublicationFingerprint(fingerprint))}</span>` : ''}
                ${snapshot ? `<span><b>发布快照</b>${escapeHtml(`${snapshot.slotCount ?? snapshot.slots?.length ?? 0} 节`)}</span>` : ''}
                ${snapshot?.score ? `<span><b>快照完成率</b>${escapeHtml(`${snapshot.score.completeness ?? '-'}%`)}</span>` : ''}
                <span><b>课时</b>${escapeHtml(`${placed}/${total}`)}</span>
                <span><b>硬冲突</b>${escapeHtml(summary.hardConflicts ?? 0)}</span>
                <span><b>未排课时</b>${escapeHtml(summary.unplacedLessons ?? 0)}</span>
                <span><b>提醒</b>${escapeHtml(reminderCount)}</span>
                ${!archiveOnly && !snapshot?.slots?.length && draftChanged ? '<span class="is-warning"><b>发布快照</b>上一版发布快照缺失，暂时无法恢复或导出发布版。</span>' : ''}
            </div>
            ${renderInspectorIssueGroups({
                title: '发布问题',
                entries: issueEntries,
                panel: 'publication',
                legacyItemClass: 'tt-publication-issue-item',
            })}
            ${draftChanged && snapshot?.slots?.length ? `
                <div class="tt-publication-actions tt-publication-actions--published">
                    <button class="tt-btn tt-btn--ghost" id="tt-restore-published-snapshot" type="button" data-restore-published-snapshot="latest" data-restore-published-version="${escapeAttr(published.version || '')}" ${restorePublishedAttrs}>
                        <i data-lucide="history"></i><span>恢复发布版</span>
                    </button>
                </div>
            ` : ''}
            ${renderPublishedDiff(project, diff)}
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
    if (!publishedDraftChanged(project) || !diff.hasSnapshot || !(project.schedule?.slots || []).length) return '';
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
    const published = schedule?.published || null;
    const archiveOnly = archiveOnlyDraftState(state.project);
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
        : archiveOnly && hasPublishedSnapshot
            ? '当前工作草稿已清空，仍可恢复或导出已发布版本。'
        : archiveOnly
            ? '当前工作草稿已清空，上一版发布快照缺失，暂时无法恢复或导出发布版。'
        : officialExportDisabled
            ? '当前草稿已变化，请重新发布后导出正式课表。'
            : publication?.ok && officialExportRequiresPublish
                ? '请先发布课表后导出正式课表。'
            : publication?.ok
                ? '发布前校验已通过，可确认发布后导出。'
                : '发布前校验通过后才能发布正式课表。';
    return `
        <section class="tt-section tt-export-setup-card" data-workflow-step="review">
            <div class="tt-section-title">
                <h3><i data-lucide="download"></i><span>发布导出</span></h3>
                <span class="tt-chip ${publishStatusTone(schedule)}">${escapeHtml(publishStatusLabel(schedule))}</span>
            </div>
            <div class="tt-export-setup-body">
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
                        <button class="tt-btn tt-btn--ghost" type="button" data-restore-published-snapshot="latest" data-restore-published-version="${escapeAttr(published?.version || '')}" ${publishedExportAttrs}><i data-lucide="history"></i><span>恢复发布版</span></button>
                        <div class="tt-export-grid">
                            <button class="tt-export-btn" data-export-type="published_class" type="button" title="${escapeAttr(publishedExportTitle)}" ${publishedExportAttrs}><i data-lucide="archive"></i><span>班级</span></button>
                            <button class="tt-export-btn" data-export-type="published_teacher" type="button" title="${escapeAttr(publishedExportTitle)}" ${publishedExportAttrs}><i data-lucide="archive"></i><span>教师</span></button>
                            <button class="tt-export-btn" data-export-type="published_master" type="button" title="${escapeAttr(publishedExportTitle)}" ${publishedExportAttrs}><i data-lucide="archive"></i><span>总表</span></button>
                        </div>
                    </div>
                ` : ''}
            </div>
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
                ${runLabel ? `
                    <span class="tt-process-chip tt-solve-toolbar-chip" aria-live="polite">
                        <i data-lucide="loader-2" class="tt-spin"></i>
                        <strong>${escapeHtml(runLabel)}</strong>
                    </span>
                ` : ''}
                ${solveScaleMessage(state.project) ? `<span class="tt-chip tt-chip--warn">${escapeHtml(solveScaleMessage(state.project))}</span>` : ''}
                <span class="tt-chip ${readiness.ready || isArchiveOnlyReadyState(state.project) ? 'tt-chip--ok' : 'tt-chip--warn'}">${readiness.ready ? '可生成' : isArchiveOnlyReadyState(state.project) ? '可恢复' : '待准备'}</span>
                <button class="tt-run-btn" id="tt-run-schedule" type="button" ${state.loading || !readiness.ready ? 'disabled' : ''}>
                    <i data-lucide="${state.loading ? 'loader-2' : 'play'}" class="${state.loading ? 'tt-spin' : ''}"></i><span>${state.loading ? '快速生成中' : '快速生成'}</span>
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
        if (!(state.project.lessonPlans || []).length && hasPublishedSnapshot(state.project)) {
            return `
                <div class="tt-empty">
                    <i data-lucide="archive-restore"></i>
                    <strong>当前草稿已清空</strong>
                    <span>仍可恢复或导出已发布版本。</span>
                    <button class="tt-btn tt-btn--ghost" type="button" data-restore-published-snapshot="latest" data-restore-published-version="${escapeAttr(state.project.schedule?.published?.version || '')}">
                        <i data-lucide="history"></i><span>恢复发布版</span>
                    </button>
                </div>
            `;
        }
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
    const context = createScheduleRenderContext(state);
    return `
        <div class="tt-schedule-body">
            <div class="tt-schedule-grid" style="--tt-days:${days.length}">
                <div class="tt-grid-head">节次</div>
                ${days.map(day => `<div class="tt-grid-head">周${dayName(day)}</div>`).join('')}
                ${periods.map(period => `
                    ${renderPeriodGridLabel(state.project, period)}
                    ${days.map(day => renderScheduleCell(state, context, day, period)).join('')}
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
                    ${renderPeriodGridLabel(state.project, period)}
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

function renderPeriodGridLabel(project = {}, period) {
    const periodTime = (project.periodTimes || []).find(item => Number(item.period) === Number(period));
    const timeLabel = periodTime?.start && periodTime?.end ? `${periodTime.start}-${periodTime.end}` : '';
    return `
        <div class="tt-period" title="${escapeAttr(timeLabel ? `第${period}节 ${timeLabel}` : `第${period}节`)}">
            <strong>第${period}节</strong>
            ${timeLabel ? `<span>${escapeHtml(timeLabel)}</span>` : ''}
        </div>
    `;
}

function scheduleCellKey(day, period) {
    return `${day}-${period}`;
}

function renderSlotTeacherIds(slot = {}) {
    const ids = Array.isArray(slot.teacherIds) ? [...slot.teacherIds] : [];
    if (slot.teacherId && !ids.includes(slot.teacherId)) ids.unshift(slot.teacherId);
    return ids;
}

function createScheduleRenderContext(state) {
    const project = state.project || {};
    const maps = entityMaps(project);
    const slotsByCell = new Map();
    const visibleSlots = getVisibleSlots(project, state.viewMode, state.selectedOwnerId);
    for (const slot of visibleSlots) {
        const key = scheduleCellKey(slot.day, slot.period);
        const cellSlots = slotsByCell.get(key) || [];
        cellSlots.push(slot);
        slotsByCell.set(key, cellSlots);
    }

    const conflictSlotIds = new Set();
    const conflictKeys = new Set();
    for (const conflict of project.schedule?.conflicts || []) {
        if (conflict.slot?.id) conflictSlotIds.add(conflict.slot.id);
        if (conflict.classId && conflict.teacherId && conflict.day && conflict.period) {
            conflictKeys.add(`${conflict.classId}:${conflict.teacherId}:${conflict.day}:${conflict.period}`);
        }
    }

    return {
        maps,
        slotsByCell,
        conflictSlotIds,
        conflictKeys,
    };
}

function slotHasCachedConflict(context, slot) {
    if (context.conflictSlotIds.has(slot.id)) return true;
    return renderSlotTeacherIds(slot).some(teacherId => (
        context.conflictKeys.has(`${slot.classId}:${teacherId}:${slot.day}:${slot.period}`)
    ));
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

function renderScheduleCell(state, context, day, period) {
    const slots = context.slotsByCell.get(scheduleCellKey(day, period)) || [];
    return `
        <div class="tt-cell" data-day="${day}" data-period="${period}">
            ${slots.map(slot => renderSlot(state, context, slot)).join('')}
        </div>
    `;
}

function renderSlot(state, context, slot) {
    const maps = context.maps;
    const subject = maps.subjects.get(slot.subjectId);
    const klass = maps.classes.get(slot.classId);
    const teacherNames = renderSlotTeacherIds(slot)
        .map(teacherId => maps.teachers.get(teacherId)?.name || teacherId)
        .join('、');
    const classLabel = klass ? `${klass.grade}${klass.name}` : slot.classId;
    const blockId = slot.blockId || '';
    const conflict = slotHasCachedConflict(context, slot);
    const primary = state.viewMode === 'teacher'
        ? `${subject?.name || slot.subjectId} · ${classLabel}`
        : state.viewMode === 'master'
            ? `${classLabel} · ${subject?.name || slot.subjectId}`
            : `${subject?.name || slot.subjectId} · ${teacherNames || slot.teacherId}`;
    const secondary = state.viewMode === 'master'
        ? teacherNames || slot.teacherId
        : `周${dayName(slot.day)} 第${slot.period}节`;
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
            ${renderUnifiedDiagnosticsPanel(state)}
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
                    ${solverDetail.reasonLabel ? `<span class="${solverDetail.kept || solverDetail.isManualReview ? 'is-warning' : ''}"><b>${solverDetail.isManualReview ? '教务复核' : '\u4f18\u5316\u539f\u56e0'}</b>${escapeHtml(solverDetail.reasonLabel)}</span>` : ''}
                    ${solverDetail.kept ? `<span class="is-warning"><b>\u4f18\u5316\u5904\u7406</b>\u5df2\u4fdd\u7559\u5f53\u524d\u8bfe\u8868${solverDetail.reasonLabel ? `：${escapeHtml(solverDetail.reasonLabel)}。` : ''}</span>` : ''}
                    ${state.lastFailure?.solverStats?.lessonCount ? `<span><b>课时数</b>${escapeHtml(state.lastFailure.solverStats.lessonCount)}</span>` : ''}
                    ${state.lastFailure?.solverStats?.timeoutSeconds ? `<span><b>超时上限</b>${escapeHtml(state.lastFailure.solverStats.timeoutSeconds)} 秒</span>` : ''}
                    ${state.lastFailure ? `<span class="is-warning"><b>失败处理</b>旧课表已保留</span>` : ''}
                </div>
            </section>
        </div>
    `;
}

function renderUnifiedDiagnosticsPanel(state) {
    const diagnostics = state.project?.schedule?.diagnostics || state.lastFailure?.diagnostics || null;
    if (!diagnostics || !Array.isArray(diagnostics.items)) return '';
    const summary = diagnostics.summary || {};
    const items = diagnostics.items || [];
    const suggestions = diagnostics.suggestions || [];
    const byObject = diagnostics.byObject || {};
    if (!items.length && !suggestions.length) return '';
    const maps = entityMaps(state.project || {});
    const chipTone = summary.error ? 'tt-chip--warn' : summary.warning ? 'tt-chip--warn' : 'tt-chip--ok';
    const severityIcon = severity => (severity === 'error' ? 'alert-circle' : severity === 'warning' ? 'triangle-alert' : 'info');
    const objectSections = [
        { key: 'classes', label: '班级', icon: 'users', nameOf: id => ownerLabel(maps.classes.get(id) || { id }) },
        { key: 'teachers', label: '教师', icon: 'badge-check', nameOf: id => maps.teachers.get(id)?.name || id },
        { key: 'subjects', label: '课程', icon: 'book-open', nameOf: id => maps.subjects.get(id)?.name || id },
        { key: 'rooms', label: '教室', icon: 'school', nameOf: id => id },
        { key: 'plans', label: '计划', icon: 'notebook-pen', nameOf: id => maps.plans.get(id)?.id || id },
    ].map(section => {
        const bucket = byObject[section.key] || {};
        const entries = Object.entries(bucket)
            .map(([id, itemIds]) => {
                const linkedItems = (Array.isArray(itemIds) ? itemIds : [])
                    .map(itemId => items.find(item => item.id === itemId))
                    .filter(Boolean);
                return {
                    id,
                    name: section.nameOf(id),
                    count: linkedItems.length,
                    topSeverity: linkedItems.some(item => item.severity === 'error')
                        ? 'error'
                        : linkedItems.some(item => item.severity === 'warning')
                            ? 'warning'
                            : 'info',
                    labels: linkedItems.slice(0, 2).map(item => item.message || timetableReviewLabel(item.type)),
                };
            })
            .filter(entry => entry.count > 0)
            .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-Hans-CN'));
        return { ...section, entries };
    }).filter(section => section.entries.length);
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="stethoscope"></i><span>诊断报告</span></h3>
                <span class="tt-chip ${chipTone}">${escapeHtml(summary.total ?? items.length)}</span>
            </div>
            <div class="tt-audit-grid tt-audit-grid--quality">
                <span><b>错误</b>${escapeHtml(summary.error || 0)}</span>
                <span><b>警告</b>${escapeHtml(summary.warning || 0)}</span>
                <span><b>提示</b>${escapeHtml(summary.info || 0)}</span>
                <span><b>建议</b>${escapeHtml(summary.suggestions ?? suggestions.length)}</span>
            </div>
            <div class="tt-conflict-list">
                ${items.slice(0, 5).map(item => `
                    <div class="tt-conflict ${item.severity === 'error' || item.severity === 'warning' ? 'is-warning' : ''}">
                        <i data-lucide="${severityIcon(item.severity)}"></i>
                        <span><b>${escapeHtml(item.targetName || timetableReviewLabel(item.type))}</b>${escapeHtml(item.message || timetableReviewLabel(item.type))}</span>
                    </div>
                `).join('')}
                ${items.length > 5 ? `<span class="tt-muted">还有 ${escapeHtml(items.length - 5)} 项诊断未展开。</span>` : ''}
            </div>
            ${objectSections.length ? `
                <div class="tt-diagnostics-groups">
                    ${objectSections.map(section => `
                        <div class="tt-diagnostics-group">
                            <div class="tt-rule-report-title">
                                <span><i data-lucide="${section.icon}"></i>${escapeHtml(section.label)}</span>
                                <span>${escapeHtml(section.entries.length)}</span>
                            </div>
                            <div class="tt-rule-preview tt-rule-preview--compact">
                                ${section.entries.slice(0, 3).map(entry => `
                                    <div class="tt-rule-preview-item tt-diagnostics-group-item ${entry.topSeverity === 'error' ? 'is-error' : entry.topSeverity === 'warning' ? 'is-warning' : ''}">
                                        <strong>${escapeHtml(entry.name)}</strong>
                                        <span>${escapeHtml(`关联 ${entry.count} 项诊断`)}</span>
                                        ${entry.labels[0] ? `<em>${escapeHtml(entry.labels.join('；'))}</em>` : ''}
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
            ${suggestions.length ? `
                <div class="tt-rule-warning-list">
                    ${suggestions.slice(0, 3).map(item => `
                        <div class="tt-rule-warning">
                            <i data-lucide="lightbulb"></i>
                            <span>${escapeHtml(item.message || '建议草稿')}</span>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        </section>
    `;
}

function renderAuditPanel(state) {
    const stats = getRosterStats(state.project);
    const rules = getRuleSummary(state.project);
    const preview = state.ruleDraftPreview || [];
    const warnings = state.ruleWarnings || [];
    const unsupported = state.ruleReview?.unsupportedItems || state.ruleUnsupportedItems || [];
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
            ${unsupported.length ? `
                <div class="tt-rule-preview tt-rule-preview--compact">
                    ${unsupported.slice(0, 3).map(item => `
                        <div class="tt-rule-preview-item">
                            <strong>${escapeHtml(item.targetName || item.targetId || item.type)}</strong>
                            <span>${escapeHtml(item.type)} 路 ${escapeHtml(item.description || '仅作建议展示')}</span>
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
    const issueEntries = normalizeScheduleDiagnosticIssues(state);
    if (!audit && !issueEntries.length) return '';
    const teachers = audit?.bottlenecks?.teachers || [];
    const classes = audit?.bottlenecks?.classes || [];
    const capacity = audit?.capacity || {};
    const issueSummary = summarizeInspectorIssueEntries(issueEntries);
    const chipTone = issueSummary.error || issueSummary.warning ? 'tt-chip--warn' : 'tt-chip--ok';
    const chipLabel = issueEntries.length ? `${issueEntries.length} 项` : '正常';
    const detailItems = [];
    if (audit) {
        detailItems.push(`<span><b>容量</b>${escapeHtml(`${capacity.totalLessons ?? 0}/${capacity.classCapacity ?? capacity.availableSlots ?? 0}`)}</span>`);
    }
    if (teachers[0]) {
        detailItems.push(`<span><b>瓶颈教师</b>${escapeHtml(`${teachers[0].name || teachers[0].id} ${teachers[0].utilization || 0}%`)}</span>`);
    }
    if (classes[0]) {
        detailItems.push(`<span><b>瓶颈班级</b>${escapeHtml(`${classes[0].name || classes[0].id} ${classes[0].utilization || 0}%`)}</span>`);
    }
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="stethoscope"></i><span>排课诊断</span></h3>
                <span class="tt-chip ${chipTone}">${chipLabel}</span>
            </div>
            ${detailItems.length ? `<div class="tt-detail-list">${detailItems.join('')}</div>` : ''}
            ${renderInspectorIssueGroups({
                title: '诊断问题',
                entries: issueEntries,
                panel: 'diagnostic',
                legacyItemClass: 'tt-schedule-diagnostic-item',
            })}
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
    const persistedStats = schedule?.solverStats || null;
    const detail = job || persistedStats;
    if (schedule?.published?.status === 'published' && !job) return '';
    const restoredPublishedDraft = schedule?.source === 'published_history_restored'
        || persistedStats?.phase === 'published_history_restore'
        || Boolean(persistedStats?.restoredPublishedDraft);
    if (!detail && schedule?.source !== 'fast_constructed') return '';
    if (!job && schedule?.source !== 'fast_constructed' && persistedStats?.phase !== 'timefold_optimization') return '';
    const label = optimizationStatusLabel(detail);
    const reasonLabel = solverReasonLabel(job?.reason || job?.solverStats?.reason || persistedStats?.reason || '');
    const statusText = job
        ? label
        : (label || '等待下一次 Timefold 优化');
    const sourceText = restoredPublishedDraft
        ? '恢复发布版'
        : schedule?.source === 'fast_constructed'
        ? '快速课表'
        : schedule?.source === 'timefold_solver'
            ? 'Timefold'
            : schedule?.source === 'manual_adjusted'
                ? '手动调整'
                : '未生成';
    return `
        <section class="tt-inspector-section">
            <div class="tt-section-title">
                <h3><i data-lucide="refresh-cw"></i><span>后台优化</span></h3>
                ${detail ? `<span class="tt-chip ${detail.status === 'failed' ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(detail.status)}</span>` : ''}
            </div>
            <div class="tt-detail-list">
                <span><b>当前课表</b>${escapeHtml(sourceText)}</span>
                <span><b>优化状态</b>${escapeHtml(statusText)}</span>
                ${reasonLabel ? `<span class="is-warning"><b>处理结果</b>${escapeHtml(reasonLabel)}</span>` : ''}
                ${(job?.solverStats?.lessonCount || persistedStats?.lessonCount) ? `<span><b>课时数</b>${escapeHtml(job?.solverStats?.lessonCount || persistedStats?.lessonCount)}</span>` : ''}
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
