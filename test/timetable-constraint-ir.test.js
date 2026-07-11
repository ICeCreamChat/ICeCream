import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CONSTRAINT_IR_SCHEMA_VERSION,
    EXECUTION_STATUSES,
    REVIEW_STATUSES,
    UNDERSTANDING_STATUSES,
    aggregateConstraintIRStatuses,
    deriveConstraintReviewStatus,
    normalizeConstraintIR,
    validateConstraintIR,
} from '../gateway/services/timetable-constraints/constraint-ir.js';

const provenance = {
    sourceId: 'src:2:text:l1:example',
    clauseId: 'src:2:text:l1:example:clause:teacher-unavailable',
    textHash: 'sha256:example',
    origin: 'user_input',
    parsedBy: ['local'],
};

test('ConstraintIR keeps understanding and solver support as independent states', () => {
    const ir = normalizeConstraintIR({
        ...provenance,
        capabilityId: 'teacher.unavailable',
        intent: 'unavailable_periods',
        target: { kind: 'teacher', name: '刘老师', matchedIds: ['teacher-1'] },
        time: { slots: ['1-2'] },
        parameters: { slots: ['1-2'] },
        understandingStatus: 'parsed',
        executionStatus: 'unsupported_by_solver',
        support: 'none',
    });

    assert.equal(ir.kind, 'ConstraintIR');
    assert.equal(ir.schemaVersion, CONSTRAINT_IR_SCHEMA_VERSION);
    assert.equal(ir.understandingStatus, 'parsed');
    assert.equal(ir.executionStatus, 'unsupported_by_solver');
    assert.equal(ir.reviewStatus, 'unsupported');
    assert.equal(ir.capabilityId, 'teacher.unavailable');
    assert.deepEqual(ir.target.matchedIds, ['teacher-1']);
    assert.equal(validateConstraintIR(ir).valid, true);
});

test('ConstraintIR keeps missing provenance origin unknown instead of fabricating user input', () => {
    const ir = normalizeConstraintIR({
        sourceId: 'legacy:source',
        clauseId: 'legacy:source:clause:1',
        capabilityId: 'teacher.unavailable',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
    });

    assert.equal(ir.origin, 'unknown');
});

test('ConstraintIR derives clarification, partial support, understood and irrelevant review states deterministically', () => {
    assert.equal(deriveConstraintReviewStatus('ambiguous', 'unsupported_by_solver'), 'needs_clarification');
    assert.equal(deriveConstraintReviewStatus('parsed', 'partially_executable'), 'partially_supported');
    assert.equal(deriveConstraintReviewStatus('parsed', 'executable'), 'understood');
    assert.equal(deriveConstraintReviewStatus('irrelevant', 'disabled'), 'irrelevant');
    assert.equal(deriveConstraintReviewStatus('parsed', 'unsupported_by_solver'), 'unsupported');

    const aggregate = aggregateConstraintIRStatuses([
        normalizeConstraintIR({ ...provenance, capabilityId: 'teacher.unavailable', understandingStatus: 'parsed', executionStatus: 'executable' }),
        normalizeConstraintIR({ ...provenance, clauseId: `${provenance.clauseId}:2`, capabilityId: 'teacher.daily_lesson_limit', understandingStatus: 'parsed', executionStatus: 'unsupported_by_solver' }),
    ]);
    assert.equal(aggregate.understandingStatus, 'parsed');
    assert.equal(aggregate.executionStatus, 'partially_executable');
    assert.equal(aggregate.reviewStatus, 'partially_supported');
});

