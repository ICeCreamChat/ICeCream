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
    getTimetableOptimizationJob,
    resetTimetableOptimizationJobs,
} from '../gateway/services/timetable-optimization-jobs.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';
import { validateTimetableProjectForSolve } from '../gateway/services/timetable-validation.js';
import {
    applyScheduleAdjustment,
    createDefaultTimetableProject,
    normalizeTimetableProject,
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

function makeTimetableWorkbook(rows) {
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

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return status === 204 ? '' : JSON.stringify(payload);
        },
    };
}
