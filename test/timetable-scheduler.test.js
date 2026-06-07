import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import { parseTimetableRosterText } from '../gateway/services/timetable-import.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';
import {
    applyScheduleAdjustment,
    createDefaultTimetableProject,
    runTimetableScheduler,
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

test('timetable scheduler creates a reproducible conflict-free schedule', () => {
    const result = runTimetableScheduler(sampleProject());

    assert.equal(result.success, true);
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
        assert.equal(runRes.data.schedule.source, 'timefold_solver');
        assert.equal(runRes.data.schedule.score.hardConflicts, 0);
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

test('timetable API does not overwrite the stored schedule when Timefold is unavailable', async () => {
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

        assert.equal(runResponse.status, 503);
        assert.equal(runPayload.success, false);
        assert.equal(runPayload.data.schedule.id, 'old_schedule');

        const stored = await store.loadProject();
        assert.equal(stored.schedule.id, 'old_schedule');
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

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return status === 204 ? '' : JSON.stringify(payload);
        },
    };
}
