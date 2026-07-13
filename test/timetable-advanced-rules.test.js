import assert from 'node:assert/strict';
import test from 'node:test';

import {
    advancedCandidatePenalty,
    advancedHardBlocker,
    advancedRuleAppliesToLesson,
    evaluateAdvancedRule,
} from '../gateway/services/timetable-advanced-rules.js';
import { normalizeTimetableProject } from '../gateway/services/timetable-project.js';
import { buildTimetableProblem } from '../gateway/services/timetable-solver-bridge.js';

function projectWithRule(rule) {
    return normalizeTimetableProject({
        teachers: [{ id: 't1', name: '教师甲' }, { id: 't2', name: '教师乙' }],
        classes: [{ id: 'c1', name: 'G9-1班', grade: '九年级' }],
        subjects: [{ id: 's1', name: '物理' }, { id: 's2', name: '化学' }],
        rooms: [
            { id: 'lab', name: '实验室', tags: ['实验室'] },
            { id: 'normal', name: '普通教室', tags: ['普通教室'] },
        ],
        lessonPlans: [
            { id: 'p1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3, activityTypes: ['实验课'], requiredResourceTypes: ['实验室'] },
            { id: 'p2', classId: 'c1', subjectId: 's2', teacherId: 't2', weeklyHours: 2, activityTypes: ['实验课'], requiredResourceTypes: ['实验室'] },
        ],
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        periodsPerDay: 8,
        rules: { hardRules: {}, softRules: {}, advancedRules: [rule] },
    });
}

function slot(overrides = {}) {
    return {
        id: overrides.id || `slot-${overrides.day || 1}-${overrides.period || 1}-${overrides.subjectId || 's1'}`,
        lessonPlanId: overrides.lessonPlanId || 'p1',
        classId: 'c1',
        subjectId: 's1',
        teacherId: 't1',
        teacherIds: ['t1'],
        roomId: 'lab',
        day: 1,
        period: 1,
        ...overrides,
    };
}

test('advanced room and period rules affect hard blocking and soft candidate scoring', () => {
    const hardRule = {
        id: 'room-rule', type: 'room.required', strength: 'hard',
        target: { kind: 'subject', matchedIds: ['s1'] },
        parameters: { roomIds: ['lab'] },
    };
    const hardProject = projectWithRule(hardRule);
    assert.match(advancedHardBlocker(hardProject, [], slot({ roomId: 'normal' })), /指定教室/);
    assert.equal(advancedHardBlocker(hardProject, [], slot({ roomId: 'lab' })), '');

    const softProject = projectWithRule({
        id: 'period-rule', type: 'subject.preferred_periods', strength: 'soft',
        target: { kind: 'subject', matchedIds: ['s1'] },
        parameters: { slots: ['1-1'] },
    });
    assert.equal(advancedCandidatePenalty(softProject, [], slot({ period: 1 })), 0);
    assert.ok(advancedCandidatePenalty(softProject, [], slot({ period: 2 })) > 0);
});

test('advanced fulfillment detects compactness, balance, blocks, adjacency and venue violations', () => {
    const cases = [
        {
            rule: { id: 'compact', type: 'teacher.compact_day', strength: 'soft', target: { kind: 'teacher', matchedIds: ['t1'] }, parameters: {} },
            slots: [slot({ period: 1 }), slot({ id: 'gap', period: 4 })],
        },
        {
            rule: { id: 'balance', type: 'class.daily_balance', strength: 'soft', target: { kind: 'global' }, parameters: {} },
            slots: [slot({ period: 1 }), slot({ id: 'same-day-2', period: 2 }), slot({ id: 'same-day-3', period: 3 })],
        },
        {
            rule: { id: 'block', type: 'lesson.consecutive', strength: 'soft', target: { kind: 'subject', matchedIds: ['s1'] }, parameters: { blockSize: 2 } },
            slots: [slot({ period: 1 }), slot({ id: 'split', day: 2, period: 3 })],
        },
        {
            rule: { id: 'relation', type: 'subject.not_consecutive_with', strength: 'soft', target: { kind: 'subject_group' }, parameters: { subjectIds: ['s1', 's2'], sameDay: true } },
            slots: [slot({ period: 1 }), slot({ id: 'chem', lessonPlanId: 'p2', subjectId: 's2', teacherId: 't2', teacherIds: ['t2'], period: 2 })],
        },
        {
            rule: { id: 'venue', type: 'schedule.cross_venue_boundary', strength: 'hard', target: { kind: 'global' }, parameters: { boundaryPeriods: [4, 5] } },
            slots: [slot({ period: 4, roomId: 'lab' }), slot({ id: 'venue-2', period: 5, roomId: 'normal' })],
        },
    ];
    for (const item of cases) {
        const result = evaluateAdvancedRule(projectWithRule(item.rule), item.rule, item.slots);
        assert.equal(result.status, 'violated', item.rule.type);
        assert.ok(result.evidence.length > 0, item.rule.type);
    }
});

test('advanced fulfillment reports not_evaluable when required lesson metadata is absent', () => {
    const rule = {
        id: 'resource', type: 'lesson.resource_attribute_avoid_periods', strength: 'soft',
        target: { kind: 'global' }, parameters: { requiredResourceTypes: ['computer_room'], slots: ['5-8'] },
    };
    const result = evaluateAdvancedRule(projectWithRule(rule), rule, [slot({ day: 5, period: 8 })]);
    assert.equal(result.status, 'not_evaluable');
    assert.match(result.detail, /规则已应用，当前没有符合条件的课程/);
});

test('Timefold bridge carries advanced rules and explicit lesson metadata', () => {
    const rule = {
        id: 'resource', type: 'lesson.resource_attribute_avoid_periods', strength: 'soft',
        target: { kind: 'subject', matchedIds: ['s1'] }, parameters: { requiredResourceTypes: ['lab'], slots: ['5-8'] },
    };
    const problem = buildTimetableProblem(projectWithRule(rule));
    const assignment = problem.lessonAssignments.find(item => item.lessonPlanId === 'p1');
    assert.ok(assignment);
    assert.deepEqual(assignment.activityTypes, ['实验课']);
    assert.deepEqual(assignment.requiredResourceTypes, ['实验室']);
    assert.ok(assignment.advancedRules.some(item => item.id === 'resource'));
    assert.ok(problem.rooms.find(item => item.id === 'lab').tags.includes('实验室'));
});

test('advanced rules match shared activity and resource aliases', () => {
    const activityRule = {
        id: 'activity-alias', type: 'lesson.activity_scope_period_policy', strength: 'soft',
        target: { kind: 'global' }, parameters: { activityTypes: ['experiment'], slots: ['1-1'] },
    };
    const activityProject = projectWithRule(activityRule);
    assert.equal(advancedRuleAppliesToLesson(activityProject, activityRule, activityProject.lessonPlans[0]), true);

    const resourceAliases = [
        ['普通教室', 'ordinary'],
        ['化学实验室', 'lab'],
        ['机房', 'computer_room'],
    ];
    for (const [planResource, ruleResource] of resourceAliases) {
        const rule = {
            id: `resource-${ruleResource}`, type: 'lesson.resource_attribute_avoid_periods', strength: 'soft',
            target: { kind: 'global' }, parameters: { requiredResourceTypes: [ruleResource], slots: ['1-1'] },
        };
        const project = projectWithRule(rule);
        project.lessonPlans[0].requiredResourceTypes = [planResource];
        assert.equal(advancedRuleAppliesToLesson(project, rule, project.lessonPlans[0]), true, planResource);
    }
});
