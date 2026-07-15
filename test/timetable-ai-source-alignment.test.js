import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import {
    applyAiReviewToParseResult,
    parseTimetableRules,
} from '../gateway/services/timetable-rule-parser.js';
import {
    buildAiRequirementExtractionMessages,
} from '../gateway/services/timetable-ai-prompts.js';
import {
    extractRequirementsWithAI,
} from '../gateway/services/timetable-ai-extractor.js';
import {
    alignAiArtifactsToSources,
    sourceRequirementsToAiInputs,
} from '../gateway/services/timetable-constraints/ai-source-alignment.js';
import {
    buildSourceRequirements,
} from '../gateway/services/timetable-constraints/source-requirement.js';

function project() {
    return createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        teachers: [
            { id: 't_zhang', name: '张老师', subjects: ['math'], unavailableSlots: [] },
            { id: 't_li', name: '李老师', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: '七年级', name: '1班' }],
        subjects: [
            { id: 'math', name: '数学' },
            { id: 'chinese', name: '语文' },
        ],
        rooms: [],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_zhang', weeklyHours: 5 },
            { id: 'lp_chinese', classId: 'c1', subjectId: 'chinese', teacherId: 't_li', weeklyHours: 5 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
}

function textSources(lines) {
    return buildSourceRequirements(lines.map((rawText, index) => ({
        lineNumber: index + 1,
        rawText,
    })), { inputType: 'text', origin: 'user_input' });
}

function aiIdentity(source) {
    return {
        sourceId: source.sourceId,
        textHash: source.source.textHash,
    };
}

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

test('AI artifacts align by sourceId and textHash even when response order is reversed', () => {
    const sources = textSources([
        '张老师周一第1节不排课。',
        '李老师周二第2节不排课。',
    ]);
    const result = alignAiArtifactsToSources([
        { id: 'second', ...aiIdentity(sources[1]), evidence: sources[1].source.rawText },
        { id: 'first', ...aiIdentity(sources[0]), evidence: sources[0].source.rawText },
    ], sources, { artifactKind: 'requirement' });

    assert.deepEqual(result.artifacts.map(item => item.id), ['second', 'first']);
    assert.equal(result.artifacts[0].lineNumber, 2);
    assert.equal(result.artifacts[1].lineNumber, 1);
    assert.equal(result.rejected.length, 0);
});

test('one source may produce multiple AI artifacts without consuming the next source', () => {
    const sources = textSources([
        '张老师周一第1节不排课，并且数学尽量排上午。',
        '李老师周二第2节不排课。',
    ]);
    const result = alignAiArtifactsToSources([
        { id: 'a1', ...aiIdentity(sources[0]), evidence: '张老师周一第1节不排课' },
        { id: 'a2', ...aiIdentity(sources[0]), evidence: '数学尽量排上午' },
        { id: 'b1', ...aiIdentity(sources[1]), evidence: sources[1].source.rawText },
    ], sources, { artifactKind: 'requirement' });

    assert.deepEqual(result.artifacts.map(item => item.sourceId), [
        sources[0].sourceId,
        sources[0].sourceId,
        sources[1].sourceId,
    ]);
    assert.equal(result.rejected.length, 0);
});

test('unknown sourceId and textHash mismatch are rejected with structured warnings', () => {
    const sources = textSources(['张老师周一第1节不排课。']);
    const result = alignAiArtifactsToSources([
        { id: 'unknown', sourceId: 'src:unknown', textHash: sources[0].source.textHash, evidence: sources[0].source.rawText },
        { id: 'mismatch', sourceId: sources[0].sourceId, textHash: 'bad-hash', evidence: sources[0].source.rawText },
    ], sources, { artifactKind: 'constraint' });

    assert.equal(result.artifacts.length, 0);
    assert.equal(result.rejected.length, 2);
    assert.deepEqual(result.warnings.map(item => item.code), [
        'ai_source_unknown_source_id',
        'ai_source_text_hash_mismatch',
    ]);
    assert.ok(result.warnings.every(item => item.message && item.artifactKind === 'constraint'));
});

test('legacy AI identity can use unique exact evidence hash but never array index', () => {
    const sources = textSources([
        '张老师周一第1节不排课。',
        '李老师周二第2节不排课。',
    ]);
    const unique = alignAiArtifactsToSources([
        { id: 'legacy-second', evidence: sources[1].source.rawText },
    ], sources, { artifactKind: 'requirement', allowLegacyEvidence: true });
    assert.equal(unique.artifacts[0].sourceId, sources[1].sourceId);

    const missing = alignAiArtifactsToSources([
        { id: 'no-identity-no-evidence', intent: 'teacher_unavailable' },
    ], sources, { artifactKind: 'requirement', allowLegacyEvidence: true });
    assert.equal(missing.artifacts.length, 0);
    assert.equal(missing.rejected.length, 1);
    assert.equal(missing.warnings[0].code, 'ai_source_missing_source_identity');
});

test('duplicate raw text makes hash-only legacy AI output ambiguous and rejected', () => {
    const sources = textSources([
        '张老师周一第1节不排课。',
        '张老师周一第1节不排课。',
    ]);
    const result = alignAiArtifactsToSources([
        { id: 'ambiguous', evidence: '张老师周一第1节不排课。' },
    ], sources, { artifactKind: 'requirement', allowLegacyEvidence: true });

    assert.equal(result.artifacts.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.warnings[0].code, 'ai_source_ambiguous_text_hash');
});

test('AI prompt sends every source identity and requires source-scoped results', () => {
    const sources = textSources([
        '张老师周一第1节不排课。',
        '李老师周二第2节不排课。',
    ]);
    const inputs = sourceRequirementsToAiInputs(sources);
    const messages = buildAiRequirementExtractionMessages({
        project: project(),
        text: sources.map(item => item.source.rawText).join('\n'),
        sourceInputs: inputs,
    });
    const userPayload = JSON.parse(messages[1].content);

    assert.equal(userPayload.sources.length, 2);
    assert.deepEqual(userPayload.sources[0], {
        sourceId: sources[0].sourceId,
        textHash: sources[0].source.textHash,
        rawText: sources[0].source.rawText,
        sourceSheet: '',
        sourceRow: null,
        lineNumber: 1,
    });
    assert.match(messages[0].content, /sourceId/);
    assert.match(messages[0].content, /textHash/);
    assert.match(messages[0].content, /results/);
    assert.match(messages[0].content, /clauses/);
});

test('AI extractor accepts reversed source-scoped results and preserves one-to-many provenance', async () => {
    const sources = textSources([
        '张老师周一第1节不排课，并且数学尽量排上午。',
        '李老师周二第2节不排课。',
    ]);
    const result = await extractRequirementsWithAI({
        project: project(),
        text: sources.map(item => item.source.rawText).join('\n'),
        sourceRequirements: sources,
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_CACHE: '0',
        },
        fetchImpl: async () => jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        results: [
                            {
                                ...aiIdentity(sources[1]),
                                clauses: [
                                    { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['李老师'], time: { slots: ['2-2'] }, strength: 'hard', confidence: 0.95, evidence: '李老师周二第2节不排课。' },
                                ],
                            },
                            {
                                ...aiIdentity(sources[0]),
                                clauses: [
                                    { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { slots: ['1-1'] }, strength: 'hard', confidence: 0.95, evidence: '张老师周一第1节不排课' },
                                    { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft', confidence: 0.95, evidence: '数学尽量排上午' },
                                ],
                            },
                        ],
                    }),
                },
            }],
        }),
    });

    assert.equal(result.rejected.length, 0);
    assert.equal(result.semanticRequirements.length, 3);
    assert.deepEqual(result.semanticRequirements.map(item => item.sourceId), [
        sources[1].sourceId,
        sources[0].sourceId,
        sources[0].sourceId,
    ]);
    assert.ok(result.draftRows.every(row => row.sourceId && row.textHash));
});

