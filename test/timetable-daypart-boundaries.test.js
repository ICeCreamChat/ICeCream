import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimetableScore,
  createDefaultTimetableProject,
} from '../gateway/services/timetable-scheduler.js';
import {
  getDayPartPeriods,
  normalizeTimetableProject,
} from '../gateway/services/timetable-project.js';
import { buildTimetableProblem } from '../gateway/services/timetable-solver-bridge.js';
import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';

function sampleProject(overrides = {}) {
  return createDefaultTimetableProject({
    weekdays: 5,
    periodsPerDay: 8,
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
    dayPartBoundaries: {
      afternoonStartPeriod: 6,
      eveningStartPeriod: 8,
    },
    teachers: [{ id: 't_wang', name: '王老师', subjects: ['math'], unavailableSlots: [] }],
    classes: [{ id: 'c1', grade: '高一', name: '1班' }],
    subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
    lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang', weeklyHours: 1 }],
    rules: { hardRules: {}, softRules: { morningSubjects: ['math'] } },
    ...overrides,
  });
}

test('normalizeTimetableProject preserves and sanitizes explicit day-part boundaries', () => {
  const project = normalizeTimetableProject({
    activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
    dayPartBoundaries: {
      afternoonStartPeriod: 6,
      eveningStartPeriod: 5,
    },
  });

  assert.deepEqual(project.dayPartBoundaries, {
    afternoonStartPeriod: 6,
    eveningStartPeriod: null,
  });
});

test('getDayPartPeriods falls back to midpoint when boundaries are missing', () => {
  const fallbackProject = sampleProject({ dayPartBoundaries: { afternoonStartPeriod: null, eveningStartPeriod: null } });

  assert.deepEqual(getDayPartPeriods(fallbackProject, 'morning'), [1, 2, 3, 4]);
  assert.deepEqual(getDayPartPeriods(fallbackProject, 'afternoon'), [5, 6, 7, 8]);
  assert.deepEqual(getDayPartPeriods(fallbackProject, 'evening'), []);
});

test('getDayPartPeriods respects explicit afternoon and evening boundaries', () => {
  const project = sampleProject();

  assert.deepEqual(getDayPartPeriods(project, 'morning'), [1, 2, 3, 4, 5]);
  assert.deepEqual(getDayPartPeriods(project, 'afternoon'), [6, 7]);
  assert.deepEqual(getDayPartPeriods(project, 'evening'), [8]);
});

test('buildTimetableProblem marks morning slots using explicit afternoon boundary', () => {
  const problem = buildTimetableProblem(sampleProject());
  const slotMap = new Map(problem.timeSlots.map(slot => [slot.lessonIndex, slot]));

  assert.equal(slotMap.get(5).morning, true);
  assert.equal(slotMap.get(6).morning, false);
  assert.equal(slotMap.get(8).morning, false);
});

test('buildTimetableScore evaluates morning subjects against explicit day-part boundaries', () => {
  const project = sampleProject();
  const morningScore = buildTimetableScore(project, [{
    id: 'slot_1',
    classId: 'c1',
    subjectId: 'math',
    teacherId: 't_wang',
    teacherIds: ['t_wang'],
    day: 1,
    period: 5,
  }], [], []);
  const afternoonScore = buildTimetableScore(project, [{
    id: 'slot_2',
    classId: 'c1',
    subjectId: 'math',
    teacherId: 't_wang',
    teacherIds: ['t_wang'],
    day: 1,
    period: 6,
  }], [], []);

  assert.equal(morningScore.softBreakdown.morningSubjects, 100);
  assert.equal(afternoonScore.softBreakdown.morningSubjects, 0);
});

test('parseTimetableRules maps afternoon and evening text to explicit day-part periods', async () => {
  const project = sampleProject();

  const afternoon = await parseTimetableRules({
    text: '王老师周三下午都没空',
    project,
    env: {},
  });
  const evening = await parseTimetableRules({
    text: '王老师周五晚自习不排课',
    project,
    env: {},
  });

  assert.deepEqual(afternoon.draftRules.hardRules.teacherUnavailable.t_wang, ['3-6', '3-7']);
  assert.deepEqual(evening.draftRules.hardRules.teacherUnavailable.t_wang, ['5-8']);
});
