import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTimetableRuleDraftRows } from '../gateway/services/timetable-rule-parser.js';
import {
    CONSTRAINT_RULE_DEFINITIONS,
    compileConstraintRuleArtifacts,
    getConstraintRuleFormValue,
    getConstraintRuleScopeClassOptions,
    validateConstraintRuleForm,
} from '../public/js/tools/timetable/constraint-rule-form-model.js';

const project = {
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [
        { id: 'teacher_zhang', name: '张老师' },
        { id: 'teacher_li', name: '李老师' },
    ],
    classes: [
        { id: 'class_g7_1', grade: '七年级', name: '1班' },
        { id: 'class_g7_2', grade: '七年级', name: '2班' },
    ],
    subjects: [{ id: 'subject_chinese', name: '语文' }],
    lessonPlans: [
        { id: 'lp_g7_1_zhang', classId: 'class_g7_1', subjectId: 'subject_chinese', teacherIds: ['teacher_zhang'] },
        { id: 'lp_g7_1_li', classId: 'class_g7_1', subjectId: 'subject_chinese', teacherIds: ['teacher_li'] },
        { id: 'lp_g7_2_li', classId: 'class_g7_2', subjectId: 'subject_chinese', teacherIds: ['teacher_li'] },
    ],
};

function courseScopeFor(definition, { restrictTeacher = false } = {}) {
    if (!definition.type.startsWith('subject_')) return {};
    return {
        scopeClassId: 'class_g7_1',
        restrictTeacher,
        scopeTeacherId: restrictTeacher ? 'teacher_zhang' : '',
    };
}

test('manual constraint model exposes exactly the eight persistable rule types', () => {
    assert.deepEqual(CONSTRAINT_RULE_DEFINITIONS.map(item => item.type), [
        'teacher_unavailable',
        'class_unavailable',
        'subject_preferred_periods',
        'subject_avoid_periods',
        'subject_morning',
        'subject_spread',
        'teacher_daily_limit',
        'teacher_consecutive_limit',
    ]);
    assert.deepEqual(
        CONSTRAINT_RULE_DEFINITIONS.filter(item => item.strength === 'hard').map(item => item.type),
        ['teacher_unavailable', 'class_unavailable'],
    );
    assert.deepEqual(CONSTRAINT_RULE_DEFINITIONS.map(item => item.helpText), [
        '所选教师在勾选节次不得安排课程。',
        '所选班级在勾选节次不得安排任何课程。',
        '所选课程尽量安排在勾选节次。',
        '所选课程尽量避开勾选节次。',
        '所选课程尽量安排在上午时段。',
        '所选课程尽量分布到不同日期。',
        '限制所选教师每天承担的最大课节数。',
        '限制所选教师连续上课的最大课节数。',
    ]);
});

test('manual constraint model compiles every supported type into linked review artifacts', () => {
    for (const definition of CONSTRAINT_RULE_DEFINITIONS) {
        const targetId = definition.targetKind === 'teacher'
            ? 'teacher_zhang'
            : definition.targetKind === 'class'
                ? 'class_g7_1'
                : 'subject_chinese';
        const form = {
            type: definition.type,
            targetId,
            slots: definition.parameterKind === 'slots' ? ['1-1', '3-4'] : [],
            limit: definition.parameterKind === 'limit' ? 3 : '',
            ...courseScopeFor(definition),
        };

        const result = compileConstraintRuleArtifacts(form, project, { id: `manual_${definition.type}` });

        assert.equal(result.ok, true, `${definition.type} should compile`);
        assert.equal(result.draftRow.type, definition.type.startsWith('subject_') ? 'advanced_constraint' : definition.type);
        assert.equal(result.draftRow.targetId, targetId);
        assert.equal(result.draftRow.priority, definition.strength);
        assert.equal(result.draftRow.status, 'effective');
        assert.equal(result.requirementItem.rowId, result.draftRow.id);
        assert.deepEqual(result.requirementItem.machineRuleIds, [result.draftRow.machineRuleId]);
        assert.equal(result.sourceRequirement.sourceId, result.draftRow.sourceId);
        assert.deepEqual(result.sourceRequirement.machineRuleIds, [result.draftRow.machineRuleId]);
        assert.equal(result.constraintIR.requirementId, result.requirementItem.requirementId);
        if (definition.type.startsWith('subject_')) {
            assert.equal(result.draftRow.advancedType, {
                subject_preferred_periods: 'subject.preferred_periods',
                subject_avoid_periods: 'subject.avoid_periods',
                subject_morning: 'subject.preferred_day_part',
                subject_spread: 'subject.spread',
            }[definition.type]);
            assert.deepEqual(result.draftRow.scope.classIds, ['class_g7_1']);
            assert.match(result.draftRow.scopeLabel, /七年级 1班 · 语文 · 不限教师/);
            assert.deepEqual(result.draftRow.parameters.classIds, ['class_g7_1']);
        }
    }
});

