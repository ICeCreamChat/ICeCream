import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
} from '../gateway/services/timetable-rule-parser.js';
import {
    buildSourceRequirements,
} from '../gateway/services/timetable-constraints/source-requirement.js';

function project(overrides = {}) {
    return {
        teachers: [
            { id: 't1', name: '张老师' },
            { id: 't2', name: '李老师' },
        ],
        classes: [{ id: 'c1', name: '七(1)班', grade: '七年级' }],
        subjects: [
            { id: 's1', name: '语文' },
            { id: 's2', name: '数学' },
            { id: 's3', name: '英语' },
        ],
        periodsPerDay: 8,
        weekdays: 5,
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    };
}

function semanticRequirement(source, id) {
    return {
        id,
        sourceId: source.sourceId,
        textHash: source.source.textHash,
        origin: 'user_input',
        parsedBy: ['ai'],
        object: { kind: 'teacher', name: '张老师', matchedIds: ['t1'], scope: 'explicit' },
        intent: 'schedule_request',
        condition: { slots: ['1-1'] },
        parameters: { slots: ['1-1'] },
        strength: 'hard',
        status: 'needs_review',
        applyTo: 'review',
        confidence: 0.9,
        source: {
            sourceId: source.sourceId,
            textHash: source.source.textHash,
            rawText: source.source.rawText,
            lineNumber: source.source.lineNumber,
        },
    };
}

test('row-to-semantic linking is source-scoped before legacy fuzzy matching', () => {
    const sources = buildSourceRequirements([
        { lineNumber: 1, rawText: '张老师周一第1节不排课。' },
        { lineNumber: 2, rawText: '张老师周一第1节不排课。' },
    ], { inputType: 'text', origin: 'user_input' });
    const requirements = [
        semanticRequirement(sources[0], 'req_first_source'),
        semanticRequirement(sources[1], 'req_second_source'),
    ];

    const result = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'ai',
        inputType: 'text',
        sourceRequirements: sources,
        semanticRequirements: requirements,
        draftRows: [{
            id: 'legacy-row-id-must-survive',
            sourceId: sources[1].sourceId,
            textHash: sources[1].source.textHash,
            lineNumber: 2,
            rawText: sources[1].source.rawText,
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't1',
            targetName: '张老师',
            slots: ['1-1'],
            status: 'effective',
            priority: 'hard',
        }],
    });

    const row = result.draftRows.find(item => item.id === 'legacy-row-id-must-survive');
    assert.ok(row);
    assert.equal(row.requirementId, 'req_second_source');
    assert.equal(row.sourceId, sources[1].sourceId);
    assert.ok(row.clauseId.startsWith(`${sources[1].sourceId}:clause:`));
    assert.notEqual(row.machineRuleId, row.id, 'new semantic identity must not overwrite the old row id');
});

test('legacy draft rows without origin remain unknown across requirement and IR projections', () => {
    const result = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'legacy_import',
        inputType: 'legacy',
        draftRows: [{
            id: 'legacy-row-without-origin',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't1',
            targetName: '张老师',
            slots: ['1-1'],
            status: 'effective',
            priority: 'hard',
            rawText: '张老师周一第1节不排课。',
        }],
    });

    assert.equal(result.requirementItems[0].origin, 'unknown');
    assert.equal(result.requirementItems[0].source.origin, 'unknown');
    assert.equal(result.constraintIRs[0].origin, 'unknown');
    assert.equal(result.draftRows[0].origin, 'unknown');
    assert.equal(result.statistics.userInputCount, 0);
});

