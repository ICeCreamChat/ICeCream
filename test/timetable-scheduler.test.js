import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { createGatewayApp } from '../gateway/app.js';
import {
    detectScheduleConflicts,
    summarizeScheduleConflicts,
} from '../gateway/services/timetable-conflicts.js';
import {
    parseTimetableRosterText,
    previewTimetableRosterFile,
} from '../gateway/services/timetable-import.js';
import {
    createTimetableOptimizationJob,
    getTimetableOptimizationJob,
    resetTimetableOptimizationJobs,
} from '../gateway/services/timetable-optimization-jobs.js';
import { buildPublishedSnapshot } from '../gateway/services/timetable-publication.js';
import {
    applyTimetableConstraintFulfillmentAction,
    evaluateTimetableConstraintFulfillment,
} from '../gateway/services/timetable-constraint-fulfillment.js';
import { buildTimetableProblem } from '../gateway/services/timetable-solver-bridge.js';
import { buildTimetableExportXlsx } from '../gateway/services/timetable-export.js';
import {
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
    TimetableRuleParseError,
} from '../gateway/services/timetable-rule-parser.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';
import { validateTimetableProjectForSolve } from '../gateway/services/timetable-validation.js';
import {
    auditTimetableProject,
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

function scheduleSignature(schedule = {}) {
    return (schedule.slots || [])
        .map(slot => ({
            lessonPlanId: slot.lessonPlanId,
            classId: slot.classId,
            subjectId: slot.subjectId,
            teacherId: slot.teacherId,
            teacherIds: [...(slot.teacherIds || [])].sort(),
            day: slot.day,
            period: slot.period,
            roomId: slot.roomId || null,
            locked: Boolean(slot.locked),
            blockIndex: slot.blockIndex || 0,
            blockSize: slot.blockSize || 1,
        }))
        .sort((left, right) => (
            left.day - right.day
            || left.period - right.period
            || left.classId.localeCompare(right.classId)
            || left.lessonPlanId.localeCompare(right.lessonPlanId)
            || String(left.roomId || '').localeCompare(String(right.roomId || ''))
        ));
}

function solveBenchmark(project, options = {}) {
    const startedAt = Date.now();
    const result = runTimetableScheduler(project, options);
    const durationMs = Date.now() - startedAt;
    const schedule = result.schedule || {};
    const score = schedule.score || {};
    const stats = schedule.solverStats || {};
    return {
        result,
        metrics: {
            success: Boolean(result.success),
            strategy: stats.strategy || null,
            status: stats.status || null,
            accepted: Boolean(stats.accepted),
            lessonCount: stats.lessonCount ?? null,
            slotCount: (schedule.slots || []).length,
            unplacedCount: (schedule.unplaced || []).length,
            hardConflicts: score.hardConflicts ?? 0,
            softScore: score.softScore ?? score.softSatisfaction ?? 0,
            completeness: score.completeness ?? 0,
            localImproveMs: stats.localImproveMs ?? 0,
            strategyVersion: stats.strategyVersion || null,
            strategyStats: stats.strategyStats || null,
            repairStats: stats.repairStats || null,
            localImprovementImproved: Boolean(stats.localImprovement?.improved),
            localImprovementRounds: stats.localImprovement?.rounds ?? 0,
            localImprovementMovesAccepted: stats.localImprovement?.movesAccepted ?? 0,
            durationMs,
        },
    };
}

test('duty assignments conflict with overlapping formal lessons for the same teacher', () => {
    const project = sampleProject({
        periodTimes: [{ period: 1, start: '08:00', end: '08:40' }],
        periodTimeSegments: {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早自习', startTime: '07:50', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            ],
        },
        dutyAssignments: [
            { id: 'duty-1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_math' },
        ],
    });

    const conflicts = detectScheduleConflicts(project, [
        { id: 'slot-1', day: 1, period: 1, classId: 'c2', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp3' },
    ]);

    assert.equal(conflicts.some(item => item.type === 'duty_lesson_teacher_conflict' && item.teacherId === 't_math'), true);
});

test('duty assignments conflict with other overlapping duty assignments for the same teacher', () => {
    const project = sampleProject({
        periodTimeSegments: {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            ],
        },
        dutyAssignments: [
            { id: 'duty-c1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_cn' },
            { id: 'duty-c2', day: 1, classId: 'c2', timeBlockId: 'early-study', teacherId: 't_cn' },
        ],
    });

    const conflicts = detectScheduleConflicts(project, []);

    assert.equal(conflicts.some(item => item.type === 'duty_teacher_conflict' && item.teacherId === 't_cn'), true);
});

function complexProject(overrides = {}) {
    return createDefaultTimetableProject({
        timetableModelVersion: 'complex_v1',
        weekdays: 5,
        periodsPerDay: 4,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4],
        campuses: [
            { id: 'north', name: '北校区' },
            { id: 'south', name: '南校区' },
        ],
        rooms: [
            { id: 'gym', name: '操场', campusId: 'north', tags: ['sport', 'outdoor'] },
            { id: 'lab', name: '实验室', campusId: 'south', tags: ['lab'] },
        ],
        teachers: [
            { id: 't_shared', name: '张老师', subjects: ['math'], unavailableSlots: [], campusId: 'north' },
            { id: 't_music', name: '王老师', subjects: ['music'], unavailableSlots: [], campusId: 'north' },
            { id: 't_pe', name: '周老师', subjects: ['pe'], unavailableSlots: [], campusId: 'north' },
            { id: 't_lab', name: '赵老师', subjects: ['science'], unavailableSlots: [], campusId: 'south' },
        ],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班', campusId: 'north' },
            { id: 'c2', grade: '七年级', name: '2班', campusId: 'north' },
            { id: 'c3', grade: '七年级', name: '3班', campusId: 'south' },
        ],
        subjects: [
            { id: 'math', name: '数学', priority: 95, color: '#2563eb' },
            { id: 'music', name: '音乐', priority: 50, color: '#16a34a' },
            { id: 'pe', name: '体育', priority: 40, color: '#f97316' },
            { id: 'science', name: '科学', priority: 70, color: '#7c3aed' },
        ],
        teachingGroups: [
            { id: 'tg_music', name: '七年级音乐合班', mode: 'combined_class', classIds: ['c1', 'c2'], subjectIds: ['music'], teacherIds: ['t_music'], roomIds: ['gym'] },
        ],
        commuteRules: { defaultGapPeriods: 1, teacherGapPeriods: { t_shared: 1 } },
        lessonPlans: [
            { id: 'lp_math_odd', classId: 'c1', subjectId: 'math', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'odd', campusId: 'north' },
            { id: 'lp_math_even', classId: 'c1', subjectId: 'math', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'even', campusId: 'north' },
            { id: 'lp_music_group', classId: 'c1', subjectId: 'music', teacherId: 't_music', weeklyHours: 1, teachingGroupId: 'tg_music', roomId: 'gym', campusId: 'north' },
            { id: 'lp_pe_room', classId: 'c2', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 1, roomRequirement: { preferredRoomIds: ['gym'], requiredTags: ['sport'] }, campusId: 'north' },
            { id: 'lp_science_south', classId: 'c3', subjectId: 'science', teacherId: 't_shared', weeklyHours: 1, campusId: 'south', roomRequirement: { preferredRoomIds: ['lab'], requiredTags: ['lab'] } },
        ],
        rules: { hardRules: { lockedSlots: [], teacherUnavailable: {}, classUnavailable: {} }, softRules: {} },
        ...overrides,
    });
}

