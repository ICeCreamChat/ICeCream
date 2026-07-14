import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CONSTRAINT_RULE_DEFINITIONS,
    compileConstraintRuleArtifacts,
    getConstraintRuleFormValue,
    validateConstraintRuleForm,
} from '../public/js/tools/timetable/constraint-rule-form-model.js';

const project = {
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [{ id: 'teacher_zhang', name: '张老师' }],
    classes: [{ id: 'class_g7_1', grade: '七年级', name: '1班' }],
    subjects: [{ id: 'subject_chinese', name: '语文' }],
};

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
        };

        const result = compileConstraintRuleArtifacts(form, project, { id: `manual_${definition.type}` });

        assert.equal(result.ok, true, `${definition.type} should compile`);
        assert.equal(result.draftRow.type, definition.type);
        assert.equal(result.draftRow.targetId, targetId);
        assert.equal(result.draftRow.priority, definition.strength);
        assert.equal(result.draftRow.status, 'effective');
        assert.equal(result.requirementItem.rowId, result.draftRow.id);
        assert.deepEqual(result.requirementItem.machineRuleIds, [result.draftRow.machineRuleId]);
        assert.equal(result.sourceRequirement.sourceId, result.draftRow.sourceId);
        assert.deepEqual(result.sourceRequirement.machineRuleIds, [result.draftRow.machineRuleId]);
        assert.equal(result.constraintIR.requirementId, result.requirementItem.requirementId);
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
