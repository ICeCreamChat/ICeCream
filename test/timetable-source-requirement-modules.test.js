import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SOURCE_SCHEMA_NAMESPACE,
    SOURCE_SCHEMA_VERSION,
    buildClauseId,
    buildMachineRuleId,
    buildSourceId,
    buildTextHash,
    normalizeSourceDisplayText,
    normalizeSourceText,
    validateUniqueSourceIds,
} from '../gateway/services/timetable-constraints/source-identity.js';
import {
    attachArtifactsToSourceRequirements,
    buildLegacyRequirementItemsFromSources,
    buildSourceRequirements,
    linkArtifactToSource,
    upsertClause,
    upsertMachineRule,
} from '../gateway/services/timetable-constraints/source-requirement.js';
import {
    buildRequirementStatistics,
} from '../gateway/services/timetable-constraints/statistics.js';

function buildSpreadsheetSources() {
    return buildSourceRequirements([
        { sourceSheet: '自然语言约束', sourceRow: 2, rawText: '刘老师周一第2节不要排课。' },
        { sourceSheet: '自然语言约束', sourceRow: 3, rawText: '刘老师周一第2节不要排课。' },
        { sourceSheet: '自然语言约束', sourceRow: 4, rawText: '张老师周二第3节不要排课。' },
    ], {
        inputType: 'xlsx_constraints',
        fileName: 'constraints.xlsx',
        origin: 'user_input',
    });
}

test('source identity normalizes text and keeps schema-scoped deterministic hashes', () => {
    assert.equal(SOURCE_SCHEMA_VERSION, 2);
    assert.match(SOURCE_SCHEMA_NAMESPACE, /timetable-natural-language-source:v2/);
    assert.equal(normalizeSourceText('\uFEFF  刘老师\t周一第2节不要排课。  '), '刘老师 周一第2节不要排课。');
    assert.equal(
        normalizeSourceDisplayText('\uFEFF  AI测试：刘老师周一不要排课，保留原始标点。  '),
        'AI测试：刘老师周一不要排课，保留原始标点。',
    );
    assert.equal(
        buildTextHash('AI测试：刘老师周一不要排课，保留原始标点。'),
        buildTextHash('AI测试:刘老师周一不要排课,保留原始标点。'),
        'identity hashing should remain NFKC-normalized',
    );
    const [displaySource] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: 'AI测试：刘老师周一不要排课，保留原始标点。',
    }], { inputType: 'text', origin: 'user_input' });
    assert.equal(displaySource.rawText, 'AI测试：刘老师周一不要排课，保留原始标点。');
    assert.equal(displaySource.source.rawText, displaySource.rawText);
    assert.equal(
        buildTextHash('刘老师\t周一第2节不要排课。'),
        buildTextHash('  刘老师 周一第2节不要排课。  '),
    );

    const identityMaterial = {
        inputType: 'xlsx_constraints',
        sourceSheet: '自然语言约束',
        sourceRow: 2,
        rawText: '刘老师周一第2节不要排课。',
    };
    assert.equal(
        buildSourceId({ ...identityMaterial, fileName: '第一次上传.xlsx', uploadId: 'upload-1' }),
        buildSourceId({ ...identityMaterial, fileName: '改名后再次上传.xlsx', uploadId: 'upload-2' }),
        'upload/session metadata must not change the source identity',
    );
});