function workbookText(buffer) {
    const workbook = new AdmZip(buffer);
    return workbook.getEntries()
        .filter(entry => entry.entryName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
        .map(entry => workbook.readAsText(entry))
        .join('\n');
}

function findValidManualMoveTarget(projectInput, slotId) {
    const project = normalizeTimetableProject(projectInput);
    const slot = project.schedule?.slots?.find(item => item.id === slotId);
    assert.ok(slot, 'expected a slot to move');

    for (const day of project.activeWeekdays) {
        for (const period of project.activePeriods) {
            if (day === slot.day && period === slot.period) continue;
            try {
                const preview = applyScheduleAdjustment(project, {
                    type: 'move',
                    slotId,
                    day,
                    period,
                });
                if (preview.success) return { day, period };
            } catch {
                // Keep scanning; the target may be occupied or unavailable.
            }
        }
    }
    assert.fail('expected a valid manual adjustment target');
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

test('timetable scheduler records an optional seed and reproduces placements for that seed', () => {
    const first = runTimetableScheduler(sampleProject(), { seed: 'legacy-seed-2026' });
    const second = runTimetableScheduler(sampleProject(), { seed: 'legacy-seed-2026' });

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.equal(first.schedule.solverStats.seed, 'legacy-seed-2026');
    assert.equal(second.schedule.solverStats.seed, 'legacy-seed-2026');
    assert.deepEqual(scheduleSignature(first.schedule), scheduleSignature(second.schedule));
});

test('timetable scheduler keeps seed metadata absent on the default path', () => {
    const result = runTimetableScheduler(sampleProject());

    assert.equal(result.success, true);
    assert.equal(Object.hasOwn(result.schedule.solverStats, 'seed'), false);
});

test('legacy scheduler baseline metrics cover core solve strategy scenarios', () => {
    const solvable = solveBenchmark(sampleProject(), { seed: 'baseline-solvable' });
    assert.equal(solvable.metrics.success, true);
    assert.equal(solvable.metrics.strategy, 'greedy_constraints');
    assert.equal(solvable.metrics.strategyVersion, 'legacy_enhanced_v2');
    assert.equal(solvable.metrics.strategyStats.ordering, 'difficulty_pressure');
    assert.equal(solvable.metrics.strategyStats.candidateScoring, 'soft_rules_pressure_weighted');
    assert.equal(solvable.metrics.repairStats.strategy, 'recursive_bounded_repair');
    assert.equal(solvable.metrics.unplacedCount, 0);
    assert.equal(solvable.metrics.hardConflicts, 0);
    assert.equal(solvable.metrics.lessonCount, 11);
    assert.equal(typeof solvable.metrics.softScore, 'number');
    assert.equal(Number.isFinite(solvable.metrics.durationMs), true);

    const impossible = solveBenchmark(sampleProject({
        weekdays: 1,
        periodsPerDay: 1,
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [
            { id: 'c1', grade: 'G7', name: '1' },
            { id: 'c2', grade: 'G7', name: '2' },
        ],
        subjects: [{ id: 'math', name: 'Math', priority: 100, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
            { id: 'lp2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    }), { seed: 'baseline-impossible' });
    assert.equal(impossible.metrics.success, false);
    assert.equal(impossible.metrics.unplacedCount, 1);
    assert.ok(impossible.result.schedule.unplaced[0].reason);

    const lockedDouble = solveBenchmark(createDefaultTimetableProject({
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
    }), { seed: 'baseline-locked-double' });
    assert.equal(lockedDouble.metrics.success, true);
    assert.equal(lockedDouble.metrics.hardConflicts, 0);
    assert.deepEqual(
        lockedDouble.result.schedule.slots
            .filter(slot => slot.lessonPlanId === 'lp_sci')
            .map(slot => [slot.day, slot.period, slot.locked, slot.blockSize])
            .sort((left, right) => left[1] - right[1]),
        [[2, 4, true, 2], [2, 5, true, 2]],
    );

    const roomLimited = solveBenchmark(createDefaultTimetableProject({
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
        subjects: [{ id: 'science', name: 'Science', priority: 60, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_lab_1', classId: 'c1', subjectId: 'science', teacherId: 't_sci_1', weeklyHours: 1, allowedRoomIds: ['Lab A', 'Lab B'] },
            { id: 'lp_lab_2', classId: 'c2', subjectId: 'science', teacherId: 't_sci_2', weeklyHours: 1, allowedRoomIds: ['Lab A', 'Lab B'] },
        ],
        rules: { hardRules: {}, softRules: {} },
    }), { seed: 'baseline-rooms' });
    assert.equal(roomLimited.metrics.success, true);
    assert.deepEqual(roomLimited.result.schedule.slots.map(slot => slot.roomId).sort(), ['Lab A', 'Lab B']);

    const manualProtected = solveBenchmark(createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 4,
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_cn', name: 'Chinese Teacher', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'chinese', name: 'Chinese', priority: 88, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'manual_baseline',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                { id: 'manual_math', day: 3, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', teacherIds: ['t_math'], lessonPlanId: 'lp_math', locked: true, manuallyAdjusted: true },
                { id: 'manual_cn', day: 4, period: 3, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', teacherIds: ['t_cn'], lessonPlanId: 'lp_cn', locked: false, manuallyAdjusted: true },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 4, completeness: 50 },
        },
    }), { seed: 'baseline-manual-protected' });
    assert.equal(manualProtected.metrics.success, true);
    assert.ok(manualProtected.result.schedule.slots.some(slot => slot.lessonPlanId === 'lp_math' && slot.day === 3 && slot.period === 2 && slot.locked));
    assert.ok(manualProtected.result.schedule.slots.some(slot => slot.lessonPlanId === 'lp_cn' && slot.day === 4 && slot.period === 3 && slot.manuallyAdjusted));

    const large = solveBenchmark(largeTimetableProject(), { seed: 'baseline-large' });
    assert.equal(large.metrics.success, true);
    assert.equal(large.metrics.slotCount, 690);
    assert.equal(large.metrics.unplacedCount, 0);
    assert.equal(large.metrics.hardConflicts, 0);
    assert.ok(large.metrics.durationMs < 15000, 'large baseline should stay inside the current 15s budget');
});

test('legacy enhanced v2 exposes construction passes, pressure stats, repair budgets and best snapshot', () => {
    const result = runTimetableScheduler(sampleProject(), { seed: 'enhanced-v2-contract' });
    const stats = result.schedule.solverStats;

    assert.equal(result.success, true);
    assert.equal(stats.strategyVersion, 'legacy_enhanced_v2');
    assert.ok(Array.isArray(stats.constructionPasses));
    assert.deepEqual(stats.constructionPasses.map(pass => pass.name), ['strict_soft', 'relaxed_soft', 'hard_only']);
    assert.ok(stats.pressureStats.maxNormalizedSlotPressure >= 0);
    assert.ok(stats.pressureStats.maxResourceDemand >= 0);
    assert.equal(stats.repairStats.strategy, 'recursive_bounded_repair');
    assert.equal(stats.repairStats.maxDepth, 14);
    assert.equal(stats.repairStats.maxBlockers, 3);
    assert.ok(Number.isInteger(stats.repairStats.maxCalls));
    assert.ok(stats.bestSnapshotStats);
    assert.equal(stats.bestSnapshotStats.stage, 'local_improvement');
});

test('legacy enhanced v2 records strict soft rejections before relaxed construction places the lessons', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 2,
        activeWeekdays: [1],
        activePeriods: [1, 2],
        teachers: [{ id: 't_math', name: 'Math', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: {
            hardRules: { teacherUnavailable: { t_math: [] } },
            softRules: {
                subjectPreferredPeriods: {
                    math: { prefer: ['1-1'], weight: 80 },
                },
            },
        },
    });

    const result = runTimetableScheduler(project, { seed: 'relaxed-soft-pass' });
    const passes = result.schedule.solverStats.constructionPasses;

    assert.equal(result.success, true);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assert.ok(passes[0].softRejected > 0);
    assert.ok(passes[1].placed > 0 || passes[2].placed > 0);
    assert.ok(result.schedule.solverStats.softEnforcement.evaluations > 0);
    assert.ok(result.schedule.solverStats.softEnforcement.enforced > 0);
});

test('legacy enhanced v2 reports best snapshot for impossible partial schedules', () => {
    const project = sampleProject({
        weekdays: 1,
        periodsPerDay: 1,
        activeWeekdays: [1],
        activePeriods: [1],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [
            { id: 'c1', grade: 'G7', name: '1' },
            { id: 'c2', grade: 'G7', name: '2' },
        ],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
            { id: 'lp2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project, { seed: 'best-snapshot-impossible' });
    const snapshot = result.schedule.solverStats.bestSnapshotStats;

    assert.equal(result.success, false);
    assert.equal(result.schedule.solverStats.strategyVersion, 'legacy_enhanced_v2');
    assert.ok(snapshot);
    assert.ok(snapshot.placedLessons >= 1);
    assert.ok(snapshot.unplacedLessons >= 1);
    assert.ok(['constructor', 'repair', 'local_improvement'].includes(snapshot.stage));
});

test('legacy enhanced v2 keeps edge-coloring fast path within the enhanced stats contract', () => {
    const result = runTimetableScheduler(largeTimetableProject(), { seed: 'large-enhanced-contract' });
    const stats = result.schedule.solverStats;

    assert.equal(result.success, true);
    assert.equal(stats.strategyVersion, 'legacy_enhanced_v2');
    assert.ok(stats.pressureStats);
    assert.ok(stats.bestSnapshotStats);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assert.equal(result.schedule.score.hardConflicts, 0);
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

test('timetable audit treats a full class timetable as normal load', () => {
    const project = sampleProject({
        weekdays: 1,
        periodsPerDay: 2,
        activeWeekdays: [1],
        activePeriods: [1, 2],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });

    const audit = auditTimetableProject(project);

    assert.equal(audit.blockingIssues.some(issue => issue.type === 'class_capacity'), false);
    assert.equal(audit.warnings.some(issue => issue.type === 'class_load'), false);
    assert.ok(audit.warnings.some(issue => issue.type === 'teacher_load'));
    assert.equal(audit.bottlenecks.classes[0].utilization, 100);
});

test('timetable publication omits full-class legacy load review while keeping teacher load', () => {
    const project = sampleProject({
        weekdays: 1,
        periodsPerDay: 2,
        activeWeekdays: [1],
        activePeriods: [1, 2],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'full-class-ready',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [],
            score: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.equal(publication.issueEntries.some(issue => issue.type === 'class_load'), false);
    assert.ok(publication.issueEntries.some(issue => issue.type === 'teacher_load'));
});

function constraintFulfillmentProject(overrides = {}) {
    return createDefaultTimetableProject({
        weekdays: 2,
        periodsPerDay: 5,
        activeWeekdays: [1, 2],
        activePeriods: [1, 2, 3, 4, 5],
        dayPartBoundaries: { afternoonStartPeriod: 4 },
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_cn', name: 'Chinese Teacher', subjects: ['chinese'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE Teacher', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'chinese', name: 'Chinese', priority: 80, color: '#dc2626' },
            { id: 'pe', name: 'PE', priority: 30, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 2 },
            { id: 'lp_pe', classId: 'c1', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 1 },
        ],
        rules: {
            hardRules: {
                teacherUnavailable: { t_math: ['1-1'] },
                classUnavailable: { c1: ['2-5'] },
                lockedSlots: [
                    { day: 1, period: 2, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', lessonPlanId: 'lp_cn' },
                ],
            },
            softRules: {
                morningSubjects: ['math'],
                subjectPreferredPeriods: {
                    pe: { prefer: ['2-2'], weight: 20 },
                    chinese: { avoid: ['1-3'], weight: 20 },
                },
                teacherLimits: {
                    t_math: { daily: 1 },
                    t_cn: { consecutive: 1 },
                },
                spreadSubjects: ['math'],
            },
        },
        schedule: {
            id: 'constraint-fulfillment-schedule',
            generatedAt: '2026-01-02T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-math-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                { id: 'slot-math-2', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                { id: 'slot-cn-1', day: 1, period: 3, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', lessonPlanId: 'lp_cn' },
                { id: 'slot-cn-2', day: 1, period: 4, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', lessonPlanId: 'lp_cn' },
                { id: 'slot-pe-1', day: 2, period: 2, classId: 'c1', subjectId: 'pe', teacherId: 't_pe', lessonPlanId: 'lp_pe' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [],
            score: { totalLessons: 5, placedLessons: 5, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
        ...overrides,
    });
}

function phase4FulfillmentPrimitiveProject(overrides = {}) {
    return createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 5,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5],
        dayPartBoundaries: { afternoonStartPeriod: 4 },
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_cn', name: 'Chinese Teacher', subjects: ['chinese'], unavailableSlots: [] },
            { id: 't_eng', name: 'English Teacher', subjects: ['english'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE Teacher', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb', category: 'main' },
            { id: 'chinese', name: 'Chinese', priority: 80, color: '#dc2626', category: 'main' },
            { id: 'english', name: 'English', priority: 75, color: '#7c3aed', category: 'main' },
            { id: 'pe', name: 'PE', priority: 30, color: '#16a34a' },
        ],
        rooms: [
            { id: 'gym', name: 'Gym', tags: ['sport'] },
            { id: 'room101', name: 'Room 101', tags: [] },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 4 },
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 2 },
            { id: 'lp_eng', classId: 'c1', subjectId: 'english', teacherId: 't_eng', weeklyHours: 1 },
            { id: 'lp_pe', classId: 'c1', subjectId: 'pe', teacherId: 't_pe', weeklyHours: 1, roomId: 'gym' },
        ],
        rules: {
            hardRules: {
                teacherUnavailable: { t_math: ['1-1'] },
                classUnavailable: { c1: ['5-5'] },
                globalUnavailable: ['3-3'],
                lockedSlots: [
                    { day: 2, period: 2, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', lessonPlanId: 'lp_cn' },
                ],
                subjectDailyLimit: { math: 1 },
                teacherWeeklyLimit: { t_math: 2 },
                teacherMaxDaysPerWeek: { t_math: 2 },
                teacherMutualExclusion: [{ teacherIds: ['t_math', 't_eng'] }],
                subjectNotSameDay: [{ subjectIds: ['math', 'english'], classIds: ['c1'] }],
                roomRequirements: { pe: { roomIds: ['gym'] } },
            },
            softRules: {
                morningSubjects: ['math'],
                afternoonSubjects: ['pe'],
                subjectPreferredPeriods: {
                    pe: { prefer: ['3-3'], weight: 20 },
                    chinese: { avoid: ['1-2'], weight: 20 },
                },
                teacherLimits: {
                    t_math: { daily: 1, consecutive: 1 },
                },
                spreadSubjects: ['math'],
                spreadSubjectGaps: { math: 2 },
                classDailyBalance: { enabled: true, mainSubjectDailyMax: 4 },
                teacherGapWeight: 1,
                teacherLoadBalance: { enabled: true, weight: 1, explicit: true },
                subjectSequence: [{ beforeSubjectId: 'chinese', afterSubjectId: 'math', classIds: ['c1'] }],
            },
        },
        schedule: {
            id: 'phase4-primitive-coverage',
            generatedAt: '2026-01-02T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-math-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math', roomId: 'room101' },
                { id: 'slot-math-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math', roomId: 'room101' },
                { id: 'slot-cn-avoid', day: 1, period: 2, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', lessonPlanId: 'lp_cn', roomId: 'room101' },
                { id: 'slot-math-3', day: 2, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math', roomId: 'room101' },
                { id: 'slot-cn-locked', day: 2, period: 2, classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', lessonPlanId: 'lp_cn', roomId: 'room101' },
                { id: 'slot-pe-room', day: 3, period: 3, classId: 'c1', subjectId: 'pe', teacherId: 't_pe', lessonPlanId: 'lp_pe', roomId: 'room101' },
                { id: 'slot-math-4', day: 4, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math', roomId: 'room101' },
                { id: 'slot-eng-1', day: 4, period: 1, classId: 'c1', subjectId: 'english', teacherId: 't_eng', lessonPlanId: 'lp_eng', roomId: 'room101' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [],
            score: { totalLessons: 8, placedLessons: 8, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
        ...overrides,
    });
}

test('timetable constraint fulfillment evaluates saved rules without changing review noise', () => {
    const project = constraintFulfillmentProject();
    const result = evaluateTimetableConstraintFulfillment(project);
    const byType = new Map(result.items.map(item => [item.type, item]));
    const bySource = new Map(result.items.map(item => [item.source, item]));

    assert.equal(result.evaluated, true);
    assert.equal(result.version, 2);
    assert.deepEqual(result.summary, {
        total: 9,
        satisfied: 2,
        partiallySatisfied: 1,
        violated: 6,
        notEvaluable: 0,
        partial: 1,
        unmet: 6,
        notApplicable: 0,
    });
    assert.equal(byType.get('teacher_unavailable').status, 'violated');
    assert.equal(byType.get('class_unavailable').status, 'satisfied');
    assert.equal(byType.get('locked_slot').status, 'violated');
    assert.equal(byType.get('subject_morning').status, 'partial');
    assert.equal(bySource.get('softRules.subjectPreferredPeriods.prefer').status, 'satisfied');
    assert.equal(bySource.get('softRules.subjectPreferredPeriods.avoid').status, 'violated');
    assert.equal(byType.get('teacher_daily_limit').status, 'violated');
    assert.equal(byType.get('teacher_consecutive_limit').status, 'violated');
    assert.equal(byType.get('subject_spread').status, 'violated');
    assert.equal(byType.get('teacher_unavailable').ruleId, 'teacher_unavailable:t_math:1-1');
    assert.equal(byType.get('teacher_unavailable').strength, 'hard');
    assert.equal(byType.get('teacher_unavailable').typeLabel, '教师不可排');
    assert.equal(byType.get('teacher_unavailable').legacyStatus, 'unmet');
    assert.ok(byType.get('teacher_unavailable').evidenceSlots.some(slot => slot.slotId === 'slot-math-1'));
    assert.ok(byType.get('teacher_unavailable').suggestions.some(action => action.kind === 'delete_rule'));
    assert.ok(byType.get('teacher_unavailable').locateTargets.some(target => target.slotId === 'slot-math-1'));
    assert.match(byType.get('subject_morning').evidence, /1\/2/);
});

test('timetable constraint fulfillment keeps saved rule total before schedule generation', () => {
    const result = evaluateTimetableConstraintFulfillment(constraintFulfillmentProject({ schedule: null }));

    assert.equal(result.evaluated, false);
    assert.equal(result.summary.total, 9);
    assert.equal(result.summary.notApplicable, 9);
    assert.equal(result.summary.notEvaluable, 9);
    assert.equal(result.items.length, 9);
    assert.ok(result.items.every(item => item.status === 'not_evaluable'));
    assert.ok(result.items.every(item => item.legacyStatus === 'not_applicable'));
});

test('timetable constraint fulfillment covers the Phase 4 primitive catalog', () => {
    const result = evaluateTimetableConstraintFulfillment(phase4FulfillmentPrimitiveProject());
    const itemTypes = new Set(result.items.map(item => item.type));

    assert.equal(result.coverage.primitiveCount, 22);
    assert.equal(result.coverage.primitives.length, 22);
    assert.equal(result.coverage.primitiveAliases.class_daily_subject_balance, 'class_daily_balance');
    assert.ok(result.coverage.primitives.includes('class_daily_subject_balance'));
    for (const primitive of [
        'teacher_unavailable',
        'class_unavailable',
        'locked_slot',
        'subject_morning',
        'subject_preferred_periods',
        'subject_avoid_periods',
        'teacher_daily_limit',
        'teacher_consecutive_limit',
        'subject_spread',
        'subject_afternoon',
        'room_requirement',
        'class_daily_balance',
        'teacher_gap_preference',
        'teacher_load_balance',
        'global_unavailable',
        'subject_daily_limit',
        'teacher_weekly_limit',
        'teacher_max_days_per_week',
        'teacher_mutual_exclusion',
        'subject_not_same_day',
        'subject_sequence',
        'course_interval',
    ]) {
        assert.ok(itemTypes.has(primitive), `missing ${primitive}`);
    }
    assert.equal(result.items.length, 22);
    assert.ok(result.items.every(item => ['satisfied', 'partial', 'violated', 'not_evaluable'].includes(item.status)));
    assert.ok(result.items.every(item => item.ruleId && item.typeLabel && item.origin && item.strength && item.detail));
});

test('timetable constraint fulfillment reports exactly two soft attention items for a small project', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 5,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3, 4, 5],
        dayPartBoundaries: { afternoonStartPeriod: 4 },
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
        rules: {
            hardRules: {},
            softRules: {
                morningSubjects: ['math'],
                teacherLimits: { t_math: { daily: 1 } },
            },
        },
        schedule: {
            id: 'two-soft-violations',
            generatedAt: '2026-01-02T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-math-afternoon-1', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                { id: 'slot-math-afternoon-2', day: 1, period: 5, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [],
            score: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const result = evaluateTimetableConstraintFulfillment(project);

    assert.equal(result.summary.violated + result.summary.partiallySatisfied, 2);
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every(item => item.strength === 'soft'));
    assert.ok(result.items.every(item => item.evidenceSlots.length > 0));
});

test('timetable constraint fulfillment action can delete a saved rule and refresh the report', () => {
    const result = applyTimetableConstraintFulfillmentAction(constraintFulfillmentProject(), {
        kind: 'delete_rule',
        ruleId: 'teacher_unavailable:t_math:1-1',
    });

    assert.equal(result.action.kind, 'delete_rule');
    assert.equal(result.action.type, 'teacher_unavailable');
    assert.deepEqual(result.project.rules.hardRules.teacherUnavailable, {});
    assert.equal(result.fulfillment.summary.total, 8);
    assert.equal(result.fulfillment.items.some(item => item.ruleId === 'teacher_unavailable:t_math:1-1'), false);
});

test('timetable publication ignores legacy subject spread quality-only review', () => {
    const project = sampleProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: { spreadSubjects: ['math'] } },
        schedule: {
            id: 'legacy-subject-spread-only',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'legacy-spread', type: 'subject_spread', severity: 'warning', classId: 'c1', subjectId: 'math', message: 'Math 同一天过于集中。' },
            ],
            score: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.equal(publication.warnings.some(issue => issue.type === 'quality_review'), false);
    assert.equal(publication.issueEntries.some(issue => issue.type === 'subject_spread'), false);
});

test('timetable publication keeps actionable quality review after ignoring subject spread', () => {
    const project = sampleProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'mixed-quality-review',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'legacy-spread', type: 'subject_spread', severity: 'warning', classId: 'c1', subjectId: 'math', message: 'Math 同一天过于集中。' },
                { id: 'avoid-period', type: 'subject_avoid_period', severity: 'warning', classId: 'c1', subjectId: 'math', message: 'Math 排在了避开节次。' },
            ],
            score: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.ok(publication.warnings.some(issue => issue.type === 'quality_review'));
    assert.equal(publication.issueEntries.some(issue => issue.type === 'subject_spread'), false);
    assert.ok(publication.issueEntries.some(issue => issue.type === 'subject_avoid_period'));
});

test('fast scheduler keeps default teacher consecutive load as soft score only', () => {
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
        rules: { hardRules: {}, softRules: {} },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.teacherConsecutive));
    assert.equal(result.schedule.qualityIssues.some(issue => issue.type === 'teacher_consecutive'), false);
});

test('timetable publication ignores legacy teacher consecutive review without explicit limit', () => {
    const project = sampleProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 4 },
        ],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'legacy-teacher-consecutive-only',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                { id: 'slot-3', day: 1, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                { id: 'slot-4', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'teacher-consecutive', type: 'teacher_consecutive', severity: 'warning', teacherId: 't_math', message: 'Math Teacher 连续授课偏多。' },
            ],
            score: { totalLessons: 4, placedLessons: 4, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.equal(publication.warnings.some(issue => issue.type === 'quality_review'), false);
    assert.equal(publication.issueEntries.some(issue => issue.type === 'teacher_consecutive'), false);
});

test('timetable publication keeps other quality review after ignoring default teacher consecutive', () => {
    const project = sampleProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'mixed-default-consecutive-quality',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'teacher-consecutive', type: 'teacher_consecutive', severity: 'warning', teacherId: 't_math', message: 'Math Teacher 连续授课偏多。' },
                { id: 'avoid-period', type: 'subject_avoid_period', severity: 'warning', classId: 'c1', subjectId: 'math', message: 'Math 排在了避开节次。' },
            ],
            score: { totalLessons: 2, placedLessons: 2, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.ok(publication.warnings.some(issue => issue.type === 'quality_review'));
    assert.equal(publication.issueEntries.some(issue => issue.type === 'teacher_consecutive'), false);
    assert.ok(publication.issueEntries.some(issue => issue.type === 'subject_avoid_period'));
});

test('timetable publication keeps teacher consecutive review for explicit limit', () => {
    const project = sampleProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 3 },
        ],
        rules: { hardRules: {}, softRules: { teacherLimits: { t_math: { consecutive: 2 } } } },
        schedule: {
            id: 'explicit-teacher-consecutive',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                { id: 'slot-2', day: 1, period: 2, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
                { id: 'slot-3', day: 1, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'teacher-consecutive', type: 'teacher_consecutive', severity: 'warning', teacherId: 't_math', message: 'Math Teacher 连续授课偏多。' },
            ],
            score: { totalLessons: 3, placedLessons: 3, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.ok(publication.warnings.some(issue => issue.type === 'quality_review'));
    assert.ok(publication.issueEntries.some(issue => issue.type === 'teacher_consecutive'));
});

test('fast scheduler keeps default morning subject preference as soft score only', () => {
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
        rules: { hardRules: {}, softRules: { morningSubjects: ['chinese'] } },
    });

    const result = runTimetableScheduler(project);

    assert.equal(result.success, true);
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.morningSubjects));
    assert.equal(result.schedule.qualityIssues.some(issue => issue.type === 'morning_subject_late'), false);
});

test('timetable publication ignores legacy morning subject review noise', () => {
    const project = sampleProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: { morningSubjects: ['math'] } },
        schedule: {
            id: 'legacy-morning-subject-only',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'morning-late', type: 'morning_subject_late', severity: 'info', classId: 'c1', subjectId: 'math', message: 'Math 未排在上午优先时段。' },
            ],
            score: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.equal(publication.warnings.some(issue => issue.type === 'quality_review'), false);
    assert.equal(publication.issueEntries.some(issue => issue.type === 'morning_subject_late'), false);
});

test('timetable publication keeps actionable quality review after ignoring morning subject noise', () => {
    const project = sampleProject({
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: { morningSubjects: ['math'] } },
        schedule: {
            id: 'mixed-morning-subject-quality',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [
                { id: 'slot-1', day: 1, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp1' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            qualityIssues: [
                { id: 'morning-late', type: 'morning_subject_late', severity: 'info', classId: 'c1', subjectId: 'math', message: 'Math 未排在上午优先时段。' },
                { id: 'avoid-period', type: 'subject_avoid_period', severity: 'warning', classId: 'c1', subjectId: 'math', message: 'Math 排在了避开节次。' },
            ],
            score: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);

    assert.equal(publication.ok, true);
    assert.ok(publication.warnings.some(issue => issue.type === 'quality_review'));
    assert.equal(publication.issueEntries.some(issue => issue.type === 'morning_subject_late'), false);
    assert.ok(publication.issueEntries.some(issue => issue.type === 'subject_avoid_period'));
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
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.subjectSpread));
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.teacherConsecutive));
    assert.ok(Number.isInteger(result.schedule.score.softBreakdown.roomUsage));
    assert.ok(result.schedule.qualityIssues.some(issue => issue.type === 'teacher_consecutive'));
    assert.ok(result.schedule.qualityIssues.some(issue => issue.type === 'subject_avoid_period'));
    assert.equal(result.schedule.qualityIssues.some(issue => issue.type === 'subject_spread'), false);
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

test('bounded repair can relocate two blockers without leaving hard conflicts', () => {
    const allSlots = ['1-1', '1-2', '2-1', '2-2', '3-1', '3-2'];
    const except = allowed => allSlots.filter(slot => !allowed.includes(slot));
    const project = createDefaultTimetableProject({
        weekdays: 3,
        periodsPerDay: 2,
        activeWeekdays: [1, 2, 3],
        activePeriods: [1, 2],
        teachers: [
            { id: 't_target', name: 'Target Teacher', subjects: ['target', 'block_b'], unavailableSlots: [] },
            { id: 't_block_a', name: 'Block A', subjects: ['block_a'], unavailableSlots: except(['1-1', '3-1']) },
            { id: 't_block_c', name: 'Block C', subjects: ['block_c'], unavailableSlots: except(['1-2']) },
            { id: 't_block_d', name: 'Block D', subjects: ['block_d'], unavailableSlots: except(['2-1']) },
            { id: 't_block_e', name: 'Block E', subjects: ['block_e'], unavailableSlots: except(['2-2']) },
            { id: 't_lab_1', name: 'Lab 1', subjects: ['lab_hold'], unavailableSlots: [] },
            { id: 't_lab_2', name: 'Lab 2', subjects: ['lab_hold'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c_target', grade: 'G', name: 'Target' },
            { id: 'c_peer', grade: 'G', name: 'Peer' },
            { id: 'c_lab_1', grade: 'G', name: 'Lab 1' },
            { id: 'c_lab_2', grade: 'G', name: 'Lab 2' },
        ],
        subjects: [
            { id: 'target', name: 'Target', priority: 1, color: '#2563eb' },
            { id: 'block_a', name: 'Block A', priority: 100, color: '#16a34a' },
            { id: 'block_b', name: 'Block B', priority: 100, color: '#f59e0b' },
            { id: 'block_c', name: 'Block C', priority: 100, color: '#f97316' },
            { id: 'block_d', name: 'Block D', priority: 100, color: '#06b6d4' },
            { id: 'block_e', name: 'Block E', priority: 100, color: '#8b5cf6' },
            { id: 'lab_hold', name: 'Lab Hold', priority: 50, color: '#64748b' },
        ],
        lessonPlans: [
            { id: 'lp_target', classId: 'c_target', subjectId: 'target', teacherId: 't_target', weeklyHours: 1, roomId: 'lab' },
            { id: 'lp_block_a', classId: 'c_target', subjectId: 'block_a', teacherId: 't_block_a', weeklyHours: 1 },
            { id: 'lp_block_b', classId: 'c_peer', subjectId: 'block_b', teacherId: 't_target', weeklyHours: 1 },
            { id: 'lp_block_c', classId: 'c_target', subjectId: 'block_c', teacherId: 't_block_c', weeklyHours: 1 },
            { id: 'lp_block_d', classId: 'c_target', subjectId: 'block_d', teacherId: 't_block_d', weeklyHours: 1 },
            { id: 'lp_block_e', classId: 'c_target', subjectId: 'block_e', teacherId: 't_block_e', weeklyHours: 1 },
            { id: 'lp_lab_1', classId: 'c_lab_1', subjectId: 'lab_hold', teacherId: 't_lab_1', weeklyHours: 1, roomId: 'lab' },
            { id: 'lp_lab_2', classId: 'c_lab_2', subjectId: 'lab_hold', teacherId: 't_lab_2', weeklyHours: 1, roomId: 'lab' },
        ],
        rules: {
            hardRules: {
                lockedSlots: [],
                teacherUnavailable: {},
                classUnavailable: {
                    c_peer: ['1-2', '2-1', '2-2', '3-1'],
                },
            },
            softRules: {
                subjectPreferredPeriods: {
                    block_a: { prefer: ['1-1'], weight: 100 },
                    block_b: { prefer: ['1-1'], weight: 100 },
                    block_c: { prefer: ['1-2'], weight: 100 },
                    block_d: { prefer: ['2-1'], weight: 100 },
                    block_e: { prefer: ['2-2'], weight: 100 },
                },
            },
        },
        schedule: {
            id: 'lab_locks',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                { id: 'lab_lock_1', day: 3, period: 1, classId: 'c_lab_1', subjectId: 'lab_hold', teacherId: 't_lab_1', teacherIds: ['t_lab_1'], lessonPlanId: 'lp_lab_1', roomId: 'lab', locked: true, manuallyAdjusted: true },
                { id: 'lab_lock_2', day: 3, period: 2, classId: 'c_lab_2', subjectId: 'lab_hold', teacherId: 't_lab_2', teacherIds: ['t_lab_2'], lessonPlanId: 'lp_lab_2', roomId: 'lab', locked: true, manuallyAdjusted: true },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 8, completeness: 25 },
        },
    });

    const result = runTimetableScheduler(project, { seed: 'two-blocker-repair' });
    const target = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_target');

    assert.equal(result.success, true);
    assert.deepEqual([target.day, target.period], [1, 1]);
    assert.equal(result.schedule.solverStats.repairStats.relocatedBlockers >= 2, true);
    assert.equal(result.schedule.solverStats.repairStats.rollbacks >= 1, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.score.unplacedLessons, 0);
    assertNoTeacherOrClassConflicts(result.schedule.slots);
});

test('recursive repair moves a blocker chain before placing the stranded lesson', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 3,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3],
        teachers: [
            { id: 't_a', name: 'Blocker A', subjects: ['block_a'], unavailableSlots: ['1-3'] },
            { id: 't_b', name: 'Blocker B', subjects: ['block_b'], unavailableSlots: ['1-1'] },
            { id: 't_target', name: 'Target', subjects: ['target'], unavailableSlots: ['1-2', '1-3'] },
        ],
        classes: [
            { id: 'c_a', grade: 'G', name: 'A' },
            { id: 'c_b', grade: 'G', name: 'B' },
            { id: 'c_target', grade: 'G', name: 'Target' },
        ],
        subjects: [
            { id: 'block_a', name: 'Block A', priority: 100, color: '#2563eb' },
            { id: 'block_b', name: 'Block B', priority: 100, color: '#16a34a' },
            { id: 'target', name: 'Target', priority: 1, color: '#f97316' },
        ],
        rooms: [{ id: 'lab', name: 'Lab' }],
        lessonPlans: [
            { id: 'lp_a', classId: 'c_a', subjectId: 'block_a', teacherId: 't_a', weeklyHours: 1, roomId: 'lab' },
            { id: 'lp_b', classId: 'c_b', subjectId: 'block_b', teacherId: 't_b', weeklyHours: 1, roomId: 'lab' },
            { id: 'lp_target', classId: 'c_target', subjectId: 'target', teacherId: 't_target', weeklyHours: 1, roomId: 'lab' },
        ],
        rules: {
            hardRules: {},
            softRules: {
                subjectPreferredPeriods: {
                    block_a: { prefer: ['1-1'], weight: 100 },
                    block_b: { prefer: ['1-2'], weight: 100 },
                },
            },
        },
    });

    const result = runTimetableScheduler(project, { seed: 'recursive-chain-repair' });
    const byPlan = Object.fromEntries(result.schedule.slots.map(slot => [slot.lessonPlanId, slot]));

    assert.equal(result.success, true);
    assert.deepEqual([byPlan.lp_target.day, byPlan.lp_target.period], [1, 1]);
    assert.deepEqual([byPlan.lp_a.day, byPlan.lp_a.period], [1, 2]);
    assert.deepEqual([byPlan.lp_b.day, byPlan.lp_b.period], [1, 3]);
    assert.equal(result.schedule.solverStats.repairStats.relocatedBlockers >= 2, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.score.unplacedLessons, 0);
});

