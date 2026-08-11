import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    parseTimetableRules,
    recompileTimetableSourceRequirement,
} from '../gateway/services/timetable-rule-parser.js';
import {
    resolveSemanticAiMode,
    sourceNeedsSemanticPlanning,
    validateSemanticRelationGraph,
} from '../gateway/services/timetable-constraints/semantic-planning.js';
import {
    CONSTRAINT_IR_SCHEMA_VERSION,
    normalizeConstraintIR,
} from '../gateway/services/timetable-constraints/constraint-ir.js';
import { createCompleteNaturalLanguage137Project } from './fixtures/timetable-natural-language-137-project.js';
import { TIMETABLE_CONSTRAINT_WORKBOOK_PATH } from './fixtures/timetable-workbook-paths.js';

const workbookPath = TIMETABLE_CONSTRAINT_WORKBOOK_PATH;

async function parseCompleteWorkbook() {
    return parseTimetableRules({
        file: { filename: path.basename(workbookPath), buffer: fs.readFileSync(workbookPath) },
        project: createCompleteNaturalLanguage137Project(),
        env: {
            TIMETABLE_RULE_AI_MODE: 'off',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true',
        },
    });
}

function sourceByRow(result, rowNumber) {
    return result.sourceRequirements.find(item => item.source?.rowNumber === rowNumber);
}

function clausesByRow(result, rowNumber) {
    const source = sourceByRow(result, rowNumber);
    assert.ok(source, `missing source row ${rowNumber}`);
    return result.constraintIRs.filter(item => item.sourceId === source.sourceId);
}

test('ConstraintIR v2 normalizes derived scope, semantic relation and quantifier', () => {
    const ir = normalizeConstraintIR({
        sourceId: 'src:test',
        clauseId: 'src:test:clause:2',
        capabilityId: 'subject.preferred_day_part',
        intent: 'preferred_day_part',
        target: { kind: 'subject', name: '语文', matchedIds: ['subject-1'] },
        scope: { kind: 'teacher_covered_classes', classIds: ['class-1'], teacherIds: ['teacher-1'] },
        relation: { kind: 'emphasis', parentClauseId: 'src:test:clause:1' },
        quantifier: { unit: 'occurrences_per_week', min: 3 },
        understandingStatus: 'parsed',
        executionStatus: 'executable',
    });

    assert.equal(CONSTRAINT_IR_SCHEMA_VERSION, 2);
    assert.equal(ir.schemaVersion, 2);
    assert.equal(ir.scope.kind, 'teacher_covered_classes');
    assert.equal(ir.relation.kind, 'emphasis');
    assert.equal(ir.relation.parentClauseId, 'src:test:clause:1');
    assert.deepEqual(ir.quantifier, { min: 3, unit: 'occurrences_per_week' });
});

test('semantic AI mode preserves legacy flags and defaults configured runtime to targeted', () => {
    assert.equal(resolveSemanticAiMode({ TIMETABLE_RULE_AI_MODE: 'off', DEEPSEEK_API_KEY: 'key' }), 'off');
    assert.equal(resolveSemanticAiMode({ TIMETABLE_RULE_AI_MODE: 'all', DEEPSEEK_API_KEY: 'key' }), 'all');
    assert.equal(resolveSemanticAiMode({ TIMETABLE_RULE_AI_EXTRACT: '1', DEEPSEEK_API_KEY: 'key' }), 'all');
    assert.equal(resolveSemanticAiMode({ TIMETABLE_RULE_AI_EXTRACT: '0', DEEPSEEK_API_KEY: 'key' }), 'off');
    assert.equal(resolveSemanticAiMode({ DEEPSEEK_API_KEY: 'key' }), 'targeted');
    assert.equal(resolveSemanticAiMode({}), 'off');
});

test('complexity routing selects compound semantics without sending simple constraints to the model', () => {
    assert.equal(sourceNeedsSemanticPlanning({ rawText: '张老师周一第1节不能上课。', understandingStatus: 'parsed', executionStatus: 'executable' }), false);
    assert.equal(sourceNeedsSemanticPlanning({ rawText: '体育课不要排每天第一节，也尽量不要排午休后的第5节。' }), true);
    assert.equal(sourceNeedsSemanticPlanning({ rawText: '语数英尽量上午，尤其是这些教师覆盖的班级。' }), true);
    assert.equal(sourceNeedsSemanticPlanning({ rawText: '九年级语文每周至少3次排第1到第3节，不要集中到下午。' }), true);
});