test('AI-first parse keeps all sources when AI omits one and rejects an invented source', async () => {
    const lines = [
        '张老师周一第1节不排课。',
        '李老师周二第2节不排课。',
    ];
    let promptSources = [];
    const result = await parseTimetableRules({
        text: lines.join('\n'),
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_CACHE: '0',
        },
        fetchImpl: async (_url, options = {}) => {
            const request = JSON.parse(options.body);
            const userPayload = JSON.parse(request.messages[1].content);
            promptSources = userPayload.sources;
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [
                                {
                                    sourceId: promptSources[1].sourceId,
                                    textHash: promptSources[1].textHash,
                                    clauses: [
                                        { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['李老师'], time: { slots: ['2-2'] }, strength: 'hard', confidence: 0.95, evidence: lines[1] },
                                    ],
                                },
                                {
                                    sourceId: 'src:invented',
                                    textHash: promptSources[0].textHash,
                                    clauses: [
                                        { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { slots: ['1-1'] }, strength: 'hard', confidence: 0.95, evidence: lines[0] },
                                    ],
                                },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(result.sourceRequirements.length, 2);
    assert.equal(result.statistics.userInputCount, 2);
    assert.deepEqual(new Set(result.draftRows.map(row => row.sourceId)), new Set(promptSources.map(source => source.sourceId)));
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_unknown_source_id'));
    assert.ok(result.sourceRequirements.every(item => item.understandingStatus === 'parsed'));
    assert.ok(result.sourceRequirements.every(item => item.applicationTarget === 'rule'));
});

test('AI review uses source identity and rejects invented or mismatched review items', async () => {
    const requestText = '\u4e03\u5e74\u7ea71\u73ed\u6570\u5b66\u5c3d\u91cf\u5b89\u6392\u5230\u4e0a\u5348\uff01';
    let promptPayload = null;
    const result = await parseTimetableRules({
        text: requestText,
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
        },
        fetchImpl: async (_url, options = {}) => {
            const request = JSON.parse(options.body || '{}');
            promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
            const [source] = promptPayload.sources || [];
            const [row] = promptPayload.localResult?.draftRows || [];
            assert.equal(promptPayload.aiReviewPromptVersion, 'timetable_ai_review_v4');
            assert.equal(promptPayload.sources.length, 1);
            assert.equal(row.sourceId, source.sourceId);
            assert.equal(row.textHash, source.textHash);
            assert.equal(promptPayload.applicationBaseline.sourceRequirements, undefined);
            assert.equal(promptPayload.applicationBaseline.draftRows.length, 1);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            reviewItems: [
                                {
                                    verdict: 'accept',
                                    sourceId: source.sourceId,
                                    textHash: source.textHash,
                                    target: {
                                        sourceId: source.sourceId,
                                        textHash: source.textHash,
                                        rowId: row.id,
                                    },
                                    evidence: { quote: requestText },
                                    reason: 'valid source-scoped review',
                                },
                                {
                                    verdict: 'flag',
                                    sourceId: 'src:invented',
                                    textHash: source.textHash,
                                    target: {
                                        sourceId: 'src:invented',
                                        textHash: source.textHash,
                                        rowId: row.id,
                                    },
                                    evidence: { quote: requestText },
                                    reason: 'invented source must be rejected',
                                },
                                {
                                    verdict: 'suggest_patch',
                                    sourceId: source.sourceId,
                                    textHash: 'bad-hash',
                                    target: {
                                        sourceId: source.sourceId,
                                        textHash: 'bad-hash',
                                        rowId: row.id,
                                    },
                                    evidence: { quote: requestText },
                                    patch: { priority: 'hard' },
                                    reason: 'hash mismatch must be rejected',
                                },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    assert.ok(promptPayload);
    assert.equal(result.sourceRequirements.length, 1);
    assert.equal(result.sourceRequirements[0].sourceId, promptPayload.sources[0].sourceId);
    const row = result.draftRows.find(item => item.sourceId === promptPayload.sources[0].sourceId);
    assert.ok(row);
    assert.equal(row.aiReviewStatus, '', 'AI accept metadata must not rewrite the formal machine row');
    assert.equal(row.priority, 'soft');
    assert.equal(result.aiReview.reviewItems.length, 1);
    assert.equal(result.aiReview.reviewItems[0].validationStatus, 'accepted');
    assert.equal(result.rejected.length, 2);
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_unknown_source_id'));
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_text_hash_mismatch'));
    assert.ok(result.warningItems
        .filter(item => item.code?.startsWith('ai_source_'))
        .every(item => item.parsedBy.includes('ai_review')));
});

test('AI review patches stay within one source and cannot rewrite provenance', async () => {
    const mathText = '\u4e03\u5e74\u7ea71\u73ed\u6570\u5b66\u5c3d\u91cf\u5b89\u6392\u5230\u4e0a\u5348\uff01';
    const chineseText = '\u4e03\u5e74\u7ea71\u73ed\u8bed\u6587\u5c3d\u91cf\u5b89\u6392\u5230\u4e0a\u5348\uff1f';
    let promptPayload = null;
    const result = await parseTimetableRules({
        text: [mathText, chineseText].join('\n'),
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
        },
        fetchImpl: async (_url, options = {}) => {
            const request = JSON.parse(options.body || '{}');
            promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
            const mathSource = promptPayload.sources.find(item => item.rawText === mathText);
            const chineseSource = promptPayload.sources.find(item => item.rawText === chineseText);
            const mathRow = promptPayload.localResult.draftRows.find(item => item.sourceId === mathSource.sourceId);
            const chineseRow = promptPayload.localResult.draftRows.find(item => item.sourceId === chineseSource.sourceId);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            reviewItems: [
                                {
                                    verdict: 'suggest_patch',
                                    sourceId: mathSource.sourceId,
                                    textHash: mathSource.textHash,
                                    target: {
                                        sourceId: mathSource.sourceId,
                                        textHash: mathSource.textHash,
                                        rowId: mathRow.id,
                                    },
                                    evidence: { quote: mathText },
                                    patch: {
                                        confidence: 0.99,
                                        rawText: 'forged review text',
                                    },
                                    reason: 'valid patch with forged provenance field',
                                },
                                {
                                    verdict: 'suggest_patch',
                                    sourceId: mathSource.sourceId,
                                    textHash: mathSource.textHash,
                                    target: {
                                        sourceId: mathSource.sourceId,
                                        textHash: mathSource.textHash,
                                        rowId: chineseRow.id,
                                    },
                                    evidence: { quote: mathText },
                                    patch: { priority: 'hard' },
                                    reason: 'cross-source row target must not match',
                                },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    const mathSource = promptPayload.sources.find(item => item.rawText === mathText);
    const chineseSource = promptPayload.sources.find(item => item.rawText === chineseText);
    const originalMathRow = promptPayload.localResult.draftRows.find(item => item.sourceId === mathSource.sourceId);
    const mathRow = result.draftRows.find(item => item.sourceId === mathSource.sourceId);
    const chineseRow = result.draftRows.find(item => item.sourceId === chineseSource.sourceId);
    assert.ok(mathRow);
    assert.ok(chineseRow);
    assert.equal(mathRow.aiReviewStatus, 'patched');
    assert.equal(mathRow.rawText, originalMathRow.rawText);
    assert.notEqual(mathRow.rawText, 'forged review text');
    assert.equal(mathRow.textHash, mathSource.textHash);
    assert.equal(mathRow.origin, 'user_input');
    assert.ok(mathRow.parsedBy.includes('local'));
    assert.equal(chineseRow.aiReviewStatus || '', '');
    assert.equal(chineseRow.priority, 'soft');
    assert.equal(result.aiReview.appliedSuggestionCount, 1);
    assert.ok(result.warnings.some(item => /AI.*review|AI.*patch|AI/.test(item)));
});

test('AI review missed requirements inherit only verified source provenance', async () => {
    const requestText = '\u4e03\u5e74\u7ea71\u73ed\u8bed\u6587\u5c3d\u91cf\u5b89\u6392\u5230\u4e0a\u5348\u3002';
    let promptPayload = null;
    const result = await parseTimetableRules({
        text: requestText,
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
        },
        fetchImpl: async (_url, options = {}) => {
            const request = JSON.parse(options.body || '{}');
            promptPayload = JSON.parse(request.messages?.[1]?.content || '{}');
            const [source] = promptPayload.sources;
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            reviewItems: [{
                                verdict: 'missed_requirement',
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                target: {
                                    sourceId: source.sourceId,
                                    textHash: source.textHash,
                                },
                                evidence: { quote: requestText },
                                reason: 'review found an additional non-executable concern',
                                suggestedRequirement: {
                                    id: 'req_review_verified_source',
                                    intent: 'unknown',
                                    status: 'needs_review',
                                    applyTo: 'review',
                                    source: {
                                        sourceId: 'src:forged',
                                        textHash: 'forged-hash',
                                        rawText: 'forged source text',
                                    },
                                },
                            }],
                        }),
                    },
                }],
            });
        },
    });

    const [source] = promptPayload.sources;
    const requirement = result.requirementItems.find(item => item.id === 'req_review_verified_source');
    assert.ok(requirement);
    assert.equal(requirement.sourceId, source.sourceId);
    assert.equal(requirement.textHash, source.textHash);
    assert.equal(requirement.source.sourceId, source.sourceId);
    assert.equal(requirement.source.textHash, source.textHash);
    assert.notEqual(requirement.source.rawText, 'forged source text');
    assert.ok(requirement.parsedBy.includes('ai_review'));
});

test('AI review patch/upsert stays idempotent for duplicate patches and repeated application', async () => {
    const requestText = [
        '张老师周一第1节不排课。',
        '七年级1班数学尽量安排在上午。',
    ].join('\n');
    const timetableProject = project();
    const localResult = await parseTimetableRules({
        text: requestText,
        project: timetableProject,
        env: { TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true' },
    });
    const mathSource = localResult.sourceRequirements.find(item => item.rawText === '七年级1班数学尽量安排在上午。');
    const mathRow = localResult.draftRows.find(item => item.sourceId === mathSource?.sourceId);
    assert.ok(mathSource);
    assert.ok(mathRow);

    const patchItem = {
        id: 'review_patch_math_once',
        verdict: 'suggest_patch',
        sourceId: mathSource.sourceId,
        textHash: mathSource.textHash,
        target: {
            sourceId: mathSource.sourceId,
            textHash: mathSource.textHash,
            rowId: mathRow.id,
        },
        evidence: { quote: mathSource.rawText },
        patch: { priority: 'hard' },
        reason: '数学上午偏好按当前校规提升优先级。',
    };
    const review = {
        model: 'mock-review',
        reviewItems: [
            patchItem,
            { ...patchItem, id: 'review_patch_math_duplicate' },
            {
                id: 'review_missed_math_note',
                verdict: 'missed_requirement',
                sourceId: mathSource.sourceId,
                textHash: mathSource.textHash,
                target: {
                    sourceId: mathSource.sourceId,
                    textHash: mathSource.textHash,
                },
                evidence: { quote: mathSource.rawText },
                reason: '还需要人工确认“上午”是否仅指前四节。',
                suggestedRequirement: {
                    id: 'req_review_math_daypart_scope',
                    intent: 'unknown',
                    status: 'needs_review',
                    applyTo: 'review',
                    object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
                    parameters: { field: 'dayPartScope' },
                    strength: 'soft',
                },
            },
        ],
    };

    const applyReview = result => applyAiReviewToParseResult({
        project: timetableProject,
        result,
        review,
        text: requestText,
        inputType: 'text',
    });
    const once = applyReview(localResult);
    const twice = applyReview(once);

    const identitySnapshot = result => ({
        sources: result.sourceRequirements.map(item => item.sourceId).sort(),
        clauses: result.sourceRequirements.flatMap(item => item.clauses.map(clause => clause.clauseId)).sort(),
        machineRules: result.draftRows.map(row => row.machineRuleId).sort(),
        draftRows: result.draftRows.map(row => row.id).sort(),
        semanticActions: result.semanticActions.map(action => action.id).sort(),
    });

    assert.equal(once.aiReview.appliedSuggestionCount, 1);
    assert.equal(twice.aiReview.appliedSuggestionCount, 1);
    assert.equal(once.draftRows.find(row => row.sourceId === mathSource.sourceId)?.aiReviewStatus, 'patched');
    assert.equal(twice.draftRows.find(row => row.sourceId === mathSource.sourceId)?.aiReviewStatus, 'patched');
    assert.ok(!twice.warnings.some(warning => /AI 复审建议未通过本地校验/.test(warning)));
    assert.equal(once.requirementItems.filter(item => item.id === 'req_review_math_daypart_scope').length, 1);
    assert.equal(twice.requirementItems.filter(item => item.id === 'req_review_math_daypart_scope').length, 1);
    assert.deepEqual(identitySnapshot(twice), identitySnapshot(once));
    assert.equal(twice.sourceRequirements.length, once.sourceRequirements.length);
    assert.equal(twice.sourceRequirements.flatMap(item => item.clauses).length, once.sourceRequirements.flatMap(item => item.clauses).length);
    assert.equal(twice.draftRows.length, once.draftRows.length);
    assert.equal(twice.semanticActions.length, once.semanticActions.length);
});

test('AI review blocks only when local validation reproduces the declared issue', async () => {
    const timetableProject = project();
    const requestText = '张老师周一第9节不排课。';
    const localResult = await parseTimetableRules({
        text: requestText,
        project: timetableProject,
        env: { TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true' },
    });
    const [source] = localResult.sourceRequirements;
    const result = applyAiReviewToParseResult({
        project: timetableProject,
        result: localResult,
        text: requestText,
        inputType: 'text',
        review: {
            model: 'mock-review',
            reviewItems: [{
                id: 'review-slot-range',
                verdict: 'flag',
                issueCode: 'slot_out_of_range',
                sourceId: source.sourceId,
                textHash: source.textHash,
                target: { sourceId: source.sourceId, textHash: source.textHash },
                fieldPath: 'time.slots',
                evidence: { quote: requestText },
                reason: '第9节超出当前8节作息。',
            }],
        },
    });

    assert.equal(result.aiReview.reviewItems[0].validationStatus, 'blocking');
    assert.equal(result.aiReview.reviewItems[0].blocking, true);
    assert.equal(result.aiAssistance.blockingCount, 1);
    assert.equal(result.sourceRequirements[0].requiresHumanReview, true);
    assert.equal(result.sourceRequirements[0].applicationTarget, 'review');
    assert.ok(result.sourceRequirements[0].reviewReasons.some(reason => (
        reason.code === 'ai_review_slot_out_of_range'
        && reason.origin === 'ai'
        && reason.verified === true
    )));
});

test('complete AI missed requirements compile locally and dedupe without creating review cards', async () => {
    const timetableProject = project();
    const requestText = '七年级1班数学尽量安排在上午。';
    const localResult = await parseTimetableRules({
        text: requestText,
        project: timetableProject,
        env: { TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true' },
    });
    const [source] = localResult.sourceRequirements;
    const result = applyAiReviewToParseResult({
        project: timetableProject,
        result: localResult,
        text: requestText,
        inputType: 'text',
        review: {
            model: 'mock-review',
            reviewItems: [{
                id: 'review-complete-missed',
                verdict: 'missed_requirement',
                sourceId: source.sourceId,
                textHash: source.textHash,
                target: { sourceId: source.sourceId, textHash: source.textHash },
                evidence: { quote: requestText },
                reason: '补充完整的数学上午偏好语义。',
                suggestedRequirement: {
                    id: 'req-complete-missed',
                    intent: 'subject_morning',
                    object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
                    parameters: { periods: [1, 2, 3, 4], classIds: ['c1'] },
                    strength: 'soft',
                },
            }],
        },
    });

    assert.equal(result.aiReview.reviewItems[0].validationStatus, 'accepted');
    assert.equal(result.aiReview.reviewItems[0].blocking, false);
    assert.equal(result.sourceRequirements.length, 1);
    assert.equal(result.sourceRequirements[0].requiresHumanReview, false);
    assert.equal(result.sourceRequirements[0].applicationTarget, 'rule');
    assert.ok(result.constraintIRs.every(item => item.executionStatus === 'executable'));
    assert.ok(result.constraintIRs.every(item => item.machineRuleIds.length > 0));
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.ok(result.draftRules.advancedRules.some(rule => (
        rule.type === 'subject.preferred_day_part'
        && rule.target.matchedIds.includes('math')
        && rule.parameters.classIds.includes('c1')
    )));
});

test('a review requirementId never broadens a patch to every row in the same source', async () => {
    const timetableProject = project();
    const requestText = '数学尽量上午，英语尽量下午。';
    const localResult = await parseTimetableRules({
        text: requestText,
        project: timetableProject,
        env: {
            TIMETABLE_RULE_AI_EXTRACT: '0',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true',
        },
    });
    const [source] = localResult.sourceRequirements;
    const before = localResult.draftRows.map(row => ({ type: row.type, targetId: row.targetId }));
    const result = applyAiReviewToParseResult({
        project: timetableProject,
        result: localResult,
        text: requestText,
        inputType: 'text',
        review: {
            model: 'mock-review',
            reviewItems: [{
                verdict: 'suggest_patch',
                sourceId: source.sourceId,
                textHash: source.textHash,
                target: {
                    sourceId: source.sourceId,
                    textHash: source.textHash,
                    requirementId: 'ai-only-requirement',
                },
                patch: { targetId: 'math' },
                reason: '该补丁只指向诊断结果中的 AI 候选。',
            }],
        },
    });

    assert.deepEqual(
        result.draftRows.map(row => ({ type: row.type, targetId: row.targetId })),
        before,
    );
    assert.equal(result.aiReview.reviewItems[0].validationStatus, 'advisory');
    assert.equal(result.aiReview.appliedSuggestionCount, 0);
});



test('AI rejection warnings preserve scalar parsedBy as one parser actor', () => {
    const sources = textSources(['张老师周一第1节不排课。']);
    const result = alignAiArtifactsToSources([{
        id: 'unknown-source',
        sourceId: 'src:unknown',
        textHash: sources[0].source.textHash,
        parsedBy: 'local',
    }], sources, { artifactKind: 'requirement', parsedBy: 'ai' });

    assert.equal(result.warnings.length, 1);
    assert.deepEqual(result.warnings[0].parsedBy, ['local', 'ai']);
});


test('legacy AI evidence must equal the complete source text and partial excerpts are never fuzzy-bound', () => {
    const sources = textSources(['张老师周一第1节不排课，并且数学尽量排上午。']);
    const partial = alignAiArtifactsToSources([{
        id: 'partial-evidence',
        evidence: '数学尽量排上午',
    }], sources, { artifactKind: 'requirement', allowLegacyEvidence: true });

    assert.equal(partial.artifacts.length, 0);
    assert.equal(partial.rejected.length, 1);
    assert.equal(partial.warnings[0].code, 'ai_source_text_hash_mismatch');

    const exact = alignAiArtifactsToSources([{
        id: 'complete-evidence',
        evidence: sources[0].source.rawText,
    }], sources, { artifactKind: 'requirement', allowLegacyEvidence: true });
    assert.equal(exact.artifacts.length, 1);
    assert.equal(exact.artifacts[0].sourceId, sources[0].sourceId);
});

test('AI source alignment flattens scalar and array parser provenance actors', () => {
    const [source] = textSources(['张老师周一第1节不排课。']);
    const result = alignAiArtifactsToSources([{
        id: 'parser-provenance',
        ...aiIdentity(source),
        parsedBy: 'legacy',
    }], [{ ...source, parsedBy: 'local' }], {
        artifactKind: 'requirement',
        parsedBy: ['ai', 'review'],
    });

    assert.equal(result.rejected.length, 0);
    assert.deepEqual(result.artifacts[0].parsedBy, ['local', 'legacy', 'ai', 'review']);
});