test('recursive repair moves an entire double-block blocker as a protected group', () => {
    const project = createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 3,
        activeWeekdays: [1],
        activePeriods: [1, 2, 3],
        teachers: [
            { id: 't_double', name: 'Double Blocker', subjects: ['double'], unavailableSlots: [] },
            { id: 't_target', name: 'Target', subjects: ['target'], unavailableSlots: ['1-2', '1-3'] },
        ],
        classes: [
            { id: 'c_double', grade: 'G', name: 'Double' },
            { id: 'c_target', grade: 'G', name: 'Target' },
        ],
        subjects: [
            { id: 'double', name: 'Double', priority: 100, color: '#2563eb' },
            { id: 'target', name: 'Target', priority: 1, color: '#f97316' },
        ],
        rooms: [{ id: 'lab', name: 'Lab' }],
        lessonPlans: [
            { id: 'lp_double', classId: 'c_double', subjectId: 'double', teacherId: 't_double', weeklyHours: 2, blockPreference: 'double', roomId: 'lab' },
            { id: 'lp_target', classId: 'c_target', subjectId: 'target', teacherId: 't_target', weeklyHours: 1, roomId: 'lab' },
        ],
        rules: {
            hardRules: {},
            softRules: {
                subjectPreferredPeriods: {
                    double: { prefer: ['1-1'], weight: 100 },
                },
            },
        },
    });

    const result = runTimetableScheduler(project, { seed: 'double-blocker-repair' });
    const doubleSlots = result.schedule.slots
        .filter(slot => slot.lessonPlanId === 'lp_double')
        .sort((left, right) => left.period - right.period);
    const target = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_target');

    assert.equal(result.success, true);
    assert.deepEqual([target.day, target.period], [1, 1]);
    assert.deepEqual(doubleSlots.map(slot => [slot.day, slot.period, slot.blockId]), [
        [1, 2, doubleSlots[0].blockId],
        [1, 3, doubleSlots[0].blockId],
    ]);
    assert.equal(result.schedule.solverStats.repairStats.relocatedBlockers >= 1, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.score.unplacedLessons, 0);
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
    assert.ok(Array.isArray(ready.issueEntries));
    assert.ok(Array.isArray(ready.reviewItems));
    assert.deepEqual(ready.issueEntries, ready.reviewItems);

    const restoredDraft = validateTimetablePublication({
        ...cleanProject,
        schedule: {
            ...cleanProject.schedule,
            source: 'published_history_restored',
        },
    });

    assert.equal(restoredDraft.ok, true);
    assert.ok(restoredDraft.warnings.some(issue => issue.type === 'restored_published_draft'));
    assert.ok(restoredDraft.issueEntries.some(item => item.type === 'restored_published_draft'));
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
    assert.ok(highLoadReady.issueEntries.some(item => item.type === 'teacher_load' && item.targetKind === 'teacher'));
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
    assert.ok(incomplete.issueEntries.some(item => item.type === 'incomplete_schedule' && item.targetKind === 'class'));
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
    assert.ok(validation.issueEntries.some(item => item.type === 'publication_fingerprint_mismatch'
        && item.severity === 'warning'
        && item.targetName === '发布快照'));
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
    assert.ok(validation.issueEntries.some(item => item.type === 'publication_fingerprint_mismatch'
        && item.severity === 'warning'
        && item.targetName === '发布历史 V1'));
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
    assert.ok(validation.issueEntries.some(item => item.type === 'published_snapshot_backfill_needed'
        && item.severity === 'warning'
        && item.targetName === '\u53d1\u5e03\u5feb\u7167'));
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
    assert.equal(adjusted.schedule.solverStats.phase, 'manual_adjustment');
    assert.equal(adjusted.schedule.solverStats.status, 'needs_review');
    assert.equal(adjusted.schedule.solverStats.accepted, false);
    assert.equal(adjusted.schedule.solverStats.reason, 'manual_adjustment_conflicts');
});