test('single-subject day-part concentration remains unsupported semantics instead of becoming an all-afternoon avoidance rule', async () => {
    const result = await parseTimetableRules({
        text: '九年级语文每周尽量有3次以上排在第1到第3节，不要集中到下午。',
        project: createCompleteNaturalLanguage137Project(),
        env: {
            TIMETABLE_RULE_AI_MODE: 'off',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true',
        },
    });
    const [source] = result.sourceRequirements;
    const preferred = source.clauses.find(item => item.capabilityId === 'subject.preferred_periods');
    const concentration = source.clauses.find(item => item.capabilityId === 'subject.avoid_day_part_concentration');

    assert.ok(preferred);
    assert.equal(preferred.executionStatus, 'executable');
    assert.equal(preferred.parameters.minOccurrences, 3);
    assert.deepEqual(preferred.parameters.periods, [1, 2, 3]);
    assert.ok(concentration);
    assert.equal(concentration.executionStatus, 'unsupported_by_solver');
    assert.equal(concentration.object.kind, 'subject');
    assert.equal(source.partiallyApplicable, true);
    assert.equal(result.constraintIRs.some(item => item.capabilityId === 'subject.avoid_periods'), false);
    assert.equal(result.draftRows.length, 1);
});

test('semantic relation validation rejects missing parents, cycles and evidence outside the source', () => {
    const sourceText = '语文尽量排上午，尤其是刘老师任教的班级。';
    const valid = validateSemanticRelationGraph(sourceText, [
        { id: 'base', evidence: '语文尽量排上午', relation: { kind: 'independent' } },
        { id: 'focus', evidence: '尤其是刘老师任教的班级', relation: { kind: 'emphasis', parentId: 'base' } },
    ]);
    assert.equal(valid.valid, true);

    const invalid = validateSemanticRelationGraph(sourceText, [
        { id: 'a', evidence: '不存在的证据', relation: { kind: 'emphasis', parentId: 'b' } },
        { id: 'b', evidence: '语文尽量排上午', relation: { kind: 'inherits', parentId: 'a' } },
    ]);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some(error => error.code === 'evidence_mismatch'));
    assert.ok(invalid.errors.some(error => error.code === 'relation_cycle'));
});

test('real complex sources derive safe scopes and preserve compound semantics', async () => {
    const result = await parseCompleteWorkbook();

    const row114 = clausesByRow(result, 114);
    assert.equal(row114.length, 6);
    assert.equal(row114.filter(item => item.relation?.kind === 'emphasis').length, 3);
    assert.equal(row114.filter(item => item.relation?.kind !== 'emphasis').length, 3);
    row114.forEach(item => {
        assert.equal(item.executionStatus, 'executable');
        assert.ok(item.scope.classIds.length > 0);
    });

    const row115 = clausesByRow(result, 115);
    const preferred = row115.filter(item => item.capabilityId === 'subject.preferred_periods');
    const concentration = row115.find(item => item.capabilityId === 'subject.avoid_day_part_concentration');
    assert.equal(preferred.length, 3);
    preferred.forEach(item => {
        assert.equal(item.parameters.minOccurrences, 3);
        assert.deepEqual(item.parameters.periods, [1, 2, 3]);
        assert.equal(item.executionStatus, 'executable');
        assert.equal(item.scope.classIds.length, 10);
    });
    assert.ok(concentration);
    assert.equal(concentration.executionStatus, 'unsupported_by_solver');
    assert.equal(sourceByRow(result, 115).partiallyApplicable, true);
    assert.equal(sourceByRow(result, 115).applicableMachineRuleIds.length, 3);
    assert.deepEqual(sourceByRow(result, 115).unresolvedClauseIds, [concentration.clauseId]);

    const row116 = clausesByRow(result, 116);
    assert.equal(row116.length, 2);
    assert.ok(row116.every(item => item.executionStatus === 'executable' && item.scope.classIds.length === 10));
    assert.ok(sourceByRow(result, 116).rationales.some(item => /学习压力/.test(item.text)));

    const row117 = clausesByRow(result, 117);
    assert.equal(row117.find(item => item.parameters.periods?.[0] === 1)?.strength, 'hard');
    assert.equal(row117.find(item => item.parameters.periods?.[0] === 5)?.strength, 'soft');
    assert.ok(row117.every(item => item.executionStatus === 'executable' && item.scope.classIds.length === 30));

    const row118 = clausesByRow(result, 118);
    assert.equal(row118.length, 1);
    assert.equal(row118[0].executionStatus, 'executable');
    assert.equal(row118[0].scope.classIds.length, 30);
    assert.ok(sourceByRow(result, 118).rationales.some(item => /黄金时段/.test(item.text)));

    const row120 = clausesByRow(result, 120);
    assert.equal(row120.length, 1);
    assert.equal(row120[0].executionStatus, 'executable');
    assert.equal(row120[0].scope.classIds.length, 30);
    assert.ok(sourceByRow(result, 120).rationales.some(item => /材料领取/.test(item.text)));

    const row132 = clausesByRow(result, 132);
    assert.equal(row132.length, 5);
    assert.ok(row132.every(item => (
        item.executionStatus === 'executable'
        && item.strength === 'hard'
        && item.scope.classIds.length === 10
        && item.parameters.days[0] === 5
        && item.parameters.periods[0] === 8
    )));

    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(new Set(result.sourceRequirements.map(item => item.sourceId)).size, 137);
});

