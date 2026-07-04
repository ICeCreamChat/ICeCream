import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { TimetablePlannerController } from '../public/js/tools/timetable/controller.js';
import {
  getRosterStats,
  getPublishedScheduleDiff,
  getRuleSummary,
  getSavedRuleItems,
  getSolveStatus,
  removeSavedRuleById,
} from '../public/js/tools/timetable/selectors.js';
import {
  buildManualRuleDraftRows,
  exportName,
} from '../public/js/tools/timetable/forms.js';
import {
  renderWorkbench,
  renderInspector,
  renderSchedulePanel,
} from '../public/js/tools/timetable/view.js';
import { handleTimetableEscape } from '../public/js/tools/timetable/grid-interactions.js';

const sourcePath = new URL('../public/js/tools/timetable-planner.js', import.meta.url);
const stylePath = new URL('../public/css/timetable-planner.css', import.meta.url);
const appLauncherPath = new URL('../public/js/tools/app-launcher.js', import.meta.url);
const constraintDialogStylePath = new URL('../public/css/timetable-constraint-dialog.css', import.meta.url);
const constraintDialogAdvancedStylePath = new URL('../public/css/timetable-constraint-dialog-advanced.css', import.meta.url);
const moduleRoot = new URL('../public/js/tools/timetable/', import.meta.url);

function createConstraintDialogState(overrides = {}) {
  return { open: true, ...overrides };
}

function sampleWorkbenchState(overrides = {}) {
  const smartWorkbench = overrides.smartWorkbench || {};
  const ruleReviewOverride = overrides.ruleReview || {};
  const mappedConstraintDialog = overrides.constraintDialog || {
    open: Boolean(smartWorkbench.open || ruleReviewOverride.open),
  };
  const normalizedRuleReview = {
    ...ruleReviewOverride,
    inputMode: ruleReviewOverride.inputMode || ruleReviewOverride.mode || smartWorkbench.sourceMode || 'text',
    parsing: Boolean(ruleReviewOverride.parsing ?? ruleReviewOverride.loading),
  };
  return {
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: overrides.schedule ?? null,
    }),
    viewMode: 'class',
    selectedOwnerId: 'c1',
    selectedSlotId: '',
    loading: false,
    message: '',
    lastFailure: null,
    ruleReview: normalizedRuleReview,
    smartWorkbench: { open: false },
    constraintDialog: mappedConstraintDialog,
    ...overrides,
    ruleReview: normalizedRuleReview,
    smartWorkbench: { open: false },
    constraintDialog: mappedConstraintDialog,
  };
}

test('timetable opens smart constraints in the constraint dialog instead of the removed workbench', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'ready_for_constraints',
    }),
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-dialog/);
  assert.match(html, /tt-dialog-title-icon/);
  assert.match(html, /tt-constraint-dialog-body--intake/);
  assert.match(html, /tt-constraint-intake-panel/);
  assert.match(html, /tt-constraint-mode-row/);
  assert.match(html, /tt-constraint-form-surface/);
  assert.match(html, /tt-constraint-command-row/);
  assert.match(html, /智能约束助手/);
  assert.match(html, /排课要求/);
  assert.match(html, /理解要求/);
  assert.match(html, /data-action="parse-constraints"/);
  assert.doesNotMatch(html, /data-smart-workbench-root/);
  assert.doesNotMatch(html, /tt-smart-workbench/);
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  assert.doesNotMatch(html, /id="tt-agent-floating"/);
});

test('timetable constraint dialog renders object-first requirements as a review workbench', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      text: '数学必须连堂；未注明默认单节；高负载教师不要连续太多；未知课程第1节优先。',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [
        {
          id: 'req_rule',
          object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
          intent: 'preferred_periods',
          status: 'actionable',
          applyTo: 'rule',
          parameters: { slots: ['1-1'] },
          source: { rawText: '语文尽量第1节' },
          confidence: 0.92,
        },
        {
          id: 'req_block',
          object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
          intent: 'block_preference',
          status: 'actionable',
          applyTo: 'lesson_plan',
          parameters: { blockPreference: 'double' },
          source: { rawText: '数学必须连堂' },
          confidence: 0.91,
        },
        {
          id: 'req_load',
          object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t_math'], scope: 'derived' },
          intent: 'teacher_load_protection',
          status: 'actionable',
          applyTo: 'optimization',
          parameters: { maxConsecutive: 3 },
          source: { rawText: '高负载教师不要连续太多' },
          confidence: 0.86,
        },
        {
          id: 'req_handled',
          object: { kind: 'global', name: '默认课时块策略', matchedIds: [], scope: 'global' },
          intent: 'default_block_policy',
          status: 'handled',
          applyTo: 'solver_policy',
          parameters: { blockPreference: 'single' },
          source: { rawText: '未注明默认单节' },
          confidence: 0.95,
        },
        {
          id: 'req_review',
          object: { kind: 'subject', name: '未知课程', matchedIds: [], scope: 'ambiguous' },
          intent: 'preferred_periods',
          status: 'needs_review',
          applyTo: 'review',
          parameters: { slots: ['1-1'] },
          source: { rawText: '未知课程第1节优先', sourceRow: 4 },
          warnings: ['未找到唯一匹配课程'],
          confidence: 0.42,
        },
      ],
      semanticActions: [
        { id: 'act_block', requirementId: 'req_block', kind: 'lesson_plan_patch', status: 'ready' },
        { id: 'act_load', requirementId: 'req_load', kind: 'soft_rules_patch', status: 'ready' },
      ],
    },
    constraintDialog: { open: true },
  }));

  assert.match(html, /tt-constraint-dialog--semantic-review/);
  assert.match(html, /tt-requirement-workbench/);
  assert.match(html, /tt-requirement-filter-bar/);
  assert.match(html, /tt-requirement-table/);
  assert.match(html, /tt-requirement-detail/);
  assert.doesNotMatch(html, /tt-requirement-card/);
  assert.match(html, /可应用到约束规则/);
  assert.match(html, /可应用到任课计划/);
  assert.match(html, /可应用到优化目标/);
  assert.match(html, /已自动处理/);
  assert.match(html, /需复核/);
  assert.match(html, /全部[\s\S]*5/);
  assert.match(html, /data-action="filter-requirements"/);
  assert.match(html, /data-action="select-requirement"/);
  assert.match(html, /<span>数学<\/span>/);
  assert.match(html, /<span>连堂设置<\/span>/);
  assert.match(html, /<span>高负载教师<\/span>/);
  assert.match(html, /默认课时块策略/);
  assert.match(html, /未找到唯一匹配课程/);
  assert.match(html, /data-requirement-id="req_review"[\s\S]*is-selected/);
  assert.doesNotMatch(html, /暂不支持[\s\S]{0,80}默认单节/);
});

test('timetable constraint dialog localizes semantic enum aliases in requirement review', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [
        {
          id: 'req_candidate_morning',
          object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
          intent: 'morning_preference',
          status: 'candidate',
          applyTo: 'rule',
          parameters: { dayPart: 'morning' },
          source: { rawText: '语文尽量上午' },
          confidence: 0.84,
        },
        {
          id: 'req_candidate_spread',
          object: { kind: 'subject', name: '英语', matchedIds: ['s3'], scope: 'explicit' },
          intent: 'spread',
          status: 'candidate',
          applyTo: 'lesson_plan',
          parameters: { blockPreference: 'double' },
          source: { rawText: '如果生成了连堂块' },
          confidence: 0.78,
        },
        {
          id: 'req_old_morning',
          object: { kind: 'subject', name: '数学', matchedIds: ['s2'], scope: 'explicit' },
          intent: 'subject_morning',
          status: 'candidate',
          applyTo: 'lesson_plan',
          parameters: {},
          source: { rawText: '数学尽量上午' },
          confidence: 0.9,
        },
        {
          id: 'req_old_avoid',
          object: { kind: 'subject', name: '体育', matchedIds: ['s4'], scope: 'explicit' },
          intent: 'subject_avoid_periods',
          status: 'suggestion',
          applyTo: 'constraint_rule',
          parameters: { periods: [1] },
          source: { rawText: '体育第一节不要排' },
          confidence: 0.82,
        },
        {
          id: 'req_old_teacher_time',
          object: { kind: 'teacher', name: '张老师', matchedIds: ['t1'], scope: 'explicit' },
          intent: 'teacher_unavailable',
          status: 'ready',
          applyTo: 'rule',
          parameters: { slots: ['1-1'] },
          source: { rawText: '张老师周一第一节不排' },
          confidence: 0.91,
        },
      ],
      semanticActions: [],
    },
    constraintDialog: { open: true, selectedRequirementId: 'req_candidate_morning' },
  }));

  assert.match(html, /待确认/);
  assert.match(html, /上午优先/);
  assert.match(html, /课程分散/);
  assert.match(html, /避开节次/);
  assert.match(html, /教师不可排/);
  assert.match(html, /双连堂/);
  assert.match(html, /时段：上午/);
  assert.match(html, /建议/);
  assert.doesNotMatch(html, />candidate</);
  assert.doesNotMatch(html, />morning_preference</);
  assert.doesNotMatch(html, />spread</);
  assert.doesNotMatch(html, /subject_morning/);
  assert.doesNotMatch(html, /subject_avoid_periods/);
  assert.doesNotMatch(html, /teacher_unavailable/);
  assert.doesNotMatch(html, /blockPreference/);
  assert.doesNotMatch(html, /：double|>double</);
});

test('timetable constraint dialog filters semantic requirements by destination', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      draftRows: [],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [
        {
          id: 'req_rule',
          object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
          intent: 'preferred_periods',
          status: 'actionable',
          applyTo: 'rule',
          parameters: { slots: ['1-1'] },
          source: { rawText: '语文尽量第1节' },
        },
        {
          id: 'req_block',
          object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
          intent: 'block_preference',
          status: 'actionable',
          applyTo: 'lesson_plan',
          parameters: { blockPreference: 'double' },
          source: { rawText: '数学必须连堂' },
        },
      ],
      semanticActions: [
        { id: 'act_block', requirementId: 'req_block', kind: 'lesson_plan_patch', status: 'ready' },
      ],
    },
    constraintDialog: { open: true, requirementFilter: 'lesson_plan', selectedRequirementId: 'req_block' },
  }));

  assert.match(html, /data-requirement-filter="lesson_plan"[\s\S]*aria-pressed="true"/);
  assert.match(html, /data-requirement-id="req_block"[\s\S]*is-selected/);
  assert.match(html, /<span>数学<\/span>/);
  assert.match(html, /双连堂/);
  assert.doesNotMatch(html, /<span>语文<\/span>/);
});