test('manual adjustment moves, locks and clears timetable slots with validation', () => {
    const result = runTimetableScheduler(sampleProject());
    result.schedule.solverStats = {
        phase: 'timefold_optimization',
        status: 'failed',
        accepted: false,
        reason: 'timeout',
        initialSolutionUsed: true,
        pinnedCount: 2,
        lessonCount: 11,
        timeoutSeconds: 210,
    };
    const first = result.schedule.slots.find(slot => !slot.locked && slot.teacherId === 't_math');
    const projectWithSchedule = sampleProject({ schedule: result.schedule });
    const target = findValidManualMoveTarget(projectWithSchedule, first.id);
    const moved = applyScheduleAdjustment(projectWithSchedule, {
        type: 'move',
        slotId: first.id,
        day: target.day,
        period: target.period,
    });

    const adjusted = moved.schedule.slots.find(slot => slot.id === first.id);
    assert.equal(adjusted.day, target.day);
    assert.equal(adjusted.period, target.period);
    assert.equal(adjusted.manuallyAdjusted, true);
    assert.equal(moved.schedule.source, 'manual_adjusted');
    assert.equal(moved.schedule.solverStats.phase, 'manual_adjustment');
    assert.equal(moved.schedule.solverStats.status, 'accepted');
    assert.equal(moved.schedule.solverStats.accepted, true);
    assert.equal(moved.schedule.solverStats.reason, null);
    assert.equal(moved.schedule.solverStats.initialSolutionUsed, undefined);
    assert.equal(moved.schedule.solverStats.pinnedCount, undefined);
    assert.equal(moved.schedule.solverStats.timeoutSeconds, undefined);

    const locked = applyScheduleAdjustment(sampleProject({ schedule: moved.schedule }), {
        type: 'lock',
        slotId: first.id,
        locked: true,
    });
    assert.equal(locked.schedule.slots.find(slot => slot.id === first.id).locked, true);
    assert.equal(locked.schedule.solverStats.phase, 'manual_adjustment');
    assert.equal(locked.schedule.solverStats.status, 'accepted');
    assert.equal(locked.schedule.solverStats.accepted, true);
    assert.equal(locked.schedule.solverStats.reason, null);

    const cleared = applyScheduleAdjustment(sampleProject({ schedule: locked.schedule }), {
        type: 'clear',
        slotId: first.id,
    });
    assert.equal(cleared.schedule.slots.some(slot => slot.id === first.id), false);
    assert.equal(cleared.schedule.solverStats.phase, 'manual_adjustment');
    assert.equal(cleared.schedule.solverStats.status, 'accepted');
    assert.equal(cleared.schedule.solverStats.accepted, true);
    assert.equal(cleared.schedule.solverStats.reason, null);
});

test('manual adjustment preserves restored-published review semantics on restored drafts', () => {
    const result = runTimetableScheduler(sampleProject());
    const first = result.schedule.slots.find(slot => !slot.locked && slot.teacherId === 't_math');
    const restoredSchedule = {
        ...result.schedule,
        source: 'published_history_restored',
        published: {
            status: 'draft_changed',
            version: 2,
            publishedAt: '2026-01-02T08:00:00.000Z',
            scheduleId: 'published-v2',
            note: '恢复的发布版',
        },
        solverStats: {
            phase: 'published_history_restore',
            status: 'restored',
            accepted: true,
            reason: null,
            restoredVersion: 2,
            restoredScheduleId: 'published-v2',
        },
    };

    const projectWithSchedule = sampleProject({ schedule: restoredSchedule });
    const target = findValidManualMoveTarget(projectWithSchedule, first.id);
    const moved = applyScheduleAdjustment(projectWithSchedule, {
        type: 'move',
        slotId: first.id,
        day: target.day,
        period: target.period,
    });

    assert.equal(moved.schedule.source, 'manual_adjusted');
    assert.equal(moved.schedule.solverStats.phase, 'manual_adjustment');
    assert.equal(moved.schedule.solverStats.restoredPublishedDraft, true);
    assert.equal(moved.schedule.solverStats.restoredVersion, 2);
    assert.equal(moved.schedule.solverStats.restoredScheduleId, 'published-v2');
    assert.ok(moved.schedule.publication.warnings.some(issue => issue.type === 'restored_published_draft'));
    assert.ok(moved.schedule.publication.reviewItems.some(item => item.type === 'restored_published_draft'));
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

test('fast timetable scheduler preserves locked and manually adjusted slots when regenerating', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 4,
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_cn', name: 'Chinese Teacher', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'chinese', name: 'Chinese', priority: 88, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2, blockPreference: 'single' },
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 2, blockPreference: 'single' },
        ],
        rules: { hardRules: { lockedSlots: [] }, softRules: {} },
        schedule: {
            id: 'manual_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                {
                    id: 'manual_locked_math',
                    day: 3,
                    period: 2,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math'],
                    lessonPlanId: 'lp_math',
                    locked: true,
                    manuallyAdjusted: true,
                },
                {
                    id: 'manual_cn',
                    day: 4,
                    period: 3,
                    classId: 'c1',
                    subjectId: 'chinese',
                    teacherId: 't_cn',
                    teacherIds: ['t_cn'],
                    lessonPlanId: 'lp_cn',
                    locked: false,
                    manuallyAdjusted: true,
                },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 4, completeness: 50 },
        },
    });

    const result = runTimetableScheduler(project);
    const mathSlots = result.schedule.slots.filter(slot => slot.lessonPlanId === 'lp_math');
    const chineseSlots = result.schedule.slots.filter(slot => slot.lessonPlanId === 'lp_cn');

    assert.equal(result.success, true);
    assert.equal(mathSlots.length, 2);
    assert.equal(chineseSlots.length, 2);
    assert.ok(mathSlots.some(slot => slot.day === 3 && slot.period === 2 && slot.locked === true));
    assert.ok(chineseSlots.some(slot => slot.day === 4 && slot.period === 3 && slot.manuallyAdjusted === true));
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.score.unplacedLessons, 0);
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

test('timetable roster parser normalizes lesson metadata aliases and keeps school-defined values', () => {
    const parsed = parseTimetableRosterText([
        '年级,班级,课程,教师,周课时,连堂,课型,教学资源',
        '七年级,1班,物理,程老师,4,单节,复习课、校本研修课,机房、Maker Space',
    ].join('\n'));
    const plan = parsed.lessonPlans[0];

    assert.deepEqual(plan.activityTypes, ['复习', '校本研修课']);
    assert.deepEqual(plan.requiredResourceTypes, ['计算机教室', 'Maker Space']);
    assert.equal(parsed.rooms.length, 0);
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
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.deepEqual(
        result.draftRules.advancedRules
            .filter(rule => rule.type === 'subject.preferred_day_part')
            .map(rule => [rule.target.matchedIds[0], rule.parameters.classIds])
            .sort(),
        [['english', ['c1']], ['math', ['c1']]],
    );
    assert.ok(result.draftRows.some(item => (
        item.advancedType === 'subject.preferred_day_part'
        && item.targetId === 'math'
        && item.parameters?.classIds?.includes('c1')
    )));
    assert.ok(result.draftRows.some(item => item.type === 'advanced_constraint' && item.advancedType === 'lesson.consecutive'));
});

test('timetable AI rules parser uses stable local roster suggestions without calling AI', async () => {
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
        fetchImpl: async () => {
            throw new Error('AI should not be called for roster workbooks');
        },
    });

    assert.equal(result.inputType, 'xlsx_roster');
    assert.equal(result.source, 'local_roster_fallback');
    assert.equal(result.contextStats.totalLessons, 12);
    assert.ok(result.draftRows.length > 0);
    assert.ok(result.draftRules.advancedRules.some(item => item.type === 'subject.preferred_day_part' && item.parameters.classIds.length === 1));
    assert.ok(result.draftRows.some(item => item.type === 'advanced_constraint' && item.advancedType === 'lesson.consecutive'));
    assert.equal(result.warnings.length, 0);
});

test('timetable AI rules parser parses decisive constraint Excel rows locally', async () => {
    const project = sampleProject({
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        rules: { hardRules: {}, softRules: {} },
    });
    let aiCalls = 0;
    let reviewPrompt = '';

    const result = await parseTimetableRules({
        file: {
            filename: 'constraints.xlsx',
            buffer: makeTimetableWorkbook([
                ['rule name', 'type', 'target', 'slots', 'natural language constraint'],
                ['Math later', 'subject_preferred_periods', 'Math', '1-2', '七年级1班 Math should be at Monday period 2.'],
                ['PE not first', 'subject_avoid_periods', 'PE', '1-1', '七年级2班 PE should avoid Monday period 1.'],
            ], { sheetName: 'AIConstraints' }),
        },
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (_url, options = {}) => {
            aiCalls += 1;
            const request = JSON.parse(options.body || '{}');
            reviewPrompt = request.messages?.[0]?.content || '';
            assert.match(reviewPrompt, /复审/);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({ reviewItems: [] }),
                    },
                }],
            });
        },
    });

    assert.equal(aiCalls, 1);
    assert.equal(result.aiReview?.status, 'reviewed');
    assert.equal(result.inputType, 'xlsx_constraints');
    assert.equal(result.source, 'local_xlsx');
    assert.equal(result.parseSource, 'local_xlsx');
    assert.deepEqual(result.draftRules.softRules.subjectPreferredPeriods, {});
    assert.deepEqual(
        result.draftRules.advancedRules
            .map(rule => [rule.type, rule.target.matchedIds[0], rule.parameters.classIds, rule.parameters.slots])
            .sort(),
        [
            ['subject.avoid_periods', 'pe', ['c2'], ['1-1']],
            ['subject.preferred_periods', 'math', ['c1'], ['1-2']],
        ],
    );
    assert.ok(result.draftRows.every(row => row.parseSource === 'local_xlsx'));
});

test('timetable AI rules parser supplements only unresolved constraint Excel rows', async () => {
    const project = sampleProject({
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        rules: { hardRules: {}, softRules: {} },
    });
    let observedSupplementPrompt = '';
    let observedReviewPrompt = '';

    const result = await parseTimetableRules({
        file: {
            filename: 'constraints.xlsx',
            buffer: makeTimetableWorkbook([
                ['rule name', 'type', 'target', 'slots', 'natural language constraint'],
                ['Math later', 'subject_preferred_periods', 'Math', '1-2', '七年级1班 Math should be at Monday period 2.'],
                ['Load balance', '', '', '', 'High-load teachers should not teach too many consecutive periods.'],
            ], { sheetName: 'AIConstraints' }),
        },
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            assert.equal(String(url), 'http://ai.test/chat/completions');
            const request = JSON.parse(options.body);
            const systemPrompt = request.messages?.[0]?.content || '';
            if (/复审|审计/.test(systemPrompt)) {
                observedReviewPrompt = JSON.stringify(request.messages);
                return jsonResponse({
                    choices: [{
                        message: {
                            content: JSON.stringify({ reviewItems: [] }),
                        },
                    }],
                });
            }
            observedSupplementPrompt = JSON.stringify(request.messages);
            assert.equal(request.temperature, 0);
            const promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
            const [source] = promptPayload.constraintRows || [];
            assert.ok(source?.sourceId);
            assert.ok(source?.textHash);
            assert.match(source.rawText || source.constraintText || '', /High-load teachers/);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            draftRows: [
                                {
                                    sourceId: source.sourceId,
                                    textHash: source.textHash,
                                    rawText: source.rawText || source.constraintText,
                                    type: 'teacher_load_balance',
                                    target: 'Math Teacher',
                                    priority: 'soft',
                                    reason: 'Balance workload',
                                },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(result.inputType, 'xlsx_constraints');
    assert.equal(result.source, 'mixed_xlsx');
    assert.match(observedSupplementPrompt, /High-load teachers/);
    assert.doesNotMatch(observedSupplementPrompt, /Math should be at Monday period 2/);
    assert.match(observedReviewPrompt, /Math should be at Monday period 2/);
    assert.ok(result.draftRules.advancedRules.some(rule => (
        rule.type === 'subject.preferred_periods'
        && rule.target.matchedIds.includes('math')
        && rule.parameters.classIds.includes('c1')
        && rule.parameters.slots.includes('1-2')
    )));
    assert.ok(result.previewItems.some(item => item.type === 'teacher_load_balance' && item.status === 'ready'));
    assert.equal(result.unsupportedItems.some(item => item.type === 'teacher_load_balance'), false);
    assert.deepEqual(result.draftRules.softRules.teacherLoadBalance, { enabled: true, weight: 1, explicit: true });
    assert.ok(result.draftRows.some(row => row.status === 'effective' && row.type === 'teacher_load_balance'));
    assert.ok(result.draftRows.some(row => row.parseSource === 'local_xlsx'));
    assert.ok(result.draftRows.some(row => row.parseSource === 'ai_supplement'));
});

test('timetable AI rules parser combines local AI constraint workbook rows with AI supplements', async () => {
    const project = sampleProject({
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        rules: { hardRules: {}, softRules: {} },
    });
    const workbook = await readFile(path.join(process.cwd(), 'AI排课约束建议.xlsx'));
    let observedSupplementPrompt = '';

    const result = await parseTimetableRules({
        file: {
            filename: 'AI排课约束建议.xlsx',
            buffer: workbook,
        },
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            assert.equal(String(url), 'http://ai.test/chat/completions');
            const request = JSON.parse(options.body);
            const systemPrompt = request.messages?.[0]?.content || '';
            if (/复审|审计/.test(systemPrompt)) {
                return jsonResponse({
                    choices: [{
                        message: {
                            content: JSON.stringify({ reviewItems: [] }),
                        },
                    }],
                });
            }
            observedSupplementPrompt = JSON.stringify(request.messages);
            const promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
            const source = (promptPayload.constraintRows || [])
                .find(row => /每个班每天课时数尽量均衡/.test(row.rawText || row.constraintText || ''));
            assert.ok(source?.sourceId);
            assert.ok(source?.textHash);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            draftRows: [
                                {
                                    sourceId: source.sourceId,
                                    textHash: source.textHash,
                                    rawText: source.rawText || source.constraintText,
                                    type: 'class_daily_balance',
                                    target: '全部班级',
                                    limit: 6,
                                    priority: 'soft',
                                    reason: '班级每日课量均衡',
                                },
                            ],
                            warnings: ['复杂质量建议仅作为复核建议展示'],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(result.inputType, 'xlsx_constraints');
    assert.equal(result.source, 'mixed_xlsx');
    assert.equal(result.contextStats.sheetName, 'AI约束建议');
    assert.ok(result.contextStats.rowCount >= 10);
    assert.ok(result.draftRows.length >= 3);
    assert.match(observedSupplementPrompt, /同一位教师同一时间只能给一个班上课/);
    assert.equal(result.draftRules.advancedRules.some(rule => (
        ['subject.preferred_periods', 'subject.avoid_periods', 'subject.preferred_day_part'].includes(rule.type)
    )), false);
    assert.ok(result.draftRows.some(row => row.courseScopeClarification && row.status === 'needs_review'));
    assert.ok(result.draftRows.some(row => row.status === 'effective' && row.type === 'teacher_load_balance'));
    assert.deepEqual(result.draftRules.softRules.teacherLoadBalance, { enabled: true, weight: 10, explicit: true });
    assert.deepEqual(result.draftRules.softRules.classDailyBalance, { enabled: true, mainSubjectDailyMax: 6 });
    assert.ok(result.draftRows.some(row => row.parseSource === 'local_xlsx'));
    assert.ok(result.draftRows.some(row => row.parseSource === 'ai_supplement' && row.type === 'class_daily_balance'));
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
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.equal(result.draftRows.filter(row => row.status === 'effective').length, 1);
    assert.ok(result.draftRows.some(row => row.type === 'subject_morning' && row.courseScopeClarification && row.status === 'needs_review'));
});

test('timetable smart rules accept full agent schema from the configured parser', async () => {
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

    let requestBody = null;
    let reviewRequestBody = null;
    const result = await parseTimetableRules({
        text: 'Math Teacher 周三第4节不要排。',
        project,
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'https://example.test',
            DEEPSEEK_MODEL: 'agent-test',
            TIMETABLE_RULE_AI_SEED: '20260705',
        },
        fetchImpl: async (_url, options = {}) => {
            const body = JSON.parse(options.body);
            const systemPrompt = body.messages?.[0]?.content || '';
            if (/复审|审计/.test(systemPrompt)) {
                reviewRequestBody = body;
                return {
                    ok: true,
                    status: 200,
                    async text() {
                        return JSON.stringify({
                            choices: [{
                                message: {
                                    content: JSON.stringify({ reviewItems: [] }),
                                },
                            }],
                        });
                    },
                };
            }
            requestBody = body;
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        choices: [{
                            message: {
                                content: JSON.stringify({
                                    draftRows: [{
                                        id: 'agent_row_1',
                                        rawText: 'Math Teacher 周三第4节不要排。',
                                        type: 'teacher_unavailable',
                                        targetType: 'teacher',
                                        targetName: 'Math Teacher',
                                        targetId: 't_math',
                                        slots: ['3-4'],
                                        priority: 'hard',
                                        status: 'effective',
                                        confidence: 0.93,
                                        reason: '教师不可排',
                                    }],
                                    autoAcceptable: [],
                                    needReview: [],
                                    clarifyingQuestions: [],
                                    missingInfo: [],
                                    conflicts: [],
                                    warnings: [],
                                    nextAction: 'ready_to_apply',
                                }),
                            },
                        }],
                    });
                },
            };
        },
    });

    const systemPrompt = requestBody.messages[0].content;
    assert.equal(requestBody.temperature, 0);
    assert.equal(requestBody.seed, 20260705);
    assert.ok(reviewRequestBody);
    assert.match(reviewRequestBody.messages[0].content, /复审/);
    assert.match(systemPrompt, /"draftRows"/);
    assert.match(systemPrompt, /"autoAcceptable"/);
    assert.match(systemPrompt, /"clarifyingQuestions"/);
    assert.match(systemPrompt, /"conflicts"/);
    assert.doesNotMatch(systemPrompt, /格式：\{"constraints":\[\],"warnings":\[\]\}/);
    assert.equal(result.source, 'ai');
    assert.equal(result.nextAction, 'ready_to_apply');
    assert.equal(result.autoAcceptable.length, 1);
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_math, ['3-4']);
});

