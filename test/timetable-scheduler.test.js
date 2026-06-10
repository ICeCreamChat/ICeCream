import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { createGatewayApp } from '../gateway/app.js';
import { summarizeScheduleConflicts } from '../gateway/services/timetable-conflicts.js';
import {
    parseTimetableRosterText,
    previewTimetableRosterFile,
} from '../gateway/services/timetable-import.js';
import {
    createTimetableOptimizationJob,
    getTimetableOptimizationJob,
    resetTimetableOptimizationJobs,
} from '../gateway/services/timetable-optimization-jobs.js';
import {
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
    TimetableRuleParseError,
} from '../gateway/services/timetable-rule-parser.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';
import { validateTimetableProjectForSolve } from '../gateway/services/timetable-validation.js';
import {
    applyScheduleAdjustment,
    createDefaultTimetableProject,
    normalizeTimetableProject,
    runTimetableScheduler,
    validateTimetablePublication,
} from '../gateway/services/timetable-scheduler.js';

function sampleProject(overrides = {}) {
    return createDefaultTimetableProject({
        schoolName: 'ICeCream 实验学校',
        term: '2026 春季',
        weekdays: 5,
        periodsPerDay: 4,
        teachers: [
            { id: 't_math', name: '陈老师', subjects: ['math'], unavailableSlots: ['1-1'] },
            { id: 't_cn', name: '林老师', subjects: ['chinese'], unavailableSlots: [] },
            { id: 't_pe', name: '周老师', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班' },
            { id: 'c2', grade: '七年级', name: '2班' },
        ],
        subjects: [
            { id: 'math', name: '数学', priority: 100, color: '#14b8a6' },
            { id: 'chinese', name: '语文', priority: 95, color: '#60a5fa' },
            { id: 'pe', name: '体育', priority: 35, color: '#f97316' },
        ],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3, blockPreference: 'single' },
            { id: 'lp2', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 3, blockPreference: 'single' },
            { id: 'lp3', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 3, blockPreference: 'single' },
            { id: 'lp4', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 2, blockPreference: 'single' },
        ],
        rules: {
            hardRules: {
                lockedSlots: [
                    { day: 2, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                ],
                teacherUnavailable: {
                    t_cn: ['5-4'],
                },
                classUnavailable: {
                    c2: ['1-1'],
                },
            },
            softRules: {
                morningSubjects: ['math', 'chinese'],
                balancedTeacherLoad: true,
            },
        },
        ...overrides,
    });
}

function largeTimetableProject() {
    const subjects = [
        { id: 'chinese', name: 'Chinese', priority: 100, color: '#14b8a6', weeklyHours: 4 },
        { id: 'math', name: 'Math', priority: 95, color: '#60a5fa', weeklyHours: 4 },
        { id: 'english', name: 'English', priority: 90, color: '#f59e0b', weeklyHours: 4 },
        { id: 'history', name: 'History', priority: 65, color: '#f97316', weeklyHours: 4 },
        { id: 'geography', name: 'Geography', priority: 60, color: '#a78bfa', weeklyHours: 4 },
        { id: 'pe', name: 'PE', priority: 30, color: '#06b6d4', weeklyHours: 3 },
    ];
    const classes = Array.from({ length: 30 }, (_, index) => ({
        id: `c${index + 1}`,
        grade: 'G7',
        name: `${index + 1}`,
    }));
    const teachers = [];
    const lessonPlans = [];

    for (const klass of classes) {
        for (const subject of subjects) {
            const teacherId = `t_${subject.id}_${klass.id}`;
            teachers.push({
                id: teacherId,
                name: `${subject.name} ${klass.name}`,
                subjects: [subject.id],
                unavailableSlots: [],
            });
            lessonPlans.push({
                id: `lp_${klass.id}_${subject.id}`,
                classId: klass.id,
                subjectId: subject.id,
                teacherId,
                weeklyHours: subject.weeklyHours,
                blockPreference: subject.id === 'pe' ? 'double' : 'single',
            });
        }
    }

    return createDefaultTimetableProject({
        schoolName: 'ICeCream School',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers,
        classes,
        subjects,
        lessonPlans,
        rules: { hardRules: {}, softRules: { morningSubjects: ['chinese', 'math', 'english'] } },
    });
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return predicate();
}

function assertNoTeacherOrClassConflicts(slots) {
    const teacherSlots = new Set();
    const classSlots = new Set();
    for (const slot of slots) {
        const teacherKey = `${slot.teacherId}:${slot.day}-${slot.period}`;
        const classKey = `${slot.classId}:${slot.day}-${slot.period}`;
        assert.equal(teacherSlots.has(teacherKey), false, `teacher conflict at ${teacherKey}`);
        assert.equal(classSlots.has(classKey), false, `class conflict at ${classKey}`);
        teacherSlots.add(teacherKey);
        classSlots.add(classKey);
    }
}

test('timetable project normalizes active weekdays and active periods from legacy shape', () => {
    const legacy = normalizeTimetableProject({ weekdays: 3, periodsPerDay: 4 });
    assert.deepEqual(legacy.activeWeekdays, [1, 2, 3]);
    assert.deepEqual(legacy.activePeriods, [1, 2, 3, 4]);

    const narrowed = normalizeTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [3, 1, 3, 9, 0],
        activePeriods: [7, 2, 2, 12, 13],
    });

    assert.deepEqual(narrowed.activeWeekdays, [1, 3]);
    assert.deepEqual(narrowed.activePeriods, [2, 7, 12]);
    assert.equal(narrowed.weekdays, 3);
    assert.equal(narrowed.periodsPerDay, 12);
});

test('fast timetable scheduler only places lessons inside active day and period selections', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [2, 4],
        activePeriods: [3, 5],
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE Teacher', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: 'G7', name: '1' },
            { id: 'c2', grade: 'G7', name: '2' },
        ],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'pe', name: 'PE', priority: 30, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
            { id: 'lp2', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.equal(result.schedule.slots.length, 4);
    assert.equal(result.schedule.slots.every(slot => [2, 4].includes(slot.day)), true);
    assert.equal(result.schedule.slots.every(slot => [3, 5].includes(slot.period)), true);
    assert.equal(result.schedule.score.hardConflicts, 0);
});

test('fast timetable scheduler scores subject preferred and avoided periods', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 2,
        activeWeekdays: [1],
        activePeriods: [1, 2],
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE Teacher', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'pe', name: 'PE', priority: 30, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1, roomId: 'room-a' },
            { id: 'lp_pe', classId: 'c1', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 1 },
        ],
        rules: {
            hardRules: {},
            softRules: {
                subjectPreferredPeriods: {
                    math: { prefer: ['1-2'], avoid: ['1-1'], weight: 40 },
                },
            },
        },
    });

    const result = runTimetableScheduler(project);
    const math = result.schedule.slots.find(slot => slot.subjectId === 'math');

    assert.equal(result.success, true);
    assert.equal(math.day, 1);
    assert.equal(math.period, 2);
});

test('fast timetable scheduler assigns alternate allowed rooms to avoid room conflicts', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 1,
        activeWeekdays: [1],
        activePeriods: [1],
        teachers: [
            { id: 't_sci_1', name: 'Science 1', subjects: ['science'], unavailableSlots: [] },
            { id: 't_sci_2', name: 'Science 2', subjects: ['science'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: 'G7', name: '1' },
            { id: 'c2', grade: 'G7', name: '2' },
        ],
        subjects: [{ id: 'science', name: 'Science Lab', priority: 50, color: '#2563eb', category: 'lab' }],
        lessonPlans: [
            {
                id: 'lp_lab_1',
                classId: 'c1',
                subjectId: 'science',
                teacherId: 't_sci_1',
                weeklyHours: 1,
                allowedRoomIds: ['Lab A', 'Lab B'],
            },
            {
                id: 'lp_lab_2',
                classId: 'c2',
                subjectId: 'science',
                teacherId: 't_sci_2',
                weeklyHours: 1,
                allowedRoomIds: ['Lab A', 'Lab B'],
            },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assert.equal(result.schedule.audit.blockingIssues.some(issue => issue.type === 'room_capacity'), false);
    assert.equal(result.schedule.slots.length, 2);
    assert.deepEqual(
        result.schedule.slots.map(slot => slot.roomId).sort(),
        ['Lab A', 'Lab B'],
    );
    assert.equal(result.schedule.slots.every(slot => slot.day === 1 && slot.period === 1), true);
});

test('timetable scheduler creates a reproducible conflict-free schedule', () => {
    const result = runTimetableScheduler(sampleProject());

    assert.equal(result.success, true);
    assert.equal(result.schedule.source, 'fast_constructed');
    assert.equal(result.schedule.slots.length, 11);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assertNoTeacherOrClassConflicts(result.schedule.slots);

    const locked = result.schedule.slots.find(slot => slot.locked);
    assert.deepEqual(
        { day: locked.day, period: locked.period, classId: locked.classId, subjectId: locked.subjectId },
        { day: 2, period: 1, classId: 'c1', subjectId: 'math' },
    );
    assert.equal(result.schedule.slots.some(slot => slot.teacherId === 't_math' && slot.day === 1 && slot.period === 1), false);
    assert.equal(result.schedule.slots.some(slot => slot.classId === 'c2' && slot.day === 1 && slot.period === 1), false);
});

test('fast timetable scheduler handles the 690 lesson project without Timefold', () => {
    const project = largeTimetableProject();
    const startedAt = Date.now();

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.equal(result.schedule.source, 'fast_constructed');
    assert.equal(result.schedule.slots.length, 690);
    assert.equal(result.schedule.score.totalLessons, 690);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.ok(Date.now() - startedAt < 15000, 'fast scheduler should complete under the local 15s budget');
    assertNoTeacherOrClassConflicts(result.schedule.slots);
});

test('timetable scheduler returns explainable unplaced lessons when constraints are impossible', () => {
    const project = sampleProject({
        weekdays: 1,
        periodsPerDay: 1,
        teachers: [{ id: 't_math', name: '陈老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班' },
            { id: 'c2', grade: '七年级', name: '2班' },
        ],
        subjects: [{ id: 'math', name: '数学', priority: 100, color: '#14b8a6' }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
            { id: 'lp2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, false);
    assert.equal(result.schedule.slots.length, 1);
    assert.equal(result.schedule.unplaced.length, 1);
    assert.match(result.schedule.unplaced[0].reason, /没有可用节次|教师/);
    assert.ok(result.schedule.conflicts.some(conflict => conflict.type === 'unplaced'));
});

test('timetable scheduler attaches preflight audit for impossible capacity', () => {
    const project = sampleProject({
        weekdays: 1,
        periodsPerDay: 1,
        activeWeekdays: [1],
        activePeriods: [1],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, false);
    assert.ok(result.schedule.audit);
    assert.ok(result.schedule.audit.blockingIssues.some(issue => issue.type === 'class_capacity'));
    assert.ok(result.schedule.audit.blockingIssues.some(issue => issue.type === 'teacher_capacity'));
    assert.equal(result.schedule.audit.capacity.totalLessons, 2);
    assert.equal(result.schedule.solverStats.reason, 'preflight_blocking_issues');
});

test('fast scheduler emits explainable quality issues and richer soft breakdown', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 4,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3, 4],
        teachers: [{ id: 't_cn', name: 'Chinese Teacher', subjects: ['chinese'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'chinese', name: 'Chinese', priority: 90, color: '#2563eb', category: 'main' }],
        lessonPlans: [
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 4 },
        ],
        rules: {
            hardRules: {},
            softRules: {
                morningSubjects: ['chinese'],
                teacherLimits: { t_cn: { consecutive: 2, daily: 3 } },
                spreadSubjects: ['chinese'],
                subjectPreferredPeriods: { chinese: { avoid: ['1-4'], weight: 30 } },
            },
        },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.classDailyBalance));
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.teacherConsecutive));
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.roomUsage));
    assert.ok(result.schedule.qualityIssues.some(issue => issue.type === 'teacher_consecutive'));
    assert.ok(result.schedule.qualityIssues.some(issue => issue.type === 'subject_avoid_period'));
    assert.ok(result.schedule.qualityIssues.some(issue => issue.type === 'subject_spread'));
});

test('fast scheduler reports real soft-rule satisfaction breakdown', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 4,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3, 4],
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE Teacher', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: '数学', priority: 90, color: '#2563eb' },
            { id: 'pe', name: '体育', priority: 30, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
            { id: 'lp_pe', classId: 'c1', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: { morningSubjects: ['math'] } },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    // morning subject (math) should land in the first half of the day
    const mathSlot = result.schedule.slots.find(slot => slot.subjectId === 'math');
    assert.ok(mathSlot.period <= 2, 'math should be scheduled in the morning half');
    assert.equal(result.schedule.score.softBreakdown.morningSubjects, 100);
    assert.ok(result.schedule.score.softSatisfaction >= 0 && result.schedule.score.softSatisfaction <= 100);
});

