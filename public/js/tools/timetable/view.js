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
} from './selectors.js';
import { buildRuleReviewTasks, getActiveRuleReviewTask } from './rule-review-tasks.js';
import { renderConstraintChatDock } from './view-chat.js';
import { renderFixPreview, renderSmartHelperDialog } from './view-smart-helper.js';
import { renderConstraintDialog } from './view-constraint-dialog.js';
import {
    buildUnifiedRequirementItems,
    draftRowApplyItemKey,
    getActionableRequirementCount,
    getRequirementGroupKey,
    isApplyItemExcluded,
    semanticActionApplyItemKey,
} from './constraint-dialog-review-model.js';
import { buildDutyTeacherSearchModel } from './duty-teacher-search.js';
import {
    plannerRuleTypeLabel as ruleTypeLabel,
} from './constraint-status-dict.js';

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

const LEGACY_NON_ACTIONABLE_REVIEW_TYPES = new Set(['class_load', 'subject_spread', 'morning_subject_late']);

function timetableProjectFromActionContext(context = {}) {
    return context?.project || context || {};
}

function hasExplicitTeacherConsecutiveLimit(context = {}, item = {}) {
    const project = timetableProjectFromActionContext(context);
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

function isActionableTimetableReviewItem(item = {}, context = {}) {
    if (item.type === 'teacher_consecutive') {
        return hasExplicitTeacherConsecutiveLimit(context, item);
    }
    return !LEGACY_NON_ACTIONABLE_REVIEW_TYPES.has(item.type);
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
    if (sorted.length === 5 && sorted.every((value, index) => value === index + 1)) return '周一至周五';
    if (sorted.length === 7) return '全周';
    if (sorted.length > 2 && isContiguous(sorted)) return `周${dayName(sorted[0])}至周${dayName(sorted[sorted.length - 1])}`;
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

function renderMultiSelectPopover({
    title,
    items,
    activeValues,
    dataAttr,
    presets = [],
    presetAttr = 'data-range-preset',
    doneAttr = 'data-tt-popover-close',
    closeAttr = 'data-tt-popover-close',
}) {
    return `
        <div class="tt-popover-header">
            <strong>${escapeHtml(title)}</strong>
            <button class="tt-icon-btn tt-icon-btn--sm" type="button" ${closeAttr} title="关闭" aria-label="关闭"><i data-lucide="x"></i></button>
        </div>
        ${presets.length ? renderPresetButtons(presets, presetAttr) : ''}
        ${renderCheckList({ items, activeValues, dataAttr })}
        <div class="tt-popover-actions">
            <button class="tt-btn" type="button" ${doneAttr}><i data-lucide="check"></i><span>完成</span></button>
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
                ${renderMultiSelectPopover({ title, items, activeValues, dataAttr, presets, presetAttr, doneAttr })}
            </div>
        </details>
    `;
}

function renderRangePopoverTrigger({
    id,
    popoverId,
    triggerId,
    title,
    summary,
    open = false,
    summaryOnly = false,
}) {
    const triggerClass = `tt-multi-select-trigger${summaryOnly ? ' tt-multi-select-trigger--summary-only' : ''}`;
    return `
        <div class="tt-multi-select ${open ? 'is-open' : ''}" data-tt-multi-select="${escapeAttr(id)}">
            <button class="${triggerClass}" id="${escapeAttr(triggerId)}" type="button" data-range-popover-trigger="${escapeAttr(popoverId)}" aria-haspopup="dialog" aria-expanded="${open ? 'true' : 'false'}">
                ${summaryOnly ? '' : `<span>${escapeHtml(title)}</span>`}
                <strong>${escapeHtml(summary)}</strong>
                <i data-lucide="chevron-down"></i>
            </button>
        </div>
    `;
}

function getRangeDraft(state) {
    return {
        activeWeekdays: state.rangeDraft?.activeWeekdays || getActiveWeekdays(state.project),
        activePeriods: state.rangeDraft?.activePeriods || getActivePeriods(state.project),
    };
}

function rangePopoverConfig(state) {
    const popoverId = state.rangePopover?.id || '';
    const { activeWeekdays, activePeriods } = getRangeDraft(state);
    if (popoverId === 'activeWeekdays') {
        return {
            popoverId,
            title: '可用周几',
            items: WEEKDAY_OPTIONS,
            activeValues: activeWeekdays,
            dataAttr: 'data-active-weekday',
            presets: [
                { value: 'weekdays:workdays', label: '工作日' },
                { value: 'weekdays:all', label: '全周' },
            ],
        };
    }
    if (popoverId === 'activePeriods') {
        const periodsFromSegments = Array.isArray(state.project?.periodTimeSegments?.segments)
            && state.project.periodTimeSegments.segments.length > 0;
        if (periodsFromSegments) return null;
        return {
            popoverId,
            title: '可用节次',
            items: PERIOD_OPTIONS,
            activeValues: activePeriods,
            dataAttr: 'data-active-period',
            presets: [
                { value: 'periods:first7', label: '第1-7节' },
                { value: 'periods:all', label: '全部节次' },
            ],
        };
    }
    return null;
}

function renderRangeFloatingPopover(state) {
    const config = rangePopoverConfig(state);
    if (!config) return '';
    const rect = state.rangePopover?.rect || {};
    const top = Number.isFinite(rect.top) ? Math.round(rect.top) : 0;
    const left = Number.isFinite(rect.left) ? Math.round(rect.left) : 0;
    const width = Number.isFinite(rect.width) ? Math.round(rect.width) : 260;
    const style = `--tt-floating-popover-top:${top}px;--tt-floating-popover-left:${left}px;--tt-floating-popover-width:${width}px`;
    return `
        <div class="tt-floating-popover-layer" data-range-popover-layer>
            <div class="tt-multi-select-popover tt-floating-range-popover" data-range-popover-panel="${escapeAttr(config.popoverId)}" role="dialog" aria-label="${escapeAttr(config.title)}" style="${escapeAttr(style)}">
                ${renderMultiSelectPopover({
                    title: config.title,
                    items: config.items,
                    activeValues: config.activeValues,
                    dataAttr: config.dataAttr,
                    presets: config.presets,
                    doneAttr: 'data-range-apply',
                    closeAttr: 'data-range-popover-close',
                })}
            </div>
        </div>
    `;
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
    const inspectorModel = buildInspectorViewModel(state);
    const inspectorSummary = inspectorHeaderSummary(inspectorModel);
    const inspectorOpen = Boolean(state.inspectorOpen || state.selectedSlotId || state.lastFailure || state.solverJob);
    const constraintOpen = Boolean(state.constraintDialog?.open);
    const inspectorPosition = state.inspectorPosition || null;
    const hasInspectorPosition = Number.isFinite(inspectorPosition?.x) && Number.isFinite(inspectorPosition?.y);
    const inspectorClass = [
        'tt-inspector',
        inspectorOpen ? 'is-open' : 'is-collapsed',
        hasInspectorPosition ? 'is-positioned' : '',
    ].filter(Boolean).join(' ');
    const inspectorStyle = hasInspectorPosition
        ? ` style="--tt-inspector-x:${Math.round(inspectorPosition.x)}px;--tt-inspector-y:${Math.round(inspectorPosition.y)}px"`
        : '';
    return `
        <div class="tt-workbench ${constraintOpen ? 'is-constraint-dialog-open' : ''}">
            ${renderTopbar(state)}
            <aside class="tt-sidebar">
                ${renderWorkflow(state)}
            </aside>
            <section class="tt-schedule-panel">
                ${renderSchedulePanel(state)}
            </section>
            <aside class="${inspectorClass}" data-inspector-floating-window${inspectorStyle}>
                <details class="tt-inspector-drawer" id="tt-inspector-drawer" ${inspectorOpen ? 'open' : ''}>
                    <summary class="tt-inspector-summary" data-inspector-drag-handle>
                        <span class="tt-inspector-summary-main"><i data-lucide="panel-right-open"></i><strong>排课审查</strong></span>
                        <em>${escapeHtml(inspectorSummary)}</em>
                        <span class="tt-inspector-summary-action" data-inspector-toggle-icon aria-hidden="true">
                            <i data-lucide="${inspectorOpen ? 'chevron-up' : 'chevron-down'}"></i>
                        </span>
                    </summary>
                    <div class="tt-inspector-body">
                        ${renderInspector(state, inspectorModel)}
                    </div>
                </details>
            </aside>
            ${renderRangeFloatingPopover(state)}
            ${renderRosterImportDialog(state)}
            ${renderPeriodTimeDialog(state)}
            ${renderDutyAssignmentDialog(state)}
            ${renderPublishDialog(state)}
            ${renderRestoreDialog(state)}
            ${renderPublicationHistoryDialog(state)}
            ${renderSmartHelperDialog(state)}
            ${renderConstraintDialog(state)}
            ${renderConstraintChatDock(state)}
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
                chip: smartHelperSidebarChip(state, rules.total),
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
    const hasSegmentConfig = Array.isArray(state.project?.periodTimeSegments?.segments) && state.project.periodTimeSegments.segments.length > 0;
    const configuredPeriods = completeProjectPeriodTimes(state.project, periodTimes)
        .filter(item => activePeriods.includes(Number(item.period)) && (item.start || item.end))
        .map(item => Number(item.period));
    const summary = summarizeRangeTimeBlocks(state.project, hasSegmentConfig ? activePeriods : configuredPeriods);
    const timeRange = summarizeFullPeriodTimeRange(state.project, periodTimes);
    const rangeLabel = timeRange.rangeLabel;
    const statusParts = [];
    if (summary.formalTotal) statusParts.push(summary.formalTotalLabel);
    if (summary.additionalTotal) statusParts.push(summary.additionalTotalLabel);
    const statusLabel = timeRange.configured && statusParts.length
        ? `${statusParts.join(' · ')} · 已配置`
        : '未配置';
    return `
        <button class="tt-period-time-entry" id="tt-open-period-time-dialog" type="button">
            <span class="tt-period-time-entry-icon">
                <i data-lucide="clock"></i>
            </span>
            <span class="tt-period-time-entry-copy">
                <strong>节次时间</strong>
                <span class="tt-period-time-entry-action">配置时间</span>
                ${rangeLabel ? `<em class="tt-period-time-entry-range">${escapeHtml(rangeLabel)}</em>` : ''}
                <em class="tt-period-time-entry-status">${escapeHtml(statusLabel)}</em>
            </span>
        </button>
    `;
}

function periodSetupKind(segment = {}) {
    const kind = ['teaching', 'duty', 'display'].includes(segment.kind)
        ? segment.kind
        : (isStudySegment(segment) ? 'duty' : 'teaching');
    return kind;
}

function isEarlyStudySegment(segment = {}) {
    return /早自习|早读|早修|晨读/.test(String(segment.label || ''));
}

function isEveningStudySegment(segment = {}) {
    return /晚自习|晚修/.test(String(segment.label || ''));
}

function isStudySegment(segment = {}) {
    return isEarlyStudySegment(segment) || isEveningStudySegment(segment);
}

function periodSetupPeriodCount(segmentConfig = {}) {
    const segments = Array.isArray(segmentConfig.segments) ? segmentConfig.segments : [];
    return segments
        .filter(segment => periodSetupKind(segment) === 'teaching')
        .reduce((sum, segment) => sum + (Math.max(0, Number.parseInt(segment.periodCount, 10) || 0)), 0);
}

function splitAdditionalSegmentId(id = '', index = 0) {
    return `${id || 'seg'}__p${index + 1}`;
}

function splitAdditionalSegmentLabel(label = '', index = 0, total = 1) {
    if (total <= 1) return label || '附加时段';
    return `${label || '附加时段'}${index + 1}`;
}

function expandPeriodTimeSegments(segmentConfig = {}) {
    const segments = Array.isArray(segmentConfig.segments) ? segmentConfig.segments : [];
    const projectForPreview = { periodTimeSegments: segmentConfig };
    return segments.flatMap(segment => {
        const kind = periodSetupKind(segment);
        const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
        if (kind === 'teaching' || periodCount <= 1) return [segment];
        const startMinutes = timeToMinutes(segment.startTime);
        const { classMinutes, breakMinutes } = segmentDurationMinutes(projectForPreview, segment);
        return Array.from({ length: periodCount }, (_, index) => ({
            ...segment,
            id: splitAdditionalSegmentId(segment.id, index),
            label: splitAdditionalSegmentLabel(segment.label, index, periodCount),
            startTime: startMinutes === null ? segment.startTime : minutesToTime(startMinutes + index * (classMinutes + breakMinutes)),
            periodCount: 1,
            classMinutes,
            breakMinutes,
        }));
    });
}

function segmentUiType(kind = 'teaching') {
    return kind === 'teaching' ? 'teaching' : 'additional';
}

export function formatPeriodTimeSegmentMeta(segment = {}, index = 0) {
    const kind = periodSetupKind(segment);
    const usedCount = segment.periodCount || 0;
    const metaParts = [`时段${index + 1}`, timeBlockKindLabel(kind)];
    if (kind === 'teaching') metaParts.push(`${usedCount}节`);
    if (kind === 'duty') metaParts.push('值班');
    return metaParts.join(' · ');
}

function renderSegmentCard(segment, index, totalSegments, activePeriods, saving) {
    const canDelete = totalSegments > 1;
    const kind = periodSetupKind(segment);
    const uiType = segmentUiType(kind);
    const dutyChecked = kind === 'duty' || (kind === 'teaching' && isStudySegment(segment));
    const maxCount = 12;
    const escapeAttr = value => String(value ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const escapeHtml = value => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const typeOptions = [
        `<option value="teaching" ${uiType === 'teaching' ? 'selected' : ''}>正式节次</option>`,
        `<option value="additional" ${uiType === 'additional' ? 'selected' : ''}>附加时段</option>`,
    ].filter(Boolean).join('');
    const metaText = formatPeriodTimeSegmentMeta(segment, index);

    return `
        <div class="tt-segment-card" data-period-time-segment-card data-segment-id="${escapeAttr(segment.id)}" data-segment-kind="${escapeAttr(kind)}">
            <div class="tt-segment-card-header">
                <input type="text"
                    class="tt-roster-review-field tt-segment-label-input"
                    data-segment-field="${escapeAttr(segment.id)}-label"
                    value="${escapeAttr(segment.label)}"
                    placeholder="时段名称"
                    maxlength="40"
                    ${saving ? 'disabled' : ''}>
                <span class="tt-segment-index">${escapeHtml(metaText)}</span>
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
                    <span>类型</span>
                    <select class="tt-roster-review-field"
                        data-segment-field="${escapeAttr(segment.id)}-kind"
                        ${saving ? 'disabled' : ''}>
                        ${typeOptions}
                    </select>
                </label>
                <div class="tt-segment-field tt-segment-duty-field ${uiType === 'teaching' ? 'is-hidden' : ''}" ${uiType === 'teaching' ? 'hidden aria-hidden="true"' : ''}>
                    <span>值班教师</span>
                    <label class="tt-segment-duty-toggle">
                        <input type="checkbox"
                            data-segment-field="${escapeAttr(segment.id)}-dutyEnabled"
                            ${dutyChecked ? 'checked' : ''}
                            ${saving || uiType === 'teaching' ? 'disabled' : ''}>
                        <em data-segment-duty-status>${dutyChecked ? '开启' : '关闭'}</em>
                    </label>
                </div>
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

function renderSegmentGroups(segmentConfig = {}, activePeriods = [], saving = false) {
    const segments = expandPeriodTimeSegments(segmentConfig);
    const groups = [
        { key: 'additional', title: '附加时段', match: segment => periodSetupKind(segment) !== 'teaching' },
        { key: 'teaching', title: '正式节次', match: segment => periodSetupKind(segment) === 'teaching' },
    ];
    return groups.map(group => {
        const items = segments
            .map((segment, index) => ({ segment, index }))
            .filter(item => group.match(item.segment));
        if (!items.length) return '';
        return `
            <section class="tt-segment-group tt-segment-group--${escapeAttr(group.key)}">
                <div class="tt-segment-group-head">
                    <span class="tt-segment-group-rule" aria-hidden="true"></span>
                    <strong>${escapeHtml(group.title)}</strong>
                </div>
                ${items.map(item => renderSegmentCard(item.segment, item.index, segments.length, activePeriods, saving)).join('')}
            </section>
        `;
    }).join('');
}

export function renderNonTeachingSegmentPreview(segmentConfig = {}) {
    const previewItems = expandPeriodTimeSegments(segmentConfig)
        .map(segment => {
            const kind = periodSetupKind(segment);
            const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
            return { ...segment, kind, periodCount };
        })
        .filter(segment => segment.kind === 'display' && segment.periodCount > 0);

    if (!previewItems.length) return '';

    const projectForPreview = { periodTimeSegments: segmentConfig };
    return `
        <div class="tt-nonformal-time-preview" aria-label="附加时段">
            <div class="tt-nonformal-time-preview-head">
                <strong>附加时段</strong>
            </div>
            <div class="tt-nonformal-time-list">
                ${previewItems.map(segment => {
                    const label = segment.label || '展示时段';
                    const timeLabel = studyBlockTimeLabel(projectForPreview, segment);
                    return `
                        <div class="tt-nonformal-time-item tt-nonformal-time-item--${escapeAttr(segment.kind)}">
                            <strong>${escapeHtml(label)}</strong>
                            <span>${escapeHtml(timeBlockKindLabel(segment.kind))}</span>
                            <span>${escapeHtml(timeLabel || '时间未配置')}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function buildPeriodTimesFromProjectSegments(project = {}, activePeriods = getActivePeriods(project)) {
    const segments = Array.isArray(project.periodTimeSegments?.segments) ? project.periodTimeSegments.segments : [];
    if (!segments.length) return [];
    const times = [];
    let periodIndex = 0;

    for (const segment of segments) {
        const kind = periodSetupKind(segment);
        if (kind !== 'teaching') continue;
        const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
        const startMinutes = timeToMinutes(segment.startTime);
        if (startMinutes === null) continue;
        const { classMinutes, breakMinutes } = segmentDurationMinutes(project, segment);
        let currentMinutes = startMinutes;

        for (let index = 0; index < periodCount && periodIndex < activePeriods.length; index += 1) {
            const period = Number(activePeriods[periodIndex]);
            const start = minutesToTime(currentMinutes);
            const end = minutesToTime(currentMinutes + classMinutes);
            times.push({ period, start, end, segmentLabel: segment.label || '' });
            currentMinutes += classMinutes;
            if (index < periodCount - 1) currentMinutes += breakMinutes;
            periodIndex += 1;
        }
    }

    return times;
}

function completeProjectPeriodTimes(project = {}, times = project.periodTimes || []) {
    const activePeriods = getActivePeriods(project).map(Number);
    const activeSet = new Set(activePeriods);
    const generated = new Map(buildPeriodTimesFromProjectSegments(project, activePeriods)
        .map(item => [Number(item.period), item]));
    const existing = new Map((Array.isArray(times) ? times : [])
        .map(item => ({
            period: Number(item.period),
            start: item.start || '',
            end: item.end || '',
        }))
        .filter(item => activeSet.has(item.period) && (item.start || item.end))
        .map(item => [item.period, item]));

    return activePeriods
        .map(period => {
            const current = existing.get(period);
            const fallback = generated.get(period);
            if (!current) return fallback || { period, start: '', end: '' };
            if (!fallback) return current;
            return {
                ...fallback,
                ...current,
                start: current.start || fallback.start,
                end: current.end || fallback.end,
            };
        })
        .filter(item => item.start || item.end);
}

function gapBetweenPeriodRows(current = {}, next = {}) {
    const end = timeToMinutes(current.end);
    const start = timeToMinutes(next.start);
    if (end === null || start === null) return '';
    return start - end;
}

function buildPeriodTimeTimelineRows(activePeriods = [], timeMap = new Map(), segmentConfig = {}) {
    const segments = expandPeriodTimeSegments(segmentConfig);
    if (!segments.length) {
        return activePeriods.map((period, index) => ({
            kind: 'teaching',
            period,
            periodIndex: index,
            segmentLabel: '',
            sortKey: index,
            order: index,
        }));
    }

    const rows = [];
    let periodIndex = 0;
    segments.forEach((segment, segmentIndex) => {
        const kind = periodSetupKind(segment);
        const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
        if (kind === 'duty' || kind === 'display') {
            const start = timeToMinutes(segment.startTime);
            rows.push({
                kind,
                timeBlock: segment,
                segmentLabel: segment.label || '',
                sortKey: start ?? ((segmentIndex + 1) * 10000),
                order: rows.length,
            });
            return;
        }
        if (kind === 'teaching') {
            for (let index = 0; index < periodCount && periodIndex < activePeriods.length; index += 1) {
                const period = activePeriods[periodIndex];
                const entry = timeMap.get(period) || {};
                const start = timeToMinutes(entry.start) ?? timeToMinutes(segment.startTime);
                rows.push({
                    kind: 'teaching',
                    period,
                    periodIndex,
                    segmentLabel: segment.label || '',
                    sortKey: start ?? ((segmentIndex + 1) * 10000 + index),
                    order: rows.length,
                });
                periodIndex += 1;
            }
            return;
        }
    });
    return rows.sort((left, right) => (left.sortKey - right.sortKey) || (left.order - right.order));
}

export function renderPeriodTimeTableBody({
    activePeriods = [],
    draftTimes = [],
    errors = [],
    segmentConfig = {},
    saving = false,
} = {}) {
    const timeMap = new Map((Array.isArray(draftTimes) ? draftTimes : []).map(item => [Number(item.period), item]));
    const errorMap = new Map((Array.isArray(errors) ? errors : []).map(item => [Number(item.period), item.message || '时间配置有误']));
    const rows = buildPeriodTimeTimelineRows(activePeriods, timeMap, segmentConfig);
    const projectForPreview = { periodTimeSegments: segmentConfig };
    const rowIntervals = rows.map(row => {
        if (row.kind === 'teaching') {
            const entry = timeMap.get(row.period) || {};
            return { start: entry.start || '', end: entry.end || '' };
        }
        const timeLabel = studyBlockTimeLabel(projectForPreview, row.timeBlock || {});
        const [start = '', end = ''] = timeLabel ? timeLabel.split('-') : [];
        return { start, end };
    });
    let previousTeachingSegmentLabel = '';

    return rows.map((row, rowIndex) => {
        if (row.kind !== 'teaching') {
            const segment = row.timeBlock || {};
            const { start: startTime = '', end: endTime = '' } = rowIntervals[rowIndex] || {};
            const nextInterval = rowIntervals[rowIndex + 1] || null;
            const gapValue = nextInterval ? gapBetweenPeriodRows({ end: endTime }, { start: nextInterval.start }) : '';
            const kindClass = row.kind === 'duty' ? 'tt-period-time-block-row--duty' : 'tt-period-time-block-row--display';
            const gapCell = nextInterval
                ? `<input type="number" class="tt-roster-review-field tt-period-time-gap-input" data-period-time-block-gap-after="${escapeAttr(segment.id || '')}" min="0" max="240" step="1" value="${escapeAttr(gapValue)}" ${saving ? 'disabled' : ''}>`
                : '<span class="tt-period-time-gap-empty">无课后间隔</span>';
            const dutyNote = row.kind === 'duty'
                ? '<span class="tt-period-time-label-note">值班教师</span>'
                : '';
            return `<tr data-period-time-block-row="${escapeAttr(segment.id || '')}" class="tt-period-time-block-row ${kindClass}">
                <td class="tt-period-time-label" data-label="节次"><strong>${escapeHtml(segment.label || '附加时段')}</strong>${dutyNote}</td>
                <td data-label="开始时间"><input type="time" class="tt-roster-review-field tt-period-time-input" data-period-time-block-start="${escapeAttr(segment.id || '')}" value="${escapeAttr(startTime || '')}" ${saving ? 'disabled' : ''}></td>
                <td data-label="结束时间"><input type="time" class="tt-roster-review-field tt-period-time-input" data-period-time-block-end="${escapeAttr(segment.id || '')}" value="${escapeAttr(endTime || '')}" ${saving ? 'disabled' : ''}></td>
                <td data-label="本节后间隔">${gapCell}</td>
            </tr>`;
        }
        const period = row.period;
        const entry = timeMap.get(period) || {};
        const next = timeMap.get(activePeriods[row.periodIndex + 1]) || {};
        const error = errorMap.get(period) || '';
        const isManual = entry.manualOverride;
        const segmentLabel = entry.segmentLabel || row.segmentLabel || '';
        const showSegmentLabel = Boolean(segmentLabel && segmentLabel !== previousTeachingSegmentLabel);
        previousTeachingSegmentLabel = segmentLabel || previousTeachingSegmentLabel;
        return `${showSegmentLabel ? `<tr class="tt-period-time-segment-header"><td colspan="4"><strong>${escapeHtml(segmentLabel)}</strong></td></tr>` : ''}<tr data-period-time-row="${period}" class="${error ? 'is-error' : ''} ${isManual ? 'is-manual-override' : ''}">
            <td class="tt-period-time-label" data-label="节次">第${period}节${isManual ? ' 🔒' : ''}</td>
            <td data-label="开始时间"><input type="time" class="tt-roster-review-field tt-period-time-input" data-period-time-draft-start="${period}" value="${escapeAttr(entry.start || '')}" ${error ? 'aria-invalid="true"' : ''} ${saving ? 'disabled' : ''}></td>
            <td data-label="结束时间"><input type="time" class="tt-roster-review-field tt-period-time-input" data-period-time-draft-end="${period}" value="${escapeAttr(entry.end || '')}" ${error ? 'aria-invalid="true"' : ''} ${saving ? 'disabled' : ''}></td>
            <td data-label="本节后间隔">
                ${row.periodIndex < activePeriods.length - 1
                    ? `<input type="number" class="tt-roster-review-field tt-period-time-gap-input" data-period-time-gap-after="${period}" min="0" max="240" step="1" value="${escapeAttr(gapBetweenPeriodRows(entry, next))}" ${saving ? 'disabled' : ''}>`
                    : '<span class="tt-period-time-gap-empty">无课后间隔</span>'}
            </td>
        </tr>${error ? `<tr class="tt-period-time-error-row"><td colspan="4">${escapeHtml(error)}</td></tr>` : ''}`;
    }).join('');
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
    const totalConfiguredPeriods = periodSetupPeriodCount(segmentConfig);
    const activePeriods = totalConfiguredPeriods > 0
        ? Array.from({ length: totalConfiguredPeriods }, (_, i) => i + 1)
        : [...getActivePeriods(state.project)].sort((left, right) => left - right);

    const saving = Boolean(dialog.saving);
    const draftTimes = Array.isArray(dialog.draftTimes) ? dialog.draftTimes : state.rangeDraft?.periodTimes || state.project?.periodTimes || [];
    const errorMap = new Map((dialog.errors || []).map(item => [Number(item.period), item.message || '时间配置有误']));
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
                        <span>配置作息时段，系统生成节次时间轴。</span>
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
                        ${renderSegmentGroups(segmentConfig, activePeriods, saving)}
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
                    <span>正式节次可微调；附加时段随上方配置同步。</span>
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
                        <tbody data-period-time-table-body-slot>
                            ${renderPeriodTimeTableBody({
                                activePeriods,
                                draftTimes,
                                errors: dialog.errors || [],
                                segmentConfig,
                                saving,
                            })}
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
    const periodsFromSegments = Array.isArray(project.periodTimeSegments?.segments) && project.periodTimeSegments.segments.length > 0;
    const rangeSummary = summarizeRangeTimeBlocks(project, activePeriods);
    const rangeSegmentDetail = [
        rangeSummary.formalSegmentLabel,
        rangeSummary.additionalSegmentLabel,
    ].filter(Boolean).join(' · ');

    return `
        <div class="tt-setup-card tt-range-setup-card" data-workflow-step="data">
            <div class="tt-subsection-title">
                <h4><i data-lucide="calendar-days"></i><span>排课范围</span></h4>
                <span class="tt-chip">${activeWeekdays.length} 天 · ${activePeriods.length} 节</span>
            </div>
            <form id="tt-project-form" class="tt-range-form">
                <div class="tt-range-summary-grid">
                    ${renderRangePopoverTrigger({
                        id: 'range-weekdays',
                        popoverId: 'activeWeekdays',
                        triggerId: 'tt-range-weekdays-trigger',
                        title: '可用周几',
                        summary: summarizeWeekdays(activeWeekdays),
                        open: state.rangePopover?.id === 'activeWeekdays',
                        summaryOnly: true,
                    })}
                    ${periodsFromSegments ? `
                        <div class="tt-range-summary-card tt-range-summary-card--readonly">
                            <div class="tt-range-summary-trigger" data-range-label="可用节次">
                                <strong>${escapeHtml(rangeSummary.totalLabel || summarizePeriods(activePeriods))}</strong>
                                ${rangeSegmentDetail ? `<small class="tt-range-summary-detail" title="${escapeAttr(rangeSegmentDetail)}">${escapeHtml(rangeSegmentDetail)}</small>` : ''}
                            </div>
                        </div>
                    ` : renderRangePopoverTrigger({
                        id: 'range-periods',
                        popoverId: 'activePeriods',
                        triggerId: 'tt-range-periods-trigger',
                        title: '可用节次',
                        summary: summarizePeriods(activePeriods),
                        open: state.rangePopover?.id === 'activePeriods',
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
    const dialogClass = `tt-roster-import-dialog${isReview ? ' tt-roster-import-dialog--review' : ''}`;
    return `
        <div class="tt-dialog-overlay" data-roster-import-close>
            <section class="${dialogClass}" id="tt-roster-import-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-roster-import-title">
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
            ${renderRosterIssueEditor(dialog)}
        </div>
    `;
}

function renderRosterImportInput(dialog, mode, fileName) {
    const isBusy = Boolean(dialog.loading);
    const disabled = isBusy ? 'disabled' : '';
    const fileBusy = isBusy && mode === 'file';
    const textBusy = isBusy && mode === 'text';
    const phaseText = dialog.phaseText || '解析任课数据中...';
    const phaseTone = dialog.phaseTone === 'warning' ? ' tt-process-chip--warning' : '';
    return `
        <div class="tt-roster-import-options" role="group" aria-label="选择任课数据导入方式">
            <section class="tt-roster-import-option tt-roster-import-option--file ${mode === 'file' ? 'is-active' : ''}" aria-labelledby="tt-roster-import-file-title">
                <div class="tt-roster-import-option-head">
                    <span class="tt-roster-import-option-icon"><i data-lucide="upload-cloud"></i></span>
                    <div>
                        <h4 id="tt-roster-import-file-title">上传文件</h4>
                        <p>智能 CSV / TXT / Excel 文件导入</p>
                    </div>
                </div>
                <div class="tt-roster-import-option-body">
                    <label class="tt-import-dropzone">
                        <i data-lucide="${fileBusy ? 'loader-2' : 'upload-cloud'}" class="${fileBusy ? 'tt-spin' : ''}"></i>
                        <strong>${escapeHtml(fileName)}</strong>
                        <span>.csv / .txt / .xlsx / .xls</span>
                        <input id="tt-roster-import-file" type="file" accept=".csv,.txt,.xlsx,.xls" ${disabled}>
                    </label>
                </div>
                <div class="tt-roster-import-option-actions tt-roster-import-option-actions--full">
                    <button class="tt-btn tt-btn--primary" type="button" data-roster-import-submit="file" ${disabled}>
                        <i data-lucide="${fileBusy ? 'loader-2' : 'file-search'}" class="${fileBusy ? 'tt-spin' : ''}"></i>
                        <span>${fileBusy ? '解析中' : '解析文件'}</span>
                    </button>
                </div>
            </section>
            <section class="tt-roster-import-option tt-roster-import-option--text ${mode === 'text' ? 'is-active' : ''}" aria-labelledby="tt-roster-import-text-title">
                <div class="tt-roster-import-option-head">
                    <span class="tt-roster-import-option-icon"><i data-lucide="file-text"></i></span>
                    <div>
                        <h4 id="tt-roster-import-text-title">粘贴文本</h4>
                        <p>智能识别自然语言的文本</p>
                    </div>
                </div>
                <div class="tt-roster-import-option-body">
                    <textarea id="tt-roster-import-text" class="tt-import-text" spellcheck="false" placeholder="例如：年级,班级,课程,教师,周课时,连堂；七年级,1班,语文,林老师,5,混合" ${disabled}>${escapeHtml(dialog.text || '')}</textarea>
                </div>
                <div class="tt-roster-import-option-actions">
                    <button class="tt-btn" id="tt-fill-roster-sample" type="button" ${disabled}><i data-lucide="wand-sparkles"></i><span>示例</span></button>
                    <button class="tt-btn tt-btn--primary" type="button" data-roster-import-submit="text" ${disabled}>
                        <i data-lucide="${textBusy ? 'loader-2' : 'file-search'}" class="${textBusy ? 'tt-spin' : ''}"></i>
                        <span>${textBusy ? '解析中' : '解析文本'}</span>
                    </button>
                </div>
            </section>
            <section class="tt-roster-import-option tt-roster-import-option--manual" aria-labelledby="tt-roster-import-manual-title">
                <div class="tt-roster-import-option-head">
                    <span class="tt-roster-import-option-icon"><i data-lucide="table-2"></i></span>
                    <div>
                        <h4 id="tt-roster-import-manual-title">手动新增</h4>
                        <p>列好空白任课表，让用户自己手动新增</p>
                    </div>
                </div>
                <div class="tt-roster-import-option-body">
                    <div class="tt-roster-import-manual-preview" aria-hidden="true">
                        <span>年级</span>
                        <span>班级</span>
                        <span>课程</span>
                        <span>教师</span>
                        <span>周课时</span>
                        <span>连堂</span>
                    </div>
                </div>
                <div class="tt-roster-import-option-actions tt-roster-import-option-actions--full">
                    <button class="tt-btn tt-btn--primary" id="tt-start-empty-roster-review" type="button" ${disabled}>
                        <i data-lucide="plus"></i>
                        <span>打开空白表</span>
                    </button>
                </div>
            </section>
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
            <button class="tt-btn" id="tt-cancel-roster-import-secondary" type="button"><i data-lucide="x"></i><span>取消</span></button>
        </div>
    `;
}

const ROSTER_ISSUE_PREVIEW_LIMIT = 4;

function rosterIssueRow(rows = [], issue = {}) {
    const rowId = String(issue.rowId || '').trim();
    if (rowId) {
        const match = rows.find(row => String(row.id || '') === rowId);
        if (match) return match;
    }
    const sourceRow = String(issue.sourceRow || '').trim();
    if (sourceRow) {
        return rows.find(row => String(row.sourceRow || '').trim() === sourceRow) || null;
    }
    return null;
}

function rosterIssueIdentity(issue = {}) {
    return [
        String(issue.rowId || '').trim(),
        String(issue.field || '').trim(),
        String(issue.message || '').trim(),
    ].join('|');
}

function editableRosterIssues(rows = [], issues = []) {
    return (issues || []).filter(issue => {
        const rowId = String(issue?.rowId || '').trim();
        return rowId && rosterIssueRow(rows, issue);
    });
}

function rosterIssueEditorNavigation(dialog = {}, rows = [], editor = {}, issue = {}) {
    const issues = editableRosterIssues(rows, dialog.issues || []);
    if (!issues.length) {
        return { index: editor ? 0 : -1, total: editor ? 1 : 0, previous: null, next: null };
    }
    const currentKey = rosterIssueIdentity({
        ...issue,
        rowId: editor.rowId || issue.rowId,
        field: editor.field || issue.field,
    });
    let index = issues.findIndex(item => rosterIssueIdentity(item) === currentKey);
    if (index < 0) {
        index = issues.findIndex(item => (
            String(item.rowId || '').trim() === String(editor.rowId || '').trim()
            && String(item.field || '').trim() === String(editor.field || issue.field || '').trim()
        ));
    }
    if (index < 0) {
        index = issues.findIndex(item => String(item.rowId || '').trim() === String(editor.rowId || '').trim());
    }
    return {
        index,
        total: issues.length,
        previous: index > 0 ? issues[index - 1] : null,
        next: index >= 0 && index < issues.length - 1 ? issues[index + 1] : null,
    };
}

function rosterIssueSourceLabel(row, issue = {}, rowIndex = -1) {
    const sourceRow = issue.sourceRow || row?.sourceRow;
    if (sourceRow) return `第 ${sourceRow} 行`;
    if (rowIndex >= 0) return `表格第 ${rowIndex + 1} 行`;
    return '全局';
}

function rosterIssueLabel(rows = [], issue = {}, index = 0) {
    const row = rosterIssueRow(rows, issue);
    const rowIndex = row ? rows.findIndex(item => item.id === row.id) : -1;
    const parts = [
        rosterIssueSourceLabel(row, issue, rowIndex),
        row?.className || issue.className || '',
        row?.subjectName || issue.subjectName || '',
        row?.teacherName || issue.teacherName || '',
    ];
    const hours = row?.weeklyHours || issue.weeklyHours;
    if (hours && ['weeklyHours', 'blockPreference'].includes(issue.field)) {
        parts.push(`周课时 ${hours}`);
    }
    parts.push(issue.message || `问题 ${index + 1}`);
    return parts.filter(Boolean).join(' · ');
}

function renderRosterIssueItem(rows = [], issue = {}, index = 0) {
    const row = rosterIssueRow(rows, issue);
    const rowId = issue.rowId || row?.id || '';
    const field = issue.field || '';
    const icon = issue.severity === 'error' ? 'alert-triangle' : 'info';
    const className = `tt-rule-warning tt-roster-issue-item ${issue.severity === 'error' ? 'tt-rule-warning--error' : ''}`;
    const label = rosterIssueLabel(rows, issue, index);
    if (!rowId) {
        return `
            <div class="${className}">
                <i data-lucide="${icon}"></i>
                <span>${escapeHtml(label)}</span>
            </div>
        `;
    }
    return `
        <button class="${className} tt-roster-issue-edit" type="button"
            data-roster-edit-issue-row="${escapeAttr(rowId)}"
            data-roster-edit-issue-field="${escapeAttr(field)}"
            aria-label="${escapeAttr(label)}">
            <i data-lucide="${icon}"></i>
            <span>${escapeHtml(label)}</span>
        </button>
    `;
}

function rosterBlockPreferenceLabel(value) {
    if (value === 'double') return '双连堂';
    if (value === 'mixed') return '混合';
    return '单节';
}

function isOddDoubleBlockIssue(issue = {}, draft = {}) {
    const hours = Number(draft.weeklyHours ?? issue.weeklyHours);
    return (issue.field === 'blockPreference' || String(issue.message || '').includes('双连堂课时建议'))
        && draft.blockPreference === 'double'
        && Number.isInteger(hours)
        && hours > 0
        && hours % 2 !== 0;
}

function renderRosterIssueEditor(dialog = {}) {
    const editor = dialog.issueEditor;
    if (!editor) return '';
    const rows = dialog.draftRows || [];
    const issue = editor.issue || {};
    const row = rosterIssueRow(rows, { ...issue, rowId: editor.rowId }) || {};
    const draft = {
        ...row,
        ...(editor.draft || {}),
        id: editor.rowId || editor.draft?.id || row.id || '',
    };
    const rowIndex = rows.findIndex(item => String(item.id || '') === String(draft.id || ''));
    const sourceRow = issue.sourceRow || draft.sourceRow;
    const sourceLabel = sourceRow
        ? `表格第 ${sourceRow} 行`
        : rowIndex >= 0 ? `表格第 ${rowIndex + 1} 行` : '当前行';
    const context = [
        sourceLabel,
        draft.className,
        draft.subjectName,
        draft.teacherName,
    ].filter(Boolean).join(' · ');
    const issueMessage = issue.message || draft.issues?.find?.(item => item.field === editor.field)?.message || '请检查这条任课数据。';
    const currentValue = [
        `周课时 ${draft.weeklyHours || '-'}`,
        rosterBlockPreferenceLabel(draft.blockPreference),
    ].join(' · ');
    const navigation = rosterIssueEditorNavigation(dialog, rows, editor, issue);
    const progressTotal = navigation.total || 1;
    const progressIndex = navigation.index >= 0 ? navigation.index + 1 : 1;
    const hasPreviousIssue = Boolean(navigation.previous);
    const hasNextIssue = Boolean(navigation.next);
    const saveMode = hasNextIssue ? 'next' : 'close';
    const saveLabel = hasNextIssue ? '保存并下一条' : '保存修改';
    const input = (field, label, type = 'text', extraAttrs = '') => `
        <label class="tt-roster-issue-editor-field">
            <span>${escapeHtml(label)}</span>
            <input class="tt-roster-review-field" data-roster-issue-field="${escapeAttr(field)}" type="${escapeAttr(type)}" value="${escapeAttr(draft[field] ?? '')}" ${extraAttrs}>
        </label>
    `;
    return `
        <div class="tt-dialog-overlay tt-roster-issue-editor-overlay" data-roster-issue-editor-overlay>
            <section class="tt-roster-issue-editor-dialog" id="tt-roster-issue-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-roster-issue-editor-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">任课数据复核</span>
                        <h3 id="tt-roster-issue-editor-title">修正任课问题</h3>
                        <p class="tt-roster-issue-editor-context">${escapeHtml(context)}</p>
                    </div>
                    <button class="tt-icon-btn" id="tt-close-roster-issue-editor" type="button" title="关闭修正弹窗" aria-label="关闭修正弹窗"><i data-lucide="x"></i></button>
                </div>
                <div class="tt-roster-issue-editor-summary">
                    <span>${escapeHtml(issueMessage)}</span>
                    <strong>${escapeHtml(currentValue)}</strong>
                </div>
                <div class="tt-roster-issue-editor-fields">
                    ${input('grade', '年级')}
                    ${input('className', '班级')}
                    ${input('subjectName', '课程')}
                    ${input('teacherName', '教师')}
                    ${input('weeklyHours', '周课时', 'number', `aria-label="周课时" title="${escapeAttr(ROSTER_WEEKLY_HOURS_TITLE)}"`)}
                    <label class="tt-roster-issue-editor-field">
                        <span>连堂</span>
                        <select class="tt-roster-review-field" data-roster-issue-field="blockPreference" aria-label="连堂方式" title="${escapeAttr(ROSTER_BLOCK_TITLE)}">
                            <option value="single" ${draft.blockPreference === 'single' ? 'selected' : ''}>单节</option>
                            <option value="double" ${draft.blockPreference === 'double' ? 'selected' : ''}>双连堂</option>
                            <option value="mixed" ${draft.blockPreference === 'mixed' ? 'selected' : ''}>混合</option>
                        </select>
                    </label>
                    ${input('roomName', '教室')}
                </div>
                ${isOddDoubleBlockIssue(issue, draft) ? `
                    <div class="tt-roster-issue-editor-quick-fixes" aria-label="快捷修复">
                        <button class="tt-btn tt-btn--sm" type="button" data-roster-issue-quick-fix="mixed">改为混合</button>
                        <button class="tt-btn tt-btn--sm" type="button" data-roster-issue-quick-fix="single">改为单节</button>
                        <button class="tt-btn tt-btn--sm" type="button" data-roster-issue-quick-fix="nextEven">周课时改为下一个偶数</button>
                    </div>
                ` : ''}
                <div class="tt-dialog-actions tt-roster-issue-editor-actions">
                    <span class="tt-roster-issue-editor-progress" aria-live="polite">${escapeHtml(`第 ${progressIndex} / ${progressTotal} 条`)}</span>
                    <button class="tt-btn" id="tt-roster-issue-locate-original" type="button"
                        data-roster-jump-row="${escapeAttr(draft.id || '')}"
                        data-roster-jump-field="${escapeAttr(editor.field || issue.field || '')}">
                        <i data-lucide="locate-fixed"></i><span>查看原行</span>
                    </button>
                    <button class="tt-btn" id="tt-roster-issue-prev" type="button" ${hasPreviousIssue ? '' : 'disabled'}><i data-lucide="chevron-left"></i><span>上一条</span></button>
                    <button class="tt-btn" id="tt-roster-issue-next" type="button" ${hasNextIssue ? '' : 'disabled'}><span>下一条</span><i data-lucide="chevron-right"></i></button>
                    <button class="tt-btn" id="tt-cancel-roster-issue-editor" type="button"><i data-lucide="x"></i><span>取消</span></button>
                    <button class="tt-btn tt-btn--primary" id="tt-save-roster-issue-editor" data-roster-issue-save-mode="${escapeAttr(saveMode)}" type="button"><i data-lucide="check"></i><span>${escapeHtml(saveLabel)}</span></button>
                </div>
            </section>
        </div>
    `;
}

function renderRosterIssueList(dialog = {}, rows = [], issues = []) {
    if (!issues.length) return '';
    const expanded = Boolean(dialog.issueListExpanded);
    const visibleIssues = expanded ? issues : issues.slice(0, ROSTER_ISSUE_PREVIEW_LIMIT);
    const hiddenCount = Math.max(0, issues.length - visibleIssues.length);
    const summary = issues.length > ROSTER_ISSUE_PREVIEW_LIMIT
        ? (expanded ? `共 ${issues.length} 条` : `共 ${issues.length} 条，显示前 ${visibleIssues.length} 条`)
        : `共 ${issues.length} 条`;
    return `
        <section class="tt-roster-review-issues" aria-label="任课数据问题">
            <div class="tt-roster-issue-heading">
                <span>${escapeHtml(summary)}</span>
                ${issues.length > ROSTER_ISSUE_PREVIEW_LIMIT ? `
                    <button class="tt-roster-issue-toggle" type="button" data-roster-toggle-issues aria-expanded="${expanded ? 'true' : 'false'}">
                        ${escapeHtml(expanded ? '收起' : `显示全部${hiddenCount ? ` ${hiddenCount}` : ''}`)}
                    </button>
                ` : ''}
            </div>
            <div class="tt-rule-warning-list tt-roster-issue-list">
                ${visibleIssues.map((issue, index) => renderRosterIssueItem(rows, issue, index)).join('')}
            </div>
        </section>
    `;
}

const ROSTER_CATEGORY_HELP_HTML = `
    <b>普通：</b>常规课程，按普通课程安排。<br>
    <b>主科：</b>语文、数学、英语等核心课程。<br>
    <b>素质：</b>体育、音乐、美术、劳动等课程。<br>
    <b>实验：</b>需要实验室或实验安排的课程。<br>
    <em>不确定时选“普通”；核心考试科目选“主科”；实验课选“实验”。</em>
`;
const ROSTER_CATEGORY_TITLE = '普通：常规课程，按普通课程安排；主科：语文、数学、英语等核心课程；素质：体育、音乐、美术、劳动等课程；实验：需要实验室或实验安排的课程。不确定时选“普通”；核心考试科目选“主科”；实验课选“实验”。';
const ROSTER_WEEKLY_HOURS_HELP_HTML = `
    表示这个班级这门课每周要排几节。<br>
    填 5，就是每周排 5 节这门课。
`;
const ROSTER_WEEKLY_HOURS_TITLE = '表示这个班级这门课每周要排几节；填 5，就是每周排 5 节这门课。';
const ROSTER_BLOCK_HELP_HTML = `
    <b>单节：</b>每次只排 1 节课。<br>
    <b>双连堂：</b>每次连续排 2 节课，周课时建议为偶数。<br>
    <b>混合：</b>单节和连堂都可。<br>
    <em>不确定时选“混合”；明确不要连堂选“单节”；需要连续时间选“双连堂”。</em>
`;
const ROSTER_BLOCK_TITLE = '单节：每次只排 1 节课；双连堂：每次连续排 2 节课，周课时建议为偶数；混合：单节和连堂都可。不确定时选“混合”；明确不要连堂选“单节”；需要连续时间选“双连堂”。';

function renderRosterHeaderHelp(label, id, ariaLabel, contentHtml) {
    return `
        <span class="tt-roster-block-help">
            <span>${escapeHtml(label)}</span>
            <button class="tt-roster-block-help-trigger" type="button" aria-label="${escapeAttr(ariaLabel)}" aria-describedby="${escapeAttr(id)}">?</button>
            <span class="tt-roster-block-help-popover" id="${escapeAttr(id)}" role="tooltip">
                ${contentHtml}
            </span>
        </span>
    `;
}

function renderRosterReview(dialog) {
    const rows = dialog.draftRows || [];
    const issues = dialog.issues || [];
    const blocking = Boolean(dialog.hasBlockingIssues || issues.some(issue => issue.severity === 'error'));
    return `
        ${dialog.stats ? renderRosterStats(dialog.stats) : ''}
        ${renderRosterImportReport(dialog.importReport)}
        ${renderRosterIssueList(dialog, rows, issues)}
        <div class="tt-roster-review-wrap">
            <table class="tt-roster-review-table" id="tt-roster-review-table">
                <colgroup class="tt-roster-review-cols">
                    <col class="tt-roster-col-row-number">
                    <col class="tt-roster-col-grade">
                    <col class="tt-roster-col-class">
                    <col class="tt-roster-col-subject">
                    <col class="tt-roster-col-category">
                    <col class="tt-roster-col-tags">
                    <col class="tt-roster-col-teacher">
                    <col class="tt-roster-col-hours">
                    <col class="tt-roster-col-block">
                    <col class="tt-roster-col-room">
                    <col class="tt-roster-col-issue">
                    <col class="tt-roster-col-action">
                </colgroup>
                <thead>
                    <tr>
                        <th>行号</th>
                        <th>年级</th>
                        <th>班级</th>
                        <th>课程</th>
                        <th>${renderRosterHeaderHelp('类型', 'tt-roster-category-help-text', '查看类型说明', ROSTER_CATEGORY_HELP_HTML)}</th>
                        <th>标签</th>
                        <th>教师</th>
                        <th>${renderRosterHeaderHelp('周课时', 'tt-roster-weekly-hours-help-text', '查看周课时说明', ROSTER_WEEKLY_HOURS_HELP_HTML)}</th>
                        <th>${renderRosterHeaderHelp('连堂', 'tt-roster-block-help-text', '查看连堂说明', ROSTER_BLOCK_HELP_HTML)}</th>
                        <th>教室</th>
                        <th>问题</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((row, index) => renderRosterReviewRow(row, index)).join('')}
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
    const visibleEntries = entries.filter(item => item.category !== 'kept').slice(0, 4);
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

function renderRosterReviewRow(row, index = 0) {
    const issues = row.issues || [];
    const hasError = issues.some(issue => issue.severity === 'error');
    const issueText = issues.map(issue => issue.message).join('；') || '无';
    const rowNumber = row.sourceRow || index + 1;
    const rowNumberTitle = row.sourceRow ? `源表第 ${row.sourceRow} 行` : `当前第 ${index + 1} 行`;
    const input = (field, value, type = 'text', extraAttrs = '') => `
        <input class="tt-roster-review-field" data-roster-field="${escapeAttr(field)}" type="${escapeAttr(type)}" value="${escapeAttr(value ?? '')}" ${extraAttrs}>
    `;
    return `
        <tr class="tt-roster-review-row ${hasError ? 'tt-roster-review-row--error' : ''}"
            data-roster-review-row="${escapeAttr(row.id)}"
            data-roster-source-row="${escapeAttr(row.sourceRow || '')}"
            data-roster-source-sheet="${escapeAttr(row.sourceSheet || '')}">
            <td data-label="行号"><span class="tt-roster-review-row-number" title="${escapeAttr(rowNumberTitle)}">${escapeHtml(rowNumber)}</span></td>
            <td data-label="年级">${input('grade', row.grade)}</td>
            <td data-label="班级">${input('className', row.className)}</td>
            <td data-label="课程">${input('subjectName', row.subjectName)}</td>
            <td data-label="类型">
                <select class="tt-roster-review-field" data-roster-field="subjectCategory" aria-label="课程类型" title="${escapeAttr(ROSTER_CATEGORY_TITLE)}">
                    <option value="normal" ${row.subjectCategory === 'normal' ? 'selected' : ''}>普通</option>
                    <option value="main" ${row.subjectCategory === 'main' ? 'selected' : ''}>主科</option>
                    <option value="quality" ${row.subjectCategory === 'quality' ? 'selected' : ''}>素质</option>
                    <option value="lab" ${row.subjectCategory === 'lab' ? 'selected' : ''}>实验</option>
                </select>
            </td>
            <td data-label="标签">${input('subjectTags', Array.isArray(row.subjectTags) ? row.subjectTags.join('、') : row.subjectTags)}</td>
            <td data-label="教师">${input('teacherName', row.teacherName)}</td>
            <td data-label="周课时">${input('weeklyHours', row.weeklyHours, 'number', `aria-label="周课时" title="${escapeAttr(ROSTER_WEEKLY_HOURS_TITLE)}"`)}</td>
            <td data-label="连堂">
                <select class="tt-roster-review-field" data-roster-field="blockPreference" aria-label="连堂方式" title="${escapeAttr(ROSTER_BLOCK_TITLE)}">
                    <option value="single" ${row.blockPreference === 'single' ? 'selected' : ''}>单节</option>
                    <option value="double" ${row.blockPreference === 'double' ? 'selected' : ''}>双连堂</option>
                    <option value="mixed" ${row.blockPreference === 'mixed' ? 'selected' : ''}>混合</option>
                </select>
            </td>
            <td data-label="教室">${input('roomName', row.roomName)}</td>
            <td data-label="问题"><span class="tt-roster-review-issue" title="${escapeAttr(issueText)}">${escapeHtml(issueText)}</span></td>
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

function renderDutyTeacherOption(option = {}, index = 0, saving = false) {
    const classes = [
        'tt-duty-teacher-option',
        option.selected ? 'is-selected' : '',
        option.recommended ? 'is-recommended' : '',
        option.disabled ? 'is-disabled' : '',
    ].filter(Boolean).join(' ');
    const badges = [
        option.selected ? '<span>已选</span>' : '',
        option.recommended ? '<span>本班任课</span>' : '',
        option.conflictReason ? `<span class="is-warning">${escapeHtml(option.conflictReason)}</span>` : '',
    ].filter(Boolean).join('');
    const disabled = saving || option.disabled;
    return `
        <button
            class="${classes}"
            id="tt-duty-teacher-option-${escapeAttr(index)}"
            type="button"
            role="option"
            data-action="select-duty-teacher"
            data-duty-teacher-option="${escapeAttr(option.id)}"
            data-duty-teacher-label="${escapeAttr(option.label)}"
            data-duty-teacher-search-text="${escapeAttr(option.searchText)}"
            aria-selected="${option.selected ? 'true' : 'false'}"
            ${disabled ? 'disabled' : ''}
        >
            <span class="tt-duty-teacher-option-main">
                <strong>${escapeHtml(option.label)}</strong>
                ${option.meta ? `<small>${escapeHtml(option.meta)}</small>` : ''}
            </span>
            ${badges ? `<span class="tt-duty-teacher-option-badges">${badges}</span>` : ''}
        </button>
    `;
}

function renderDutyTeacherPicker(project = {}, context = {}, saving = false) {
    const model = buildDutyTeacherSearchModel(project, context);
    const selectedLabel = model.selectedTeacher?.label || '未安排';
    return `
        <div class="tt-duty-teacher-picker" data-duty-teacher-picker>
            <div class="tt-duty-teacher-search-row">
                <i data-lucide="search"></i>
                <input
                    id="tt-duty-teacher-search"
                    type="search"
                    data-duty-teacher-search
                    class="tt-duty-teacher-search"
                    placeholder="搜索老师姓名、拼音或学科"
                    autocomplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-controls="tt-duty-teacher-list"
                    ${saving ? 'disabled' : ''}
                >
            </div>
            <input id="tt-duty-assignment-teacher" type="hidden" value="${escapeAttr(context.teacherId || '')}">
            <div class="tt-duty-teacher-current" data-duty-teacher-current>
                <span>当前</span>
                <strong>${escapeHtml(selectedLabel)}</strong>
            </div>
            <div class="tt-duty-teacher-list" id="tt-duty-teacher-list" role="listbox" data-duty-teacher-list aria-label="值班老师候选">
                ${model.visibleOptions.map((option, index) => renderDutyTeacherOption(option, index, saving)).join('')}
                <div class="tt-duty-teacher-empty" data-duty-teacher-empty-message hidden>没有匹配的老师</div>
            </div>
        </div>
    `;
}

function renderDutyAssignmentDialog(state) {
    const dialog = state.dutyDialog || {};
    if (!dialog.open) return '';
    const project = state.project || {};
    const day = Number(dialog.day);
    const timeBlockId = dialog.timeBlockId || '';
    const segment = (project.periodTimeSegments?.segments || []).find(item => item.id === timeBlockId) || {};
    const classId = dialog.classId || project.classes?.[0]?.id || '';
    const classLocked = Boolean(dialog.classLocked && classId);
    const selectedClass = (project.classes || []).find(klass => klass.id === classId);
    const classLabel = ownerLabel(selectedClass || { id: classId });
    const existing = (project.dutyAssignments || []).find(item => (
        Number(item.day) === day
        && item.classId === classId
        && item.timeBlockId === timeBlockId
        && item.status !== 'paused'
    ));
    const teacherId = dialog.teacherId || existing?.teacherId || '';
    const timeLabel = studyBlockTimeLabel(project, segment);
    const segmentLabel = segment.label || timeBlockId || '附加时段';
    const saving = Boolean(dialog.saving);
    const classOptions = (project.classes || []).map(klass => `
        <option value="${escapeAttr(klass.id)}" ${klass.id === classId ? 'selected' : ''}>${escapeHtml(ownerLabel(klass))}</option>
    `).join('');
    const classField = classLocked ? '' : `
                    <label class="tt-duty-field">
                        <span>班级</span>
                        <select id="tt-duty-assignment-class" class="tt-roster-review-field" ${saving ? 'disabled' : ''}>
                            ${classOptions}
                        </select>
                    </label>
        `;
    const contextItems = [
        classLocked ? `
                    <div class="tt-duty-context-item" data-duty-assignment-class-readonly>
                        <span>班级</span>
                        <strong>${escapeHtml(classLabel || '当前班级')}</strong>
                    </div>
        ` : '',
        `
                    <div class="tt-duty-context-item">
                        <span>时段</span>
                        <strong>周${dayName(day)} · ${escapeHtml(segmentLabel)}</strong>
                        ${timeLabel ? `<small>${escapeHtml(timeLabel)}</small>` : ''}
                    </div>
        `,
    ].filter(Boolean).join('');
    const teacherPicker = renderDutyTeacherPicker(project, {
        day,
        classId,
        timeBlockId,
        teacherId,
    }, saving);

    return `
        <div class="tt-dialog-overlay" data-duty-assignment-overlay>
            <section class="tt-duty-assignment-dialog" id="tt-duty-assignment-dialog" role="dialog" aria-modal="true" aria-labelledby="tt-duty-assignment-title">
                <div class="tt-dialog-header">
                    <div>
                        <span class="tt-eyebrow">值班安排</span>
                        <h3 id="tt-duty-assignment-title">编辑值班老师</h3>
                    </div>
                    <button class="tt-icon-btn" type="button" data-action="close-duty-assignment" title="关闭" aria-label="关闭值班老师编辑"><i data-lucide="x"></i></button>
                </div>
                <div class="tt-duty-assignment-form">
                    <div class="tt-duty-context-grid">
                        ${contextItems}
                    </div>
                    ${classField}
                    <div class="tt-duty-field">
                        <span>值班老师</span>
                        ${teacherPicker}
                    </div>
                    ${dialog.error ? `<div class="tt-duty-error" role="alert">${escapeHtml(dialog.error)}</div>` : ''}
                </div>
                <div class="tt-dialog-actions tt-duty-actions">
                    <button class="tt-btn tt-btn--ghost" id="tt-clear-duty-assignment" type="button" data-action="clear-duty-assignment" ${saving ? 'disabled' : ''}><i data-lucide="eraser"></i><span>清除值班</span></button>
                    <div class="tt-duty-actions-main">
                        <button class="tt-btn tt-btn--ghost" type="button" data-action="close-duty-assignment" ${saving ? 'disabled' : ''}><i data-lucide="x"></i><span>取消</span></button>
                        <button class="tt-btn tt-btn--primary" id="tt-save-duty-assignment" type="button" data-action="save-duty-assignment" ${saving ? 'disabled' : ''}><i data-lucide="${saving ? 'loader-2' : 'save'}" class="${saving ? 'tt-spin' : ''}"></i><span>${saving ? '保存中' : '保存值班'}</span></button>
                    </div>
                </div>
            </section>
        </div>
    `;
}

function summarizeTimeBlockKinds(project = {}) {
    const summary = summarizeRangeTimeBlocks(project);
    return [summary.formalSummaryLabel, summary.additionalSegmentLabel].filter(Boolean).join(' · ');
}

function summarizeFormalTimeSegments(project = {}) {
    const summary = summarizeFormalTimeSegmentParts(project);
    return [summary.totalLabel, summary.segmentLabel].filter(Boolean).join(' · ');
}

function compactTimeSegmentLabel(label = '', fallback = '正式节次') {
    const text = String(label || fallback).trim();
    return text.replace(/时段$/, '').trim() || fallback;
}

function baseAdditionalSegmentLabel(label = '') {
    return compactTimeSegmentLabel(label || '', '附加时段').replace(/\d+$/, '').trim() || '附加时段';
}

function summarizeFormalTimeSegmentParts(project = {}, fallbackPeriods = []) {
    const segments = Array.isArray(project.periodTimeSegments?.segments) ? project.periodTimeSegments.segments : [];
    const formalSegments = segments
        .map(segment => ({
            label: compactTimeSegmentLabel(segment.label || '', '正式节次'),
            kind: periodSetupKind(segment),
            count: Math.max(0, Number.parseInt(segment.periodCount, 10) || 0),
        }))
        .filter(segment => segment.kind === 'teaching' && segment.count > 0);
    if (!formalSegments.length) {
        const total = Array.isArray(fallbackPeriods) ? fallbackPeriods.length : 0;
        return {
            total,
            totalLabel: total ? `${total}节` : '',
            segmentLabel: '',
        };
    }
    const total = formalSegments.reduce((sum, segment) => sum + segment.count, 0);
    const parts = formalSegments.map(segment => `${segment.label}${segment.count}`);
    return {
        total,
        totalLabel: `${total}节`,
        segmentLabel: parts.join(' · '),
    };
}

function summarizeAdditionalTimeSegmentParts(project = {}) {
    const segments = expandPeriodTimeSegments(project.periodTimeSegments || {});
    const additionalGroups = new Map();
    segments.forEach((segment, index) => {
        const kind = periodSetupKind(segment);
        const count = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
        if (kind === 'teaching' || count <= 0) return;
        const key = String(segment.id || `${segment.label || 'additional'}-${index}`).replace(/__p\d+$/, '');
        const label = baseAdditionalSegmentLabel(segment.label || '附加时段');
        const current = additionalGroups.get(key) || { label, count: 0 };
        current.count += count;
        additionalGroups.set(key, current);
    });
    const parts = [...additionalGroups.values()].map(item => `${item.label}${item.count}`);
    const total = [...additionalGroups.values()].reduce((sum, item) => sum + item.count, 0);
    return {
        total,
        totalLabel: total ? `附加${total}段` : '',
        segmentLabel: parts.join(' · '),
    };
}

function summarizeRangeTimeBlocks(project = {}, fallbackPeriods = []) {
    const formal = summarizeFormalTimeSegmentParts(project, fallbackPeriods);
    const additional = summarizeAdditionalTimeSegmentParts(project);
    const totalParts = [];
    if (formal.totalLabel) totalParts.push(formal.totalLabel);
    if (additional.totalLabel) totalParts.push(additional.totalLabel);
    return {
        formalTotal: formal.total,
        additionalTotal: additional.total,
        formalTotalLabel: formal.totalLabel,
        additionalTotalLabel: additional.totalLabel,
        totalLabel: totalParts.join(' · '),
        formalSegmentLabel: formal.segmentLabel,
        additionalSegmentLabel: additional.segmentLabel,
        formalSummaryLabel: [formal.totalLabel, formal.segmentLabel].filter(Boolean).join(' · '),
    };
}

function summarizeFullPeriodTimeRange(project = {}, periodTimes = project.periodTimes || []) {
    const activePeriods = getActivePeriods(project);
    const intervals = completeProjectPeriodTimes(project, periodTimes)
        .filter(item => activePeriods.includes(Number(item.period)) && item.start && item.end)
        .map(item => ({ start: item.start, end: item.end }));
    const segments = expandPeriodTimeSegments(project.periodTimeSegments || {});
    const projectForPreview = { periodTimeSegments: project.periodTimeSegments || {} };
    segments.forEach(segment => {
        if (periodSetupKind(segment) === 'teaching') return;
        const timeLabel = studyBlockTimeLabel(projectForPreview, segment);
        const [start = '', end = ''] = timeLabel ? timeLabel.split('-') : [];
        if (start && end) intervals.push({ start, end });
    });
    const normalized = intervals
        .map(interval => ({
            start: interval.start,
            end: interval.end,
            startMinutes: timeToMinutes(interval.start),
            endMinutes: timeToMinutes(interval.end),
        }))
        .filter(interval => interval.startMinutes !== null && interval.endMinutes !== null);
    if (!normalized.length) return { configured: false, rangeLabel: '' };
    const first = normalized.reduce((min, item) => (item.startMinutes < min.startMinutes ? item : min), normalized[0]);
    const last = normalized.reduce((max, item) => (item.endMinutes > max.endMinutes ? item : max), normalized[0]);
    return {
        configured: true,
        rangeLabel: `${first.start}-${last.end}`,
    };
}

function timeBlockKindLabel(kind = 'teaching') {
    if (kind === 'teaching') return '正式节次';
    return '附加时段';
}

function smartHelperSidebarChip(state = {}, savedTotal = 0) {
    const review = state.ruleReview || {};
    const draftCount = (review.draftRows || []).length || (state.pendingRules || []).length;
    const requirements = buildUnifiedRequirementItems(review);
    const semanticCount = Math.max(
        getActionableRequirementCount(review, 'all'),
        requirements.length
    );
    if (draftCount) return `${draftCount} 条`;
    if (semanticCount) return `${semanticCount} 项`;
    if (savedTotal) return `${savedTotal} 条`;
    return '待处理';
}

function normalizeTimetableUiKey(value = '') {
    return String(value || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function requirementHasComplexSignal(item = {}) {
    const applyTo = normalizeTimetableUiKey(item.applyTo || '');
    const params = item.parameters || {};
    const support = item.modelSupport || {};
    const actions = item.semanticActions || [];
    if (applyTo === 'model_extension' || applyTo === 'complex_model') return true;
    if (support.requiredModel || support.capability) return true;
    if (params.weekPattern || params.campusId || params.roomId || params.roomRequirement || params.teachingGroupId) return true;
    return actions.some(action => normalizeTimetableUiKey(action.kind || action.type || '') === 'complex_model_patch');
}

function projectHasComplexSignals(project = {}) {
    if (project.timetableModelVersion === 'complex_v1' || project.complexModelEnabled === true) return true;
    const hasPattern = item => ['odd', 'even', 'odd_even'].includes(item?.weekPattern);
    if ((project.lessonPlans || []).some(item => hasPattern(item) || item.campusId || item.roomId || item.roomRequirement || item.teachingGroupId)) return true;
    if ((project.schedule?.slots || []).some(item => hasPattern(item) || item.campusId || item.roomId || item.roomRequirement || item.teachingGroupId)) return true;
    if ((project.campuses || []).length || (project.rooms || []).length || (project.teachingGroups || []).length) return true;
    return Boolean(project.commuteRules && Object.keys(project.commuteRules).length);
}

function smartHelperStats(state = {}, savedCount = 0, draftCount = 0, warningCount = 0) {
    const review = state.ruleReview || {};
    const requirements = buildUnifiedRequirementItems(review);
    const reviewCount = requirements.filter(item => getRequirementGroupKey(item) === 'review').length;
    const handledCount = requirements.filter(item => getRequirementGroupKey(item) === 'handled').length;
    return {
        actionableCount: getActionableRequirementCount(review, 'all'),
        reviewCount,
        handledCount,
        complexCount: requirements.filter(requirementHasComplexSignal).length,
        savedCount,
        draftCount,
        warningCount,
        publicationOk: Boolean(state.project?.schedule?.publication?.ok),
        hasSchedule: Boolean(state.project?.schedule?.slots?.length),
        complexProject: projectHasComplexSignals(state.project || {}),
    };
}

function renderSmartHelperFlow(stats = {}) {
    const steps = ['理解需求', '补充信息', '生成规则', '发布校验'];
    const activeIndex = stats.publicationOk ? 3 : stats.hasSchedule ? 3 : stats.actionableCount || stats.savedCount ? 2 : stats.reviewCount || stats.warningCount ? 1 : 0;
    return `
        <div class="tt-smart-helper-flow" aria-label="智能约束助手流程">
            ${steps.map((label, index) => `
                <span class="${index <= activeIndex ? 'is-active' : ''}">
                    <b>${escapeHtml(label)}</b>
                </span>
            `).join('')}
        </div>
    `;
}

function renderSmartHelperMetrics(stats = {}) {
    const reviewCount = stats.warningCount || stats.reviewCount || 0;
    const handledCount = stats.handledCount || stats.savedCount || 0;
    const metrics = [
        ['可应用', stats.actionableCount || 0, ''],
        ['需复核', reviewCount, reviewCount ? 'is-warning' : ''],
        ['已处理', handledCount, ''],
    ];
    return `
        <div class="tt-smart-helper-metrics" aria-label="智能约束助手状态">
            ${metrics.map(([label, value, className]) => `
                <span class="${escapeAttr(className)}">
                    <b>${escapeHtml(label)}</b>
                    <strong>${escapeHtml(value)}</strong>
                    <em>项</em>
                </span>
            `).join('')}
        </div>
    `;
}

function renderConstraintAgentMessage(message = {}, index = 0) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    return `
        <div class="tt-constraint-agent-message tt-constraint-agent-message--${escapeAttr(role)}" data-agent-message-index="${escapeAttr(index)}">
            <span>${escapeHtml(role === 'user' ? '你' : '助手')}</span>
            <p>${escapeHtml(message.content || '')}</p>
        </div>
    `;
}

function renderConstraintAgentMiniCard({ title = '', subtitle = '', applyItemKey = '', excluded = false } = {}) {
    return `
        <div class="tt-constraint-agent-mini-card ${excluded ? 'is-excluded' : ''}" data-apply-item-key="${escapeAttr(applyItemKey)}">
            <div>
                <strong>${escapeHtml(title || '排课需求')}</strong>
                <span>${escapeHtml(subtitle || (excluded ? '已暂停应用' : '将随确认一起应用'))}</span>
            </div>
            <button class="tt-btn tt-btn--sm tt-btn--ghost" data-action="toggle-constraint-apply-item" data-apply-item-key="${escapeAttr(applyItemKey)}" type="button">
                <i data-lucide="${excluded ? 'rotate-ccw' : 'pause-circle'}"></i>
                <span>${escapeHtml(excluded ? '恢复' : '暂停')}</span>
            </button>
        </div>
    `;
}

function renderConstraintAgentMiniCards(state = {}) {
    const review = state.ruleReview || {};
    const rows = (review.draftRows || []).slice(0, 4).map(row => {
        const key = draftRowApplyItemKey(row);
        return renderConstraintAgentMiniCard({
            title: row.understanding || row.description || row.rawText || ruleTypeLabel(row.type || row.intent || 'rule'),
            subtitle: `${ruleTypeLabel(row.type || row.intent || 'rule')} · ${row.priority === 'hard' || row.strength === 'hard' ? '硬约束' : '软约束'}`,
            applyItemKey: key,
            excluded: isApplyItemExcluded(review, key),
        });
    });
    const actions = (review.semanticActions || []).slice(0, Math.max(0, 4 - rows.length)).map(action => {
        const key = semanticActionApplyItemKey(action);
        return renderConstraintAgentMiniCard({
            title: action.title || action.description || action.target?.name || action.targetName || '模型动作',
            subtitle: action.kind || action.type || 'semantic_action',
            applyItemKey: key,
            excluded: isApplyItemExcluded(review, key),
        });
    });
    const cards = [...rows, ...actions];
    if (!cards.length) return '';
    return `
        <div class="tt-constraint-agent-mini-cards" aria-label="对话排课需求卡">
            ${cards.join('')}
        </div>
    `;
}

function renderConstraintAgentPanel(state = {}) {
    const agent = state.constraintAgent || {};
    const messages = (agent.messages || []).slice(-4);
    const loading = Boolean(agent.loading);
    const stage = agent.stage || 'INTAKE';
    const canConfirm = stage === 'CONFIRM' && (agent.confirmationToken || agent.highRiskToken) && !(agent.confirmed || agent.highRiskConfirmed);
    const canApply = stage === 'CONFIRM' && (agent.confirmed || agent.highRiskConfirmed);
    const canSolve = stage === 'APPLY';
    const statusLine = agent.statusLine || '[已理解 0 · 待澄清 0 · 待确认 0]';
    return `
        <section class="tt-constraint-agent-panel" data-constraint-agent-stage="${escapeAttr(stage)}">
            <div class="tt-constraint-agent-header">
                <div>
                    <strong><i data-lucide="messages-square"></i><span>对话排课</span></strong>
                    <em>${escapeHtml(statusLine)}</em>
                </div>
                <button class="tt-icon-btn tt-icon-btn--sm" data-action="constraint-agent-start" type="button" title="新建对话排课会话" aria-label="新建对话排课会话">
                    <i data-lucide="refresh-cw"></i>
                </button>
            </div>
            ${messages.length ? `
                <div class="tt-constraint-agent-thread" aria-live="polite">
                    ${messages.map(renderConstraintAgentMessage).join('')}
                </div>
            ` : ''}
            ${renderConstraintAgentMiniCards(state)}
            ${agent.error ? `<p class="tt-constraint-agent-error">${escapeHtml(agent.error)}</p>` : ''}
            <label class="tt-constraint-agent-input">
                <span>排课要求</span>
                <textarea id="tt-constraint-agent-message" rows="3" ${loading ? 'disabled' : ''} placeholder="例如：张老师周三下午不排，数学尽量上午，确认后直接生成课表">${escapeHtml(agent.input || '')}</textarea>
            </label>
            <div class="tt-constraint-agent-actions">
                <button class="tt-btn tt-btn--primary" data-action="constraint-agent-send" type="button" ${loading ? 'disabled' : ''}>
                    <i data-lucide="${loading ? 'loader-2' : 'send'}" ${loading ? 'class="tt-spin"' : ''}></i><span>发送</span>
                </button>
                <button class="tt-btn" data-action="constraint-agent-confirm" type="button" ${!canConfirm || loading ? 'disabled' : ''}>
                    <i data-lucide="check-circle-2"></i><span>确认</span>
                </button>
                <button class="tt-btn" data-action="constraint-agent-apply" type="button" ${!canApply || loading ? 'disabled' : ''}>
                    <i data-lucide="file-check-2"></i><span>应用</span>
                </button>
                <button class="tt-btn" data-action="constraint-agent-solve" type="button" ${!canSolve || loading ? 'disabled' : ''}>
                    <i data-lucide="play"></i><span>求解</span>
                </button>
            </div>
        </section>
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
    const helperStats = smartHelperStats(state, savedCount, draftCount, warningCount);
    const cardTitle = '智能约束助手';
    const cardDescription = draftCount
        ? `${draftCount} 条要求待处理${warningCount ? ` / ${warningCount} 条需注意` : ''}，继续完成理解、复核和落地。`
        : savedCount
            ? `已有 ${savedCount} 条要求应用，可继续检查、调整并生成课表。`
            : '自然语言需求理解、复核与落地。';

    return `
        <div class="tt-rule-stack tt-rules-setup-card" data-workflow-step="rules">
            <div class="tt-rules-setup-body">
                <button class="tt-empty-card tt-roster-entry tt-rule-entry tt-smart-helper-entry" id="tt-open-rule-review" type="button" data-action="open-constraint-dialog">
                    <i data-lucide="brain-circuit"></i>
                    <strong>${escapeHtml(cardTitle)}</strong>
                    <span class="tt-smart-helper-entry-subtitle">自然语言需求理解、复核与落地</span>
                    <span class="tt-smart-helper-entry-status">${escapeHtml(cardDescription)}</span>
                </button>
                ${renderConstraintAgentPanel(state)}
                ${renderSmartHelperFlow(helperStats)}
                ${renderSmartHelperMetrics(helperStats)}
                ${(savedCount || draftCount || warningCount) ? `
                    <div class="tt-action-row tt-action-row--compact">
                        <button class="tt-btn" id="tt-reparse-rule-review" type="button"><i data-lucide="upload"></i><span>重新解析</span></button>
                        <button class="tt-btn tt-btn--danger" id="tt-clear-rules" type="button"><i data-lucide="trash-2"></i><span>清空约束</span></button>
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
            ? '查看已应用约束'
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
// 主入口已切换到 constraint dialog；以下共享函数保留给规则复核和诊断视图使用。

function renderPublishDialog(state) {
    const dialog = state.publishDialog || {};
    if (!dialog.open) return '';
    const schedule = state.project?.schedule || {};
    const publication = schedule.publication || {};
    const summary = publication.summary || schedule.score || {};
    const isBusy = Boolean(dialog.loading);
    const reviewEntries = publishReviewEntries(publication, state);
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

function publishReviewEntries(publication = {}, state = {}, limit = 5) {
    const entries = [];
    const seen = new Set();
    const issueSource = publicationIssueEntriesForView(publication, state);
    const add = item => {
        if (!item || item.type === 'quality_review' || !isActionableTimetableReviewItem(item, state)) return;
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

function publicationIssueEntriesForView(publication = null, state = {}) {
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
        if (!isActionableTimetableReviewItem(item, state)) return false;
        const slot = inspectorSlotLabel(item.slot);
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

// 以下共享函数保留，供规则复核辅助视图使用：
// - renderRuleCardList
// - renderRuleReviewCard
// - renderAutoAcceptableRules
// - renderNeedReviewRules
// - renderRuleConflictSection
// - renderUnsupportedRuleItems

// 保留共享函数供规则复核辅助视图使用

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
    const scaleMessage = solveScaleMessage(project, state.solveScaleHint);
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

function solveScaleMessage(project, hint = null) {
    if (hint?.message) return hint.message;
    const classCount = (project?.classes || []).length;
    if (classCount >= 30) return `${classCount} 个班，预计需要数分钟；当前 Timefold 超时上限 300 秒。`;
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
        const slot = inspectorSlotLabel(item.slot);
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

function inspectorSlotLabel(slot = '') {
    if (slot === null || slot === undefined || slot === '') return '';
    if (typeof slot === 'string' || typeof slot === 'number') return String(slot);
    if (typeof slot === 'object') {
        const day = slot.day ?? slot.weekday ?? slot.dayIndex;
        const period = slot.period ?? slot.periodIndex;
        if (day !== null && day !== undefined && day !== '' && period !== null && period !== undefined && period !== '') {
            return `${day}-${period}`;
        }
        if (slot.label) return String(slot.label);
        if (slot.name) return String(slot.name);
    }
    return '';
}

function comparableText(value = '') {
    return String(value || '').trim().replace(/\s+/g, '');
}

function parseInspectorSlotParts(slot = '') {
    const label = inspectorSlotLabel(slot);
    const match = String(label || '').match(/^(\d+)\s*[-/]\s*(\d+)$/);
    if (!match) return { day: null, period: null };
    const day = Number.parseInt(match[1], 10);
    const period = Number.parseInt(match[2], 10);
    return Number.isInteger(day) && day > 0 && Number.isInteger(period) && period > 0
        ? { day, period }
        : { day: null, period: null };
}

function findClassByLocateName(project = {}, targetName = '') {
    const needle = comparableText(targetName);
    if (!needle) return null;
    return (project.classes || []).find(item => {
        const labels = [
            item.id,
            item.name,
            ownerLabel(item),
            item.grade && item.name ? `${item.grade} ${item.name}` : '',
        ];
        return labels.some(label => comparableText(label) === needle);
    }) || null;
}

function findTeacherByLocateName(project = {}, targetName = '') {
    const needle = comparableText(targetName);
    if (!needle) return null;
    return (project.teachers || []).find(item => (
        comparableText(item.id) === needle || comparableText(item.name) === needle
    )) || null;
}

export function resolveInspectorIssueLocateTarget(project = {}, item = {}) {
    const targetKind = String(item.targetKind || item.inspectorTargetKind || '').trim();
    const targetId = String(item.targetId || item.inspectorTargetId || '').trim();
    const targetName = String(item.targetName || item.inspectorTargetName || '').trim();
    const slotParts = parseInspectorSlotParts(item.slot || item.inspectorSlot || {
        day: item.day || item.inspectorDay,
        period: item.period || item.inspectorPeriod,
    });
    const maps = entityMaps(project);

    if (targetKind === 'class') {
        const klass = maps.classes.get(targetId) || findClassByLocateName(project, targetName);
        if (!klass?.id) return null;
        const label = ownerLabel(klass);
        return {
            viewMode: 'class',
            ownerId: klass.id,
            targetKind: 'class',
            targetId: klass.id,
            targetName: label,
            label,
            day: slotParts.day,
            period: slotParts.period,
        };
    }

    if (targetKind === 'teacher') {
        const teacher = maps.teachers.get(targetId) || findTeacherByLocateName(project, targetName);
        if (!teacher?.id) return null;
        const label = teacher.name || teacher.id;
        return {
            viewMode: 'teacher',
            ownerId: teacher.id,
            targetKind: 'teacher',
            targetId: teacher.id,
            targetName: label,
            label,
            day: slotParts.day,
            period: slotParts.period,
        };
    }

    if (targetKind === 'plan') {
        const plan = maps.plans.get(targetId);
        const klass = plan?.classId ? maps.classes.get(plan.classId) : null;
        if (!plan?.id || !klass?.id) return null;
        const label = ownerLabel(klass);
        return {
            viewMode: 'class',
            ownerId: klass.id,
            targetKind: 'plan',
            targetId: plan.id,
            targetName: label,
            label,
            planId: plan.id,
            day: slotParts.day,
            period: slotParts.period,
        };
    }

    if (slotParts.day && slotParts.period) {
        return {
            viewMode: 'master',
            ownerId: 'master',
            targetKind: targetKind || 'schedule',
            targetId: targetId || 'master',
            targetName: targetName || `第${slotParts.period}节`,
            label: `周${dayName(slotParts.day)} 第${slotParts.period}节`,
            day: slotParts.day,
            period: slotParts.period,
        };
    }

    return null;
}

function inspectorIssueMeta(entry = {}) {
    const parts = [];
    const kindLabel = inspectorIssueTargetKindLabel(entry.targetKind);
    if (kindLabel && entry.targetName && entry.targetKind !== 'schedule' && entry.targetName !== entry.title) {
        parts.push(`${kindLabel} · ${entry.targetName}`);
    } else if (!kindLabel && entry.targetName && entry.targetName !== entry.title && entry.targetName !== '课表') {
        parts.push(entry.targetName);
    }
    const slotLabel = inspectorSlotLabel(entry.slot);
    if (slotLabel) parts.push(`课节 ${slotLabel}`);
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

function renderInspectorIssueGroups({ title, entries, panel = 'diagnostic', sectionKey = '', state = {} }) {
    if (!entries.length) return '';
    const summary = summarizeInspectorIssueEntries(entries);
    const chipTone = summary.error || summary.warning ? 'tt-chip--warn' : 'tt-chip--ok';
    const normalizedEntries = entries.map(item => ({ ...item, source: item.source || panel }));
    const grouped = groupInspectorIssuesByProblem(normalizedEntries);
    return `
        <div class="tt-inspector-issues">
            <div class="tt-subsection-title">
                <h4><i data-lucide="list-tree"></i><span>${escapeHtml(title)}</span></h4>
                <span class="tt-chip ${chipTone}">${escapeHtml(entries.length)} 条</span>
            </div>
            <div class="tt-inspector-issue-groups">
                ${grouped.map(group => renderInspectorProblemGroup(group, state, sectionKey || `system-${panel}`)).join('')}
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
            filter: item => item.type !== 'quality_review' && isActionableTimetableReviewItem(item, state),
            labelOf: publicationIssueLabel,
            titleOf: publicationItemTitle,
        });
    }
    return normalizeInspectorIssueEntries(publicationIssueEntriesForView(publication, state), {
        fallbackSeverity: 'warning',
        filter: item => item.type !== 'quality_review' && isActionableTimetableReviewItem(item, state),
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
        slot: inspectorSlotLabel(item.slot),
    };
}

function normalizeScheduleDiagnosticIssues(state) {
    const diagnosticsItems = state.project?.schedule?.diagnostics?.items || state.lastFailure?.diagnostics?.items || [];
    const scheduleDiagnostics = diagnosticsItems.filter(item => item.category !== 'publication');
    if (scheduleDiagnostics.length) {
        return normalizeInspectorIssueEntries(scheduleDiagnostics, {
            fallbackSeverity: 'warning',
            filter: item => isActionableTimetableReviewItem(item, state),
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
        filter: item => isActionableTimetableReviewItem(item, state),
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

function publicationStatusInspectorItem(project = {}) {
    if (archiveOnlyDraftState(project)) {
        return {
            id: 'publication-archive-only',
            source: 'publication',
            severity: 'warning',
            type: 'published_archive',
            title: '发布归档',
            message: '当前工作草稿已清空，仍可恢复或导出已发布版本。',
            targetKind: 'schedule',
        };
    }
    if (!publishedDraftChanged(project)) return null;
    const diff = getPublishedScheduleDiff(project);
    const diffText = diff.total
        ? `发布差异：移动 ${diff.moved || 0} · 新增 ${diff.added || 0} · 移除 ${diff.removed || 0}。`
        : '发布差异：当前草稿已变化。';
    return {
        id: 'publication-draft-changed',
        source: 'publication',
        severity: 'warning',
        type: 'publication_draft_changed',
        title: '发布差异',
        message: `${diffText}请重新发布后导出正式课表。`,
        targetKind: 'schedule',
    };
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

function optimizationScheduleSourceLabel(schedule = {}, persistedStats = null) {
    const restoredPublishedDraft = schedule?.source === 'published_history_restored'
        || persistedStats?.phase === 'published_history_restore'
        || Boolean(persistedStats?.restoredPublishedDraft);
    if (restoredPublishedDraft) return '恢复发布版';
    if (schedule?.source === 'fast_constructed') return '快速课表';
    if (schedule?.source === 'timefold_solver') return 'Timefold';
    if (schedule?.source === 'manual_adjusted') return '手动调整';
    if (schedule?.source === 'published' || schedule?.source === 'published_snapshot' || schedule?.source === 'published_history_snapshot') return '已发布';
    return '未生成';
}

function optimizationDetailForSummary(state = {}) {
    const job = state.solverJob || null;
    const schedule = state.project?.schedule || null;
    const persistedStats = schedule?.solverStats || null;
    if (schedule?.published?.status === 'published' && !job) return null;
    const detail = job || persistedStats;
    if (!detail && schedule?.source !== 'fast_constructed') return null;
    if (!job && schedule?.source !== 'fast_constructed' && persistedStats?.phase !== 'timefold_optimization') return null;
    const label = optimizationStatusLabel(detail);
    return {
        detail,
        sourceText: optimizationScheduleSourceLabel(schedule, persistedStats),
        statusText: job ? label : (label || '等待下一次 Timefold 优化'),
        reasonLabel: solverReasonLabel(job?.reason || job?.solverStats?.reason || persistedStats?.reason || ''),
        lessonCount: job?.solverStats?.lessonCount || persistedStats?.lessonCount || null,
    };
}

function inspectorModelItemKey(item = {}) {
    if (item.type) {
        return [
            item.type || '',
            item.severity || '',
            item.targetKind || '',
            item.targetId || item.targetName || '',
            item.slot || '',
            item.message || '',
        ].join('|');
    }
    return [
        item.id || '',
        item.title || '',
        item.message || '',
        item.targetKind || '',
        item.targetId || '',
        item.slot || '',
    ].join('|');
}

function pushUniqueInspectorModelItem(target, seen, item) {
    if (!item?.title && !item?.message) return;
    const normalized = {
        id: item.id || '',
        source: item.source || 'unknown',
        severity: item.severity || 'info',
        category: item.category || '',
        type: item.type || '',
        title: item.title || item.targetName || timetableReviewLabel(item.type) || '审查项',
        message: item.message || item.title || '需要复核。',
        targetKind: item.targetKind || '',
        targetId: item.targetId || '',
        targetName: item.targetName || '',
        slot: inspectorSlotLabel(item.slot),
    };
    const key = inspectorModelItemKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    target.push(normalized);
}

function issueEntryToInspectorModelItem(entry = {}, source = 'diagnostic') {
    return {
        ...entry,
        id: entry.id || '',
        source,
        severity: entry.severity === 'error' || entry.severity === 'hard'
            ? 'error'
            : entry.severity === 'warning'
                ? 'warning'
                : 'info',
        title: entry.title || entry.targetName || timetableReviewLabel(entry.type) || '审查项',
        message: entry.message || entry.title || timetableReviewLabel(entry.type) || '需要复核。',
    };
}

function conflictToInspectorModelItem(conflict = {}, index = 0) {
    const severity = conflict.severity === 'hard' || conflict.severity === 'error' ? 'error' : 'warning';
    return {
        id: conflict.id || `conflict-${index}`,
        source: 'conflict',
        severity,
        category: conflict.category || '',
        type: conflict.type || '',
        title: conflict.title || conflict.targetName || timetableReviewLabel(conflict.type) || '冲突',
        message: conflict.message || conflict.reason || conflict.type || '存在课表冲突。',
        targetKind: conflict.targetKind || 'schedule',
        targetId: conflict.targetId || '',
        targetName: conflict.targetName || '',
        slot: inspectorSlotLabel(conflict.slot),
    };
}

function qualityIssueToInspectorModelItem(issue = {}, index = 0) {
    return {
        id: issue.id || `quality-${index}`,
        source: 'quality',
        severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
        category: issue.category || '',
        type: issue.type || '',
        title: issue.title || issue.targetName || timetableReviewLabel(issue.type) || '质量建议',
        message: issue.message || issue.title || timetableReviewLabel(issue.type) || '建议复核课表质量。',
        targetKind: issue.targetKind || 'schedule',
        targetId: issue.targetId || '',
        targetName: issue.targetName || '',
        slot: inspectorSlotLabel(issue.slot),
    };
}

function diagnosticSuggestionToInspectorModelItem(suggestion = {}, index = 0) {
    return {
        id: suggestion.id || `suggestion-${index}`,
        source: 'suggestion',
        severity: 'info',
        category: suggestion.category || suggestion.kind || '',
        type: suggestion.type || suggestion.kind || '',
        title: suggestion.title || '建议',
        message: suggestion.message || suggestion.description || suggestion.title || '建议复核。',
        targetKind: suggestion.targetKind || '',
        targetId: suggestion.targetId || '',
        targetName: suggestion.targetName || '',
        slot: inspectorSlotLabel(suggestion.slot),
    };
}

function diagnosticsItemMap(diagnostics = {}) {
    const map = new Map();
    (diagnostics.items || []).forEach(item => {
        if (item?.id) map.set(item.id, item);
    });
    return map;
}

function isActionableDiagnosticSuggestion(suggestion = {}, diagnostics = {}, context = {}) {
    const targetIds = Array.isArray(suggestion.targetDiagnostics)
        ? suggestion.targetDiagnostics.filter(Boolean)
        : [];
    if (!targetIds.length) return true;
    const itemById = diagnosticsItemMap(diagnostics);
    const targetItems = targetIds.map(id => itemById.get(id)).filter(Boolean);
    if (!targetItems.length) return true;
    return targetItems.some(item => isActionableTimetableReviewItem(item, context));
}

function buildInspectorSystemDetails(state = {}, metrics = {}) {
    const project = state.project || {};
    const stats = getRosterStats(project);
    const rules = getRuleSummary(project);
    const status = getSolveStatus(project, state.lastFailure);
    const solverDetail = getSolverDetail(state);
    const optimizationDetail = optimizationDetailForSummary(state);
    const solverStats = state.lastFailure?.solverStats || solverDetail.stats || {};
    const optimizationLessonCount = optimizationDetail?.lessonCount || solverStats.lessonCount || null;
    const details = [
        {
            group: 'data',
            title: '数据摘要',
            items: [
                { label: '班级', value: stats.classCount },
                { label: '教师', value: stats.teacherCount },
                { label: '课程', value: stats.subjectCount },
                { label: '总课时', value: stats.totalLessons },
                { label: '规则', value: rules.total },
                { label: '数据问题', value: stats.issueCount },
            ],
        },
        {
            group: 'solver',
            title: '生成详情',
            items: [
                { label: '来源', value: status.sourceLabel },
                { label: '完成率', value: status.completeness },
                { label: '硬冲突', value: metrics.hardConflicts },
                { label: '未排课时', value: metrics.unplaced },
                optimizationDetail ? { label: '当前课表', value: optimizationDetail.sourceText } : null,
                optimizationDetail ? { label: '后台优化', value: optimizationDetail.statusText } : null,
                optimizationDetail ? { label: '优化状态', value: optimizationDetail.statusText } : null,
                optimizationDetail?.reasonLabel ? { label: '处理结果', value: optimizationDetail.reasonLabel, tone: 'warning' } : null,
                solverDetail.reasonLabel
                    ? { label: solverDetail.isManualReview ? '教务复核' : '优化原因', value: solverDetail.reasonLabel }
                    : null,
                solverDetail.hasInitialSolutionInfo
                    ? { label: '初始解', value: solverDetail.initialSolutionText }
                    : null,
                solverDetail.hasPinnedCount
                    ? { label: '锁定课节', value: solverDetail.pinnedCount }
                    : null,
                solverDetail.kept ? {
                    label: '优化处理',
                    value: `已保留当前课表${solverDetail.reasonLabel ? `：${solverDetail.reasonLabel}。` : ''}`,
                    tone: 'warning',
                } : null,
                optimizationLessonCount ? { label: '课时数', value: optimizationLessonCount } : null,
                solverStats.timeoutSeconds ? { label: '超时上限', value: `${solverStats.timeoutSeconds} 秒` } : null,
                state.lastFailure?.message ? { label: '失败原因', value: state.lastFailure.message, tone: 'warning' } : null,
                state.lastFailure ? { label: '失败处理', value: '旧课表已保留', tone: 'warning' } : null,
            ].filter(Boolean),
        },
    ];
    const published = project.schedule?.published || null;
    const publication = project.schedule?.publication || state.lastFailure?.publication || null;
    if (published || publication) {
        details.push({
            group: 'publication',
            title: '发布详情',
            items: [
                published ? { label: '发布状态', value: publishedDraftChanged(project) ? '草稿已变化' : `已发布 V${published.version || 1}` } : { label: '发布状态', value: '未发布' },
                publication ? { label: '发布校验', value: publication.ok ? '可发布' : '不可发布' } : null,
                published?.fingerprint ? { label: '发布指纹', value: shortPublicationFingerprint(published.fingerprint) } : null,
            ].filter(Boolean),
        });
    }
    return details;
}

export function buildInspectorViewModel(state = {}) {
    const project = state.project || {};
    const schedule = project.schedule || null;
    const score = schedule?.score || {};
    const plannedTotal = totalPlannedLessons(project);
    const total = Number(score.totalLessons ?? plannedTotal ?? 0);
    const placed = Number(score.placedLessons ?? (schedule?.slots || []).length ?? 0);
    const hardConflicts = Number(score.hardConflicts ?? (schedule?.conflicts || []).filter(item => item.severity === 'hard' || item.severity === 'error').length ?? 0);
    const unplaced = Number(score.unplacedLessons ?? (schedule?.unplaced || []).length ?? Math.max(0, total - placed));
    const hasGeneratedSchedule = Boolean(schedule && (schedule.id || schedule.source || (schedule.slots || []).length || schedule.score));
    const blockingItems = [];
    const reviewItems = [];
    const blockingSeen = new Set();
    const reviewSeen = new Set();

    if (hasGeneratedSchedule && unplaced > 0) {
        pushUniqueInspectorModelItem(blockingItems, blockingSeen, {
            id: 'summary-unplaced',
            source: 'score',
            severity: 'error',
            title: '未排课时',
            message: `还有 ${unplaced} 节未排。`,
            targetKind: 'schedule',
        });
    }

    (schedule?.conflicts || []).forEach((conflict, index) => {
        const item = conflictToInspectorModelItem(conflict, index);
        if (item.severity === 'error') pushUniqueInspectorModelItem(blockingItems, blockingSeen, item);
        else pushUniqueInspectorModelItem(reviewItems, reviewSeen, item);
    });

    normalizePublicationPanelIssues(state).forEach(entry => {
        const item = issueEntryToInspectorModelItem(entry, 'publication');
        if (item.severity === 'error') pushUniqueInspectorModelItem(blockingItems, blockingSeen, item);
        else pushUniqueInspectorModelItem(reviewItems, reviewSeen, item);
    });

    const publicationStatusItem = publicationStatusInspectorItem(project);
    if (publicationStatusItem) {
        pushUniqueInspectorModelItem(reviewItems, reviewSeen, publicationStatusItem);
    }

    const publication = schedule?.publication || state.lastFailure?.publication || null;
    if (hasGeneratedSchedule && publication && publication.ok === false && !blockingItems.some(item => item.source === 'publication')) {
        pushUniqueInspectorModelItem(blockingItems, blockingSeen, {
            id: 'publication-not-ok',
            source: 'publication',
            severity: 'error',
            title: '发布前校验',
            message: '发布前校验未通过。',
            targetKind: 'schedule',
        });
    }

    normalizeScheduleDiagnosticIssues(state).forEach(entry => {
        const item = issueEntryToInspectorModelItem(entry, 'diagnostic');
        if (item.severity === 'error') pushUniqueInspectorModelItem(blockingItems, blockingSeen, item);
        else pushUniqueInspectorModelItem(reviewItems, reviewSeen, item);
    });

    (schedule?.qualityIssues || []).filter(issue => isActionableTimetableReviewItem(issue, state)).forEach((issue, index) => {
        const item = qualityIssueToInspectorModelItem(issue, index);
        if (item.severity === 'error') pushUniqueInspectorModelItem(blockingItems, blockingSeen, item);
        else pushUniqueInspectorModelItem(reviewItems, reviewSeen, item);
    });

    const metrics = {
        placed,
        total,
        hardConflicts,
        unplaced,
        warnings: reviewItems.length,
    };
    const systemDetails = buildInspectorSystemDetails(state, metrics);
    let verdict;
    if (!hasGeneratedSchedule) {
        verdict = {
            status: 'not_generated',
            title: '未生成',
            tone: 'warn',
            message: '当前还没有生成课表。',
        };
        metrics.placed = 0;
        metrics.unplaced = total;
    } else if (blockingItems.length) {
        verdict = {
            status: 'blocked',
            title: '不可发布',
            tone: 'danger',
            message: `有 ${blockingItems.length} 项必须处理的问题。`,
        };
    } else if (publishedDraftChanged(project)) {
        verdict = {
            status: 'changed_draft',
            title: '草稿已变化',
            tone: 'warn',
            message: '当前课表改动后需要重新发布。',
        };
    } else {
        verdict = {
            status: 'publishable',
            title: '可发布',
            tone: 'ok',
            message: '当前课表无阻断问题，可进入发布复核。',
        };
    }

    return {
        verdict,
        metrics,
        blockingItems,
        reviewItems,
        systemDetails,
    };
}

function inspectorHeaderSummary(model = {}) {
    const blockingCount = Number(model.blockingItems?.length || 0);
    const reviewCount = Number(model.reviewItems?.length || 0);
    if (blockingCount && reviewCount) return `需处理 ${blockingCount} · 复核 ${reviewCount}`;
    if (blockingCount) return `需处理 ${blockingCount}`;
    if (reviewCount) return `复核 ${reviewCount}`;
    return model.verdict?.title || '排课审查';
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

function normalizeExportWeekView(value = 'merged') {
    return ['odd', 'even'].includes(value) ? value : 'merged';
}

function hasWeekPatternMetadata(project = {}) {
    const isComplex = project.timetableModelVersion === 'complex_v1' || project.complexModelEnabled === true;
    if (!isComplex) return false;
    const hasPattern = item => ['odd', 'even', 'odd_even'].includes(item?.weekPattern);
    if ((project.lessonPlans || []).some(hasPattern)) return true;
    if ((project.schedule?.slots || []).some(hasPattern)) return true;
    if ((project.schedule?.published?.snapshot?.slots || []).some(hasPattern)) return true;
    return Object.values(project.rules?.softRules?.subjectPreferredPeriods || {}).some(hasPattern);
}

function renderExportWeekViewControl(state = {}) {
    if (!hasWeekPatternMetadata(state.project || {})) return '';
    const selected = normalizeExportWeekView(state.exportWeekView);
    const items = [
        ['merged', '合并'],
        ['odd', '单周'],
        ['even', '双周'],
    ];
    return `
        <div class="tt-export-week-view" aria-label="导出周次视图">
            <span>周次视图</span>
            <div class="tt-segment tt-export-week-segment" role="group" aria-label="导出周次视图">
                ${items.map(([value, label]) => `
                    <button type="button" data-export-week-view="${escapeAttr(value)}" class="${selected === value ? 'is-active' : ''}">${escapeHtml(label)}</button>
                `).join('')}
            </div>
        </div>
    `;
}

function renderComplexModelStrip(project = {}) {
    if (!projectHasComplexSignals(project)) return '';
    const enabled = project.timetableModelVersion === 'complex_v1' || project.complexModelEnabled === true;
    const checked = Boolean(project.schedule?.publication);
    const weekPatternVisible = hasWeekPatternMetadata(project);
    const modelText = `复杂模型：${enabled ? '已启用' : '未启用'}`;
    const weekText = weekPatternVisible ? '单双周视图：合并 / 单周 / 双周' : '单双周视图：暂无单双周课时';
    const checkText = `发布校验：${checked ? '已检查复杂冲突' : '待生成课表'}`;
    return `
        <div class="tt-complex-model-strip" aria-label="复杂排课模型状态">
            <span><b>${escapeHtml(modelText)}</b></span>
            <span><b>${escapeHtml(weekText)}</b></span>
            <span><b>${escapeHtml(checkText)}</b></span>
        </div>
    `;
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
                ${renderComplexModelStrip(state.project || {})}
                ${renderExportWeekViewControl(state)}
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
                ${solveScaleMessage(state.project, state.solveScaleHint) ? `<span class="tt-chip tt-chip--warn">${escapeHtml(solveScaleMessage(state.project, state.solveScaleHint))}</span>` : ''}
                <span class="tt-chip ${readiness.ready || isArchiveOnlyReadyState(state.project) ? 'tt-chip--ok' : 'tt-chip--warn'}">${readiness.ready ? '可生成' : isArchiveOnlyReadyState(state.project) ? '可恢复' : '待准备'}</span>
                <button class="tt-run-btn" id="tt-run-schedule" type="button" ${state.loading || !readiness.ready ? 'disabled' : ''}>
                    <i data-lucide="${state.loading ? 'loader-2' : 'play'}" class="${state.loading ? 'tt-spin' : ''}"></i><span>${state.loading ? '快速生成中' : '快速生成'}</span>
                </button>
            </div>
        </div>
        <div class="tt-schedule-scroll ${state.inspectorLocatePulse?.kind === 'owner' ? 'is-inspector-locate-pulse' : ''}">
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
    const rows = getTimetableRows(state.project);
    const context = createScheduleRenderContext(state);
    return `
        <div class="tt-schedule-body">
            <div class="tt-schedule-grid" style="--tt-days:${days.length}">
                <div class="tt-grid-head">节次</div>
                ${days.map(day => `<div class="tt-grid-head">周${dayName(day)}</div>`).join('')}
                ${rows.map(row => `
                    ${renderTimetableRowLabel(state.project, row)}
                    ${days.map(day => renderTimetableRowCell(state, context, day, row, false)).join('')}
                `).join('')}
            </div>
        </div>
    `;
}

function renderEmptyScheduleGrid(state) {
    const days = getActiveWeekdays(state.project);
    const rows = getTimetableRows(state.project);
    return `
        <div class="tt-schedule-body">
            <div class="tt-schedule-grid" style="--tt-days:${days.length}">
                <div class="tt-grid-head">节次</div>
                ${days.map(day => `<div class="tt-grid-head">周${dayName(day)}</div>`).join('')}
                ${rows.map(row => `
                    ${renderTimetableRowLabel(state.project, row)}
        ${days.map(day => renderTimetableRowCell(state, null, day, row, true)).join('')}
                `).join('')}
            </div>
        </div>
    `;
}

function getTimetableRows(project = {}) {
    const activePeriods = getActivePeriods(project);
    const segments = expandPeriodTimeSegments(project.periodTimeSegments || {});
    if (!segments.length) return activePeriods.map(period => ({ kind: 'teaching', period }));

    const rows = [];
    const periodTimeMap = new Map(completeProjectPeriodTimes(project).map(item => [Number(item.period), item]));
    let periodIndex = 0;
    segments.forEach((segment, segmentIndex) => {
        const kind = periodSetupKind(segment);
        const periodCount = Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
        if (kind === 'duty') {
            rows.push({
                kind,
                timeBlock: segment,
                sortKey: timeToMinutes(segment.startTime) ?? ((segmentIndex + 1) * 10000),
                order: rows.length,
            });
        } else if (kind === 'teaching') {
            const segmentStartMinutes = timeToMinutes(segment.startTime);
            const { classMinutes, breakMinutes } = segmentDurationMinutes(project, segment);
            for (let index = 0; index < periodCount && periodIndex < activePeriods.length; index += 1) {
                const period = activePeriods[periodIndex];
                const periodTime = periodTimeMap.get(Number(period)) || {};
                const calculatedStart = segmentStartMinutes === null
                    ? null
                    : segmentStartMinutes + (index * (classMinutes + breakMinutes));
                rows.push({
                    kind: 'teaching',
                    period,
                    segmentId: segment.id || '',
                    segmentLabel: segment.label || '',
                    segmentIndex,
                    segmentStart: index === 0,
                    sortKey: timeToMinutes(periodTime.start) ?? calculatedStart ?? ((segmentIndex + 1) * 10000 + index),
                    order: rows.length,
                });
                periodIndex += 1;
            }
        } else if (periodCount > 0) {
            rows.push({
                kind,
                timeBlock: segment,
                sortKey: timeToMinutes(segment.startTime) ?? ((segmentIndex + 1) * 10000),
                order: rows.length,
            });
        }
    });
    return rows.length
        ? rows.sort((left, right) => (left.sortKey - right.sortKey) || (left.order - right.order))
        : activePeriods.map(period => ({ kind: 'teaching', period }));
}

function renderTimetableRowLabel(project = {}, row = {}) {
    if (row.kind === 'duty' || row.kind === 'display') {
        return renderStudyBlockLabel(project, row.timeBlock, row.kind);
    }
    return renderPeriodGridLabel(project, row);
}

function renderTimetableRowCell(state, context, day, row, emptySchedule = false) {
    if (row.kind === 'duty') return renderDutyTimeBlockCell(state, day, row.timeBlock);
    if (row.kind === 'display') return renderDisplayTimeBlockCell(day, row.timeBlock);
    if (emptySchedule) {
        return `
            <div class="tt-cell tt-main-empty-cell ${inspectorPulseMatchesCell(state, day, row.period) ? 'is-inspector-locate-pulse' : ''}" data-day="${day}" data-period="${row.period}">
                <span>待排</span>
            </div>
        `;
    }
    return renderScheduleCell(state, context, day, row.period);
}

function renderPeriodGridLabel(project = {}, rowOrPeriod) {
    const row = typeof rowOrPeriod === 'object' ? rowOrPeriod : { period: rowOrPeriod };
    const period = row.period;
    const periodTime = completeProjectPeriodTimes(project).find(item => Number(item.period) === Number(period));
    const timeLabel = periodTime?.start && periodTime?.end ? `${periodTime.start}-${periodTime.end}` : '';
    const segmentLabel = row.segmentLabel || '';
    const segmentAttrs = row.segmentId ? ` data-period-segment-id="${escapeAttr(row.segmentId)}"` : '';
    const segmentClass = [
        'tt-period',
        segmentLabel ? 'tt-period--segmented' : '',
        row.segmentStart ? 'tt-period--segment-start' : '',
    ].filter(Boolean).join(' ');
    const title = [
        segmentLabel,
        `第${period}节`,
        timeLabel,
    ].filter(Boolean).join(' ');
    return `
        <div class="${segmentClass}"${segmentAttrs} title="${escapeAttr(title)}">
            ${segmentLabel ? `<em class="tt-period-segment-chip">${escapeHtml(segmentLabel)}</em>` : ''}
            <strong>第${period}节</strong>
            ${timeLabel ? `<span>${escapeHtml(timeLabel)}</span>` : ''}
        </div>
    `;
}

function segmentDurationMinutes(project = {}, segment = {}) {
    const defaults = project.periodTimeSegments?.globalDefaults || {};
    return {
        classMinutes: Math.max(1, Math.min(180, Number.parseInt(segment.classMinutes ?? defaults.classMinutes, 10) || 45)),
        breakMinutes: Math.max(0, Math.min(120, Number.parseInt(segment.breakMinutes ?? defaults.breakMinutes, 10) || 10)),
    };
}

function timeToMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

function minutesToTime(minutes) {
    const bounded = Math.max(0, Math.min(23 * 60 + 59, Math.round(Number(minutes) || 0)));
    return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}

function studyBlockTimeLabel(project = {}, segment = {}) {
    const startMinutes = timeToMinutes(segment.startTime);
    if (startMinutes === null) return '';
    const periodCount = Math.max(1, Number.parseInt(segment.periodCount, 10) || 1);
    const { classMinutes, breakMinutes } = segmentDurationMinutes(project, segment);
    const endMinutes = startMinutes + (periodCount * classMinutes) + Math.max(0, periodCount - 1) * breakMinutes;
    return `${minutesToTime(startMinutes)}-${minutesToTime(endMinutes)}`;
}

function renderStudyBlockLabel(project = {}, segment = {}, kind = 'duty') {
    const label = segment.label || '附加时段';
    const timeLabel = studyBlockTimeLabel(project, segment);
    const meta = kind === 'duty' ? '值班' : '附加时段';
    return `
        <div class="tt-period tt-study-period tt-study-period--${escapeAttr(kind)}" data-time-block-id="${escapeAttr(segment.id)}" title="${escapeAttr(timeLabel ? `${label} ${timeLabel}` : label)}">
            <strong>${escapeHtml(label)}</strong>
            ${timeLabel ? `<span>${escapeHtml(timeLabel)}</span>` : ''}
            <em>${escapeHtml(meta)}</em>
        </div>
    `;
}

function dutyAssignmentForCell(project = {}, day, timeBlockId = '', viewMode = 'class', ownerId = '') {
    return (project.dutyAssignments || []).filter(item => (
        item
        && item.status !== 'paused'
        && Number(item.day) === Number(day)
        && item.timeBlockId === timeBlockId
        && (viewMode === 'teacher'
            ? item.teacherId === ownerId
            : viewMode === 'master' || item.classId === ownerId)
    ));
}

function renderDutyTimeBlockCell(state, day, segment = {}) {
    const project = state.project || {};
    const maps = entityMaps(project);
    const assignments = dutyAssignmentForCell(project, day, segment.id, state.viewMode, state.selectedOwnerId);
    const content = assignments.length
        ? assignments.map(item => {
            const teacherName = maps.teachers.get(item.teacherId)?.name || item.teacherId;
            const className = ownerLabel(maps.classes.get(item.classId) || { id: item.classId });
            return state.viewMode === 'master'
                ? `${className} · ${teacherName}`
                : state.viewMode === 'teacher'
                    ? className
                    : teacherName;
        }).join('、')
        : '未排值班';
    return `
        <button class="tt-cell tt-study-cell tt-duty-cell ${assignments.length ? 'is-assigned' : 'is-missing'}" type="button" data-action="edit-duty-assignment" data-day="${day}" data-time-block-id="${escapeAttr(segment.id)}">
            <span>${escapeHtml(content)}</span>
        </button>
    `;
}

function renderDisplayTimeBlockCell(day, segment = {}) {
    return `
        <div class="tt-study-cell tt-display-cell" data-day="${day}" data-time-block-id="${escapeAttr(segment.id)}">
            <span>作息</span>
        </div>
    `;
}

function scheduleCellKey(day, period) {
    return `${day}-${period}`;
}

function inspectorPulseMatchesCell(state = {}, day, period) {
    const pulse = state.inspectorLocatePulse || null;
    return Boolean(pulse
        && Number(pulse.day) === Number(day)
        && Number(pulse.period) === Number(period));
}

function inspectorPulseMatchesSlot(state = {}, slot = {}) {
    const pulse = state.inspectorLocatePulse || null;
    if (!pulse) return false;
    if (pulse.slotId && slot.id && pulse.slotId === slot.id) return true;
    return inspectorPulseMatchesCell(state, slot.day, slot.period);
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
        <div class="tt-cell ${inspectorPulseMatchesCell(state, day, period) ? 'is-inspector-locate-pulse' : ''}" data-day="${day}" data-period="${period}">
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
    const slotClass = [
        'tt-slot',
        slot.locked ? 'is-locked' : '',
        conflict ? 'has-conflict' : '',
        state.selectedSlotId === slot.id ? 'is-selected' : '',
        inspectorPulseMatchesSlot(state, slot) ? 'is-inspector-locate-pulse' : '',
    ].filter(Boolean).join(' ');
    return `
        <button class="${slotClass}"
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

function inspectorVerdictToneClass(tone = 'warn') {
    return tone === 'ok' ? 'is-ok' : tone === 'danger' ? 'is-danger' : 'is-warn';
}

function renderInspectorVerdict(model) {
    const metrics = model.metrics || {};
    const verdict = model.verdict || {};
    return `
        <section class="tt-inspector-section tt-inspector-verdict ${inspectorVerdictToneClass(verdict.tone)}">
            <div class="tt-section-title">
                <h3><i data-lucide="badge-check"></i><span>当前结论</span></h3>
                <span class="tt-chip ${verdict.tone === 'ok' ? 'tt-chip--ok' : 'tt-chip--warn'}">${escapeHtml(verdict.title || '待审查')}</span>
            </div>
            <p>${escapeHtml(verdict.message || '请检查当前课表。')}</p>
            <div class="tt-inspector-metrics">
                <span aria-label="${escapeAttr(`已排 ${metrics.placed ?? 0}/${metrics.total ?? 0}`)}"><b>已排</b>${escapeHtml(`${metrics.placed ?? 0}/${metrics.total ?? 0}`)}</span>
                <span aria-label="${escapeAttr(`硬冲突 ${metrics.hardConflicts ?? 0}`)}"><b>硬冲突</b>${escapeHtml(metrics.hardConflicts ?? 0)}</span>
                <span aria-label="${escapeAttr(`未排 ${metrics.unplaced ?? 0}`)}"><b>未排</b>${escapeHtml(metrics.unplaced ?? 0)}</span>
                <span aria-label="${escapeAttr(`警告 ${metrics.warnings ?? 0}`)}"><b>警告</b>${escapeHtml(metrics.warnings ?? 0)}</span>
            </div>
        </section>
    `;
}

function inspectorIssueSourceLabel(source = '') {
    return ({
        publication: '发布问题',
        diagnostic: '诊断问题',
        quality: '质量建议',
        conflict: '冲突',
        score: '未排课时',
        suggestion: '建议',
    })[source] || '审查项';
}

const INSPECTOR_ISSUE_DEFAULT_LIMIT = 5;
const INSPECTOR_ISSUE_LIMIT_STEP = 20;

function inspectorIssueLimitKey(sectionKey = 'inspector', groupKey = 'items') {
    return `${sectionKey || 'inspector'}:${groupKey || 'items'}`;
}

function opaqueInspectorKey(prefix = 'item', parts = []) {
    const text = parts.map(part => String(part ?? '').trim()).join('|');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function inspectorIssueVisibleLimit(state = {}, limitKey = '', total = 0) {
    const savedLimit = Number(state.inspectorIssueLimits?.[limitKey]);
    const requestedLimit = Number.isFinite(savedLimit) && savedLimit > INSPECTOR_ISSUE_DEFAULT_LIMIT
        ? savedLimit
        : INSPECTOR_ISSUE_DEFAULT_LIMIT;
    return Math.min(Math.max(0, Number(total) || 0), requestedLimit);
}

function renderInspectorListActions({ limitKey = '', shown = 0, total = 0 } = {}) {
    if ((Number(total) || 0) <= INSPECTOR_ISSUE_DEFAULT_LIMIT) return '';
    const safeShown = Math.min(Number(total) || 0, Math.max(0, Number(shown) || 0));
    const safeTotal = Math.max(0, Number(total) || 0);
    const remaining = Math.max(0, safeTotal - safeShown);
    const expandLabel = remaining > INSPECTOR_ISSUE_LIMIT_STEP
        ? `展开更多 ${INSPECTOR_ISSUE_LIMIT_STEP}`
        : `展开剩余 ${remaining}`;
    return `
        <div class="tt-inspector-list-actions">
            <span>${escapeHtml(`已显示 ${safeShown}/${safeTotal}`)}</span>
            ${remaining ? `
                <button class="tt-inspector-list-action" type="button"
                    data-action="expand-inspector-issue-group"
                    data-inspector-issue-limit-key="${escapeAttr(limitKey)}"
                    data-inspector-issue-shown="${escapeAttr(safeShown)}"
                    data-inspector-issue-total="${escapeAttr(safeTotal)}">${escapeHtml(expandLabel)}</button>
            ` : ''}
            ${safeShown > INSPECTOR_ISSUE_DEFAULT_LIMIT ? `
                <button class="tt-inspector-list-action" type="button"
                    data-action="collapse-inspector-issue-group"
                    data-inspector-issue-limit-key="${escapeAttr(limitKey)}"
                    data-inspector-issue-shown="${escapeAttr(safeShown)}"
                    data-inspector-issue-total="${escapeAttr(safeTotal)}">收起</button>
            ` : ''}
        </div>
    `;
}

function inspectorLimitedItems(state = {}, sectionKey = '', groupKey = '', items = []) {
    const limitKey = inspectorIssueLimitKey(sectionKey, groupKey);
    const shown = inspectorIssueVisibleLimit(state, limitKey, items.length);
    return {
        limitKey,
        shown,
        visibleItems: items.slice(0, shown),
        actions: renderInspectorListActions({ limitKey, shown, total: items.length }),
    };
}

function inspectorIssueItemClass(item = {}) {
    const sourceClass = item.source === 'publication'
        ? 'tt-publication-issue-item'
        : item.source === 'diagnostic'
            ? 'tt-schedule-diagnostic-item'
            : '';
    return `tt-rule-preview-item tt-inspector-issue-item ${sourceClass} ${inspectorIssueSeverityClass(item.severity)}`.trim();
}

function inspectorIssueToneClass(severity = 'warning') {
    return severity === 'error' ? 'is-error' : severity === 'info' ? 'is-info' : 'is-warning';
}

function inspectorIssueStableKey(item = {}) {
    return opaqueInspectorKey('issue', [
        item.source || 'inspector',
        item.id || item.issueId || item.key || '',
        item.severity || '',
        item.category || '',
        item.type || '',
        item.targetKind || '',
        item.targetId || '',
        item.targetName || '',
        inspectorSlotLabel(item.slot),
        item.title || '',
        item.message || '',
    ]);
}

function renderInspectorIssueLocateAttrs(target = {}, issueKey = '') {
    return [
        'data-action="locate-inspector-issue"',
        issueKey ? `data-inspector-issue-key="${escapeAttr(issueKey)}"` : '',
        `data-inspector-target-kind="${escapeAttr(target.targetKind || '')}"`,
        `data-inspector-target-id="${escapeAttr(target.targetId || '')}"`,
        `data-inspector-target-name="${escapeAttr(target.targetName || target.label || '')}"`,
        `data-inspector-view-mode="${escapeAttr(target.viewMode || '')}"`,
        `data-inspector-owner-id="${escapeAttr(target.ownerId || '')}"`,
        target.planId ? `data-inspector-plan-id="${escapeAttr(target.planId)}"` : '',
        target.day ? `data-inspector-day="${escapeAttr(target.day)}"` : '',
        target.period ? `data-inspector-period="${escapeAttr(target.period)}"` : '',
    ].filter(Boolean).join(' ');
}

function inspectorIssueGroupKey(item = {}) {
    const groupTitle = inspectorIssueGroupTitle(item);
    const hasStableProblemShape = Boolean(
        item.type
        || item.category
        || item.source === 'suggestion'
        || (groupTitle && groupTitle !== item.message && groupTitle !== item.targetName)
    );
    const sourceKey = hasStableProblemShape ? '' : item.source || 'unknown';
    const categoryKey = item.type ? '' : item.category || '';
    const messageKey = hasStableProblemShape ? '' : item.message || '';
    return opaqueInspectorKey('group', [
        sourceKey,
        item.severity || 'info',
        categoryKey,
        item.type || '',
        groupTitle || inspectorIssueSourceLabel(item.source),
        messageKey,
    ]);
}

function inspectorIssueGroupTitle(item = {}) {
    const title = String(item.title || '').trim();
    const message = String(item.message || '').trim();
    const typeLabel = timetableReviewLabel(item.type);
    if (item.type && typeLabel && typeLabel !== '审查项') return typeLabel;
    if (item.source === 'suggestion' && title) return title;
    if (title && title !== item.targetName && title !== inspectorIssueSourceLabel(item.source)) return title;
    return message || title || inspectorIssueSourceLabel(item.source);
}

function inspectorIssueGroupDescription(group = {}) {
    const first = group.items?.[0] || {};
    const message = String(first.message || '').trim();
    const title = String(first.title || '').trim();
    if (!message || message === title || message === group.title) return '';
    if (group.source === 'publication') {
        return first.severity === 'error' ? '必须先处理' : '建议发布前复核';
    }
    if ((group.items || []).length > 1 && (first.type || group.source === 'suggestion')) {
        return inspectorIssueSectionLabel(group.source, first.severity || group.severity);
    }
    return message;
}

function inspectorIssueTargetLabel(item = {}, target = null) {
    const groupTitle = inspectorIssueGroupTitle(item);
    const title = String(item.title || '').trim();
    const message = String(item.message || '').trim();
    return target?.label
        || target?.targetName
        || item.targetName
        || (title && title !== groupTitle ? title : '')
        || (message && message !== groupTitle ? message : '')
        || inspectorIssueMeta(item)
        || title
        || message
        || '审查项';
}

function inspectorIssueCompactMeta(item = {}, label = '') {
    const parts = [];
    const kindLabel = inspectorIssueTargetKindLabel(item.targetKind);
    if (kindLabel && item.targetName && item.targetName !== label && item.targetName !== item.title) {
        parts.push(`${kindLabel} · ${item.targetName}`);
    }
    const message = String(item.message || '').trim();
    const groupTitle = inspectorIssueGroupTitle(item);
    if (message && message !== label && message !== item.title && message !== groupTitle) {
        parts.push(message);
    }
    const slotLabel = inspectorSlotLabel(item.slot);
    if (slotLabel) parts.push(`课节 ${slotLabel}`);
    return parts.join(' · ');
}

function groupInspectorIssuesByProblem(items = []) {
    const groups = new Map();
    items.forEach(item => {
        const key = inspectorIssueGroupKey(item);
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                source: item.source || 'unknown',
                severity: item.severity || 'info',
                title: inspectorIssueGroupTitle(item),
                items: [],
            });
        }
        groups.get(key).items.push(item);
    });
    return Array.from(groups.values());
}

function renderInspectorIssueCompactRow(item = {}, state = {}) {
    const locateTarget = resolveInspectorIssueLocateTarget(state.project || {}, item);
    const issueKey = locateTarget ? inspectorIssueStableKey(item) : '';
    const label = inspectorIssueTargetLabel(item, locateTarget);
    const meta = inspectorIssueCompactMeta(item, label);
    const rowClass = [
        'tt-inspector-target-row',
        locateTarget ? 'tt-inspector-target-row--locatable tt-inspector-issue-item--locatable' : '',
        issueKey && state.inspectorLocatedIssueKey === issueKey ? 'is-inspector-located-source' : '',
    ].filter(Boolean).join(' ');
    const content = `
        <span class="tt-inspector-target-main">${escapeHtml(label)}</span>
        ${meta ? `<span class="tt-inspector-target-meta">${escapeHtml(meta)}</span>` : ''}
        ${locateTarget ? '<span class="tt-inspector-locate-hint" aria-hidden="true">定位</span>' : ''}
    `;
    if (locateTarget) {
        return `
            <button type="button" class="${rowClass}" ${renderInspectorIssueLocateAttrs(locateTarget, issueKey)} aria-label="${escapeAttr(`定位：${label}`)}">
                ${content}
            </button>
        `;
    }
    return `<div class="${rowClass}">${content}</div>`;
}

function renderInspectorProblemGroup(group = {}, state = {}, sectionKey = '') {
    const limited = inspectorLimitedItems(state, sectionKey, group.key, group.items || []);
    const description = inspectorIssueGroupDescription(group);
    const sourceLabel = inspectorIssueSourceLabel(group.source);
    return `
        <div class="tt-inspector-problem-group ${inspectorIssueToneClass(group.severity)}">
            <div class="tt-inspector-problem-head">
                <div>
                    <strong>${escapeHtml(group.title || sourceLabel)}</strong>
                    ${description ? `<span>${escapeHtml(description)}</span>` : ''}
                </div>
                <span>${escapeHtml(group.items?.length || 0)}</span>
            </div>
            <div class="tt-inspector-target-list">
                ${limited.visibleItems.map(item => renderInspectorIssueCompactRow(item, state)).join('')}
            </div>
            ${limited.actions}
        </div>
    `;
}

function renderInspectorIssueItem(item = {}, state = {}) {
    const panel = item.source === 'publication' ? 'publication' : 'diagnostic';
    const severityLabel = inspectorIssueSectionLabel(panel, item.severity || 'warning');
    const meta = [severityLabel, inspectorIssueMeta(item)].filter(Boolean).join(' · ');
    const locateTarget = resolveInspectorIssueLocateTarget(state.project || {}, item);
    const issueKey = locateTarget ? inspectorIssueStableKey(item) : '';
    const itemClass = [
        inspectorIssueItemClass(item),
        locateTarget ? 'tt-inspector-issue-item--locatable' : '',
        issueKey && state.inspectorLocatedIssueKey === issueKey ? 'is-inspector-located-source' : '',
    ].filter(Boolean).join(' ');
    const content = `
        <strong>${escapeHtml(item.title || inspectorIssueSourceLabel(item.source))}</strong>
        <span>${escapeHtml(item.message || '需要复核。')}</span>
        ${meta ? `<em>${escapeHtml(meta)}</em>` : ''}
        ${locateTarget ? '<span class="tt-inspector-locate-hint">定位</span>' : ''}
    `;
    if (locateTarget) {
        return `
            <button type="button" class="${itemClass}" ${renderInspectorIssueLocateAttrs(locateTarget, issueKey)} aria-label="${escapeAttr(`定位：${locateTarget.label || item.title || '审查项'}`)}">
                ${content}
            </button>
        `;
    }
    return `
        <div class="${itemClass}">
            ${content}
        </div>
    `;
}

function renderInspectorIssueSection({ title, icon, items = [], emptyText = '暂无问题', tone = 'warn', sectionKey = '', open = false, state = {} }) {
    const grouped = groupInspectorIssuesByProblem(items);
    return `
        <section class="tt-inspector-section tt-inspector-review-section tt-inspector-review-section--${escapeAttr(tone)}">
            <details class="tt-inspector-collapsible" data-inspector-section="${escapeAttr(sectionKey || title)}"${open ? ' open' : ''}>
                <summary class="tt-section-title">
                    <h3><i data-lucide="${escapeAttr(icon)}"></i><span>${escapeHtml(title)}</span></h3>
                    <span class="tt-chip ${items.length ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(items.length)}</span>
                </summary>
                ${items.length ? `
                    <div class="tt-inspector-issue-groups">
                        ${grouped.map(group => renderInspectorProblemGroup(group, state, sectionKey || title)).join('')}
                    </div>
                ` : `<span class="tt-muted">${escapeHtml(emptyText)}</span>`}
            </details>
        </section>
    `;
}

const CONSTRAINT_FULFILLMENT_STATUS_LABELS = {
    satisfied: '已满足',
    partial: '部分满足',
    violated: '未满足',
    not_evaluable: '暂不可评估',
    unmet: '未满足',
    not_applicable: '未参与',
};

const CONSTRAINT_FULFILLMENT_FILTERS = [
    { key: 'attention', label: '需关注' },
    { key: 'all', label: '全部' },
    { key: 'violated', label: '未满足' },
    { key: 'partial', label: '部分满足' },
    { key: 'satisfied', label: '已满足' },
    { key: 'not_evaluable', label: '暂不可评估' },
];

function normalizeFulfillmentStatus(status = '') {
    if (status === 'unmet') return 'violated';
    if (status === 'not_applicable') return 'not_evaluable';
    return status || 'not_evaluable';
}

function fallbackConstraintFulfillment(project = {}) {
    const rules = getSavedRuleItems(project);
    if (!rules.length) return null;
    return {
        evaluated: false,
        summary: {
            total: rules.length,
            satisfied: 0,
            partiallySatisfied: 0,
            violated: 0,
            notEvaluable: rules.length,
            partial: 0,
            unmet: 0,
            notApplicable: rules.length,
        },
        items: rules.map(rule => ({
            id: rule.id,
            type: rule.type,
            source: rule.source,
            priority: rule.priority,
            targetKind: rule.targetKind,
            targetId: rule.targetId,
            targetName: rule.targetName,
            slots: rule.slots || [],
            title: `${rule.targetName || ''}${rule.description ? ` ${rule.description}` : ''}`.trim() || ruleTypeLabel(rule.type),
            description: rule.description,
            status: 'not_evaluable',
            legacyStatus: 'not_applicable',
            statusLabel: '暂不可评估',
            evidence: '等待生成课表后评估。',
            detail: '等待生成课表后评估。',
            evidenceSlots: [],
            suggestions: [],
            locateTargets: [],
        })),
    };
}

function getConstraintFulfillment(state = {}) {
    return state.constraintFulfillment || fallbackConstraintFulfillment(state.project || {});
}

function constraintFulfillmentSummaryText(summary = {}) {
    const total = Number(summary.total || 0);
    const satisfied = Number(summary.satisfied || 0);
    const partial = Number(summary.partiallySatisfied ?? summary.partial ?? 0);
    const violated = Number(summary.violated ?? summary.unmet ?? 0);
    const notEvaluable = Number(summary.notEvaluable ?? summary.notApplicable ?? 0);
    return `约束 ${total}：满足 ${satisfied} / 部分 ${partial} / 未满足 ${violated} / 暂不可评估 ${notEvaluable}`;
}

function normalizeConstraintFulfillmentFilter(state = {}, fulfillment = {}) {
    const requested = state.constraintFulfillmentFilter || '';
    if (CONSTRAINT_FULFILLMENT_FILTERS.some(item => item.key === requested)) return requested;
    const summary = fulfillment.summary || {};
    return Number(summary.violated ?? summary.unmet ?? 0) || Number(summary.partiallySatisfied ?? summary.partial ?? 0) ? 'attention' : 'all';
}

function constraintFulfillmentFilterCount(filter, items = []) {
    if (filter === 'all') return items.length;
    if (filter === 'attention') return items.filter(item => ['violated', 'partial'].includes(normalizeFulfillmentStatus(item.status))).length;
    return items.filter(item => normalizeFulfillmentStatus(item.status) === filter).length;
}

function filterConstraintFulfillmentItems(items = [], filter = 'attention') {
    if (filter === 'all') return items;
    if (filter === 'attention') return items.filter(item => ['violated', 'partial'].includes(normalizeFulfillmentStatus(item.status)));
    return items.filter(item => normalizeFulfillmentStatus(item.status) === filter);
}

function constraintFulfillmentTone(status = '') {
    const normalized = normalizeFulfillmentStatus(status);
    if (normalized === 'satisfied') return 'ok';
    if (normalized === 'partial') return 'warn';
    if (normalized === 'violated') return 'danger';
    return 'muted';
}

function constraintFulfillmentIssueTypes(item = {}) {
    const related = {
        teacher_consecutive_limit: ['teacher_consecutive'],
        subject_avoid_periods: ['subject_avoid_period'],
        subject_preferred_periods: ['preferredPeriods'],
        subject_morning: ['morningSubjects', 'morning_subject_late'],
    };
    return new Set([item.type, ...(related[item.type] || [])].filter(Boolean));
}

function issueTargetMatchesConstraint(issue = {}, item = {}) {
    const itemTargetId = item.targetId || '';
    if (!itemTargetId) return true;
    const issueIds = [
        issue.targetId,
        issue.teacherId,
        issue.classId,
        issue.subjectId,
        issue.planId,
        issue.lessonPlanId,
        issue.raw?.targetId,
        issue.raw?.teacherId,
        issue.raw?.classId,
        issue.raw?.subjectId,
    ].filter(Boolean).map(String);
    return issueIds.includes(String(itemTargetId));
}

function constraintFulfillmentRelation(item = {}, model = {}) {
    const types = constraintFulfillmentIssueTypes(item);
    const matches = issue => types.has(issue.type) && issueTargetMatchesConstraint(issue, item);
    if ((model.blockingItems || []).some(matches)) return '必须处理';
    if ((model.reviewItems || []).some(matches)) return '建议复核';
    return '';
}

function constraintFulfillmentStableKey(item = {}) {
    return opaqueInspectorKey('constraint', [
        item.id,
        item.type,
        item.targetKind,
        item.targetId,
        item.status,
        item.title,
    ]);
}

function renderConstraintFulfillmentFilters(activeFilter = 'attention', items = []) {
    return `
        <div class="tt-constraint-fulfillment-filters" role="tablist" aria-label="约束达成度筛选">
            ${CONSTRAINT_FULFILLMENT_FILTERS.map(filter => {
                const active = filter.key === activeFilter;
                const count = constraintFulfillmentFilterCount(filter.key, items);
                return `
                    <button class="tt-constraint-fulfillment-filter ${active ? 'is-active' : ''}" type="button"
                        data-action="filter-constraint-fulfillment"
                        data-constraint-fulfillment-filter="${escapeAttr(filter.key)}"
                        role="tab"
                        aria-pressed="${active ? 'true' : 'false'}">
                        <span>${escapeHtml(filter.label)}</span>
                        <em>${escapeHtml(count)}</em>
                    </button>
                `;
            }).join('')}
        </div>
    `;
}

function constraintFulfillmentSuggestionLabel(suggestion = {}) {
    return suggestion.label || ({
        relax_to_soft: '改为软约束',
        shrink_slots: '调整时段',
        delete_rule: '删除规则',
        manual: '人工处理',
    })[suggestion.kind] || '处理';
}

function renderConstraintFulfillmentSuggestions(item = {}) {
    const suggestions = (item.suggestions || []).slice(0, 3);
    if (!suggestions.length) return '';
    return `
        <span class="tt-constraint-fulfillment-actions">
            ${suggestions.map(suggestion => {
                const autoSupported = suggestion.kind === 'delete_rule';
                return `
                    <button class="tt-btn tt-btn--sm ${autoSupported ? 'tt-btn--ghost' : 'tt-btn--subtle'}" type="button"
                        data-action="constraint-fulfillment-suggestion"
                        data-constraint-fulfillment-row="${escapeAttr(item.ruleId || item.id || '')}"
                        data-constraint-fulfillment-suggestion="${escapeAttr(suggestion.kind || '')}">
                        ${escapeHtml(constraintFulfillmentSuggestionLabel(suggestion))}
                    </button>
                `;
            }).join('')}
        </span>
    `;
}

function constraintFulfillmentLocateTargets(item = {}) {
    const legacyTargets = Array.isArray(item.locateTargets) ? item.locateTargets.filter(Boolean) : [];
    if (legacyTargets.length) return legacyTargets;
    const evidenceSlots = Array.isArray(item.evidenceSlots) ? item.evidenceSlots : [];
    return evidenceSlots.map(slot => {
        const targetKind = item.targetKind === 'teacher' ? 'teacher' : 'class';
        const targetId = targetKind === 'teacher'
            ? item.targetId || slot.teacherId || ''
            : slot.classId || item.targetId || '';
        return {
            targetKind,
            targetId,
            targetName: item.targetName || '',
            day: slot.day,
            period: slot.period,
            slotId: slot.slotId || '',
            slot,
        };
    }).filter(target => target.day && target.period);
}

function renderConstraintFulfillmentRow(item = {}, state = {}, model = {}) {
    const relation = constraintFulfillmentRelation(item, model);
    const locateTarget = constraintFulfillmentLocateTargets(item)[0] || null;
    const issueKey = locateTarget ? constraintFulfillmentStableKey(item) : '';
    const normalizedStatus = normalizeFulfillmentStatus(item.status);
    const tone = constraintFulfillmentTone(normalizedStatus);
    const statusLabel = item.statusLabel || CONSTRAINT_FULFILLMENT_STATUS_LABELS[normalizedStatus] || normalizedStatus || '待评估';
    const detail = item.detail || item.evidence || '暂无评估证据。';
    const rowClass = [
        'tt-constraint-fulfillment-row',
        `tt-constraint-fulfillment-row--${tone}`,
        locateTarget ? 'tt-inspector-issue-item--locatable' : '',
        issueKey && state.inspectorLocatedIssueKey === issueKey ? 'is-inspector-located-source' : '',
    ].filter(Boolean).join(' ');
    const locateButton = locateTarget
        ? `<button type="button" class="tt-inspector-locate-hint" ${renderInspectorIssueLocateAttrs(locateTarget, issueKey)} aria-label="${escapeAttr(`定位：${item.title || statusLabel}`)}">定位</button>`
        : '';
    const content = `
        <span class="tt-constraint-fulfillment-status">${escapeHtml(statusLabel)}</span>
        <span class="tt-constraint-fulfillment-main">
            <strong>${escapeHtml(item.title || item.typeLabel || ruleTypeLabel(item.type))}</strong>
            <em>${escapeHtml(detail)}</em>
        </span>
        <span class="tt-constraint-fulfillment-meta">
            ${(item.strength || item.priority) === 'hard' ? '<b>硬约束</b>' : '<b>软约束</b>'}
            ${relation ? `<b>已列入${escapeHtml(relation)}</b>` : ''}
            ${locateButton}
        </span>
        ${renderConstraintFulfillmentSuggestions(item)}
    `;
    return `
        <div class="${rowClass}" data-constraint-fulfillment-row="${escapeAttr(item.id || '')}">
            ${content}
        </div>
    `;
}

function renderConstraintFulfillmentSection(state = {}, model = {}) {
    const fulfillment = getConstraintFulfillment(state);
    if (!fulfillment?.summary?.total) return '';
    const items = Array.isArray(fulfillment.items) ? fulfillment.items : [];
    const activeFilter = normalizeConstraintFulfillmentFilter(state, fulfillment);
    const visibleItems = filterConstraintFulfillmentItems(items, activeFilter);
    const hasAttention = Number(fulfillment.summary?.violated ?? fulfillment.summary?.unmet ?? 0)
        || Number(fulfillment.summary?.partiallySatisfied ?? fulfillment.summary?.partial ?? 0);
    const open = Boolean(hasAttention || state.constraintFulfillmentOpen);
    const loading = Boolean(state.constraintFulfillmentLoading);
    const error = state.constraintFulfillmentError || '';
    return `
        <section class="tt-inspector-section tt-constraint-fulfillment-section">
            <details class="tt-inspector-collapsible" data-inspector-section="constraint-fulfillment"${open ? ' open' : ''}>
                <summary class="tt-section-title">
                    <h3><i data-lucide="check-check"></i><span>约束满足度报告</span></h3>
                    <span class="tt-chip ${hasAttention ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(fulfillment.summary.total)}</span>
                </summary>
                <div class="tt-constraint-fulfillment-panel">
                    <div class="tt-constraint-fulfillment-summary">
                        <strong>${escapeHtml(constraintFulfillmentSummaryText(fulfillment.summary))}</strong>
                        <span>${escapeHtml(fulfillment.evaluated ? '基于当前课表评估' : '等待生成课表后评估')}</span>
                        <button class="tt-btn tt-btn--sm tt-btn--ghost" data-action="rerun-constraint-fulfillment" type="button">
                            <i data-lucide="refresh-cw"></i>
                            <span>重新排课</span>
                        </button>
                    </div>
                    ${loading ? '<span class="tt-muted">正在刷新约束达成度...</span>' : ''}
                    ${error ? `<span class="tt-muted">${escapeHtml(error)}</span>` : ''}
                    ${renderConstraintFulfillmentFilters(activeFilter, items)}
                    <div class="tt-constraint-fulfillment-list">
                        ${visibleItems.length
                            ? visibleItems.map(item => renderConstraintFulfillmentRow(item, state, model)).join('')
                            : '<span class="tt-muted">当前筛选下没有约束。</span>'}
                    </div>
                </div>
            </details>
        </section>
    `;
}

function renderInspectorDiagnosticsSystemSummary(state) {
    const diagnostics = state.project?.schedule?.diagnostics || state.lastFailure?.diagnostics || null;
    if (!diagnostics || !Array.isArray(diagnostics.items)) return '';
    const items = diagnostics.items || [];
    const suggestions = diagnostics.suggestions || [];
    if (!items.length && !suggestions.length) return '';
    const issueEntries = normalizeInspectorIssueEntries(items, {
        fallbackSeverity: 'warning',
        filter: item => isActionableTimetableReviewItem(item, state),
        labelOf: timetableReviewLabel,
        titleOf: item => item.targetName || timetableReviewLabel(item.type) || '诊断问题',
    });
    const suggestionEntries = suggestions
        .filter(item => isActionableDiagnosticSuggestion(item, diagnostics, state))
        .map((item, index) => diagnosticSuggestionToInspectorModelItem(item, index));
    if (!issueEntries.length && !suggestionEntries.length) return '';
    const visibleSummary = issueEntries.reduce((acc, item) => {
        const severity = ['error', 'warning', 'info'].includes(item.severity) ? item.severity : 'info';
        acc[severity] += 1;
        return acc;
    }, { error: 0, warning: 0, info: 0 });
    visibleSummary.total = issueEntries.length;
    visibleSummary.suggestions = suggestionEntries.length;
    return `
        <div class="tt-inspector-system-block">
            <div class="tt-subsection-title">
                <h4><i data-lucide="stethoscope"></i>诊断报告</h4>
                <span class="tt-chip ${visibleSummary.error || visibleSummary.warning ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(visibleSummary.total)}</span>
            </div>
            <div class="tt-audit-grid tt-audit-grid--quality">
                <span><b>错误</b>${escapeHtml(visibleSummary.error)}</span>
                <span><b>警告</b>${escapeHtml(visibleSummary.warning)}</span>
                <span><b>提示</b>${escapeHtml(visibleSummary.info)}</span>
                <span><b>建议</b>${escapeHtml(visibleSummary.suggestions)}</span>
            </div>
            ${renderInspectorIssueGroups({
                title: '诊断明细',
                entries: issueEntries,
                panel: 'diagnostic',
                sectionKey: 'system-diagnostics-items',
                state,
            })}
            ${renderInspectorIssueGroups({
                title: '诊断建议',
                entries: suggestionEntries,
                panel: 'suggestion',
                sectionKey: 'system-diagnostics-suggestions',
                state,
            })}
        </div>
    `;
}

function renderInspectorQualitySystemSummary(state) {
    const schedule = state.project?.schedule || {};
    const issues = (schedule.qualityIssues || []).filter(item => isActionableTimetableReviewItem(item, state));
    const breakdown = schedule.score?.softBreakdown || {};
    if (!issues.length && !Object.keys(breakdown).length) return '';
    return `
        <div class="tt-inspector-system-block">
            <div class="tt-subsection-title">
                <h4><i data-lucide="line-chart"></i>质量建议</h4>
                <span class="tt-chip ${issues.length ? 'tt-chip--warn' : 'tt-chip--ok'}">${escapeHtml(issues.length)}</span>
            </div>
            ${Object.keys(breakdown).length ? `
                <div class="tt-audit-grid tt-audit-grid--quality">
                    ${Object.entries(breakdown).slice(0, 6).map(([key, value]) => `<span><b>${escapeHtml(timetableReviewLabel(key))}</b>${escapeHtml(value)}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

function renderInspectorSystemDetailGroups(model) {
    const groups = model.systemDetails || [];
    if (!groups.length) return '';
    return `
        <div class="tt-inspector-system-block">
            ${groups.map(group => `
                <div class="tt-diagnostics-group">
                    <div class="tt-rule-report-title">
                        <strong>${escapeHtml(group.title || '系统详情')}</strong>
                    </div>
                    <div class="tt-detail-list">
                        ${(group.items || []).map(item => `<span class="${item.tone === 'warning' ? 'is-warning' : ''}"><b>${escapeHtml(item.label)}</b>${escapeHtml(item.value ?? '-')}</span>`).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderInspectorSolverSystemDetails(state) {
    const status = getSolveStatus(state.project, state.lastFailure);
    const solverDetail = getSolverDetail(state);
    return `
        <div class="tt-inspector-system-block">
            <div class="tt-subsection-title">
                <h4><i data-lucide="activity"></i>求解详情</h4>
            </div>
            <div class="tt-detail-list">
                <span><b>来源</b>${escapeHtml(status.sourceLabel)}</span>
                <span><b>完成率</b>${escapeHtml(status.completeness)}</span>
                <span><b>硬冲突</b>${escapeHtml(status.hardConflicts)}</span>
                <span><b>未排课时</b>${escapeHtml(status.unplaced)}</span>
                ${solverDetail.hasInitialSolutionInfo ? `<span><b>初始解</b>${escapeHtml(solverDetail.initialSolutionText)}</span>` : ''}
                ${solverDetail.hasPinnedCount ? `<span><b>锁定课节</b>${escapeHtml(solverDetail.pinnedCount)}</span>` : ''}
                ${solverDetail.reasonLabel ? `<span class="${solverDetail.kept || solverDetail.isManualReview ? 'is-warning' : ''}"><b>${solverDetail.isManualReview ? '教务复核' : '优化原因'}</b>${escapeHtml(solverDetail.reasonLabel)}</span>` : ''}
                ${solverDetail.kept ? `<span class="is-warning"><b>优化处理</b>已保留当前课表${solverDetail.reasonLabel ? `：${escapeHtml(solverDetail.reasonLabel)}。` : ''}</span>` : ''}
                ${state.lastFailure?.solverStats?.lessonCount ? `<span><b>课时数</b>${escapeHtml(state.lastFailure.solverStats.lessonCount)}</span>` : ''}
                ${state.lastFailure?.solverStats?.timeoutSeconds ? `<span><b>超时上限</b>${escapeHtml(state.lastFailure.solverStats.timeoutSeconds)} 秒</span>` : ''}
                ${state.lastFailure?.message ? `<span class="is-warning"><b>失败原因</b>${escapeHtml(state.lastFailure.message)}</span>` : ''}
                ${state.lastFailure ? `<span class="is-warning"><b>失败处理</b>旧课表已保留</span>` : ''}
            </div>
        </div>
    `;
}

function renderInspectorSystemDetails(state, model, selectedDetail) {
    const detailBlocks = [
        renderInspectorSystemDetailGroups(model),
    ].filter(Boolean).join('');
    return `
        <section class="tt-inspector-section tt-inspector-system-section">
            <details class="tt-inspector-collapsible" data-inspector-section="system">
                <summary class="tt-section-title">
                    <h3><i data-lucide="layers-3"></i><span>系统详情</span></h3>
                    <span class="tt-chip">展开</span>
                </summary>
                <div class="tt-inspector-system-stack">
                    ${detailBlocks}
                </div>
            </details>
        </section>
    `;
}

export function renderInspector(state, model = buildInspectorViewModel(state)) {
    const selectedDetail = getSlotDetails(state.project, state.selectedSlotId);
    const hasBlocking = model.blockingItems.length > 0;
    const hasReview = model.reviewItems.length > 0;
    return `
        <div class="tt-inspector-stack">
            ${renderInspectorVerdict(model)}
            ${renderInspectorIssueSection({
                title: '必须处理',
                icon: 'octagon-alert',
                items: model.blockingItems,
                emptyText: '无阻断问题',
                tone: 'danger',
                sectionKey: 'blocking',
                open: hasBlocking,
                state,
            })}
            ${renderInspectorIssueSection({
                title: '建议复核',
                icon: 'list-checks',
                items: model.reviewItems,
                emptyText: '暂无建议复核项',
                tone: 'warn',
                sectionKey: 'review',
                open: hasReview,
                state,
            })}
            ${renderConstraintFulfillmentSection(state, model)}
            ${renderPublicationPanel(state)}
            ${renderInspectorSystemDetails(state, model, selectedDetail)}
            ${selectedDetail ? renderSlotInspector(state) : ''}
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
    const itemList = inspectorLimitedItems(state, 'diagnostics', 'items', items);
    const suggestionList = inspectorLimitedItems(state, 'diagnostics', 'suggestions', suggestions);
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
                ${itemList.visibleItems.map(item => `
                    <div class="tt-conflict ${item.severity === 'error' || item.severity === 'warning' ? 'is-warning' : ''}">
                        <i data-lucide="${severityIcon(item.severity)}"></i>
                        <span><b>${escapeHtml(item.targetName || timetableReviewLabel(item.type))}</b>${escapeHtml(item.message || timetableReviewLabel(item.type))}</span>
                    </div>
                `).join('')}
            </div>
            ${itemList.actions}
            ${objectSections.length ? `
                <div class="tt-diagnostics-groups">
                    ${objectSections.map(section => {
                        const entryList = inspectorLimitedItems(state, 'diagnostics', `object-${section.key}`, section.entries);
                        return `
                            <div class="tt-diagnostics-group">
                                <div class="tt-rule-report-title">
                                    <span><i data-lucide="${section.icon}"></i>${escapeHtml(section.label)}</span>
                                    <span>${escapeHtml(section.entries.length)}</span>
                                </div>
                                <div class="tt-rule-preview tt-rule-preview--compact">
                                    ${entryList.visibleItems.map(entry => `
                                        <div class="tt-rule-preview-item tt-diagnostics-group-item ${entry.topSeverity === 'error' ? 'is-error' : entry.topSeverity === 'warning' ? 'is-warning' : ''}">
                                            <strong>${escapeHtml(entry.name)}</strong>
                                            <span>${escapeHtml(`关联 ${entry.count} 项诊断`)}</span>
                                            ${entry.labels[0] ? `<em>${escapeHtml(entry.labels.join('；'))}</em>` : ''}
                                        </div>
                                    `).join('')}
                                </div>
                                ${entryList.actions}
                            </div>
                        `;
                    }).join('')}
                </div>
            ` : ''}
            ${suggestions.length ? `
                <div class="tt-rule-warning-list">
                    ${suggestionList.visibleItems.map(item => `
                        <div class="tt-rule-warning">
                            <i data-lucide="lightbulb"></i>
                            <span>${escapeHtml(item.message || '建议草稿')}</span>
                        </div>
                    `).join('')}
                </div>
                ${suggestionList.actions}
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
    const diagnosticsItems = state.project?.schedule?.diagnostics?.items || state.lastFailure?.diagnostics?.items || [];
    if (diagnosticsItems.some(item => item.category !== 'publication')) return '';
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
                sectionKey: 'system-schedule-diagnostics',
                state,
            })}
        </section>
    `;
}

function renderQualityPanel(state) {
    const schedule = state.project?.schedule || {};
    const issues = (schedule.qualityIssues || []).filter(item => isActionableTimetableReviewItem(item, state));
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
    const scaleMessage = solveScaleMessage(state.project, state.solveScaleHint);
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
            <details class="tt-inspector-collapsible" data-inspector-section="current-slot" open>
                <summary class="tt-section-title">
                    <h3><i data-lucide="panel-right"></i><span>当前课节</span></h3>
                    <span class="tt-chip ${detail.hasConflict ? 'tt-chip--warn' : 'tt-chip--ok'}">${detail.hasConflict ? '有冲突' : '已选中'}</span>
                </summary>
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
            </details>
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