test('source recompile replaces only the edited source and validates text identity', async () => {
    const previousResult = await parseCompleteWorkbook();
    const source = sourceByRow(previousResult, 115);
    const untouchedClauseIds = clausesByRow(previousResult, 114).map(item => item.clauseId).sort();
    const previousMachineRuleIds = previousResult.draftRows
        .filter(item => item.sourceId === source.sourceId)
        .map(item => item.machineRuleId)
        .sort();
    const editedClauses = source.clauses.filter(clause => (
        clause.capabilityId !== 'subject.avoid_day_part_concentration'
    ));

    const result = recompileTimetableSourceRequirement({
        project: createCompleteNaturalLanguage137Project(),
        previousResult,
        sourceId: source.sourceId,
        textHash: source.source.textHash,
        clauses: editedClauses,
        rationales: [{ text: '毕业年级主科优先保障上午学习效率。', evidence: '九年级语文、数学、英语' }],
    });

    assert.equal(clausesByRow(result, 115).length, 3);
    assert.equal(clausesByRow(result, 115).some(item => item.capabilityId === 'subject.avoid_day_part_concentration'), false);
    assert.deepEqual(clausesByRow(result, 114).map(item => item.clauseId).sort(), untouchedClauseIds);
    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(previousResult.constraintIRs.length, 154);
    assert.equal(previousResult.draftRows.length, 153);
    assert.equal(result.constraintIRs.length, 153);
    assert.equal(result.draftRows.length, 153);
    assert.deepEqual(
        result.draftRows.filter(item => item.sourceId === source.sourceId).map(item => item.machineRuleId).sort(),
        previousMachineRuleIds,
    );
    assert.ok(sourceByRow(result, 115).rationales.some(item => /学习效率/.test(item.text)));

    assert.throws(() => recompileTimetableSourceRequirement({
        project: createCompleteNaturalLanguage137Project(),
        previousResult,
        sourceId: source.sourceId,
        textHash: 'stale-text-hash',
        clauses: editedClauses,
    }), error => error?.reason === 'source_text_hash_mismatch');
});

test('source recompile derives the object label from selected entity ids and rejects cross-kind ids', async () => {
    const project = createCompleteNaturalLanguage137Project();
    const previousResult = await parseCompleteWorkbook();
    const source = sourceByRow(previousResult, 115);
    const chineseClause = source.clauses.find(item => item.object?.name === '语文');
    const math = project.subjects.find(item => item.name === '数学');
    assert.ok(chineseClause);
    assert.ok(math);

    const editedClauses = source.clauses.map(clause => clause.clauseId === chineseClause.clauseId
        ? {
            ...clause,
            object: {
                ...clause.object,
                name: '语文',
                matchedIds: [math.id],
            },
        }
        : clause);
    const result = recompileTimetableSourceRequirement({
        project,
        previousResult,
        sourceId: source.sourceId,
        textHash: source.source.textHash,
        clauses: editedClauses,
        rationales: source.rationales,
    });
    const editedClause = sourceByRow(result, 115).clauses.find(item => item.clauseId === chineseClause.clauseId);
    const editedRow = result.draftRows.find(item => item.clauseId === chineseClause.clauseId);

    assert.deepEqual(editedClause.object.matchedIds, [math.id]);
    assert.equal(editedClause.object.name, '数学');
    assert.equal(editedRow.targetId, math.id);
    assert.equal(editedRow.targetName, '数学');

    const invalidClauses = source.clauses.map(clause => clause.clauseId === chineseClause.clauseId
        ? { ...clause, object: { ...clause.object, matchedIds: [project.classes[0].id] } }
        : clause);
    assert.throws(() => recompileTimetableSourceRequirement({
        project,
        previousResult,
        sourceId: source.sourceId,
        textHash: source.source.textHash,
        clauses: invalidClauses,
        rationales: source.rationales,
    }), error => error?.reason === 'source_clause_object_mismatch');
});

test('source recompile only accepts capability-owned edits and preserves unknown original extensions', async () => {
    const project = createCompleteNaturalLanguage137Project();
    const previousResult = await parseCompleteWorkbook();
    const source = sourceByRow(previousResult, 115);
    const preferred = source.clauses.find(item => item.capabilityId === 'subject.preferred_periods');
    assert.ok(preferred);
    preferred.parameters.futureExtension = { mode: 'preserve' };
    const editedClauses = source.clauses.map(clause => clause.clauseId === preferred.clauseId
        ? {
            ...clause,
            parameters: {
                ...clause.parameters,
                minOccurrences: 2,
                dayPart: 'afternoon',
                futureExtension: { mode: 'overwrite' },
                arbitraryFlag: true,
            },
        }
        : clause);

    const result = recompileTimetableSourceRequirement({
        project,
        previousResult,
        sourceId: source.sourceId,
        textHash: source.source.textHash,
        clauses: editedClauses,
        rationales: source.rationales,
    });
    const edited = sourceByRow(result, 115).clauses.find(item => item.clauseId === preferred.clauseId);

    assert.equal(edited.parameters.minOccurrences, 2);
    assert.deepEqual(edited.parameters.futureExtension, { mode: 'preserve' });
    assert.equal(Object.hasOwn(edited.parameters, 'dayPart'), false);
    assert.equal(Object.hasOwn(edited.parameters, 'arbitraryFlag'), false);
});