test('fast scheduler packs mixed block preference into double blocks', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 4,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4],
        teachers: [{ id: 't_sci', name: 'Science', subjects: ['sci'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'sci', name: '科学', priority: 50, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_sci', classId: 'c1', subjectId: 'sci', teacherId: 't_sci', weeklyHours: 6, blockPreference: 'mixed' },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.equal(result.schedule.slots.length, 6);
    // 6 hours of mixed should become 2+2+1+1: two distinct double blocks
    const blockIds = new Set(result.schedule.slots.filter(slot => slot.blockId).map(slot => slot.blockId));
    assert.equal(blockIds.size, 2, 'mixed 6h should produce two double blocks');
    const blockSlots = result.schedule.slots.filter(slot => slot.blockSize === 2);
    assert.equal(blockSlots.length, 4, 'four slots should belong to double blocks');
});

test('fast scheduler expands a locked double block into a contiguous protected block', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 5,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5],
        teachers: [{ id: 't_sci', name: 'Science', subjects: ['sci'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'sci', name: '科学', priority: 70, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_sci', classId: 'c1', subjectId: 'sci', teacherId: 't_sci', weeklyHours: 2, blockPreference: 'double' },
        ],
        rules: {
            hardRules: {
                lockedSlots: [{ day: 2, period: 3, classId: 'c1', subjectId: 'sci', teacherId: 't_sci', lessonPlanId: 'lp_sci' }],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
    });

    const result = runTimetableScheduler(project);
    const slots = result.schedule.slots
        .filter(slot => slot.lessonPlanId === 'lp_sci')
        .sort((left, right) => left.period - right.period);

    assert.equal(result.success, true);
    assert.deepEqual(slots.map(slot => [slot.day, slot.period, slot.locked, slot.blockSize]), [
        [2, 3, true, 2],
        [2, 4, true, 2],
    ]);
    assert.equal(new Set(slots.map(slot => slot.blockId)).size, 1);
    assert.equal(result.schedule.unplaced.length, 0);
    assert.equal(result.schedule.score.hardConflicts, 0);
});

test('fast scheduler anchors a locked double block backward from the last active period', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 5,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5],
        teachers: [{ id: 't_sci', name: 'Science', subjects: ['sci'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'sci', name: 'Science', priority: 70, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_sci', classId: 'c1', subjectId: 'sci', teacherId: 't_sci', weeklyHours: 2, blockPreference: 'double' },
        ],
        rules: {
            hardRules: {
                lockedSlots: [{ day: 2, period: 5, classId: 'c1', subjectId: 'sci', teacherId: 't_sci', lessonPlanId: 'lp_sci' }],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
    });

    const result = runTimetableScheduler(project);
    const slots = result.schedule.slots
        .filter(slot => slot.lessonPlanId === 'lp_sci')
        .sort((left, right) => left.period - right.period);

    assert.equal(result.success, true);
    assert.deepEqual(slots.map(slot => [slot.day, slot.period, slot.locked, slot.blockSize]), [
        [2, 4, true, 2],
        [2, 5, true, 2],
    ]);
    assert.equal(result.schedule.conflicts.some(conflict => conflict.type === 'locked-conflict'), false);
});

test('fast scheduler treats duplicate locked slots inside the same double block as one protected block', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 5,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5],
        teachers: [{ id: 't_sci', name: 'Science', subjects: ['sci'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'sci', name: 'Science', priority: 70, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_sci', classId: 'c1', subjectId: 'sci', teacherId: 't_sci', weeklyHours: 4, blockPreference: 'double' },
        ],
        rules: {
            hardRules: {
                lockedSlots: [
                    { day: 2, period: 4, classId: 'c1', subjectId: 'sci', teacherId: 't_sci', lessonPlanId: 'lp_sci' },
                    { day: 2, period: 3, classId: 'c1', subjectId: 'sci', teacherId: 't_sci', lessonPlanId: 'lp_sci' },
                ],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
    });

    const result = runTimetableScheduler(project);
    const lockedSlots = result.schedule.slots
        .filter(slot => slot.lessonPlanId === 'lp_sci' && slot.locked)
        .sort((left, right) => left.day - right.day || left.period - right.period);

    assert.equal(result.success, true);
    assert.deepEqual(lockedSlots.map(slot => [slot.day, slot.period, slot.blockSize]), [
        [2, 3, 2],
        [2, 4, 2],
    ]);
    assert.equal(result.schedule.slots.filter(slot => slot.lessonPlanId === 'lp_sci').length, 4);
    assert.equal(result.schedule.conflicts.some(conflict => conflict.type === 'locked-conflict'), false);
});

test('local repair rescues an otherwise unplaced lesson by relocating a blocker', () => {
    // Two classes share one teacher across a 2x2 grid. A naive greedy that fills
    // greedily could strand the last lesson; repair should relocate to fit all four.
    const project = createDefaultTimetableProject({
        weekdays: 2,
        periodsPerDay: 2,
        activeWeekdays: [1, 2],
        activePeriods: [1, 2],
        teachers: [
            { id: 't_a', name: 'A', subjects: ['s1'], unavailableSlots: [] },
            { id: 't_b', name: 'B', subjects: ['s2'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G', name: '1' }],
        subjects: [
            { id: 's1', name: 'S1', priority: 50, color: '#2563eb' },
            { id: 's2', name: 'S2', priority: 50, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't_a', weeklyHours: 2 },
            { id: 'lp2', classId: 'c1', subjectId: 's2', teacherId: 't_b', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.equal(result.schedule.slots.length, 4);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assertNoTeacherOrClassConflicts(result.schedule.slots);
});

test('structured subject category drives scheduler timing without relying on course name', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 4,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3, 4],
        teachers: [
            { id: 't_project', name: 'Project Teacher', subjects: ['project'], unavailableSlots: [] },
            { id: 't_quality', name: 'Quality Teacher', subjects: ['quality'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'project', name: 'Project Studies', category: 'main', tags: ['core'], priority: 50, color: '#2563eb' },
            { id: 'quality', name: 'Movement Studio', category: 'quality', tags: ['sport'], priority: 50, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_project', classId: 'c1', subjectId: 'project', teacherId: 't_project', weeklyHours: 1 },
            { id: 'lp_quality', classId: 'c1', subjectId: 'quality', teacherId: 't_quality', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);
    const projectSlot = result.schedule.slots.find(slot => slot.subjectId === 'project');
    const qualitySlot = result.schedule.slots.find(slot => slot.subjectId === 'quality');

    assert.equal(result.success, true);
    assert.ok(projectSlot.period <= 2, 'main-category subject should prefer the morning half');
    assert.ok(qualitySlot.period > projectSlot.period, 'quality-category subject should be pushed later than main subject');
});

test('solve preflight explains missing timetable data before calling Timefold', () => {
    const empty = createDefaultTimetableProject({
        teachers: [],
        classes: [],
        subjects: [],
        lessonPlans: [],
    });

    const validation = validateTimetableProjectForSolve(empty);

    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'missing_lesson_plans');
    assert.match(validation.message, /任课数据/);
});

test('publication validation blocks incomplete schedules and hard conflicts', () => {
    const cleanProject = runTimetableScheduler(sampleProject()).project;
    const ready = validateTimetablePublication(cleanProject);

    assert.equal(ready.ok, true);
    assert.equal(ready.reason, 'ready');
    assert.equal(ready.summary.totalLessons, 11);
    assert.equal(ready.summary.unplacedLessons, 0);
    assert.ok(Array.isArray(ready.reviewItems));

    const restoredDraft = validateTimetablePublication({
        ...cleanProject,
        schedule: {
            ...cleanProject.schedule,
            source: 'published_history_restored',
        },
    });

    assert.equal(restoredDraft.ok, true);
    assert.ok(restoredDraft.warnings.some(issue => issue.type === 'restored_published_draft'));
    assert.ok(restoredDraft.reviewItems.some(item => item.type === 'restored_published_draft'
        && item.message.includes('恢复发布版')));

    const highLoadProject = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 4,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3, 4],
        teachers: [{ id: 't_load', name: 'High Load Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [
            { id: 'c1', grade: 'G7', name: '1' },
            { id: 'c2', grade: 'G7', name: '2' },
            { id: 'c3', grade: 'G7', name: '3' },
            { id: 'c4', grade: 'G7', name: '4' },
        ],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_load', weeklyHours: 1 },
            { id: 'lp2', classId: 'c2', subjectId: 'math', teacherId: 't_load', weeklyHours: 1 },
            { id: 'lp3', classId: 'c3', subjectId: 'math', teacherId: 't_load', weeklyHours: 1 },
            { id: 'lp4', classId: 'c4', subjectId: 'math', teacherId: 't_load', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
    const highLoadReady = validateTimetablePublication(runTimetableScheduler(highLoadProject).project);

    assert.equal(highLoadReady.ok, true);
    assert.ok(highLoadReady.reviewItems.some(item => item.type === 'teacher_load' && item.targetKind === 'teacher'));

    const incomplete = validateTimetablePublication(sampleProject({
        schedule: {
            ...cleanProject.schedule,
            slots: cleanProject.schedule.slots.slice(0, -1),
            unplaced: [{ lessonPlanId: 'lp4', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', reason: 'missing slot' }],
            conflicts: [],
            score: { ...cleanProject.schedule.score, placedLessons: 10, unplacedLessons: 1, completeness: 91 },
        },
    }));

    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.reason, 'publication_blocked');
    assert.ok(incomplete.blockingIssues.some(issue => issue.type === 'incomplete_schedule'));
    assert.ok(incomplete.reviewItems.some(item => item.type === 'incomplete_schedule' && item.targetKind === 'class'));

    const [left, right] = cleanProject.schedule.slots.filter(slot => slot.teacherId === 't_math');
    const conflicted = validateTimetablePublication(sampleProject({
        schedule: {
            ...cleanProject.schedule,
            slots: [
                left,
                { ...right, id: 'forced_conflict', day: left.day, period: left.period },
                ...cleanProject.schedule.slots.filter(slot => slot.id !== left.id && slot.id !== right.id),
            ],
            conflicts: [],
            unplaced: [],
        },
    }));

    assert.equal(conflicted.ok, false);
    assert.ok(conflicted.blockingIssues.some(issue => issue.type === 'hard_conflicts'));
    assert.ok(conflicted.summary.hardConflicts > 0);
});

test('publication validation warns when the saved published snapshot fingerprint mismatches', () => {
    const cleanProject = runTimetableScheduler(sampleProject()).project;
    const validation = validateTimetablePublication({
        ...cleanProject,
        schedule: {
            ...cleanProject.schedule,
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: cleanProject.schedule.id,
                note: '教务处确认发布',
                fingerprint: '0'.repeat(64),
                snapshot: {
                    scheduleId: cleanProject.schedule.id,
                    generatedAt: cleanProject.schedule.generatedAt,
                    source: cleanProject.schedule.source,
                    slotCount: cleanProject.schedule.slots.length,
                    score: cleanProject.schedule.score,
                    publicationSummary: { totalLessons: 11, placedLessons: 11, unplacedLessons: 0, hardConflicts: 0 },
                    fingerprint: '0'.repeat(64),
                    slots: cleanProject.schedule.slots,
                },
            },
        },
    });

    assert.equal(validation.ok, true);
    assert.equal(validation.reason, 'ready');
    assert.ok(validation.warnings.some(issue => issue.type === 'publication_fingerprint_mismatch'
        && issue.message.includes('发布快照校验失败')));
    assert.ok(validation.reviewItems.some(item => item.type === 'publication_fingerprint_mismatch'
        && item.severity === 'warning'
        && item.targetName === '发布快照'));
});

test('publication validation warns when a published history snapshot fingerprint mismatches', () => {
    const cleanProject = runTimetableScheduler(sampleProject()).project;
    const validation = validateTimetablePublication({
        ...cleanProject,
        schedule: {
            ...cleanProject.schedule,
            published: {
                status: 'published',
                version: 2,
                publishedAt: '2026-01-03T08:00:00.000Z',
                scheduleId: cleanProject.schedule.id,
                note: '第二次发布',
                snapshot: {
                    scheduleId: cleanProject.schedule.id,
                    generatedAt: cleanProject.schedule.generatedAt,
                    source: cleanProject.schedule.source,
                    slotCount: cleanProject.schedule.slots.length,
                    score: cleanProject.schedule.score,
                    publicationSummary: { totalLessons: 11, placedLessons: 11, unplacedLessons: 0, hardConflicts: 0 },
                    slots: cleanProject.schedule.slots,
                },
                history: [{
                    version: 1,
                    publishedAt: '2026-01-02T08:00:00.000Z',
                    scheduleId: 'published-v1',
                    note: '第一次发布',
                    fingerprint: '0'.repeat(64),
                    snapshot: {
                        scheduleId: 'published-v1',
                        generatedAt: cleanProject.schedule.generatedAt,
                        source: cleanProject.schedule.source,
                        slotCount: cleanProject.schedule.slots.length,
                        score: cleanProject.schedule.score,
                        publicationSummary: { totalLessons: 11, placedLessons: 11, unplacedLessons: 0, hardConflicts: 0 },
                        fingerprint: '0'.repeat(64),
                        slots: cleanProject.schedule.slots,
                    },
                }],
            },
        },
    });

    assert.equal(validation.ok, true);
    assert.ok(validation.warnings.some(issue => issue.type === 'publication_fingerprint_mismatch'
        && issue.targetName === '发布历史 V1'
        && issue.message.includes('发布快照校验失败')));
    assert.ok(validation.reviewItems.some(item => item.type === 'publication_fingerprint_mismatch'
        && item.severity === 'warning'
        && item.targetName === '发布历史 V1'));
});

test('publication validation warns when the current published schedule is missing its snapshot', () => {
    const cleanProject = runTimetableScheduler(sampleProject()).project;
    const validation = validateTimetablePublication({
        ...cleanProject,
        schedule: {
            ...cleanProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: cleanProject.schedule.id,
                note: 'legacy published without snapshot',
            },
        },
    });

    assert.equal(validation.ok, true);
    assert.ok(validation.warnings.some(issue => issue.type === 'published_snapshot_backfill_needed'
        && issue.targetName === '\u53d1\u5e03\u5feb\u7167'
        && issue.message.includes('\u7f3a\u5c11\u53d1\u5e03\u5feb\u7167')));
    assert.ok(validation.reviewItems.some(item => item.type === 'published_snapshot_backfill_needed'
        && item.severity === 'warning'
        && item.targetName === '\u53d1\u5e03\u5feb\u7167'));
});

test('conflict summary groups hard failures for the workbench inspector', () => {
    const project = sampleProject({
        schedule: {
            id: 'conflict_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            slots: [
                {
                    id: 'a',
                    day: 1,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math'],
                    lessonPlanId: 'lp1',
                    locked: false,
                },
                {
                    id: 'b',
                    day: 1,
                    period: 1,
                    classId: 'c2',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math'],
                    lessonPlanId: 'lp3',
                    locked: false,
                },
            ],
            lockedSlots: [],
            conflicts: [
                { type: 'teacher-conflict', severity: 'hard', message: '教师同节冲突' },
                { type: 'teacher-conflict', severity: 'hard', message: '教师同节冲突' },
                { type: 'unplaced', severity: 'hard', message: '有课时未排入课表' },
            ],
            unplaced: [{ lessonPlanId: 'lp4', reason: '有课时未排入课表' }],
            score: { hardConflicts: 3, unplacedLessons: 1, placedLessons: 2, totalLessons: 11, completeness: 18 },
        },
    });

    const summary = summarizeScheduleConflicts(project.schedule);

    assert.deepEqual(summary.counts, {
        'teacher-conflict': 2,
        unplaced: 1,
    });
    assert.equal(summary.hardCount, 3);
    assert.equal(summary.items[0].label, '教师冲突');
});

test('manual adjustment preserves unplaced conflicts after partial schedules change', () => {
    const project = sampleProject({
        weekdays: 1,
        periodsPerDay: 1,
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [
            { id: 'c1', grade: 'G7', name: '1' },
            { id: 'c2', grade: 'G7', name: '2' },
        ],
        subjects: [{ id: 'math', name: 'Math', priority: 100, color: '#14b8a6' }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
            { id: 'lp2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
    const generated = runTimetableScheduler(project);
    const placed = generated.schedule.slots[0];

    assert.equal(generated.success, false);
    assert.equal(generated.schedule.unplaced.length, 1);
    assert.ok(generated.schedule.conflicts.some(conflict => conflict.type === 'unplaced'));

    const adjusted = applyScheduleAdjustment({ ...project, schedule: generated.schedule }, {
        type: 'lock',
        slotId: placed.id,
        locked: true,
    });

    assert.equal(adjusted.success, false);
    assert.equal(adjusted.schedule.unplaced.length, 1);
    assert.ok(adjusted.schedule.conflicts.some(conflict => conflict.type === 'unplaced'));
    assert.equal(adjusted.schedule.score.unplacedLessons, 1);
    assert.equal(adjusted.schedule.score.hardConflicts, 1);
});

test('manual adjustment moves, locks and clears timetable slots with validation', () => {
    const result = runTimetableScheduler(sampleProject());
    const first = result.schedule.slots.find(slot => !slot.locked && slot.teacherId === 't_math');
    const moved = applyScheduleAdjustment(sampleProject({ schedule: result.schedule }), {
        type: 'move',
        slotId: first.id,
        day: 5,
        period: 4,
    });

    const adjusted = moved.schedule.slots.find(slot => slot.id === first.id);
    assert.equal(adjusted.day, 5);
    assert.equal(adjusted.period, 4);
    assert.equal(adjusted.manuallyAdjusted, true);
    assert.equal(moved.schedule.source, 'manual_adjusted');

    const locked = applyScheduleAdjustment(sampleProject({ schedule: moved.schedule }), {
        type: 'lock',
        slotId: first.id,
        locked: true,
    });
    assert.equal(locked.schedule.slots.find(slot => slot.id === first.id).locked, true);

    const cleared = applyScheduleAdjustment(sampleProject({ schedule: locked.schedule }), {
        type: 'clear',
        slotId: first.id,
    });
    assert.equal(cleared.schedule.slots.some(slot => slot.id === first.id), false);
});

test('manual adjustment applies move, lock and clear to an entire block', () => {
    const project = sampleProject({
        schedule: {
            id: 'block_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            slots: [
                {
                    id: 'block_0',
                    day: 1,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math'],
                    lessonPlanId: 'lp1',
                    blockId: 'lp1_block_1',
                    blockIndex: 0,
                    blockSize: 2,
                    locked: false,
                },
                {
                    id: 'block_1',
                    day: 1,
                    period: 2,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math'],
                    lessonPlanId: 'lp1',
                    blockId: 'lp1_block_1',
                    blockIndex: 1,
                    blockSize: 2,
                    locked: false,
                },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 11, completeness: 18 },
        },
    });

    const moved = applyScheduleAdjustment(project, {
        type: 'move',
        slotId: 'block_1',
        day: 2,
        period: 4,
    });
    const movedBlock = moved.schedule.slots
        .filter(slot => slot.blockId === 'lp1_block_1')
        .sort((left, right) => left.blockIndex - right.blockIndex);

    assert.deepEqual(movedBlock.map(slot => [slot.day, slot.period]), [[2, 3], [2, 4]]);

    const locked = applyScheduleAdjustment({ ...project, schedule: moved.schedule }, {
        type: 'lock',
        slotId: 'block_0',
        locked: true,
    });
    assert.equal(locked.schedule.slots.filter(slot => slot.blockId === 'lp1_block_1').every(slot => slot.locked), true);

    const cleared = applyScheduleAdjustment({ ...project, schedule: locked.schedule }, {
        type: 'clear',
        slotId: 'block_0',
    });
    assert.equal(cleared.schedule.slots.some(slot => slot.blockId === 'lp1_block_1'), false);
});

test('timetable roster parser imports teachers, classes, subjects and lesson plans', () => {
    const parsed = parseTimetableRosterText(`
年级,班级,课程,教师,周课时,连堂
七年级,1班,数学,陈老师,4,单节
七年级,1班,语文,林老师,5,混合
七年级,2班,体育,周老师,2,双连堂
`);

    assert.equal(parsed.teachers.length, 3);
    assert.equal(parsed.classes.length, 2);
    assert.equal(parsed.subjects.length, 3);
    assert.equal(parsed.lessonPlans.length, 3);
    assert.equal(parsed.lessonPlans.find(plan => plan.subjectName === '体育').blockPreference, 'double');
});

test('timetable roster parser preserves subject category and tags from reviewed rows', () => {
    const result = parseTimetableRosterText([
        'grade,class,subject,teacher,hours,block,room,subject category,subject tags',
        'G7,1,Project Studies,Ms Main,2,single,,main,core/reading',
        'G7,1,Creative Lab,Ms Lab,2,double,Lab A,lab,experiment',
    ].join('\n'));

    const main = result.subjects.find(subject => subject.name === 'Project Studies');
    const lab = result.subjects.find(subject => subject.name === 'Creative Lab');
    const draftMain = result.draftRows.find(row => row.subjectName === 'Project Studies');

    assert.equal(draftMain.subjectCategory, 'main');
    assert.deepEqual(draftMain.subjectTags, ['core', 'reading']);
    assert.equal(main.category, 'main');
    assert.deepEqual(main.tags, ['core', 'reading']);
    assert.equal(main.priority, 95);
    assert.equal(lab.category, 'lab');
    assert.ok(lab.tags.includes('experiment'));
});

function makeTimetableWorkbook(rows, { sheetName = 'Sheet1' } = {}) {
    const zip = new AdmZip();
    const strings = [];
    const stringIndex = new Map();
    const xmlEscape = value => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const getStringIndex = value => {
        const key = String(value ?? '');
        if (!stringIndex.has(key)) {
            stringIndex.set(key, strings.length);
            strings.push(key);
        }
        return stringIndex.get(key);
    };
    const columnName = index => String.fromCharCode(65 + index);
    const sheetRows = rows.map((row, rowIndex) => `
        <row r="${rowIndex + 1}">
            ${row.map((cell, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="s"><v>${getStringIndex(cell)}</v></c>`).join('')}
        </row>
    `).join('');
    zip.addFile('[Content_Types].xml', Buffer.from(`
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
            <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
            <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
        </Types>
    `));
    zip.addFile('_rels/.rels', Buffer.from(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>
    `));
    zip.addFile('xl/workbook.xml', Buffer.from(`
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
        </workbook>
    `));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>
    `));
    zip.addFile('xl/sharedStrings.xml', Buffer.from(`<sst>${strings.map(value => `<si><t>${xmlEscape(value)}</t></si>`).join('')}</sst>`));
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`));
    return zip.toBuffer();
}

test('timetable roster preview parses Excel draft rows with teachers and rooms before saving', () => {
    const preview = previewTimetableRosterFile({
        filename: 'roster.xlsx',
        buffer: makeTimetableWorkbook([
            ['grade', 'class', 'subject', 'teacher', 'hours', 'block', 'room'],
            ['G7', '1', 'Math', 'Alice/Bob', '4', 'double', 'Lab 1/Lab 2'],
        ]),
    });

    assert.equal(preview.draftRows.length, 1);
    assert.equal(preview.draftRows[0].teacherName, 'Alice、Bob');
    assert.equal(preview.draftRows[0].roomName, 'Lab 1、Lab 2');
    assert.equal(preview.stats.planCount, 1);
    assert.equal(preview.issues.filter(issue => issue.severity === 'error').length, 0);
});

test('timetable AI rules parser derives local suggestions from roster Excel when AI is unavailable', async () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_english', name: 'English Teacher', subjects: ['english'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE Teacher', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'english', name: 'English', priority: 90, color: '#60a5fa' },
            { id: 'pe', name: 'PE', priority: 30, color: '#16a34a' },
        ],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = await parseTimetableRules({
        file: {
            filename: 'teacher-roster.xlsx',
            buffer: makeTimetableWorkbook([
                ['grade', 'class', 'subject', 'teacher', 'hours', 'block'],
                ['G7', '1', 'Math', 'Math Teacher', '5', 'single'],
                ['G7', '1', 'English', 'English Teacher', '4', 'single'],
                ['G7', '1', 'PE', 'PE Teacher', '3', 'mixed'],
            ]),
        },
        project,
        env: {},
    });

    assert.equal(result.inputType, 'xlsx_roster');
    assert.equal(result.source, 'local_roster_fallback');
    assert.equal(result.contextStats.totalLessons, 12);
    assert.deepEqual(result.draftRules.softRules.morningSubjects.sort(), ['english', 'math']);
    assert.ok(result.previewItems.some(item => item.type === 'subject_morning' && item.status === 'ready'));
    assert.ok(result.previewItems.some(item => item.type === 'block_protection' && item.status === 'suggestion'));
    assert.ok(result.unsupportedItems.length >= 1);
});

test('timetable AI rules parser falls back to reviewable roster suggestions when AI returns no constraints', async () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [],
        classes: [],
        subjects: [],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = await parseTimetableRules({
        file: {
            filename: 'teacher-roster.xlsx',
            buffer: makeTimetableWorkbook([
                ['grade', 'class', 'subject', 'teacher', 'hours', 'block'],
                ['G7', '1', 'Math', 'Math Teacher', '5', 'single'],
                ['G7', '1', 'English', 'English Teacher', '4', 'single'],
                ['G7', '1', 'PE', 'PE Teacher', '3', 'mixed'],
            ]),
        },
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async () => jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        constraints: [],
                        warnings: ['Roster is incomplete, review manually.'],
                    }),
                },
            }],
        }),
    });

    assert.equal(result.inputType, 'xlsx_roster');
    assert.equal(result.source, 'local_roster_fallback');
    assert.equal(result.contextStats.totalLessons, 12);
    assert.ok(result.draftRows.length > 0);
    assert.ok(result.previewItems.some(item => item.type === 'subject_morning'));
    assert.ok(result.previewItems.some(item => item.type === 'block_protection'));
    assert.ok(result.warnings.some(warning => warning.includes('Roster is incomplete')));
});

