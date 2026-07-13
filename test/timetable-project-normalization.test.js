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

test('normalizeTimetableProject shares lesson metadata aliases and preserves custom labels with spaces', () => {
    const project = normalizeTimetableProject({
        teachers: [{ id: 't-metadata', name: '程老师' }],
        classes: [{ id: 'c-metadata', grade: '七年级', name: '1班' }],
        subjects: [{ id: 's-metadata', name: '物理' }],
        lessonPlans: [{
            id: 'lp-metadata',
            classId: 'c-metadata',
            subjectId: 's-metadata',
            teacherId: 't-metadata',
            weeklyHours: 4,
            activityTypes: ['复习课', '校本研修课'],
            requiredResourceTypes: ['机房', 'Maker Space'],
        }],
    });

    assert.deepEqual(project.lessonPlans[0].activityTypes, ['复习', '校本研修课']);
    assert.deepEqual(project.lessonPlans[0].requiredResourceTypes, ['计算机教室', 'Maker Space']);
});

test('normalizeTimetableProject preserves singleton entity collections', () => {
    const project = normalizeTimetableProject({
        timetableModelVersion: 'complex_v1',
        complexModelEnabled: true,
        teachers: { id: 't1', name: '张老师', subjects: 's1', unavailableSlots: '1-2' },
        classes: { id: 'c1', grade: '七年级', name: '1班' },
        subjects: { id: 's1', name: '语文' },
        campuses: { id: 'campus1', name: '北校区' },
        rooms: { id: 'room1', name: '语文教室', campusId: 'campus1' },
        teachingGroups: { id: 'group1', name: '语文组', classIds: 'c1' },
        lessonPlans: {
            id: 'plan1',
            classId: 'c1',
            subjectId: 's1',
            teacherId: 't1',
            weeklyHours: 4,
            teachingGroupId: 'group1',
        },
        rules: {
            hardRules: { globalUnavailable: '1-1' },
            softRules: { morningSubjects: 's1' },
        },
    });

    assert.deepEqual(project.teachers.map(item => item.id), ['t1']);
    assert.deepEqual(project.teachers[0].subjects, ['s1']);
    assert.deepEqual(project.teachers[0].unavailableSlots, ['1-2']);
    assert.deepEqual(project.classes.map(item => item.id), ['c1']);
    assert.deepEqual(project.subjects.map(item => item.id), ['s1']);
    assert.deepEqual(project.campuses.map(item => item.id), ['campus1']);
    assert.deepEqual(project.rooms.map(item => item.id), ['room1']);
    assert.deepEqual(project.teachingGroups.map(item => item.id), ['group1']);
    assert.deepEqual(project.lessonPlans.map(item => item.id), ['plan1']);
    assert.deepEqual(project.rules.hardRules.globalUnavailable, ['1-1']);
    assert.deepEqual(project.rules.softRules.morningSubjects, ['s1']);
});

test('normalizeTimetableProject adds empty rules v2 fields for legacy projects', () => {
    const project = normalizeTimetableProject({
        rules: {
            hardRules: {
                teacherUnavailable: { t1: ['1-1'] },
            },
            softRules: {
                morningSubjects: ['math'],
            },
        },
    });

    assert.deepEqual(project.rules.hardRules.teacherUnavailable, { t1: ['1-1'] });
    assert.deepEqual(project.rules.hardRules.globalUnavailable, []);
    assert.deepEqual(project.rules.hardRules.subjectDailyLimit, {});
    assert.deepEqual(project.rules.hardRules.teacherWeeklyLimit, {});
    assert.deepEqual(project.rules.hardRules.teacherMaxDaysPerWeek, {});
    assert.deepEqual(project.rules.hardRules.teacherMutualExclusion, []);
    assert.deepEqual(project.rules.hardRules.subjectNotSameDay, []);
    assert.deepEqual(project.rules.hardRules.roomRequirements, {});
    assert.deepEqual(project.rules.softRules.afternoonSubjects, []);
    assert.deepEqual(project.rules.softRules.subjectDailySoftLimit, {});
    assert.deepEqual(project.rules.softRules.spreadSubjectGaps, {});
    assert.deepEqual(project.rules.softRules.subjectSequence, []);
    assert.equal(project.rules.softRules.teacherGapWeight, 0);
    assert.deepEqual(project.rules.softRules.classDailyBalance, { enabled: false, mainSubjectDailyMax: 0 });
    assert.deepEqual(project.rules.softRules.teacherLoadBalance, { enabled: true, weight: 1, explicit: false });
});