test('timetable smart rules split clear local text into auto-acceptable constraints', async () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers: [{ id: 't_wang', name: '王老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = await parseTimetableRules({
        text: '王老师周三下午都没空，数学尽量排上午。',
        project,
        env: {},
    });

    const teacherRow = result.draftRows.find(row => row.type === 'teacher_unavailable');
    const subjectRow = result.draftRows.find(row => row.type === 'subject_morning');

    assert.equal(result.nextAction, 'ask_user');
    assert.equal(result.autoAcceptable.length, 1);
    assert.equal(result.needReview.length, 1);
    assert.equal(teacherRow.status, 'effective');
    assert.equal(teacherRow.targetId, 't_wang');
    assert.deepEqual(teacherRow.slots, ['3-5', '3-6', '3-7', '3-8']);
    assert.equal(subjectRow.priority, 'soft');
    assert.equal(subjectRow.courseScopeClarification, true);
    assert.equal(subjectRow.status, 'needs_review');
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_wang, ['3-5', '3-6', '3-7', '3-8']);
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.deepEqual(result.confidenceSummary, { high: 2, medium: 0, low: 0 });
});

test('timetable smart rules keep low-confidence effective rows in needReview', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_wang', name: '王老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'low_confidence_teacher',
            rawText: '王老师周三下午没空',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '王老师',
            slots: ['3-5', '3-6'],
            priority: 'hard',
            status: 'effective',
            confidence: 0.7,
        }],
    });

    assert.equal(result.autoAcceptable.length, 0);
    assert.equal(result.needReview.length, 1);
    assert.equal(result.needReview[0].id, 'low_confidence_teacher');
    assert.equal(result.nextAction, 'review');
});

test('timetable smart rules ask a clarifying question for ambiguous teachers', async () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers: [
            { id: 't_wang_ming', name: '王明', subjects: ['math'], unavailableSlots: [] },
            { id: 't_wang_hua', name: '王华', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = await parseTimetableRules({
        text: '王老师周三下午都没空。',
        project,
        env: {},
    });

    assert.equal(result.nextAction, 'ask_user');
    assert.equal(result.autoAcceptable.length, 0);
    assert.equal(result.needReview.length, 1);
    assert.equal(result.draftRows[0].status, 'needs_review');
    assert.equal(result.clarifyingQuestions.length, 1);
    assert.match(result.clarifyingQuestions[0].question, /王老师/);
    assert.deepEqual(result.clarifyingQuestions[0].options.map(item => item.value).sort(), ['t_wang_hua', 't_wang_ming']);
    assert.equal(result.draftRules.hardRules.teacherUnavailable.t_wang_ming, undefined);
});

test('timetable smart rules deduplicate clarifying questions for the same ambiguous target', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers: [
            { id: 't_wang_ming', name: '王明', subjects: ['math'], unavailableSlots: [] },
            { id: 't_wang_hua', name: '王华', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'ambiguous_1',
            rawText: '王老师周三下午没空',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '王老师',
            slots: ['3-5'],
            priority: 'hard',
            status: 'effective',
            confidence: 0.9,
        }, {
            id: 'ambiguous_2',
            rawText: '王老师周五第1节没空',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '王老师',
            slots: ['5-1'],
            priority: 'hard',
            status: 'effective',
            confidence: 0.9,
        }],
    });

    assert.equal(result.clarifyingQuestions.length, 1);
    assert.deepEqual(result.clarifyingQuestions[0].relatedRuleIds.sort(), ['ambiguous_1', 'ambiguous_2']);
});

test('timetable smart rules normalize locked slots and detect hard conflicts', async () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers: [{ id: 't_li', name: '李老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_li', weeklyHours: 4 }],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = await parseTimetableRules({
        text: '李老师周三第3节不要排。李老师必须周三第3节上高一1班数学。',
        project,
        env: {},
    });

    const locked = result.draftRows.find(row => row.type === 'locked_slot');
    assert.equal(locked.status, 'effective');
    assert.equal(locked.teacherId, 't_li');
    assert.equal(locked.classId, 'c1');
    assert.equal(locked.subjectId, 'math');
    assert.deepEqual(locked.slots, ['3-3']);
    assert.equal(result.draftRules.hardRules.lockedSlots[0].lessonPlanId, 'lp_math');
    assert.ok(result.conflicts.some(conflict => conflict.level === 'blocking' && conflict.message.includes('不可排')));
    assert.equal(result.nextAction, 'review');
});

test('timetable smart rules do not silently apply unknown subjects or unsupported AI output', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [{ id: 't_math', name: '王老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'unknown_subject',
            rawText: '物理尽量排上午',
            type: 'subject_morning',
            targetType: 'subject',
            targetName: '物理',
            priority: 'soft',
            status: 'effective',
            confidence: 0.92,
        }, {
            id: 'unsupported_ai',
            rawText: '所有老师空堂紧凑',
            type: 'teacher_free_period_compact',
            targetType: 'global',
            priority: 'soft',
            status: 'effective',
            confidence: 0.9,
        }],
    });

    assert.equal(result.nextAction, 'ask_user');
    assert.equal(result.autoAcceptable.length, 0);
    assert.equal(result.draftRows.find(row => row.id === 'unknown_subject').status, 'needs_review');
    assert.ok(result.missingInfo.some(item => item.message.includes('物理')));
    assert.equal(result.draftRows.find(row => row.id === 'unsupported_ai').status, 'unsupported');
    assert.ok(result.unsupportedItems.some(item => item.id === 'unsupported_ai'));
});

test('timetable smart rules expand all-teacher limits across uploaded teachers', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [
            { id: 't_zhang', name: '张老师', subjects: ['math'], unavailableSlots: [] },
            { id: 't_li', name: '李老师', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'all_daily',
            rawText: '每位教师每天授课量尽量均衡，单日不超过4节',
            type: 'teacher_daily_limit',
            targetType: 'teacher',
            targetName: '全部教师',
            limit: 4,
            priority: 'soft',
            status: 'effective',
            confidence: 0.9,
        }, {
            id: 'all_consecutive',
            rawText: '每位教师连续授课限制',
            type: 'teacher_consecutive_limit',
            targetType: 'teacher',
            targetName: '全部教师',
            limit: 2,
            priority: 'soft',
            status: 'effective',
            confidence: 0.9,
        }],
    });

    assert.equal(result.nextAction, 'ready_to_apply');
    assert.equal(result.needReview.length, 0);
    assert.equal(result.missingInfo.length, 0);
    assert.deepEqual(result.draftRows.map(row => row.status), ['effective', 'effective']);
    assert.deepEqual(result.draftRows.map(row => row.targetType), ['all_teachers', 'all_teachers']);
    assert.deepEqual(result.draftRules.softRules.teacherLimits.t_zhang, { daily: 4, consecutive: 2 });
    assert.deepEqual(result.draftRules.softRules.teacherLimits.t_li, { daily: 4, consecutive: 2 });
});

test('timetable smart rules do not ask object questions for all-teacher rules', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [
            { id: 't_zhang', name: 'Zhang', subjects: ['math'], unavailableSlots: [] },
            { id: 't_li', name: 'Li', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: { hardRules: {}, softRules: {} },
    });

    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'all_teacher_balance',
            rawText: 'Balance workload for all teachers',
            type: 'teacher_load_balance',
            targetType: 'teacher',
            targetName: 'all teachers',
            priority: 'soft',
            status: 'needs_review',
            confidence: 0.82,
            ambiguity: {
                field: 'target',
                targetType: 'teacher',
                targetText: 'all teachers',
                candidates: [
                    { id: 't_zhang', label: 'Zhang' },
                    { id: 't_li', label: 'Li' },
                ],
            },
            ambiguities: [{
                field: 'target',
                targetType: 'teacher',
                targetText: 'all teachers',
                candidates: [
                    { id: 't_zhang', label: 'Zhang' },
                    { id: 't_li', label: 'Li' },
                ],
            }],
        }],
    });

    const row = result.draftRows[0];
    assert.equal(row.status, 'needs_review');
    assert.equal(row.targetType, 'all_teachers');
    assert.equal(row.targetId, '__all_teachers');
    assert.equal(result.requirementItems[0].intent, 'teacher_load_balance');
    assert.equal(result.clarifyingQuestions.length, 0);
    assert.equal(result.missingInfo.length, 0);
    assert.equal(result.nextAction, 'review');
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
    assert.equal(result.draftRows.find(row => row.id === 'row_2').status, 'effective');
    assert.deepEqual(result.draftRules.softRules.teacherLoadBalance, { enabled: true, weight: 1, explicit: true });
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
        lessonPlans: [{ id: 'lp_pe', classId: 'c1', subjectId: 'pe', teacherId: 't_math', weeklyHours: 2 }],
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
            classIds: ['c1'],
            priority: 'soft',
            status: 'effective',
        }],
    });

    assert.deepEqual(result.draftRules.softRules.teacherLimits.t_math, { daily: 3 });
    assert.ok(result.draftRules.advancedRules.some(rule => (
        rule.type === 'subject.spread'
        && rule.target.matchedIds.includes('pe')
        && rule.parameters.classIds.includes('c1')
    )));
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