test('timetable constraint dialog reserves semantic review height before legacy draft rows', async () => {
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      draftRows: [{
        id: 'legacy-draft-1',
        rawText: '同一位教师同一时间只能给一个班上课。',
        type: 'teacher_unavailable',
        targetName: '全部教师',
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
      }],
      warnings: [],
      conflicts: [],
      unsupportedItems: [],
      requirementItems: [{
        id: 'req_review',
        object: { kind: 'subject', name: '未知课程', matchedIds: [], scope: 'ambiguous' },
        intent: 'preferred_periods',
        status: 'needs_review',
        applyTo: 'review',
        parameters: { slots: ['1-1'] },
        source: { rawText: '未知课程第1节优先', sourceRow: 1 },
      }],
      semanticActions: [],
    },
    constraintDialog: { open: true },
  }));

  assert.match(html, /tt-requirement-workbench[\s\S]*已识别约束 \(1\)/);
  assert.match(dialogStyles, /\.tt-requirement-workbench\s*{[\s\S]*--tt-requirement-review-height:\s*clamp/);
  assert.match(dialogStyles, /\.tt-requirement-workbench\s*{[\s\S]*grid-template-rows:\s*auto auto var\(--tt-requirement-review-height\)/);
  assert.match(dialogStyles, /\.tt-requirement-workbench\s*{[\s\S]*block-size:\s*calc\(var\(--tt-requirement-review-height\) \+ 78px\)/);
  assert.match(dialogStyles, /\.tt-requirement-review-layout\s*{[\s\S]*height:\s*var\(--tt-requirement-review-height\)/);
  assert.match(dialogStyles, /\.tt-requirement-table\s*{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(dialogStyles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-requirement-workbench\s*{[\s\S]*block-size:\s*auto/);
});

test('timetable constraint dialog controller exposes the current dialog actions', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const dialogControllerSource = await readFile(new URL('../public/js/tools/timetable/controller-constraint-dialog.js', import.meta.url), 'utf8');
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');

  assert.match(controllerSource, /openConstraintDialog\(/);
  assert.match(dialogControllerSource, /closeConstraintDialog\(/);
  assert.match(dialogControllerSource, /parseConstraintsFromDialog\(/);
  assert.match(dialogControllerSource, /applyConstraintsFromDialog\(/);
  assert.match(dialogControllerSource, /filterRequirements\(/);
  assert.match(dialogControllerSource, /selectRequirement\(/);
  assert.match(dialogControllerSource, /result\.draftRows/);
  assert.match(controllerSource, /this\.constraintDialogFile\s*=\s*null/);
  assert.match(dialogControllerSource, /fileInput\?\.files\?\.\[0\]\s*\|\|\s*this\.constraintDialogFile/);
  assert.match(dialogControllerSource, /this\.constraintDialogFile\s*=\s*file/);
  assert.match(interactionSource, /open-constraint-dialog/);
  assert.match(interactionSource, /close-constraint-dialog/);
  assert.match(interactionSource, /switch-constraint-mode/);
  assert.match(interactionSource, /parse-constraints/);
  assert.match(interactionSource, /apply-constraints/);
  assert.match(interactionSource, /filter-requirements/);
  assert.match(interactionSource, /select-requirement/);
  assert.match(interactionSource, /start-ai-chat/);
});

function buttonTag(html, marker) {
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, `expected button marker ${marker}`);
  const start = html.lastIndexOf('<button', markerIndex);
  const end = html.indexOf('>', markerIndex);
  assert.ok(start >= 0 && end > start, `expected button tag for ${marker}`);
  return html.slice(start, end + 1);
}

function extractMethodSource(source, methodName) {
  const signature = `async ${methodName}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected method ${methodName}`);
  const paramsEnd = source.indexOf(') {', start);
  assert.notEqual(paramsEnd, -1, `expected parameter list end for ${methodName}`);
  const bodyStart = source.indexOf('{', paramsEnd);
  assert.notEqual(bodyStart, -1, `expected method body for ${methodName}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unable to extract method ${methodName}`);
}

function createPeriodTimeDom(rows, settings = {}, segments = {}) {
  const createSelect = (value = '', options = []) => ({
    value: String(value ?? ''),
    disabled: false,
    options: options.map(option => ({ ...option })),
  });
  const settingInputs = new Map([
    ['#tt-period-start-time', { value: settings.startTime || '08:00' }],
    ['#tt-period-class-minutes', { value: String(settings.classMinutes ?? 40) }],
    ['#tt-period-break-minutes', { value: String(settings.breakMinutes ?? 10) }],
    ['#tt-period-afternoon-start-period', createSelect(
      settings.afternoonStartPeriod === undefined ? '' : String(settings.afternoonStartPeriod ?? ''),
      [{ value: '', label: '不单独拆分下午' }],
    )],
    ['#tt-period-afternoon-start-time', { value: settings.afternoonStartTime || '14:00' }],
    ['#tt-period-evening-start-period', createSelect(
      settings.eveningStartPeriod === undefined ? '' : String(settings.eveningStartPeriod ?? ''),
      [{ value: '', label: '不启用晚间' }],
    )],
    ['#tt-period-evening-start-time', { value: settings.eveningStartTime || '19:00', disabled: !settings.eveningStartPeriod }],
    ['#tt-segment-global-class-minutes', { value: String(settings.classMinutes ?? 45) }],
    ['#tt-segment-global-break-minutes', { value: String(settings.breakMinutes ?? 10) }],
  ]);
  const segmentCards = Object.entries(segments).map(([id, seg]) => ({
    dataset: { segmentId: id },
    querySelector(selector) {
      if (selector.includes(`${id}-label`)) return { value: seg.label || '时段' };
      if (selector.includes(`${id}-startTime`)) return { value: seg.startTime || '08:00' };
      if (selector.includes(`${id}-periodCount`)) return { value: String(seg.periodCount || 1) };
      if (selector.includes(`${id}-classMinutes`)) return { value: seg.classMinutes === null ? '' : String(seg.classMinutes || '') };
      if (selector.includes(`${id}-breakMinutes`)) return { value: seg.breakMinutes === null ? '' : String(seg.breakMinutes || '') };
      return null;
    },
  }));
  const createElement = tagName => ({
    tagName: String(tagName).toUpperCase(),
    className: '',
    colSpan: undefined,
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    querySelector(selector) {
      if (selector === 'strong') {
        return this.children.find(child => child.tagName === 'STRONG')
          || this.children.flatMap(child => child.children || []).find(child => child.tagName === 'STRONG')
          || null;
      }
      return null;
    },
    remove() {
      if (!this.parentNode?.children) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
  });
  const fakeDocument = { createElement };
  const tableBody = {
    ownerDocument: fakeDocument,
    children: [],
    querySelectorAll(selector) {
      if (selector === '.tt-period-time-segment-header') {
        return this.children.filter(child => child.className === 'tt-period-time-segment-header');
      }
      return [];
    },
    insertBefore(node, referenceNode) {
      node.parentNode = this;
      const index = this.children.indexOf(referenceNode);
      if (index >= 0) this.children.splice(index, 0, node);
      else this.children.push(node);
      return node;
    },
  };
  const createSegmentHeader = label => {
    const header = createElement('tr');
    header.className = 'tt-period-time-segment-header';
    const cell = createElement('td');
    cell.colSpan = 4;
    const strong = createElement('strong');
    strong.textContent = label;
    cell.appendChild(strong);
    header.appendChild(cell);
    return header;
  };
  const rowNodes = rows.map(row => {
    const startInput = { value: row.start || '' };
    const endInput = { value: row.end || '' };
    const gapInput = row.gapAfter === undefined
      ? null
      : { value: String(row.gapAfter), dataset: { periodTimeGapAfter: String(row.period) } };
    return {
      dataset: { periodTimeRow: String(row.period) },
      startInput,
      endInput,
      gapInput,
      querySelector(selector) {
        if (selector.includes('data-period-time-draft-start') || selector.includes('data-period-time-start')) return startInput;
        if (selector.includes('data-period-time-draft-end') || selector.includes('data-period-time-end')) return endInput;
        if (selector.includes('data-period-time-gap-after')) return gapInput;
        return null;
      },
    };
  });
  rowNodes.forEach(row => {
    row.parentNode = tableBody;
    tableBody.children.push(row);
  });
  return {
    rows: rowNodes,
    settings: settingInputs,
    tableBody,
    createSegmentHeader,
    querySelector(selector) {
      if (selector === '.tt-period-time-table tbody') return tableBody;
      return settingInputs.get(selector) || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-period-time-row]') return rowNodes;
      if (selector === '[data-segment-id]') return segmentCards;
      return [];
    },
  };
}

test('timetable roster stats count multi-teacher plans and allowed rooms', () => {
  const project = createDefaultTimetableProject({
    teachers: [
      { id: 't_math', name: 'Math Teacher', subjects: ['science'], unavailableSlots: [] },
      { id: 't_lab', name: 'Lab Teacher', subjects: ['science'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'science', name: 'Science', priority: 80, color: '#0891b2' }],
    lessonPlans: [{
      id: 'lp_science',
      classId: 'c1',
      subjectId: 'science',
      teacherId: 't_math',
      teacherIds: ['t_math', 't_lab'],
      weeklyHours: 4,
      roomId: 'lab_a',
      allowedRoomIds: ['lab_a', 'lab_b'],
    }],
  });

  const stats = getRosterStats(project);

  assert.equal(stats.fixedRoomCount, 2);
  assert.equal(stats.issueCount, 0);

  const invalidStats = getRosterStats({
    ...project,
    lessonPlans: [{
      ...project.lessonPlans[0],
      teacherIds: ['t_math', 'missing_teacher'],
    }],
  });
  assert.equal(invalidStats.issueCount, 1);
});

test('timetable frontend export names include published timetable files', () => {
  assert.equal(exportName('published_class'), '正式班级课表');
  assert.equal(exportName('published_teacher'), '正式教师课表');
  assert.equal(exportName('published_master'), '正式总课表');
});

test('timetable manual rule builder creates teacher limit review rows', () => {
  const rows = buildManualRuleDraftRows({
    type: 'teacher_daily_limit',
    targetType: 'teacher',
    targets: [{ id: 't_math', name: 'Math Teacher' }],
    days: [1, 2],
    periods: [1, 2],
    limit: 4,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'teacher_daily_limit');
  assert.equal(rows[0].targetId, 't_math');
  assert.equal(rows[0].limit, 4);
  assert.deepEqual(rows[0].slots, []);
  assert.equal(rows[0].priority, 'soft');
});

test('timetable planner is assembled from workbench modules', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const expectedModules = [
    'api.js',
    'controller.js',
    'forms.js',
    'grid-interactions.js',
    'selectors.js',
    'state.js',
    'view.js',
  ];

  assert.match(source, /import\s+\{\s*TimetablePlannerController\s*\}\s+from\s+['"]\.\/timetable\/controller\.js['"]/);
  assert.doesNotMatch(source, /class\s+TimetablePlanner\s*{/);

  for (const moduleName of expectedModules) {
    const moduleSource = await readFile(new URL(moduleName, moduleRoot), 'utf8');
    assert.match(moduleSource, /export\s+/);
  }
});

test('timetable immersive mode hides global click particles without affecting seating', async () => {
  const controller = new TimetablePlannerController();
  const classes = new Set();
  const host = {
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
  };
  const container = {
    closest: selector => selector === '.tool-container' ? host : null,
  };
  controller.load = async () => {};

  await controller.init(container);
  assert.equal(classes.has('tool-container--timetable'), true);

  controller.destroy();
  assert.equal(classes.has('tool-container--timetable'), false);

  const styles = await readFile(stylePath, 'utf8');
  assert.match(styles, /\.tool-container--timetable\.active\s*~\s*\.math-particle-dom/);
});

test('timetable planner uses the seating-style control panel and board layout', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');

  assert.match(viewSource, /class="tt-workbench \$\{/);
  assert.match(viewSource, /class="tt-topbar"/);
  assert.match(viewSource, /class="tt-sidebar"/);
  assert.match(viewSource, /class="tt-schedule-panel"/);
  assert.match(viewSource, /class="tt-inspector"/);
  assert.match(viewSource, /id="tt-inspector-drawer"/);
  assert.match(viewSource, /class="tt-inspector-summary"/);
  assert.match(viewSource, /data-workflow-step="data"/);
  assert.match(viewSource, /data-workflow-step="rules"/);
  assert.match(viewSource, /data-workflow-step="solve"/);
  assert.match(viewSource, /data-workflow-step="review"/);
  assert.doesNotMatch(viewSource, /id:\s*'agent'/);
  assert.match(viewSource, /renderWorkbench/);
  assert.match(viewSource, /renderSchedulePanel/);
  assert.match(viewSource, /renderInspector/);
  assert.doesNotMatch(source, /class="tt-tabs"/);
  assert.doesNotMatch(source, /renderTab\(/);
  assert.doesNotMatch(source, /renderActiveTab/);

  assert.match(styles, /\.tt-workbench\s*{/);
  assert.match(styles, /\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar topbar"\s*"sidebar schedule"/s);
  assert.doesNotMatch(styles, /\.tt-workbench\s*{[^}]*"sidebar schedule inspector"/s);
  assert.match(styles, /\.tt-sidebar\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-schedule-scroll\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-inspector\s*{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.tt-inspector-drawer\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
  assert.match(styles, /--tt-bg-base:\s*#0f172a/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar"\s*"sidebar"\s*"schedule"\s*"inspector"/s);
});

test('timetable planner no longer renders the legacy floating smart agent', async () => {
  const html = renderWorkbench(sampleWorkbenchState({
    agent: {
      sessionId: 'tt_agent_demo',
      stage: 'solve_planning',
      messages: [
        { role: 'user', content: '开始排课' },
        { role: 'assistant', content: '我已生成求解计划，确认后才会调用求解器。' },
      ],
      plan: [],
      questions: [{ id: 'q_missing', title: '需要补充', description: '请补充教师名单' }],
      approvalQueue: [
        {
        id: 'act_solve',
        type: 'execute_solve',
        title: '执行求解计划',
        description: '确认后才会调用本地排课算法/Timefold。',
        },
        {
          id: 'act_save_recommended',
          type: 'save_solution',
          title: 'save recommended solution',
          description: 'save the Timefold candidate',
          recommended: true,
          payload: {
            solutionId: 'timefold',
            diff: { addedSlots: 3, removedSlots: 0, slotDelta: 3 },
          },
        },
        {
          id: 'act_save_candidate',
          type: 'save_solution',
          title: 'save candidate solution',
          description: 'save the local candidate',
          recommended: false,
          payload: {
            solutionId: 'local',
            diff: { addedSlots: 3, removedSlots: 0, slotDelta: 3 },
          },
        },
      ],
      artifacts: [
        { id: 'a_plan', type: 'solve_plan', title: '求解计划', solverPreference: 'local_only' },
        {
          id: 'a_solution',
          type: 'solve_result',
          title: '排课方案',
          score: { hardViolationCount: 0 },
          bestSolution: { id: 'timefold' },
          comparison: [
            { id: 'local', name: '本地快速方案', solverUsed: 'local_scheduler', totalScore: 82, hardViolationCount: 0 },
            { id: 'timefold', name: 'Timefold 优化方案', solverUsed: 'timefold', totalScore: 88, hardViolationCount: 0 },
          ],
          savePreview: {
            diff: {
              before: { slotCount: 0 },
              after: { slotCount: 3 },
              addedSlots: 3,
              removedSlots: 0,
              slotDelta: 3,
              unplacedDelta: 0,
            },
          },
        },
        {
          id: 'a_export',
          type: 'export_result',
          title: 'export links',
          summary: 'saved and ready to export',
          exportLinks: [
            { type: 'class', label: 'class timetable' },
            { type: 'teacher', label: 'teacher timetable' },
          ],
        },
      ],
      loading: false,
      error: null,
      input: '',
      nextAction: 'await_approval',
    },
  }));

  assert.doesNotMatch(html, /data-workflow-step="agent"/);
  assert.doesNotMatch(html, /id="tt-agent-floating"/);
  assert.doesNotMatch(html, /class="tt-agent-toggle"/);
  assert.doesNotMatch(html, /class="tt-agent-floating-panel"/);
  assert.doesNotMatch(html, /id="tt-timetable-agent-panel"/);
  assert.match(html, /id="tt-open-rule-review"/);
});

test('timetable smart agent frontend calls additive agent APIs without touching seating modules', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const apiSource = await readFile(new URL('api.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const constraintDialogStyles = await readFile(constraintDialogStylePath, 'utf8');

  assert.match(apiSource, /requestTimetableAgent/);
  assert.match(controllerSource, /startTimetableAgentSession/);
  assert.match(controllerSource, /sendTimetableAgentMessage/);
  assert.match(controllerSource, /requestTimetableAgent\('\/session'/);
  assert.match(controllerSource, /requestTimetableAgent\('\/message'/);
  assert.match(controllerSource, /requestTimetableAgent\('\/approve'/);
  assert.match(controllerSource, /buildSmartSolvePlan/);
  assert.match(controllerSource, /solvePlan:\s*{/);
  assert.match(controllerSource, /planner/);
  assert.match(interactionSource, /timetable-agent-start/);
  assert.match(interactionSource, /timetable-agent-approve/);
  assert.doesNotMatch(interactionSource, /#tt-agent-floating/);
  assert.doesNotMatch(interactionSource, /state\.agentOpen = Boolean\(event\.target\.open\)/);
  assert.doesNotMatch(styles, /\.tt-agent-panel\s*{/);
  assert.doesNotMatch(styles, /\.tt-agent-floating\s*{/);
  assert.doesNotMatch(styles, /\.tt-agent-toggle\s*{/);
  assert.doesNotMatch(styles, /\.tt-agent-floating-panel\s*{/);
  assert.match(constraintDialogStyles, /\.tt-constraint-dialog\s*{/);
  assert.match(constraintDialogStyles, /\.tt-constraint-preview\s*{/);
  assert.match(constraintDialogStyles, /\.tt-constraint-list\s*{/);
  assert.doesNotMatch(constraintDialogStyles, /\.tt-agent-floating\s*{/);
  assert.doesNotMatch(controllerSource, /seating/i);
});

test('timetable master schedule renderer indexes slots instead of rescanning for every cell', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');

  assert.match(viewSource, /createScheduleRenderContext/);
  assert.match(viewSource, /slotsByCell/);
  assert.match(viewSource, /function renderScheduleCell\(state,\s*context,\s*day,\s*period\)/);
  assert.doesNotMatch(viewSource, /function renderScheduleCell\(state,\s*day,\s*period\)[\s\S]*getSlotsAt/);
  assert.doesNotMatch(viewSource, /function renderSlot\(state,\s*slot\)[\s\S]*getSlotDetails/);
});

test('timetable interactions bind delegated hot-path listeners only once', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(interactionSource, /__ttDelegatedInteractionsBound/);
  assert.match(interactionSource, /function bindDelegatedInteractions\(container\)/);
  assert.match(interactionSource, /if \(container\.__ttDelegatedInteractionsBound\) return;/);
  assert.match(interactionSource, /container\.__ttController = controller;/);
  assert.match(interactionSource, /container\.addEventListener\('dragstart'/);
  assert.match(interactionSource, /container\.addEventListener\('drop'/);
  assert.doesNotMatch(interactionSource, /querySelectorAll\('\.tt-slot'\)/);
  assert.doesNotMatch(interactionSource, /querySelectorAll\('\.tt-cell'\)/);
});

test('timetable styles mirror the seating planner theme and font system', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-page:\s*transparent/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary:\s*#0891b2/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary-hover:\s*#06b6d4/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary-glow:\s*0 0 20px rgba\(8,\s*145,\s*178,\s*0\.35\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-base:\s*#0f172a/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-panel:\s*rgba\(30,\s*41,\s*59,\s*0\.85\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-input:\s*rgba\(15,\s*23,\s*42,\s*0\.6\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-border:\s*rgba\(148,\s*163,\s*184,\s*0\.15\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-radius-lg:\s*16px/s);
  assert.match(styles, /body\.light-mode\s+\.tt-workbench\s*{[^}]*--tt-bg-panel:\s*rgba\(255,\s*255,\s*255,\s*0\.9\)/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*font-family:\s*var\(--font-heading/s);
  assert.match(styles, /\.tt-import-text\s*{[^}]*font-family:\s*inherit/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*background:\s*var\(--tt-bg-panel\)/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*border-radius:\s*var\(--tt-radius-md\)/s);
  assert.match(styles, /\.tt-sidebar,[\s\S]*?\.tt-schedule-panel\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
  assert.match(styles, /\.tt-inspector-drawer\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
  assert.match(styles, /\.tt-btn,[\s\S]*?\.tt-icon-btn\s*{[^}]*transition:\s*all var\(--tt-transition-fast\)/s);
  assert.match(styles, /\.tt-chip\s*{[^}]*background:\s*rgba\(148,\s*163,\s*184,\s*0\.1\)/s);

  assert.doesNotMatch(styles, /--tt-bg-page:\s*#f6f7f9/i);
  assert.doesNotMatch(styles, /--tt-bg-page:\s*#111827/i);
  assert.doesNotMatch(styles, /--tt-bg-panel:\s*var\(--glass-panel/i);
  assert.doesNotMatch(styles, /--tt-shadow:\s*var\(--shadow-depth/i);
  assert.doesNotMatch(styles, /var\(--accent-gradient/i);
  assert.doesNotMatch(styles, /var\(--font-mono/i);
  assert.doesNotMatch(styles, /body:not\(\.light-mode\)\s+\.tt-workbench/);
});

test('timetable planner keeps schedule operations inside the board surface', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(viewSource, /id="tt-run-schedule"/);
  assert.match(viewSource, /id="tt-owner-select"/);
  assert.match(viewSource, /data-view-mode="class"/);
  assert.match(viewSource, /data-view-mode="teacher"/);
  assert.match(viewSource, /data-view-mode="master"/);
  assert.match(viewSource, /id="tt-lock-selected"/);
  assert.match(viewSource, /id="tt-clear-selected"/);
  assert.match(viewSource, /data-export-type="class"/);
  assert.match(viewSource, /data-export-type="teacher"/);
  assert.match(viewSource, /data-export-type="master"/);
  assert.match(viewSource, /data-export-type="plans"/);
  assert.match(viewSource, /连堂/);
  assert.match(viewSource, /旧课表已保留/);
  assert.match(controllerSource, /normalizeApiError/);
  assert.match(interactionSource, /bindGridInteractions/);
  assert.match(interactionSource, /blockId/);
});

test('timetable controller clears stale optimization jobs after saved data changes', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const mutatingMethods = [
    'saveProject',
    'importRoster',
    'saveRules',
    'adjustSlot',
    'confirmRestoreSchedule',
    'confirmPublishSchedule',
  ];

  for (const methodName of mutatingMethods) {
    assert.match(
      controllerSource,
      new RegExp(`async\\s+${methodName}\\([^)]*\\)\\s*{[\\s\\S]*?this\\.clearOptimizationPolling\\(\\);[\\s\\S]*?this\\.state\\.solverJob\\s*=\\s*null;`),
    );
  }
});

test('timetable workbench keeps solving in the board and pending plans in the inspector', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');
  const state = sampleWorkbenchState({
    lastFailure: {
      reason: 'timeout',
      message: 'Timefold 求解超时，旧课表已保留。',
      solverStats: { lessonCount: 3, timeoutSeconds: 660, durationMs: 660000 },
    },
  });
  const schedulePanel = renderSchedulePanel(state);
  const inspector = renderInspector(state);

  assert.match(viewSource, /class="tt-schedule-actions"/);
  assert.match(viewSource, /id="tt-run-schedule"/);
  assert.match(viewSource, /renderEmptyScheduleGrid/);
  assert.match(viewSource, /renderUnscheduledPlanQueue/);
  assert.doesNotMatch(schedulePanel, /class="tt-plan-queue"/);
  assert.match(schedulePanel, /class="tt-schedule-grid"/);
  assert.match(schedulePanel, /data-period="1"/);
  assert.match(schedulePanel, /data-period="7"/);
  assert.match(inspector, /class="tt-plan-queue"/);
  assert.match(inspector, /Math Teacher/);
  assert.match(inspector, /Timefold 求解超时/);

  assert.match(styles, /\.tt-schedule-body\s*{/);
  assert.match(styles, /\.tt-schedule-body\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.tt-schedule-body\s*{[^}]*align-items:\s*start/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*align-self:\s*start/s);
  assert.match(styles, /\.tt-schedule-grid\s*{[^}]*grid-auto-rows:\s*minmax\(72px,\s*auto\)/s);
  assert.match(styles, /\.tt-grid-head\s*{[^}]*min-height:\s*36px/s);
  assert.match(styles, /\.tt-plan-queue\s*{/);
  assert.match(styles, /\.tt-main-empty-cell\s*{/);
});

test('timetable schedule grid shows configured period times beside period labels', () => {
  const state = sampleWorkbenchState();
  state.project = createDefaultTimetableProject({
    activeWeekdays: [1, 2],
    activePeriods: [1, 2],
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    periodTimes: [
      { period: 1, start: '08:00', end: '08:40' },
      { period: 2, start: '08:55', end: '09:35' },
    ],
    schedule: {
      source: 'fast_constructed',
      slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
    },
  });

  const panel = renderSchedulePanel(state);

  assert.match(panel, /第1节/);
  assert.match(panel, /08:00-08:40/);
  assert.match(panel, /第2节/);
  assert.match(panel, /08:55-09:35/);
});

test('timetable manual adjustment success clears stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async adjustSlot\([\s\S]*this\.state\.lastFailure = null;/);
});

test('timetable optimization polling success clears stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async refreshOptimizationJob\([\s\S]*status === 'completed' && result\.job\.accepted[\s\S]*this\.state\.lastFailure = null;/);
  assert.match(controllerSource, /async refreshOptimizationJob\([\s\S]*else if \(result\.job\.status === 'completed'\)[\s\S]*this\.state\.lastFailure = null;/);
  assert.match(controllerSource, /async refreshOptimizationJob\([\s\S]*else if \(result\.job\.status === 'failed'\)[\s\S]*this\.state\.lastFailure = null;/);
});

test('timetable optimization polling ignores stale job responses after manual state changes', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.solverJob = { jobId: 'job-old', status: 'running' };
  controller.state.message = '手动调整中';
  let resolveJobResponse;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    await new Promise(resolve => {
      resolveJobResponse = resolve;
    });
    return {
      ok: true,
      async json() {
        return {
          success: true,
          data: {
            job: { jobId: 'job-old', status: 'completed', accepted: false, reason: 'not_better' },
          },
        };
      },
    };
  };

  try {
    const refreshPromise = controller.refreshOptimizationJob('job-old');
    await Promise.resolve();
    controller.state.solverJob = null;
    controller.state.message = '已调整。';
    resolveJobResponse();
    await refreshPromise;

    assert.deepEqual(requests, ['/api/tools/timetable/schedule/jobs/job-old']);
    assert.equal(controller.state.solverJob, null);
    assert.equal(controller.state.message, '已调整。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable optimization polling still applies current job responses', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.startOptimizationPolling = job => {
    controller._nextPolledJob = job;
  };
  controller.state.solverJob = { jobId: 'job-current', status: 'running' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => ({
    ok: true,
    async json() {
      assert.equal(String(url), '/api/tools/timetable/schedule/jobs/job-current');
      return {
        success: true,
        data: {
          job: { jobId: 'job-current', status: 'completed', accepted: false, reason: 'not_better' },
        },
      };
    },
  });

  try {
    await controller.refreshOptimizationJob('job-current');

    assert.deepEqual(controller.state.solverJob, {
      jobId: 'job-current',
      status: 'completed',
      accepted: false,
      reason: 'not_better',
    });
    assert.match(controller.state.message, /快速|课表|保留|蹇/);
    assert.equal(controller.state.lastFailure, null);
    assert.equal(controller._nextPolledJob.jobId, 'job-current');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable optimization polling explains skipped stale jobs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /\/schedule\/jobs\/job_skip$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            job: { jobId: 'job_skip', status: 'skipped', accepted: false, reason: 'stale_schedule' },
          },
        };
      },
    };
  };
  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(createDefaultTimetableProject({
      schedule: {
        id: 'schedule_1',
        source: 'fast_constructed',
        slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
      },
    }));
    controller.state.solverJob = { jobId: 'job_skip', status: 'running' };

    await controller.refreshOptimizationJob('job_skip');

    assert.equal(controller.state.message, '课表已变化，已丢弃旧优化结果。');
    assert.equal(controller.state.lastFailure, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable publish success clears stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async confirmPublishSchedule\([\s\S]*this\.state\.lastFailure = null;/);
});

test('timetable 智能 rule acceptance reuses saved rules response instead of extra bootstrap refresh', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async acceptRule\([\s\S]*const result = await requestTimetable\('\/rules'/);
  assert.match(controllerSource, /async acceptRule\([\s\S]*this\.applyProject\(result\.project\);/);
  assert.doesNotMatch(controllerSource, /async acceptRule\([\s\S]*await this\.refreshProject\(\);/);

  assert.match(controllerSource, /async acceptAllRules\([\s\S]*const result = await requestTimetable\('\/rules'/);
  assert.match(controllerSource, /async acceptAllRules\([\s\S]*this\.applyProject\(result\.project\);/);
  assert.doesNotMatch(controllerSource, /async acceptAllRules\([\s\S]*await this\.refreshProject\(\);/);
});

test('timetable legacy bulk 智能 rule acceptance keeps review-only drafts pending', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/rules/normalize')) {
      assert.deepEqual(body.draftRows.map(row => row.id), ['auto-1']);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              draftRows: [{ id: 'auto-1', status: 'effective' }],
              draftRules: { hardRules: { teacherUnavailable: { t1: ['3-5'] } }, softRules: {} },
            },
          };
        },
      };
    }
    if (String(url).endsWith('/rules')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              project: createDefaultTimetableProject({
                rules: body.rules,
              }),
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = {
      conflicts: [{ level: 'blocking', relatedRuleIds: ['conflict-1'] }],
    };
    controller.state.pendingRules = [{
      id: 'auto-1',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetId: 't1',
      targetName: 'Teacher 1',
      slots: ['3-5'],
      priority: 'hard',
      status: 'effective',
      confidence: 0.91,
      warnings: [],
    }, {
      id: 'conflict-1',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetId: 't2',
      targetName: 'Teacher 2',
      slots: ['3-5'],
      priority: 'hard',
      status: 'effective',
      confidence: 0.95,
      warnings: [],
    }, {
      id: 'review-1',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetName: 'Teacher',
      slots: ['3-5'],
      priority: 'hard',
      status: 'needs_review',
      confidence: 0.7,
      warnings: ['存在多个候选教师'],
    }, {
      id: 'unsupported-1',
      type: 'teacher_free_period_compact',
      targetType: 'global',
      status: 'unsupported',
      confidence: 0.9,
      warnings: [],
    }];

    await controller.acceptAllRules();

    assert.ok(calls.some(call => call.url.endsWith('/rules/normalize')));
    assert.ok(calls.some(call => call.url.endsWith('/rules')));
    assert.deepEqual(controller.state.pendingRules.map(row => row.id), ['conflict-1', 'review-1', 'unsupported-1']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable auto-apply only sends safe high-confidence review rows', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/rules/normalize')) {
      assert.deepEqual(body.draftRows.map(row => row.id), ['safe-1']);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              draftRows: [{ id: 'safe-1', status: 'effective' }],
              draftRules: { hardRules: { teacherUnavailable: { t1: ['3-5'] } }, softRules: {} },
              autoAcceptable: [{ id: 'safe-1', status: 'effective' }],
              needReview: [],
              warnings: [],
              unsupportedItems: [],
              conflicts: [],
            },
          };
        },
      };
    }
    if (String(url).endsWith('/rules')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              project: createDefaultTimetableProject({
                rules: body.rules,
              }),
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
      draftRows: [
        { id: 'safe-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'review-1', status: 'needs_review', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'low-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.7, warnings: [] },
        { id: 'suggestion-1', status: 'suggestion', type: 'teacher_load_balance', confidence: 0.95, warnings: [] },
      ],
      autoAcceptable: [
        { id: 'safe-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'review-1', status: 'needs_review', type: 'teacher_unavailable', confidence: 0.91, warnings: [] },
        { id: 'low-1', status: 'effective', type: 'teacher_unavailable', confidence: 0.7, warnings: [] },
        { id: 'suggestion-1', status: 'suggestion', type: 'teacher_load_balance', confidence: 0.95, warnings: [] },
      ],
      needReview: [],
      warnings: [],
      unsupportedItems: [],
      conflicts: [],
    };

    await controller.applyAutoAcceptableRules();

    assert.ok(calls.some(call => call.url.endsWith('/rules/normalize')));
    assert.ok(calls.some(call => call.url.endsWith('/rules')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable successful data and rule mutations clear stale solve failure state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const mutatingMethods = [
    'saveProject',
    'importRoster',
    'clearRoster',
    'saveRules',
    'acceptAllRules',
    'confirmRuleDraft',
    'removeSavedRule',
    'clearRules',
    'addLockedSlot',
    'removeLockedSlot',
    'confirmRestoreSchedule',
  ];

  for (const methodName of mutatingMethods) {
    const methodSource = extractMethodSource(controllerSource, methodName);
    assert.match(methodSource, /this\.state\.lastFailure\s*=\s*null;/);
  }
});

test('timetable mutations that invalidate the current draft clear selected slot state', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const selectionResetMethods = [
    'saveProject',
    'importRoster',
    'clearRoster',
    'saveRules',
    'confirmRuleDraft',
    'removeSavedRule',
    'clearRules',
    'addLockedSlot',
    'removeLockedSlot',
    'confirmRestoreSchedule',
  ];

  for (const methodName of selectionResetMethods) {
    const methodSource = extractMethodSource(controllerSource, methodName);
    assert.match(methodSource, /this\.state\.selectedSlotId\s*=\s*'';/);
  }
});

test('timetable clearRuleDraft clears pending 智能 rule cards and expanded editor state', () => {
  const controller = new TimetablePlannerController();
  controller.state.pendingRules = [{ id: 'draft-1' }];
  controller.state.expandedRuleId = 'draft-1';
  controller.state.ruleDraft = { hardRules: {}, softRules: {} };
  controller.state.ruleDraftPreview = [{ id: 'preview-1' }];
  controller.state.ruleWarnings = [{ message: 'warn' }];
  controller.state.ruleReview = {
    ...controller.state.ruleReview,
    open: true,
    draftRows: [{ id: 'draft-1' }],
  };

  controller.clearRuleDraft();

  assert.deepEqual(controller.state.pendingRules, []);
  assert.equal(controller.state.expandedRuleId, null);
  assert.equal(controller.state.ruleDraft, null);
  assert.deepEqual(controller.state.ruleDraftPreview, []);
  assert.deepEqual(controller.state.ruleWarnings, []);
  assert.equal(controller.state.ruleReview.open, false);
  assert.deepEqual(controller.state.ruleReview.draftRows, []);
});

test('timetable applyProject clears stale selected and drag slot state when the schedule changes', () => {
  const controller = new TimetablePlannerController();
  controller.state.selectedSlotId = 'slot-old';
  controller.state.dragSlotId = 'slot-old';
  controller.state.dragBlockId = 'block-old';
  controller.state.viewMode = 'class';
  controller.state.selectedOwnerId = 'c1';

  controller.applyProject(createDefaultTimetableProject({
    teachers: [{ id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 }],
    schedule: {
      id: 'schedule-new',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-new',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't1',
        teacherIds: ['t1'],
        lessonPlanId: 'lp1',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  }));

  assert.equal(controller.state.selectedSlotId, '');
  assert.equal(controller.state.dragSlotId, '');
  assert.equal(controller.state.dragBlockId, '');
});

test('timetable applyProject preserves active selected and drag slot state when the slot still exists', () => {
  const controller = new TimetablePlannerController();
  controller.state.selectedSlotId = 'slot-1';
  controller.state.dragSlotId = 'slot-1';
  controller.state.dragBlockId = 'block-1';
  controller.state.viewMode = 'class';
  controller.state.selectedOwnerId = 'c1';

  controller.applyProject(createDefaultTimetableProject({
    teachers: [{ id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 }],
    schedule: {
      id: 'schedule-current',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't1',
        teacherIds: ['t1'],
        lessonPlanId: 'lp1',
        blockId: 'block-1',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  }));

  assert.equal(controller.state.selectedSlotId, 'slot-1');
  assert.equal(controller.state.dragSlotId, 'slot-1');
  assert.equal(controller.state.dragBlockId, 'block-1');
});

test('timetable applyProject clears selected and drag slot state when the slot is no longer visible in the current view', () => {
  const controller = new TimetablePlannerController();
  controller.state.selectedSlotId = 'slot-1';
  controller.state.dragSlotId = 'slot-1';
  controller.state.dragBlockId = 'block-1';
  controller.state.viewMode = 'teacher';
  controller.state.selectedOwnerId = 't1';

  controller.applyProject(createDefaultTimetableProject({
    teachers: [
      { id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] },
      { id: 't2', name: 'Teacher 2', subjects: ['s1'], unavailableSlots: [] },
    ],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't2', weeklyHours: 3 }],
    schedule: {
      id: 'schedule-current',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't2',
        teacherIds: ['t2'],
        lessonPlanId: 'lp1',
        blockId: 'block-1',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  }));

  assert.equal(controller.state.selectedOwnerId, 't1');
  assert.equal(controller.state.selectedSlotId, '');
  assert.equal(controller.state.dragSlotId, '');
  assert.equal(controller.state.dragBlockId, '');
});

test('timetable applyProject closes stale publication history and restore dialogs when their target version disappears', () => {
  const controller = new TimetablePlannerController();
  controller.state.publicationHistoryDialog = { open: true, version: 1 };
  controller.state.restoreDialog = {
    open: true,
    mode: 'history',
    version: 1,
    targetLabel: 'Publication history V1',
    summary: { total: 1 },
    loading: false,
  };

  controller.applyProject(createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [],
      },
    },
  }));

  assert.deepEqual(controller.state.publicationHistoryDialog, { open: false, version: null });
  assert.deepEqual(controller.state.restoreDialog, {
    open: false,
    mode: '',
    version: null,
    targetLabel: '',
    summary: null,
    loading: false,
  });
});

test('timetable applyProject preserves publication dialogs when their target version still exists', () => {
  const controller = new TimetablePlannerController();
  controller.state.publicationHistoryDialog = { open: true, version: '1' };
  controller.state.restoreDialog = {
    open: true,
    mode: 'history',
    version: '1',
    targetLabel: 'Publication history V1',
    summary: { total: 1 },
    loading: false,
  };

  controller.applyProject(createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          snapshot: { scheduleId: 'published-v1', slotCount: 0, slots: [] },
        }],
      },
    },
  }));

  assert.deepEqual(controller.state.publicationHistoryDialog, { open: true, version: 1 });
  assert.deepEqual(controller.state.restoreDialog, {
    open: true,
    mode: 'history',
    version: 1,
    targetLabel: 'Publication history V1',
    summary: { total: 1 },
    loading: false,
  });
});

test('timetable applyProject closes an open publish dialog when the new schedule is not ready', () => {
  const controller = new TimetablePlannerController();
  controller.state.publishDialog = { open: true, note: 'ready before mutation', loading: false };

  controller.applyProject(createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    schedule: {
      id: 'blocked-after-mutation',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      publication: {
        ok: false,
        reason: 'publication_blocked',
        blockingIssues: [{ type: 'incomplete_schedule', message: 'unplaced lesson' }],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 0, unplacedLessons: 1, hardConflicts: 0 },
      },
      score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 0, totalLessons: 1, completeness: 0 },
    },
  }));

  assert.deepEqual(controller.state.publishDialog, { open: false, note: '', loading: false });
});

test('timetable restore dialog refuses missing publication history versions before confirmation', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [],
      },
    },
  });

  controller.openRestoreDialog('history', 1);

  assert.deepEqual(controller.state.restoreDialog, {
    open: false,
    mode: '',
    version: null,
    targetLabel: '',
    summary: null,
    loading: false,
  });
  assert.match(controller.state.message, /1/);
});

test('timetable latest restore dialog still opens for legacy published projects without a saved snapshot', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schedule: {
      id: 'legacy-published',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 3,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'legacy-published',
        note: 'legacy published without snapshot',
      },
    },
  });

  controller.openRestoreDialog('latest', 3);

  assert.equal(controller.state.restoreDialog.open, true);
  assert.equal(controller.state.restoreDialog.mode, 'latest');
  assert.equal(controller.state.restoreDialog.version, 3);
  assert.match(controller.state.restoreDialog.targetLabel, /3/);
});

test('timetable publication history dialog refuses missing history versions before rendering', () => {
  const controller = new TimetablePlannerController();
  controller.state.project = createDefaultTimetableProject({
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 0, completeness: 100 },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        snapshot: { scheduleId: 'published-current', slotCount: 0, slots: [] },
        history: [],
      },
    },
  });

  controller.openPublicationHistoryDialog(1);

  assert.deepEqual(controller.state.publicationHistoryDialog, { open: false, version: null });
  assert.match(controller.state.message, /1/);
});

test('timetable syncPendingRuleDraftState keeps 智能 draft review state aligned', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't1', name: 'Teacher 1', subjects: ['s1'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 's1', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 }],
  });
  controller.state.ruleReview = {
    ...controller.state.ruleReview,
    open: true,
    step: 'review',
    mode: 'file',
    inputType: 'xlsx_constraints',
    contextStats: { rowCount: 2 },
    warnings: ['warn-1'],
    unsupportedItems: [{ id: 'u1', type: 'suggestion' }],
  };
  controller.state.ruleWarnings = ['warn-1'];
  controller.state.ruleUnsupportedItems = [{ id: 'u1', type: 'suggestion' }];
  controller.state.expandedRuleId = 'draft-2';
  controller.state.ruleDraft = { hardRules: { teacherUnavailable: { t1: ['1-1'] } }, softRules: {} };

  controller.syncPendingRuleDraftState([
    { id: 'draft-1', type: 'teacher_unavailable', targetName: 'Teacher 1', status: 'effective', slots: ['1-1'] },
    { id: 'draft-2', type: 'class_unavailable', targetName: 'G7 1', status: 'needs_review', slots: ['2-2'] },
  ]);

  assert.deepEqual(controller.state.pendingRules.map(item => item.id), ['draft-1', 'draft-2']);
  assert.equal(controller.state.expandedRuleId, 'draft-2');
  assert.equal(controller.state.ruleDraft, null);
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'review');
  assert.equal(controller.state.ruleReview.inputType, 'xlsx_constraints');
  assert.deepEqual(controller.state.ruleReview.warnings, ['warn-1']);
  assert.equal(controller.state.ruleDraftPreview.length, 2);

  controller.syncPendingRuleDraftState([], { keepDialogOpen: true });

  assert.deepEqual(controller.state.pendingRules, []);
  assert.equal(controller.state.expandedRuleId, null);
  assert.equal(controller.state.ruleDraft, null);
  assert.deepEqual(controller.state.ruleWarnings, []);
  assert.deepEqual(controller.state.ruleUnsupportedItems, []);
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'input');
});

test('timetable syncPendingRuleDraftState drops stale unsupported 智能 items when draft rows shrink', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject();
  controller.state.ruleReview = {
    ...controller.state.ruleReview,
    open: true,
    step: 'review',
    mode: 'file',
    inputType: 'xlsx_constraints',
    unsupportedItems: [
      { id: 'draft-suggestion', type: 'teacher_load_balance', description: 'keep me if still present' },
      { id: 'draft-removed', type: 'spread_hint', description: 'should disappear with removed row' },
    ],
  };
  controller.state.ruleUnsupportedItems = [
    { id: 'draft-suggestion', type: 'teacher_load_balance', description: 'keep me if still present' },
    { id: 'draft-removed', type: 'spread_hint', description: 'should disappear with removed row' },
  ];

  controller.syncPendingRuleDraftState([
    {
      id: 'draft-suggestion',
      type: 'teacher_load_balance',
      targetName: 'All teachers',
      status: 'suggestion',
      slots: [],
      description: 'keep me if still present',
    },
    {
      id: 'draft-effective',
      type: 'teacher_unavailable',
      targetName: 'Teacher 1',
      status: 'effective',
      slots: ['1-1'],
    },
  ]);

  assert.deepEqual(
    controller.state.ruleUnsupportedItems.map(item => item.id),
    ['draft-suggestion'],
  );
  assert.deepEqual(
    controller.state.ruleReview.unsupportedItems.map(item => item.id),
    ['draft-suggestion'],
  );
});

test('timetable inspector renders scheduling audit and quality suggestions', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'audit-schedule',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        audit: {
          blockingIssues: [],
          warnings: [{ type: 'teacher_load', message: 'Math Teacher load is high' }],
          bottlenecks: { teachers: [{ id: 't_math', name: 'Math Teacher', utilization: 86 }] },
          capacity: { totalLessons: 3, availableSlots: 35 },
        },
        qualityIssues: [
          { type: 'teacher_consecutive', severity: 'warning', message: 'Math Teacher has too many consecutive lessons' },
        ],
        score: {
          hardConflicts: 0,
          unplacedLessons: 0,
          placedLessons: 3,
          totalLessons: 3,
          completeness: 100,
          softSatisfaction: 74,
          softBreakdown: { teacherConsecutive: 60, classDailyBalance: 75 },
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /Math Teacher load is high/);
  assert.match(inspector, /教师负载/);
  assert.match(inspector, /Math Teacher has too many consecutive lessons/);
  assert.match(inspector, /教师连续课/);
  assert.match(inspector, /班级日负载/);
  assert.match(inspector, /诊断问题/);
  assert.match(inspector, /持续关注/);
  assert.match(inspector, /tt-inspector-issue-item/);
  assert.match(inspector, /tt-schedule-diagnostic-item is-warning/);
  assert.doesNotMatch(inspector, /teacher_load/);
  assert.doesNotMatch(inspector, /teacherConsecutive/);
  assert.doesNotMatch(inspector, /classDailyBalance/);
});

test('timetable inspector shows publication readiness before export', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'publish-check',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', reason: 'missing slots' }],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [{ type: 'incomplete_schedule', message: '还有课时未排入课表。' }],
          reviewItems: [
            { type: 'manual_review', severity: 'warning', targetKind: 'schedule', targetName: '课表', message: '请教务复核。' },
            { type: 'teacher_load', severity: 'warning', targetKind: 'teacher', targetName: 'Math Teacher', message: 'Math Teacher 负载接近满载。' },
            { type: 'incomplete_schedule', severity: 'error', targetKind: 'class', targetName: 'G7 1', message: 'G7 1 还有 2 节未排。' },
          ],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /发布前校验/);
  assert.match(inspector, /不可发布/);
  assert.match(inspector, /未排课时/);
  assert.match(inspector, /教务复核/);
  assert.doesNotMatch(inspector, /incomplete_schedule/);
  assert.doesNotMatch(inspector, /manual_review/);
  assert.match(inspector, /Math Teacher 负载接近满载/);
  assert.match(inspector, /G7 1 还有 2 节未排/);
  assert.match(inspector, /发布问题/);
  assert.match(inspector, /必须先处理/);
  assert.match(inspector, /建议发布前复核/);
  assert.match(inspector, /tt-inspector-issue-item/);
  assert.match(inspector, /tt-publication-issue-item is-error/);
  assert.match(inspector, /tt-publication-issue-item is-warning/);
  assert.match(inspector, /1\/3/);
});