test('clause and machine-rule identities are deterministic, source-scoped, and independent of array position', () => {
    const [first, second] = buildSpreadsheetSources();
    const clauses = [
        { intent: 'avoid_periods', object: { kind: 'teacher', name: '刘老师' }, condition: { slots: ['1-2'] } },
        { intent: 'daily_limit', object: { kind: 'teacher', name: '刘老师' }, parameters: { limit: 4 } },
    ];
    const forwardClauseIds = clauses.map((clause, index) => buildClauseId(first.sourceId, clause, index));
    const reversedClauseIds = [...clauses].reverse().map((clause, index) => buildClauseId(first.sourceId, clause, index));

    assert.deepEqual(new Set(forwardClauseIds), new Set(reversedClauseIds));
    assert.notEqual(buildClauseId(first.sourceId, clauses[0]), buildClauseId(second.sourceId, clauses[0]));
    assert.equal(
        buildClauseId(first.sourceId, { ...clauses[0], evidence: '整句证据' }),
        buildClauseId(first.sourceId, { ...clauses[0], evidence: '较短证据摘录' }),
        'evidence wording is provenance, not clause semantic identity',
    );

    const clauseId = forwardClauseIds[0];
    const rules = [
        { type: 'subject_morning', targetType: 'subject', targetName: '语文', periods: [1, 2, 3, 4] },
        { type: 'subject_morning', targetType: 'subject', targetName: '数学', periods: [1, 2, 3, 4] },
        { type: 'subject_morning', targetType: 'subject', targetName: '英语', periods: [1, 2, 3, 4] },
    ];
    const forwardRuleIds = rules.map((rule, index) => buildMachineRuleId(first.sourceId, clauseId, rule, index));
    const reversedRuleIds = [...rules].reverse().map((rule, index) => buildMachineRuleId(first.sourceId, clauseId, rule, index));

    assert.equal(new Set(forwardRuleIds).size, 3, 'one source may generate multiple distinct machine rules');
    assert.deepEqual(new Set(forwardRuleIds), new Set(reversedRuleIds));
    assert.notEqual(
        buildMachineRuleId(first.sourceId, clauseId, rules[0]),
        buildMachineRuleId(second.sourceId, buildClauseId(second.sourceId, clauses[0]), rules[0]),
    );
    assert.equal(
        buildMachineRuleId(first.sourceId, clauseId, { ...rules[0], status: 'effective', warnings: ['本地提示'], enabled: true }),
        buildMachineRuleId(first.sourceId, clauseId, { ...rules[0], status: 'needs_review', warnings: ['AI 提示'], enabled: false }),
        'review/runtime metadata must not change machine-rule identity',
    );
});

test('artifact linking uses validated stable identity and never falls back to array index', () => {
    const sources = buildSpreadsheetSources();
    const first = sources[0];
    const unique = sources[2];

    const direct = linkArtifactToSource({
        sourceId: first.sourceId,
        textHash: first.textHash,
        intent: 'avoid_periods',
    }, sources, { parsedBy: 'ai' });
    assert.equal(direct.source?.sourceId, first.sourceId);
    assert.equal(direct.artifact.origin, 'user_input');
    assert.deepEqual(direct.artifact.parsedBy, ['ai']);

    assert.equal(linkArtifactToSource({
        sourceId: first.sourceId,
        textHash: buildTextHash('错误原文'),
    }, sources).reason, 'text_hash_mismatch');
    assert.equal(linkArtifactToSource({
        sourceId: 'src:2:unknown',
        textHash: first.textHash,
    }, sources).reason, 'unknown_source_id');

    const byPosition = linkArtifactToSource({
        sourceSheet: '自然语言约束',
        sourceRow: 4,
        textHash: unique.textHash,
    }, sources);
    assert.equal(byPosition.source?.sourceId, unique.sourceId);
    assert.equal(linkArtifactToSource({
        sourceSheet: '自然语言约束',
        sourceRow: 4,
        textHash: first.textHash,
    }, sources).reason, 'text_hash_mismatch');

    assert.equal(linkArtifactToSource({ rawText: unique.rawText }, sources).source?.sourceId, unique.sourceId);
    assert.equal(linkArtifactToSource({ rawText: first.rawText }, sources).reason, 'ambiguous_text_hash');
    assert.equal(linkArtifactToSource({ sourceIndex: 0 }, sources).reason, 'missing_source_identity');
});

test('clause and machine-rule upserts are idempotent within one source', () => {
    const [source] = buildSpreadsheetSources();
    const clause = {
        intent: 'avoid_periods',
        object: { kind: 'teacher', name: '刘老师' },
        condition: { slots: ['1-2'] },
        parsedBy: ['local'],
    };
    const once = upsertClause(source, clause, 0);
    const twice = upsertClause(once, { ...clause, confidence: 0.9, parsedBy: ['ai'] }, 99);

    assert.equal(twice.clauses.length, 1);
    assert.equal(twice.clauses[0].clauseId, once.clauses[0].clauseId);

    const rule = { type: 'teacher_unavailable', targetType: 'teacher', targetName: '刘老师', slots: ['1-2'] };
    const firstRule = upsertMachineRule(twice, rule, twice.clauses[0].clauseId, 0);
    const secondRule = upsertMachineRule(firstRule.sourceRequirement, rule, twice.clauses[0].clauseId, 999);

    assert.equal(firstRule.machineRule.machineRuleId, secondRule.machineRule.machineRuleId);
    assert.equal(secondRule.sourceRequirement.machineRuleIds.length, 1);
});