test('semantic actions and source-bound warnings preserve complete provenance', async () => {
    const result = await parseTimetableRules({
        text: [
            '张老师周一第1节不排课。',
            '不存在老师周二第2节不排课。',
        ].join('\n'),
        project: project(),
        env: {},
    });
    const actionSource = result.sourceRequirements[0];
    const warningSource = result.sourceRequirements[1];
    assert.ok(actionSource);
    assert.ok(warningSource);
    assert.equal(actionSource.origin, 'user_input');
    assert.ok(actionSource.parsedBy.includes('local'));

    const sourceActions = result.semanticActions.filter(action => action.sourceId === actionSource.sourceId);
    assert.ok(sourceActions.length > 0);
    for (const action of sourceActions) {
        assert.equal(action.textHash, actionSource.source.textHash);
        assert.equal(action.origin, 'user_input');
        assert.ok(action.parsedBy.includes('local'));
        assert.equal(action.lineNumber, 1);
        assert.ok(action.rawText);
        assert.ok(action.clauseId);
    }

    assert.ok(Array.isArray(result.warningItems));
    const linkedWarnings = result.warningItems.filter(item => item.sourceId === warningSource.sourceId);
    assert.ok(linkedWarnings.length > 0);
    assert.ok(linkedWarnings.every(item => item.textHash === warningSource.source.textHash));
    assert.ok(linkedWarnings.every(item => item.origin === 'user_input'));
    assert.ok(linkedWarnings.every(item => item.parsedBy.includes('local')));
    assert.ok(linkedWarnings.some(item => /没有匹配对象|需要复核|未找到/.test(item.message)));
});
test('text, txt, csv, and manual entry points archive sources before parsing', async () => {
    const plainText = await parseTimetableRules({
        text: ['张老师周一第1节不排课。', '李老师周二第2节不排课。'].join('\n'),
        project: project(),
        env: {},
    });
    assert.equal(plainText.sourceRequirements.length, 2);
    assert.ok(plainText.sourceRequirements.every(item => item.source.inputType === 'text'));

    for (const [filename, inputType] of [['constraints.txt', 'txt'], ['constraints.csv', 'csv_text']]) {
        const uploaded = await parseTimetableRules({
            file: {
                filename,
                buffer: Buffer.from('张老师周一第1节不排课。\n李老师周二第2节不排课。', 'utf8'),
            },
            project: project(),
            env: {},
        });
        assert.equal(uploaded.sourceRequirements.length, 2);
        assert.ok(uploaded.sourceRequirements.every(item => item.source.inputType === inputType));
        assert.ok(uploaded.sourceRequirements.every(item => item.origin === 'user_input'));
    }

    const manual = normalizeTimetableRuleDraftRows({
        project: project(),
        inputType: 'manual',
        draftRows: [{
            id: 'manual-before-expand',
            rawText: '语文、数学、英语尽量安排在上午前四节。',
            type: 'subject_morning',
            targetType: 'subject',
            targetName: '语文、数学、英语',
            targetIds: ['s1', 's2', 's3'],
            periods: [1, 2, 3, 4],
            status: 'effective',
        }],
    });
    assert.equal(manual.sourceRequirements.length, 1, 'manual source must be archived before grouped target expansion');
    assert.equal(manual.sourceRequirements[0].origin, 'manual');
    assert.equal(manual.draftRows.length, 3);
});

test('origin and parsedBy remain orthogonal for AI, manual, and system supplements', () => {
    const [source] = buildSourceRequirements([
        { lineNumber: 1, rawText: '张老师周一第1节不排课。' },
    ], { inputType: 'text', origin: 'user_input' });
    const aiResult = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'ai',
        inputType: 'text',
        sourceRequirements: [source],
        draftRows: [{
            id: 'ai-user-row',
            sourceId: source.sourceId,
            textHash: source.source.textHash,
            rawText: source.source.rawText,
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '张老师',
            slots: ['1-1'],
            status: 'effective',
        }],
    });
    assert.equal(aiResult.sourceRequirements[0].origin, 'user_input');
    assert.ok(aiResult.sourceRequirements[0].parsedBy.includes('ai'));
    assert.equal(aiResult.draftRows[0].origin, 'user_input');
    assert.ok(aiResult.draftRows[0].parsedBy.includes('ai'));

    const manualResult = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'school_workflow_review',
        inputType: 'manual',
        draftRows: [{
            id: 'manual-row',
            rawText: '李老师周二第2节不排课。',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '李老师',
            slots: ['2-2'],
            status: 'effective',
        }],
    });
    assert.equal(manualResult.sourceRequirements.length, 1);
    assert.equal(manualResult.sourceRequirements[0].origin, 'manual');
    assert.ok(manualResult.sourceRequirements[0].parsedBy.includes('manual'));
    assert.equal(manualResult.draftRows[0].origin, 'manual');
    assert.equal(manualResult.statistics.userInputCount, 0);
    assert.equal(manualResult.statistics.manualInputCount, 1);

    const systemResult = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'local_text',
        inputType: 'text',
        originalText: '同一位教师同一时间只能给一个班上课。',
        sourceRequirements: buildSourceRequirements([
            { lineNumber: 1, rawText: '同一位教师同一时间只能给一个班上课。' },
        ], { inputType: 'text', origin: 'user_input' }),
    });
    const supplement = systemResult.systemSupplements.find(item => item.requirement?.intent === 'teacher_time_conflict');
    assert.ok(supplement);
    assert.equal(supplement.origin, 'system_supplement');
    assert.equal(systemResult.statistics.userInputCount, 1);
    assert.equal(systemResult.statistics.systemSupplementCount, 1);
    const action = systemResult.semanticActions.find(item => item.requirementId === supplement.requirement.id);
    assert.ok(action);
    assert.equal(action.origin, 'system_supplement');
    assert.ok(action.parsedBy.includes('local'));
});

