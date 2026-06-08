import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import {
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
  assert.match(viewSource, /data-workflow-step="data"/);
  assert.match(viewSource, /data-workflow-step="rules"/);
  assert.match(viewSource, /data-workflow-step="solve"/);
  assert.match(viewSource, /data-workflow-step="review"/);
  assert.match(viewSource, /renderWorkbench/);
  assert.match(viewSource, /renderSchedulePanel/);
  assert.match(viewSource, /renderInspector/);
  assert.doesNotMatch(source, /class="tt-tabs"/);
  assert.doesNotMatch(source, /renderTab\(/);
  assert.doesNotMatch(source, /renderActiveTab/);

  assert.match(styles, /\.tt-workbench\s*{/);
  assert.match(styles, /\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar topbar topbar"\s*"sidebar schedule inspector"/s);
  assert.match(styles, /\.tt-sidebar\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-schedule-scroll\s*{[^}]*overflow:\s*auto/s);
  assert.match(styles, /\.tt-inspector\s*{/);
  assert.doesNotMatch(styles, /--tt-bg-base:\s*#0f172a/);
  assert.doesNotMatch(styles, /border-radius:\s*(1[0-9]|[2-9][0-9])px/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar"\s*"sidebar"\s*"schedule"\s*"inspector"/s);
});

test('timetable styles inherit the ICeCream tool tokens and fonts', async () => {
  const styles = await readFile(stylePath, 'utf8');

  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-page:\s*transparent/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-bg-panel:\s*var\(--glass-panel/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-border:\s*var\(--glass-border/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-primary:\s*var\(--accent-color/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*--tt-shadow:\s*var\(--shadow-depth/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*var\(--pm-surface/s);
  assert.match(styles, /\.tt-workbench\s*{[^}]*font-family:\s*var\(--font-heading/s);
  assert.match(styles, /\.tt-import-text\s*{[^}]*font-family:\s*var\(--font-mono/s);
  assert.match(styles, /\.tt-topbar\s*{[^}]*min-height:\s*56px/s);

  assert.doesNotMatch(styles, /--tt-bg-page:\s*#f6f7f9/i);
  assert.doesNotMatch(styles, /--tt-bg-page:\s*#111827/i);
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
  const mutatingMethods = ['saveProject', 'importRoster', 'saveRules', 'adjustSlot'];

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