test('timetable AI rules parser sends constraint Excel to AI and maps preferred period rules', async () => {
    const project = sampleProject({
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        rules: { hardRules: {}, softRules: {} },
    });
    let observedPrompt = '';

    const result = await parseTimetableRules({
        file: {
            filename: 'constraints.xlsx',
            buffer: makeTimetableWorkbook([
                ['rule name', 'type', 'target', 'slots', 'natural language constraint'],
                ['Math later', 'subject_preferred_periods', 'Math', '1-2', 'Math should be at Monday period 2.'],
                ['PE not first', 'subject_avoid_periods', 'PE', '1-1', 'PE should avoid Monday period 1.'],
            ], { sheetName: 'AIConstraints' }),
        },
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            assert.equal(String(url), 'http://ai.test/chat/completions');
            const request = JSON.parse(options.body);
            observedPrompt = JSON.stringify(request.messages);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            constraints: [
                                { type: 'subject_preferred_periods', targetId: 'math', slots: ['1-2'], priority: 'soft', reason: 'Preferred time' },
                                { type: 'subject_avoid_periods', targetId: 'pe', slots: ['1-1'], priority: 'soft', reason: 'Avoid early PE' },
                                { type: 'teacher_load_balance', target: 'Math Teacher', priority: 'soft', reason: 'Balance workload' },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(result.inputType, 'xlsx_constraints');
    assert.equal(result.source, 'ai');
    assert.match(observedPrompt, /Math should be at Monday period 2/);
    assert.deepEqual(result.draftRules.softRules.subjectPreferredPeriods.math.prefer, ['1-2']);
    assert.deepEqual(result.draftRules.softRules.subjectPreferredPeriods.pe.avoid, ['1-1']);
    assert.ok(result.previewItems.some(item => item.type === 'teacher_load_balance' && item.status === 'suggestion'));
    assert.ok(result.unsupportedItems.some(item => item.type === 'teacher_load_balance'));
});

test('timetable AI rules parser recognizes the local AI constraint workbook as constraints', async () => {
    const project = sampleProject({
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        rules: { hardRules: {}, softRules: {} },
    });
    const workbook = await readFile(path.join(process.cwd(), 'AI排课约束建议.xlsx'));
    let observedPrompt = '';

    const result = await parseTimetableRules({
        file: {
            filename: 'AI排课约束建议.xlsx',
            buffer: workbook,
        },
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            assert.equal(String(url), 'http://ai.test/chat/completions');
            observedPrompt = JSON.stringify(JSON.parse(options.body).messages);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            constraints: [
                                { type: 'subject_morning', targetId: 'math', priority: 'soft', reason: '主科上午优先' },
                                { type: 'subject_preferred_periods', targetId: 'pe', slots: ['1-5', '2-5'], priority: 'soft', reason: '体育分散到后半天' },
                                { type: 'teacher_load_balance', target: '全部教师', priority: 'soft', reason: '高负载教师需要均衡' },
                            ],
                            warnings: ['复杂质量建议仅作为复核建议展示'],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(result.inputType, 'xlsx_constraints');
    assert.equal(result.contextStats.sheetName, 'AI约束建议');
    assert.ok(result.contextStats.rowCount >= 10);
    assert.ok(result.draftRows.length >= 3);
    assert.match(observedPrompt, /同一位教师同一时间只能给一个班上课/);
    assert.deepEqual(result.draftRules.softRules.morningSubjects, ['math']);
    assert.deepEqual(result.draftRules.softRules.subjectPreferredPeriods.pe.prefer, ['1-5', '2-5']);
    assert.ok(result.draftRows.some(row => row.status === 'suggestion' && row.type === 'teacher_load_balance'));
});

test('timetable AI rules parser locally extracts obvious text rules when AI is unavailable', async () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = await parseTimetableRules({
        text: 'Math Teacher 周三第4节不要排，Math 尽量上午。',
        project,
        env: {},
    });

    assert.equal(result.inputType, 'text');
    assert.equal(result.source, 'local_text');
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_math, ['3-4']);
    assert.deepEqual(result.draftRules.softRules.morningSubjects, ['math']);
    assert.equal(result.draftRows.filter(row => row.status === 'effective').length, 2);
});

test('timetable rule draft row normalization only saves effective valid rows', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'row_1',
            rawText: 'Math Teacher cannot teach Wednesday period 4',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            slots: ['3-4'],
            priority: 'hard',
            status: 'effective',
        }, {
            id: 'row_2',
            rawText: 'Balance teacher workload',
            type: 'teacher_load_balance',
            targetName: '全部教师',
            priority: 'soft',
            status: 'suggestion',
        }, {
            id: 'row_3',
            rawText: 'Unknown person Friday period 1',
            type: 'teacher_unavailable',
            targetName: 'Unknown person',
            slots: ['5-1'],
            priority: 'hard',
            status: 'needs_review',
        }],
    });

    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_math, ['3-4']);
    assert.equal(result.draftRows.find(row => row.id === 'row_2').status, 'suggestion');
    assert.equal(result.draftRows.find(row => row.id === 'row_3').status, 'needs_review');
    assert.ok(result.warnings.some(warning => warning.includes('Unknown person')));
});