test('unrecognized sources remain present and receive a legacy review projection', () => {
    const sources = buildSourceRequirements([
        { lineNumber: 1, rawText: '地理和生物尽量隔天分布，不要都挤在周四周五。' },
    ], { inputType: 'text', origin: 'user_input' });
    const attached = attachArtifactsToSourceRequirements(sources, { clauses: [], machineRules: [] });
    const legacy = buildLegacyRequirementItemsFromSources(attached.sourceRequirements);

    assert.equal(attached.sourceRequirements.length, 1);
    assert.equal(attached.sourceRequirements[0].understandingStatus, 'unrecognized');
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].intent, 'unrecognized');
    assert.equal(legacy[0].sourceId, sources[0].sourceId);
});

test('statistics count source categories without double-counting manual compatibility projections', () => {
    const userSources = buildSourceRequirements([
        { lineNumber: 1, rawText: '用户输入。' },
    ], { inputType: 'text', origin: 'user_input' });
    const manualSources = buildSourceRequirements([
        { lineNumber: 1, rawText: '手工输入。' },
    ], { inputType: 'manual', origin: 'manual' });
    const sources = [
        { ...userSources[0], status: 'understood', understandingStatus: 'parsed', executionStatus: 'executable' },
        { ...manualSources[0], status: 'partially_supported', understandingStatus: 'parsed', executionStatus: 'partially_executable' },
        {
            ...buildSourceRequirements([{ lineNumber: 2, rawText: '需要澄清。' }], { inputType: 'text', origin: 'user_input' })[0],
            status: 'needs_clarification',
            understandingStatus: 'ambiguous',
            executionStatus: 'unsupported_by_solver',
        },
        {
            ...buildSourceRequirements([{ lineNumber: 3, rawText: '已理解但求解器不支持。' }], { inputType: 'text', origin: 'user_input' })[0],
            status: 'unsupported',
            understandingStatus: 'parsed',
            executionStatus: 'unsupported_by_solver',
        },
    ];
    const statistics = buildRequirementStatistics({
        sourceRequirements: sources,
        manualRequirements: [
            { sourceId: manualSources[0].sourceId, origin: 'manual' },
            { sourceId: manualSources[0].sourceId, origin: 'manual' },
        ],
        systemSupplements: [
            { supplementId: 'system:1', origin: 'system_supplement' },
            { supplementId: 'system:1', origin: 'system_supplement' },
        ],
        clauses: [
            { clauseId: 'clause:1' },
            { clauseId: 'clause:1' },
            { clauseId: 'clause:2' },
        ],
        machineRules: [
            { machineRuleId: 'rule:1', executionStatus: 'executable' },
            { machineRuleId: 'rule:1', executionStatus: 'executable' },
            { machineRuleId: 'rule:2', executionStatus: 'unsupported_by_solver' },
        ],
        draftRows: [{ id: 'legacy:1' }, { id: 'legacy:2' }, { id: 'legacy:3' }],
    });

    assert.equal(statistics.sourceRequirementCount, 4);
    assert.equal(statistics.userInputCount, 3);
    assert.equal(statistics.manualInputCount, 1);
    assert.equal(statistics.systemSupplementCount, 1);
    assert.equal(statistics.understoodSourceCount, 1);
    assert.equal(statistics.needsClarificationSourceCount, 1);
    assert.equal(statistics.partiallySupportedSourceCount, 1);
    assert.equal(statistics.unsupportedSourceCount, 1);
    assert.equal(statistics.clauseCount, 2);
    assert.equal(statistics.machineRuleCount, 2);
    assert.equal(statistics.executableMachineRuleCount, 1);
    assert.equal(statistics.unsupportedMachineRuleCount, 1);
    assert.equal(statistics.draftRowCount, 3);
});