test('manual constraint validation rejects missing entities, invalid slots and out-of-range limits', () => {
    const missingTarget = validateConstraintRuleForm({
        type: 'teacher_unavailable',
        targetId: '',
        slots: ['1-1'],
    }, project);
    assert.equal(missingTarget.valid, false);
    assert.match(missingTarget.errors.target, /教师/);

    const invalidSlots = validateConstraintRuleForm({
        type: 'teacher_unavailable',
        targetId: 'teacher_zhang',
        slots: ['1-1', '6-8'],
    }, project);
    assert.equal(invalidSlots.valid, false);
    assert.match(invalidSlots.errors.slots, /排课范围/);

    const invalidLimit = validateConstraintRuleForm({
        type: 'teacher_daily_limit',
        targetId: 'teacher_zhang',
        limit: 8,
    }, project);
    assert.equal(invalidLimit.valid, false);
    assert.match(invalidLimit.errors.limit, /1.*7/);

    const missingClass = validateConstraintRuleForm({
        type: 'subject_morning',
        targetId: 'subject_chinese',
    }, project);
    assert.equal(missingClass.valid, false);
    assert.match(missingClass.errors.scopeClass, /班级/);

    const missingRestrictedTeacher = validateConstraintRuleForm({
        type: 'subject_morning',
        targetId: 'subject_chinese',
        scopeClassId: 'class_g7_1',
        restrictTeacher: true,
    }, project);
    assert.equal(missingRestrictedTeacher.valid, false);
    assert.match(missingRestrictedTeacher.errors.scopeTeacher, /教师/);

    const unmatchedTeacher = validateConstraintRuleForm({
        type: 'subject_morning',
        targetId: 'subject_chinese',
        scopeClassId: 'class_g7_2',
        restrictTeacher: true,
        scopeTeacherId: 'teacher_zhang',
    }, project);
    assert.equal(unmatchedTeacher.valid, false);
    assert.match(unmatchedTeacher.errors.scopeTeacher, /没有匹配/);
});

test('editing converts legacy placeholders without silently changing type and preserves stable identities', () => {
    const legacy = {
        id: 'manual_legacy',
        type: 'forbid',
        sourceId: 'manual:source:legacy',
        clauseId: 'manual:source:legacy:clause:1',
        machineRuleId: 'manual:source:legacy:rule:1',
        requirementId: 'manual:source:legacy:requirement:1',
        targetName: '张老师',
        sourceText: '旧手动填写',
        origin: 'manual',
    };

    assert.equal(getConstraintRuleFormValue(legacy).type, '');

    const result = compileConstraintRuleArtifacts({
        type: 'teacher_unavailable',
        targetId: 'teacher_zhang',
        slots: ['2-3'],
    }, project, { existing: legacy });

    assert.equal(result.ok, true);
    assert.equal(result.draftRow.id, legacy.id);
    assert.equal(result.draftRow.sourceId, legacy.sourceId);
    assert.equal(result.draftRow.clauseId, legacy.clauseId);
    assert.equal(result.draftRow.machineRuleId, legacy.machineRuleId);
    assert.equal(result.draftRow.requirementId, legacy.requirementId);
    assert.equal(result.draftRow.type, 'teacher_unavailable');
});