test('timetable rule draft row normalization saves teacher limits and subject spread', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'pe', name: '体育', priority: 30, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'row_1',
            rawText: 'Math Teacher at most 3 lessons per day',
            type: 'teacher_daily_limit',
            targetType: 'teacher',
            targetId: 't_math',
            targetName: 'Math Teacher',
            limit: 3,
            priority: 'soft',
            status: 'effective',
        }, {
            id: 'row_2',
            rawText: 'PE should be spread across the week',
            type: 'subject_spread',
            targetType: 'subject',
            targetId: 'pe',
            targetName: '体育',
            priority: 'soft',
            status: 'effective',
        }],
    });

    assert.deepEqual(result.draftRules.softRules.teacherLimits.t_math, { daily: 3 });
    assert.ok(result.draftRules.softRules.spreadSubjects.includes('pe'));
    assert.equal(result.draftRows.filter(row => row.status === 'effective').length, 2);
});

test('timetable rule draft row normalization saves locked slot review rows', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'lock_1',
            rawText: 'Lock Math Teacher for G7-1 Math on Tuesday period 3',
            type: 'locked_slot',
            targetType: 'locked_slot',
            targetName: 'G7-1 / Math / Math Teacher',
            classId: 'c1',
            className: 'G7-1',
            subjectId: 'math',
            subjectName: 'Math',
            teacherId: 't_math',
            teacherName: 'Math Teacher',
            slots: ['2-3'],
            priority: 'hard',
            status: 'effective',
        }],
    });

    assert.equal(result.draftRows[0].status, 'effective');
    assert.equal(result.draftRows[0].type, 'locked_slot');
    assert.deepEqual(result.draftRules.hardRules.lockedSlots, [{
        id: 'lock_1',
        day: 2,
        period: 3,
        classId: 'c1',
        subjectId: 'math',
        teacherId: 't_math',
        lessonPlanId: 'lp_math',
        roomId: null,
    }]);
});

test('timetable constraint Excel requires AI when it is not a roster table', async () => {
    await assert.rejects(
        () => parseTimetableRules({
            file: {
                filename: 'constraints.xlsx',
                buffer: makeTimetableWorkbook([
                    ['rule name', 'natural language constraint'],
                    ['Teacher unavailable', 'Math Teacher cannot teach Monday period 1.'],
                ], { sheetName: 'AIConstraints' }),
            },
            project: sampleProject(),
            env: {},
        }),
        error => error instanceof TimetableRuleParseError && error.reason === 'ai_not_configured',
    );
});

test('timetable store persists project data atomically in a local data directory', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-'));
    const store = createTimetableStore({ dataDir });
    const project = sampleProject({ schoolName: '持久化学校' });

    await store.saveProject(project);
    const loaded = await store.loadProject();

    assert.equal(loaded.schoolName, '持久化学校');
    assert.equal(loaded.lessonPlans.length, project.lessonPlans.length);

    const raw = await readFile(path.join(dataDir, 'projects.json'), 'utf8');
    assert.match(raw, /持久化学校/);
});

test('timetable API exposes bootstrap, project save, import and scheduling flow', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
    const previousTimetableTimeout = process.env.TIMETABLE_SOLVER_TIMEOUT;
    const nativeFetch = globalThis.fetch;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-'));
    process.env.TIMEFOLD_SOLVER_URL = 'http://timefold.test';
    process.env.TIMETABLE_SOLVER_TIMEOUT = '2';

    let postedProblem = null;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (!target.startsWith('http://timefold.test')) {
            return nativeFetch(url, options);
        }
        if (options.method === 'POST' && target.endsWith('/timetable-solutions')) {
            postedProblem = JSON.parse(options.body);
            return jsonResponse({ jobId: 'tt-job-1', solverStatus: 'SOLVING_ACTIVE' }, 202);
        }
        if (target.endsWith('/status')) {
            return jsonResponse({ jobId: 'tt-job-1', solverStatus: 'NOT_SOLVING', hardScore: 0, softScore: -4, score: '0hard/-4soft' });
        }
        if (options.method === 'DELETE') {
            return jsonResponse({}, 204);
        }
        return jsonResponse({
            jobId: 'tt-job-1',
            solverStatus: 'NOT_SOLVING',
            hardScore: 0,
            softScore: -4,
            score: '0hard/-4soft',
            lessonAssignments: postedProblem.lessonAssignments.map((assignment, index) => ({
                ...assignment,
                timeSlot: index < 3 ? `1-${index + 1}` : `2-${index - 2}`,
                room: '__NONE__',
            })),
        });
    };

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const bootstrap = await fetch(`${baseUrl}/api/tools/timetable/bootstrap`).then(res => res.json());
        assert.equal(bootstrap.success, true);
        assert.equal(bootstrap.data.project.weekdays, 5);

        const projectRes = await fetch(`${baseUrl}/api/tools/timetable/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schoolName: 'API 学校', weekdays: 5, periodsPerDay: 4 }),
        }).then(res => res.json());
        assert.equal(projectRes.success, true);
        assert.equal(projectRes.data.project.schoolName, 'API 学校');

        const importRes = await fetch(`${baseUrl}/api/tools/timetable/roster/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: '年级,班级,课程,教师,周课时\n七年级,1班,数学,陈老师,3\n七年级,2班,数学,陈老师,3\n',
            }),
        }).then(res => res.json());
        assert.equal(importRes.success, true);
        assert.equal(importRes.data.project.lessonPlans.length, 2);

        const runRes = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, {
            method: 'POST',
        }).then(res => res.json());
        assert.equal(runRes.success, true);
        assert.equal(runRes.data.schedule.source, 'fast_constructed');
        assert.equal(runRes.data.schedule.score.hardConflicts, 0);
        assert.equal(runRes.data.schedule.score.unplacedLessons, 0);
        assert.equal(runRes.data.solverJob?.phase, 'timefold_optimization');
    } finally {
        await new Promise(resolve => server.close(resolve));
        globalThis.fetch = nativeFetch;
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousSolverUrl === undefined) {
            delete process.env.TIMEFOLD_SOLVER_URL;
        } else {
            process.env.TIMEFOLD_SOLVER_URL = previousSolverUrl;
        }
        if (previousTimetableTimeout === undefined) {
            delete process.env.TIMETABLE_SOLVER_TIMEOUT;
        } else {
            process.env.TIMETABLE_SOLVER_TIMEOUT = previousTimetableTimeout;
        }
    }
});

