import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildTimetableProblem,
    solveTimetableWithTimefold,
    TimetableTimefoldError,
    transformTimetableSolutionToSchedule,
} from '../gateway/services/timetable-solver-bridge.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';

function sampleProject(overrides = {}) {
    return createDefaultTimetableProject({
        schoolName: 'Solver School',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 4,
        teachers: [
            { id: 't_math', name: 'Math', subjects: ['math'], unavailableSlots: ['5-4'] },
            { id: 't_helper', name: 'Helper', subjects: ['math'], unavailableSlots: [] },
            { id: 't_pe', name: 'PE', subjects: ['pe'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [
            { id: 'math', name: 'Math', priority: 98, color: '#14b8a6' },
            { id: 'pe', name: 'PE', priority: 35, color: '#f97316' },
        ],
        lessonPlans: [
            {
                id: 'lp_math',
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math', 't_helper'],
                weeklyHours: 2,
                blockPreference: 'double',
            },
            {
                id: 'lp_pe',
                classId: 'c1',
                subjectId: 'pe',
                teacherId: 't_pe',
                weeklyHours: 1,
                roomId: 'gym',
                blockPreference: 'single',
            },
        ],
        rules: {
            hardRules: {
                lockedSlots: [
                    { day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                ],
                teacherUnavailable: { t_helper: ['1-1'] },
                classUnavailable: { c1: ['1-2'] },
            },
            softRules: { morningSubjects: ['math'], balancedTeacherLoad: true },
        },
        ...overrides,
    });
}

test('buildTimetableProblem expands lessons, blocks, multi-teachers and hard rules', () => {
    const problem = buildTimetableProblem(sampleProject());

    assert.equal(problem.timeSlots.length, 20);
    assert.deepEqual(problem.rooms.map(room => room.id), ['__NONE__', 'gym']);
    assert.equal(problem.lessonAssignments.length, 3);

    const math = problem.lessonAssignments.filter(assignment => assignment.lessonPlanId === 'lp_math');
    assert.equal(math.length, 2);
    assert.equal(new Set(math.map(assignment => assignment.blockId)).size, 1);
    assert.deepEqual(math.map(assignment => assignment.blockIndex), [0, 1]);
    assert.deepEqual(math[0].teacherIds, ['t_math', 't_helper']);
    assert.equal(math[0].pinnedTimeSlotId, '2-3');
    assert.ok(math[0].blockedTimeSlotIds.includes('1-1'));
    assert.ok(math[0].blockedTimeSlotIds.includes('1-2'));

    const pe = problem.lessonAssignments.find(assignment => assignment.lessonPlanId === 'lp_pe');
    assert.equal(pe.requiresRoom, true);
    assert.deepEqual(pe.allowedRoomIds, ['gym']);
});

test('buildTimetableProblem only exposes active timetable slots to Timefold', () => {
    const problem = buildTimetableProblem(sampleProject({
        activeWeekdays: [1, 3],
        activePeriods: [2, 4],
    }));

    assert.deepEqual(problem.timeSlots.map(slot => slot.id), ['1-2', '1-4', '3-2', '3-4']);
    assert.equal(problem.timeSlots.every(slot => slot.morning === (slot.lessonIndex === 2)), true);
});

test('buildTimetableProblem mirrors fast scheduler mixed block splitting', () => {
    const problem = buildTimetableProblem(sampleProject({
        lessonPlans: [
            {
                id: 'lp_sci',
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                weeklyHours: 6,
                blockPreference: 'mixed',
            },
        ],
        rules: { hardRules: { lockedSlots: [], teacherUnavailable: {}, classUnavailable: {} }, softRules: {} },
        schedule: null,
    }));

    const assignments = problem.lessonAssignments.filter(assignment => assignment.lessonPlanId === 'lp_sci');
    const doubleBlocks = new Set(assignments.filter(assignment => assignment.blockSize === 2).map(assignment => assignment.blockId));
    const singleAssignments = assignments.filter(assignment => assignment.blockSize === 1);

    assert.equal(assignments.length, 6);
    assert.deepEqual(assignments.map(assignment => assignment.blockSize), [2, 2, 2, 2, 1, 1]);
    assert.equal(doubleBlocks.size, 2);
    assert.equal(singleAssignments.length, 2);
});

test('buildTimetableProblem sends current schedule as initial solution and pins protected slots', () => {
    const project = sampleProject({
        rules: { hardRules: { lockedSlots: [], teacherUnavailable: {}, classUnavailable: {} }, softRules: {} },
        schedule: {
            id: 'manual-schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                {
                    id: 'math_1',
                    day: 1,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math', 't_helper'],
                    lessonPlanId: 'lp_math',
                    blockId: 'lp_math_block_1',
                    blockIndex: 0,
                    blockSize: 2,
                    locked: true,
                },
                {
                    id: 'math_2',
                    day: 1,
                    period: 2,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math', 't_helper'],
                    lessonPlanId: 'lp_math',
                    blockId: 'lp_math_block_1',
                    blockIndex: 1,
                    blockSize: 2,
                    locked: true,
                },
                {
                    id: 'pe_1',
                    day: 3,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'pe',
                    teacherId: 't_pe',
                    teacherIds: ['t_pe'],
                    lessonPlanId: 'lp_pe',
                    roomId: 'gym',
                    manuallyAdjusted: true,
                },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 3, totalLessons: 3, completeness: 100 },
        },
    });

    const problem = buildTimetableProblem(project);
    const math = problem.lessonAssignments.filter(assignment => assignment.lessonPlanId === 'lp_math');
    const pe = problem.lessonAssignments.find(assignment => assignment.lessonPlanId === 'lp_pe');

    assert.deepEqual(math.map(assignment => assignment.timeSlot), ['1-1', '1-2']);
    assert.deepEqual(math.map(assignment => assignment.pinnedTimeSlotId), ['1-1', '1-2']);
    assert.equal(pe.timeSlot, '3-1');
    assert.equal(pe.room, 'gym');
    assert.equal(pe.pinnedTimeSlotId, '3-1');
});

test('buildTimetableProblem protects an entire double block when one block slot is locked by rule', () => {
    const project = sampleProject({
        lessonPlans: [
            {
                id: 'lp_math',
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math', 't_helper'],
                weeklyHours: 2,
                blockPreference: 'double',
            },
        ],
        rules: {
            hardRules: {
                lockedSlots: [
                    { day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                ],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
        schedule: null,
    });

    const problem = buildTimetableProblem(project);
    const math = problem.lessonAssignments
        .filter(assignment => assignment.lessonPlanId === 'lp_math')
        .sort((left, right) => left.blockIndex - right.blockIndex);

    assert.equal(math.length, 2);
    assert.deepEqual(math.map(assignment => assignment.pinnedTimeSlotId), ['2-3', '2-4']);
    assert.deepEqual(math.map(assignment => assignment.timeSlot), ['2-3', '2-4']);
    assert.equal(new Set(math.map(assignment => assignment.blockId)).size, 1);
});

test('buildTimetableProblem anchors a locked double block backward from the last active period', () => {
    const project = sampleProject({
        periodsPerDay: 5,
        activePeriods: [1, 2, 3, 4, 5],
        lessonPlans: [
            {
                id: 'lp_math',
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math', 't_helper'],
                weeklyHours: 2,
                blockPreference: 'double',
            },
        ],
        rules: {
            hardRules: {
                lockedSlots: [
                    { day: 2, period: 5, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                ],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
        schedule: null,
    });

    const problem = buildTimetableProblem(project);
    const math = problem.lessonAssignments
        .filter(assignment => assignment.lessonPlanId === 'lp_math')
        .sort((left, right) => left.blockIndex - right.blockIndex);

    assert.equal(math.length, 2);
    assert.deepEqual(math.map(assignment => assignment.pinnedTimeSlotId), ['2-4', '2-5']);
    assert.deepEqual(math.map(assignment => assignment.timeSlot), ['2-4', '2-5']);
});

test('buildTimetableProblem deduplicates locked cells that belong to the same double block', () => {
    const project = sampleProject({
        periodsPerDay: 5,
        activePeriods: [1, 2, 3, 4, 5],
        lessonPlans: [
            {
                id: 'lp_math',
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_math',
                teacherIds: ['t_math', 't_helper'],
                weeklyHours: 4,
                blockPreference: 'double',
            },
        ],
        rules: {
            hardRules: {
                lockedSlots: [
                    { day: 2, period: 4, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                    { day: 2, period: 3, classId: 'c1', subjectId: 'math', teacherId: 't_math', lessonPlanId: 'lp_math' },
                ],
                teacherUnavailable: {},
                classUnavailable: {},
            },
            softRules: {},
        },
        schedule: null,
    });

    const problem = buildTimetableProblem(project);
    const math = problem.lessonAssignments
        .filter(assignment => assignment.lessonPlanId === 'lp_math')
        .sort((left, right) => left.sequence - right.sequence);

    assert.equal(math.length, 4);
    assert.deepEqual(math.map(assignment => assignment.pinnedTimeSlotId), ['2-3', '2-4', null, null]);
    assert.deepEqual(math.map(assignment => assignment.timeSlot), ['2-3', '2-4', null, null]);
});

test('transformTimetableSolutionToSchedule keeps current schedule shape and solver metadata', () => {
    const project = sampleProject();
    const problem = buildTimetableProblem(project);
    const solved = {
        jobId: 'job-1',
        solverStatus: 'NOT_SOLVING',
        score: '0hard/-8soft',
        hardScore: 0,
        softScore: -8,
        lessonAssignments: problem.lessonAssignments.map((assignment, index) => ({
            ...assignment,
            timeSlot: assignment.lessonPlanId === 'lp_math'
                ? (assignment.blockIndex === 0 ? '2-3' : '2-4')
                : '3-1',
            room: assignment.lessonPlanId === 'lp_pe' ? 'gym' : '__NONE__',
            sequence: index,
        })),
    };

    const schedule = transformTimetableSolutionToSchedule(project, solved, { durationMs: 42 });

    assert.equal(schedule.source, 'timefold_solver');
    assert.equal(schedule.solverStats.solverUsed, true);
    assert.equal(schedule.solverStats.score, '0hard/-8soft');
    assert.equal(schedule.score.hardConflicts, 0);
    assert.equal(schedule.score.unplacedLessons, 0);
    assert.equal(schedule.slots.length, 3);
    assert.deepEqual(schedule.slots.find(slot => slot.lessonPlanId === 'lp_pe').roomId, 'gym');
    assert.deepEqual(schedule.slots.find(slot => slot.lessonPlanId === 'lp_math').teacherIds, ['t_math', 't_helper']);
    assert.equal(schedule.slots.filter(slot => slot.blockId).length, 2);
});

test('transformTimetableSolutionToSchedule preserves manual protected slots without converting them into locked slots', () => {
    const project = sampleProject({
        rules: { hardRules: { lockedSlots: [], teacherUnavailable: {}, classUnavailable: {} }, softRules: {} },
        schedule: {
            id: 'manual-seeded',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'manual_adjusted',
            slots: [
                {
                    id: 'math_1',
                    day: 1,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math', 't_helper'],
                    lessonPlanId: 'lp_math',
                    blockId: 'lp_math_block_1',
                    blockIndex: 0,
                    blockSize: 2,
                    locked: true,
                    manuallyAdjusted: true,
                },
                {
                    id: 'math_2',
                    day: 1,
                    period: 2,
                    classId: 'c1',
                    subjectId: 'math',
                    teacherId: 't_math',
                    teacherIds: ['t_math', 't_helper'],
                    lessonPlanId: 'lp_math',
                    blockId: 'lp_math_block_1',
                    blockIndex: 1,
                    blockSize: 2,
                    locked: true,
                    manuallyAdjusted: true,
                },
                {
                    id: 'pe_1',
                    day: 3,
                    period: 1,
                    classId: 'c1',
                    subjectId: 'pe',
                    teacherId: 't_pe',
                    teacherIds: ['t_pe'],
                    lessonPlanId: 'lp_pe',
                    roomId: 'gym',
                    locked: false,
                    manuallyAdjusted: true,
                },
            ],
            lockedSlots: [],
            conflicts: [],
            unplaced: [],
            score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 3, totalLessons: 3, completeness: 100 },
        },
    });

    const problem = buildTimetableProblem(project);
    const solved = {
        jobId: 'job-manual-shape',
        solverStatus: 'NOT_SOLVING',
        score: '0hard/-4soft',
        hardScore: 0,
        softScore: -4,
        lessonAssignments: problem.lessonAssignments.map(assignment => ({
            ...assignment,
            timeSlot: assignment.timeSlot,
            room: assignment.room || '__NONE__',
        })),
    };

    const schedule = transformTimetableSolutionToSchedule(project, solved, { durationMs: 12 });
    const peSlot = schedule.slots.find(slot => slot.lessonPlanId === 'lp_pe');
    const mathSlots = schedule.slots.filter(slot => slot.lessonPlanId === 'lp_math');

    assert.equal(peSlot.locked, false);
    assert.equal(peSlot.manuallyAdjusted, true);
    assert.equal(mathSlots.every(slot => slot.locked), true);
    assert.equal(mathSlots.every(slot => slot.manuallyAdjusted), true);
});

test('solveTimetableWithTimefold rejects solutions that move pinned assignments', async () => {
    let postedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (options.method === 'POST') {
            postedProblem = JSON.parse(options.body);
            return jsonResponse({ jobId: 'job-pinned', solverStatus: 'SOLVING_ACTIVE' }, 202);
        }
        if (target.endsWith('/status')) {
            return jsonResponse({ jobId: 'job-pinned', solverStatus: 'NOT_SOLVING', hardScore: 0, softScore: 20 }, 200);
        }
        if (options.method === 'DELETE') return jsonResponse({}, 204);
        return jsonResponse({
            jobId: 'job-pinned',
            solverStatus: 'NOT_SOLVING',
            hardScore: 0,
            softScore: 20,
            lessonAssignments: postedProblem.lessonAssignments.map(assignment => ({
                ...assignment,
                timeSlot: assignment.pinnedTimeSlotId ? '4-4' : (assignment.timeSlot || '1-1'),
                room: assignment.room || '__NONE__',
            })),
        }, 200);
    };

    await assert.rejects(() => solveTimetableWithTimefold({
        project: sampleProject(),
        env: { TIMEFOLD_SOLVER_URL: 'http://solver', TIMETABLE_SOLVER_TIMEOUT: '2' },
        fetchImpl,
    }), error => (
        error instanceof TimetableTimefoldError
        && error.reason === 'pinned_slot_moved'
        && error.solverStats.pinnedCount > 0
    ));
});

test('solveTimetableWithTimefold rejects unavailable solver before mutating project', async () => {
    await assert.rejects(() => solveTimetableWithTimefold({
        project: sampleProject(),
        env: {},
    }), error => error instanceof TimetableTimefoldError && error.reason === 'not_configured' && error.status === 503);
});

test('solveTimetableWithTimefold explains missing timetable endpoint on stale solver jars', async () => {
    const fetchImpl = async () => jsonResponse({}, 404);

    await assert.rejects(() => solveTimetableWithTimefold({
        project: sampleProject(),
        env: { TIMEFOLD_SOLVER_URL: 'http://solver', TIMETABLE_SOLVER_TIMEOUT: '2' },
        fetchImpl,
    }), error => (
        error instanceof TimetableTimefoldError
        && error.reason === 'endpoint_missing'
        && error.status === 404
        && /timetable endpoint/i.test(error.message)
    ));
});

test('solveTimetableWithTimefold maps request aborts to timeout metadata', async () => {
    const timeoutError = new Error('request timed out');
    timeoutError.name = 'TimeoutError';

    await assert.rejects(() => solveTimetableWithTimefold({
        project: sampleProject(),
        env: { TIMEFOLD_SOLVER_URL: 'http://solver' },
        fetchImpl: async () => {
            throw timeoutError;
        },
    }), error => (
        error instanceof TimetableTimefoldError
        && error.reason === 'timeout'
        && error.status === 504
        && error.solverStats.lessonCount === 3
        && error.solverStats.timeoutSeconds === 210
        && Number.isInteger(error.solverStats.durationMs)
    ));
});

test('solveTimetableWithTimefold rejects hard-score violations and terminates jobs', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET' });
        if (options.method === 'POST') return jsonResponse({ jobId: 'job-1', solverStatus: 'SOLVING_ACTIVE' }, 202);
        if (String(url).endsWith('/status')) return jsonResponse({ jobId: 'job-1', solverStatus: 'NOT_SOLVING', hardScore: -1 }, 200);
        if (options.method === 'DELETE') return jsonResponse({}, 204);
        return jsonResponse({ jobId: 'job-1', hardScore: -1, softScore: 0, lessonAssignments: [] }, 200);
    };

    await assert.rejects(() => solveTimetableWithTimefold({
        project: sampleProject(),
        env: { TIMEFOLD_SOLVER_URL: 'http://solver', TIMETABLE_SOLVER_TIMEOUT: '2' },
        fetchImpl,
    }), error => error instanceof TimetableTimefoldError && error.reason === 'hard_score_violation' && error.status === 422);

    assert.equal(calls.some(call => call.method === 'DELETE'), true);
});

test('solveTimetableWithTimefold rejects complex model until Timefold supports it', async () => {
    const project = sampleProject({
        timetableModelVersion: 'complex_v1',
        lessonPlans: [
            { id: 'lp_odd', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1, weekPattern: 'odd' },
            { id: 'lp_even', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1, weekPattern: 'even' },
        ],
    });

    await assert.rejects(() => solveTimetableWithTimefold({
        project,
        env: { TIMEFOLD_SOLVER_URL: 'http://solver', TIMETABLE_SOLVER_TIMEOUT: '2' },
        fetchImpl: async () => {
            throw new Error('Timefold should not be called for complex_v1 without support');
        },
    }), error => (
        error instanceof TimetableTimefoldError
        && error.reason === 'complex_model_not_supported'
        && error.status === 409
        && error.solverStats?.accepted === false
    ));
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