test('ConstraintIR normalization deduplicates evidence, warnings and clarification questions', () => {
    const ir = normalizeConstraintIR({
        ...provenance,
        capabilityId: 'teacher.unavailable',
        understandingStatus: 'ambiguous',
        executionStatus: 'unsupported_by_solver',
        warnings: ['教师存在重名', '教师存在重名'],
        clarifications: ['请选择教师', '请选择教师'],
        evidence: [
            { quote: '刘老师周一第2节不要排课。', start: 0, end: 15 },
            { quote: '刘老师周一第2节不要排课。', start: 0, end: 15 },
        ],
    });

    assert.deepEqual(ir.warnings, ['教师存在重名']);
    assert.deepEqual(ir.clarifications, ['请选择教师']);
    assert.equal(ir.evidence.length, 1);
    assert.equal(ir.reviewStatus, 'needs_clarification');
});

test('ConstraintIR validator rejects unknown states and missing identity instead of silently coercing them to executable', () => {
    const validation = validateConstraintIR({
        kind: 'ConstraintIR',
        schemaVersion: CONSTRAINT_IR_SCHEMA_VERSION,
        sourceId: '',
        clauseId: '',
        capabilityId: '',
        understandingStatus: 'magic_understanding_state',
        executionStatus: 'magic_execution_state',
        reviewStatus: 'magic_review_state',
    }, { normalize: false });

    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(error => error.code === 'missing_source_id'));
    assert.ok(validation.errors.some(error => error.code === 'missing_clause_id'));
    assert.ok(validation.errors.some(error => error.code === 'missing_capability_id'));
    assert.ok(validation.errors.some(error => error.code === 'invalid_understanding_status'));
    assert.ok(validation.errors.some(error => error.code === 'invalid_execution_status'));
    assert.ok(validation.errors.some(error => error.code === 'invalid_review_status'));
    assert.ok(UNDERSTANDING_STATUSES.has('parsed'));
    assert.ok(EXECUTION_STATUSES.has('executable'));
    assert.ok(REVIEW_STATUSES.has('partially_supported'));
});


test('ConstraintIR keeps scalar provenance and review messages as whole entries', () => {
    const ir = normalizeConstraintIR({
        ...provenance,
        parsedBy: 'ai',
        warnings: 'AI warning',
        questions: '请选择唯一教师',
        capabilityId: 'teacher.unavailable',
        understandingStatus: 'ambiguous',
        executionStatus: 'unsupported_by_solver',
    }, {
        parsedBy: 'local',
        warnings: 'local warning',
        clarifications: '请补充教师范围',
    });

    assert.deepEqual(ir.parsedBy, ['local', 'ai']);
    assert.deepEqual(ir.warnings, ['local warning', 'AI warning']);
    assert.deepEqual(ir.clarifications, ['请补充教师范围', '请选择唯一教师']);
});


test('ConstraintIR merges clarifications and questions from defaults and candidate without dropping either field', () => {
    const ir = normalizeConstraintIR({
        ...provenance,
        capabilityId: 'teacher.unavailable',
        understandingStatus: 'ambiguous',
        executionStatus: 'unsupported_by_solver',
        clarifications: [],
        questions: ['候选问题', '重复问题'],
    }, {
        clarifications: ['默认澄清', '重复问题'],
        questions: '默认问题',
    });

    assert.deepEqual(ir.clarifications, ['默认澄清', '重复问题', '默认问题', '候选问题']);
});

test('ConstraintIR aggregate understanding is order independent and preserves the most conservative review state', () => {
    const irrelevant = normalizeConstraintIR({
        ...provenance,
        capabilityId: 'legacy.irrelevant',
        understandingStatus: 'irrelevant',
        executionStatus: 'disabled',
    });
    const ambiguous = normalizeConstraintIR({
        ...provenance,
        clauseId: provenance.clauseId + ':ambiguous',
        capabilityId: 'teacher.unavailable',
        understandingStatus: 'ambiguous',
        executionStatus: 'unsupported_by_solver',
    });

    const forward = aggregateConstraintIRStatuses([irrelevant, ambiguous]);
    const reverse = aggregateConstraintIRStatuses([ambiguous, irrelevant]);
    assert.deepEqual(forward, reverse);
    assert.equal(forward.understandingStatus, 'ambiguous');
    assert.equal(forward.reviewStatus, 'needs_clarification');
});