test('timetable workflow exposes publish action and published status', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'publish-ready',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [],
          reviewItems: [],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /id="tt-publish-schedule"/);
  assert.match(html, /data-publish-schedule/);
  assert.match(html, /发布课表/);
  assert.match(html, /未发布/);
  assert.doesNotMatch(html, /id="tt-publish-schedule"[^>]*disabled/);
});

test('timetable publish uses a confirmation dialog with editable note', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const closed = renderWorkbench(sampleWorkbenchState());
  const open = renderWorkbench(sampleWorkbenchState({
    publishDialog: {
      open: true,
      note: '教务主任确认',
      loading: false,
    },
  }));

  assert.match(closed, /id="tt-publish-schedule"/);
  assert.doesNotMatch(closed, /id="tt-publish-dialog"/);
  assert.match(open, /id="tt-publish-dialog"/);
  assert.match(open, /id="tt-publish-note"/);
  assert.match(open, /教务主任确认/);
  assert.match(open, /id="tt-confirm-publish"/);
  assert.match(controllerSource, /openPublishDialog\(/);
  assert.match(controllerSource, /confirmPublishSchedule\(/);
  assert.match(controllerSource, /JSON\.stringify\(\{\s*note\s*:\s*this\.state\.publishDialog\?\.note/s);
  assert.doesNotMatch(controllerSource, /JSON\.stringify\(\{\s*note:\s*''\s*\}\)/);
  assert.match(interactionSource, /#tt-publish-schedule[\s\S]*openPublishDialog\(\)/);
  assert.match(interactionSource, /#tt-confirm-publish[\s\S]*confirmPublishSchedule\(\)/);
});

test('timetable publish dialog refuses schedules that are not publication-ready', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    schedule: {
      id: 'not-ready-publish',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math' }],
      publication: {
        ok: false,
        reason: 'publication_blocked',
        blockingIssues: [{ type: 'incomplete_schedule', message: 'unplaced lesson' }],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0 },
      },
      score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
    },
  });

  controller.openPublishDialog();

  assert.deepEqual(controller.state.publishDialog, { open: false, note: '', loading: false });
  assert.ok(controller.state.message);
});

test('timetable smart workbench keeps not-ready schedules in diagnosis instead of opening publish', () => {
  const controller = new TimetablePlannerController();
  let closed = false;
  let published = false;
  controller.renderSmartWorkbenchSurface = () => {};
  controller.closeSmartWorkbench = () => { closed = true; };
  controller.openPublishDialog = () => { published = true; };
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    schedule: {
      id: 'not-ready-smart-publish',
      source: 'fast_constructed',
      slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
      conflicts: [],
      unplaced: [{ lessonPlanId: 'lp_math' }],
      publication: {
        ok: false,
        summary: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0 },
        issues: [{ message: 'unplaced lesson' }],
      },
      score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
    },
  });
  controller.state.smartWorkbench = createConstraintDialogState({ open: true, stage: 'solution_review' });

  controller.openSmartPublish();

  assert.equal(closed, false);
  assert.equal(published, false);
  assert.equal(controller.state.smartWorkbench.open, true);
  assert.equal(controller.state.smartWorkbench.stage, 'diagnosing');
  assert.match(controller.state.smartWorkbench.diagnosis.summary, /不能保存|not/i);
});

test('timetable smart workbench sends incomplete generated schedules to diagnosis', async () => {
  const controller = new TimetablePlannerController();
  controller.renderSmartWorkbenchSurface = () => {};
  controller.render = () => {};
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
  });
  controller.state.smartWorkbench = createConstraintDialogState({ open: true, stage: 'waiting_solve_approval' });
  controller.runSchedule = async () => {
    controller.applyProject(createDefaultTimetableProject({
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
      schedule: {
        id: 'incomplete-generated',
        source: 'fast_constructed',
        slots: [{ id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
        conflicts: [],
        unplaced: [{ lessonPlanId: 'lp_math' }],
        publication: {
          ok: false,
          summary: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0 },
          issues: [{ message: 'unplaced lesson' }],
        },
        score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
      },
    }));
    controller.state.lastFailure = null;
  };

  await controller.runSmartSchedule();

  assert.equal(controller.state.smartWorkbench.stage, 'diagnosing');
  assert.equal(controller.state.smartWorkbench.candidates.length, 1);
  assert.match(controller.state.smartWorkbench.diagnosis.summary, /不能保存|not/i);
});

test('timetable restore published actions use a confirmation dialog with overwrite summary', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'draft-changed',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-current-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-03T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        snapshot: {
          scheduleId: 'published-current',
          slotCount: 1,
          fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
          slots: [{
            id: 'slot-published-1',
            day: 1,
            period: 1,
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            teacherIds: ['t_math'],
            lessonPlanId: 'lp_math',
          }],
        },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          note: '第一次发布',
          fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
          snapshot: {
            scheduleId: 'published-v1',
            slotCount: 1,
            fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
            slots: [{
              id: 'slot-v1-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });

  const closed = renderWorkbench(sampleWorkbenchState({ project }));
  const open = renderWorkbench(sampleWorkbenchState({
    project,
    restoreDialog: {
      open: true,
      mode: 'latest',
      version: 2,
      loading: false,
      targetLabel: '发布版 V2',
      summary: { moved: 1, changed: 0, added: 0, removed: 0, total: 1 },
    },
  }));

  assert.doesNotMatch(closed, /id="tt-restore-dialog"/);
  assert.match(open, /id="tt-restore-dialog"/);
  assert.match(open, /恢复发布版/);
  assert.match(open, /发布版 V2/);
  assert.match(open, /当前草稿将被覆盖/);
  assert.match(open, /移动 1/);
  assert.match(open, /id="tt-confirm-restore"/);
  assert.match(controllerSource, /openRestoreDialog\(/);
  assert.match(controllerSource, /confirmRestoreSchedule\(/);
  assert.match(controllerSource, /restorePublicationHistoryVersion\([^)]*\)\s*\{/);
  assert.match(controllerSource, /restoreLatestPublishedSnapshot\(\)\s*\{/);
  assert.doesNotMatch(controllerSource, /requestTimetable\('\/schedule\/published\/restore'[\s\S]*restorePublicationHistoryVersion\(/);
  assert.match(interactionSource, /#tt-restore-publication-history[\s\S]*openRestoreDialog/);
  assert.match(interactionSource, /\[data-restore-published-snapshot\][\s\S]*openRestoreDialog\('latest', button\.dataset\.restorePublishedVersion\)/);
  assert.match(interactionSource, /#tt-confirm-restore[\s\S]*confirmRestoreSchedule/);
});

test('timetable publish confirmation surfaces review warnings before publishing', () => {
  const open = renderWorkbench(sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'publish-with-warnings',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [{
            type: 'publication_fingerprint_mismatch',
            targetName: '发布历史 V1',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          reviewItems: [{
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
    publishDialog: {
      open: true,
      note: '',
      loading: false,
    },
  }));

  assert.match(open, /id="tt-publish-dialog"/);
  assert.match(open, /发布提醒/);
  assert.match(open, /发布历史 V1/);
  assert.match(open, /发布快照校验失败/);
  assert.match(open, /Math Teacher/);
  assert.match(open, /负载接近满载/);
  assert.doesNotMatch(open, /publication_fingerprint_mismatch/);
  assert.doesNotMatch(open, /teacher_load/);
});

test('timetable publish confirmation surfaces published snapshot backfill warning in human text', () => {
  const open = renderWorkbench(sampleWorkbenchState({
    schedule: {
      id: 'publish-with-backfill-warning',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'published',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'published_snapshot_backfill_needed',
          targetName: '发布快照',
          message: '当前已发布版本缺少发布快照，系统会在导出、恢复或重新发布前自动补修。',
        }],
        reviewItems: [{
          type: 'published_snapshot_backfill_needed',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '发布快照',
          message: '当前已发布版本缺少发布快照，系统会在导出、恢复或重新发布前自动补修。',
        }],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'publish-with-backfill-warning',
        note: 'legacy publish',
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
    publishDialog: {
      open: true,
      note: '',
      loading: false,
    },
  }));

  assert.match(open, /id="tt-publish-dialog"/);
  assert.match(open, /发布快照/);
  assert.match(open, /自动补修/);
  assert.doesNotMatch(open, /published_snapshot_backfill_needed/);
});

test('timetable workflow disables official exports when published draft changed', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'draft-changed',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [],
          reviewItems: [],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'draft_changed',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-1',
          note: '教务处确认发布',
          snapshot: {
            scheduleId: 'published-1',
            slotCount: 1,
            score: { completeness: 100 },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /草稿已变化/);
  assert.match(html, /请重新发布后导出正式课表/);
  assert.match(html, /data-export-type="class"[^>]*disabled/);
  assert.match(html, /data-export-type="teacher"[^>]*disabled/);
  assert.match(html, /data-export-type="master"[^>]*disabled/);
  assert.match(html, /导出发布版/);
  assert.match(html, /data-export-type="published_class"/);
  assert.match(html, /data-export-type="published_teacher"/);
  assert.match(html, /data-export-type="published_master"/);
  assert.doesNotMatch(html, /data-export-type="plans"[^>]*disabled/);
});

test('timetable workflow explains missing published snapshot when a changed draft cannot restore the published version', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'draft-changed-missing-published-snapshot',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [{
            type: 'published_snapshot_missing',
            targetName: '发布快照',
            message: '上一版发布快照缺失，当前只能重新发布，暂时无法恢复或导出发布版。',
          }],
          reviewItems: [{
            type: 'published_snapshot_missing',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '发布快照',
            message: '上一版发布快照缺失，当前只能重新发布，暂时无法恢复或导出发布版。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'draft_changed',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-1',
          note: '教务处确认发布',
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.match(html, /草稿已变化/);
  assert.doesNotMatch(html, /data-export-type="published_class"/);
  assert.doesNotMatch(html, /id="tt-restore-published-snapshot"/);
  assert.match(html, /上一版发布快照缺失/);
  assert.match(inspector, /发布快照/);
  assert.match(inspector, /暂时无法恢复或导出发布版/);
  assert.doesNotMatch(html, /published_snapshot_missing/);
});

test('timetable workflow keeps published restore/export entry when current draft was cleared but archive remains', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [],
      classes: [],
      subjects: [],
      lessonPlans: [],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'archive-only-draft',
        generatedAt: '2026-01-03T00:00:00.000Z',
        source: 'published',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: null,
        published: {
          status: 'draft_changed',
          version: 3,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-3',
          note: '教务处确认发布',
          snapshot: {
            scheduleId: 'published-3',
            slotCount: 1,
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
            projectContext: {
              schoolName: 'UI School',
              term: '2026',
              weekdays: 5,
              periodsPerDay: 7,
              activeWeekdays: [1, 2, 3, 4, 5],
              activePeriods: [1, 2, 3, 4, 5, 6, 7],
              teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
              classes: [{ id: 'c1', grade: 'G7', name: '1' }],
              subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
              lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
              rules: { hardRules: {}, softRules: {} },
            },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: {},
      },
    }),
  });

  const html = renderWorkbench(state);
  const inspector = renderInspector(state);

  assert.match(html, /当前工作草稿已清空，仍可恢复或导出已发布版本。/);
  assert.match(html, /data-restore-published-snapshot="latest"/);
  assert.match(html, /data-export-type="published_class"/);
  assert.match(html, /data-export-type="published_teacher"/);
  assert.match(html, /data-export-type="published_master"/);
  assert.match(html, /当前草稿已清空/);
  assert.match(inspector, /发布归档/);
  assert.match(inspector, /已清空，仍可恢复或导出已发布版本/);
});

test('timetable archive-only draft does not fall back to roster-import readiness copy', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [],
      classes: [],
      subjects: [],
      lessonPlans: [],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'archive-only-topbar',
        generatedAt: '2026-01-03T00:00:00.000Z',
        source: 'published',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: null,
        published: {
          status: 'draft_changed',
          version: 3,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-3',
          snapshot: {
            scheduleId: 'published-3',
            slotCount: 1,
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
            projectContext: {
              schoolName: 'UI School',
              term: '2026',
              weekdays: 5,
              periodsPerDay: 7,
              activeWeekdays: [1, 2, 3, 4, 5],
              activePeriods: [1, 2, 3, 4, 5, 6, 7],
              teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
              classes: [{ id: 'c1', grade: 'G7', name: '1' }],
              subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
              lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
              rules: { hardRules: {}, softRules: {} },
            },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: {},
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(html, /来源<\/span><strong>草稿已变化<\/strong>/);
  assert.match(html, /data-restore-published-snapshot="latest"/);
  assert.doesNotMatch(html, /待导入任课/);
  assert.doesNotMatch(html, /请先导入任课数据。/);
});

test('timetable workflow treats published status with slot drift as draft changed', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-drift',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'published',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-1',
        note: '教务处确认发布',
        snapshot: {
          scheduleId: 'published-1',
          slotCount: 1,
          score: { completeness: 100 },
          slots: [{
            id: 'slot-1',
            day: 1,
            period: 1,
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            teacherIds: ['t_math'],
            lessonPlanId: 'lp_math',
          }],
        },
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({ project }));
  const status = getSolveStatus(project);

  assert.equal(status.sourceLabel, '草稿已变化');
  assert.match(html, /草稿已变化/);
  assert.doesNotMatch(html, /<span>来源<\/span><strong>已发布<\/strong>/);
  assert.match(html, /<span>来源<\/span><strong>草稿已变化<\/strong>/);
  assert.match(html, /发布差异/);
  assert.match(html, /请重新发布后导出正式课表/);
  assert.match(buttonTag(html, 'data-export-type="class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="master"'), /disabled/);
});

test('timetable workflow disables official exports until the schedule is published', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'ready-unpublished',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: null,
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({ project }));

  assert.match(html, /请先发布课表后导出正式课表/);
  assert.match(buttonTag(html, 'data-export-type="class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="master"'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'data-export-type="plans"'), /disabled/);
});

test('timetable workflow disables published snapshot export and restore when fingerprint is known bad', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'bad-published-snapshot',
        generatedAt: '2026-01-03T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 2,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: true,
          reason: 'ready',
          blockingIssues: [],
          warnings: [{
            type: 'publication_fingerprint_mismatch',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          reviewItems: [{
            type: 'publication_fingerprint_mismatch',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          status: 'draft_changed',
          version: 1,
          publishedAt: '2026-01-02T08:00:00.000Z',
          scheduleId: 'published-1',
          note: '教务处确认发布',
          fingerprint: 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
          snapshot: {
            scheduleId: 'published-1',
            slotCount: 1,
            fingerprint: 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
            score: { completeness: 100 },
            slots: [{
              id: 'slot-1',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            }],
          },
        },
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      },
    }),
  });

  const html = renderWorkbench(state);

  assert.match(buttonTag(html, 'data-export-type="published_class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="published_teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="published_master"'), /disabled/);
  assert.match(buttonTag(html, 'id="tt-restore-published-snapshot"'), /disabled/);
  assert.match(html, /发布快照校验失败，请重新发布后再导出或恢复。/);
  assert.match(buttonTag(html, 'id="tt-publish-schedule"'), /data-publish-schedule/);
  assert.doesNotMatch(buttonTag(html, 'id="tt-publish-schedule"'), /disabled/);
  assert.doesNotMatch(html, /publication_fingerprint_mismatch/);
});