test('timetable constraint Excel parses decisive rows locally without AI', async () => {
    const result = await parseTimetableRules({
        file: {
            filename: 'constraints.xlsx',
            buffer: makeTimetableWorkbook([
                ['rule name', 'natural language constraint'],
                ['Teacher unavailable', '陈老师周一第1节不排'],
            ], { sheetName: 'AIConstraints' }),
        },
        project: sampleProject(),
        env: {},
    });

    assert.equal(result.inputType, 'xlsx_constraints');
    assert.equal(result.source, 'local_xlsx');
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_math, ['1-1']);
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

test('timetable project API rejects duty assignments outside duty time blocks', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-duty-validation-'));
    const timetableStore = createTimetableStore({ dataDir: process.env.TIMETABLE_DATA_DIR });
    await timetableStore.saveProject(sampleProject({
        periodTimeSegments: {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
                { id: 'evening-display', label: '晚自习展示', startTime: '19:00', periodCount: 1, classMinutes: 45, breakMinutes: 10, kind: 'display' },
            ],
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
        const response = await fetch(`${baseUrl}/api/tools/timetable/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dutyAssignments: [
                    { day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_cn' },
                    { day: 1, classId: 'c1', timeBlockId: 'evening-display', teacherId: 't_cn' },
                    { day: 1, classId: 'c1', timeBlockId: 'missing-block', teacherId: 't_cn' },
                ],
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 422);
        assert.equal(payload.success, false);
        assert.equal(payload.data.reason, 'invalid_duty_assignments');
        assert.equal(payload.data.errors.length, 2);
        const persisted = await timetableStore.loadProject();
        assert.deepEqual(persisted.dutyAssignments, []);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable project API saves early-study duty blocks without resetting formal period times', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-formalized-study-'));
    const timetableStore = createTimetableStore({ dataDir: process.env.TIMETABLE_DATA_DIR });
    await timetableStore.saveProject(sampleProject({
        activePeriods: [1, 2, 3, 4],
        periodTimes: [
            { period: 1, start: '08:00', end: '08:40' },
            { period: 2, start: '08:50', end: '09:30' },
            { period: 3, start: '09:40', end: '10:20' },
            { period: 4, start: '10:30', end: '11:10' },
        ],
        periodTimeSegments: {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早读', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            ],
        },
        dutyAssignments: [
            { day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_cn' },
        ],
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
        const periodTimes = [
            { period: 1, start: '08:10', end: '08:50' },
            { period: 2, start: '09:00', end: '09:40' },
            { period: 3, start: '09:50', end: '10:30' },
            { period: 4, start: '10:40', end: '11:20' },
        ];
        const periodTimeSegments = {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早读', startTime: '07:30', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:10', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            ],
        };
        const response = await fetch(`${baseUrl}/api/tools/timetable/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                periodTimes,
                periodTimeSegments,
                dayPartBoundaries: {
                    afternoonStartPeriod: null,
                    eveningStartPeriod: null,
                },
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.project.periodTimes, periodTimes);
        assert.deepEqual(payload.data.project.dutyAssignments, [
            { id: 'duty_1-c1-early-study-t-cn', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_cn', source: 'manual', status: 'active' },
        ]);
        assert.deepEqual(payload.data.project.periodTimeSegments.segments.map(segment => segment.kind), ['duty', 'teaching']);

        const persisted = await timetableStore.loadProject();
        assert.deepEqual(persisted.periodTimes, periodTimes);
        assert.deepEqual(persisted.dutyAssignments, [
            { id: 'duty_1-c1-early-study-t-cn', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_cn', source: 'manual', status: 'active' },
        ]);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable project API saves period times without clearing schedule and marks published draft changed', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-period-times-'));
    const timetableStore = createTimetableStore({ dataDir: process.env.TIMETABLE_DATA_DIR });
    const schedule = {
        id: 'sched_period_times',
        generatedAt: '2026-06-12T08:00:00.000Z',
        source: 'fast_constructed',
        slots: [{ id: 'slot_keep', classId: 'c1', subjectId: 'math', teacherId: 't_math', day: 1, period: 1 }],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0 },
    };
    const baseProject = sampleProject({
        activePeriods: [1, 2],
        dayPartBoundaries: { afternoonStartPeriod: null, eveningStartPeriod: null },
        periodTimes: [{ period: 1, start: '08:00', end: '08:40' }],
        schedule,
    });
    const snapshot = buildPublishedSnapshot(schedule, { summary: {} }, baseProject);
    assert.deepEqual(snapshot.projectContext.dayPartBoundaries, { afternoonStartPeriod: null, eveningStartPeriod: null });
    assert.deepEqual(snapshot.projectContext.periodTimes, [{ period: 1, start: '08:00', end: '08:40' }]);
    await timetableStore.saveProject(normalizeTimetableProject({
        ...baseProject,
        schedule: {
            ...schedule,
            published: {
                status: 'published',
                version: 1,
                scheduleId: schedule.id,
                publishedAt: '2026-06-12T08:10:00.000Z',
                fingerprint: snapshot.fingerprint,
                snapshot,
            },
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
        const response = await fetch(`${baseUrl}/api/tools/timetable/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dayPartBoundaries: {
                    afternoonStartPeriod: 2,
                    eveningStartPeriod: null,
                },
                periodTimes: [
                    { period: 1, start: '08:10', end: '08:50' },
                    { period: 2, start: '09:05', end: '09:45' },
                ],
            }),
        }).then(res => res.json());

        assert.equal(response.success, true);
        assert.deepEqual(response.data.project.periodTimes, [
            { period: 1, start: '08:10', end: '08:50' },
            { period: 2, start: '09:05', end: '09:45' },
        ]);
        assert.deepEqual(response.data.project.dayPartBoundaries, {
            afternoonStartPeriod: 2,
            eveningStartPeriod: null,
        });
        assert.equal(response.data.project.schedule.slots[0].id, 'slot_keep');
        assert.equal(response.data.project.schedule.published.status, 'draft_changed');
        assert.deepEqual(response.data.project.schedule.published.snapshot.projectContext.dayPartBoundaries, {
            afternoonStartPeriod: null,
            eveningStartPeriod: null,
        });
        assert.deepEqual(response.data.project.schedule.published.snapshot.projectContext.periodTimes, [
            { period: 1, start: '08:00', end: '08:40' },
        ]);

        const persisted = await timetableStore.loadProject();
        assert.equal(persisted.schedule.slots[0].id, 'slot_keep');
        assert.equal(persisted.schedule.published.status, 'draft_changed');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
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

test('timetable API supports the full school workflow from roster review to publish export and restore', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-school-workflow-'));
    process.env.TIMEFOLD_SOLVER_URL = '';
    resetTimetableOptimizationJobs();

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    const postJson = async (pathName, body = {}) => {
        const response = await fetch(`${baseUrl}${pathName}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const payload = await response.json();
        return { response, payload };
    };

    try {
        const projectSetup = await postJson('/api/tools/timetable/project', {
            activeWeekdays: [1, 2, 3, 4, 5],
            activePeriods: [1, 2, 3, 4, 5, 6, 7],
        });
        assert.equal(projectSetup.response.status, 200);
        assert.deepEqual(projectSetup.payload.data.project.activeWeekdays, [1, 2, 3, 4, 5]);
        assert.deepEqual(projectSetup.payload.data.project.activePeriods, [1, 2, 3, 4, 5, 6, 7]);

        const preview = await postJson('/api/tools/timetable/roster/preview', {
            text: [
                'grade,class,subject,teacher,hours,block,room,category,tags',
                'G7,1,Chinese,Ms Lin,4,single,Room 101,core,main',
                'G7,1,Math,Mr Chen,4,single,Room 101,core,main',
                'G7,1,PE,Coach Zhou,2,double,Playground,activity,sport',
                'G7,2,Chinese,Ms Lin,4,single,Room 102,core,main',
                'G7,2,Math,Mr Chen,4,single,Room 102,core,main',
                'G7,2,PE,Coach Zhou,2,double,Playground,activity,sport',
            ].join('\n'),
        });
        assert.equal(preview.response.status, 200);
        assert.equal(preview.payload.success, true);
        assert.equal(preview.payload.data.stats.classCount, 2);
        assert.equal(preview.payload.data.stats.teacherCount, 3);
        assert.equal(preview.payload.data.stats.totalLessons, 20);
        assert.equal(preview.payload.data.hasBlockingIssues, false);

        const imported = await postJson('/api/tools/timetable/roster/import', {
            rows: preview.payload.data.draftRows,
        });
        assert.equal(imported.response.status, 200);
        assert.equal(imported.payload.data.project.lessonPlans.length, 6);
        assert.equal(imported.payload.data.project.schedule, null);

        const rules = await postJson('/api/tools/timetable/rules/normalize', {
            source: 'school_workflow_review',
            inputType: 'manual',
            draftRows: [{
                id: 'workflow_rule_1',
                rawText: 'Chinese and Math should be in the morning.',
                type: 'subject_preferred_periods',
                targetType: 'subject',
                subjectName: 'Chinese',
                targetName: 'Chinese',
                slots: ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3', '3-1', '3-2', '3-3', '4-1', '4-2', '4-3', '5-1', '5-2', '5-3'],
                priority: 'soft',
                status: 'effective',
            }, {
                id: 'workflow_rule_2',
                rawText: 'Mr Chen cannot teach on Monday first period.',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                teacherName: 'Mr Chen',
                targetName: 'Mr Chen',
                slots: ['1-1'],
                priority: 'hard',
                status: 'effective',
            }],
        });
        assert.equal(rules.response.status, 200);
        assert.equal(
            Object.values(rules.payload.data.draftRules.hardRules.teacherUnavailable || {})
                .some(slots => slots.includes('1-1')),
            true,
        );

        const savedRules = await postJson('/api/tools/timetable/rules', rules.payload.data.draftRules);
        assert.equal(savedRules.response.status, 200);
        assert.equal(savedRules.payload.data.project.schedule, null);

        const run = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' }).then(async response => ({
            response,
            payload: await response.json(),
        }));
        assert.equal(run.response.status, 200);
        assert.equal(run.payload.success, true);
        assert.equal(run.payload.data.schedule.source, 'fast_constructed');
        assert.equal(run.payload.data.schedule.score.hardConflicts, 0);
        assert.equal(run.payload.data.schedule.score.unplacedLessons, 0);
        assert.equal(run.payload.data.schedule.score.totalLessons, 20);
        assert.equal(run.payload.data.schedule.publication.ok, true);
        assert.equal(run.payload.data.solverJob, null);

        const publish = await postJson('/api/tools/timetable/schedule/publish', {
            note: 'school workflow acceptance publish',
        });
        assert.equal(publish.response.status, 200);
        assert.equal(publish.payload.data.schedule.source, 'published');
        assert.equal(publish.payload.data.schedule.published.status, 'published');
        assert.equal(publish.payload.data.schedule.published.version, 1);
        assert.equal(publish.payload.data.schedule.published.snapshot.slotCount, 20);
        assert.equal(publish.payload.data.schedule.publication.ok, true);
        assert.ok(Array.isArray(publish.payload.data.schedule.publication.issueEntries));

        const officialExport = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'master' }),
        });
        assert.equal(officialExport.status, 200);
        assert.match(officialExport.headers.get('content-type') || '', /spreadsheetml\.sheet/);
        const officialWorkbook = new AdmZip(Buffer.from(await officialExport.arrayBuffer()));
        assert.ok(officialWorkbook.getEntry('xl/workbook.xml'));

        const publishedProject = publish.payload.data.project;
        const movedSlot = publishedProject.schedule.slots.find(slot => !slot.blockId || Number(slot.blockSize || 1) <= 1);
        assert.ok(movedSlot, 'expected at least one movable single-period slot');
        let target = null;
        for (const day of publishedProject.activeWeekdays) {
            for (const period of publishedProject.activePeriods) {
                if (day === movedSlot.day && period === movedSlot.period) continue;
                try {
                    const previewMove = applyScheduleAdjustment(publishedProject, {
                        type: 'move',
                        slotId: movedSlot.id,
                        day,
                        period,
                    });
                    if (previewMove.success) {
                        target = { day, period };
                        break;
                    }
                } catch {
                    // Try the next candidate cell.
                }
            }
            if (target) break;
        }
        assert.ok(target, 'expected a valid manual adjustment target');
        const manualAdjust = await postJson('/api/tools/timetable/schedule/adjust', {
            type: 'move',
            slotId: movedSlot.id,
            day: target.day,
            period: target.period,
        });
        assert.equal(manualAdjust.response.status, 200);
        assert.equal(manualAdjust.payload.data.project.schedule.source, 'manual_adjusted');
        assert.equal(manualAdjust.payload.data.project.schedule.published.status, 'draft_changed');

        const blockedOfficialExport = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'master' }),
        });
        const blockedPayload = await blockedOfficialExport.json();
        assert.equal(blockedOfficialExport.status, 422);
        assert.equal(blockedPayload.data.reason, 'publication_draft_changed');

        const publishedSnapshotExport = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'published_master' }),
        });
        assert.equal(publishedSnapshotExport.status, 200);
        assert.ok(new AdmZip(Buffer.from(await publishedSnapshotExport.arrayBuffer())).getEntry('xl/workbook.xml'));

        const restore = await postJson('/api/tools/timetable/schedule/published/restore');
        assert.equal(restore.response.status, 200);
        assert.equal(restore.payload.data.schedule.source, 'published_history_restored');
        assert.equal(restore.payload.data.schedule.slots.length, 20);
        assert.equal(restore.payload.data.schedule.publication.ok, true);
        assert.equal(restore.payload.data.schedule.solverStats.phase, 'published_history_restore');
        assert.equal(restore.payload.data.schedule.solverStats.status, 'restored');
        assert.equal(restore.payload.data.schedule.solverStats.accepted, true);
        assert.equal(restore.payload.data.schedule.published.status, 'draft_changed');
        assert.ok(restore.payload.data.schedule.publication.warnings.some(issue => issue.type === 'restored_published_draft'));
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
                ai: false,
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
        assert.equal(importPayload.data.project.rooms.length, 2);
        assert.deepEqual(
            science.allowedRoomIds.map(id => importPayload.data.project.rooms.find(room => room.id === id)?.name),
            ['Lab A', 'Lab B'],
        );
        assert.equal(importPayload.data.project.rooms.find(room => room.id === science.roomId)?.name, 'Lab A');
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
    process.env.TIMEFOLD_SOLVER_URL = '';

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

