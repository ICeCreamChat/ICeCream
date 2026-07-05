import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSchedule, normalizeTimetableProject, publicationIssueEntries } from '../gateway/services/timetable-project.js';

test('legacy timetable projects stay legacy and do not get complex fields by default', () => {
    const project = normalizeTimetableProject({
        id: 'legacy-project',
        teachers: [{ id: 't1', name: '张老师', campusId: 'north' }],
        classes: [{ id: 'c1', grade: '一年级', name: '一班', campusId: 'north' }],
        subjects: [{ id: 's1', name: '语文' }],
        lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 4 }],
        rules: {
            softRules: {
                subjectPreferredPeriods: {
                    s1: { prefer: ['1-1'], weight: 30, weekPattern: 'odd' },
                },
            },
        },
    });

    assert.equal(project.timetableModelVersion, 'legacy');
    assert.equal(project.complexModelEnabled, false);
    assert.equal(project.teachers[0].campusId, '');
    assert.equal(project.classes[0].campusId, '');
    assert.equal(project.lessonPlans[0].weekPattern, 'every');
    assert.equal(project.rules.softRules.subjectPreferredPeriods.s1.weekPattern, undefined);
    assert.deepEqual(project.campuses, []);
    assert.deepEqual(project.teachingGroups, []);
    assert.deepEqual(project.rooms, []);
});

test('complex timetable model preserves versioned fields and normalizes metadata', () => {
    const project = normalizeTimetableProject({
        timetableModelVersion: 'complex_v1',
        campuses: [{ id: 'north', name: '北校区' }, { name: '南校区' }],
        commuteRules: { defaultGapPeriods: 2, teacherGapPeriods: { t1: 1 } },
        teachers: [{ id: 't1', name: '张老师', campusId: 'north' }],
        classes: [{ id: 'c1', grade: '一年级', name: '一班', campusId: 'south' }],
        subjects: [{ id: 's1', name: '语文' }],
        rooms: [{ id: 'r1', name: '操场', campusId: 'south', capacity: 120, tags: ['sport', 'outdoor'] }],
        teachingGroups: [{ id: 'tg1', name: '一二班体育组', classIds: ['c1', 'c2'], subjectIds: ['s4'], mode: 'combined_class' }],
        lessonPlans: [{
            id: 'lp1',
            classId: 'c1',
            subjectId: 's1',
            teacherId: 't1',
            weeklyHours: 4,
            weekPattern: 'odd',
            campusId: 'south',
            teachingGroupId: 'tg1',
            roomRequirement: { preferredRoomIds: ['r1'], requiredTags: ['outdoor'] },
        }],
        rules: {
            softRules: {
                subjectPreferredPeriods: {
                    s1: { prefer: ['1-1'], weight: 30, weekPattern: 'odd' },
                },
            },
        },
        schedule: {
            id: 'schedule_complex',
            slots: [{
                id: 'slot1',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 's1',
                teacherId: 't1',
                lessonPlanId: 'lp1',
                weekPattern: 'odd',
                campusId: 'south',
                teachingGroupId: 'tg1',
                roomId: 'r1',
            }],
        },
    });

    assert.equal(project.timetableModelVersion, 'complex_v1');
    assert.equal(project.complexModelEnabled, true);
    assert.equal(project.campuses.length, 2);
    assert.equal(project.campuses[1].name, '南校区');
    assert.match(project.campuses[1].id, /^campus_/);
    assert.equal(project.commuteRules.defaultGapPeriods, 2);
    assert.equal(project.commuteRules.teacherGapPeriods.t1, 1);
    assert.equal(project.teachers[0].campusId, 'north');
    assert.equal(project.classes[0].campusId, 'south');
    assert.equal(project.rooms[0].capacity, 120);
    assert.deepEqual(project.rooms[0].tags, ['sport', 'outdoor']);
    assert.deepEqual(project.teachingGroups[0].classIds, ['c1', 'c2']);
    assert.equal(project.lessonPlans[0].weekPattern, 'odd');
    assert.equal(project.lessonPlans[0].teachingGroupId, 'tg1');
    assert.deepEqual(project.lessonPlans[0].roomRequirement.preferredRoomIds, ['r1']);
    assert.equal(project.rules.softRules.subjectPreferredPeriods.s1.weekPattern, 'odd');
    assert.equal(project.schedule.slots[0].weekPattern, 'odd');
    assert.equal(project.schedule.slots[0].campusId, 'south');
    assert.equal(project.schedule.slots[0].teachingGroupId, 'tg1');
});

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