test('timetable inspector explains published and changed draft states', () => {
  const publishedProject = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-1',
        note: '教务处确认发布',
        fingerprint: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        snapshot: {
          scheduleId: 'published-1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: 'fast_constructed',
          slotCount: 12,
          fingerprint: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 12, placedLessons: 12, unplacedLessons: 0, hardConflicts: 0 },
          slots: [],
        },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-0',
          note: '第一次发布',
          fingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          snapshot: {
            scheduleId: 'published-0',
            slotCount: 10,
            fingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 10, placedLessons: 10, unplacedLessons: 0, hardConflicts: 0 },
            slots: [],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
    },
  });

  const publishedInspector = renderInspector(sampleWorkbenchState({ project: publishedProject }));
  const changedInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        published: {
          ...publishedProject.schedule.published,
          status: 'draft_changed',
        },
      },
    },
  }));
  const restoredInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        source: 'published_history_restored',
        publication: {
          ...publishedProject.schedule.publication,
          warnings: [{
            type: 'restored_published_draft',
            message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
          }],
          reviewItems: [{
            type: 'restored_published_draft',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '恢复发布版',
            message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
        published: {
          ...publishedProject.schedule.published,
          status: 'draft_changed',
        },
      },
    },
  }));

  assert.match(publishedInspector, /发布状态/);
  assert.match(publishedInspector, /发布归档/);
  assert.match(publishedInspector, /已发布/);
  assert.match(publishedInspector, /已发布 V1/);
  assert.match(publishedInspector, /来源<\/b>已发布/);
  assert.match(publishedInspector, /教务处确认发布/);
  assert.match(publishedInspector, /发布指纹/);
  assert.match(publishedInspector, /1234567890ab/);
  assert.match(publishedInspector, /发布快照/);
  assert.match(publishedInspector, /12 节/);
  assert.match(publishedInspector, /发布历史/);
  assert.match(publishedInspector, /V1/);
  assert.match(publishedInspector, /第一次发布/);
  assert.match(publishedInspector, /10 节/);
  assert.match(changedInspector, /草稿已变化/);
  assert.match(changedInspector, /发布已失效/);
  assert.match(restoredInspector, /恢复发布版/);
  assert.match(restoredInspector, /重新发布前建议教务复核/);
  assert.doesNotMatch(restoredInspector, /restored_published_draft/);

  const republishedInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        source: 'published',
        publication: {
          ...publishedProject.schedule.publication,
          warnings: [],
          reviewItems: [],
        },
        published: {
          ...publishedProject.schedule.published,
          status: 'published',
        },
        solverStats: {
          phase: 'published',
          status: 'accepted',
          accepted: true,
          reason: null,
          restoredPublishedDraft: true,
          restoredVersion: 1,
          restoredScheduleId: 'published-1',
        },
      },
    },
  }));
  const republishedStatus = getSolveStatus({
    ...publishedProject,
    schedule: {
      ...publishedProject.schedule,
      source: 'published',
      published: {
        ...publishedProject.schedule.published,
        status: 'published',
      },
      solverStats: {
        phase: 'published',
        status: 'accepted',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 1,
        restoredScheduleId: 'published-1',
      },
    },
  });

  assert.equal(republishedStatus.sourceLabel, '已发布');
  assert.match(republishedInspector, /<b>来源<\/b>已发布/);
  assert.doesNotMatch(republishedInspector, /恢复发布版/);

  const fingerprintFailedInspector = renderInspector(sampleWorkbenchState({
    project: {
      ...publishedProject,
      schedule: {
        ...publishedProject.schedule,
        publication: {
          ...publishedProject.schedule.publication,
          ok: true,
          reason: 'ready',
          warnings: [{
            type: 'publication_fingerprint_mismatch',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          reviewItems: [{
            type: 'publication_fingerprint_mismatch',
            severity: 'warning',
            targetKind: 'schedule',
            targetName: '发布快照',
            message: '发布快照校验失败，请重新发布后再导出或恢复。',
          }],
          summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
        },
      },
    },
  }));
  assert.match(fingerprintFailedInspector, /发布快照校验/);
  assert.match(fingerprintFailedInspector, /重新发布后再导出或恢复/);
  assert.doesNotMatch(fingerprintFailedInspector, /publication_fingerprint_mismatch/);
});

test('timetable publication history opens a detail dialog for snapshot review', async () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        snapshot: { scheduleId: 'published-current', slotCount: 2, fingerprint: '2222222222222222222222222222222222222222222222222222222222222222', slots: [] },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          note: '第一次发布',
          fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
          snapshot: {
            scheduleId: 'published-v1',
            slotCount: 2,
            fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
            slots: [
              {
                id: 'slot-v1-1',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math'],
                lessonPlanId: 'lp_math',
              },
            ],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const state = sampleWorkbenchState({
    project,
    publicationHistoryDialog: { open: true, version: 1 },
  });
  const html = renderWorkbench(state);
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(html, /data-publication-history-version="1"/);
  assert.match(html, /id="tt-publication-history-dialog"/);
  assert.match(html, /V1/);
  assert.match(html, /published-v1/);
  assert.match(html, /发布指纹/);
  assert.match(html, /111111111111/);
  assert.match(html, /Math Teacher/);
  assert.match(html, /1-1/);
  assert.match(html, /id="tt-restore-publication-history"/);
  assert.match(html, /data-export-history-type="published_class"/);
  assert.match(html, /data-export-history-type="published_teacher"/);
  assert.match(html, /data-export-history-type="published_master"/);
  assert.match(controllerSource, /openPublicationHistoryDialog\(/);
  assert.match(controllerSource, /closePublicationHistoryDialog\(/);
  assert.match(controllerSource, /restorePublicationHistoryVersion\(/);
  assert.match(controllerSource, /openRestoreDialog\(/);
  assert.match(controllerSource, /confirmRestoreSchedule\(/);
  assert.match(controllerSource, /publishedVersion/);
  assert.match(controllerSource, /requestTimetable\('\/schedule\/published\/restore'/);
  assert.match(interactionSource, /data-publication-history-version[\s\S]*openPublicationHistoryDialog/);
  assert.match(interactionSource, /#tt-restore-publication-history[\s\S]*openRestoreDialog/);
  assert.match(interactionSource, /data-export-history-type[\s\S]*export\(button\.dataset\.exportHistoryType/);
  assert.match(interactionSource, /#tt-close-publication-history[\s\S]*closePublicationHistoryDialog/);
});

test('timetable publication history disables export and restore when history fingerprint is known bad', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'fast_constructed',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'publication_fingerprint_mismatch',
          targetName: '发布历史 V1',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        reviewItems: [{
          type: 'publication_fingerprint_mismatch',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '发布历史 V1',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        snapshot: {
          scheduleId: 'published-current',
          slotCount: 2,
          fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
          slots: [],
        },
        history: [{
          version: 1,
          publishedAt: '2026-01-01T08:00:00.000Z',
          scheduleId: 'published-v1',
          note: '第一次发布',
          fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
          snapshot: {
            scheduleId: 'published-v1',
            slotCount: 2,
            fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
            score: { completeness: 100 },
            publicationSummary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
            slots: [],
          },
        }],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({
    project,
    publicationHistoryDialog: { open: true, version: 1 },
  }));

  assert.match(buttonTag(html, 'data-export-history-type="published_class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-history-type="published_teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-history-type="published_master"'), /disabled/);
  assert.match(buttonTag(html, 'id="tt-restore-publication-history"'), /disabled/);
  assert.match(html, /发布历史 V1/);
  assert.match(html, /发布快照校验失败，请重新发布后再导出或恢复。/);
  assert.doesNotMatch(html, /publication_fingerprint_mismatch/);
});

test('timetable export panel disables official export when current published fingerprint is known bad', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-current',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'publication_fingerprint_mismatch',
          targetName: '发布快照',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        reviewItems: [{
          type: 'publication_fingerprint_mismatch',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '发布快照',
          message: '发布快照校验失败，请重新发布后再导出或恢复。',
        }],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-current',
        note: '第二次发布',
        fingerprint: '0'.repeat(64),
        snapshot: {
          scheduleId: 'published-current',
          slotCount: 2,
          fingerprint: '0'.repeat(64),
          slots: [],
        },
        history: [],
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });
  const html = renderWorkbench(sampleWorkbenchState({ project }));

  assert.match(buttonTag(html, 'data-export-type="class"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="teacher"'), /disabled/);
  assert.match(buttonTag(html, 'data-export-type="master"'), /disabled/);
  assert.doesNotMatch(buttonTag(html, 'data-export-type="plans"'), /disabled/);
  assert.match(html, /发布快照校验失败，请重新发布后再导出或恢复。/);
  assert.doesNotMatch(html, /publication_fingerprint_mismatch/);
});

test('timetable inspector compares current draft against the published snapshot', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'draft-after-publish',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [
        {
          id: 'slot-moved',
          day: 2,
          period: 3,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        },
        {
          id: 'slot-added',
          day: 3,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        },
      ],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-1',
        note: '教务处确认发布',
        snapshot: {
          scheduleId: 'published-1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          source: 'fast_constructed',
          slotCount: 2,
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0 },
          slots: [
            {
              id: 'slot-moved',
              day: 1,
              period: 1,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            },
            {
              id: 'slot-removed',
              day: 1,
              period: 2,
              classId: 'c1',
              subjectId: 'math',
              teacherId: 't_math',
              teacherIds: ['t_math'],
              lessonPlanId: 'lp_math',
            },
          ],
        },
      },
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 2, completeness: 100 },
    },
  });

  const diff = getPublishedScheduleDiff(project);
  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.equal(diff.total, 3);
  assert.equal(diff.moved, 1);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.match(inspector, /发布差异/);
  assert.match(inspector, /移动 1/);
  assert.match(inspector, /新增 1/);
  assert.match(inspector, /移除 1/);
  assert.match(inspector, /Math/);
  assert.match(inspector, /周一 第1节/);
  assert.match(inspector, /周二 第3节/);
  assert.match(inspector, /id="tt-restore-published-snapshot"/);
  assert.match(inspector, /data-restore-published-version="1"/);
  assert.match(inspector, /恢复发布版/);
});

test('timetable archive-only draft uses published snapshot context for diff labels and restore wiring', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [],
    classes: [],
    subjects: [],
    lessonPlans: [],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'archive-only-context',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'published',
      slots: [],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      publication: null,
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-2',
        note: '教务处确认发布',
        snapshot: {
          scheduleId: 'published-2',
          slotCount: 1,
          score: { completeness: 100 },
          publicationSummary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
          projectContext: {
            schoolName: 'UI School',
            term: '2026',
            weekdays: 5,
            periodsPerDay: 7,
            activeWeekdays: [1, 2, 3, 4, 5],
            activePeriods: [1, 2, 3, 4, 5, 6, 7],
            teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
            classes: [{ id: 'c1', grade: 'G7', name: '1' }],
            subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
            lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
            rules: { hardRules: {}, softRules: {} },
          },
          slots: [{
            id: 'slot-1',
            day: 1,
            period: 1,
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            teacherIds: ['t_math'],
            lessonPlanId: 'lp_math',
          }],
        },
      },
      score: {},
    },
  });

  const html = renderWorkbench(sampleWorkbenchState({ project }));

  assert.match(html, /data-restore-published-snapshot="latest"/);
  assert.match(html, /data-restore-published-version="2"/);
  assert.match(html, /data-export-type="published_class"/);
  assert.match(interactionSource, /\[data-restore-published-snapshot\][\s\S]*openRestoreDialog\('latest', button\.dataset\.restorePublishedVersion\)/);
});

test('timetable publish action is wired through controller and grid interactions', async () => {
  const manualProject = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'manual-current',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
      },
    },
  });
  const manualInspector = renderInspector(sampleWorkbenchState({ project: manualProject }));

  assert.match(manualInspector, /<b>来源<\/b>手动调整/);
  assert.doesNotMatch(manualInspector, /Timefold 未完成/);
  assert.doesNotMatch(manualInspector, /后台优化超时/);
  assert.doesNotMatch(manualInspector, /优化原因/);
  assert.doesNotMatch(manualInspector, /优化处理/);

  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.match(controllerSource, /async\s+publishSchedule\(/);
  assert.match(controllerSource, /requestTimetable\('\/schedule\/publish'/);
  assert.match(interactionSource, /#tt-publish-schedule/);
  assert.match(interactionSource, /openPublishDialog\(\)/);
  assert.match(interactionSource, /#tt-confirm-publish/);
  assert.match(interactionSource, /confirmPublishSchedule\(\)/);
  assert.match(interactionSource, /\[data-restore-published-snapshot\]/);
  assert.match(interactionSource, /openRestoreDialog\('latest', button\.dataset\.restorePublishedVersion\)/);
});

test('timetable inspector treats manual adjustment review as school review instead of optimization fallback', () => {
  const reviewProject = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'manual-review',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [{
        type: 'unplaced',
        severity: 'hard',
        message: '仍有课时未进入课表',
        lessonPlanId: 'lp_math',
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
      }],
      unplaced: [{
        lessonPlanId: 'lp_math',
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        reason: 'Manual review still required',
      }],
      score: { hardConflicts: 1, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'needs_review',
        accepted: false,
        reason: 'manual_adjustment_conflicts',
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project: reviewProject }));

  assert.match(inspector, /<b>来源<\/b>手动调整/);
  assert.match(inspector, /手动调整/);
  assert.match(inspector, /教务复核/);
  assert.doesNotMatch(inspector, /优化原因/);
  assert.doesNotMatch(inspector, /优化处理/);
  assert.doesNotMatch(inspector, /后台优化未采纳/);
});

test('timetable inspector treats stale optimization on manual schedules as optimization status, not manual review', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'manual-stale-optimization',
      generatedAt: '2026-01-03T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({
    project,
    solverJob: {
      jobId: 'stale-manual-job',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'stale_schedule',
    },
  }));

  assert.match(inspector, /优化原因/);
  assert.match(inspector, /课表已被更新，旧优化结果已作废/);
  assert.match(inspector, /优化处理/);
  assert.doesNotMatch(inspector, /<b>教务复核<\/b>课表已被更新，旧优化结果已作废/);
});

test('timetable restored published schedules are labeled as restored publish versions', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-published-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published_history_restored',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: { phase: 'published_history_restore', status: 'restored' },
    },
  });

  const status = getSolveStatus(project);
  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.equal(status.sourceLabel, '\u6062\u590d\u53d1\u5e03\u7248');
  assert.match(inspector, /\u6062\u590d\u53d1\u5e03\u7248/);
  assert.doesNotMatch(inspector, /\u672a\u751f\u6210/);
});

test('timetable optimization panel labels restored published drafts correctly', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-published-optimization',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published_history_restored',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: { phase: 'published_history_restore', status: 'restored' },
    },
  });
  const inspector = renderInspector(sampleWorkbenchState({
    project,
    solverJob: {
      jobId: 'old-job',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'stale_schedule',
    },
  }));

  assert.match(inspector, /<b>当前课表<\/b>恢复发布版/);
  assert.doesNotMatch(inspector, /<b>当前课表<\/b>未生成/);
});

test('timetable optimization panel keeps restored-published label after manual adjustment on a restored draft', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-manual-optimization',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });
  const inspector = renderInspector(sampleWorkbenchState({
    project,
    solverJob: {
      jobId: 'manual-restored-job',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'stale_schedule',
    },
  }));

  assert.match(inspector, /<b>当前课表<\/b>恢复发布版/);
  assert.doesNotMatch(inspector, /<b>当前课表<\/b>手动调整/);
});

test('timetable published schedules do not keep showing the background optimization panel from stale solver stats', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'published-with-stale-opt-stats',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'published',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'published',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '教务处确认发布',
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: false,
        reason: 'not_better',
        initialSolutionUsed: true,
        pinnedCount: 2,
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.doesNotMatch(inspector, /后台优化/);
  assert.doesNotMatch(inspector, /优化原因/);
  assert.doesNotMatch(inspector, /优化处理/);
  assert.doesNotMatch(inspector, /初始解/);
  assert.doesNotMatch(inspector, /锁定课节/);
});

test('timetable inspector keeps restored-published review wording after accepted optimization on a restored draft', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-optimized-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'timefold_solver',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'restored_published_draft',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        reviewItems: [{
          type: 'restored_published_draft',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '恢复发布版',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '恢复的发布版',
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });

  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.match(inspector, /恢复发布版/);
  assert.match(inspector, /重新发布前建议教务复核/);
});

test('timetable topbar keeps restored-published source wording after accepted optimization on a restored draft', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-topbar-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'timefold_solver',
      slots: [{
        id: 'slot-1',
        day: 1,
        period: 1,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'restored_published_draft',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        reviewItems: [],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '恢复的发布版',
      },
      solverStats: {
        phase: 'timefold_optimization',
        status: 'completed',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });

  const status = getSolveStatus(project);
  const panel = renderSchedulePanel(sampleWorkbenchState({ project }));

  assert.equal(status.sourceLabel, '恢复发布版');
  assert.match(panel, /可生成/);
});

test('timetable manual-adjusted restored drafts keep restored-published wording and review warning', () => {
  const project = createDefaultTimetableProject({
    schoolName: 'UI School',
    term: '2026',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: {} },
    schedule: {
      id: 'restored-manual-1',
      generatedAt: '2026-01-02T00:00:00.000Z',
      source: 'manual_adjusted',
      slots: [{
        id: 'slot-1',
        day: 2,
        period: 2,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        teacherIds: ['t_math'],
        lessonPlanId: 'lp_math',
        locked: false,
        manuallyAdjusted: true,
      }],
      lockedSlots: [],
      conflicts: [],
      unplaced: [],
      score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 1, completeness: 100 },
      publication: {
        ok: true,
        reason: 'ready',
        blockingIssues: [],
        warnings: [{
          type: 'restored_published_draft',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        reviewItems: [{
          type: 'restored_published_draft',
          severity: 'warning',
          targetKind: 'schedule',
          targetName: '恢复发布版',
          message: '当前草稿来自恢复发布版，重新发布前建议教务复核。',
        }],
        summary: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0 },
      },
      published: {
        status: 'draft_changed',
        version: 2,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: 'published-v2',
        note: '恢复的发布版',
      },
      solverStats: {
        phase: 'manual_adjustment',
        status: 'accepted',
        accepted: true,
        reason: null,
        restoredPublishedDraft: true,
        restoredVersion: 2,
        restoredScheduleId: 'published-v2',
      },
    },
  });

  const status = getSolveStatus(project);
  const inspector = renderInspector(sampleWorkbenchState({ project }));

  assert.equal(status.sourceLabel, '恢复发布版');
  assert.match(inspector, /<b>来源<\/b>恢复发布版/);
  assert.match(inspector, /重新发布前建议教务复核/);
});

test('timetable schedule panel shows animated fast-generation progress while running', () => {
  const state = sampleWorkbenchState({
    loading: true,
    solvePhaseText: '局部优化中',
  });

  const panel = renderSchedulePanel(state);
  const workbench = renderWorkbench(state);

  assert.match(panel, /局部优化中/);
  assert.match(panel, /loader-2/);
  assert.match(panel, /class="tt-spin"/);
  assert.match(panel, /tt-solve-toolbar-chip/);
  assert.match(workbench, /tt-process-strip tt-solve-process/);
  assert.match(workbench, /生成课表/);
  assert.match(workbench, /data-lucide="loader-2" class="tt-spin"/);
});

test('timetable workbench shows fast generation and background optimization status in Chinese', async () => {
  const state = sampleWorkbenchState({
    solverJob: {
      jobId: 'tt-opt-1',
      phase: 'timefold_optimization',
      status: 'running',
      accepted: false,
    },
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: false,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: { phase: 'fast_construct', status: 'accepted', lessonCount: 3 },
      },
    }),
  });

  const panel = renderSchedulePanel(state);
  const inspector = renderInspector(state);

  assert.match(panel, /快速生成/);
  assert.match(panel, /Timefold 优化中/);
  assert.match(inspector, /后台优化/);
  assert.match(inspector, /快速课表/);
  assert.doesNotMatch(panel + inspector, /姝ｅ湪|鏁欏姟|璇捐〃|鎺掕/);
});

test('timetable inspector explains initial solution and pinned optimization rejection', () => {
  const state = sampleWorkbenchState({
    solverJob: {
      jobId: 'tt-opt-pinned',
      phase: 'timefold_optimization',
      status: 'failed',
      accepted: false,
      reason: 'pinned_slot_moved',
      solverStats: {
        initialSolutionUsed: true,
        pinnedCount: 2,
        accepted: false,
        reason: 'pinned_slot_moved',
      },
    },
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'manual-1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: true,
          manuallyAdjusted: true,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          solverUsed: true,
          initialSolutionUsed: true,
          pinnedCount: 2,
          accepted: false,
          reason: 'pinned_slot_moved',
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /\u521d\u59cb\u89e3/);
  assert.match(inspector, /\u5df2\u4f7f\u7528/);
  assert.match(inspector, /\u9501\u5b9a\u8bfe\u8282/);
  assert.match(inspector, /锁定课节被移动/);
  assert.match(inspector, /已保留当前课表/);
  assert.doesNotMatch(inspector, /pinned_slot_moved/);
});

test('timetable inspector keeps persisted failed optimization details visible after reload', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-timeout-reload',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: false,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          phase: 'timefold_optimization',
          status: 'failed',
          accepted: false,
          reason: 'timeout',
          lessonCount: 3,
          timeoutSeconds: 210,
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /后台优化/);
  assert.match(inspector, /<b>优化状态<\/b>Timefold 未完成/);
  assert.match(inspector, /<b>处理结果<\/b>后台优化超时/);
  assert.match(inspector, /<b>优化处理<\/b>已保留当前课表：后台优化超时。/);
  assert.doesNotMatch(inspector, /timeout/);
});

test('timetable inspector translates background optimization rejection reasons for school staff', () => {
  const state = sampleWorkbenchState({
    solverJob: {
      jobId: 'tt-opt-not-better',
      phase: 'timefold_optimization',
      status: 'completed',
      accepted: false,
      reason: 'not_better',
      solverStats: {
        initialSolutionUsed: true,
        pinnedCount: 1,
        accepted: false,
        reason: 'not_better',
      },
    },
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-keep',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: true,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          initialSolutionUsed: true,
          pinnedCount: 1,
          accepted: false,
          reason: 'not_better',
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /优化结果没有更好/);
  assert.match(inspector, /已保留当前课表/);
  assert.doesNotMatch(inspector, /not_better/);
});

test('timetable inspector keeps persisted optimization rejection details visible after reload', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: {
        id: 'fast-keep-reload',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
          locked: false,
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        solverStats: {
          phase: 'timefold_optimization',
          status: 'completed',
          initialSolutionUsed: true,
          pinnedCount: 1,
          accepted: false,
          reason: 'not_better',
          qualityScoreBefore: 133,
          qualityScoreAfter: 133,
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /优化结果没有更好/);
  assert.match(inspector, /已保留当前课表/);
  assert.match(inspector, /<b>优化状态<\/b>已保留快速课表/);
  assert.doesNotMatch(inspector, /not_better/);
});

test('timetable data setup uses collapsible groups and compact active range dropdowns', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'Hidden School',
      term: 'Hidden Term',
      weekdays: 5,
      periodsPerDay: 7,
      activeWeekdays: [1, 3, 5],
      activePeriods: [1, 4, 7],
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      rules: { hardRules: {}, softRules: {} },
      schedule: null,
    }),
  });

  const html = renderWorkbench(state);
  const panel = renderSchedulePanel(state);

  assert.doesNotMatch(html, /name="schoolName"/);
  assert.doesNotMatch(html, /name="term"/);
  assert.match(html, /data-tt-section-toggle="data"/);
  assert.match(html, /data-tt-section-toggle="rules"/);
  assert.match(html, /data-tt-section-toggle="solve"/);
  assert.match(html, /class="[^"]*tt-workflow-panel[^"]*"/);
  assert.match(html, /class="[^"]*tt-workflow-body[^"]*"/);
  assert.match(html, /data-workflow-step="rules"[\s\S]*?class="[^"]*tt-workflow-body[^"]*"[^>]*>/);
  assert.match(html, /data-workflow-step="rules"[\s\S]*?id="tt-open-rule-review"/);
  assert.match(html, /class="[^"]*tt-rule-stack[^"]*tt-rules-setup-card[^"]*"/);
  assert.match(html, /class="[^"]*tt-rules-setup-body[^"]*"/);
  assert.match(html, /class="[^"]*tt-rule-summary[^"]*"/);
  assert.match(html, /id="tt-range-weekdays-trigger"/);
  assert.match(html, /id="tt-range-periods-trigger"/);
  const weekdayTrigger = html.match(/<summary class="[^"]*" id="tt-range-weekdays-trigger">[\s\S]*?<\/summary>/)?.[0] || '';
  const periodTrigger = html.match(/<summary class="[^"]*" id="tt-range-periods-trigger">[\s\S]*?<\/summary>/)?.[0] || '';
  assert.match(weekdayTrigger, /tt-multi-select-trigger--summary-only/);
  assert.match(periodTrigger, /tt-multi-select-trigger--summary-only/);
  assert.doesNotMatch(weekdayTrigger, /<span>可用周几<\/span>/);
  assert.doesNotMatch(periodTrigger, /<span>可用节次<\/span>/);
  assert.match(weekdayTrigger, /<strong>/);
  assert.match(periodTrigger, /<strong>/);
  assert.doesNotMatch(html, /id="tt-apply-range"/);
  assert.doesNotMatch(html, /id="tt-reset-range"/);
  assert.match(html, /data-range-apply/);
  assert.match(html, /data-tt-popover-close/);
  assert.match(html, /data-active-weekday="1"[^>]*checked/);
  assert.match(html, /data-active-weekday="3"[^>]*checked/);
  assert.match(html, /data-active-period="4"[^>]*checked/);
  assert.doesNotMatch(html, /tt-chip-grid--range/);
  assert.match(html, /class="tt-roster-stats"/);
  assert.match(html, /id="tt-clear-roster"/);
  assert.match(html, /id="tt-reopen-roster-import"/);
  assert.match(html, /id="tt-edit-roster"/);
  assert.doesNotMatch(html, /id="tt-import-text"/);
  assert.doesNotMatch(html, /id="tt-import-roster"/);
  assert.doesNotMatch(html, /class="tt-plan-list"/);
  assert.doesNotMatch(html, /class="tt-plan-row"/);
  // 智能 constraints use the same compact entry + modal workflow as roster import.
  assert.match(html, /id="tt-open-rule-review"/);
  assert.doesNotMatch(html, /id="tt-rule-input-area"/);
  assert.doesNotMatch(html, /id="tt-rule-input-text"/);
  assert.doesNotMatch(html, /id="tt-rule-parse-btn"/);
  assert.doesNotMatch(html, /id="tt-rule-manual-add-btn"/);
  assert.doesNotMatch(html, /id="tt-pending-rules"/);
  assert.doesNotMatch(html, /id="tt-saved-rules"/);
  assert.doesNotMatch(html, /id="tt-open-bulk-rule-review"/);
  assert.doesNotMatch(html, /id="tt-add-lock"/);
  assert.doesNotMatch(html, /class="tt-lock-list"/);
  assert.doesNotMatch(html, /id="tt-rule-prompt"/);
  assert.doesNotMatch(html, /id="tt-rule-file"/);
  assert.doesNotMatch(html, /id="tt-parse-rules"/);
  assert.doesNotMatch(html, /id="tt-confirm-rule-draft"/);
  assert.doesNotMatch(html, /id="tt-add-bulk-rule"/);
  assert.doesNotMatch(html, /id="tt-bulk-rule-type"/);
  assert.doesNotMatch(html, /id="tt-bulk-days-trigger"/);
  assert.doesNotMatch(html, /id="tt-bulk-periods-trigger"/);

  assert.match(panel, /style="--tt-days:3"/);
  assert.match(panel, /data-day="1"/);
  assert.match(panel, /data-day="3"/);
  assert.doesNotMatch(panel, /data-day="2"/);
  assert.match(panel, /data-period="4"/);
  assert.doesNotMatch(panel, /data-period="2"/);
});