test('legacy arrays remain compatible while unrecognized source input gets a review projection', () => {
    const sourceRequirements = buildSourceRequirements([
        { lineNumber: 1, rawText: '地理和生物尽量隔天分布，不要都挤在周四周五。' },
    ], { inputType: 'text', origin: 'user_input' });
    const result = normalizeTimetableRuleDraftRows({
        project: project({
            subjects: [
                { id: 'geo', name: '地理' },
                { id: 'bio', name: '生物' },
            ],
        }),
        source: 'local_text',
        inputType: 'text',
        sourceRequirements,
        draftRows: [],
        originalText: '',
    });

    assert.ok(Array.isArray(result.requirementItems));
    assert.ok(Array.isArray(result.draftRows));
    assert.ok(Array.isArray(result.semanticActions));
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.warningItems));
    assert.equal(result.sourceRequirements.length, 1);
    const source = result.sourceRequirements[0];
    const projection = result.requirementItems.find(item => item.sourceId === source.sourceId);
    assert.ok(projection, 'every source must remain visible to legacy consumers even with zero machine rows');
    assert.equal(projection.status, 'needs_review');
    assert.equal(projection.origin, 'user_input');
    assert.equal(result.statistics.userInputCount, 1);
});



test('manual source preparation preserves scalar parsedBy without splitting characters', () => {
    const result = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'school_workflow_review',
        inputType: 'manual',
        draftRows: [{
            id: 'manual-scalar-parser',
            rawText: '张老师周一第1节不排课。',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '张老师',
            slots: ['1-1'],
            status: 'effective',
            parsedBy: 'ai',
        }],
    });

    assert.deepEqual(result.sourceRequirements[0].parsedBy, ['ai', 'manual']);
    assert.ok(result.draftRows[0].parsedBy.includes('ai'));
    assert.ok(result.draftRows[0].parsedBy.includes('manual'));
    assert.ok(result.draftRows[0].parsedBy.includes('capability_registry'));
    assert.ok(!result.draftRows[0].parsedBy.includes('a'));
});

test('draft row normalization preserves scalar metadata and merges questions with clarifications', () => {
    const result = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'ai',
        inputType: 'legacy',
        draftRows: [{
            id: 'scalar-metadata-row',
            type: 'subject_daily_limit',
            targetType: 'subject',
            targetId: 's1',
            targetName: '语文',
            limit: 2,
            status: 'effective',
            parsedBy: 'ai',
            warnings: '单值 warning',
            clarifications: '先确认范围',
            questions: ['再确认强度'],
            landing: 'rule',
            aiReviewWarnings: '复审单值 warning',
            ambiguities: { field: 'scope' },
        }],
    });

    const row = result.draftRows.find(item => item.id === 'scalar-metadata-row');
    assert.ok(row);
    assert.deepEqual(row.parsedBy, ['ai']);
    assert.deepEqual(row.warnings, ['单值 warning']);
    assert.deepEqual(row.clarifications, ['先确认范围', '再确认强度']);
    assert.deepEqual(row.landing, ['rule']);
    assert.deepEqual(row.aiReviewWarnings, ['复审单值 warning']);
    assert.deepEqual(row.ambiguities, [{ field: 'scope' }]);
});

test('semantic requirement matching accepts scalar entity ids at legacy boundaries', () => {
    const result = normalizeTimetableRuleDraftRows({
        project: project(),
        source: 'legacy_import',
        inputType: 'legacy',
        semanticRequirements: [{
            id: 'scalar-target-requirement',
            object: {
                kind: 'teacher',
                name: '张老师',
                matchedIds: 't1',
                scope: 'explicit',
            },
            intent: 'teacher_daily_limit',
            parameters: { limit: 3 },
            strength: 'hard',
            status: 'actionable',
            applyTo: 'rule',
            warnings: '单值语义 warning',
            aiReviewWarnings: '单值语义复审 warning',
            machineRuleIds: 'legacy-machine-rule',
        }],
        draftRows: [{
            id: 'scalar-target-row',
            type: 'teacher_daily_limit',
            targetType: 'teacher',
            targetId: 't1',
            targetName: '张老师',
            limit: 3,
            status: 'effective',
        }],
    });

    const requirement = result.requirementItems.find(item => item.id === 'scalar-target-requirement');
    assert.ok(requirement);
    assert.deepEqual(requirement.object.matchedIds, ['t1']);
    assert.ok(requirement.machineRuleIds.includes('legacy-machine-rule'));
    assert.deepEqual(requirement.warnings, ['单值语义 warning']);
    assert.deepEqual(requirement.aiReviewWarnings, ['单值语义复审 warning']);
    const row = result.draftRows.find(item => item.id === 'scalar-target-row');
    assert.equal(row.requirementId, 'scalar-target-requirement');
});