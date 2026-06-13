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

const sourcePath = new URL('../public/js/tools/timetable-planner.js', import.meta.url);
const stylePath = new URL('../public/css/timetable-planner.css', import.meta.url);
const moduleRoot = new URL('../public/js/tools/timetable/', import.meta.url);

function sampleWorkbenchState(overrides = {}) {
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
    ...overrides,
  };
}

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

function createPeriodTimeDom(rows, settings = {}) {
  const settingInputs = new Map([
    ['#tt-period-start-time', { value: settings.startTime || '08:00' }],
    ['#tt-period-class-minutes', { value: String(settings.classMinutes ?? 40) }],
    ['#tt-period-break-minutes', { value: String(settings.breakMinutes ?? 10) }],
  ]);
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
  return {
    rows: rowNodes,
    settings: settingInputs,
    querySelector(selector) {
      return settingInputs.get(selector) || null;
    },
    querySelectorAll(selector) {
      return selector === '[data-period-time-row]' ? rowNodes : [];
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

test('timetable planner uses the seating-style control panel and board layout', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');

  assert.match(viewSource, /class="tt-workbench"/);
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

test('timetable planner renders the smart agent as a seating-style floating assistant', async () => {
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
  assert.match(html, /id="tt-agent-floating"/);
  assert.match(html, /class="tt-agent-toggle"/);
  assert.match(html, /class="tt-agent-floating-panel"/);
  assert.match(html, /智能主导排课/);
  assert.match(html, /id="tt-timetable-agent-panel"/);
  assert.match(html, /id="tt-agent-message"/);
  assert.match(html, /data-action="timetable-agent-send"/);
  assert.match(html, /data-action="timetable-agent-run"/);
  assert.match(html, /data-action="timetable-agent-answer"/);
  assert.match(html, /data-action="timetable-agent-approve"/);
  assert.match(html, /data-agent-action-id="act_solve"/);
  assert.match(html, /data-agent-action-id="act_save_recommended"/);
  assert.match(html, /data-agent-action-id="act_save_candidate"/);
  assert.match(html, /tt-agent-recommended/);
  assert.match(html, /data-agent-solution-id="timefold"/);
  assert.match(html, /data-agent-export-type="class"/);
  assert.match(html, /data-agent-export-type="teacher"/);
  assert.match(html, /求解计划/);
  assert.match(html, /方案对比/);
  assert.match(html, /Timefold 优化方案/);
  assert.match(html, /保存预览/);
  assert.match(html, /新增 3 节/);
});

test('timetable smart agent frontend calls additive agent APIs without touching seating modules', async () => {
  const controllerSource = await readFile(new URL('controller.js', moduleRoot), 'utf8');
  const interactionSource = await readFile(new URL('grid-interactions.js', moduleRoot), 'utf8');
  const apiSource = await readFile(new URL('api.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.match(apiSource, /requestTimetableAgent/);
  assert.match(controllerSource, /startTimetableAgentSession/);
  assert.match(controllerSource, /sendTimetableAgentMessage/);
  assert.match(controllerSource, /requestTimetableAgent\('\/session'/);
  assert.match(controllerSource, /requestTimetableAgent\('\/message'/);
  assert.match(controllerSource, /requestTimetableAgent\('\/approve'/);
  assert.match(interactionSource, /timetable-agent-start/);
  assert.match(interactionSource, /timetable-agent-approve/);
  assert.match(interactionSource, /#tt-agent-floating/);
  assert.match(interactionSource, /state\.agentOpen = Boolean\(event\.target\.open\)/);
  assert.match(styles, /\.tt-agent-panel\s*{/);
  assert.match(styles, /\.tt-agent-floating\s*{/);
  assert.match(styles, /\.tt-agent-toggle\s*{/);
  assert.match(styles, /\.tt-agent-floating-panel\s*{/);
  assert.match(styles, /\.tt-agent-comparison\s*,\s*\n\.tt-agent-save-preview\s*,\s*\n\.tt-agent-export-links\s*{/);
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
          warnings: [{ type: 'manual_review', message: '请教务复核。' }],
          reviewItems: [
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
  assert.match(styles, /\.tt-roster-import-dialog,\s*\n\.tt-rule-review-dialog\s*{[\s\S]*width:\s*max-content;[\s\S]*max-width:\s*calc\(100vw - 48px\);/);
  assert.match(styles, /\.tt-period-time-dialog\s*{[\s\S]*width:\s*min\(840px,\s*calc\(100vw - 48px\)\);[\s\S]*max-width:\s*min\(840px,\s*calc\(100vw - 48px\)\);/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog/);
});

test('timetable dialogs expand to review content on desktop and stay constrained on mobile', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.tt-roster-import-dialog,\s*\n\.tt-rule-review-dialog\s*{[\s\S]*width:\s*max-content;[\s\S]*min-width:\s*min\(640px,\s*calc\(100vw - 48px\)\);[\s\S]*max-width:\s*calc\(100vw - 48px\);/);
  assert.match(styles, /\.tt-rule-review-dialog\s*{[\s\S]*min-width:\s*min\(820px,\s*calc\(100vw - 48px\)\);/);
  assert.match(styles, /\.tt-period-time-dialog\s*{[\s\S]*width:\s*min\(840px,\s*calc\(100vw - 48px\)\);[\s\S]*min-width:\s*min\(620px,\s*calc\(100vw - 48px\)\);[\s\S]*max-width:\s*min\(840px,\s*calc\(100vw - 48px\)\);/);
  assert.match(styles, /\.tt-publication-history-dialog\s*{[\s\S]*width:\s*max-content;[\s\S]*min-width:\s*min\(720px,\s*calc\(100vw - 48px\)\);[\s\S]*max-width:\s*calc\(100vw - 48px\);/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog,[\s\S]*\.tt-rule-review-dialog,[\s\S]*\.tt-period-time-dialog,[\s\S]*\.tt-publish-dialog,[\s\S]*\.tt-publication-history-dialog\s*{[\s\S]*width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*100%;/);
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
  assert.doesNotMatch(styles, /\.tt-rule-entry-card/);
  assert.match(styles, /\.tt-rule-review-dialog/);
});

test('timetable rule review keeps parsed drafts inside the modal and preserves them across renders', async () => {
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

  // Pending cards are rendered inline in the sidebar
  const html = renderWorkbench(state);
  const sidebar = html.match(/<aside class="tt-sidebar">([\s\S]*?)<\/aside>\s*<section class="tt-schedule-panel">/)?.[1] || '';

  assert.match(sidebar, /id="tt-open-rule-review"/);
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.match(sidebar, /继续复核智能约束/);
  assert.match(sidebar, /2/);
  assert.doesNotMatch(sidebar, /id="tt-pending-rules"/);
  assert.doesNotMatch(sidebar, /data-rule-card="draft-1"/);
  assert.doesNotMatch(sidebar, /data-rule-card="draft-2"/);
  assert.doesNotMatch(sidebar, /待确认 \(2\)/);
  // Suggestion card is rendered with reject (ignore) only
  assert.doesNotMatch(sidebar, /data-rule-reject="draft-1"/);
  // Effective card shows accept and reject
  assert.doesNotMatch(sidebar, /data-rule-accept="draft-2"/);
  assert.doesNotMatch(sidebar, /data-rule-reject="draft-2"/);
  // No dialog overlay
  assert.match(html, /id="tt-rule-review-dialog"/);
  assert.match(html, /xlsx_constraints/);
  assert.match(html, /data-rule-review-row="draft-1"/);
  assert.match(html, /data-rule-review-row="draft-2"/);
  assert.match(html, /Unknown object ignored/);

  // Re-rendering with a different expanded state preserves pending rules
  const expandedHtml = renderWorkbench({ ...state, expandedRuleId: 'draft-2' });
  assert.match(expandedHtml, /data-rule-review-row="draft-2"/);
  assert.doesNotMatch(expandedHtml, /tt-rule-card--expanded/);
  assert.doesNotMatch(expandedHtml, /data-pending-field="slots"/);
  assert.doesNotMatch(expandedHtml, /data-pending-field="priority"/);

  // Controller: openRuleReview sends existing drafts back to the review modal.
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
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'review');
  assert.equal(controller.state.ruleReview.draftRows.length, 2);
});

test('timetable rule review shows all-teacher limit targets instead of an unmatched teacher dropdown', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      text: 'dialog text',
      originalText: 'original constraint',
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

  const row = html.match(/<tr class="tt-rule-review-row[^"]*" data-rule-review-row="all-teachers-limit">([\s\S]*?)<\/tr>/)?.[1] || '';

  assert.match(row, /value="全部教师"/);
  assert.match(row, /data-rule-review-field="targetType" value="all_teachers"/);
  assert.match(row, /data-rule-review-field="targetId" value="__all_teachers"/);
  assert.doesNotMatch(row, /data-rule-target-select/);
  assert.doesNotMatch(row, /<option value="">未选择<\/option>/);
});

test('timetable 智能 rules sidebar renders roster-style card entry while examples and file upload stay in the modal', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
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
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.match(sidebar, /导入智能约束/);
  assert.doesNotMatch(sidebar, /tt-rule-entry-card/);
  // No dialog rendered when no pending rules and no open state
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  // view.js contains the locked_slot option in the manual rule builder
  assert.match(viewSource, /value="locked_slot"/);
  assert.match(viewSource, /value="teacher_daily_limit"/);
  assert.match(viewSource, /value="teacher_consecutive_limit"/);
  assert.match(viewSource, /id="tt-manual-rule-limit"/);

  // Opening directly to manual mode keeps manual rules in the modal.
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.openRuleReview('manual');
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'manual');
  assert.equal(controller.state.ruleReview.mode, 'manual');
});

test('timetable smart rules no longer keep the old inline sidebar renderer', async () => {
  const viewSource = await readFile(new URL('view.js', moduleRoot), 'utf8');
  const styles = await readFile(stylePath, 'utf8');

  assert.doesNotMatch(viewSource, /function renderRuleInputArea/);
  assert.doesNotMatch(viewSource, /function renderRuleCard/);
  assert.doesNotMatch(viewSource, /function renderSavedRuleList/);
  assert.doesNotMatch(viewSource, /function renderRulePreview/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-rule-input-area\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-pending-rules\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rules\s*\{/);
});

test('timetable rule review modal shows seating-style parse progress feedback', async () => {
  const styles = await readFile(stylePath, 'utf8');
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

  assert.match(fileHtml, /class="[^"]*tt-process-strip[^"]*"/);
  assert.match(fileHtml, /智能解析约束中\.\.\./);
  assert.match(fileHtml, /智能-rules\.xlsx/);
  assert.match(fileHtml, /id="tt-rule-review-parse"[^>]*disabled/);
  assert.match(fileHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(fileHtml, /智能解析中/);
  assert.match(fileHtml, /data-rule-review-mode="file"[^>]*disabled/);
  assert.match(fileHtml, /id="tt-rule-review-file"[^>]*disabled/);
  assert.match(fileHtml, /id="tt-rule-review-text"[^>]*disabled/);

  const manualHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'manual',
      mode: 'manual',
      draftRows: [],
      warnings: [],
      loading: true,
      phase: 'manual_rows',
      phaseText: '生成复核行中...',
    },
  }));

  assert.match(manualHtml, /生成复核行中\.\.\./);
  assert.match(manualHtml, /id="tt-add-manual-rule-rows"[^>]*disabled/);
  assert.match(manualHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);

  assert.match(styles, /\.tt-spin\s*{/);
  assert.match(styles, /@keyframes\s+tt-spin/);
  assert.match(styles, /\.tt-process-strip\s*{/);
  assert.match(styles, /\.tt-process-chip\s*{/);
  assert.match(styles, /\.tt-process-chip--warning\s*{/);
});

test('timetable constraint chat is wired into the real planner frontend', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const interactionSource = await readFile(new URL('../public/js/tools/timetable/grid-interactions.js', import.meta.url), 'utf8');
  const indexHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const chatStyles = await readFile(new URL('../public/css/timetable-chat.css', import.meta.url), 'utf8');
  const plannerStyles = await readFile(stylePath, 'utf8');

  const state = sampleWorkbenchState({
    constraintChat: {
      open: true,
      loading: false,
      conversationId: 'conv_test',
      inputText: '请解释这些约束',
      messages: [{
        role: 'assistant',
        content: '我可以帮你解释和优化约束。',
        timestamp: new Date('2026-06-13T08:00:00+08:00').getTime(),
      }],
      reviewContext: {
        counts: {
          needsInput: 34,
          needReview: 101,
          unsupported: 1,
          warnings: 76,
        },
        groups: [{
          type: 'missing_info',
          label: '需要补充信息',
          count: 34,
          examples: ['缺少明确节次，请补充后再生效。'],
        }],
        suggestedPrompts: ['先处理缺少明确节次的问题'],
      },
    },
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
      warnings: [],
      loading: false,
    },
  });
  const html = renderWorkbench(state);

  assert.doesNotThrow(() => new TimetablePlannerController());
  assert.equal(typeof TimetablePlannerController.prototype.startConstraintConversation, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.sendConstraintChatMessage, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.closeConstraintChat, 'function');
  assert.equal(typeof TimetablePlannerController.prototype.updateConstraintChatInput, 'function');
  assert.match(controllerSource, /constraintChatControllerMethods/);
  assert.match(controllerSource, /buildConstraintReviewContext/);
  assert.match(controllerSource, /reviewContext/);
  assert.match(html, /data-action="constraint-chat-start"/);
  assert.match(html, /tt-constraint-chat-overlay/);
  assert.match(html, /AI 帮我处理/);
  assert.match(html, /按这个顺序复核就行/);
  assert.match(html, /先处理当前复核表里的问题/);
  assert.match(html, /不需要懂排课规则/);
  assert.match(html, /今天要处理的复核任务/);
  assert.match(html, /点推荐操作/);
  assert.match(html, /当前复核重点/);
  assert.match(html, /需要补充信息/);
  assert.match(html, /34/);
  assert.match(html, /data-action="constraint-chat-suggest"/);
  assert.match(html, /我可以帮你解释和优化约束。/);
  assert.match(html, /请解释这些约束/);
  assert.match(interactionSource, /constraint-chat-start/);
  assert.match(interactionSource, /constraint-chat-send/);
  assert.match(interactionSource, /constraint-chat-input/);
  assert.match(interactionSource, /constraint-chat-suggest/);
  assert.match(indexHtml, /css\/timetable-chat\.css/);
  assert.match(chatStyles, /\.tt-constraint-chat-body\s*{/);
  assert.match(chatStyles, /\.tt-constraint-chat-guide\s*{/);
  assert.match(chatStyles, /\.tt-chat-step-guide/);
  assert.match(chatStyles, /@media \(max-width:\s*780px\)/);
  assert.match(plannerStyles, /\.tt-rule-beginner-guide\s*{/);
  assert.match(plannerStyles, /\.tt-rule-beginner-steps\s*{/);
});

test('timetable rule review parse renders the opened input state before progress updates', async () => {
  const controllerSource = await readFile(new URL('../public/js/tools/timetable/controller.js', import.meta.url), 'utf8');
  const parseRulesSource = extractMethodSource(controllerSource, 'parseRules');

  assert.match(
    parseRulesSource,
    /this\.state\.ruleReview\s*=\s*{[\s\S]*?open:\s*true,[\s\S]*?text,[\s\S]*?};\s*this\.render\(\);\s*try\s*{/
  );
});

test('timetable rule review modal locks review table while rules are being written', () => {
  const html = renderWorkbench(sampleWorkbenchState({
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
      loading: true,
      phase: 'saving',
      phaseText: '写入项目中...',
    },
  }));

  assert.match(html, /写入项目中\.\.\./);
  assert.match(html, /id="tt-confirm-rule-review"[^>]*disabled/);
  assert.match(html, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(html, /确认中/);
  assert.match(html, /data-rule-review-field="rawText"[^>]*disabled/);
  assert.match(html, /data-rule-review-field="type"[^>]*disabled/);
  assert.match(html, /data-rule-review-delete-row="draft-1"[^>]*disabled/);
  assert.match(html, /id="tt-add-rule-review-row"[^>]*disabled/);
});

test('timetable rule review explains warning groups and draft row sources separately', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
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
      loading: false,
    },
  }));

  assert.match(html, /tt-rule-review-report/);
  assert.match(html, /已自动处理/);
  assert.match(html, /需要人工补充/);
  assert.match(html, /暂不支持 \/ 仅作建议/);
  assert.match(html, /tt-rule-warning--info/);
  assert.match(html, /tt-rule-warning--review/);
  assert.match(html, /tt-rule-warning--suggestion/);
  assert.match(html, /来自第 1 条 · 智能已转换/);
  assert.match(html, /来自第 4 条 · 建议项/);
  assert.match(html, /data-rule-review-row="draft-source-1"/);
  assert.match(html, /data-rule-review-row="draft-source-2"/);

  assert.match(styles, /\.tt-rule-review-report\s*{/);
  assert.match(styles, /\.tt-rule-warning--info\s*{/);
  assert.match(styles, /\.tt-rule-row-source\s*{/);
});

test('timetable rule review groups smart parse results by readiness and questions', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      inputType: 'text',
      nextAction: 'ask_user',
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
        options: [
          { label: '王明', value: 't_wang_ming' },
          { label: '王华', value: 't_wang_hua' },
        ],
        relatedRuleIds: ['review-1'],
      }],
      missingInfo: [{ id: 'm_1', message: '没有找到物理这门课', relatedRuleIds: ['review-2'] }],
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
    },
  }));

  assert.match(html, /智能建议总览/);
  assert.match(html, /已识别/);
  assert.match(html, /可直接生效/);
  assert.match(html, /需要补充信息/);
  assert.match(html, /你说的王老师是哪一位/);
  assert.match(html, /data-rule-clarify-question="q_1"/);
  assert.match(html, /data-rule-clarify-option/);
  assert.match(html, /data-action="submit-rule-clarification"/);
  assert.match(html, /data-rule-question-answer="q_1"/);
  assert.match(html, /id="tt-continue-rule-conversation"/);
  assert.match(html, /id="tt-apply-auto-rules"/);
  assert.match(html, /需要复核/);
  assert.match(html, /冲突与风险/);
  assert.match(html, /李老师不可排与锁定课节冲突/);
  assert.match(html, /暂不支持/);
  assert.match(html, /teacher_free_period_compact/);

  assert.match(styles, /\.tt-rule-review-overview\s*{/);
  assert.match(styles, /\.tt-rule-review-group\s*{/);
  assert.match(styles, /\.tt-rule-conflict--blocking\s*{/);
});

test('timetable rule review does not render empty candidate questions as blank selects', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
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

  assert.match(html, /Which all-teacher object/);
  assert.match(html, /data-rule-clarify-question="q_empty"/);
  assert.match(html, /data-rule-clarify-input="q_empty"/);
  assert.match(html, /<input[^>]*data-rule-question-answer="q_empty"/);
  assert.doesNotMatch(html, /<select[^>]*data-rule-question-answer="q_empty"/);
});

test('timetable rule review disables auto apply when blocking conflicts exist', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'text',
      autoAcceptable: [{
        id: 'auto-1',
        type: 'subject_morning',
        targetName: '数学',
        status: 'effective',
        confidence: 0.92,
        warnings: [],
      }],
      draftRows: [],
      needReview: [],
      conflicts: [{ level: 'blocking', message: '锁定课节与教师不可用冲突。' }],
      warnings: [],
      unsupportedItems: [],
    },
  }));

  assert.match(html, /id="tt-apply-auto-rules"[^>]*disabled/);
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

test('timetable rule review table aligns controls with fixed helper rows', async () => {
  const styles = await readFile(stylePath, 'utf8');
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
      loading: false,
    },
  }));

  assert.match(html, /<colgroup class="tt-rule-review-cols">/);
  assert.match(html, /class="tt-rule-review-cell"/);
  assert.match(html, /class="tt-rule-review-cell-main"/);
  assert.match(html, /class="tt-rule-review-cell-helper"/);
  assert.match(html, /class="tt-rule-review-action-cell"/);
  assert.match(html, /data-rule-review-field="slots"/);
  assert.match(html, /data-rule-review-field="status"/);
  assert.match(html, /data-rule-review-delete-row="draft-align-1"/);

  assert.match(styles, /\.tt-rule-review-table\s*{[^}]*table-layout:\s*fixed/s);
  assert.match(styles, /\.tt-rule-review-cell\s*{[^}]*display:\s*grid/s);
  assert.match(styles, /\.tt-rule-review-cell-main\s*{[^}]*min-height:\s*34px/s);
  assert.match(styles, /\.tt-rule-review-cell-helper\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.tt-rule-review-action-cell\s*{[^}]*align-items:\s*start/s);
});

test('timetable saved 智能 rules remain visible after confirmation', async () => {
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
  assert.match(sidebar, /class="[^"]*tt-empty-card[^"]*tt-roster-entry[^"]*tt-rule-entry[^"]*"/);
  assert.match(sidebar, /查看智能约束/);
  assert.match(sidebar, /9/);
  assert.match(sidebar, /id="tt-clear-rules"/);
  assert.doesNotMatch(sidebar, /id="tt-saved-rules"/);
  assert.doesNotMatch(sidebar, /data-saved-rule-delete=/);
  assert.doesNotMatch(sidebar, /data-saved-rule="/);
  // Rule type labels are visible
  assert.doesNotMatch(sidebar, /teacher_daily_limit/);
  assert.doesNotMatch(sidebar, /subject_spread/);

  const modalHtml = renderWorkbench(sampleWorkbenchState({
    project,
    ruleReview: {
      open: true,
      step: 'saved',
      mode: 'file',
      draftRows: [],
      warnings: [],
    },
  }));

  assert.match(modalHtml, /id="tt-saved-rule-table"/);
  assert.match(modalHtml, /<colgroup class="tt-saved-rule-cols">/);
  assert.match(modalHtml, /<tr class="tt-saved-rule-table-row"/);
  assert.doesNotMatch(modalHtml, /<tr class="tt-saved-rule-row"/);
  assert.match(modalHtml, /class="tt-saved-rule-cell"/);
  assert.match(modalHtml, /class="tt-saved-rule-action-cell"/);
  assert.match(modalHtml, /data-saved-rule-delete=/);
  assert.match(modalHtml, /teacher_daily_limit/);
  assert.match(modalHtml, /subject_spread/);
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
    },
  });

  assert.match(open, /id="tt-period-time-dialog"/);
  assert.match(open, /id="tt-period-start-time"/);
  assert.match(open, /id="tt-period-class-minutes"/);
  assert.match(open, /id="tt-period-break-minutes"/);
  assert.match(open, /id="tt-generate-period-times"/);
  assert.doesNotMatch(open, /id="tt-period-lunch-after"/);
  assert.doesNotMatch(open, /id="tt-period-lunch-minutes"/);
  assert.match(open, /data-period-time-row="1"/);
  assert.match(open, /data-period-time-draft-start="1"/);
  assert.match(open, /data-period-time-draft-end="1"/);
  assert.match(open, /data-period-time-gap-after="1"/);
  assert.match(open, /data-period-time-gap-after="2"/);
  assert.doesNotMatch(open, /data-period-time-gap-after="3"/);
  assert.match(open, /data-label="开始时间"/);
  assert.match(open, /data-label="本节后间隔"/);
  assert.match(open, /id="tt-reset-period-time-settings"/);
  assert.match(open, /id="tt-clear-period-times"/);
  assert.match(open, /id="tt-save-period-times"/);
  assert.match(open, /id="tt-cancel-period-times"/);
  assert.match(styles, /\.tt-period-time-entry\s*{/);
  assert.match(styles, /\.tt-period-time-settings\s*{/);
  assert.match(styles, /\.tt-period-time-dialog\s*{/);
  assert.match(styles, /\.tt-period-time-table\s*{/);
  assert.match(styles, /\.tt-roster-review-field\s*{[\s\S]*box-sizing:\s*border-box;/);
  assert.match(styles, /@media \(max-width:\s*900px\)[\s\S]*\.tt-period-time-setting-actions\s*{[\s\S]*grid-column:\s*1 \/ -1;/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-dialog/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table,[\s\S]*\.tt-period-time-table thead,[\s\S]*\.tt-period-time-table tbody,[\s\S]*\.tt-period-time-table tr,[\s\S]*\.tt-period-time-table th,[\s\S]*\.tt-period-time-table td\s*{[\s\S]*display:\s*block;/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-period-time-table td\s*{[\s\S]*grid-template-columns:\s*88px minmax\(0,\s*1fr\);/);
  assert.match(interactionSource, /#tt-open-period-time-dialog/);
  assert.match(interactionSource, /generate-period-times/);
  assert.match(interactionSource, /reset-period-time-settings/);
  assert.match(interactionSource, /\[data-period-time-setting\]/);
  assert.match(interactionSource, /\[data-period-time-gap-after\]/);
  assert.match(interactionSource, /#tt-save-period-times/);
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
    assert.equal(controller.state.periodTimeDialog.settings.startTime, '07:55');
    assert.equal(controller.state.periodTimeDialog.settings.classMinutes, 40);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes, [
      { period: 1, start: '07:55', end: '08:35' },
      { period: 2, start: '08:45', end: '09:25' },
      { period: 3, start: '09:35', end: '10:15' },
    ]);

    controller.autoFillPeriodTimes();
    assert.equal(calls.length, 0);
    assert.deepEqual(controller.state.periodTimeDialog.settings, {
      startTime: '08:00',
      classMinutes: 40,
      breakMinutes: 10,
    });
    assert.equal(controller.state.periodTimeDialog.draftTimes.length, 3);
    assert.deepEqual(controller.state.periodTimeDialog.draftTimes[0], { period: 1, start: '08:00', end: '08:40' });

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
    controller.state.periodTimeDialog = { ...controller.state.periodTimeDialog, open: true };
    controller.state.container = createPeriodTimeDom([
      { period: 1, start: '08:05', end: '08:45', gapAfter: 15 },
      { period: 2, start: '09:00', end: '09:40', gapAfter: 10 },
      { period: 3, start: '09:50', end: '10:30' },
    ]);

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
    { period: 2, start: '08:50', end: '09:30' },
  ]);
});

test('timetable project route only clears schedule when active range changes', async () => {
  const routeSource = await readFile(new URL('../gateway/routes/timetable.js', import.meta.url), 'utf8');

  assert.match(routeSource, /sameNumberList\(current\.activeWeekdays,\s*project\.activeWeekdays\)/);
  assert.match(routeSource, /sameNumberList\(current\.activePeriods,\s*project\.activePeriods\)/);
  assert.doesNotMatch(routeSource, /periodTimes[\s\S]{0,160}preservePublishedArchive\(null,\s*current\.schedule\)/);
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