test('timetable roster import is opened from a data card instead of permanent sidebar controls', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [],
      classes: [],
      subjects: [],
      lessonPlans: [],
      rules: { hardRules: {}, softRules: {} },
      schedule: null,
    }),
  });

  const closed = renderWorkbench(state);
  assert.match(closed, /id="tt-open-roster-import"/);
  assert.match(closed, /class="[^"]*tt-roster-entry[^"]*"/);
  assert.match(closed, /data-roster-import-trigger/);
  assert.doesNotMatch(closed, /id="tt-import-text"/);
  assert.doesNotMatch(closed, /id="tt-import-file"/);
  assert.doesNotMatch(closed, /id="tt-import-roster"/);
  assert.doesNotMatch(closed, /id="tt-roster-import-dialog"/);

  const open = renderWorkbench({
    ...state,
    rosterImport: {
      open: true,
      mode: 'text',
      fileName: '',
      text: '',
    },
  });
  assert.match(open, /id="tt-roster-import-dialog"/);
  assert.match(open, /id="tt-roster-import-file"/);
  assert.match(open, /id="tt-roster-import-text"/);
  assert.match(open, /id="tt-fill-roster-sample"/);
  assert.match(open, /id="tt-start-empty-roster-review"/);
  assert.match(open, /id="tt-cancel-roster-import"/);
  assert.match(open, /id="tt-preview-roster-import"/);
  assert.doesNotMatch(open, /id="tt-roster-review-table"/);
  assert.match(open, /data-roster-import-mode="file"/);
  assert.match(open, /data-roster-import-mode="text"/);

  const review = renderWorkbench({
    ...state,
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'text',
      fileName: '',
      text: '',
      draftRows: [{
        id: 'draft_1',
        grade: 'G7',
        className: '1',
        subjectName: 'Math',
        subjectCategory: 'main',
        subjectTags: ['core', 'exam'],
        teacherName: 'Alice/Bob',
        weeklyHours: 4,
        blockPreference: 'double',
        roomName: 'Lab A/Lab B',
        issues: [],
      }],
      stats: { classCount: 1, teacherCount: 2, subjectCount: 1, planCount: 1, totalLessons: 4, blockLessons: 4, fixedRoomCount: 2, issueCount: 0 },
      issues: [],
      warnings: [],
    },
  });
  assert.match(review, /id="tt-roster-review-table"/);
  assert.match(review, /data-roster-review-row="draft_1"/);
  assert.match(review, /data-roster-field="grade"/);
  assert.match(review, /data-roster-field="className"/);
  assert.match(review, /data-roster-field="subjectName"/);
  assert.match(review, /data-roster-field="subjectCategory"/);
  assert.match(review, /data-roster-field="subjectTags"/);
  assert.match(review, /data-roster-field="teacherName"/);
  assert.match(review, /data-roster-field="weeklyHours"/);
  assert.match(review, /data-roster-field="blockPreference"/);
  assert.match(review, /data-roster-field="roomName"/);
  assert.match(review, /data-roster-delete-row="draft_1"/);
  assert.match(review, /id="tt-add-roster-review-row"/);
  assert.match(review, /id="tt-roster-bulk-text"/);
  assert.match(review, /id="tt-append-roster-rows"/);
  assert.match(review, /id="tt-confirm-roster-import"/);
});

test('timetable roster import review renders the import report summary and entries', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'review',
      mode: 'text',
      fileName: '',
      text: '',
      draftRows: [{
        id: 'draft_1',
        grade: 'G8',
        className: '1班',
        subjectName: '数学',
        subjectCategory: 'main',
        subjectTags: [],
        teacherName: '张老师',
        weeklyHours: 4,
        blockPreference: 'double',
        roomName: '',
        issues: [],
      }],
      stats: { classCount: 1, teacherCount: 1, subjectCount: 1, planCount: 1, totalLessons: 4, blockLessons: 4, fixedRoomCount: 0, issueCount: 1 },
      issues: [],
      warnings: ['存在重复任课，请确认是否需要合并。'],
      importReport: {
        sourceKind: 'roster',
        summary: { total: 3, kept: 1, degraded: 1, dropped: 0, review: 1 },
        entries: [{
          category: 'kept',
          source: { row: 2, rowId: 'draft_1' },
          field: 'row',
          reason: '任课行已保留。',
        }, {
          category: 'degraded',
          source: { row: 4, rowId: 'draft_3' },
          field: 'blockPreference',
          reason: '无法识别“三连堂”，已按单节处理。',
          originalValue: '三连堂',
        }, {
          category: 'review',
          source: { row: 3, rowId: 'draft_2' },
          field: 'subjectName',
          reason: '存在重复任课，请确认是否需要合并。',
        }],
        hasIssues: true,
      },
    },
  }));

  assert.match(html, /导入报告/);
  assert.match(html, /保留<\/b>1/);
  assert.match(html, /降级<\/b>1/);
  assert.match(html, /丢弃<\/b>0/);
  assert.match(html, /待审<\/b>1/);
  assert.match(html, /无法识别“三连堂”，已按单节处理。/);
  assert.match(html, /存在重复任课，请确认是否需要合并。/);
});

test('timetable roster import shows a loading state while parsing before review', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    rosterImport: {
      open: true,
      step: 'input',
      mode: 'file',
      fileName: '教师配置排课数据.xlsx',
      text: '',
      loading: true,
      phaseText: '读取并解析任课文件中...',
      phaseTone: '',
    },
  }));

  assert.match(html, /id="tt-roster-import-dialog"/);
  assert.match(html, /data-lucide="loader-2" class="tt-spin"/);
  assert.match(html, /id="tt-preview-roster-import"[^>]*disabled/);
  assert.match(html, />解析中<\/span>/);
  assert.match(html, /tt-roster-import-process/);
  assert.match(html, /读取并解析任课文件中/);
  assert.match(html, /id="tt-roster-import-file"[^>]*disabled/);
  assert.match(html, /id="tt-roster-import-text"[^>]*disabled/);
  assert.match(html, /data-roster-import-mode="file" disabled/);
  assert.match(html, /id="tt-fill-roster-sample"[^>]*disabled/);
  assert.match(html, /id="tt-start-empty-roster-review"[^>]*disabled/);
});

