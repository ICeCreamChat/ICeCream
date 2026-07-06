import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getActivePeriods as getModelActivePeriods,
    normalizeTimetableProject,
    suggestTimeBlockKind,
    validateDutyAssignments,
} from '../gateway/services/timetable-project.js';
import {
    getActivePeriods as getUiActivePeriods,
    getTotalPeriods as getUiTotalPeriods,
} from '../public/js/tools/timetable/selectors.js';

const studyBlockProjectInput = {
    periodsPerDay: 10,
    teachers: [{ id: 't1', name: '王老师' }, { id: 't2', name: '李老师' }],
    classes: [{ id: 'c1', grade: '七年级', name: '1班' }],
    subjects: [{ id: 'math', name: '数学' }],
    lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't2', weeklyHours: 4 }],
    periodTimeSegments: {
        globalDefaults: { classMinutes: 40, breakMinutes: 10 },
        segments: [
            { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, classMinutes: 30, breakMinutes: 10, kind: 'duty' },
            { id: 'morning', label: '上午', startTime: '08:00', periodCount: 4, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            { id: 'afternoon', label: '下午', startTime: '14:00', periodCount: 3, classMinutes: 40, breakMinutes: 10, kind: 'teaching' },
            { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 2, classMinutes: 45, breakMinutes: 10, kind: 'display' },
        ],
    },
    dutyAssignments: [
        { id: 'duty-1', day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't1', source: 'manual' },
        { id: 'invalid-display-duty', day: 1, classId: 'c1', timeBlockId: 'evening-study', teacherId: 't1' },
    ],
};

test('time block kinds derive active periods from all non-display blocks and preserve duty assignments separately', () => {
    const project = normalizeTimetableProject(studyBlockProjectInput);

    assert.deepEqual(project.activePeriods, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(project.periodsPerDay, 8);
    assert.deepEqual(getModelActivePeriods(project), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(project.periodTimeSegments.segments[0].kind, 'duty');
    assert.equal(project.periodTimeSegments.segments[1].kind, 'teaching');
    assert.equal(project.periodTimeSegments.segments[3].kind, 'display');
    assert.deepEqual(project.dutyAssignments, [{
        id: 'duty-1',
        day: 1,
        classId: 'c1',
        timeBlockId: 'early-study',
        teacherId: 't1',
        source: 'manual',
        status: 'active',
    }]);
    assert.equal(project.lessonPlans.length, 1);
    assert.equal(project.lessonPlans[0].weeklyHours, 4);
});

test('legacy time segments without kind remain formal teaching periods', () => {
    const project = normalizeTimetableProject({
        periodsPerDay: 3,
        periodTimeSegments: {
            segments: [
                { id: 'seg-1', label: '早读', startTime: '07:30', periodCount: 1 },
                { id: 'seg-2', label: '上午', startTime: '08:10', periodCount: 2 },
            ],
        },
    });

    assert.deepEqual(project.activePeriods, [1, 2, 3]);
    assert.equal(project.periodsPerDay, 3);
    assert.deepEqual(project.periodTimeSegments.segments.map(segment => segment.kind), ['teaching', 'teaching']);
    assert.equal(suggestTimeBlockKind(project.periodTimeSegments.segments[0]), 'duty');
});

test('frontend selectors count non-display blocks as active formal periods', () => {
    const project = normalizeTimetableProject(studyBlockProjectInput);

    assert.equal(getUiTotalPeriods(project), 10);
    assert.deepEqual(getUiActivePeriods(project), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('projects with only duty and display blocks keep duty as an active period', () => {
    const project = normalizeTimetableProject({
        periodsPerDay: 2,
        periodTimeSegments: {
            segments: [
                { id: 'early-study', label: '早自习', startTime: '07:20', periodCount: 1, kind: 'duty' },
                { id: 'evening-study', label: '晚自习', startTime: '19:00', periodCount: 1, kind: 'display' },
            ],
        },
    });

    assert.deepEqual(project.activePeriods, [1]);
    assert.deepEqual(getModelActivePeriods(project), [1]);
    assert.deepEqual(getUiActivePeriods(project), [1]);
});

test('duty assignment validation rejects non-duty or unknown time blocks before save', () => {
    const project = normalizeTimetableProject(studyBlockProjectInput);

    const validation = validateDutyAssignments([
        { day: 1, classId: 'c1', timeBlockId: 'early-study', teacherId: 't1' },
        { day: 1, classId: 'c1', timeBlockId: 'evening-study', teacherId: 't1' },
        { day: 1, classId: 'c1', timeBlockId: 'missing-block', teacherId: 't1' },
    ], project.periodTimeSegments, {
        classes: project.classes,
        teachers: project.teachers,
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.errors.length, 2);
    assert.match(validation.errors[0].message, /自习值班时段/);
    assert.match(validation.errors[1].message, /自习值班时段/);
});

test('duty assignment normalization reserves source fields for later imports', () => {
    const project = normalizeTimetableProject({
        ...studyBlockProjectInput,
        dutyAssignments: [{
            id: 'imported-duty',
            day: 2,
            classId: 'c1',
            timeBlockId: 'early-study',
            teacherId: 't2',
            source: 'import',
            sourceSheet: '值班表',
            sourceRow: 8,
            rawText: '七年级1班 周二早自习 李老师',
        }],
    });

    assert.deepEqual(project.dutyAssignments, [{
        id: 'imported-duty',
        day: 2,
        classId: 'c1',
        timeBlockId: 'early-study',
        teacherId: 't2',
        source: 'import',
        sourceSheet: '值班表',
        sourceRow: 8,
        rawText: '七年级1班 周二早自习 李老师',
        status: 'active',
    }]);
});