test('timetable API reports Timefold downgrade when duty assignments require local occupancy handling', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    const previousSolverUrl = process.env.TIMEFOLD_SOLVER_URL;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-duty-downgrade-'));
    process.env.TIMEFOLD_SOLVER_URL = 'http://timefold.test';

    const store = createTimetableStore();
    await store.saveProject(sampleProject({
        periodTimes: [
            { period: 1, start: '08:00', end: '08:40' },
            { period: 2, start: '08:50', end: '09:30' },
            { period: 3, start: '09:40', end: '10:20' },
            { period: 4, start: '10:30', end: '11:10' },
        ],
        periodTimeSegments: {
            globalDefaults: { classMinutes: 40, breakMinutes: 10 },
            segments: [
                { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
                { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            ],
        },
        dutyAssignments: [
            { id: 'duty-1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't_cn' },
        ],
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
        const runResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' });
        const runPayload = await runResponse.json();

        assert.equal(runResponse.status, 200);
        assert.equal(runPayload.success, true);
        assert.equal(runPayload.data.solverJob, null);
        assert.equal(runPayload.data.solverDowngrade.reason, 'duty_assignments_not_supported');
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
    process.env.TIMEFOLD_SOLVER_URL = '';

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
        assert.equal(runPayload.data.reason, 'fast_construct_failed'); // 更新：使用实际返回的reason
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
        assert.equal(stored.schedule.solverStats.phase, 'timefold_optimization');
        assert.equal(stored.schedule.solverStats.status, 'failed');
        assert.equal(stored.schedule.solverStats.accepted, false);
        assert.equal(stored.schedule.solverStats.reason, 'timeout');
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
        assert.equal(stored.schedule.solverStats.phase, 'timefold_optimization');
        assert.equal(stored.schedule.solverStats.status, 'completed');
        assert.equal(stored.schedule.solverStats.accepted, false);
        assert.equal(stored.schedule.solverStats.reason, 'not_better');
        assert.equal(stored.schedule.solverStats.qualityScoreBefore, stored.schedule.solverStats.qualityScoreAfter);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background Timefold rejection keeps latest initial-solution and pinned metadata on the preserved schedule', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-not-better-meta-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    const seeded = {
        ...fast,
        schedule: {
            ...fast.schedule,
            slots: fast.schedule.slots.map((slot, index) => (
                index === 0
                    ? { ...slot, locked: true, manuallyAdjusted: true }
                    : slot
            )),
            solverStats: {
                phase: 'manual_adjustment',
                status: 'accepted',
                accepted: true,
                reason: null,
                initialSolutionUsed: false,
                pinnedCount: 0,
            },
        },
    };
    await store.saveProject(seeded);

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            return new Response(JSON.stringify({ jobId: 'same-quality-meta-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/same-quality-meta-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'same-quality-meta-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore,
                score: `0hard/${fast.schedule.score.softScore}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/same-quality-meta-job')) {
            return new Response(JSON.stringify({
                jobId: 'same-quality-meta-job',
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
            project: seeded,
            schedule: seeded.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.same-meta', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const completed = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'completed' ? current : null;
        }, 1500);

        assert.equal(completed.accepted, false);
        assert.equal(completed.reason, 'not_better');
        assert.equal(completed.solverStats.initialSolutionUsed, true);
        assert.equal(completed.solverStats.pinnedCount, 2);

        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, seeded.schedule.id);
        assert.equal(stored.schedule.solverStats.accepted, false);
        assert.equal(stored.schedule.solverStats.reason, 'not_better');
        assert.equal(stored.schedule.solverStats.initialSolutionUsed, true);
        assert.equal(stored.schedule.solverStats.pinnedCount, 2);
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

test('background Timefold acceptance keeps restored-published review semantics on restored drafts', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-accepted-restored-draft-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    const restoredDraft = {
        ...fast,
        schedule: {
            ...fast.schedule,
            id: 'restored-draft-schedule',
            source: 'published_history_restored',
            score: {
                ...fast.schedule.score,
                softScore: Number(fast.schedule.score.softScore || 0) - 1000,
                completeness: Math.max(0, Number(fast.schedule.score.completeness || 0) - 10),
            },
            solverStats: {
                phase: 'published_history_restore',
                status: 'restored',
                accepted: true,
                reason: null,
                restoredVersion: 2,
                restoredScheduleId: 'published-v2',
            },
            published: {
                status: 'draft_changed',
                version: 2,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: 'published-v2',
                note: '恢复的发布版',
                snapshot: {
                    scheduleId: 'published-v2',
                    generatedAt: fast.schedule.generatedAt,
                    source: 'timefold_solver',
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
                history: [],
            },
        },
    };
    await store.saveProject(restoredDraft);

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            return new Response(JSON.stringify({ jobId: 'accepted-restored-draft-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/accepted-restored-draft-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'accepted-restored-draft-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: fast.schedule.score.softScore + 100,
                score: `0hard/${fast.schedule.score.softScore + 100}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/accepted-restored-draft-job')) {
            return new Response(JSON.stringify({
                jobId: 'accepted-restored-draft-job',
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
            project: restoredDraft,
            schedule: restoredDraft.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.accepted-restored-draft', TIMETABLE_SOLVER_TIMEOUT: '5' },
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
        assert.equal(stored.schedule.solverStats.phase, 'timefold_optimization');
        assert.equal(stored.schedule.solverStats.restoredVersion, 2);
        assert.equal(stored.schedule.solverStats.restoredScheduleId, 'published-v2');
        assert.equal(stored.schedule.solverStats.restoredPublishedDraft, true);
        assert.ok(stored.schedule.publication.warnings.some(issue => issue.type === 'restored_published_draft'));
        assert.ok(stored.schedule.publication.reviewItems.some(item => item.type === 'restored_published_draft'));
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background Timefold acceptance preserves manual protected slot semantics', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-api-accepted-manual-protected-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    const protectedSchedule = {
        ...fast.schedule,
        source: 'manual_adjusted',
        score: {
            ...fast.schedule.score,
            softScore: Number(fast.schedule.score.softScore || 0) - 1000,
            completeness: Math.max(0, Number(fast.schedule.score.completeness || 0) - 10),
        },
        slots: fast.schedule.slots.map((slot, index) => {
            if (index === 0) {
                return { ...slot, locked: true, manuallyAdjusted: true };
            }
            if (index === 1) {
                return { ...slot, locked: false, manuallyAdjusted: true };
            }
            return slot;
        }),
        solverStats: {
            phase: 'manual_adjustment',
            status: 'accepted',
            accepted: true,
            reason: null,
        },
    };
    await store.saveProject({
        ...fast,
        schedule: protectedSchedule,
    });

    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            return new Response(JSON.stringify({ jobId: 'accepted-manual-protected-job', solverStatus: 'SOLVING' }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/accepted-manual-protected-job/status')) {
            return new Response(JSON.stringify({
                jobId: 'accepted-manual-protected-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: protectedSchedule.score.softScore + 100,
                score: `0hard/${protectedSchedule.score.softScore + 100}soft`,
            }), { status: 200 });
        }
        if (target.endsWith('/timetable-solutions/accepted-manual-protected-job')) {
            return new Response(JSON.stringify({
                jobId: 'accepted-manual-protected-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: protectedSchedule.score.softScore + 100,
                score: `0hard/${protectedSchedule.score.softScore + 100}soft`,
                lessonAssignments: postedProblem.lessonAssignments.map(assignment => ({ ...assignment })),
            }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: { ...fast, schedule: protectedSchedule },
            schedule: protectedSchedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.accepted-manual-protected', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const completed = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'completed' && current.accepted ? current : null;
        }, 1500);

        assert.equal(completed.accepted, true);
        const stored = await store.loadProject();
        const protectedSlots = stored.schedule.slots.filter(slot => slot.manuallyAdjusted);
        assert.ok(protectedSlots.length >= 2);
        assert.equal(protectedSlots.some(slot => slot.locked === false), true);
        assert.equal(protectedSlots.some(slot => slot.locked === true), true);
        assert.equal(stored.schedule.source, 'timefold_solver');
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
        assert.equal(stored.schedule.solverStats.phase, 'timefold_optimization');
        assert.equal(stored.schedule.solverStats.status, 'skipped');
        assert.equal(stored.schedule.solverStats.accepted, false);
        assert.equal(stored.schedule.solverStats.reason, 'stale_schedule');
        assert.equal(stored.schedule.solverStats.staleRejected, true);
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
        assert.equal(stored.schedule.solverStats.phase, 'timefold_optimization');
        assert.equal(stored.schedule.solverStats.status, 'skipped');
        assert.equal(stored.schedule.solverStats.accepted, false);
        assert.equal(stored.schedule.solverStats.reason, 'published_schedule');
        assert.equal(stored.schedule.solverStats.staleRejected, true);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background stale Timefold failure is skipped and does not overwrite newer manual-adjustment solver metadata', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-timeout-manual-state-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(fast);

    const timeoutError = new Error('request timed out');
    timeoutError.name = 'TimeoutError';
    let adjustedProject = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            const latest = await store.loadProject();
            const movable = latest.schedule.slots.find(slot => !slot.locked);
            adjustedProject = applyScheduleAdjustment(latest, {
                type: 'lock',
                slotId: movable.id,
                locked: true,
            }).project;
            await store.saveProject(adjustedProject);
            throw timeoutError;
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: fast,
            schedule: fast.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.timeout-manual', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const failed = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'skipped' ? current : null;
        }, 1500);

        assert.equal(failed.reason, 'stale_schedule');
        assert.equal(failed.solverStats.staleRejected, true);
        const stored = await store.loadProject();
        assert.ok(adjustedProject);
        assert.equal(stored.schedule.source, 'manual_adjusted');
        assert.equal(stored.schedule.solverStats.phase, 'manual_adjustment');
        assert.equal(stored.schedule.solverStats.status, 'accepted');
        assert.equal(stored.schedule.solverStats.accepted, true);
        assert.equal(stored.schedule.solverStats.reason, null);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('background published Timefold failure is skipped and does not overwrite published metadata', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-timeout-published-state-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    const fast = runTimetableScheduler(sampleProject()).project;
    await store.saveProject(fast);

    const timeoutError = new Error('request timed out');
    timeoutError.name = 'TimeoutError';
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
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
                        note: 'Published before stale failure',
                    },
                },
            });
            throw timeoutError;
        }
        return new Response('{}', { status: 404 });
    };

    try {
        const job = createTimetableOptimizationJob({
            project: fast,
            schedule: fast.schedule,
            store,
            env: { TIMEFOLD_SOLVER_URL: 'http://timefold.timeout-published', TIMETABLE_SOLVER_TIMEOUT: '5' },
            fetchImpl,
        });

        const skipped = await waitFor(() => {
            const current = getTimetableOptimizationJob(job.jobId);
            return current?.status === 'skipped' ? current : null;
        }, 1500);

        assert.equal(skipped.reason, 'published_schedule');
        assert.equal(skipped.solverStats.staleRejected, true);
        const stored = await store.loadProject();
        assert.equal(stored.schedule.source, 'fast_constructed');
        assert.equal(stored.schedule.published.status, 'published');
        assert.equal(stored.schedule.solverStats.phase, 'fast_construct');
        assert.equal(stored.schedule.solverStats?.reason ?? null, null);
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
        assert.equal(blockedPayload.data.reason, 'UNPLACED_LESSONS'); // 更新：使用新的ValidationErrorCodes
        // 验证publication中有错误信息
        assert.ok(blockedPayload.data.errors || blockedPayload.data.publication);
        assert.ok(Array.isArray(blockedPayload.data.publication?.issueEntries));
        assert.ok(blockedPayload.data.publication.issueEntries.some(item => item.message.includes('未排入课表')));
        assert.deepEqual(blockedPayload.data.publication.issueEntries, blockedPayload.data.publication.reviewItems);
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
        assert.equal(republishPayload.data.schedule.solverStats?.restoredPublishedDraft, undefined);
        assert.equal(republishPayload.data.schedule.solverStats?.restoredVersion, undefined);
        assert.equal(republishPayload.data.schedule.solverStats?.restoredScheduleId, undefined);
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

test('timetable API records seed metadata from schedule run requests', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-seed-'));
    resetTimetableOptimizationJobs();

    const store = createTimetableStore();
    await store.saveProject(sampleProject());

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const runResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seed: 'api-seed-2026' }),
        });
        const runPayload = await runResponse.json();

        assert.equal(runResponse.status, 200);
        assert.equal(runPayload.success, true);
        assert.equal(runPayload.data.schedule.solverStats.seed, 'api-seed-2026');

        const stored = await store.loadProject();
        assert.equal(stored.schedule.solverStats.seed, 'api-seed-2026');
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('manual-adjusted schedules keep protected slots and seed Timefold pinned metadata on regeneration intent', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 4,
        teachers: [
            { id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] },
            { id: 't_cn', name: 'Chinese Teacher', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 90, color: '#2563eb' },
            { id: 'chinese', name: 'Chinese', priority: 88, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2, blockPreference: 'single' },
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_cn', weeklyHours: 2, blockPreference: 'single' },
        ],
        rules: { hardRules: { lockedSlots: [] }, softRules: {} },
        schedule: {
            id: 'manual_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                {
                    id: 'manual_locked_math',
                    day: 3,
                    period: 2,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math'],
                    lessonPlanId: 'lp_math',
                    locked: true,
                    manuallyAdjusted: true,
                },
                {
                    id: 'manual_cn',
                    day: 4,
                    period: 3,
                    classId: 'c1',
                    subjectId: 'chinese',
                    teacherId: 't_cn',
                    teacherIds: ['t_cn'],
                    lessonPlanId: 'lp_cn',
                    locked: false,
                    manuallyAdjusted: true,
                },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 2, totalLessons: 4, completeness: 50 },
        },
    });

    const rerun = runTimetableScheduler(project);
    const problem = buildTimetableProblem(rerun.project);
    const pinnedAssignments = problem.lessonAssignments.filter(assignment => assignment.pinnedTimeSlotId);

    assert.equal(rerun.success, true);
    assert.ok(rerun.schedule.slots.some(slot => slot.lessonPlanId === 'lp_math' && slot.day === 3 && slot.period === 2 && slot.locked));
    assert.ok(rerun.schedule.slots.some(slot => slot.lessonPlanId === 'lp_cn' && slot.day === 4 && slot.period === 3 && slot.manuallyAdjusted));
    assert.deepEqual(
        pinnedAssignments.map(assignment => [assignment.lessonPlanId, assignment.pinnedTimeSlotId]).sort(),
        [['lp_cn', '4-3'], ['lp_math', '3-2']],
    );
});