test('normalizeTimetableProject sanitizes rules v2 values', () => {
    const project = normalizeTimetableProject({
        rules: {
            hardRules: {
                globalUnavailable: ['1-1', { day: 2, period: 3 }, 'bad'],
                subjectDailyLimit: { math: 99, empty: 0, bad: 'x' },
                teacherWeeklyLimit: { t1: 88, t2: -3 },
                teacherMaxDaysPerWeek: { t1: 10 },
                teacherMutualExclusion: [
                    { teacherIds: ['t1', 't2', 't1'] },
                    { teacherIds: ['single'] },
                ],
                subjectNotSameDay: [
                    { subjectIds: ['math', 'physics', 'extra'], classIds: ['c1', 'c1'] },
                    { subjectIds: ['single'] },
                ],
                roomRequirements: {
                    science: { roomIds: ['lab1', 'lab1'], requiredTags: ['lab'] },
                    empty: { roomIds: [] },
                },
            },
            softRules: {
                afternoonSubjects: ['pe', 'pe', 'music'],
                subjectDailySoftLimit: { chinese: 9 },
                spreadSubjectGaps: { pe: 9 },
                subjectSequence: [
                    { beforeSubjectId: 'math', afterSubjectId: 'physics', classIds: ['c1'], weight: 99 },
                    { beforeSubjectId: 'same', afterSubjectId: 'same' },
                ],
                teacherGapWeight: 99,
                classDailyBalance: { enabled: true, mainSubjectDailyMax: 99 },
                teacherLoadBalance: { enabled: true, weight: 99 },
            },
        },
    });

    assert.deepEqual(project.rules.hardRules.globalUnavailable, ['1-1', '2-3']);
    assert.deepEqual(project.rules.hardRules.subjectDailyLimit, { math: 8, empty: 1 });
    assert.deepEqual(project.rules.hardRules.teacherWeeklyLimit, { t1: 40, t2: 1 });
    assert.deepEqual(project.rules.hardRules.teacherMaxDaysPerWeek, { t1: 7 });
    assert.deepEqual(project.rules.hardRules.teacherMutualExclusion, [{ teacherIds: ['t1', 't2'] }]);
    assert.deepEqual(project.rules.hardRules.subjectNotSameDay, [{ subjectIds: ['math', 'physics'], classIds: ['c1'] }]);
    assert.deepEqual(project.rules.hardRules.roomRequirements, { science: { roomIds: ['lab1'], requiredTags: ['lab'] } });
    assert.deepEqual(project.rules.softRules.afternoonSubjects, ['pe', 'music']);
    assert.deepEqual(project.rules.softRules.subjectDailySoftLimit, { chinese: 8 });
    assert.deepEqual(project.rules.softRules.spreadSubjectGaps, { pe: 7 });
    assert.deepEqual(project.rules.softRules.subjectSequence, [{ beforeSubjectId: 'math', afterSubjectId: 'physics', classIds: ['c1'], weight: 10 }]);
    assert.equal(project.rules.softRules.teacherGapWeight, 10);
    assert.deepEqual(project.rules.softRules.classDailyBalance, { enabled: true, mainSubjectDailyMax: 8 });
    assert.deepEqual(project.rules.softRules.teacherLoadBalance, { enabled: true, weight: 10, explicit: true });
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