test('timetable roster preview does not save and reviewed rows replace the saved roster', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-roster-review-'));

    const store = createTimetableStore();
    await store.saveProject(sampleProject({
        activeWeekdays: [1, 2, 3, 4],
        activePeriods: [1, 2, 3, 4, 5, 6],
        lessonPlans: [{
            id: 'lp_old',
            classId: 'c1',
            subjectId: 'math',
            teacherId: 't_math',
            weeklyHours: 3,
            blockPreference: 'single',
        }],
        schedule: {
            id: 'old_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [{
                id: 'old_slot',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                lessonPlanId: 'lp_old',
                locked: false,
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 3, completeness: 33 },
        },
    }));

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const previewPayload = await fetch(`${baseUrl}/api/tools/timetable/roster/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: [
                    'grade,class,subject,teacher,hours,block,room',
                    'G8,2,Science,Alice/Bob,4,double,Lab A/Lab B',
                    'G8,2,Art,Alice,2,single,',
                ].join('\n'),
            }),
        }).then(res => res.json());

        assert.equal(previewPayload.success, true);
        assert.equal(previewPayload.data.draftRows.length, 2);
        assert.equal(previewPayload.data.stats.teacherCount, 2);

        const afterPreview = await store.loadProject();
        assert.equal(afterPreview.lessonPlans.length, 1);
        assert.equal(afterPreview.schedule.id, 'old_schedule');

        const importPayload = await fetch(`${baseUrl}/api/tools/timetable/roster/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: previewPayload.data.draftRows }),
        }).then(res => res.json());

        assert.equal(importPayload.success, true);
        assert.equal(importPayload.data.project.lessonPlans.length, 2);
        assert.equal(importPayload.data.project.schedule, null);
        assert.deepEqual(importPayload.data.project.activeWeekdays, [1, 2, 3, 4]);
        assert.equal(importPayload.data.project.subjects.some(subject => subject.name === 'Math'), false);

        const science = importPayload.data.project.lessonPlans.find(plan => plan.subjectName === 'Science');
        assert.deepEqual(science.teacherIds.map(id => importPayload.data.project.teachers.find(teacher => teacher.id === id)?.name), ['Alice', 'Bob']);
        assert.deepEqual(science.allowedRoomIds, ['Lab A', 'Lab B']);
        assert.equal(science.roomId, 'Lab A');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API saves a fast schedule when Timefold is unavailable', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-fail-'));
    delete process.env.TIMEFOLD_SOLVER_URL;

    const store = createTimetableStore();
    const existing = sampleProject({
        schedule: {
            id: 'old_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            slots: [{
                id: 'old_slot',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                lessonPlanId: 'lp1',
                locked: false,
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 11, completeness: 9 },
        },
    });
    await store.saveProject(existing);

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const runResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' });
        const runPayload = await runResponse.json();

        assert.equal(runResponse.status, 200);
        assert.equal(runPayload.success, true);
        assert.equal(runPayload.data.schedule.source, 'fast_constructed');
        assert.equal(runPayload.data.solverJob, null);

        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'fast_constructed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousSolverUrl === undefined) {
            delete process.env.TIMEFOLD_SOLVER_URL;
        } else {
            process.env.TIMEFOLD_SOLVER_URL = previousSolverUrl;
        }
    }
});

test('timetable API keeps saved schedule when fast preflight audit blocks generation', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-audit-block-'));
    delete process.env.TIMEFOLD_SOLVER_URL;

    const store = createTimetableStore();
    const existing = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 1,
        activeWeekdays: [1],
        activePeriods: [1],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'old_capacity_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 2, completeness: 0 },
        },
    });
    await store.saveProject(existing);

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const runResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' });
        const runPayload = await runResponse.json();

        assert.equal(runResponse.status, 422);
        assert.equal(runPayload.success, false);
        assert.equal(runPayload.data.schedule.id, 'old_capacity_schedule');
        assert.equal(runPayload.data.reason, 'insufficient_slots');
        assert.ok(runPayload.data.audit.blockingIssues.some(issue => issue.type === 'class_capacity'));

        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, 'old_capacity_schedule');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousSolverUrl === undefined) {
            delete process.env.TIMEFOLD_SOLVER_URL;
        } else {
            process.env.TIMEFOLD_SOLVER_URL = previousSolverUrl;
        }
    }
});

