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

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return status === 204 ? '' : JSON.stringify(payload);
        },
    };
}