test('requirement statistics accept singleton collection objects without dropping them', () => {
    const statistics = buildRequirementStatistics({
        sourceRequirements: {
            sourceId: 'src:singleton:user',
            origin: 'user_input',
            status: 'understood',
            understandingStatus: 'parsed',
            executionStatus: 'executable',
        },
        systemSupplements: { supplementId: 'supplement:singleton' },
        manualRequirements: { requirementId: 'manual:singleton', origin: 'manual' },
        clauses: { clauseId: 'clause:singleton' },
        machineRules: { machineRuleId: 'rule:singleton', executionStatus: 'executable' },
        draftRows: { id: 'draft:singleton' },
        semanticActions: { id: 'action:singleton' },
    });

    assert.equal(statistics.sourceRequirementCount, 1);
    assert.equal(statistics.userInputCount, 1);
    assert.equal(statistics.manualInputCount, 1);
    assert.equal(statistics.systemSupplementCount, 1);
    assert.equal(statistics.understoodSourceCount, 1);
    assert.equal(statistics.clauseCount, 1);
    assert.equal(statistics.machineRuleCount, 1);
    assert.equal(statistics.executableMachineRuleCount, 1);
    assert.equal(statistics.draftRowCount, 1);
    assert.equal(statistics.semanticActionCount, 1);
});

test('source identity validation accepts a singleton source object', () => {
    assert.deepEqual(validateUniqueSourceIds({ sourceId: 'src:singleton:user' }), {
        valid: true,
        duplicates: [],
        uniqueCount: 1,
    });
    assert.deepEqual(validateUniqueSourceIds({}), {
        valid: false,
        duplicates: ['(missing)'],
        uniqueCount: 0,
    });
});


test('source requirements preserve scalar provenance and review arrays', () => {
    const [source] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '张老师周一第1节不排课。',
        parsedBy: 'ai',
        machineRuleIds: 'machine-rule-1',
        warnings: '需要人工复核',
        questions: '是否指张老师本人？',
    }], { inputType: 'text', origin: 'user_input' });

    assert.deepEqual(source.parsedBy, ['ai']);
    assert.deepEqual(source.machineRuleIds, ['machine-rule-1']);
    assert.deepEqual(source.warnings, ['需要人工复核']);
    assert.deepEqual(source.questions, ['是否指张老师本人?']);
});


test('artifact attachment normalizes scalar arrays from compatibility sources', () => {
    const [source] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '张老师周一第1节不排课。',
    }], { inputType: 'text', origin: 'user_input' });
    const attached = attachArtifactsToSourceRequirements([{
        ...source,
        parsedBy: 'local',
        warnings: '兼容来源警告',
        machineRuleIds: 'legacy-machine-rule',
    }], {
        parsedBy: 'ai',
        clauses: [{
            sourceId: source.sourceId,
            textHash: source.source.textHash,
            intent: 'avoid_periods',
            object: { kind: 'teacher', name: '张老师' },
            parsedBy: 'ai',
        }],
    });

    assert.deepEqual(attached.sourceRequirements[0].parsedBy, ['local', 'ai']);
    assert.deepEqual(attached.sourceRequirements[0].warnings, ['兼容来源警告']);
    assert.deepEqual(attached.sourceRequirements[0].machineRuleIds, ['legacy-machine-rule']);
});


test('source requirements merge questions and clarifications at the compatibility boundary', () => {
    const [source] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '张老师周一第1节不排课。',
        questions: [],
        clarifications: ['请确认教师', '请确认时间'],
    }], { inputType: 'text', origin: 'user_input' });

    assert.deepEqual(source.questions, ['请确认教师', '请确认时间']);
});

test('source attachment flattens parser actor arrays, normalizes questions, and preserves irrelevant understanding', () => {
    const [source] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '这是一句与排课无关的寒暄。',
    }], { inputType: 'text', origin: 'user_input' });
    const linked = linkArtifactToSource({
        sourceId: source.sourceId,
        textHash: source.textHash,
        parsedBy: 'legacy',
    }, [{ ...source, parsedBy: 'local' }], { parsedBy: ['ai', 'review'] });
    assert.deepEqual(linked.artifact.parsedBy, ['local', 'legacy', 'ai', 'review']);

    const attached = attachArtifactsToSourceRequirements([{
        ...source,
        parsedBy: 'local',
        questions: '这是兼容层问题',
    }], {
        parsedBy: ['ai', 'review'],
        clauses: [{
            sourceId: source.sourceId,
            textHash: source.textHash,
            intent: 'irrelevant',
            understandingStatus: 'irrelevant',
            executionStatus: 'disabled',
        }],
    });

    assert.deepEqual(attached.sourceRequirements[0].parsedBy, ['local', 'ai', 'review']);
    assert.deepEqual(attached.sourceRequirements[0].questions, ['这是兼容层问题']);
    assert.equal(attached.sourceRequirements[0].understandingStatus, 'irrelevant');
    assert.equal(attached.sourceRequirements[0].status, 'irrelevant');
});