test('complex timetable scheduler allows odd and even lessons to share one cell without conflict', () => {
    const project = complexProject({
        activeWeekdays: [1],
        activePeriods: [1],
        weekdays: 1,
        periodsPerDay: 1,
        teachers: [{ id: 't_shared', name: '张老师', subjects: ['math'], unavailableSlots: [], campusId: 'north' }],
        classes: [{ id: 'c1', grade: '七年级', name: '1班', campusId: 'north' }],
        subjects: [{ id: 'math', name: '数学', priority: 95, color: '#2563eb' }],
        lessonPlans: [
            { id: 'lp_math_odd', classId: 'c1', subjectId: 'math', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'odd', campusId: 'north' },
            { id: 'lp_math_even', classId: 'c1', subjectId: 'math', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'even', campusId: 'north' },
        ],
    });

    const result = runTimetableScheduler(project, { seed: 'complex-week-pattern' });

    assert.equal(result.success, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(result.schedule.unplaced.length, 0);
    assert.deepEqual(
        result.schedule.slots
            .map(slot => [slot.lessonPlanId, slot.day, slot.period, slot.weekPattern])
            .sort(),
        [
            ['lp_math_even', 1, 1, 'even'],
            ['lp_math_odd', 1, 1, 'odd'],
        ],
    );
});

test('complex timetable scheduler expands teaching groups and uses room requirements', () => {
    const result = runTimetableScheduler(complexProject(), { seed: 'complex-group-room' });
    const groupSlot = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_music_group');
    const peSlot = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_pe_room');
    const scienceSlot = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_science_south');

    assert.equal(result.success, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.deepEqual(groupSlot.classIds, ['c1', 'c2']);
    assert.equal(groupSlot.teachingGroupId, 'tg_music');
    assert.equal(groupSlot.roomId, 'gym');
    assert.equal(peSlot.roomId, 'gym');
    assert.equal(peSlot.campusId, 'north');
    assert.equal(scienceSlot.roomId, 'lab');
    assert.equal(scienceSlot.campusId, 'south');
});

test('complex timetable scheduler preserves complex metadata for locked lessons', () => {
    const project = complexProject({
        rules: {
            hardRules: {
                lockedSlots: [
                    { id: 'locked_math_odd', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_shared', lessonPlanId: 'lp_math_odd' },
                    { id: 'locked_music_group', day: 2, period: 1, classId: 'c1', subjectId: 'music', teacherId: 't_music', lessonPlanId: 'lp_music_group', roomId: 'gym' },
                ],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
    });

    const result = runTimetableScheduler(project, { seed: 'complex-locked-metadata' });
    const oddSlot = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_math_odd' && slot.locked);
    const groupSlot = result.schedule.slots.find(slot => slot.lessonPlanId === 'lp_music_group' && slot.locked);

    assert.equal(result.success, true);
    assert.equal(result.schedule.score.hardConflicts, 0);
    assert.equal(oddSlot.weekPattern, 'odd');
    assert.equal(oddSlot.campusId, 'north');
    assert.equal(groupSlot.teachingGroupId, 'tg_music');
    assert.deepEqual(groupSlot.classIds, ['c1', 'c2']);
    assert.equal(groupSlot.roomId, 'gym');
    assert.equal(groupSlot.campusId, 'north');
});

test('complex timetable scheduler enriches protected current slots from complex lesson plans', () => {
    const project = complexProject({
        schedule: {
            id: 'complex_protected_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                {
                    id: 'manual_music_group',
                    day: 2,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'music',
                    teacherId: 't_music',
                    teacherIds: ['t_music'],
                    lessonPlanId: 'lp_music_group',
                    roomId: 'gym',
                    locked: true,
                    manuallyAdjusted: true,
                },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { totalLessons: 1, placedLessons: 1, unplacedLessons: 0, hardConflicts: 0, completeness: 20 },
        },
    });

    const result = runTimetableScheduler(project, { seed: 'complex-protected-metadata' });
    const protectedSlot = result.schedule.slots.find(slot => slot.id === 'manual_music_group');

    assert.equal(result.success, true);
    assert.equal(protectedSlot.locked, true);
    assert.equal(protectedSlot.manuallyAdjusted, true);
    assert.equal(protectedSlot.teachingGroupId, 'tg_music');
    assert.deepEqual(protectedSlot.classIds, ['c1', 'c2']);
    assert.equal(protectedSlot.roomId, 'gym');
    assert.equal(protectedSlot.campusId, 'north');
});

test('complex publication validation blocks overlapping weekPattern, teaching group, commute and room conflicts', () => {
    const project = complexProject({
        schedule: {
            id: 'complex_bad_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                { id: 'odd', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_shared', teacherIds: ['t_shared'], lessonPlanId: 'lp_math_odd', weekPattern: 'odd', campusId: 'north' },
                { id: 'every', day: 1, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_shared', teacherIds: ['t_shared'], lessonPlanId: 'lp_math_even', weekPattern: 'every', campusId: 'north' },
                { id: 'group', day: 2, period: 1, classId: 'c1', classIds: ['c1', 'c2'], subjectId: 'music', teacherId: 't_music', teacherIds: ['t_music'], lessonPlanId: 'lp_music_group', teachingGroupId: 'tg_music', roomId: 'gym', campusId: 'north' },
                { id: 'c2_math', day: 2, period: 1, classId: 'c2', subjectId: 'math', teacherId: 't_shared', teacherIds: ['t_shared'], lessonPlanId: 'lp_math_odd', weekPattern: 'every', campusId: 'north' },
                { id: 'north', day: 3, period: 1, classId: 'c1', subjectId: 'math', teacherId: 't_shared', teacherIds: ['t_shared'], lessonPlanId: 'lp_math_odd', weekPattern: 'every', campusId: 'north' },
                { id: 'south', day: 3, period: 2, classId: 'c3', subjectId: 'science', teacherId: 't_shared', teacherIds: ['t_shared'], lessonPlanId: 'lp_science_south', weekPattern: 'every', roomId: 'lab', campusId: 'south' },
                { id: 'room_a', day: 4, period: 1, classId: 'c1', subjectId: 'music', teacherId: 't_music', teacherIds: ['t_music'], lessonPlanId: 'lp_music_group', weekPattern: 'every', roomId: 'gym', campusId: 'north' },
                { id: 'room_b', day: 4, period: 1, classId: 'c2', subjectId: 'pe', teacherId: 't_pe', teacherIds: ['t_pe'], lessonPlanId: 'lp_pe_room', weekPattern: 'every', roomId: 'gym', campusId: 'north' },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { totalLessons: 8, placedLessons: 8, unplacedLessons: 0, hardConflicts: 0, completeness: 100 },
        },
    });

    const publication = validateTimetablePublication(project);
    const types = new Set(publication.issueEntries.map(item => item.type));

    assert.equal(publication.ok, false);
    assert.equal(types.has('week_pattern_conflict'), true);
    assert.equal(types.has('teaching_group_conflict'), true);
    assert.equal(types.has('campus_commute_conflict'), true);
    assert.equal(types.has('room-conflict'), true);
});

test('complex timetable export includes week pattern, campus, teaching group and room labels', () => {
    const scheduled = runTimetableScheduler(complexProject(), { seed: 'complex-export' }).project;
    const buffer = buildTimetableExportXlsx(scheduled, { type: 'master', weekView: 'merged' });
    const text = workbookText(buffer);

    assert.match(text, /单双周|周次/);
    assert.match(text, /北校区|南校区/);
    assert.match(text, /七年级音乐合班/);
    assert.match(text, /操场|实验室/);
});

test('complex timetable export filters odd and even week views', () => {
    const scheduled = runTimetableScheduler(complexProject({
        activeWeekdays: [1],
        activePeriods: [1],
        weekdays: 1,
        periodsPerDay: 1,
        teachers: [{ id: 't_shared', name: '张老师', subjects: ['alpha', 'beta'], unavailableSlots: [], campusId: 'north' }],
        classes: [{ id: 'c1', grade: '七年级', name: '1班', campusId: 'north' }],
        subjects: [
            { id: 'alpha', name: '甲课', priority: 90, color: '#2563eb' },
            { id: 'beta', name: '乙课', priority: 80, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_alpha_odd', classId: 'c1', subjectId: 'alpha', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'odd', campusId: 'north' },
            { id: 'lp_beta_even', classId: 'c1', subjectId: 'beta', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'even', campusId: 'north' },
        ],
    }), { seed: 'complex-export-week-view' }).project;

    const oddText = workbookText(buildTimetableExportXlsx(scheduled, { type: 'master', weekView: 'odd' }));
    const evenText = workbookText(buildTimetableExportXlsx(scheduled, { type: 'master', weekView: 'even' }));

    assert.match(oddText, /甲课/);
    assert.doesNotMatch(oddText, /乙课/);
    assert.match(evenText, /乙课/);
    assert.doesNotMatch(evenText, /甲课/);
});

test('timetable export API filters complex odd and even week views', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-complex-export-api-'));

    const store = createTimetableStore();
    const scheduled = runTimetableScheduler(complexProject({
        activeWeekdays: [1],
        activePeriods: [1],
        weekdays: 1,
        periodsPerDay: 1,
        teachers: [{ id: 't_shared', name: '张老师', subjects: ['alpha', 'beta'], unavailableSlots: [], campusId: 'north' }],
        classes: [{ id: 'c1', grade: '七年级', name: '1班', campusId: 'north' }],
        subjects: [
            { id: 'alpha', name: '甲课', priority: 90, color: '#2563eb' },
            { id: 'beta', name: '乙课', priority: 80, color: '#16a34a' },
        ],
        lessonPlans: [
            { id: 'lp_alpha_odd', classId: 'c1', subjectId: 'alpha', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'odd', campusId: 'north' },
            { id: 'lp_beta_even', classId: 'c1', subjectId: 'beta', teacherId: 't_shared', weeklyHours: 1, weekPattern: 'even', campusId: 'north' },
        ],
    }), { seed: 'complex-export-api-week-view' }).project;
    await store.saveProject(scheduled);

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
            body: JSON.stringify({ note: 'complex export week view' }),
        });
        assert.equal(publishResponse.status, 200);

        const oddResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'master', weekView: 'odd' }),
        });
        const evenResponse = await fetch(`${baseUrl}/api/tools/timetable/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'master', weekView: 'even' }),
        });

        assert.equal(oddResponse.status, 200);
        assert.equal(evenResponse.status, 200);
        const oddText = workbookText(Buffer.from(await oddResponse.arrayBuffer()));
        const evenText = workbookText(Buffer.from(await evenResponse.arrayBuffer()));

        assert.match(oddText, /甲课/);
        assert.doesNotMatch(oddText, /乙课/);
        assert.match(evenText, /乙课/);
        assert.doesNotMatch(evenText, /甲课/);
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

test('timetable project/rules/roster changes preserve published archive while clearing current draft', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-preserve-published-archive-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const publication = validateTimetablePublication(readyProject);
    const publishedSnapshot = {
        status: 'published',
        version: 1,
        publishedAt: '2026-01-02T08:00:00.000Z',
        scheduleId: readyProject.schedule.id,
        note: '教务处确认发布',
        snapshot: {
            scheduleId: readyProject.schedule.id,
            generatedAt: readyProject.schedule.generatedAt,
            source: readyProject.schedule.source,
            slotCount: readyProject.schedule.slots.length,
            score: readyProject.schedule.score,
            publicationSummary: publication.summary || {},
            projectContext: {
                schoolName: readyProject.schoolName,
                term: readyProject.term,
                weekdays: readyProject.weekdays,
                periodsPerDay: readyProject.periodsPerDay,
                activeWeekdays: readyProject.activeWeekdays,
                activePeriods: readyProject.activePeriods,
                teachers: readyProject.teachers,
                classes: readyProject.classes,
                subjects: readyProject.subjects,
                lessonPlans: readyProject.lessonPlans,
                rules: readyProject.rules,
            },
            slots: readyProject.schedule.slots,
        },
    };
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            published: publishedSnapshot,
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
        const projectResponse = await fetch(`${baseUrl}/api/tools/timetable/project`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeWeekdays: [1, 2, 3, 4], activePeriods: [1, 2, 3, 4, 5] }),
        });
        const projectPayload = await projectResponse.json();

        assert.equal(projectResponse.status, 200);
        assert.equal(projectPayload.data.project.schedule.slots.length, 0);
        assert.equal(projectPayload.data.project.schedule.published.status, 'draft_changed');
        assert.equal(projectPayload.data.project.schedule.published.version, 1);
        assert.ok(projectPayload.data.project.schedule.published.snapshot.projectContext);

        const rulesResponse = await fetch(`${baseUrl}/api/tools/timetable/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rules: {
                    hardRules: { teacherUnavailable: { t_math: ['3-4'] }, classUnavailable: {}, lockedSlots: [] },
                    softRules: { morningSubjects: ['math'], balancedTeacherLoad: true },
                },
            }),
        });
        const rulesPayload = await rulesResponse.json();

        assert.equal(rulesResponse.status, 200);
        assert.equal(rulesPayload.data.project.schedule.slots.length, 0);
        assert.equal(rulesPayload.data.project.schedule.published.status, 'draft_changed');
        assert.equal(rulesPayload.data.project.schedule.published.version, 1);

        const clearResponse = await fetch(`${baseUrl}/api/tools/timetable/roster/clear`, { method: 'POST' });
        const clearPayload = await clearResponse.json();

        assert.equal(clearResponse.status, 200);
        assert.equal(clearPayload.data.project.schedule.slots.length, 0);
        assert.equal(clearPayload.data.project.schedule.published.status, 'draft_changed');
        assert.equal(clearPayload.data.project.schedule.published.version, 1);

        const stored = await store.loadProject();
        assert.equal(stored.schedule.published.status, 'draft_changed');
        assert.equal(stored.schedule.published.version, 1);
        assert.ok(stored.schedule.published.snapshot.projectContext);
        assert.equal(stored.schedule.published.snapshot.projectContext.lessonPlans.length, readyProject.lessonPlans.length);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable can restore published snapshot after current draft was cleared by setup changes', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-restore-after-clear-'));

    const store = createTimetableStore();
    const readyProject = runTimetableScheduler(sampleProject()).project;
    const publication = validateTimetablePublication(readyProject);
    await store.saveProject({
        ...readyProject,
        schedule: {
            ...readyProject.schedule,
            published: {
                status: 'published',
                version: 2,
                publishedAt: '2026-01-02T08:00:00.000Z',
                scheduleId: readyProject.schedule.id,
                note: '教务处确认发布',
                snapshot: {
                    scheduleId: readyProject.schedule.id,
                    generatedAt: readyProject.schedule.generatedAt,
                    source: readyProject.schedule.source,
                    slotCount: readyProject.schedule.slots.length,
                    score: readyProject.schedule.score,
                    publicationSummary: publication.summary || {},
                    projectContext: {
                        schoolName: readyProject.schoolName,
                        term: readyProject.term,
                        weekdays: readyProject.weekdays,
                        periodsPerDay: readyProject.periodsPerDay,
                        activeWeekdays: readyProject.activeWeekdays,
                        activePeriods: readyProject.activePeriods,
                        teachers: readyProject.teachers,
                        classes: readyProject.classes,
                        subjects: readyProject.subjects,
                        lessonPlans: readyProject.lessonPlans,
                        rules: readyProject.rules,
                    },
                    slots: readyProject.schedule.slots,
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
        const clearResponse = await fetch(`${baseUrl}/api/tools/timetable/roster/clear`, { method: 'POST' });
        const clearPayload = await clearResponse.json();

        assert.equal(clearResponse.status, 200);
        assert.equal(clearPayload.data.project.schedule.published.status, 'draft_changed');
        assert.equal(clearPayload.data.project.teachers.length, 0);

        const restoreResponse = await fetch(`${baseUrl}/api/tools/timetable/schedule/published/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const restorePayload = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200);
        assert.equal(restorePayload.success, true);
        assert.equal(restorePayload.data.schedule.source, 'published_history_restored');
        assert.equal(restorePayload.data.project.teachers.length, readyProject.teachers.length);
        assert.equal(restorePayload.data.project.classes.length, readyProject.classes.length);
        assert.equal(restorePayload.data.project.subjects.length, readyProject.subjects.length);
        assert.equal(restorePayload.data.project.lessonPlans.length, readyProject.lessonPlans.length);
        assert.equal(restorePayload.data.schedule.slots.length, readyProject.schedule.slots.length);
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
        const request = JSON.parse(options.body || '{}');
        const systemPrompt = request.messages?.[0]?.content || '';
        if (/复审|审计/.test(systemPrompt)) {
            const promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
            const [source] = promptPayload.sources || [];
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            reviewItems: [{
                                verdict: 'missed_requirement',
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                target: { sourceId: source.sourceId, textHash: source.textHash },
                                fieldPath: 'clauses',
                                evidence: { quote: 'Math in morning' },
                                reason: 'The local baseline omitted the independent morning preference.',
                                suggestedRequirement: {
                                    intent: 'subject_morning',
                                    object: {
                                        kind: 'subject',
                                        name: 'Math',
                                        matchedIds: ['math'],
                                        scope: 'explicit',
                                    },
                                    parameters: { periods: [1, 2, 3, 4] },
                                    strength: 'soft',
                                },
                            }],
                        }),
                    },
                }],
            });
        }
        const promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
        const [source] = promptPayload.sources || [];
        assert.ok(source?.sourceId);
        assert.ok(source?.textHash);
        return jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        results: [{
                            sourceId: source.sourceId,
                            textHash: source.textHash,
                            clauses: [{
                                intent: 'teacher_unavailable',
                                targetKind: 'teacher',
                                targetNames: ['Math Teacher'],
                                time: { slots: ['3-4'] },
                                strength: 'hard',
                                confidence: 0.95,
                                evidence: 'Math Teacher Wednesday period 4 unavailable',
                            }, {
                                intent: 'subject_morning',
                                targetKind: 'subject',
                                targetNames: ['Math'],
                                strength: 'soft',
                                confidence: 0.95,
                                evidence: 'Math in morning',
                            }],
                        }],
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
        assert.equal(payload.data.aiReview.status, 'reviewed');
        assert.equal(payload.data.aiReview.reviewItems[0]?.validationStatus, 'accepted');
        assert.equal(payload.data.aiCandidateValidation?.unverifiedCandidateCount, 0);
        assert.ok(
            payload.data.constraintIRs.some(item => (
                item.capabilityId === 'subject.preferred_day_part'
                && item.executionStatus === 'blocked_by_clarification'
                && item.machineRuleIds.length === 0
            )),
            JSON.stringify({
                draftRows: payload.data.draftRows,
                constraintIRs: payload.data.constraintIRs,
                aiReview: payload.data.aiReview,
            }),
        );
        assert.deepEqual(payload.data.draftRules.hardRules.teacherUnavailable.t_math, ['3-4']);
        assert.deepEqual(payload.data.draftRules.softRules.morningSubjects, []);
        assert.ok(payload.data.draftRows.some(row => row.courseScopeClarification && row.status === 'needs_review'));
        assert.equal(payload.data.previewItems.length, 2);
        assert.equal(payload.data.parseSource, 'ai_extract');

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
        const request = JSON.parse(options.body || '{}');
        const systemPrompt = request.messages?.[0]?.content || '';
        if (/复审|审计/.test(systemPrompt)) {
            return jsonResponse({
                choices: [{ message: { content: JSON.stringify({ reviewItems: [] }) } }],
            });
        }
        const promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
        const [source] = promptPayload.constraintRows || [];
        assert.ok(source?.sourceId);
        assert.ok(source?.textHash);
        return jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        draftRows: [
                            {
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                rawText: source.rawText || source.constraintText,
                                type: 'subject_preferred_periods',
                                targetId: 'math',
                                slots: ['2-1'],
                                priority: 'soft',
                                reason: 'Prefer Monday',
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
        assert.deepEqual(payload.data.draftRules.softRules.subjectPreferredPeriods, {});
        assert.ok(payload.data.draftRows.some(row => row.courseScopeClarification && row.status === 'needs_review'));

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
        assert.equal(payload.data.draftRows.find(row => row.id === 'review_2').status, 'effective');
        assert.deepEqual(payload.data.draftRules.softRules.teacherLoadBalance, { enabled: true, weight: 1, explicit: true });

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

test('timetable rules fulfillment API evaluates request project without saving it', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-rules-fulfillment-'));

    const store = createTimetableStore();
    const storedProject = sampleProject({
        rules: { hardRules: {}, softRules: {} },
        schedule: null,
    });
    await store.saveProject(storedProject);

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/rules/fulfillment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: constraintFulfillmentProject() }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.fulfillment.version, 2);
        assert.equal(payload.data.fulfillment.summary.total, 9);
        assert.equal(payload.data.fulfillment.summary.violated, 6);
        assert.equal(payload.data.fulfillment.summary.unmet, 6);

        const storedAfter = await store.loadProject();
        assert.deepEqual(storedAfter.rules, storedProject.rules);
        assert.equal(storedAfter.schedule, null);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable rules fulfillment action API saves a supported delete action', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-rules-fulfillment-action-'));

    const store = createTimetableStore();
    await store.saveProject(constraintFulfillmentProject());

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/rules/fulfillment/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: {
                    kind: 'delete_rule',
                    ruleId: 'teacher_unavailable:t_math:1-1',
                },
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.action.type, 'teacher_unavailable');
        assert.equal(payload.data.fulfillment.summary.total, 8);

        const storedAfter = await store.loadProject();
        assert.deepEqual(storedAfter.rules.hardRules.teacherUnavailable, {});
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});

test('timetable rules clarify and diagnose APIs support autonomous review flow', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-rules-clarify-'));

    const store = createTimetableStore();
    await store.saveProject(createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        teachers: [
            { id: 't_wang_ming', name: '王明', subjects: ['math'], unavailableSlots: [] },
            { id: 't_wang_hua', name: '王华', subjects: ['math'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: '高一', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 90, color: '#2563eb' }],
        lessonPlans: [],
        rules: {
            hardRules: {
                teacherUnavailable: { t_wang_ming: ['1-1', '1-2', '1-3', '1-4', '1-5', '1-6'] },
                classUnavailable: {},
                lockedSlots: [],
            },
            softRules: {},
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
        const draftRows = [{
            id: 'ambiguous_1',
            rawText: '王老师周三下午不要排',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '王老师',
            slots: ['3-5'],
            priority: 'hard',
            status: 'needs_review',
            confidence: 0.7,
            ambiguity: {
                field: 'target',
                targetType: 'teacher',
                targetText: '王老师',
                candidates: [
                    { id: 't_wang_ming', label: '王明' },
                    { id: 't_wang_hua', label: '王华' },
                ],
            },
        }];
        const clarifyResponse = await fetch(`${baseUrl}/api/tools/timetable/rules/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                originalText: '王老师周三下午不要排',
                previousResult: { draftRows },
                answers: [{
                    questionId: 'q_ambiguous_1_target',
                    value: 't_wang_hua',
                    label: '王华',
                    targetType: 'teacher',
                    targetText: '王老师',
                }],
            }),
        });
        const clarified = await clarifyResponse.json();

        assert.equal(clarifyResponse.status, 200);
        assert.equal(clarified.data.draftRows[0].status, 'effective');
        assert.equal(clarified.data.draftRows[0].targetId, 't_wang_hua');
        assert.equal(clarified.data.draftRows[0].ambiguity, null);
        assert.equal((clarified.data.draftRows[0].ambiguities || []).length, 0);
        assert.equal(clarified.data.clarifyingQuestions.length, 0);
        assert.deepEqual(clarified.data.draftRules.hardRules.teacherUnavailable.t_wang_hua, ['3-5']);

        const diagnoseResponse = await fetch(`${baseUrl}/api/tools/timetable/rules/diagnose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draftRows: clarified.data.draftRows }),
        });
        const diagnosed = await diagnoseResponse.json();

        assert.equal(diagnoseResponse.status, 200);
        assert.match(diagnosed.data.diagnosis.summary, /约束|风险|无解/);
        assert.ok(diagnosed.data.diagnosis.suggestedRelaxations.length >= 1);
        assert.ok(diagnosed.data.diagnosis.blockingRules.some(item => item.includes('王明')));
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
