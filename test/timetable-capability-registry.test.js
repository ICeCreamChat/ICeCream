import test from 'node:test';
import assert from 'node:assert/strict';

import {
    compileConstraintIR,
    createConstraintCapabilityRegistry,
    listConstraintCapabilities,
    registerConstraintCapability,
    resolveConstraintCapability,
    validateCapabilityIR,
} from '../gateway/services/timetable-constraints/capability-registry.js';
import {
    createDefaultTimetableCapabilityRegistry,
    legacyArtifactToConstraintIR,
} from '../gateway/services/timetable-constraints/capabilities.js';
import {
    normalizeConstraintIR,
} from '../gateway/services/timetable-constraints/constraint-ir.js';

const provenance = {
    sourceId: 'src:2:text:l1:example',
    clauseId: 'src:2:text:l1:example:clause:teacher-unavailable',
    textHash: 'sha256:example',
    origin: 'user_input',
    parsedBy: ['local'],
};

test('capability registry resolves aliases and refuses duplicate aliases', () => {
    const registry = createConstraintCapabilityRegistry();
    registerConstraintCapability(registry, {
        id: 'teacher.unavailable',
        intents: ['unavailable_periods'],
        aliases: ['teacher_unavailable', 'teacher_no_class'],
        objectTypes: ['teacher'],
        requiredParameters: ['slots'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_unavailable'],
        validate: () => ({ valid: true, errors: [], warnings: [], clarifications: [] }),
        compile: ir => ({ rows: [{ type: 'teacher_unavailable', slots: ir.parameters.slots }] }),
        explain: () => '教师在指定时间不可排课。',
    });

    assert.equal(resolveConstraintCapability(registry, 'teacher_no_class').id, 'teacher.unavailable');
    assert.equal(resolveConstraintCapability(registry, 'UNAVAILABLE-PERIODS').id, 'teacher.unavailable');
    assert.throws(() => registerConstraintCapability(registry, {
        id: 'teacher.other',
        aliases: ['teacher_no_class'],
        objectTypes: ['teacher'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['review'],
        solverSupport: 'none',
        machineRuleTypes: [],
    }), /alias/i);
});

test('teacher.unavailable migrates through ConstraintIR and compiles a provenance-safe legacy row', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const ir = legacyArtifactToConstraintIR({
        ...provenance,
        id: 'rule-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 'teacher-1',
        targetName: '刘老师',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        rawText: '刘老师周一第2节不要排课。',
    }, { registry });

    assert.equal(ir.capabilityId, 'teacher.unavailable');
    assert.equal(ir.understandingStatus, 'parsed');
    assert.equal(ir.executionStatus, 'executable');
    assert.equal(ir.reviewStatus, 'understood');

    const compiled = compileConstraintIR(registry, ir);
    assert.equal(compiled.valid, true);
    assert.equal(compiled.rows.length, 1);
    const row = compiled.rows[0];
    assert.deepEqual({
        type: row.type,
        targetType: row.targetType,
        targetId: row.targetId,
        targetName: row.targetName,
        slots: row.slots,
        priority: row.priority,
        status: row.status,
        sourceId: row.sourceId,
        clauseId: row.clauseId,
        capabilityId: row.capabilityId,
        generatedBy: row.generatedBy,
    }, {
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 'teacher-1',
        targetName: '刘老师',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        sourceId: provenance.sourceId,
        clauseId: provenance.clauseId,
        capabilityId: 'teacher.unavailable',
        generatedBy: 'capability_registry',
    });
});

test('legacy capability artifacts without provenance stay unknown instead of becoming user input', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const ir = legacyArtifactToConstraintIR({
        id: 'legacy-without-origin',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 'teacher-1',
        targetName: '刘老师',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        rawText: '刘老师周一第2节不要排课。',
    }, { registry, sourceId: 'legacy:source' });

    assert.equal(ir.origin, 'unknown');
});