test('timetable roster import controller exposes modal workflow methods and bindings', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(stateSource, /rosterImport:\s*{/);
  assert.match(controllerSource, /openRosterImport\(/);
  assert.match(controllerSource, /closeRosterImport\(/);
  assert.match(controllerSource, /setRosterImportMode\(/);
  assert.match(controllerSource, /selectRosterImportFile\(/);
  assert.match(controllerSource, /previewRosterImport\(/);
  assert.match(controllerSource, /phaseText:\s*hasFile\s*\?\s*'读取并解析任课文件中\.\.\.'/);
  assert.match(controllerSource, /startEmptyRosterReview\(/);
  assert.match(controllerSource, /openRosterEditor\(/);
  assert.match(controllerSource, /updateRosterReviewField\(/);
  assert.match(controllerSource, /appendRosterReviewRows\(/);
  assert.match(controllerSource, /deleteRosterReviewRow\(/);
  assert.match(controllerSource, /confirmRosterImport\(/);
  assert.match(controllerSource, /new FormData\(\)/);
  assert.match(controllerSource, /#tt-roster-import-text/);
  assert.match(interactionSource, /data-roster-import-trigger/);
  assert.match(interactionSource, /#tt-reopen-roster-import/);
  assert.match(interactionSource, /#tt-edit-roster/);
  assert.match(interactionSource, /#tt-preview-roster-import/);
  assert.match(interactionSource, /#tt-start-empty-roster-review/);
  assert.match(interactionSource, /#tt-confirm-roster-import/);
  assert.match(interactionSource, /#tt-cancel-roster-import/);
  assert.match(interactionSource, /#tt-roster-import-file/);
  assert.match(interactionSource, /\[data-roster-field\]/);
  assert.match(interactionSource, /\[data-roster-delete-row\]/);
  assert.match(interactionSource, /#tt-add-roster-review-row/);
  assert.match(interactionSource, /#tt-append-roster-rows/);
  assert.match(interactionSource, /\[data-roster-import-mode\]/);
  assert.match(styles, /\.tt-dialog-overlay/);
  assert.match(styles, /\.tt-roster-import-dialog/);
  assert.match(styles, /\.tt-import-dropzone/);
  assert.match(styles, /\.tt-roster-review-table/);
  assert.match(styles, /\.tt-roster-review-row--error/);
  // 已删除 .tt-rule-review-dialog CSS 断言（旧弹窗已废弃，使用 constraint dialog 替代）
  assert.match(styles, /\.tt-roster-import-dialog/);
  assert.match(styles, /\.tt-period-time-dialog/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog/);
});

test('timetable dialogs expand to review content on desktop and stay constrained on mobile', async () => {
  const styles = await readFile(stylePath, 'utf8');

  // 已删除 .tt-rule-review-dialog CSS 断言（旧弹窗已废弃，使用 constraint dialog 替代）
  assert.match(styles, /\.tt-roster-import-dialog,\s*[\s\S]*\.tt-period-time-dialog,\s*[\s\S]*\.tt-publish-dialog,\s*[\s\S]*\.tt-publication-history-dialog\s*{[\s\S]*width:\s*min\(var\(--tt-dialog-width,\s*720px\),\s*calc\(100vw - 48px\)\);[\s\S]*max-width:\s*calc\(100vw - 48px\);[\s\S]*max-height:\s*min\(var\(--tt-dialog-max-height,\s*860px\),\s*calc\(100vh - 48px\)\);[\s\S]*overflow:\s*auto;[\s\S]*box-shadow:\s*0 24px 60px rgba\(2,\s*6,\s*23,\s*0\.38\);/);
  assert.match(styles, /\.tt-roster-import-dialog\s*{[\s\S]*--tt-dialog-width:\s*1120px;/);
  assert.match(styles, /\.tt-period-time-dialog\s*{[\s\S]*--tt-dialog-width:\s*960px;[\s\S]*--tt-dialog-max-height:\s*820px;/);
  assert.match(styles, /\.tt-publish-dialog\s*{[\s\S]*--tt-dialog-width:\s*640px;[\s\S]*--tt-dialog-max-height:\s*760px;/);
  assert.match(styles, /\.tt-publication-history-dialog\s*{[\s\S]*--tt-dialog-width:\s*920px;[\s\S]*--tt-dialog-max-height:\s*820px;/);
  assert.match(styles, /\.tt-roster-review-wrap\s*{[\s\S]*overflow:\s*auto;[\s\S]*max-width:\s*100%;/);
  assert.match(styles, /\.tt-period-time-review\s*{[\s\S]*overflow:\s*auto;[\s\S]*max-width:\s*100%;[\s\S]*min-height:\s*0;/);
  // 已删除响应式 CSS 中对 .tt-rule-review-dialog 的断言
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog,[\s\S]*\.tt-period-time-dialog,[\s\S]*\.tt-publish-dialog,[\s\S]*\.tt-publication-history-dialog\s*{[\s\S]*width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*100%;/);
});

test('timetable roster import preserves input and review drafts when the modal is reopened', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'input',
    mode: 'text',
    text: 'G7,1,Math,Teacher,4',
    fileName: '',
    draftRows: [],
  };
  controller.closeRosterImport();
  assert.equal(controller.state.rosterImport.open, false);
  assert.equal(controller.state.rosterImport.text, 'G7,1,Math,Teacher,4');
  controller.openRosterImport('file');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'text');
  assert.equal(controller.state.rosterImport.text, 'G7,1,Math,Teacher,4');

  controller.state.rosterImport = {
    ...controller.state.rosterImport,
    open: true,
    step: 'review',
    mode: 'file',
    fileName: 'roster.xlsx',
    draftRows: [{ id: 'draft_1', className: '1', subjectName: 'Math', teacherName: 'Teacher', weeklyHours: '4' }],
    stats: { planCount: 1 },
    warnings: ['warn'],
    issues: [],
  };
  controller.closeRosterImport();
  assert.equal(controller.state.rosterImport.open, false);
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'review');
  assert.equal(controller.state.rosterImport.mode, 'file');
  assert.equal(controller.state.rosterImport.draftRows.length, 1);

  controller.resetRosterImport();
  controller.openRosterImport('text');
  assert.equal(controller.state.rosterImport.open, true);
  assert.equal(controller.state.rosterImport.step, 'input');
  assert.equal(controller.state.rosterImport.mode, 'text');
  assert.deepEqual(controller.state.rosterImport.draftRows, []);
});

test('timetable 智能 rules support Excel file upload and rich preview metadata', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  // New design: pending rules from an xlsx parse appear as inline cards
  const state = sampleWorkbenchState({
    ruleInput: { text: '', fileName: 'constraints.xlsx', loading: false },
    pendingRules: [{
      id: 'draft-1',
      rawText: 'Math should prefer Monday period 2',
      type: 'subject_preferred_periods',
      targetType: 'subject',
      targetName: 'Math',
      targetId: 'math',
      slots: ['1-2'],
      priority: 'soft',
      status: 'effective',
      confidence: 0.92,
      description: 'Prefer period',
      warnings: [],
    }, {
      id: 'draft-2',
      rawText: 'Balance teacher workload',
      type: 'teacher_load_balance',
      targetType: 'global',
      targetName: 'All teachers',
      slots: [],
      priority: 'soft',
      status: 'suggestion',
      confidence: 0.78,
      description: 'Suggestion only',
      warnings: [],
    }],
    expandedRuleId: null,
  });
  const html = renderWorkbench(state);

  // Inline card-based UI renders pending cards and input area
  assert.match(html, /id="tt-open-rule-review"/);
  assert.doesNotMatch(html, /id="tt-rule-input-area"/);
  assert.doesNotMatch(html, /id="tt-pending-rules"/);
  assert.doesNotMatch(html, /data-rule-card="draft-1"/);
  assert.doesNotMatch(html, /data-rule-card="draft-2"/);
  assert.doesNotMatch(html, /data-rule-accept="draft-1"/);
  assert.doesNotMatch(html, /data-rule-reject="draft-1"/);
  assert.doesNotMatch(html, /data-rule-expand="draft-1"/);
  assert.doesNotMatch(html, /id="tt-rule-accept-all"/);
  assert.doesNotMatch(html, /id="tt-rule-reject-all"/);
  assert.doesNotMatch(html, /subject_preferred_periods/);
  assert.doesNotMatch(html, /teacher_load_balance/);
  // File input supports xlsx
  assert.doesNotMatch(html, /id="tt-rule-input-file"/);
  // State shape includes ruleInput and pendingRules
  assert.match(stateSource, /ruleInput:\s*{/);
  assert.match(stateSource, /pendingRules:\s*\[/);
  // Controller exposes card-based methods plus legacy dialog methods
  assert.match(controllerSource, /parseRulesInline\(/);
  assert.match(controllerSource, /acceptRule\(/);
  assert.match(controllerSource, /rejectRule\(/);
  assert.match(controllerSource, /acceptAllRules\(/);
  assert.match(controllerSource, /submitClarifyingAnswers\(/);
  assert.match(controllerSource, /rejectAllRules\(/);
  assert.match(controllerSource, /selectRuleInputFile\(/);
  assert.match(controllerSource, /expandRuleCard\(/);
  assert.match(controllerSource, /\/rules\/normalize/);
  // Interactions bind the new card buttons
  assert.doesNotMatch(interactionSource, /#tt-rule-parse-btn/);
  assert.doesNotMatch(interactionSource, /#tt-rule-input-file/);
  assert.doesNotMatch(interactionSource, /#tt-rule-manual-add-btn/);
  assert.doesNotMatch(interactionSource, /\[data-rule-accept\]/);
  assert.doesNotMatch(interactionSource, /\[data-rule-reject\]/);
  assert.doesNotMatch(interactionSource, /\[data-rule-expand\]/);
  assert.match(interactionSource, /#tt-open-rule-review/);
  assert.match(interactionSource, /#tt-rule-review-file/);
  assert.match(interactionSource, /#tt-rule-review-parse/);
  assert.match(interactionSource, /submit-rule-clarification/);
  assert.match(interactionSource, /submitClarifyingAnswers\(/);
  assert.match(interactionSource, /\[data-saved-rule-delete\]/);
  assert.doesNotMatch(interactionSource, /#tt-open-bulk-rule-review/);
  assert.match(styles, /\.tt-empty-card/);
  assert.match(styles, /\.tt-rule-entry/);
  assert.match(styles, /\.tt-rules-setup-card/);
  assert.match(styles, /\.tt-rules-setup-body/);
  assert.doesNotMatch(styles, /\.tt-rule-entry-card/);
  // 已删除 .tt-rule-review-dialog 样式断言（旧弹窗已废弃）
});

test('timetable constraint dialog keeps parsed drafts in the current review flow', async () => {
  const pendingRules = [{
    id: 'draft-1',
    rawText: 'All teachers should be balanced',
    type: 'teacher_load_balance',
    targetType: 'global',
    targetName: 'All teachers',
    slots: [],
    priority: 'soft',
    status: 'suggestion',
    confidence: 0.7,
    description: 'Suggestion only',
    warnings: [],
  }, {
    id: 'draft-2',
    rawText: 'Math should prefer Monday period 2',
    type: 'subject_preferred_periods',
    targetType: 'subject',
    targetName: 'Math',
    targetId: 'math',
    slots: ['1-2'],
    priority: 'soft',
    status: 'effective',
    confidence: 0.9,
    description: 'Prefer period',
    warnings: [],
  }];
  const state = sampleWorkbenchState({
    pendingRules: [],
    expandedRuleId: null,
    ruleInput: { text: '', fileName: '', loading: false },
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: 'constraints.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: pendingRules,
      warnings: ['Unknown object ignored'],
      unsupportedItems: [],
      contextStats: { rowCount: 2 },
    },
  });

  const dialogState = {
    ...state,
    constraintDialog: { open: true },
    smartWorkbench: { open: false },
  };
  const html = renderWorkbench(dialogState);
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-dialog/);
  assert.match(html, /已识别约束 \(2\)/);
  assert.match(html, /All teachers should be balanced/);
  assert.match(html, /Math should prefer Monday period 2/);
  assert.match(html, /data-action="apply-constraints"/);
  assert.doesNotMatch(html, /data-smart-workbench-root/);
  assert.doesNotMatch(sidebar, /id="tt-pending-rules"/);
  assert.doesNotMatch(sidebar, /data-rule-card="draft-1"/);
  assert.doesNotMatch(sidebar, /data-rule-card="draft-2"/);
  assert.doesNotMatch(sidebar, /待确认 \(2\)/);
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-1"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-2"/);

  // Controller sends existing drafts to the constraint dialog.
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    open: false,
    step: 'input',
    mode: 'file',
    draftRows: pendingRules,
    warnings: [],
  };
  controller.openRuleReview('file');
  assert.equal(controller.state.constraintDialog.open, true);
  assert.equal(controller.state.smartWorkbench.open, false);
  assert.equal(controller.state.ruleReview.inputMode, 'file');
  assert.equal(controller.state.ruleReview.draftRows.length, 2);
});

test('timetable rule review shows all-teacher limit targets instead of an unmatched teacher dropdown', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
      busy: true,
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
      advancedOpen: true,
      draftRows: [{
        id: 'all-teachers-limit',
        rawText: '每位教师每天授课量尽量均衡，单日不超过4节',
        type: 'teacher_daily_limit',
        targetType: 'teacher',
        targetName: '全部教师',
        targetId: '',
        limit: 4,
        priority: 'soft',
        status: 'effective',
        confidence: 0.9,
        warnings: [],
      }],
      warnings: [],
    },
  }));

  assert.match(html, /data-constraint-id="all-teachers-limit"/);
  assert.match(html, /全部教师/);
  assert.match(html, /每位教师每天授课量尽量均衡/);
  assert.doesNotMatch(html, /data-rule-target-select/);
  assert.doesNotMatch(html, /<option value="">未选择<\/option>/);
});

test('timetable smart rules sidebar opens the constraint dialog', async () => {
  const dialogSource = await readFile(new URL('view-constraint-dialog.js', moduleRoot), 'utf8');
  const componentSource = await readFile(new URL('view-constraint-dialog-components.js', moduleRoot), 'utf8');
  const state = sampleWorkbenchState({
    pendingRules: [],
    expandedRuleId: null,
    ruleInput: { text: '', fileName: '', loading: false },
  });
  const html = renderWorkbench(state);
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  // Inline input area is present in the sidebar rules section
  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-input-area"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-input-text"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-input-file"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-parse-btn"/);
  assert.doesNotMatch(sidebar, /id="tt-rule-manual-add-btn"/);
  // Example chips are rendered
  assert.doesNotMatch(sidebar, /data-rule-example=/);
  // No obsolete dialog or card entry pattern
  assert.doesNotMatch(sidebar, /id="tt-open-bulk-rule-review"/);
  assert.doesNotMatch(sidebar, /id="tt-add-lock"/);
  assert.doesNotMatch(sidebar, /tt-lock-list/);
  assert.match(sidebar, /class="[^"]*tt-rule-stack[^"]*tt-rules-setup-card[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-rules-setup-body[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.match(sidebar, /打开智能排课助手/);
  assert.match(sidebar, /已应用|已生效/);
  assert.match(sidebar, /待处理/);
  assert.match(sidebar, /需注意/);
  assert.match(sidebar, /class="[^"]*tt-rule-summary[^"]*"/);
  assert.doesNotMatch(sidebar, /tt-rule-entry-card/);
  // No dialog rendered when no pending rules and no open state
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  // The current dialog owns text, file, manual, preview, edit, and AI actions.
  assert.match(dialogSource, /data-action="switch-constraint-mode"/);
  assert.match(dialogSource, /id="tt-manual-type"/);
  assert.match(dialogSource, /data-action="add-manual-constraint"/);
  assert.match(dialogSource, /data-action="parse-constraints"/);
  assert.match(dialogSource, /data-action="apply-constraints"/);
  const dialogControllerSource = await readFile(new URL('controller-constraint-dialog.js', moduleRoot), 'utf8');
  assert.match(dialogControllerSource, /requestTimetable\('\/rules\/parse'/);
  assert.doesNotMatch(dialogControllerSource, /requestTimetable\('\/rule-review\/parse'/);
  assert.match(componentSource, /data-action="edit-constraint"/);
  assert.match(componentSource, /data-action="delete-constraint"/);

  // Opening directly to manual mode uses the constraint dialog.
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.openRuleReview('manual');
  assert.equal(controller.state.constraintDialog.open, true);
  assert.equal(controller.state.smartWorkbench.open, false);
  assert.equal(controller.state.ruleReview.inputMode, 'manual');
});

test('timetable smart rules no longer keep the old inline sidebar renderer', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.doesNotMatch(viewSource, /function renderRuleInputArea/);
  assert.doesNotMatch(viewSource, /function renderRuleCard\(/);
  assert.doesNotMatch(viewSource, /function renderSavedRuleList/);
  assert.doesNotMatch(viewSource, /function renderRulePreview/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-rule-input-area\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-pending-rules\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rules\s*\{/);
});

test('timetable constraint dialog shows parse progress feedback', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const dialogBaseStyles = await readFile(constraintDialogStylePath, 'utf8');
  const dialogAdvancedStyles = await readFile(constraintDialogAdvancedStylePath, 'utf8');
  const dialogStyles = `${dialogBaseStyles}\n${dialogAdvancedStyles}`;
  const fileHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      text: 'Math prefers morning',
      draftRows: [],
      warnings: [],
      loading: true,
      phase: 'parse_file',
      phaseText: '智能解析约束中...',
    },
  }));

  assert.match(fileHtml, /data-constraint-dialog-overlay/);
  assert.match(fileHtml, /智能-rules\.xlsx/);
  assert.match(fileHtml, /data-action="parse-constraints"[^>]*disabled/);
  assert.match(fileHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(fileHtml, /正在解析/);
  assert.match(fileHtml, /data-action="switch-constraint-mode"[\s\S]*?disabled/);
  assert.match(fileHtml, /id="tt-constraint-file-input"[^>]*disabled/);
  assert.doesNotMatch(fileHtml, /data-smart-workbench-root/);
  assert.doesNotMatch(fileHtml, /id="tt-rule-review-dialog"/);

  const textHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'text',
      text: '数学尽量上午',
      draftRows: [],
      warnings: [],
      loading: true,
      phaseText: '生成复核行中...',
    },
  }));

  assert.match(textHtml, /tt-parsing-status/);
  assert.match(textHtml, /生成复核行中\.\.\./);
  assert.match(textHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);

  assert.match(styles, /\.tt-spin\s*{/);
  assert.match(styles, /@keyframes\s+tt-spin/);
  assert.match(dialogStyles, /\.tt-parsing-status\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-input-tabs\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-intake-panel\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-mode-row\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-form-surface\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-command-row\s*{/);
  assert.match(dialogStyles, /\.tt-tab-btn\s+span\s*{[^}]*white-space:\s*nowrap/);
  assert.match(dialogStyles, /\.tt-tab-btn\.is-active\s*{[^}]*background:\s*var\(--tt-bg-panel\)/);
  assert.doesNotMatch(dialogStyles, /\.tt-tab-btn\.is-active\s*{[^}]*background:\s*var\(--tt-primary\)/);
});

test('timetable constraint AI chat is embedded inside the constraint dialog', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const dialogControllerSource = await readFile(new URL('../public/js/tools/timetable/controller-constraint-dialog-advanced.js', import.meta.url), 'utf8');
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dialogBaseStyles = await readFile(constraintDialogStylePath, 'utf8');
  const dialogAdvancedStyles = await readFile(constraintDialogAdvancedStylePath, 'utf8');
  const dialogStyles = `${dialogBaseStyles}\n${dialogAdvancedStyles}`;

  const state = sampleWorkbenchState({
    constraintDialog: createConstraintDialogState({
      open: true,
      aiChat: {
        active: true,
        loading: false,
        conversationId: 'conv_test',
        messages: [{
          role: 'assistant',
          content: '缺少节次会导致规则不能执行，请补充可用节次。',
        }, {
          role: 'user',
          content: '请解释这些约束',
        }],
        suggestedPrompts: ['检查这些约束是否有冲突'],
      },
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      draftRows: [{
        id: 'draft-1',
        rawText: 'Math Teacher daily limit',
        type: 'teacher_daily_limit',
        targetType: 'teacher',
        targetName: 'Math Teacher',
        targetId: 't_math',
        value: 4,
        slots: [],
        priority: 'soft',
        status: 'effective',
        confidence: 0.9,
        description: 'Daily limit',
        warnings: [],
      }],
      missingInfo: [{
        id: 'missing-1',
        message: '缺少明确节次，请补充后再生效。',
        relatedRuleIds: ['draft-1'],
      }],
      needReview: [],
      unsupportedItems: [],
      warnings: ['H-004 和 H-005 涉及连堂保护，无法直接映射。'],
      loading: false,
    },
  });
  const html = renderWorkbench(state);

  assert.doesNotThrow(() => new TimetablePlannerController());
  assert.equal(typeof TimetablePlannerController.prototype.startConstraintConversation, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.sendConstraintChatMessage, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.closeConstraintChat, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.updateConstraintChatInput, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.applyConstraintChatPreview, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.startConstraintAIChat, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.sendConstraintAIMessage, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.closeConstraintAIChat, 'function');
  assert.match(controllerSource, /constraintDialogAdvancedMethods/);
  assert.match(dialogControllerSource, /startConstraintAIChat/);
  assert.match(dialogControllerSource, /sendConstraintAIMessage/);
  assert.match(html, /tt-constraint-dialog--with-ai/);
  assert.match(html, /tt-ai-chat-panel/);
  assert.match(html, /tt-constraint-dialog-body/);
  assert.match(html, /tt-constraint-dialog-body--ai/);
  assert.match(html, /tt-ai-chat-toolbar/);
  assert.match(html, /tt-ai-chat-stream/);
  assert.match(html, /tt-ai-message-icon/);
  assert.match(html, /AI 约束优化助手/);
  assert.match(html, /缺少节次会导致规则不能执行/);
  assert.match(html, /请解释这些约束/);
  assert.match(html, /data-action="use-ai-prompt"/);
  assert.match(html, /data-action="send-ai-message"/);
  assert.match(html, /data-action="close-ai-chat"/);
  assert.doesNotMatch(html, /tt-smart-workbench/);
  assert.doesNotMatch(html, /tt-constraint-chat-dock/);
  assert.doesNotMatch(html, /tt-constraint-chat-overlay/);
  assert.doesNotMatch(html, /当前办理事项/);
  assert.doesNotMatch(html, /AI 帮我处理/);
  assert.match(interactionSource, /start-ai-chat/);
  assert.match(interactionSource, /send-ai-message/);
  assert.match(interactionSource, /close-ai-chat/);
  assert.match(interactionSource, /use-ai-prompt/);
  assert.match(indexHtml, /css\/timetable-chat\.css/);
  assert.match(indexHtml, /css\/timetable-constraint-dialog\.css/);
  assert.match(indexHtml, /css\/timetable-constraint-dialog-advanced\.css/);
  assert.doesNotMatch(indexHtml, /css\/timetable-smart-workbench\.css/);
  assert.match(dialogStyles, /\.tt-constraint-dialog\s*{/);
  assert.match(dialogStyles, /--tt-dialog-width:\s*780px/);
  assert.match(dialogStyles, /\.tt-constraint-dialog-body\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-dialog--with-ai\s*{[\s\S]*--tt-dialog-width:\s*960px/);
  assert.match(dialogStyles, /@media\s*\(max-width:\s*640px\)[\s\S]*\.tt-constraint-dialog/);
  assert.match(dialogStyles, /\.tt-ai-chat-panel\s*{[\s\S]*background:\s*var\(--tt-bg-input\)/);
  assert.match(dialogStyles, /\.tt-ai-chat-messages\s*{[\s\S]*max-height:\s*min\(420px,\s*48vh\)/);
  assert.match(dialogStyles, /\.tt-ai-message-icon\s*{[\s\S]*border-radius:\s*var\(--tt-radius-sm\)/);
  assert.doesNotMatch(dialogStyles, /\.tt-ai-chat-panel\s*{[\s\S]*height:\s*600px/);
  assert.doesNotMatch(dialogStyles, /\.tt-suggested-prompt-chip:hover\s*{[\s\S]*box-shadow:\s*0 0 20px/);
});

test('timetable hides the constraint chat dock until a conversation is open', () => {
  const html = renderWorkbench(sampleWorkbenchState());

  assert.doesNotMatch(html, /tt-constraint-chat-dock/);
  assert.doesNotMatch(html, /当前办理事项/);
});

test('timetable rule review parse renders the opened input state before progress updates', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const parseRulesSource = extractMethodSource(controllerSource, 'parseRules');

  assert.match(
    parseRulesSource,
    /this\.state\.ruleReview\s*=\s*{[\s\S]*?open:\s*true,[\s\S]*?text,[\s\S]*?};\s*this\.renderRuleReviewSurface\(\);\s*try\s*{/
  );
});

test('timetable rule review updates the constraint dialog without old modal renderers', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const closedHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      advancedOpen: false,
      draftRows: [{
        id: 'lazy-row',
        rawText: 'Math should be in the morning',
        type: 'subject_morning',
        targetType: 'subject',
        targetId: 'math',
        targetName: 'Math',
        status: 'effective',
        priority: 'soft',
        warnings: [],
      }],
      warnings: [],
    },
  }));

  assert.match(controllerSource, /renderRuleReviewSurface\(\)\s*{/);
  assert.match(controllerSource, /this\.state\.constraintDialog\s*=\s*{/);
  assert.match(controllerSource, /open:\s*true/);
  assert.match(controllerSource, /this\.state\.smartWorkbench\s*=\s*{[\s\S]*open:\s*false/);
  assert.doesNotMatch(controllerSource, /renderRuleReviewDialog\(this\.state\)/);
  assert.match(closedHtml, /data-constraint-dialog-overlay/);
  assert.match(closedHtml, /data-constraint-id="lazy-row"/);
  assert.match(closedHtml, /Math should be in the morning/);
  assert.doesNotMatch(closedHtml, /id="tt-rule-review-table"/);
  assert.doesNotMatch(closedHtml, /data-rule-review-row="lazy-row"/);
});

test('timetable constraint dialog locks inputs while rules are being written', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: [{
        id: 'draft-1',
        rawText: 'Math should prefer Monday period 2',
        type: 'subject_preferred_periods',
        targetType: 'subject',
        targetName: 'Math',
        targetId: 'math',
        slots: ['1-2'],
        priority: 'soft',
        status: 'effective',
        confidence: 0.92,
        description: 'Prefer period',
        warnings: [],
      }],
      contextStats: { rowCount: 1 },
      warnings: [],
      advancedOpen: true,
      loading: true,
      parsing: true,
      phase: 'saving',
      phaseText: '写入项目中...',
    },
  }));

  assert.match(html, /正在解析/);
  assert.match(html, /data-action="parse-constraints"[^>]*disabled/);
  assert.match(html, /data-action="apply-constraints"[^>]*disabled/);
  assert.match(html, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(html, /data-action="switch-constraint-mode"[\s\S]*?disabled/);
  assert.match(html, /data-constraint-id="draft-1"/);
  assert.doesNotMatch(html, /data-action="smart-workbench-preview-rules"/);
  assert.doesNotMatch(html, /data-rule-review-field="rawText"/);
});

test('timetable constraint dialog explains card warnings and source text separately', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: [{
        id: 'draft-source-1',
        source: '智能约束建议',
        sourceRow: 1,
        rawText: '同一位教师同一时间只能给一个班上课。',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '语文',
        targetId: 'chinese',
        slots: [],
        priority: 'soft',
        status: 'effective',
        confidence: 0.9,
        description: '语文尽量安排在上午',
        warnings: [],
      }, {
        id: 'draft-source-2',
        source: '智能约束建议',
        sourceRow: 4,
        rawText: '混合课程连堂块不可拆。',
        type: 'block_protection',
        targetType: 'subject',
        targetName: '化学',
        slots: [],
        priority: 'soft',
        status: 'suggestion',
        confidence: 0.75,
        description: '建议项，仅供复核',
        warnings: ['当前版本只能预览这类建议'],
      }],
      contextStats: { rowCount: 2 },
      warnings: [
        '第1条（同一教师不冲突）是排课系统的基础规则，已自动处理，无需额外约束。',
        '第4条（混合课程连堂块不可拆）当前约束类型不支持，请人工在设计时处理。',
        '第9条（上午主科不过载）无法用现有约束精确表达，建议通过手动调整或后续优化。',
        '第17条（教师空堂紧凑）建议作为优化目标。',
      ],
      advancedOpen: true,
      loading: false,
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-preview/);
  assert.match(html, /已识别约束 \(2\)/);
  assert.match(html, /混合课程连堂块不可拆/);
  assert.match(html, /原文：同一位教师同一时间只能给一个班上课。/);
  assert.match(html, /原文：混合课程连堂块不可拆。/);
  assert.match(html, /当前版本只能预览这类建议/);
  assert.match(html, /data-constraint-id="draft-source-1"/);
  assert.match(html, /data-constraint-id="draft-source-2"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-source-1"/);
  assert.doesNotMatch(html, /data-rule-review-row="draft-source-2"/);

  assert.match(dialogStyles, /\.tt-constraint-source\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-warning\s*{/);
  assert.match(styles, /\.tt-rule-review-table\s*{/);
});

test('timetable smart scan renders problem details inline with beginner actions', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      draftRows: [{
        id: 'row-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        slots: [],
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
      }],
      warnings: [],
    },
    constraintScan: {
      open: true,
      completed: true,
      scanning: false,
      stats: { total: 1, autoFixable: 1, completeness: 95, scanDuration: 12, checksPerformed: 5, complianceScore: 95 },
      problems: [{
        id: 'missing_slots',
        type: 'HARD',
        severity: 'urgent',
        title: '有 1 条约束还没安排具体时间',
        description: '缺少明确节次',
        count: 1,
        autoFixable: true,
        fixSuggestion: '可自动补齐 1 条已能识别的时段',
        constraints: [{ id: 'row-1', rawText: 'Math Teacher 周三下午不排课' }],
      }],
    },
    problemDetailDialog: {
      open: true,
      problem: {
        id: 'missing_slots',
        type: 'HARD',
        severity: 'urgent',
        title: '有 1 条约束还没安排具体时间',
        description: '缺少明确节次',
        count: 1,
        autoFixable: true,
        fixSuggestion: '可自动补齐 1 条已能识别的时段',
        constraints: [{ id: 'row-1', rawText: 'Math Teacher 周三下午不排课' }],
      },
    },
  }));

  assert.match(html, /data-smart-helper-overlay/);
  assert.match(html, /tt-smart-detail/);
  assert.match(html, /问题详情/);
  assert.match(html, /修正建议/);
  assert.match(html, /data-action="close-problem-detail"/);
  assert.match(html, /data-action="apply-fix"/);
  assert.match(html, /data-action="discuss-with-ai"/);
  assert.match(html, /问智能/);
  assert.doesNotMatch(html, /问AI/);
  assert.match(html, /可自动补齐 1 条已能识别的时段/);
  assert.match(html, /data-smart-detail-backdrop/);
});

test('timetable smart helper applies generated fixes to review draft rows', () => {
  const controller = new TimetablePlannerController();
  const rows = [{
    id: 'row-1',
    type: 'teacher_unavailable',
    targetType: 'teacher',
    targetId: 't_math',
    targetName: 'Math Teacher',
    slots: [],
    status: 'invalid',
    warnings: ['缺少明确节次，请补充后再生效。'],
  }, {
    id: 'row-2',
    type: 'teacher_unavailable',
    targetType: 'teacher',
    targetId: 't_math',
    targetName: 'Math Teacher',
    slots: ['1-1'],
    status: 'effective',
    warnings: [],
  }];

  const updated = controller.applyFixToConstraints(rows, {
    fixes: [{
      action: 'set_slots',
      constraintId: 'row-1',
      slots: ['3-5', '3-6', '3-7'],
    }, {
      action: 'replace_slot',
      constraintId: 'row-2',
      from: '1-1',
      to: '1-2',
    }, {
      action: 'add_constraint',
      constraint: {
        id: 'auto_teacher_daily_limit_t_math',
        type: 'teacher_daily_limit',
        targetType: 'teacher',
        targetId: 't_math',
        targetName: 'Math Teacher',
        value: 5,
        priority: 'soft',
        status: 'effective',
      },
    }],
  });

  assert.deepEqual(updated[0].slots, ['3-5', '3-6', '3-7']);
  assert.equal(updated[0].status, 'needs_review');
  assert.equal(updated[0].warnings.length, 0);
  assert.deepEqual(updated[1].slots, ['1-2']);
  assert.equal(updated[1].status, 'needs_review');
  assert.ok(updated.some(row => row.id === 'auto_teacher_daily_limit_t_math'));
});

test('timetable beginner rule cards update the underlying review draft rows', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    open: true,
    step: 'review',
    mode: 'text',
    advancedOpen: false,
    draftRows: [{
      id: 'card-1',
      rawText: '王老师周三下午不排课',
      type: 'teacher_unavailable',
      targetType: 'teacher',
      targetId: 't_math',
      targetName: 'Math Teacher',
      slots: ['3-5'],
      priority: 'hard',
      status: 'needs_review',
      description: '教师不可排',
      warnings: [],
    }, {
      id: 'card-2',
      rawText: '体育课尽量分散',
      type: 'subject_spread',
      targetType: 'subject',
      targetId: 'pe',
      targetName: '体育',
      slots: [],
      priority: 'soft',
      status: 'needs_review',
      description: '同科分散',
      warnings: [],
    }],
    warnings: [],
  };

  controller.markRuleReviewRowEffective('card-1');
  assert.equal(controller.state.ruleReview.draftRows.find(row => row.id === 'card-1').status, 'effective');

  controller.ignoreRuleReviewRow('card-1');
  assert.equal(controller.state.ruleReview.draftRows.find(row => row.id === 'card-1').status, 'ignored');

  controller.editRuleReviewRow('card-1');
  assert.equal(controller.state.ruleReview.advancedOpen, true);
  assert.equal(controller.state.ruleReview.selectedRuleId, 'card-1');

  controller.deleteRuleReviewCard('card-2');
  assert.deepEqual(controller.state.ruleReview.draftRows.map(row => row.id), ['card-1']);
});

test('timetable smart helper asks through the existing constraint chat with problem context', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.setMessage = message => {
    controller.state.message = message;
  };
  controller.state.ruleReview = {
    open: true,
    step: 'review',
    draftRows: [{ id: 'row-1', type: 'teacher_unavailable', status: 'needs_review' }],
  };
  controller.state.constraintScan = {
    problems: [{
      id: 'missing_slots',
      title: '缺少节次',
      description: '王老师没说明第几节',
      fixSuggestion: '补充具体节次',
    }],
  };
  let optionsSeen = null;
  controller.startConstraintConversation = async options => {
    optionsSeen = options;
    controller.state.constraintChat = {
      open: true,
      inputText: '',
      messages: [],
      activeTaskId: options?.taskContext?.taskId || '',
    };
  };

  await controller.openAIChatFromHelper('missing_slots');

  assert.equal(controller.state.constraintChat.open, true);
  assert.equal(optionsSeen.intent, 'explain');
  assert.equal(optionsSeen.taskContext.taskId, 'missing_slots');
  assert.equal(optionsSeen.taskContext.taskType, 'missing_slots');
  assert.match(optionsSeen.taskContext.examples.join('\n'), /王老师没说明第几节/);
  assert.equal(controller.state.constraintChat.activeTaskId, 'missing_slots');
});

test('timetable smart helper interactions include detail close and problem-aware chat', async () => {
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');

  assert.match(interactionSource, /data-smart-detail-backdrop/);
  assert.match(interactionSource, /closeProblemDetails/);
  assert.match(interactionSource, /openAIChatFromHelper\(event\.target\.closest\('\[data-problem-id\]'\)/);
});

test('timetable constraint chat preview application updates drafts only after confirmation', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.state.ruleReview = {
    open: true,
    step: 'review',
    draftRows: [{
      id: 'draft-1',
      type: 'teacher_unavailable',
      targetName: '王老师',
      slots: ['1-8', '1-7'],
      warnings: ['节次 1-8 不在当前排课范围内。'],
      status: 'needs_review',
    }],
  };
  controller.state.project = createDefaultTimetableProject({
    teachers: [{ id: 't_wang', name: '王老师' }],
    classes: [{ id: 'c1', name: '七年级1班' }],
    subjects: [{ id: 'math', name: '数学' }],
    lessonPlans: [],
    rules: { hardRules: {}, softRules: {} },
  });
  controller.state.constraintChat = {
    open: true,
    docked: true,
    actionPreview: {
      title: '过滤超出范围节次',
      affectedRuleIds: ['draft-1'],
      changes: [{
        ruleId: 'draft-1',
        updates: {
          slots: ['1-7'],
          warnings: [],
          status: 'effective',
        },
      }],
      requiresConfirmation: true,
    },
  };

  const savedRulesBefore = JSON.stringify(controller.state.project.rules);
  assert.deepEqual(controller.state.ruleReview.draftRows[0].slots, ['1-8', '1-7']);

  controller.applyConstraintChatPreview();

  assert.deepEqual(controller.state.ruleReview.draftRows[0].slots, ['1-7']);
  assert.equal(controller.state.ruleReview.draftRows[0].status, 'effective');
  assert.deepEqual(controller.state.ruleReview.draftRows[0].warnings, []);
  assert.equal(JSON.stringify(controller.state.project.rules), savedRulesBefore);
});

test('timetable smart scan status stays compact and completed problems join the task workbench', () => {
  const baseReview = {
    open: true,
    step: 'review',
    mode: 'file',
    draftRows: [{ id: 'row-1', type: 'teacher_unavailable', status: 'needs_review' }],
    warnings: [],
  };
  const problem = index => ({
    id: `urgent-${index}`,
    type: 'HARD',
    severity: 'urgent',
    title: `紧急问题 ${index}`,
    description: `问题 ${index}`,
    count: 1,
    autoFixable: true,
    fixSuggestion: '生成修复预览',
  });

  const errorHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: false,
      error: '扫描服务暂不可用',
      problems: [],
      stats: {},
    },
  }));
  assert.match(errorHtml, /扫描服务暂不可用/);
  assert.match(errorHtml, /data-action="rescan-smart-helper"/);

  const loadingHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: true,
      progress: 60,
      phase: '检查可能冲突的规则...',
      problems: [],
      stats: {},
    },
  }));
  assert.match(loadingHtml, /检查可能冲突的规则/);
  assert.match(loadingHtml, /智能助手正在检查约束/);

  const scanHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: false,
      applyingAll: true,
      expandedGroups: new Set(['urgent']),
      stats: { total: 4, autoFixable: 4, completeness: 80, scanDuration: 3, checksPerformed: 5, complianceScore: 80 },
      problems: [problem(1), problem(2), problem(3), problem(4)],
    },
  }));
  assert.match(scanHtml, /智能检查完成/);
  assert.match(scanHtml, /发现 4 个问题/);
  assert.match(scanHtml, /紧急问题 1/);
  assert.match(scanHtml, /紧急问题 4/);
  assert.match(scanHtml, /data-problem-id="urgent-1"/);
  assert.match(scanHtml, /data-action="apply-fix"/);
  assert.doesNotMatch(scanHtml, /class="tt-smart-helper"/);
  assert.match(scanHtml, /data-action="apply-all-fixes"[^>]*disabled/);

  const previewHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: baseReview,
    constraintScan: {
      open: true,
      scanning: false,
      expandedGroups: new Set(['urgent']),
      stats: { total: 4, autoFixable: 4, completeness: 80, scanDuration: 3, checksPerformed: 5, complianceScore: 80 },
      problems: [problem(1), problem(2), problem(3), problem(4)],
    },
    fixPreview: {
      open: true,
      applying: true,
      problem: problem(1),
      fix: {
        preview: { before: '修复前', after: '修复后' },
        fixes: [{ reason: '测试修复' }],
      },
    },
  }));
  assert.match(previewHtml, /应用中/);
  assert.match(previewHtml, /data-action="confirm-fix"[^>]*disabled/);
});

test('timetable rule review renders a beginner task workbench instead of raw question lists', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const ruleReview = {
      open: true,
      step: 'review',
      mode: 'text',
      inputType: 'text',
      nextAction: 'ask_user',
      activeTaskId: 'confirm_teacher_names',
      autoAcceptable: [{
        id: 'auto-1',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetName: '数学',
        targetId: 'math',
        priority: 'soft',
        status: 'effective',
        confidence: 0.93,
        description: '数学优先上午',
      }],
      needReview: [{
        id: 'review-1',
        rawText: '王老师周三下午不要排',
        type: 'teacher_unavailable',
        targetName: '王老师',
        priority: 'hard',
        status: 'needs_review',
        confidence: 0.62,
        warnings: ['存在多个候选教师'],
      }],
      clarifyingQuestions: [{
        id: 'q_1',
        question: '你说的王老师是哪一位？',
        reason: '存在多个同姓教师',
        targetType: 'teacher',
        targetText: '王老师',
        options: [
          { label: '王明', value: 't_wang_ming' },
          { label: '王华', value: 't_wang_hua' },
        ],
        relatedRuleIds: ['review-1'],
      }],
      missingInfo: [{
        id: 'm_1',
        message: '你说的道法、地理、劳动是哪个课程？',
        targetType: 'subject',
        targetText: '道法、地理、劳动',
        relatedRuleIds: ['review-2'],
      }, {
        id: 'm_2',
        message: '节次 1-8、2-8 不在当前排课范围内。',
        relatedRuleIds: ['review-1'],
      }],
      conflicts: [{ level: 'blocking', message: '李老师不可排与锁定课节冲突', suggestion: '取消其中一个硬约束。', relatedRuleIds: ['lock-1'] }],
      unsupportedItems: [{ id: 'u_1', type: 'teacher_free_period_compact', targetName: '全部教师', description: '当前仅作为建议。' }],
      confidenceSummary: { high: 1, medium: 1, low: 0 },
      draftRows: [{
        id: 'auto-1',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '数学',
        targetId: 'math',
        priority: 'soft',
        status: 'effective',
        confidence: 0.93,
        warnings: [],
      }, {
        id: 'review-1',
        rawText: '王老师周三下午不要排',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        priority: 'hard',
        status: 'needs_review',
        confidence: 0.62,
        warnings: ['存在多个候选教师'],
      }],
      warnings: [],
  };
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview,
  }));
  const readyHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview,
  }));
  const conflictHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'conflict',
    }),
    ruleReview,
  }));
  const unsupportedHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'unsupported',
    }),
    ruleReview,
  }));
  const advancedHtml = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'review',
    }),
    ruleReview: { ...ruleReview, advancedOpen: true },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /tt-constraint-dialog/);
  assert.match(html, /已识别约束 \(2\)/);
  assert.match(html, /数学尽量上午/);
  assert.match(html, /王老师周三下午不要排/);
  assert.match(html, /存在多个候选教师/);
  assert.match(html, /data-constraint-id="auto-1"/);
  assert.match(html, /data-constraint-id="review-1"/);
  assert.match(html, /data-action="edit-constraint"/);
  assert.match(html, /data-action="delete-constraint"/);
  assert.match(html, /data-action="apply-constraints"/);
  assert.doesNotMatch(html, /tt-smart-workbench/);
  assert.doesNotMatch(html, /tt-smart-task-checklist/);
  assert.doesNotMatch(html, /data-action="smart-workbench-section"/);
  assert.doesNotMatch(html, /你说的王老师是哪一位/);
  assert.doesNotMatch(html, /你说的道法、地理、劳动是哪个课程/);
  assert.doesNotMatch(html, /data-rule-clarify-question="q_1"/);
  assert.match(readyHtml, /data-action="apply-constraints"/);
  assert.match(conflictHtml, /data-constraint-dialog-overlay/);
  assert.match(unsupportedHtml, /data-constraint-dialog-overlay/);
  assert.doesNotMatch(html, /data-rule-review-row="auto-1"/);
  assert.doesNotMatch(advancedHtml, /data-rule-review-row="auto-1"/);
  assert.doesNotMatch(advancedHtml, /data-rule-review-field="rawText"/);

  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  assert.match(dialogStyles, /\.tt-constraint-dialog\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-card\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-actions\s*{/);
});

