import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { TimetablePlannerController } from '../public/js/tools/timetable/controller.js';
import {
  getRuleSummary,
  getSavedRuleItems,
  removeSavedRuleById,
} from '../public/js/tools/timetable/selectors.js';
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
  assert.match(inspector, /Math Teacher has too many consecutive lessons/);
  assert.match(inspector, /teacherConsecutive/);
  assert.match(inspector, /classDailyBalance/);
});

test('timetable schedule panel shows local optimization phase while running', () => {
  const state = sampleWorkbenchState({
    loading: true,
    solvePhaseText: '局部优化中',
  });

  const panel = renderSchedulePanel(state);

  assert.match(panel, /局部优化中/);
  assert.match(panel, /loader-2/);
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
  // AI constraints use the same compact entry + modal workflow as roster import.
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
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*\.tt-roster-import-dialog/);
});

test('timetable AI rules support Excel file upload and rich preview metadata', async () => {
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
  assert.match(sidebar, /继续复核 AI 约束/);
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

test('timetable AI rules sidebar renders roster-style card entry while examples and file upload stay in the modal', async () => {
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
  assert.match(sidebar, /导入 AI 约束/);
  assert.doesNotMatch(sidebar, /tt-rule-entry-card/);
  // No dialog rendered when no pending rules and no open state
  assert.doesNotMatch(html, /id="tt-rule-review-dialog"/);
  // view.js contains the locked_slot option in the manual rule builder
  assert.match(viewSource, /value="locked_slot"/);

  // Opening directly to manual mode keeps manual rules in the modal.
  const controller = new TimetablePlannerController();
  controller.render = () => {};
  controller.openRuleReview('manual');
  assert.equal(controller.state.ruleReview.open, true);
  assert.equal(controller.state.ruleReview.step, 'manual');
  assert.equal(controller.state.ruleReview.mode, 'manual');
});

test('timetable rule review modal shows seating-style parse progress feedback', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const fileHtml = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'input',
      mode: 'file',
      fileName: 'AI-rules.xlsx',
      text: 'Math prefers morning',
      draftRows: [],
      warnings: [],
      loading: true,
      phase: 'parse_file',
      phaseText: 'AI 解析约束中...',
    },
  }));

  assert.match(fileHtml, /class="[^"]*tt-process-strip[^"]*"/);
  assert.match(fileHtml, /AI 解析约束中\.\.\./);
  assert.match(fileHtml, /AI-rules\.xlsx/);
  assert.match(fileHtml, /id="tt-rule-review-parse"[^>]*disabled/);
  assert.match(fileHtml, /data-lucide="loader-2"[^>]*class="tt-spin"/);
  assert.match(fileHtml, /AI 解析中/);
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

test('timetable rule review modal locks review table while rules are being written', () => {
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: 'AI-rules.xlsx',
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

test('timetable rule review table aligns controls with fixed helper rows', async () => {
  const styles = await readFile(stylePath, 'utf8');
  const html = renderWorkbench(sampleWorkbenchState({
    ruleReview: {
      open: true,
      step: 'review',
      mode: 'file',
      fileName: 'AI-rules.xlsx',
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

test('timetable saved AI rules remain visible after confirmation', async () => {
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
  assert.match(sidebar, /查看 AI 约束/);
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
  assert.match(styles, /(?:^|\n)\.tt-saved-rules\s+\.tt-saved-rule-row\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.tt-saved-rule-row\s*\{/);
});

test('timetable saved AI rules can be removed one at a time without clearing others', () => {
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