test('missing or ambiguous teacher references produce clarification and no ready-to-apply row', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const missingTarget = normalizeConstraintIR({
        ...provenance,
        capabilityId: 'teacher.unavailable',
        intent: 'unavailable_periods',
        target: { kind: 'teacher', name: '刘老师', matchedIds: [] },
        parameters: { slots: ['1-2'] },
        strength: 'hard',
        understandingStatus: 'invalid_reference',
        executionStatus: 'unsupported_by_solver',
    });
    const ambiguousTarget = normalizeConstraintIR({
        ...missingTarget,
        target: { kind: 'teacher', name: '刘老师', matchedIds: ['teacher-1', 'teacher-2'] },
        understandingStatus: 'ambiguous',
    });

    const missingValidation = validateCapabilityIR(registry, missingTarget);
    assert.equal(missingValidation.valid, false);
    assert.ok(missingValidation.clarifications.some(message => /教师/.test(message)));
    assert.equal(compileConstraintIR(registry, missingTarget).rows.length, 0);

    const ambiguousValidation = validateCapabilityIR(registry, ambiguousTarget);
    assert.equal(ambiguousValidation.valid, false);
    assert.ok(ambiguousValidation.clarifications.some(message => /多个|重名|唯一/.test(message)));
    assert.equal(compileConstraintIR(registry, ambiguousTarget).rows.length, 0);
});

test('upgraded teacher load balance capability is fully executable', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const ir = legacyArtifactToConstraintIR({
        ...provenance,
        id: 'fairness-1',
        type: 'teacher_load_balance',
        targetType: 'global',
        targetName: '全部教师',
        priority: 'soft',
        status: 'suggestion',
        rawText: '同一备课组教师课量尽量均衡。',
    }, { registry });

    assert.equal(ir.capabilityId, 'teacher.load_balance');
    assert.equal(ir.understandingStatus, 'parsed');
    assert.equal(ir.executionStatus, 'executable');
    assert.equal(ir.reviewStatus, 'understood');
    assert.equal(ir.support, 'full');
});

test('unknown capability is never treated as unrecognized natural language when the clause intent is known', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const ir = legacyArtifactToConstraintIR({
        ...provenance,
        intent: 'future_market_capability',
        object: { kind: 'global', name: '全校' },
        status: 'actionable',
        rawText: '这是已识别但当前求解器尚未实现的市场能力。',
    }, { registry });

    assert.equal(ir.capabilityId, 'legacy.future_market_capability');
    assert.equal(ir.understandingStatus, 'parsed');
    assert.equal(ir.executionStatus, 'unsupported_by_solver');
    assert.equal(ir.reviewStatus, 'unsupported');
    assert.equal(compileConstraintIR(registry, ir).rows.length, 0);
});


test('legacy capability normalization preserves scalar provenance and review messages', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const ir = legacyArtifactToConstraintIR({
        ...provenance,
        parsedBy: 'ai',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 'teacher-1',
        targetName: '刘老师',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        rawText: '刘老师周一第2节不要排课。',
        warnings: '来源需复核',
        questions: '是否为刘老师本人？',
    }, { registry });

    assert.deepEqual(ir.parsedBy, ['ai']);
    assert.deepEqual(ir.warnings, ['来源需复核']);
    assert.deepEqual(ir.clarifications, ['是否为刘老师本人？']);
});


test('capability registry accepts scalar aliases, intents and row types as whole values', () => {
    const registry = createConstraintCapabilityRegistry();
    registerConstraintCapability(registry, {
        id: 'teacher.scalar_boundary',
        aliases: 'teacher_scalar_alias',
        intents: 'teacher_scalar_intent',
        rowTypes: 'teacher_scalar_row',
        objectTypes: 'teacher',
        landing: 'review',
        solverSupport: 'none',
    });

    assert.equal(resolveConstraintCapability(registry, 'teacher_scalar_alias')?.id, 'teacher.scalar_boundary');
    assert.equal(resolveConstraintCapability(registry, 'teacher_scalar_intent')?.id, 'teacher.scalar_boundary');
    assert.equal(resolveConstraintCapability(registry, 'teacher_scalar_row')?.id, 'teacher.scalar_boundary');
});