test('timetable constraint dialog renders manual mode without old clarify questions', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    constraintDialog: createConstraintDialogState({ open: true }),
    ruleReview: {
      open: true,
      step: 'manual',
      mode: 'manual',
      clarifyingQuestions: [{
        id: 'q_empty',
        question: 'Which all-teacher object?',
        reason: 'No valid candidate should be shown as a dropdown.',
        options: [
          { label: '', value: '' },
          { label: null, value: null },
        ],
      }],
      draftRows: [],
      warnings: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /id="tt-manual-target"/);
  assert.match(html, /id="tt-manual-time"/);
  assert.match(html, /data-action="add-manual-constraint"/);
  assert.doesNotMatch(html, /data-rule-clarify-question="q_empty"/);
  assert.doesNotMatch(html, /data-rule-question-answer="q_empty"/);
});

test('timetable constraint dialog renders recognized rule cards instead of the removed report workbench', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputType: 'text',
      draftRows: [{
        id: 'rule_kept',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetType: 'subject',
        targetId: 'math',
        targetName: 'Math',
        priority: 'soft',
        status: 'effective',
        confidence: 0.93,
        warnings: [],
      }],
      autoAcceptable: [{
        id: 'rule_kept',
        rawText: '数学尽量上午',
        type: 'subject_morning',
        targetId: 'math',
        targetName: 'Math',
        status: 'effective',
      }],
      needReview: [],
      unsupportedItems: [],
      warnings: [],
      conflicts: [],
      ruleReport: {
        sourceKind: 'rules',
        summary: { total: 3, kept: 1, degraded: 1, dropped: 0, review: 1 },
        entries: [{
          category: 'kept',
          source: { rowId: 'rule_kept', inputType: 'text' },
          field: 'subject_morning',
          reason: '高置信度规则，可确认后写入。',
        }, {
          category: 'degraded',
          source: { rowId: 'rule_suggestion', inputType: 'text' },
          field: 'teacher_load_balance',
          reason: '当前只能作为建议展示，不会直接写入规则。',
        }, {
          category: 'review',
          source: { rowId: 'rule_review', inputType: 'text' },
          field: 'teacher_unavailable',
          reason: '王老师需要复核后才能生效。',
        }],
        hasIssues: true,
      },
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /已识别约束 \(1\)/);
  assert.match(html, /数学尽量上午/);
  assert.match(html, /data-constraint-id="rule_kept"/);
  assert.match(html, /data-action="apply-constraints"/);
  assert.doesNotMatch(html, /规则报告/);
  assert.doesNotMatch(html, /当前只能作为建议展示，不会直接写入规则。/);
});

test('timetable constraint dialog disables apply when blocking conflicts exist', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    smartWorkbench: createConstraintDialogState({
      open: true,
      stage: 'reviewing_constraints',
      selectedSection: 'ready',
    }),
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      activeTaskId: 'ready_to_apply',
      autoAcceptable: [{
        id: 'auto-1',
        type: 'subject_morning',
        targetName: '数学',
        status: 'effective',
        confidence: 0.92,
          warnings: [],
      }],
      draftRows: [{
        id: 'auto-1',
        type: 'subject_morning',
        targetType: 'subject',
        targetName: '数学',
        status: 'effective',
        confidence: 0.92,
        warnings: [],
        hasConflict: true,
        conflicts: [{ level: 'blocking', message: '锁定课节与教师不可用冲突。' }],
      }],
      needReview: [],
      conflicts: [{ level: 'blocking', message: '锁定课节与教师不可用冲突。' }],
      warnings: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /data-action="apply-constraints"[^>]*disabled/);
  assert.match(html, /锁定课节与教师不可用冲突/);
  assert.match(html, /tt-constraint-card--conflict/);
});

test('timetable rule review can clarify questions and request rule diagnosis', async () => {
  const calls = [];
  let clarifyBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/rules/clarify')) {
      clarifyBody = calls.at(-1).body;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              draftRows: [{
                id: 'review-1',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_wang_hua',
                targetName: '王华',
                slots: ['3-5'],
                priority: 'hard',
                status: 'effective',
                confidence: 0.9,
                warnings: [],
              }],
              autoAcceptable: [{ id: 'review-1', status: 'effective' }],
              needReview: [],
              warnings: [],
              unsupportedItems: [],
              nextAction: 'ready_to_apply',
            },
          };
        },
      };
    }
    if (String(url).endsWith('/rules/diagnose')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              diagnosis: {
                summary: '当前约束没有明显无解风险。',
                blockingRules: [],
                suggestedRelaxations: ['可以继续试排。'],
                questions: [],
              },
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.state.project = createDefaultTimetableProject({
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [
        { id: 't_wang_ming', name: '王明', subjects: ['math'], unavailableSlots: [] },
        { id: 't_wang_hua', name: '王华', subjects: ['math'], unavailableSlots: [] },
      ],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang_hua', weeklyHours: 3 }],
    });
    controller.state.ruleReview = {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
      draftRows: [{
        id: 'review-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        slots: ['3-5'],
        priority: 'hard',
        status: 'needs_review',
        confidence: 0.7,
        warnings: ['存在多个候选教师'],
      }],
      clarifyingQuestions: [{
        id: 'q_review-1_target',
        targetType: 'teacher',
        targetText: 'Wang',
        question: '你说的王老师是哪一位？',
        options: [{ label: '王华', value: 't_wang_hua' }],
      }],
    };
    controller.state.pendingRules = [
      { id: 'old-duplicate' },
      ...controller.state.ruleReview.draftRows,
    ];
    controller.state.container = {
      innerHTML: '',
      querySelectorAll(selector) {
        if (selector === '[data-rule-clarify-question]') {
          return [{
            dataset: { ruleClarifyQuestion: 'q_review-1_target', targetType: 'teacher', targetText: 'Wang' },
            querySelectorAll(innerSelector) {
              if (innerSelector === '[data-rule-clarify-option]') {
                return [{
                  checked: true,
                  value: 't_wang_hua',
                  dataset: { label: 'Wang Hua' },
                }];
              }
              return [];
            },
            querySelector() { return null; },
          }];
        }
        if (selector === '[data-rule-question-answer]') {
          return [{
            dataset: { ruleQuestionAnswer: 'q_review-1_target' },
            value: 't_wang_hua',
            selectedIndex: 0,
            options: [{ textContent: '王华' }],
          }];
        }
        return [];
      },
      querySelector() { return null; },
    };
    controller.render = () => {};

    await controller.submitClarifyingAnswers();
    assert.ok(calls.some(call => call.url.endsWith('/rules/clarify')));
    assert.ok(clarifyBody.project);
    assert.equal(clarifyBody.originalText, 'original constraint');
    assert.equal(clarifyBody.previousResult?.draftRows?.length, 1);
    assert.deepEqual(clarifyBody.answers, [{
      questionId: 'q_review-1_target',
      value: 't_wang_hua',
      label: 'Wang Hua',
      targetType: 'teacher',
      targetText: 'Wang',
    }]);
    assert.equal(controller.state.ruleReview.draftRows[0].targetId, 't_wang_hua');
    assert.deepEqual(controller.state.pendingRules.map(row => row.id), ['review-1']);

    await controller.diagnoseRules();
    assert.ok(calls.some(call => call.url.endsWith('/rules/diagnose')));
    assert.equal(controller.state.ruleReview.diagnosis.summary, '当前约束没有明显无解风险。');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable constraint dialog card aligns controls and helper text without the removed table', async () => {
  const dialogStyles = await readFile(constraintDialogStylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: '智能-rules.xlsx',
      inputType: 'xlsx_constraints',
      draftRows: [{
        id: 'draft-align-1',
        rawText: 'Music should avoid the last periods',
        type: 'subject_avoid_periods',
        targetType: 'subject',
        targetName: 'Music',
        targetId: 'music',
        slots: ['1-5', '1-6', '1-7', '2-5'],
        priority: 'soft',
        status: 'effective',
        confidence: 0.7,
        description: 'Music should be arranged before afternoon or half day',
        warnings: ['Long warning should stay in the helper row instead of moving controls'],
      }],
      contextStats: { rowCount: 1 },
      warnings: [],
      advancedOpen: true,
      loading: false,
    },
  }));

  assert.match(html, /data-constraint-dialog-overlay/);
  assert.match(html, /data-constraint-id="draft-align-1"/);
  assert.match(html, /Music should avoid the last periods/);
  assert.match(html, /Long warning should stay/);
  assert.match(html, /class="tt-constraint-actions"/);
  assert.match(html, /data-action="edit-constraint"/);
  assert.match(html, /data-action="delete-constraint"/);
  assert.doesNotMatch(html, /<colgroup class="tt-rule-review-cols">/);
  assert.doesNotMatch(html, /data-rule-review-field="slots"/);

  assert.match(dialogStyles, /\.tt-constraint-card\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-content\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-warning\s*{/);
  assert.match(dialogStyles, /\.tt-constraint-actions\s*{/);
});

test('timetable saved smart rules remain summarized while the constraint dialog stays separate', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const project = createDefaultTimetableProject({
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [
      { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
      { id: 'pe', name: 'PE', priority: 30, color: '#22c55e' },
    ],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: {
      hardRules: {
        teacherUnavailable: { t_math: ['3-4'] },
        classUnavailable: { c1: ['5-7'] },
        lockedSlots: [{ id: 'lock_1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
      },
      softRules: {
        morningSubjects: ['math'],
        subjectPreferredPeriods: { math: { prefer: ['1-1'], avoid: ['5-7'], weight: 20 } },
        teacherLimits: { t_math: { daily: 3, consecutive: 2 } },
        spreadSubjects: ['pe'],
      },
    },
    schedule: null,
  });

  const savedItems = getSavedRuleItems(project);
  const summary = getRuleSummary(project);

  assert.equal(savedItems.length, 9);
  assert.equal(summary.total, 9);
  assert.ok(savedItems.some(item => item.type === 'subject_preferred_periods' && item.slots.includes('1-1')));
  assert.ok(savedItems.some(item => item.type === 'teacher_daily_limit' && item.targetName === 'Math Teacher'));
  assert.ok(savedItems.some(item => item.type === 'subject_spread' && item.targetName === 'PE'));

  // Saved rules render inline in the sidebar as a saved rule list
  const html = renderWorkbench(sampleWorkbenchState({
    project,
    pendingRules: [],
    expandedRuleId: null,
    ruleInput: { text: '', fileName: '', loading: false },
  }));
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  // New card-based saved rules section
  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.match(sidebar, /class="[^"]*tt-rule-stack[^"]*tt-rules-setup-card[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.match(sidebar, /class="[^"]*tt-rule-summary[^"]*"/);
  assert.match(sidebar, /查看已应用约束|查看已生效约束/);
  assert.match(sidebar, /9/);
  assert.match(sidebar, /id="tt-clear-rules"/);
  assert.doesNotMatch(sidebar, /id="tt-saved-rules"/);
  assert.doesNotMatch(sidebar, /data-saved-rule-delete=/);
  assert.doesNotMatch(sidebar, /data-saved-rule="/);
  // Rule type labels are visible
  assert.doesNotMatch(sidebar, /teacher_daily_limit/);
  assert.doesNotMatch(sidebar, /subject_spread/);

  const workbenchHtml = renderWorkbench(sampleWorkbenchState({
    project,
    constraintDialog: { open: true },
    smartWorkbench: { open: false },
    ruleReview: {
      open: false,
      draftRows: [],
      warnings: [],
    },
  }));

  assert.match(workbenchHtml, /data-constraint-dialog-overlay/);
  assert.match(workbenchHtml, /智能约束助手/);
  assert.match(workbenchHtml, /已应用约束|已生效约束/);
  assert.match(workbenchHtml, /排课要求/);
  assert.match(workbenchHtml, /理解要求/);
  assert.match(workbenchHtml, /data-action="parse-constraints"/);
  assert.doesNotMatch(workbenchHtml, /data-smart-workbench-root/);
  assert.doesNotMatch(workbenchHtml, /data-saved-rule-delete=/);
  assert.doesNotMatch(workbenchHtml, /id="tt-saved-rule-table"/);
  assert.doesNotMatch(workbenchHtml, /id="tt-rule-review-dialog"/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rules\s+\.tt-saved-rule-row\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rule-row\s*\{/);
});

test('timetable saved 智能 rules can be removed one at a time without clearing others', () => {
  const project = createDefaultTimetableProject({
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: 'G7', name: '1' }],
    subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
    rules: {
      hardRules: {
        teacherUnavailable: { t_math: ['3-4', '4-5'] },
        lockedSlots: [{ id: 'lock_1', day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' }],
      },
      softRules: {
        morningSubjects: ['math'],
        subjectPreferredPeriods: { math: { prefer: ['1-1'], avoid: ['5-7'], weight: 20 } },
      },
    },
  });

  const items = getSavedRuleItems(project);
  const teacherRule = items.find(item => item.type === 'teacher_unavailable' && item.slots.includes('3-4'));
  const preferredRule = items.find(item => item.type === 'subject_preferred_periods');
  const lockedRule = items.find(item => item.type === 'locked_slot');
  const morningRule = items.find(item => item.type === 'subject_morning');

  const withoutTeacher = removeSavedRuleById(project, teacherRule.id);
  assert.deepEqual(withoutTeacher.hardRules.teacherUnavailable.t_math, ['4-5']);

  const withoutPreferred = removeSavedRuleById({ ...project, rules: withoutTeacher }, preferredRule.id);
  assert.deepEqual(withoutPreferred.softRules.subjectPreferredPeriods.math.prefer, []);
  assert.deepEqual(withoutPreferred.softRules.subjectPreferredPeriods.math.avoid, ['5-7']);

  const withoutLocked = removeSavedRuleById({ ...project, rules: withoutPreferred }, lockedRule.id);
  assert.deepEqual(withoutLocked.hardRules.lockedSlots, []);

  const withoutMorning = removeSavedRuleById({ ...project, rules: withoutLocked }, morningRule.id);
  assert.deepEqual(withoutMorning.softRules.morningSubjects, []);
  assert.deepEqual(withoutMorning.hardRules.teacherUnavailable.t_math, ['4-5']);
});

test('timetable modal overlays do not close when the blank overlay is clicked', async () => {
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');

  assert.doesNotMatch(interactionSource, /\[data-rule-review-close\][\s\S]{0,220}closeRuleReview\(/);
  assert.doesNotMatch(interactionSource, /\[data-roster-import-close\][\s\S]{0,220}closeRosterImport\(/);
});

test('timetable Escape steps back inside the workbench instead of bubbling to the tool shell', () => {
  let stopped = false;
  let prevented = false;
  const closed = [];
  const event = {
    key: 'Escape',
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  const controller = {
    closeRestoreDialog() {
      closed.push('restore');
    },
    closePublicationHistoryDialog() {
      closed.push('history');
    },
    closePublishDialog() {
      closed.push('publish');
    },
    closePeriodTimeDialog() {
      closed.push('period');
    },
    closeRosterImport() {
      closed.push('roster');
    },
    closeConstraintChat() {
      closed.push('chat');
    },
    closeProblemDetails() {
      closed.push('problem');
    },
    closeSmartWorkbench() {
      closed.push('smart');
      state.smartWorkbench.open = false;
    },
    render() {
      closed.push('render');
    },
  };
  let removedDetails = 0;
  let openDetails = [{ removeAttribute() { removedDetails += 1; } }];
  const state = {
    restoreDialog: { open: true },
    publicationHistoryDialog: { open: true },
    publishDialog: { open: true },
    periodTimeDialog: { open: true },
    rosterImport: { open: true },
    constraintChat: { open: true },
    problemDetailDialog: { open: true, problem: { id: 'p1' } },
    smartWorkbench: { open: true },
    selectedSlotId: 'slot-1',
    inspectorOpen: true,
  };
  const container = {
    querySelectorAll() {
      return openDetails;
    },
  };

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(closed, ['restore']);

  state.restoreDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history']);

  state.publicationHistoryDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish']);

  state.publishDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period']);

  state.periodTimeDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'roster']);

  state.rosterImport.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'roster', 'chat']);

  state.constraintChat.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'roster', 'chat', 'problem']);

  state.problemDetailDialog.open = false;
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'roster', 'chat', 'problem']);
  assert.equal(removedDetails, 1);
  assert.equal(state.selectedSlotId, 'slot-1');

  openDetails = [];
  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'roster', 'chat', 'problem', 'smart']);
  assert.equal(state.selectedSlotId, 'slot-1');

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.deepEqual(closed, ['restore', 'history', 'publish', 'period', 'roster', 'chat', 'problem', 'smart', 'render']);
  assert.equal(state.selectedSlotId, '');
  assert.equal(state.inspectorOpen, false);

  assert.equal(handleTimetableEscape(event, container, controller, state), true);
  assert.equal(stopped, true);
});

test('timetable tool handles Escape before the app launcher can close the tool', async () => {
  const launcherSource = await readFile(appLauncherPath, 'utf8');
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');

  assert.match(launcherSource, /currentToolInstance[\s\S]*handleEscape[\s\S]*return;/);
  assert.match(controllerSource, /handleEscape\(event\)\s*{[\s\S]*handleTimetableEscape\(event,\s*this\.state\.container,\s*this,\s*this\.state\)/);
});

test('timetable left sidebar range workflow applies only from the range popover done button', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const stateSource = await readFile(new URL('state.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(stateSource, /workflowOpenSections/);
  assert.match(stateSource, /rangeDraft/);
  assert.match(stateSource, /bulkRuleDraft/);
  assert.match(controllerSource, /toggleWorkflowSection\(/);
  assert.match(controllerSource, /updateRangeDraftFromForm\(/);
  assert.match(controllerSource, /applyRangeDraft\(/);
  assert.match(interactionSource, /data-tt-section-toggle/);
  assert.doesNotMatch(interactionSource, /#tt-apply-range/);
  assert.doesNotMatch(interactionSource, /#tt-reset-range/);
  assert.match(interactionSource, /\[data-range-apply\]/);
  assert.match(interactionSource, /applyRangeDraft\(/);
  assert.match(interactionSource, /\[data-active-weekday\]/);
  assert.match(interactionSource, /\[data-active-period\]/);
  assert.doesNotMatch(interactionSource, /\[data-active-weekday\][\s\S]{0,160}saveProject\(/);
  assert.doesNotMatch(interactionSource, /\[data-active-period\][\s\S]{0,160}saveProject\(/);
  assert.match(styles, /\.tt-workflow-panel/);
  assert.match(styles, /\.tt-range-summary-grid/);
  assert.match(styles, /\.tt-multi-select/);
  assert.match(styles, /\.tt-multi-select-popover/);
  assert.match(styles, /\.tt-range-setup-card\s+\.tt-range-summary-icon\s*{[^}]*background:\s*rgba\(8,\s*145,\s*178,\s*0\.12\);[^}]*border:\s*1px solid rgba\(8,\s*145,\s*178,\s*0\.24\);[^}]*color:\s*var\(--tt-primary\);/s);
  assert.doesNotMatch(styles, /\.tt-range-setup-card\s+\.tt-range-summary-icon\s*{[^}]*var\(--tt-success\)/s);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-multi-select-popover/);
});

test('timetable period time setup uses a compact entry and modal editor', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activePeriods: [1, 2, 3],
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
      ],
    }),
  });

  const closed = renderWorkbench(state);
  const sidebar = closed.slice(closed.indexOf('<aside class="tt-sidebar"'), closed.indexOf('<section class="tt-schedule-panel"'));

  assert.match(sidebar, /id="tt-open-period-time-dialog"/);
  assert.match(sidebar, /节次时间/);
  assert.match(sidebar, /08:00-09:30 · 已配置 2 节/);
  assert.doesNotMatch(sidebar, /class="tt-period-time-table"/);
  assert.doesNotMatch(sidebar, /data-period-time-draft-start/);

  const open = renderWorkbench({
    ...state,
    periodTimeDialog: {
      open: true,
      draftTimes: state.project.periodTimes,
      segmentConfig: {
        globalDefaults: { classMinutes: 45, breakMinutes: 10 },
        segments: [
          { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 3, classMinutes: null, breakMinutes: null },
        ],
      },
    },
  });

  assert.match(open, /id="tt-period-time-dialog"/);
  assert.match(open, /id="tt-segment-global-class-minutes"/);
  assert.match(open, /id="tt-segment-global-break-minutes"/);
  assert.match(open, /id="tt-add-segment"/);
  assert.match(open, /data-segment-template="standard"/);
  assert.match(open, /data-segment-template="withMorningEvening"/);
  assert.match(open, /data-segment-template="juniorHigh"/);
  assert.match(open, /data-segment-id="seg-1"/);
  assert.match(open, /data-segment-field="seg-1-label"/);
  assert.match(open, /data-segment-field="seg-1-startTime"/);
  assert.match(open, /data-segment-field="seg-1-periodCount"/);
  assert.match(open, /data-period-time-row="1"/);
  assert.match(open, /data-period-time-draft-start="1"/);
  assert.match(open, /data-period-time-draft-end="1"/);
  assert.match(open, /data-period-time-gap-after="1"/);
  assert.match(open, /data-period-time-gap-after="2"/);
  assert.doesNotMatch(open, /data-period-time-gap-after="3"/);
  assert.match(open, /data-label="开始时间"/);
  assert.match(open, /data-label="本节后间隔"/);
  assert.match(open, /id="tt-clear-period-times"/);
  assert.match(open, /id="tt-cancel-period-times-secondary"[^>]*>[\s\S]*data-lucide="x"[\s\S]*<span>取消<\/span>/);
  assert.match(open, /id="tt-save-period-times"/);
  assert.match(open, /id="tt-cancel-period-times"/);
  assert.match(styles, /\.tt-period-time-entry\s*{/);
  assert.match(styles, /\.tt-period-time-settings\s*{/);
  assert.match(styles, /\.tt-period-time-dialog\s*{/);
  assert.match(styles, /\.tt-period-time-table\s*{/);
  assert.match(styles, /\.tt-segment-card\s*{/);
  assert.match(styles, /\.tt-segment-list\s*{/);
  assert.match(styles, /\.tt-global-defaults\s*{/);
  assert.match(styles, /\.tt-roster-review-field\s*{[\s\S]*box-sizing:\s*border-box;/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-dialog/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table,[\s\S]*\.tt-period-time-table thead,[\s\S]*\.tt-period-time-table tbody,[\s\S]*\.tt-period-time-table tr,[\s\S]*\.tt-period-time-table th,[\s\S]*\.tt-period-time-table td\s*{[\s\S]*display:\s*block;/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table td\s*{[\s\S]*grid-template-columns:\s*88px minmax\(0,\s*1fr\);/);
  assert.match(interactionSource, /#tt-open-period-time-dialog/);
  assert.match(interactionSource, /\[data-segment-field\]/);
  assert.match(interactionSource, /\[data-global-default-field\]/);
  assert.match(interactionSource, /\[data-segment-template\]/);
  assert.match(interactionSource, /\[data-add-segment\]/);
  assert.match(interactionSource, /\[data-remove-segment\]/);
  assert.match(interactionSource, /\[data-period-time-gap-after\]/);
  assert.match(interactionSource, /#tt-save-period-times/);
});

test('timetable period time segment labels drive timeline group headers', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      activePeriods: [1, 2, 3, 4],
      periodTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '14:00', end: '14:40' },
        { period: 4, start: '14:50', end: '15:30' },
      ],
    }),
    periodTimeDialog: {
      open: true,
      draftTimes: [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: '08:50', end: '09:30' },
        { period: 3, start: '14:00', end: '14:40' },
        { period: 4, start: '14:50', end: '15:30' },
      ],
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'seg-1', label: '自定义上午', startTime: '08:00', periodCount: 2, classMinutes: null, breakMinutes: null },
          { id: 'seg-2', label: '自定义下午', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
        ],
      },
    },
  });

  const html = renderWorkbench(state);

  assert.match(html, /tt-period-time-segment-header[\s\S]*自定义上午/);
  assert.match(html, /tt-period-time-segment-header[\s\S]*自定义下午/);
});

test('timetable period time segment label edits update timeline headers without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('segment label edits should update timeline headers without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4] }));
  const previousConfig = {
    globalDefaults: { classMinutes: 40, breakMinutes: 10 },
    segments: [
      { id: 'seg-1', label: '上午时段', startTime: '08:00', periodCount: 2, classMinutes: null, breakMinutes: null },
      { id: 'seg-2', label: '下午时段', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
    ],
  };
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 270 },
    { period: 3, start: '14:00', end: '14:40', gapAfter: 10 },
    { period: 4, start: '14:50', end: '15:30' },
  ], {}, {
    'seg-1': { label: '自定义上午', startTime: '08:00', periodCount: 2, classMinutes: null, breakMinutes: null },
    'seg-2': { label: '自定义下午', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
  });
  dom.tableBody.insertBefore(dom.createSegmentHeader('上午时段'), dom.rows[0]);
  dom.tableBody.insertBefore(dom.createSegmentHeader('下午时段'), dom.rows[2]);
  controller.state.container = dom;
  controller.state.periodTimeDialog = {
    ...controller.state.periodTimeDialog,
    open: true,
    segmentConfig: previousConfig,
    draftTimes: controller.buildPeriodTimesFromSegments(previousConfig, [1, 2, 3, 4]),
  };

  controller.updateSegmentConfigFromForm();

  const headerTexts = dom.tableBody
    .querySelectorAll('.tt-period-time-segment-header')
    .map(header => header.querySelector('strong')?.textContent);
  assert.deepEqual(headerTexts, ['自定义上午', '自定义下午']);
  assert.equal(controller.state.periodTimeDialog.draftTimes[0].segmentLabel, '自定义上午');
  assert.equal(controller.state.periodTimeDialog.draftTimes[2].segmentLabel, '自定义下午');
});

