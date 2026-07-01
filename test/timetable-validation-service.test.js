import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { validationService, ValidationErrorCodes } from '../gateway/services/timetable-validation-service.js';

test('timetable validation service publish check returns structured publication issues', () => {
    const project = createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 4,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4],
        teachers: [{ id: 't_math', name: '陈老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: '七年级', name: '1班' }],
        subjects: [{ id: 'math', name: '数学', priority: 100, color: '#14b8a6' }],
        lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
        rules: { hardRules: {}, softRules: {} },
        schedule: {
            id: 'invalid_publish_schedule',
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
                lessonPlanId: 'lp1',
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [{ lessonPlanId: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', reason: 'missing slot' }],
            score: { totalLessons: 2, placedLessons: 1, unplacedLessons: 1, hardConflicts: 0, completeness: 50 },
        },
    });

    const result = validationService.validateForPublish(project);

    assert.equal(result.ok, false);
    assert.equal(result.reason, ValidationErrorCodes.UNPLACED_LESSONS);
    assert.ok(Array.isArray(result.issueEntries));
    assert.ok(Array.isArray(result.reviewItems));
    assert.ok(Array.isArray(result.blockingIssues));
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.issueEntries.some(item => item.type === 'incomplete_schedule'));
    assert.deepEqual(result.issueEntries, result.reviewItems);
    assert.ok(result.blockingIssues.some(item => item.type === 'incomplete_schedule'));
    assert.equal(result.warnings.length, 0);
    assert.equal(result.summary.unplacedLessons, 1);
    assert.equal(result.summary.placedLessons, 1);
});
