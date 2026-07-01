import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSchedule, publicationIssueEntries } from '../gateway/services/timetable-project.js';

test('timetable schedule normalization bridges publication issueEntries and reviewItems', () => {
    const fromLegacy = normalizeSchedule({
        id: 'schedule_legacy_publication',
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
        publication: {
            ok: false,
            reason: 'publication_blocked',
            reviewItems: [{
                type: 'incomplete_schedule',
                severity: 'error',
                targetKind: 'class',
                targetId: 'c1',
                targetName: 'G7 1',
                message: 'G7 1 还有 1 节未排。',
            }],
        },
    });

    assert.ok(Array.isArray(fromLegacy.publication.issueEntries));
    assert.deepEqual(fromLegacy.publication.issueEntries, fromLegacy.publication.reviewItems);

    const fromNewShape = normalizeSchedule({
        id: 'schedule_new_publication',
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
        publication: {
            ok: false,
            reason: 'publication_blocked',
            issueEntries: [{
                type: 'teacher_load',
                severity: 'warning',
                targetKind: 'teacher',
                targetId: 't_math',
                targetName: 'Math Teacher',
                message: 'Math Teacher 负载接近满载。',
            }],
        },
    });

    assert.ok(Array.isArray(fromNewShape.publication.reviewItems));
    assert.deepEqual(fromNewShape.publication.reviewItems, fromNewShape.publication.issueEntries);
});

test('timetable publication issue entries bridge legacy blockingIssues and warnings', () => {
    const schedule = normalizeSchedule({
        id: 'schedule_publication_legacy_lists',
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
        publication: {
            ok: false,
            reason: 'publication_blocked',
            blockingIssues: [{
                type: 'incomplete_schedule',
                targetKind: 'class',
                targetId: 'c1',
                targetName: 'G7 1',
                message: 'G7 1 还有 1 节未排。',
            }],
            warnings: [{
                type: 'manual_review',
                targetKind: 'schedule',
                targetId: '',
                targetName: '课表',
                message: '请教务复核。',
            }],
        },
    });

    assert.ok(Array.isArray(schedule.publication.issueEntries));
    assert.equal(schedule.publication.issueEntries.length, 2);
    assert.ok(schedule.publication.issueEntries.some(item => item.type === 'incomplete_schedule' && item.severity === 'error'));
    assert.ok(schedule.publication.issueEntries.some(item => item.type === 'manual_review' && item.severity === 'warning'));
    assert.deepEqual(publicationIssueEntries(schedule.publication), schedule.publication.issueEntries);
});