test('background Timefold timeout keeps the saved fast schedule and exposes job status', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
    const previousTimetableTimeout = process.env.TIMETABLE_SOLVER_TIMEOUT;
    const previousTimefoldTimeout = process.env.TIMEFOLD_SOLVER_TIMEOUT;
    const nativeFetch = globalThis.fetch;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-timeout-'));
    process.env.TIMEFOLD_SOLVER_URL = 'http://timefold.timeout';
    process.env.TIMETABLE_SOLVER_TIMEOUT = '1';
    delete process.env.TIMEFOLD_SOLVER_TIMEOUT;
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const existing = sampleProject({
        schedule: {
            id: 'old_timeout_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            slots: [{
                id: 'old_timeout_slot',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math'],
                lessonPlanId: 'lp1',
                locked: false,
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 11, completeness: 9 },
        },
    });
    await store.saveProject(existing);

    const timeoutError = new Error('request timed out');
    timeoutError.name = 'TimeoutError';
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (!target.startsWith('http://timefold.timeout')) {
            return nativeFetch(url, options);
        }
        throw timeoutError;
    };

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const runResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' });
        const runPayload = await runResponse.json();

        assert.equal(runResponse.status, 200);
        assert.equal(runPayload.success, true);
        assert.equal(runPayload.data.schedule.source, 'fast_constructed');
        assert.equal(runPayload.data.solverJob.phase, 'timefold_optimization');

        const job = await waitFor(() => {
            const current = getTimetableOptimizationJob(runPayload.data.solverJob.jobId);
            return current?.status === 'failed' ? current : null;
        }, 1500);
        assert.equal(job.reason, 'timeout');
        assert.equal(job.accepted, false);

        const jobResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/jobs/${runPayload.data.solverJob.jobId}`).then(res => res.json());
        assert.equal(jobResponse.success, true);
        assert.equal(jobResponse.data.job.status, 'failed');

        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'fast_constructed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        globalThis.fetch = nativeFetch;
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousSolverUrl === undefined) {
            delete process.env.TIMEFOLD_SOLVER_URL;
        } else {
            process.env.TIMEFOLD_SOLVER_URL = previousSolverUrl;
        }
        if (previousTimetableTimeout === undefined) {
            delete process.env.TIMETABLE_SOLVER_TIMEOUT;
        } else {
            process.env.TIMETABLE_SOLVER_TIMEOUT = previousTimetableTimeout;
        }
        if (previousTimefoldTimeout === undefined) {
            delete process.env.TIMEFOLD_SOLVER_TIMEOUT;
        } else {
            process.env.TIMEFOLD_SOLVER_TIMEOUT = previousTimefoldTimeout;
        }
    }
});

test('background Timefold keeps the fast schedule when optimized quality is equal', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-not-better-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(fast);

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            return new Response(JSON.stringify({ jobId: 'same-quality-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/same-quality-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'same-quality-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore,
                score: `0hard/${fast.schedule.score.softScore}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/same-quality-job')) {
            return new Response(JSON.stringify({
                jobId: 'same-quality-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore,
                score: `0hard/${fast.schedule.score.softScore}soft`,
                lessonAssignments: postedProblem.lessonAssignments.map(assignment => ({ ...assignment })),
            }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: fast,
            schedule: fast.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.same', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const completed = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'completed' ? current : null;
        }, 1500);

        assert.equal(completed.accepted, false);
        assert.equal(completed.reason, 'not_better');
        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, fast.schedule.id);
        assert.equal(stored.schedule.source, 'fast_constructed');
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background Timefold preserves published draft metadata when accepting a better schedule', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-accepted-published-draft-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    const publishedDraft = {
        ...fast,
        schedule: {
            ...fast.schedule,
            score: {
                ...fast.schedule.score,
                softScore: Number(fast.schedule.score.softScore || 0) - 1000,
                completeness: Math.max(0, Number(fast.schedule.score.completeness || 0) - 10),
            },
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: fast.schedule.id,
                note: '教务处确认发布',
                snapshot: {
                    scheduleId: fast.schedule.id,
                    generatedAt: fast.schedule.generatedAt,
                    source: fast.schedule.source,
                    slotCount: fast.schedule.slots.length,
                    score: fast.schedule.score,
                    publicationSummary: {
                        totalLessons: fast.schedule.score.totalLessons,
                        placedLessons: fast.schedule.score.placedLessons,
                        unplacedLessons: 0,
                        hardConflicts: 0,
                    },
                    slots: fast.schedule.slots,
                },
                history: [{
                    version: 0,
                    publishedAt: '2026-01-01T08:00:00.000Z',
                    scheduleId: 'previous-published',
                    note: '历史发布版',
                    snapshot: {
                        scheduleId: 'previous-published',
                        generatedAt: fast.schedule.generatedAt,
                        source: 'fast_constructed',
                        slotCount: fast.schedule.slots.length,
                        score: fast.schedule.score,
                        publicationSummary: {
                            totalLessons: fast.schedule.score.totalLessons,
                            placedLessons: fast.schedule.score.placedLessons,
                            unplacedLessons: 0,
                            hardConflicts: 0,
                        },
                        slots: fast.schedule.slots,
                    },
                }],
            },
        },
    };
    await store.saveProject(publishedDraft);

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            return new Response(JSON.stringify({ jobId: 'accepted-draft-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/accepted-draft-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'accepted-draft-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/accepted-draft-job')) {
            return new Response(JSON.stringify({
                jobId: 'accepted-draft-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
                lessonAssignments: postedProblem.lessonAssignments.map(assignment => ({ ...assignment })),
            }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: publishedDraft,
            schedule: publishedDraft.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.accepted-draft', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const completed = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'completed' && current.accepted ? current : null;
        }, 1500);

        assert.equal(completed.accepted, true);
        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'timefold_solver');
        assert.equal(stored.schedule.published.status, 'draft_changed');
        assert.equal(stored.schedule.published.version, 1);
        assert.equal(stored.schedule.published.scheduleId, fast.schedule.id);
        assert.equal(stored.schedule.published.snapshot.scheduleId, fast.schedule.id);
        assert.equal(stored.schedule.published.history.length, 1);
        assert.equal(stored.schedule.solverStats.accepted, true);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background Timefold rejects stale jobs when schedule content changed without id change', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-stale-signature-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(fast);

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            const latest = await store.loadProject();
            await store.saveProject({
                ...latest,
                schedule: {
                    ...latest.schedule,
                    slots: latest.schedule.slots.map((slot, index) => index === 0
                        ? { ...slot, period: slot.period === 1 ? 2 : 1, manuallyAdjusted: true }
                        : slot),
                },
            });
            return new Response(JSON.stringify({ jobId: 'stale-signature-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/stale-signature-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'stale-signature-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/stale-signature-job')) {
            return new Response(JSON.stringify({
                jobId: 'stale-signature-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
                lessonAssignments: postedProblem.lessonAssignments.map(assignment => ({ ...assignment })),
            }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: fast,
            schedule: fast.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.stale', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const skipped = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'skipped' ? current : null;
        }, 1500);

        assert.equal(skipped.accepted, false);
        assert.equal(skipped.reason, 'stale_schedule');
        assert.equal(skipped.solverStats.staleRejected, true);
        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, fast.schedule.id);
        assert.equal(stored.schedule.source, 'fast_constructed');
        assert.equal(stored.schedule.slots.some(slot => slot.manuallyAdjusted), true);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background Timefold does not overwrite a schedule after it has been published', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-published-job-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(fast);

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            const latest = await store.loadProject();
            await store.saveProject({
                ...latest,
                schedule: {
                    ...latest.schedule,
                    published: {
                        status: 'published',
                        version: 1,
                        publishedAt: '2026-01-02T08:00:00.000Z',
                        scheduleId: latest.schedule.id,
                        note: '教务处确认发布',
                    },
                },
            });
            return new Response(JSON.stringify({ jobId: 'published-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/published-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'published-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/published-job')) {
            return new Response(JSON.stringify({
                jobId: 'published-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
                lessonAssignments: postedProblem.lessonAssignments.map(assignment => ({ ...assignment })),
            }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: fast,
            schedule: fast.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.published', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const skipped = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'skipped' ? current : null;
        }, 1500);

        assert.equal(skipped.accepted, false);
        assert.equal(skipped.reason, 'published_schedule');
        assert.equal(skipped.solverStats.staleRejected, true);
        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, fast.schedule.id);
        assert.equal(stored.schedule.source, 'fast_constructed');
        assert.equal(stored.schedule.published.status, 'published');
        assert.equal(stored.schedule.published.version, 1);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API returns the saved schedule and does not persist failed manual adjustments', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-adjust-fail-'));

    const store = createTimetableStore();
    const existing = sampleProject({
        schedule: {
            id: 'adjust_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            slots: [{
                id: 'locked_slot',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math'],
                lessonPlanId: 'lp1',
                locked: true,
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 11, completeness: 9 },
        },
    });
    await store.saveProject(existing);

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const adjustResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'move', slotId: 'locked_slot', day: 2, period: 2 }),
        });
        const payload = await adjustResponse.json();

        assert.equal(adjustResponse.status, 400);
        assert.equal(payload.success, false);
        assert.equal(payload.data.schedule.id, 'adjust_schedule');
        assert.equal(payload.data.reason, 'adjustment_failed');

        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, 'adjust_schedule');
        assert.deepEqual(stored.schedule.slots.map(slot => [slot.id, slot.day, slot.period]), [['locked_slot', 1, 1]]);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable export blocks publishable timetable files when publication validation fails', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-export-guard-'));

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(sampleProject({
        schedule: {
            ...fast.schedule,
            slots: fast.schedule.slots.slice(0, -1),
            unplaced: [{ lessonPlanId: 'lp4', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', reason: 'missing slot' }],
            conflicts: [],
            score: { ...fast.schedule.score, placedLessons: 10, unplacedLessons: 1, completeness: 91 },
        },
    }));

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });
        const payload = await response.json();

        assert.equal(response.status, 422);
        assert.equal(payload.success, false);
        assert.equal(payload.data.reason, 'publication_blocked');
        assert.ok(payload.data.publication.blockingIssues.some(issue => issue.type === 'incomplete_schedule'));

        const plansResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'plans' }),
        });

        assert.equal(plansResponse.status, 200);
        assert.match(plansResponse.headers.get('content-type') || '', /spreadsheetml/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable export blocks official files until the schedule is published', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-export-unpublished-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            published: null,
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });
        const payload = await response.json();

        assert.equal(response.status, 422);
        assert.equal(payload.success, false);
        assert.equal(payload.data.reason, 'publication_required');
        assert.match(payload.error, /请先发布课表/);

        const plansResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'plans' }),
        });

        assert.equal(plansResponse.status, 200);
        assert.match(plansResponse.headers.get('content-type') || '', /spreadsheetml/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable export blocks official files when the published schedule has draft changes', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-export-draft-changed-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '教务处确认发布',
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    slotCount: readyProject.schedule.slots.length,
                    slots: readyProject.schedule.slots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });
        const payload = await response.json();

        assert.equal(response.status, 422);
        assert.equal(payload.success, false);
        assert.equal(payload.data.reason, 'publication_draft_changed');
        assert.equal(payload.data.schedule.published.status, 'draft_changed');

        const plansResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'plans' }),
        });

        assert.equal(plansResponse.status, 200);
        assert.match(plansResponse.headers.get('content-type') || '', /spreadsheetml/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable export blocks official files when published status drifts from the snapshot', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-export-published-drift-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const snapshotSlots = readyProject.schedule.slots.map(slot => ({ ...slot }));
    const driftSlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, day: slot.day === 1 ? 2 : 1, manuallyAdjusted: true }
        : slot);
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            slots: driftSlots,
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '教务处确认发布',
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: snapshotSlots.length,
                    slots: snapshotSlots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });
        const payload = await response.json();

        assert.equal(response.status, 422);
        assert.equal(payload.success, false);
        assert.equal(payload.data.reason, 'publication_draft_changed');
        assert.equal(payload.data.schedule.published.status, 'draft_changed');
        assert.match(payload.error, /当前课表已改动/);

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.status, 'draft_changed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable export can emit the last published snapshot after draft changes', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-export-published-snapshot-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const snapshotSlots = readyProject.schedule.slots.map(slot => ({ ...slot }));
    const draftSlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, subjectId: 'draft_subject', teacherId: 'draft_teacher', teacherIds: ['draft_teacher'] }
        : slot);
    await store.saveProject({
        ...readyProject,
        subjects: [
            ...readyProject.subjects,
            { id: 'draft_subject', name: '草稿课程', priority: 10, color: '#999999' },
        ],
        teachers: [
            ...readyProject.teachers,
            { id: 'draft_teacher', name: '草稿老师', subjects: ['draft_subject'], unavailableSlots: [] },
        ],
        schedule: {
            ...readyProject.schedule,
            slots: draftSlots,
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '教务处确认发布',
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: snapshotSlots.length,
                    slots: snapshotSlots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'published_class' }),
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const workbook = new AdmZip(buffer);
        const combined = workbook.getEntries()
            .filter(entry => entry.entryName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
            .map(entry => workbook.readAsText(entry))
            .join('\n');

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition') || '', /%E5%B7%B2%E5%8F%91%E5%B8%83/);
        assert.match(combined, /发布信息/);
        assert.match(combined, /已发布/);
        assert.match(combined, /发布指纹/);
        assert.match(combined, /[a-f0-9]{64}/);
        assert.doesNotMatch(combined, /草稿已变化/);
        assert.match(combined, /数学|语文|体育/);
        assert.doesNotMatch(combined, /草稿课程/);
        assert.doesNotMatch(combined, /草稿老师/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API backfills missing current published snapshot during published snapshot export', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-published-export-missing-snapshot-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: 'legacy published without snapshot',
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const exportResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'published_class' }),
        });

        assert.equal(exportResponse.status, 200);
        assert.match(exportResponse.headers.get('content-disposition') || '', /%E5%B7%B2%E5%8F%91%E5%B8%83/);

        const buffer = Buffer.from(await exportResponse.arrayBuffer());
        const workbook = new AdmZip(buffer);
        const combined = workbook.getEntries()
            .filter(entry => entry.entryName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
            .map(entry => workbook.readAsText(entry))
            .join('\n');

        assert.match(combined, /legacy published without snapshot/);
        assert.match(combined, /[a-f0-9]{64}/);

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.status, 'published');
        assert.match(stored.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(stored.schedule.published.snapshot.fingerprint, stored.schedule.published.fingerprint);
        assert.equal(stored.schedule.published.snapshot.slots.length, readyProject.schedule.slots.length);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable export can emit a selected published history version', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-export-history-snapshot-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const historySlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, subjectId: 'history_subject', teacherId: 'history_teacher', teacherIds: ['history_teacher'] }
        : slot);
    const latestSlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, subjectId: 'latest_subject', teacherId: 'latest_teacher', teacherIds: ['latest_teacher'] }
        : slot);
    await store.saveProject({
        ...readyProject,
        subjects: [
            ...readyProject.subjects,
            { id: 'history_subject', name: '历史版本课程', priority: 10, color: '#777777' },
            { id: 'latest_subject', name: '最新发布课程', priority: 10, color: '#999999' },
        ],
        teachers: [
            ...readyProject.teachers,
            { id: 'history_teacher', name: '历史版本教师', subjects: ['history_subject'], unavailableSlots: [] },
            { id: 'latest_teacher', name: '最新发布教师', subjects: ['latest_subject'], unavailableSlots: [] },
        ],
        schedule: {
            ...readyProject.schedule,
            slots: latestSlots,
            published: {
                status: 'draft_changed',
                version: 2,
                publishedAt: '2026-01-03T08:00:00.000Z',
                scheduleId: 'latest-published',
                note: '第二次发布',
                snapshot: {
                    scheduleId: 'latest-published',
                    generatedAt: '2026-01-03T00:00:00.000Z',
                    source: 'timefold_solver',
                    slotCount: latestSlots.length,
                    slots: latestSlots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
                history: [{
                    version: 1,
                    publishedAt: '2026-01-02T08:00:00.000Z',
                    scheduleId: 'history-published',
                    note: '第一次发布',
                    snapshot: {
                        scheduleId: 'history-published',
                        generatedAt: '2026-01-02T00:00:00.000Z',
                        source: 'fast_constructed',
                        slotCount: historySlots.length,
                        slots: historySlots,
                        score: readyProject.schedule.score,
                        publicationSummary: readyProject.schedule.publication?.summary || {},
                    },
                }],
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'published_class', publishedVersion: 1 }),
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const workbook = new AdmZip(buffer);
        const combined = workbook.getEntries()
            .filter(entry => entry.entryName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
            .map(entry => workbook.readAsText(entry))
            .join('\n');

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition') || '', /V1/);
        assert.match(combined, /发布信息/);
        assert.match(combined, /V1/);
        assert.match(combined, /第一次发布/);
        assert.match(combined, /2026-01-02T08:00:00.000Z/);
        assert.match(combined, /发布指纹/);
        assert.match(combined, /[a-f0-9]{64}/);
        assert.match(combined, /历史版本课程/);
        assert.match(combined, /历史版本教师/);
        assert.doesNotMatch(combined, /V2/);
        assert.doesNotMatch(combined, /第二次发布/);
        assert.doesNotMatch(combined, /2026-01-03T08:00:00.000Z/);
        assert.doesNotMatch(combined, /最新发布课程/);
        assert.doesNotMatch(combined, /最新发布教师/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API rejects published snapshot export and restore when fingerprint mismatches', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-fingerprint-mismatch-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const snapshotSlots = readyProject.schedule.slots.map(slot => ({ ...slot }));
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'manual_adjusted',
            slots: readyProject.schedule.slots.map((slot, index) => index === 0
                ? { ...slot, day: slot.day === 1 ? 2 : 1, manuallyAdjusted: true }
                : slot),
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '被篡改的发布快照',
                fingerprint: '0'.repeat(64),
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: snapshotSlots.length,
                    fingerprint: '0'.repeat(64),
                    slots: snapshotSlots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const exportResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'published_class' }),
        });
        const exportPayload = await exportResponse.json();

        assert.equal(exportResponse.status, 409);
        assert.equal(exportPayload.success, false);
        assert.equal(exportPayload.data.reason, 'publication_fingerprint_mismatch');
        assert.match(exportPayload.error, /发布快照校验失败/);
        assert.match(exportPayload.data.fingerprint.actual, /^[a-f0-9]{64}$/);
        assert.equal(exportPayload.data.fingerprint.expected, '0'.repeat(64));

        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 409);
        assert.equal(restorePayload.success, false);
        assert.equal(restorePayload.data.reason, 'publication_fingerprint_mismatch');
        assert.match(restorePayload.error, /发布快照校验失败/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API rejects official export when current published snapshot fingerprint mismatches', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-official-fingerprint-mismatch-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const snapshotSlots = readyProject.schedule.slots.map(slot => ({ ...slot }));
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '指纹异常的正式发布版',
                fingerprint: '0'.repeat(64),
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: snapshotSlots.length,
                    fingerprint: '0'.repeat(64),
                    slots: snapshotSlots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const exportResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });

        assert.equal(exportResponse.status, 409);
        const exportPayload = await exportResponse.json();
        assert.equal(exportPayload.success, false);
        assert.equal(exportPayload.data.reason, 'publication_fingerprint_mismatch');
        assert.match(exportPayload.error, /发布快照校验失败/);
        assert.equal(exportPayload.data.fingerprint.expected, '0'.repeat(64));
        assert.match(exportPayload.data.fingerprint.actual, /^[a-f0-9]{64}$/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API backfills legacy current published fingerprint during official export without marking draft changed', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-official-legacy-fingerprint-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const snapshotSlots = readyProject.schedule.slots.map(slot => ({ ...slot }));
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '旧版正式发布版',
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: snapshotSlots.length,
                    slots: snapshotSlots,
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const exportResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });
        const buffer = Buffer.from(await exportResponse.arrayBuffer());
        const workbook = new AdmZip(buffer);
        const combined = workbook.getEntries()
            .filter(entry => entry.entryName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
            .map(entry => workbook.readAsText(entry))
            .join('\n');

        assert.equal(exportResponse.status, 200);
        assert.match(combined, /发布信息/);
        assert.match(combined, /已发布/);
        assert.doesNotMatch(combined, /草稿已变化/);
        assert.match(combined, /发布指纹/);
        assert.match(combined, /[a-f0-9]{64}/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API backfills missing current published snapshot during official export', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-official-missing-snapshot-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '旧版缺快照发布版',
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const exportResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'class' }),
        });
        const buffer = Buffer.from(await exportResponse.arrayBuffer());
        const workbook = new AdmZip(buffer);
        const combined = workbook.getEntries()
            .filter(entry => entry.entryName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
            .map(entry => workbook.readAsText(entry))
            .join('\n');

        assert.equal(exportResponse.status, 200);
        assert.match(combined, /发布信息/);
        assert.match(combined, /已发布/);
        assert.match(combined, /发布指纹/);
        assert.match(combined, /[a-f0-9]{64}/);
        assert.doesNotMatch(combined, /草稿已变化/);

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.status, 'published');
        assert.match(stored.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(stored.schedule.published.snapshot.fingerprint, stored.schedule.published.fingerprint);
        assert.equal(stored.schedule.published.snapshot.slots.length, readyProject.schedule.slots.length);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API republish repairs a bad current published snapshot without archiving it', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-republish-bad-fingerprint-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const currentSlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, manuallyAdjusted: true }
        : { ...slot });
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'manual_adjusted',
            slots: currentSlots,
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '指纹异常的旧发布版',
                fingerprint: '0'.repeat(64),
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: readyProject.schedule.slots.length,
                    fingerprint: '0'.repeat(64),
                    slots: readyProject.schedule.slots.map(slot => ({ ...slot })),
                    score: readyProject.schedule.score,
                    publicationSummary: readyProject.schedule.publication?.summary || {},
                },
                history: [],
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const republishResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: '重新发布修复快照' }),
        });
        const republishPayload = await republishResponse.json();

        assert.equal(republishResponse.status, 200);
        assert.equal(republishPayload.success, true);
        assert.equal(republishPayload.data.schedule.published.status, 'published');
        assert.equal(republishPayload.data.schedule.published.version, 2);
        assert.equal((republishPayload.data.schedule.published.history || []).length, 0);
        assert.doesNotMatch(
            JSON.stringify(republishPayload.data.schedule.publication),
            /publication_fingerprint_mismatch/,
        );

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.version, 2);
        assert.equal((stored.schedule.published.history || []).length, 0);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API republish archives a legacy current published version that is missing its snapshot', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-republish-missing-snapshot-history-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: 'legacy published without snapshot',
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const republishResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'republished after snapshot repair' }),
        });
        const republishPayload = await republishResponse.json();

        assert.equal(republishResponse.status, 200);
        assert.equal(republishPayload.success, true);
        assert.equal(republishPayload.data.schedule.published.status, 'published');
        assert.equal(republishPayload.data.schedule.published.version, 2);
        assert.equal(republishPayload.data.schedule.published.note, 'republished after snapshot repair');
        assert.equal(republishPayload.data.schedule.published.history.length, 1);
        assert.equal(republishPayload.data.schedule.published.history[0].version, 1);
        assert.equal(republishPayload.data.schedule.published.history[0].note, 'legacy published without snapshot');
        assert.match(republishPayload.data.schedule.published.history[0].fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(
            republishPayload.data.schedule.published.history[0].snapshot.fingerprint,
            republishPayload.data.schedule.published.history[0].fingerprint,
        );
        assert.equal(
            republishPayload.data.schedule.published.history[0].snapshot.slots.length,
            readyProject.schedule.slots.length,
        );

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.version, 2);
        assert.equal(stored.schedule.published.history.length, 1);
        assert.equal(stored.schedule.published.history[0].version, 1);
        assert.equal(stored.schedule.published.history[0].note, 'legacy published without snapshot');
        assert.match(stored.schedule.published.history[0].fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(
            stored.schedule.published.history[0].snapshot.fingerprint,
            stored.schedule.published.history[0].fingerprint,
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API republish backfills fingerprints for legacy published snapshots', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-republish-legacy-fingerprint-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const legacySnapshot = {
        scheduleId: readyProject.schedule.id,
        generatedAt: readyProject.schedule.generatedAt,
        source: readyProject.schedule.source,
        slotCount: readyProject.schedule.slots.length,
        slots: readyProject.schedule.slots.map(slot => ({ ...slot })),
        score: readyProject.schedule.score,
        publicationSummary: readyProject.schedule.publication?.summary || {},
    };
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'manual_adjusted',
            slots: readyProject.schedule.slots.map((slot, index) => index === 0
                ? { ...slot, manuallyAdjusted: true }
                : { ...slot }),
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '旧版发布快照',
                snapshot: legacySnapshot,
                history: [],
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const republishResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: '新版发布' }),
        });
        const republishPayload = await republishResponse.json();
        const historyEntry = republishPayload.data.schedule.published.history[0];

        assert.equal(republishResponse.status, 200);
        assert.equal(republishPayload.success, true);
        assert.equal(republishPayload.data.schedule.published.version, 2);
        assert.equal(republishPayload.data.schedule.published.history.length, 1);
        assert.match(historyEntry.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(historyEntry.snapshot.fingerprint, historyEntry.fingerprint);
        assert.equal(historyEntry.snapshot.scheduleId, legacySnapshot.scheduleId);

        const stored = await store.loadProject();
        assert.match(stored.schedule.published.history[0].fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(
            stored.schedule.published.history[0].snapshot.fingerprint,
            stored.schedule.published.history[0].fingerprint,
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API publishes a validated schedule and invalidates publication after manual changes', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-publish-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(readyProject);

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const publishResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: '教务处确认发布' }),
        });
        const publishPayload = await publishResponse.json();

        assert.equal(publishResponse.status, 200);
        assert.equal(publishPayload.success, true);
        assert.equal(publishPayload.data.schedule.published.status, 'published');
        assert.equal(publishPayload.data.schedule.published.version, 1);
        assert.equal(publishPayload.data.schedule.published.note, '教务处确认发布');
        assert.equal(publishPayload.data.schedule.published.scheduleId, readyProject.schedule.id);
        assert.equal(publishPayload.data.schedule.published.snapshot.scheduleId, readyProject.schedule.id);
        assert.equal(publishPayload.data.schedule.published.snapshot.slotCount, readyProject.schedule.slots.length);
        assert.equal(publishPayload.data.schedule.published.snapshot.slots.length, readyProject.schedule.slots.length);
        assert.equal(publishPayload.data.schedule.published.snapshot.score.completeness, readyProject.schedule.score.completeness);
        assert.match(publishPayload.data.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(
            publishPayload.data.schedule.published.snapshot.fingerprint,
            publishPayload.data.schedule.published.fingerprint,
        );

        const storedPublished = await store.loadProject();
        assert.equal(storedPublished.schedule.published.status, 'published');
        assert.equal(storedPublished.schedule.published.snapshot.slots.length, readyProject.schedule.slots.length);
        assert.equal(storedPublished.schedule.published.fingerprint, publishPayload.data.schedule.published.fingerprint);

        const slot = storedPublished.schedule.slots.find(item => !item.locked);
        const adjustResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'lock', slotId: slot.id, locked: true }),
        });
        const adjustPayload = await adjustResponse.json();

        assert.equal(adjustResponse.status, 200);
        assert.equal(adjustPayload.data.schedule.source, 'manual_adjusted');
        assert.equal(adjustPayload.data.schedule.published.status, 'draft_changed');
        assert.equal(adjustPayload.data.schedule.published.version, 1);
        assert.equal(adjustPayload.data.schedule.published.snapshot.scheduleId, readyProject.schedule.id);
        assert.equal(adjustPayload.data.schedule.published.snapshot.slots.length, readyProject.schedule.slots.length);
        assert.deepEqual(
            adjustPayload.data.schedule.published.snapshot.slots,
            publishPayload.data.schedule.published.snapshot.slots,
        );

        const republishResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: '第二次发布' }),
        });
        const republishPayload = await republishResponse.json();

        assert.equal(republishResponse.status, 200);
        assert.equal(republishPayload.data.schedule.published.status, 'published');
        assert.equal(republishPayload.data.schedule.published.version, 2);
        assert.equal(republishPayload.data.schedule.published.note, '第二次发布');
        assert.equal(republishPayload.data.schedule.published.history.length, 1);
        assert.equal(republishPayload.data.schedule.published.history[0].version, 1);
        assert.equal(republishPayload.data.schedule.published.history[0].note, '教务处确认发布');
        assert.equal(
            republishPayload.data.schedule.published.history[0].fingerprint,
            publishPayload.data.schedule.published.fingerprint,
        );
        assert.equal(
            republishPayload.data.schedule.published.history[0].snapshot.fingerprint,
            publishPayload.data.schedule.published.fingerprint,
        );
        assert.equal(republishPayload.data.schedule.published.history[0].snapshot.scheduleId, readyProject.schedule.id);
        assert.deepEqual(
            republishPayload.data.schedule.published.history[0].snapshot.slots,
            publishPayload.data.schedule.published.snapshot.slots,
        );

        const invalidProject = sampleProject({
            schedule: {
                ...readyProject.schedule,
                slots: readyProject.schedule.slots.slice(0, -1),
                unplaced: [{ lessonPlanId: 'lp4', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', reason: 'missing slot' }],
                conflicts: [],
                score: { ...readyProject.schedule.score, placedLessons: 10, unplacedLessons: 1, completeness: 91 },
            },
        });
        await store.saveProject(invalidProject);

        const blockedResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'should fail' }),
        });
        const blockedPayload = await blockedResponse.json();

        assert.equal(blockedResponse.status, 422);
        assert.equal(blockedPayload.success, false);
        assert.equal(blockedPayload.data.reason, 'publication_blocked');
        assert.ok(blockedPayload.data.publication.blockingIssues.some(issue => issue.type === 'incomplete_schedule'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API restores a published history version into the current draft', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-restore-history-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const currentSlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, day: slot.day === 1 ? 2 : 1, period: slot.period === 1 ? 2 : 1, manuallyAdjusted: true }
        : slot);
    const historySlots = readyProject.schedule.slots.map(slot => ({ ...slot, locked: Boolean(slot.locked), manuallyAdjusted: false }));
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            id: 'current-after-publish',
            source: 'manual_adjusted',
            slots: currentSlots,
            solverStats: {
                phase: 'timefold_optimization',
                status: 'running',
                jobId: 'stale-optimization-job',
                accepted: false,
                reason: 'not_better',
            },
            published: {
                status: 'published',
                version: 2,
                publishedAt: '2026-01-03T08:00:00.000Z',
                scheduleId: 'current-after-publish',
                note: '第二次发布',
                snapshot: {
                    scheduleId: 'current-after-publish',
                    generatedAt: '2026-01-03T00:00:00.000Z',
                    source: 'manual_adjusted',
                    slotCount: currentSlots.length,
                    score: readyProject.schedule.score,
                    publicationSummary: { totalLessons: currentSlots.length, placedLessons: currentSlots.length, unplacedLessons: 0, hardConflicts: 0 },
                    slots: currentSlots,
                },
                history: [{
                    version: 1,
                    publishedAt: '2026-01-02T08:00:00.000Z',
                    scheduleId: readyProject.schedule.id,
                    note: '第一次发布',
                    snapshot: {
                        scheduleId: readyProject.schedule.id,
                        generatedAt: readyProject.schedule.generatedAt,
                        source: 'fast_constructed',
                        slotCount: historySlots.length,
                        score: readyProject.schedule.score,
                        publicationSummary: { totalLessons: historySlots.length, placedLessons: historySlots.length, unplacedLessons: 0, hardConflicts: 0 },
                        slots: historySlots,
                    },
                }],
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: 1 }),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200);
        assert.equal(restorePayload.success, true);
        assert.equal(restorePayload.data.restoredVersion, 1);
        assert.equal(restorePayload.data.schedule.source, 'published_history_restored');
        assert.equal(restorePayload.data.schedule.solverStats.phase, 'published_history_restore');
        assert.equal(restorePayload.data.schedule.solverStats.status, 'restored');
        assert.equal(restorePayload.data.schedule.solverStats.accepted, true);
        assert.equal(restorePayload.data.schedule.solverStats.jobId, undefined);
        assert.equal(restorePayload.data.schedule.published.status, 'draft_changed');
        assert.equal(restorePayload.data.schedule.published.version, 2);
        assert.equal(restorePayload.data.schedule.published.history.length, 1);
        assert.equal(restorePayload.data.schedule.slots.length, historySlots.length);
        assert.deepEqual(
            restorePayload.data.schedule.slots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
            historySlots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
        );

        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'published_history_restored');
        assert.equal(stored.schedule.solverStats.phase, 'published_history_restore');
        assert.equal(stored.schedule.solverStats.status, 'restored');
        assert.equal(stored.schedule.published.status, 'draft_changed');

        const republishResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: '恢复后重新发布' }),
        });
        const republishPayload = await republishResponse.json();

        assert.equal(republishResponse.status, 200);
        assert.equal(republishPayload.data.schedule.published.status, 'published');
        assert.equal(republishPayload.data.schedule.published.version, 3);
        assert.equal(republishPayload.data.schedule.published.note, '恢复后重新发布');
        assert.equal(
            republishPayload.data.schedule.publication.warnings.some(issue => issue.type === 'restored_published_draft'),
            false,
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API restores the latest published snapshot into the current draft', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-restore-latest-published-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const draftSlots = readyProject.schedule.slots.map((slot, index) => index === 0
        ? { ...slot, day: slot.day === 1 ? 2 : 1, period: slot.period === 1 ? 2 : 1, manuallyAdjusted: true }
        : slot);
    const publishedSlots = readyProject.schedule.slots.map(slot => ({ ...slot, manuallyAdjusted: false }));
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            id: 'draft-after-publish',
            source: 'manual_adjusted',
            slots: draftSlots,
            published: {
                status: 'draft_changed',
                version: 3,
                publishedAt: '2026-01-05T08:00:00.000Z',
                scheduleId: 'latest-published-schedule',
                note: '最新发布版',
                snapshot: {
                    scheduleId: 'latest-published-schedule',
                    generatedAt: '2026-01-05T00:00:00.000Z',
                    source: 'timefold_solver',
                    slotCount: publishedSlots.length,
                    score: readyProject.schedule.score,
                    publicationSummary: { totalLessons: publishedSlots.length, placedLessons: publishedSlots.length, unplacedLessons: 0, hardConflicts: 0 },
                    slots: publishedSlots,
                },
                history: [],
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200);
        assert.equal(restorePayload.success, true);
        assert.equal(restorePayload.data.restoredVersion, 3);
        assert.equal(restorePayload.data.schedule.source, 'published_history_restored');
        assert.equal(restorePayload.data.schedule.published.status, 'draft_changed');
        assert.equal(restorePayload.data.schedule.published.version, 3);
        assert.deepEqual(
            restorePayload.data.schedule.slots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
            publishedSlots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
        );

        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'published_history_restored');
        assert.equal(stored.schedule.published.status, 'draft_changed');
        assert.deepEqual(
            stored.schedule.slots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
            publishedSlots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
        );
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API backfills missing current published snapshot during latest published restore', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-restore-missing-published-snapshot-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'published',
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-05T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: 'legacy published without snapshot',
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200);
        assert.equal(restorePayload.success, true);
        assert.equal(restorePayload.data.restoredVersion, 1);
        assert.equal(restorePayload.data.schedule.source, 'published_history_restored');
        assert.equal(restorePayload.data.schedule.published.status, 'draft_changed');
        assert.match(restorePayload.data.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(
            restorePayload.data.schedule.published.snapshot.fingerprint,
            restorePayload.data.schedule.published.fingerprint,
        );
        assert.deepEqual(
            restorePayload.data.schedule.slots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
            readyProject.schedule.slots.map(slot => [slot.lessonPlanId, slot.day, slot.period]),
        );

        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'published_history_restored');
        assert.equal(stored.schedule.published.status, 'draft_changed');
        assert.match(stored.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(stored.schedule.published.snapshot.fingerprint, stored.schedule.published.fingerprint);
        assert.equal(stored.schedule.published.snapshot.slots.length, readyProject.schedule.slots.length);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API explains missing published snapshot when restoring a changed draft without a saved published snapshot', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-restore-draft-changed-missing-published-snapshot-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            source: 'manual_adjusted',
            slots: readyProject.schedule.slots.map((slot, index) => index === 0
                ? { ...slot, day: slot.day === 1 ? 2 : 1, manuallyAdjusted: true }
                : slot),
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-05T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: 'draft changed but snapshot missing',
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 422);
        assert.equal(restorePayload.success, false);
        assert.equal(restorePayload.data.reason, 'published_snapshot_missing');
        assert.match(restorePayload.error, /\u53d1\u5e03\u5feb\u7167/);
        assert.equal(restorePayload.data.schedule.published.status, 'draft_changed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API restore backfills fingerprints for legacy published snapshots', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-restore-legacy-fingerprint-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const publishedSlots = readyProject.schedule.slots.map(slot => ({ ...slot, manuallyAdjusted: false }));
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            id: 'legacy-draft-after-publish',
            source: 'manual_adjusted',
            slots: readyProject.schedule.slots.map((slot, index) => index === 0
                ? { ...slot, manuallyAdjusted: true }
                : { ...slot }),
            published: {
                status: 'draft_changed',
                version: 1,
                publishedAt: '2026-01-05T08:00:00.000Z',
                scheduleId: 'legacy-published-schedule',
                note: '旧版发布版',
                snapshot: {
                    scheduleId: 'legacy-published-schedule',
                    generatedAt: '2026-01-05T00:00:00.000Z',
                    source: 'fast_constructed',
                    slotCount: publishedSlots.length,
                    score: readyProject.schedule.score,
                    publicationSummary: { totalLessons: publishedSlots.length, placedLessons: publishedSlots.length, unplacedLessons: 0, hardConflicts: 0 },
                    slots: publishedSlots,
                },
                history: [],
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200);
        assert.equal(restorePayload.success, true);
        assert.match(restorePayload.data.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(
            restorePayload.data.schedule.published.snapshot.fingerprint,
            restorePayload.data.schedule.published.fingerprint,
        );

        const stored = await store.loadProject();
        assert.match(stored.schedule.published.fingerprint, /^[a-f0-9]{64}$/);
        assert.equal(stored.schedule.published.snapshot.fingerprint, stored.schedule.published.fingerprint);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API marks a published schedule as changed after regeneration', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-publish-regenerate-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            published: {
                status: 'published',
                version: 1,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '教务处确认发布',
            },
        },
    });

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const runResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' });
        const runPayload = await runResponse.json();

        assert.equal(runResponse.status, 200);
        assert.equal(runPayload.success, true);
        assert.equal(runPayload.data.schedule.source, 'fast_constructed');
        assert.equal(runPayload.data.schedule.published.status, 'draft_changed');
        assert.equal(runPayload.data.schedule.published.version, 1);
        assert.equal(runPayload.data.schedule.published.note, '教务处确认发布');

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.status, 'draft_changed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable API clears roster data while preserving active timetable range', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-clear-'));

    const store = createTimetableStore();
    await store.saveProject(sampleProject({
        activeWeekdays: [1, 3, 5],
        activePeriods: [1, 4, 7],
        schedule: {
            id: 'clear_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            slots: [{
                id: 'clear_slot',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math'],
                lessonPlanId: 'lp1',
                locked: false,
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 1, totalLessons: 11, completeness: 9 },
        },
    }));

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/roster/clear`, { method: 'POST' });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.project.activeWeekdays, [1, 3, 5]);
        assert.deepEqual(payload.data.project.activePeriods, [1, 4, 7]);
        assert.equal(payload.data.project.teachers.length, 0);
        assert.equal(payload.data.project.classes.length, 0);
        assert.equal(payload.data.project.subjects.length, 0);
        assert.equal(payload.data.project.lessonPlans.length, 0);
        assert.equal(payload.data.project.schedule, null);
        assert.deepEqual(payload.data.project.rules.hardRules.teacherUnavailable, {});
        assert.deepEqual(payload.data.project.rules.hardRules.classUnavailable, {});
        assert.deepEqual(payload.data.project.rules.hardRules.lockedSlots, []);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable rules parse API returns an editable AI draft without saving it', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousApiKey = process.env.DEEPSEEK_API_KEY;
    const previousApiBase = process.env.DEEPSEEK_API_BASE;
    const nativeFetch = globalThis.fetch;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-rules-ai-'));
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.DEEPSEEK_API_BASE = 'http://ai.test';

    const store = createTimetableStore();
    await store.saveProject(createDefaultTimetableProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 }],
        rules: { hardRules: {}, softRules: {} },
    }));

    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (!target.startsWith('http://ai.test')) return nativeFetch(url, options);
        return jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        constraints: [
                            {
                                type: 'teacher_unavailable',
                                targetId: 't_math',
                                slots: ['3-4'],
                                priority: 'hard',
                                reason: 'Teacher request',
                            },
                            {
                                type: 'subject_morning',
                                targetId: 'math',
                                priority: 'soft',
                                reason: 'Core subject',
                            },
                        ],
                    }),
                },
            }],
        });
    };

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/rules/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Math Teacher Wednesday period 4 unavailable, Math in morning.' }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.draftRules.hardRules.teacherUnavailable.t_math, ['3-4']);
        assert.deepEqual(payload.data.draftRules.softRules.morningSubjects, ['math']);
        assert.equal(payload.data.previewItems.length, 2);
        assert.equal(payload.data.source, 'ai');

        const storedBeforeConfirm = await store.loadProject();
        assert.deepEqual(storedBeforeConfirm.rules.hardRules.teacherUnavailable, {});

        const confirmResponse = await fetch(`${baseUrl}/api/tools/timetable/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: payload.data.draftRules }),
        });
        const confirmed = await confirmResponse.json();
        assert.equal(confirmResponse.status, 200);
        assert.deepEqual(confirmed.data.project.rules.hardRules.teacherUnavailable.t_math, ['3-4']);
    } finally {
        await new Promise(resolve => server.close(resolve));
        globalThis.fetch = nativeFetch;
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousApiKey === undefined) {
            delete process.env.DEEPSEEK_API_KEY;
        } else {
            process.env.DEEPSEEK_API_KEY = previousApiKey;
        }
        if (previousApiBase === undefined) {
            delete process.env.DEEPSEEK_API_BASE;
        } else {
            process.env.DEEPSEEK_API_BASE = previousApiBase;
        }
    }
});