test('capability validation and compilation merge clarifications with questions', () => {
    const registry = createConstraintCapabilityRegistry();
    registerConstraintCapability(registry, {
        id: 'global.review_messages',
        aliases: [],
        intents: [],
        rowTypes: [],
        objectTypes: ['global'],
        landing: ['rule'],
        solverSupport: 'full',
        validate: () => ({
            valid: true,
            clarifications: [],
            questions: '验证问题',
        }),
        compile: () => ({
            rows: [{ type: 'review_message_rule' }],
            clarifications: ['编译澄清'],
            questions: ['编译问题', '验证问题'],
        }),
    });
    const ir = normalizeConstraintIR({
        ...provenance,
        capabilityId: 'global.review_messages',
        intent: 'global_review_messages',
        target: { kind: 'global', name: '全校' },
        understandingStatus: 'parsed',
        executionStatus: 'executable',
    });

    const validation = validateCapabilityIR(registry, ir);
    assert.deepEqual(validation.clarifications, ['验证问题']);
    const compiled = compileConstraintIR(registry, ir);
    assert.deepEqual(compiled.clarifications, ['验证问题', '编译澄清', '编译问题']);
});

test('legacy capability boundary flattens scalar targets, provenance, landing and both review fields', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const ir = legacyArtifactToConstraintIR({
        ...provenance,
        parsedBy: 'ai',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        matchedIds: 'teacher-1',
        targetName: '刘老师',
        slots: ['1-2'],
        priority: 'hard',
        status: 'effective',
        landing: 'optimization',
        clarifications: [],
        questions: '请确认例外日期',
    }, { registry, parsedBy: ['local', 'review'] });

    assert.deepEqual(ir.target.matchedIds, ['teacher-1']);
    assert.deepEqual(ir.parsedBy, ['local', 'review', 'ai']);
    assert.deepEqual(ir.landing, ['optimization']);
    assert.deepEqual(ir.clarifications, ['请确认例外日期']);

    const subjectGroup = legacyArtifactToConstraintIR({
        ...provenance,
        type: 'subject_not_same_day',
        targetType: 'subject_group',
        subjectIds: 'math',
        status: 'suggestion',
    }, { registry });
    assert.deepEqual(subjectGroup.target.matchedIds, ['math']);
});

test('teacher role-group period preferences stay understood but unsupported instead of compiling subject rows', () => {
    const registry = createDefaultTimetableCapabilityRegistry();
    const capabilities = listConstraintCapabilities(registry);
    const ir = legacyArtifactToConstraintIR({
        ...provenance,
        id: 'teacher-role-period-preference',
        intent: 'teacher_avoid_periods',
        object: { kind: 'derived_group', name: '班主任', matchedIds: [] },
        condition: { periods: [1] },
        parameters: { slots: ['1-1', '2-1', '3-1', '4-1', '5-1'] },
        strength: 'soft',
        status: 'needs_review',
        needsClarification: true,
        rawText: '班主任第一节尽量不要有课方便晨检',
    }, { registry });

    assert.equal(capabilities.length, 33);
    assert.deepEqual(capabilities.filter(item => item.id === 'teacher.avoid_periods').map(item => ({
        solverSupport: item.solverSupport,
        machineRuleTypes: item.machineRuleTypes,
        objectTypes: item.objectTypes,
    })), [{
        solverSupport: 'none',
        machineRuleTypes: [],
        objectTypes: ['teacher', 'teacher_group', 'derived_group'],
    }]);
    assert.equal(ir.capabilityId, 'teacher.avoid_periods');
    assert.equal(ir.target.kind, 'derived_group');
    assert.equal(ir.executionStatus, 'unsupported_by_solver');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.equal(compileConstraintIR(registry, ir).rows.length, 0);
});
