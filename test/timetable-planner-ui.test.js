import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
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
  assert.match(styles, /--tt-bg-base:\s*#0f172a/);
  assert.match(styles, /@media \(max-width:\s*980px\)[\s\S]*\.tt-workbench\s*{[^}]*grid-template-areas:\s*"topbar"\s*"sidebar"\s*"schedule"\s*"inspector"/s);
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
  assert.match(styles, /\.tt-sidebar,[\s\S]*?\.tt-inspector\s*{[^}]*border-radius:\s*var\(--tt-radius-lg\)/s);
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
  assert.doesNotMatch(html, /id="tt-import-text"/);
  assert.doesNotMatch(html, /id="tt-import-roster"/);
  assert.doesNotMatch(html, /class="tt-plan-list"/);
  assert.doesNotMatch(html, /class="tt-plan-row"/);
  assert.match(html, /id="tt-rule-prompt"/);
  assert.match(html, /id="tt-parse-rules"/);
  assert.match(html, /id="tt-confirm-rule-draft"/);
  assert.match(html, /id="tt-add-bulk-rule"/);
  assert.match(html, /id="tt-clear-rules"/);
  assert.match(html, /id="tt-bulk-days-trigger"/);
  assert.match(html, /id="tt-bulk-periods-trigger"/);
  assert.match(html, /data-bulk-day="1"/);
  assert.match(html, /data-bulk-period="4"/);

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
  assert.match(open, /id="tt-cancel-roster-import"/);
  assert.match(open, /id="tt-confirm-roster-import"/);
  assert.match(open, /data-roster-import-mode="file"/);
  assert.match(open, /data-roster-import-mode="text"/);
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
  assert.match(controllerSource, /confirmRosterImport\(/);
  assert.match(controllerSource, /new FormData\(\)/);
  assert.match(controllerSource, /#tt-roster-import-text/);
  assert.match(interactionSource, /data-roster-import-trigger/);
  assert.match(interactionSource, /#tt-reopen-roster-import/);
  assert.match(interactionSource, /#tt-confirm-roster-import/);
  assert.match(interactionSource, /#tt-cancel-roster-import/);
  assert.match(interactionSource, /#tt-roster-import-file/);
  assert.match(interactionSource, /\[data-roster-import-mode\]/);
  assert.match(styles, /\.tt-dialog-overlay/);
  assert.match(styles, /\.tt-roster-import-dialog/);
  assert.match(styles, /\.tt-import-dropzone/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog/);
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

test('timetable inspector surfaces data and AI rule audit summaries', () => {
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
  });

  const inspector = renderInspector(state);

  assert.match(inspector, /class="tt-audit-grid"/);
  assert.match(inspector, /tt-rule-preview-item/);
  assert.match(inspector, /Unknown class ignored/);
});