test('timetable rules parse API accepts multipart Excel without saving the draft', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousApiKey = process.env.DEEPSEEK_API_KEY;
    const previousApiBase = process.env.DEEPSEEK_API_BASE;
    const nativeFetch = globalThis.fetch;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-rules-xlsx-'));
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.DEEPSEEK_API_BASE = 'http://ai.test';

    const store = createTimetableStore();
    await store.saveProject(sampleProject({
        rules: { hardRules: {}, softRules: {} },
    }));

    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (!target.startsWith('http://ai.test')) return nativeFetch(url, options);
        return jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        constraints: [
                            { type: 'subject_preferred_periods', targetId: 'math', slots: ['2-1'], priority: 'soft', reason: 'Prefer Monday' },
                        ],
                    }),
                },
            }],
        });
    };

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const form = new FormData();
        form.append('file', new Blob([makeTimetableWorkbook([
            ['rule name', 'natural language constraint'],
            ['Math preferred', 'Math should prefer Tuesday period 1.'],
        ], { sheetName: 'AIConstraints' })]), 'constraints.xlsx');

        const response = await fetch(`${baseUrl}/api/tools/timetable/rules/parse`, {
            method: 'POST',
            body: form,
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.inputType, 'xlsx_constraints');
        assert.deepEqual(payload.data.draftRules.softRules.subjectPreferredPeriods.math.prefer, ['2-1']);

        const stored = await store.loadProject();
        assert.deepEqual(stored.rules.softRules.subjectPreferredPeriods || {}, {});
    } finally {
        await new Promise(resolve => server.close(resolve));
        globalThis.fetch = nativeFetch;
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
        if (previousApiKey === undefined) {
            delete process.env.DEEPSEEK_API_KEY;
        } else {
            process.env.DEEPSEEK_API_KEY = previousApiKey;
        }
        if (previousApiBase === undefined) {
            delete process.env.DEEPSEEK_API_BASE;
        } else {
            process.env.DEEPSEEK_API_BASE = previousApiBase;
        }
    }
});

test('timetable rules normalize API converts review rows without saving rules', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-rules-normalize-'));

    const store = createTimetableStore();
    await store.saveProject(createDefaultTimetableProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    }));

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/rules/normalize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                draftRows: [{
                    id: 'review_1',
                    type: 'teacher_unavailable',
                    targetType: 'teacher',
                    targetId: 't_math',
                    targetName: 'Math Teacher',
                    slots: ['3-4'],
                    priority: 'hard',
                    status: 'effective',
                }, {
                    id: 'review_2',
                    type: 'teacher_load_balance',
                    targetName: 'All teachers',
                    priority: 'soft',
                    status: 'suggestion',
                }],
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(payload.data.draftRules.hardRules.teacherUnavailable.t_math, ['3-4']);
        assert.equal(payload.data.draftRows.find(row => row.id === 'review_2').status, 'suggestion');

        const stored = await store.loadProject();
        assert.deepEqual(stored.rules.hardRules.teacherUnavailable, {});
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return status === 204 ? '' : JSON.stringify(payload);
        },
    };
}