test('course scope preserves legacy global rules until a user chooses a class', () => {
    const legacy = getConstraintRuleFormValue({
        id: 'legacy_global',
        type: 'subject_morning',
        targetType: 'subject',
        targetId: 'subject_chinese',
    });

    assert.equal(legacy.legacyCourseGlobal, true);
    assert.equal(legacy.scopeClassId, '');

    const converted = compileConstraintRuleArtifacts({
        type: legacy.type,
        targetId: legacy.targetId,
        scopeClassId: 'class_g7_1',
        restrictTeacher: true,
        scopeTeacherId: 'teacher_zhang',
    }, project, { existing: { id: 'legacy_global' } });

    assert.equal(converted.ok, true);
    assert.equal(converted.draftRow.id, 'legacy_global');
    assert.deepEqual(converted.draftRow.parameters.classIds, ['class_g7_1']);
    assert.deepEqual(converted.draftRow.parameters.teacherIds, ['teacher_zhang']);
});

test('course scope class options use grade and class number order', () => {
    const classes = [
        { id: 'class_g8_10', grade: '八年级', name: 'G8-10班' },
        { id: 'class_g9_1', grade: '九年级', name: 'G9-1班' },
        { id: 'class_g7_10', grade: '七年级', name: 'G7-10班' },
        { id: 'class_g8_2', grade: '八年级', name: 'G8-2班' },
        { id: 'class_g7_1', grade: '七年级', name: 'G7-1班' },
        { id: 'class_g8_1', grade: '八年级', name: 'G8-1班' },
    ];
    const scopedProject = {
        classes,
        lessonPlans: classes.map(klass => ({
            classId: klass.id,
            subjectId: 'subject_chinese',
        })),
    };

    const options = getConstraintRuleScopeClassOptions(
        scopedProject,
        'subject_morning',
        'subject_chinese',
    );

    assert.deepEqual(options.map(option => option.id), [
        'class_g7_1',
        'class_g7_10',
        'class_g8_1',
        'class_g8_2',
        'class_g8_10',
        'class_g9_1',
    ]);
});

test('course scope class options naturally sort Chinese and custom class names', () => {
    const classes = [
        { id: 'class_cn_g8_1', grade: '八年级', name: '1班' },
        { id: 'class_cn_g7_10', grade: '七年级', name: '10班' },
        { id: 'class_cn_g7_2', grade: '七年级', name: '2班' },
        { id: 'class_custom_10', grade: '国际部', name: '创新班10' },
        { id: 'class_custom_2', grade: '国际部', name: '创新班2' },
    ];
    const scopedProject = {
        classes,
        lessonPlans: classes.map(klass => ({
            classId: klass.id,
            subjectId: 'subject_chinese',
        })),
    };

    const options = getConstraintRuleScopeClassOptions(
        scopedProject,
        'subject_spread',
        'subject_chinese',
    );

    assert.deepEqual(options.map(option => option.id), [
        'class_cn_g7_2',
        'class_cn_g7_10',
        'class_cn_g8_1',
        'class_custom_2',
        'class_custom_10',
    ]);
});

test('all structured manual rows pass the real backend normalizer', () => {
    const draftRows = CONSTRAINT_RULE_DEFINITIONS.map((definition, index) => {
        const targetId = definition.targetKind === 'teacher'
            ? 'teacher_zhang'
            : definition.targetKind === 'class'
                ? 'class_g7_1'
                : 'subject_chinese';
        return compileConstraintRuleArtifacts({
            type: definition.type,
            targetId,
            slots: definition.parameterKind === 'slots' ? ['1-1', '3-4'] : [],
            limit: definition.parameterKind === 'limit' ? 3 : '',
            ...courseScopeFor(definition),
        }, project, { id: `normalize_${index}` }).draftRow;
    });

    const normalized = normalizeTimetableRuleDraftRows({
        project: { ...project, rules: { hardRules: {}, softRules: {} } },
        draftRows,
        inputType: 'manual',
    });

    assert.equal(normalized.draftRows.length, CONSTRAINT_RULE_DEFINITIONS.length);
    assert.deepEqual(normalized.draftRows.map(row => row.status), CONSTRAINT_RULE_DEFINITIONS.map(() => 'effective'));
    assert.ok(normalized.draftRules?.hardRules);
    assert.ok(normalized.draftRules?.softRules);
    assert.equal(normalized.draftRules.advancedRules.length, 4);
    assert.ok(normalized.draftRules.advancedRules.every(rule => rule.parameters.classIds.includes('class_g7_1')));
    assert.equal(Object.keys(normalized.draftRules.softRules.subjectPreferredPeriods || {}).length, 0);
    assert.deepEqual(normalized.draftRules.softRules.morningSubjects || [], []);
});