test('timetable period time dialog drafts fill, clear and save through project payload', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const schedule = {
    source: 'fast_constructed',
    slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
  };
  const project = createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimes: [{ period: 1, start: '07:55', end: '08:35' }],
    schedule,
  });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/project')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              project: createDefaultTimetableProject({
                ...project,
                ...body,
                schedule,
              }),
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.solverJob = { jobId: 'job_keep', status: 'running' };
    controller.state.ruleDraftPreview = [{ id: 'draft_keep', status: 'needs_review' }];
    controller.state.ruleWarnings = ['warning_keep'];

    controller.openPeriodTimeDialog();
    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.ok(controller.state.periodTimeDialog.segmentConfig);
    assert.equal(controller.state.periodTimeDialog.segmentConfig.globalDefaults.classMinutes, 40);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
      { period: 1, start: '07:55', end: '08:35' },
      { period: 2, start: '08:45', end: '09:25', manualOverride: false, segmentLabel: '上午时段' },
      { period: 3, start: '09:35', end: '10:15', manualOverride: false, segmentLabel: '上午时段' },
    ]);

    controller.autoFillPeriodTimes();
    assert.equal(calls.length, 0);
    assert.ok(controller.state.periodTimeDialog.segmentConfig);
    assert.equal(controller.state.periodTimeDialog.segmentConfig.globalDefaults.classMinutes, 45);
    assert.equal(controller.state.periodTimeDialog.draftTimes.length, 3);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes[0], { period: 1, start: '08:00', end: '08:45', manualOverride: false, segmentLabel: '上午时段' });

    controller.clearPeriodTimes();
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, []);

    controller.state.periodTimeDialog.draftTimes = [
      { period: 1, start: '08:10', end: '08:50' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ];
    await controller.savePeriodTimes();

    const projectSave = calls.find(call => call.url.endsWith('/project'));
    assert.ok(projectSave);
    assert.deepEqual(projectSave.body.periodTimes, [
      { period: 1, start: '08:10', end: '08:50' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ]);
    assert.ok(projectSave.body.periodTimeSegments);
    assert.ok(projectSave.body.dayPartBoundaries);
    assert.equal(projectSave.body.activePeriods, undefined);
    assert.equal(projectSave.body.activeWeekdays, undefined);
    assert.equal(controller.state.periodTimeDialog.open, false);
    assert.deepEqual(controller.state.solverJob, { jobId: 'job_keep', status: 'running' });
    assert.deepEqual(controller.state.ruleDraftPreview, [{ id: 'draft_keep', status: 'needs_review' }]);
    assert.deepEqual(controller.state.ruleWarnings, ['warning_keep']);
    assert.equal(controller.state.project.schedule.slots.length, 1);
    assert.equal(controller.state.project.schedule.slots[0].id, 'slot_1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time settings generate preview drafts from quick settings', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('quick setting edits should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  controller.render = () => {};
  controller.openPeriodTimeDialog();
  controller.render = () => {
    throw new Error('quick setting edits should update the draft without rerendering the modal');
  };

  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ], { startTime: '08:10', classMinutes: 35, breakMinutes: 5 });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();
  assert.deepEqual(controller.state.periodTimeDialog.settings, {
    startTime: '08:10',
    classMinutes: 35,
    breakMinutes: 5,
    afternoonStartPeriod: null,
    afternoonStartTime: '14:00',
    eveningStartPeriod: null,
    eveningStartTime: '19:00',
  });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:10', end: '08:45' },
    { period: 2, start: '08:50', end: '09:25' },
    { period: 3, start: '09:30', end: '10:05' },
  ]);
  assert.equal(dom.rows[0].startInput.value, '08:10');
  assert.equal(dom.rows[1].startInput.value, '08:50');
  assert.equal(dom.rows[2].endInput.value, '10:05');
});

test('timetable period time settings generate afternoon-anchored drafts without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('segmented quick setting edits should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
    { period: 5, start: '14:00', end: '14:40', gapAfter: 10 },
    { period: 6, start: '14:50', end: '15:30', gapAfter: 10 },
    { period: 7, start: '15:40', end: '16:20' },
  ], {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: 5,
    afternoonStartTime: '14:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.deepEqual(controller.state.periodTimeDialog.settings, {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: 5,
    afternoonStartTime: '14:00',
    eveningStartPeriod: null,
    eveningStartTime: '19:00',
  });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[3], { period: 4, start: '10:30', end: '11:10' });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[4], { period: 5, start: '14:00', end: '14:40' });
  assert.equal(dom.rows[4].startInput.value, '14:00');
});

test('timetable period time settings generate evening-anchored drafts without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('evening quick setting edits should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:45', gapAfter: 10 },
    { period: 2, start: '08:55', end: '09:40', gapAfter: 10 },
    { period: 3, start: '09:50', end: '10:35', gapAfter: 10 },
    { period: 4, start: '10:45', end: '11:30', gapAfter: 10 },
    { period: 5, start: '14:00', end: '14:45', gapAfter: 10 },
    { period: 6, start: '14:55', end: '15:40', gapAfter: 10 },
    { period: 7, start: '15:50', end: '16:35', gapAfter: 10 },
    { period: 8, start: '19:00', end: '19:45', gapAfter: 10 },
    { period: 9, start: '19:55', end: '20:40', gapAfter: 10 },
    { period: 10, start: '20:50', end: '21:35' },
  ], {
    startTime: '08:00',
    classMinutes: 45,
    breakMinutes: 10,
    afternoonStartPeriod: 5,
    afternoonStartTime: '14:00',
    eveningStartPeriod: 8,
    eveningStartTime: '19:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[4], { period: 5, start: '14:00', end: '14:45' });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[7], { period: 8, start: '19:00', end: '19:45' });
  assert.equal(dom.settings.get('#tt-period-evening-start-time').disabled, false);
});

test('timetable period time settings let afternoon boundary be cleared without snapping back to midpoint', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('clearing the afternoon boundary should update the draft without rerendering the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
    { period: 5, start: '11:20', end: '12:00', gapAfter: 10 },
    { period: 6, start: '19:00', end: '19:40', gapAfter: 10 },
    { period: 7, start: '19:50', end: '20:30' },
  ], {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: '',
    afternoonStartTime: '14:00',
    eveningStartPeriod: 6,
    eveningStartTime: '19:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.equal(controller.state.periodTimeDialog.settings.afternoonStartPeriod, null);
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[4], { period: 5, start: '11:20', end: '12:00' });
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes[5], { period: 6, start: '19:00', end: '19:40' });
});

test('timetable period time settings narrow evening options after afternoon boundary changes', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('boundary option updates should not rerender the modal');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
    { period: 5, start: '11:20', end: '12:00', gapAfter: 10 },
    { period: 6, start: '14:00', end: '14:40', gapAfter: 10 },
    { period: 7, start: '19:00', end: '19:40' },
  ], {
    startTime: '08:00',
    classMinutes: 40,
    breakMinutes: 10,
    afternoonStartPeriod: 6,
    afternoonStartTime: '14:00',
    eveningStartPeriod: '',
    eveningStartTime: '19:00',
  });
  controller.state.container = dom;

  controller.updatePeriodTimeSettingsFromForm();

  assert.deepEqual(
    dom.settings.get('#tt-period-evening-start-period').options.map(option => option.value),
    ['', '7'],
  );
  assert.equal(dom.settings.get('#tt-period-evening-start-period').value, '');
});

test('timetable period time gap edits shift following periods without rerendering the modal', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('gap edits should not rerender the whole dialog');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 25 },
    { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
    { period: 4, start: '10:30', end: '11:10' },
  ]);
  controller.state.container = dom;
  controller.state.periodTimeDialog = {
    ...controller.state.periodTimeDialog,
    open: true,
    settings: { startTime: '08:00', classMinutes: 40, breakMinutes: 10 },
  };

  controller.updatePeriodTimeGapFromDom(dom.rows[1].gapInput);

  assert.equal(dom.rows[2].startInput.value, '09:55');
  assert.equal(dom.rows[2].endInput.value, '10:35');
  assert.equal(dom.rows[3].startInput.value, '10:45');
  assert.equal(dom.rows[3].endInput.value, '11:25');
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:00', end: '08:40' },
    { period: 2, start: '08:50', end: '09:30' },
    { period: 3, start: '09:55', end: '10:35' },
    { period: 4, start: '10:45', end: '11:25' },
  ]);
});

test('timetable period time manual start and end edits refresh adjacent gap values', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {
    throw new Error('manual time edits should not rerender the whole dialog');
  };
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  const dom = createPeriodTimeDom([
    { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
    { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
    { period: 3, start: '09:40', end: '10:20' },
  ]);
  controller.state.container = dom;
  controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };

  dom.rows[1].startInput.value = '09:00';
  controller.readPeriodTimesFromDom();
  controller.refreshPeriodTimeGapInputsFromDom();

  assert.equal(dom.rows[0].gapInput.value, '20');
  assert.equal(dom.rows[1].gapInput.value, '10');

  dom.rows[1].endInput.value = '09:35';
  controller.readPeriodTimesFromDom();
  controller.refreshPeriodTimeGapInputsFromDom();

  assert.equal(dom.rows[1].gapInput.value, '5');
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:00', end: '08:40' },
    { period: 2, start: '09:00', end: '09:35' },
    { period: 3, start: '09:40', end: '10:20' },
  ]);
});

test('timetable period time save reads live inputs and rejects invalid rows', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const schedule = {
    source: 'fast_constructed',
    slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
  };
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3], schedule });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { project: createDefaultTimetableProject({ ...project, ...body, schedule }) } };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:05', end: '08:45', gapAfter: 15 },
      { period: 2, start: '09:00', end: '09:40', gapAfter: 10 },
      { period: 3, start: '09:50', end: '10:30' },
    ]);

    await controller.savePeriodTimes();

    assert.deepEqual(calls[0].body.periodTimes, [
      { period: 1, start: '08:05', end: '08:45' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ]);
    assert.equal(controller.state.project.schedule.slots[0].id, 'slot_1');

    calls.length = 0;
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:40', end: '08:00', gapAfter: 10 },
      { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
      { period: 3, start: '09:40', end: '10:20' },
    ]);

    await controller.savePeriodTimes();

    assert.equal(calls.length, 0);
    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.equal(controller.state.periodTimeDialog.errors[0].period, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save posts explicit afternoon and evening boundaries', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3, 4, 5, 6, 7, 8] });

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { project: createDefaultTimetableProject({ ...project, ...body }) } };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = {
      ...controller.state.periodTimeDialog,
      open: true,
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
          { id: 'seg-1', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: null, breakMinutes: null },
          { id: 'seg-2', label: '下午', startTime: '14:00', periodCount: 2, classMinutes: null, breakMinutes: null },
          { id: 'seg-3', label: '晚间', startTime: '19:00', periodCount: 2, classMinutes: null, breakMinutes: null },
        ],
      },
    };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:00', end: '08:40', gapAfter: 10 },
      { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
      { period: 3, start: '09:40', end: '10:20', gapAfter: 10 },
      { period: 4, start: '10:30', end: '11:10', gapAfter: 10 },
      { period: 5, start: '14:00', end: '14:40', gapAfter: 10 },
      { period: 6, start: '14:50', end: '15:30', gapAfter: 10 },
      { period: 7, start: '19:00', end: '19:40', gapAfter: 10 },
      { period: 8, start: '19:50', end: '20:30' },
    ], {}, { 'seg-1': { label: '上午', startTime: '08:00', periodCount: 4 }, 'seg-2': { label: '下午', startTime: '14:00', periodCount: 2 }, 'seg-3': { label: '晚间', startTime: '19:00', periodCount: 2 } });

    await controller.savePeriodTimes();

    assert.ok(calls[0].body.dayPartBoundaries);
    assert.equal(calls[0].body.dayPartBoundaries.afternoonStartPeriod, 5);
    assert.equal(calls[0].body.dayPartBoundaries.eveningStartPeriod, 7);
    assert.ok(calls[0].body.periodTimeSegments);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time save blocks incomplete, invalid and overlapping rows', async () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({ activePeriods: [1, 2, 3] }));
  const cases = [
    {
      rows: [
        { period: 1, start: '08:00', end: '', gapAfter: 10 },
        { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
        { period: 3, start: '09:40', end: '10:20' },
      ],
      period: 1,
      message: /请补齐开始和结束时间/,
    },
    {
      rows: [
        { period: 1, start: '25:00', end: '08:40', gapAfter: 10 },
        { period: 2, start: '08:50', end: '09:30', gapAfter: 10 },
        { period: 3, start: '09:40', end: '10:20' },
      ],
      period: 1,
      message: /时间格式无效/,
    },
    {
      rows: [
        { period: 1, start: '08:00', end: '08:40', gapAfter: -5 },
        { period: 2, start: '08:35', end: '09:15', gapAfter: 10 },
        { period: 3, start: '09:25', end: '10:05' },
      ],
      period: 2,
      message: /后一节不能早于前一节结束/,
    },
  ];

  for (const item of cases) {
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true, errors: [] };
    controller.state.container = createPeriodTimeDom(item.rows);
    await controller.savePeriodTimes();
    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.equal(controller.state.periodTimeDialog.errors[0].period, item.period);
    assert.match(controller.state.periodTimeDialog.errors[0].message, item.message);
  }
});

test('timetable period time save failure keeps the dialog draft editable', async () => {
  const originalFetch = globalThis.fetch;
  const schedule = {
    source: 'fast_constructed',
    slots: [{ id: 'slot_1', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
  };
  const project = createDefaultTimetableProject({ activePeriods: [1, 2, 3], schedule });
  globalThis.fetch = async () => {
    throw new Error('project-save-down');
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.state.periodTimeDialog = {
      ...controller.state.periodTimeDialog,
      open: true,
      segmentConfig: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [{ id: 'seg-1', label: '全天', startTime: '08:00', periodCount: 3, classMinutes: null, breakMinutes: null }],
      },
    };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:05', end: '08:45', gapAfter: 15 },
      { period: 2, start: '09:00', end: '09:40', gapAfter: 10 },
      { period: 3, start: '09:50', end: '10:30' },
    ], {}, { 'seg-1': { label: '全天', startTime: '08:00', periodCount: 3 } });

    await controller.savePeriodTimes();

    assert.equal(controller.state.periodTimeDialog.open, true);
    assert.equal(controller.state.periodTimeDialog.saving, false);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
      { period: 1, start: '08:05', end: '08:45' },
      { period: 2, start: '09:00', end: '09:40' },
      { period: 3, start: '09:50', end: '10:30' },
    ]);
    assert.equal(controller.state.project.schedule.slots[0].id, 'slot_1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time clear can be saved and reopened as empty', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const project = createDefaultTimetableProject({
    activePeriods: [1, 2, 3],
    periodTimes: [{ period: 1, start: '08:00', end: '08:40' }],
  });
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { project: createDefaultTimetableProject({ ...project, ...body }) } };
      },
    };
  };

  try {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.applyProject(project);
    controller.openPeriodTimeDialog();
    controller.clearPeriodTimes();
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '', end: '', gapAfter: '' },
      { period: 2, start: '', end: '', gapAfter: '' },
      { period: 3, start: '', end: '' },
    ]);

    await controller.savePeriodTimes();

    assert.deepEqual(calls[0].body.periodTimes, []);
    assert.equal(controller.state.periodTimeDialog.open, false);
    controller.openPeriodTimeDialog();
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('timetable period time cancel discards unsaved clear draft', () => {
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.applyProject(createDefaultTimetableProject({
    activePeriods: [1, 2],
    periodTimes: [{ period: 1, start: '08:00', end: '08:40' }],
  }));

  controller.openPeriodTimeDialog();
  controller.clearPeriodTimes();
  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, []);

  controller.closePeriodTimeDialog();
  controller.openPeriodTimeDialog();

  assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
    { period: 1, start: '08:00', end: '08:40' },
    { period: 2, start: '08:50', end: '09:30', manualOverride: false, segmentLabel: '上午时段' },
  ]);
});

test('timetable project route only clears schedule when active range changes', async () => {
  const routeSource = await readFile(new URL('../gateway/routes/timetable.js', import.meta.url), 'utf8');

  assert.match(routeSource, /sameNumberList\(current\.activeWeekdays,\s*project\.activeWeekdays\)/);
  assert.match(routeSource, /sameNumberList\(current\.activePeriods,\s*project\.activePeriods\)/);
  assert.doesNotMatch(routeSource, /periodTimes[\s\S]{0,160}preservePublishedArchive\(null,\s*current\.schedule\)/);
  assert.doesNotMatch(routeSource, /dayPartBoundaries[\s\S]{0,200}preservePublishedArchive\(null,\s*current\.schedule\)/);
});

test('timetable inspector surfaces data and 智能 rule audit summaries', () => {
  const state = sampleWorkbenchState({
    ruleDraftPreview: [{
      id: 'draft-1',
      type: 'teacher_unavailable',
      targetName: 'Math Teacher',
      slots: ['3-4'],
      priority: 'hard',
      description: 'Teacher unavailable',
      status: 'ready',
    }],
    ruleWarnings: ['Unknown class ignored'],
    ruleReview: {
      ...sampleWorkbenchState().ruleReview,
      unsupportedItems: [{
        id: 'draft-2',
        type: 'teacher_load_balance',
        targetName: 'All teachers',
        slots: [],
        priority: 'soft',
        description: 'Suggestion only',
        status: 'suggestion',
      }],
    },
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /class="tt-audit-grid"/);
  assert.match(inspector, /tt-rule-preview-item/);
  assert.match(inspector, /Unknown class ignored/);
  assert.match(inspector, /All teachers/);
  assert.match(inspector, /teacher_load_balance/);
});

test('timetable inspector renders unified diagnostics summary and items', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
      schedule: {
        id: 'schedule_diag',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        conflicts: [],
        unplaced: [],
        audit: null,
        qualityIssues: [],
        score: { totalLessons: 2, placedLessons: 0, unplacedLessons: 2 },
        diagnostics: {
          diagnosticsVersion: 1,
          summary: { error: 1, warning: 1, info: 0, total: 2, suggestions: 1 },
          items: [{
            id: 'diag_1',
            category: 'unplaced',
            type: 'unplaced',
            severity: 'error',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G71',
            message: 'Math 还有 2 节未排。',
          }, {
            id: 'diag_2',
            category: 'quality',
            type: 'subject_spread',
            severity: 'warning',
            targetKind: 'subject',
            targetId: 'math',
            targetName: 'Math',
            message: '同科过于集中。',
          }],
          byObject: { teachers: {}, classes: { c1: ['diag_1'] }, subjects: { math: ['diag_2'] }, rooms: {}, plans: {} },
          suggestions: [{
            id: 'sug_1',
            kind: 'unplaced',
            targetDiagnostics: ['diag_1'],
            targetName: 'G71',
            message: '检查班级容量后重新生成。',
            applied: false,
          }],
        },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /诊断报告/);
  assert.match(inspector, /错误<\/b>1/);
  assert.match(inspector, /警告<\/b>1/);
  assert.match(inspector, /建议<\/b>1/);
  assert.match(inspector, /班级/);
  assert.match(inspector, /课程/);
  assert.match(inspector, /G71/);
  assert.match(inspector, /关联 1 项诊断/);
  assert.match(inspector, /Math 还有 2 节未排。/);
  assert.match(inspector, /同科过于集中。/);
  assert.match(inspector, /检查班级容量后重新生成。/);
});

test('timetable publication panel prefers unified publication diagnostics when present', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      schedule: {
        id: 'publication-diagnostics',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [{
          id: 'slot-1',
          day: 1,
          period: 1,
          classId: 'c1',
          subjectId: 'math',
          teacherId: 't_math',
          teacherIds: ['t_math'],
          lessonPlanId: 'lp_math',
        }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [{ lessonPlanId: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', reason: 'missing slots' }],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [{ type: 'incomplete_schedule', message: '还有课时未排入课表。' }],
          warnings: [{ type: 'manual_review', message: '请教务复核。' }],
          reviewItems: [],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        diagnostics: {
          diagnosticsVersion: 1,
          summary: { error: 1, warning: 1, info: 0, total: 2, suggestions: 0 },
          items: [{
            id: 'diag_pub_1',
            category: 'publication',
            type: 'incomplete_schedule',
            severity: 'error',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G71',
            message: 'G71 还有 2 节未排。',
            slot: '',
            objects: { teachers: [], classes: ['c1'], subjects: [], rooms: [], plans: [] },
          }, {
            id: 'diag_pub_2',
            category: 'publication',
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
            slot: '',
            objects: { teachers: ['t_math'], classes: [], subjects: [], rooms: [], plans: [] },
          }],
          byObject: { teachers: { t_math: ['diag_pub_2'] }, classes: { c1: ['diag_pub_1'] }, subjects: {}, rooms: {}, plans: {} },
          suggestions: [],
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /发布问题/);
  assert.match(inspector, /G71 还有 2 节未排。/);
  assert.match(inspector, /Math Teacher 负载接近满载。/);
  assert.match(inspector, /tt-inspector-issue-item tt-publication-issue-item is-error/);
  assert.match(inspector, /tt-inspector-issue-item tt-publication-issue-item is-warning/);
});

test('timetable publication panel can fall back to publication issueEntries without diagnostics', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      schedule: {
        id: 'publication-issue-entries',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [],
          warnings: [],
          issueEntries: [{
            type: 'incomplete_schedule',
            severity: 'error',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G7 1',
            message: 'G7 1 还有 2 节未排。',
          }, {
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: 'Math Teacher 负载接近满载。',
          }],
          reviewItems: [{
            type: 'teacher_load',
            severity: 'warning',
            targetKind: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            message: '旧 reviewItems 文案不该出现。',
          }],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /G7 1 还有 2 节未排。/);
  assert.match(inspector, /Math Teacher 负载接近满载。/);
  assert.doesNotMatch(inspector, /旧 reviewItems 文案不该出现/);
});

test('timetable publication panel can bridge legacy blockingIssues and warnings without reviewItems', () => {
  const state = sampleWorkbenchState({
    project: createDefaultTimetableProject({
      schoolName: 'UI School',
      term: '2026',
      weekdays: 5,
      periodsPerDay: 7,
      teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
      classes: [{ id: 'c1', grade: 'G7', name: '1' }],
      subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
      lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
      schedule: {
        id: 'publication-legacy-lists',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'fast_constructed',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        publication: {
          ok: false,
          reason: 'publication_blocked',
          blockingIssues: [{
            type: 'incomplete_schedule',
            targetKind: 'class',
            targetId: 'c1',
            targetName: 'G7 1',
            message: 'G7 1 还有 2 节未排。',
          }],
          warnings: [{
            type: 'manual_review',
            targetKind: 'schedule',
            targetId: '',
            targetName: '课表',
            message: '请教务复核。',
          }],
          summary: { totalLessons: 3, placedLessons: 1, unplacedLessons: 2, hardConflicts: 0 },
        },
        score: { hardConflicts: 0, unplacedLessons: 2, placedLessons: 1, totalLessons: 3, completeness: 33 },
      },
    }),
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /G7 1 还有 2 节未排。/);
  assert.match(inspector, /请教务复核。/);
  assert.match(inspector, /tt-publication-issue-item is-error/);
  assert.match(inspector, /tt-publication-issue-item is-warning/);
});
