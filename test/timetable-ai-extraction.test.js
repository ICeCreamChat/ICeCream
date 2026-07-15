import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import { buildSourceRequirements } from '../gateway/services/timetable-constraints/source-requirement.js';
import {
    countExpectedFieldChecks,
    loadConstraintCorpus,
} from '../scripts/lib/timetable-market-language-corpus.js';
import {
    renderTimetableAiGoldenMarkdown,
    runTimetableAiGolden,
    timetableAiGoldenGateFailures,
} from '../scripts/lib/timetable-ai-golden-runner.js';
import {
    AI_REQUIREMENT_PROMPT_VERSION,
    buildAiRequirementExtractionMessages,
    TIMETABLE_REQUIREMENT_INTENT_GUIDE,
    TIMETABLE_REQUIREMENT_INTENTS,
} from '../gateway/services/timetable-ai-prompts.js';
import {
    buildAiExtractionPromptProjectForTests,
    extractRequirementsWithAI,
    getTimetableAiExtractionCacheStats,
    resetTimetableAiExtractionCache,
    resolveEntityRefs,
    validateExtractionPayload,
} from '../gateway/services/timetable-ai-extractor.js';

function project(overrides = {}) {
    return createDefaultTimetableProject({
        weekdays: 5,
        periodsPerDay: 7,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7],
        dayPartBoundaries: { morningEndPeriod: 4, afternoonStartPeriod: 5 },
        teachers: [
            { id: 't_zhang', name: '张老师', subjects: ['math'], unavailableSlots: [] },
            { id: 't_wang', name: '王老师', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [{ id: 'c1', grade: '三', name: '1班' }],
        subjects: [
            { id: 'math', name: '数学', priority: 90, color: '#2563eb' },
            { id: 'chinese', name: '语文', priority: 90, color: '#dc2626' },
            { id: 'pe', name: '体育', priority: 30, color: '#16a34a' },
        ],
        rooms: [{ id: 'lab1', name: '实验室', tags: ['实验室'] }],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_zhang', weeklyHours: 5 },
            { id: 'lp_cn', classId: 'c1', subjectId: 'chinese', teacherId: 't_wang', weeklyHours: 5 },
        ],
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    });
}

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

async function loadCorpusRows() {
    return (await loadConstraintCorpus()).rows;
}

function goldenProject() {
    return project({
        teachers: [
            { id: 't_zhang', name: '张老师', subjects: ['math'], unavailableSlots: [] },
            { id: 't_wang', name: '王老师', subjects: ['chinese'], unavailableSlots: [] },
            { id: 't_li', name: '李老师', subjects: ['physics'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: '三', name: '1班' },
            { id: 'c2', grade: '七年级', name: '1班' },
            { id: 'c3', grade: '七年级', name: '2班' },
        ],
        subjects: [
            { id: 'math', name: '数学', priority: 90, color: '#2563eb' },
            { id: 'chinese', name: '语文', priority: 90, color: '#dc2626' },
            { id: 'english', name: '英语', priority: 85, color: '#7c3aed' },
            { id: 'pe', name: '体育', priority: 30, color: '#16a34a' },
            { id: 'music', name: '音乐', priority: 25, color: '#f59e0b' },
            { id: 'art', name: '美术', priority: 25, color: '#ec4899' },
            { id: 'physics', name: '物理', priority: 80, color: '#0891b2' },
            { id: 'chemistry', name: '化学', priority: 80, color: '#65a30d' },
            { id: 'science', name: '科学', priority: 75, color: '#0d9488' },
            { id: 'it', name: '信息技术', priority: 45, color: '#475569' },
            { id: 'football', name: '足球', priority: 25, color: '#15803d' },
            { id: 'theory', name: '理论课', priority: 60, color: '#64748b' },
            { id: 'experiment', name: '实验课', priority: 60, color: '#14b8a6' },
        ],
        rooms: [
            { id: 'lab1', name: '实验室', tags: ['实验室'] },
            { id: 'computer_room', name: '机房', tags: ['机房'] },
            { id: 'playground', name: '操场', tags: ['操场', '运动'] },
            { id: 'gym', name: '体育馆', tags: ['体育馆', '运动'] },
        ],
    });
}

test('AI extraction prompt includes schema, intent catalog and few-shot examples', () => {
    const messages = buildAiRequirementExtractionMessages({
        project: project(),
        text: '数学尽量上午，张老师周一不排课',
    });
    const system = messages[0].content;

    assert.match(system, /JSON Schema/);
    assert.match(system, /Few-shot/);
    assert.ok(TIMETABLE_REQUIREMENT_INTENTS.includes('avoid_first_period'));
    assert.match(system, /teacher_unavailable/);
    for (const category of ['colloquial', 'noisy_text', 'ellipsis', 'cross_sentence_reference', 'complex_negation', 'school_terminology']) {
        assert.match(system, new RegExp(category));
    }
    assert.match(messages[1].content, /张老师周一不排课/);
});

test('extractRequirementsWithAI returns locally resolved draft rows and semantic requirements', async () => {
    let observedBody = null;
    const result = await extractRequirementsWithAI({
        project: project(),
        text: '三1班数学尽量上午，音乐不要第一节',
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            assert.equal(String(url), 'http://ai.test/chat/completions');
            observedBody = JSON.parse(options.body);
            const promptPayload = JSON.parse(observedBody.messages[1].content);
            const source = promptPayload.sources[0];
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [{
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                clauses: [
                                { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], params: { classIds: ['c1'] }, strength: 'soft', confidence: 0.94, evidence: '三1班数学尽量上午' },
                                { intent: 'avoid_first_period', targetKind: 'subject', targetNames: ['体育'], strength: 'soft', confidence: 0.9, evidence: '体育不要第一节' },
                                ],
                            }],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(observedBody.temperature, 0);
    assert.equal(result.promptVersion, 'timetable_ai_requirement_extract_v6');
    assert.ok(result.draftRows.some(row => row.type === 'subject_morning' && row.targetId === 'math'));
    assert.ok(result.semanticRequirements.some(item => item.parameters.classIds?.includes('c1')));
    assert.ok(result.semanticRequirements.some(item => item.intent === 'avoid_first_period' && item.object.matchedIds.includes('pe')));
});

test('extractRequirementsWithAI caches by prompt version, model, input and project context', async () => {
    resetTimetableAiExtractionCache();
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        requirements: [
                            { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft', confidence: 0.94, evidence: '数学尽量上午' },
                        ],
                    }),
                },
            }],
        });
    };

    const first = await extractRequirementsWithAI({
        project: project(),
        text: '数学尽量上午',
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test', DEEPSEEK_MODEL: 'cache-model' },
        fetchImpl,
    });
    const second = await extractRequirementsWithAI({
        project: project(),
        text: '数学尽量上午',
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test', DEEPSEEK_MODEL: 'cache-model' },
        fetchImpl,
    });

    assert.equal(calls, 1);
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.equal(getTimetableAiExtractionCacheStats().size, 1);
    assert.deepEqual(second.rawRequirements.map(item => item.intent), ['subject_morning']);
});

test('extractRequirementsWithAI batches more than 30 sources without cross-source dedupe', async () => {
    resetTimetableAiExtractionCache();
    const inputProject = project();
    const mathName = inputProject.subjects.find(subject => subject.id === 'math').name;
    const sourceLines = Array.from({ length: 35 }, (_, index) => `batch source ${index + 1}`);
    const calls = [];
    const result = await extractRequirementsWithAI({
        project: inputProject,
        text: sourceLines.join('\n'),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_BATCH_CONCURRENCY: '2',
            TIMETABLE_RULE_AI_CACHE: '0',
        },
        fetchImpl: async (url, options = {}) => {
            const body = JSON.parse(options.body);
            const promptPayload = JSON.parse(body.messages[1].content);
            calls.push(promptPayload.sources);
            const results = promptPayload.sources.slice().reverse().map(source => {
                const clause = {
                    intent: 'subject_morning',
                    targetKind: 'subject',
                    targetNames: [mathName],
                    strength: 'soft',
                    confidence: 0.9,
                    evidence: source.rawText,
                };
                return {
                    sourceId: source.sourceId,
                    textHash: source.textHash,
                    clauses: [clause, { ...clause }],
                };
            });
            if (calls.length === 2) {
                results.push({
                    sourceId: 'src:invented-batch-source',
                    textHash: promptPayload.sources[0].textHash,
                    clauses: [{
                        intent: 'subject_morning',
                        targetKind: 'subject',
                        targetNames: [mathName],
                        strength: 'soft',
                        confidence: 0.9,
                        evidence: 'invented source',
                    }],
                });
            }
            return jsonResponse({
                choices: [{ message: { content: JSON.stringify({ results }) } }],
            });
        },
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(items => items.length).sort((a, b) => a - b), [15, 20]);
    assert.equal(new Set(calls.flat().map(item => item.sourceId)).size, 35);
    assert.equal(result.batch.sentenceCount, 35);
    assert.equal(result.batch.chunkCount, 2);
    assert.equal(result.batch.concurrency, 2);
    assert.equal(result.rawRequirements.length, 35);
    assert.equal(new Set(result.rawRequirements.map(item => item.sourceId)).size, 35);
    assert.equal(result.draftRows.length, 35);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_unknown_source_id'));
});

test('AI extraction cache key includes source identity as well as request text', async () => {
    resetTimetableAiExtractionCache();
    const rawText = 'same cache request text';
    const sourceA = buildSourceRequirements([
        { lineNumber: 1, rawText },
    ], { inputType: 'text', origin: 'user_input' });
    const sourceB = buildSourceRequirements([
        { lineNumber: 2, rawText },
    ], { inputType: 'text', origin: 'user_input' });
    let calls = 0;
    const fetchImpl = async (_url, options = {}) => {
        calls += 1;
        const body = JSON.parse(options.body);
        const promptPayload = JSON.parse(body.messages[1].content);
        const source = promptPayload.sources[0];
        return jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        results: [{
                            sourceId: source.sourceId,
                            textHash: source.textHash,
                            clauses: [],
                            unrecognized: true,
                            reason: 'cache identity test',
                        }],
                    }),
                },
            }],
        });
    };
    const env = {
        DEEPSEEK_API_KEY: 'test-key',
        DEEPSEEK_API_BASE: 'http://ai.test',
        DEEPSEEK_MODEL: 'source-cache-model',
    };

    const first = await extractRequirementsWithAI({
        project: project(),
        text: rawText,
        sourceRequirements: sourceA,
        env,
        fetchImpl,
    });
    const second = await extractRequirementsWithAI({
        project: project(),
        text: rawText,
        sourceRequirements: sourceB,
        env,
        fetchImpl,
    });
    const third = await extractRequirementsWithAI({
        project: project(),
        text: rawText,
        sourceRequirements: sourceB,
        env,
        fetchImpl,
    });

    assert.notEqual(sourceA[0].sourceId, sourceB[0].sourceId);
    assert.equal(calls, 2);
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, false);
    assert.equal(third.cache.hit, true);
    assert.equal(getTimetableAiExtractionCacheStats().size, 2);
});

test('AI extraction prunes large entity tables to locally mentioned candidates', async () => {
    const largeProject = project({
        teachers: Array.from({ length: 220 }, (_, index) => ({
            id: `t_${index}`,
            name: index === 42 ? '王老师' : `教师${index}`,
            subjects: index === 42 ? ['math'] : [],
            unavailableSlots: [],
        })),
        subjects: [
            { id: 'math', name: '数学', priority: 90, color: '#2563eb' },
            ...Array.from({ length: 10 }, (_, index) => ({ id: `s_${index}`, name: `课程${index}`, priority: 50, color: '#64748b' })),
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_42', weeklyHours: 5 },
        ],
    });
    const promptProject = buildAiExtractionPromptProjectForTests(largeProject, '王老师周三第3节没空，数学尽量上午。');
    let promptPayload = null;
    const result = await extractRequirementsWithAI({
        project: largeProject,
        text: '王老师周三第3节没空，数学尽量上午。',
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            promptPayload = JSON.parse(JSON.parse(options.body).messages[1].content);
            const source = promptPayload.sources[0];
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [{
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                clauses: [
                                    { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['王老师'], time: { slots: ['3-3'] }, strength: 'hard', confidence: 0.94, evidence: '王老师周三第3节没空' },
                                ],
                            }],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(promptProject.pruned, true);
    assert.equal(promptProject.project.teachers.some(teacher => teacher.id === 't_42'), true);
    assert.equal(promptProject.project.teachers.some(teacher => teacher.id === 't_7'), false);
    assert.equal(promptPayload.project.teachers.length < 220, true);
    assert.equal(promptPayload.project.teachers.some(teacher => teacher.name === '王老师'), true);
    assert.equal(result.entityCandidates.pruned, true);
    assert.ok(result.draftRows.some(row => row.type === 'teacher_unavailable' && row.targetId === 't_42'));
});

test('validateExtractionPayload does not fabricate user origin without verified source provenance', () => {
    const unverified = validateExtractionPayload({
        results: [{
            clauses: [{
                intent: 'subject_morning',
                targetKind: 'subject',
                targetNames: ['数学'],
                evidence: '数学尽量安排到上午',
            }],
        }],
    });

    assert.equal(unverified.requirements[0].origin, 'unknown');

    const [source] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '数学尽量安排到上午',
    }], { inputType: 'manual_test', origin: 'manual' });
    const verified = validateExtractionPayload({
        results: [{
            sourceId: source.sourceId,
            textHash: source.textHash || source.source?.textHash,
            clauses: [{
                intent: 'subject_morning',
                targetKind: 'subject',
                targetNames: ['数学'],
                evidence: '数学尽量安排到上午',
            }],
        }],
    }, { sourceRequirements: [source] });

    assert.equal(verified.requirements[0].origin, 'manual');
    assert.equal(verified.requirements[0].sourceId, source.sourceId);
});

test('validateExtractionPayload downgrades unknown intents without throwing', () => {
    const result = validateExtractionPayload({
        requirements: [{ intent: 'teleport_course', targetNames: ['数学'], evidence: '数学瞬移' }],
    });

    assert.equal(result.requirements[0].intent, 'unknown');
    assert.ok(result.warnings.some(warning => warning.includes('intent 不在目录')));
});

test('semantic firewall prefers concrete teacher unavailability over first/last-period subject preferences', () => {
    const result = validateExtractionPayload({
        results: [{
            sourceId: 'src:c111',
            textHash: 'hash:c111',
            clauses: [{
                intent: 'avoid_last_period',
                targetKind: 'teacher',
                targetNames: ['王老师'],
                time: { days: [5], periods: [7] },
                strength: 'soft',
                evidence: '王老师周五末节不方便',
            }],
        }],
    });

    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0].intent, 'teacher_unavailable');
    assert.equal(result.requirements[0].targetKind, 'teacher');
    assert.deepEqual(result.requirements[0].targetNames, ['王老师']);
    assert.deepEqual(result.requirements[0].time, { days: [5], periods: [7] });
    assert.equal(result.requirements[0].strength, 'hard');
});

test('semantic firewall merges overlapping teacher clauses and preserves vague-time clarification', () => {
    const result = validateExtractionPayload({
        results: [{
            sourceId: 'src:c079',
            textHash: 'hash:c079',
            clauses: [{
                intent: 'avoid_first_period',
                targetKind: 'teacher',
                targetNames: ['王老师'],
                strength: 'soft',
                evidence: '王老师不要太早上课',
            }, {
                intent: 'teacher_unavailable',
                targetKind: 'teacher',
                targetNames: ['王老师'],
                strength: 'hard',
                evidence: '王老师不要太早上课',
            }],
        }],
    });

    assert.equal(result.requirements.length, 1);
    assert.equal(result.requirements[0].intent, 'teacher_unavailable');
    assert.equal(result.requirements[0].needsClarification, true);
    assert.ok(result.requirements[0].clarification?.question);
});

test('semantic firewall preserves non-overlapping teacher hard and soft time constraints', () => {
    const result = validateExtractionPayload({
        results: [{
            sourceId: 'src:teacher-mixed-time',
            textHash: 'hash:teacher-mixed-time',
            clauses: [{
                intent: 'teacher_unavailable',
                targetKind: 'teacher',
                targetNames: ['王老师'],
                time: { days: [1], periods: [1] },
                strength: 'hard',
                evidence: '王老师周一第一节没空',
            }, {
                intent: 'teacher_avoid_periods',
                targetKind: 'teacher',
                targetNames: ['王老师'],
                time: { days: [5], periods: [7] },
                strength: 'soft',
                evidence: '周五末节尽量少排',
            }],
        }],
    });

    assert.deepEqual(result.requirements.map(item => item.intent), [
        'teacher_unavailable',
        'teacher_avoid_periods',
    ]);
});

test('semantic firewall keeps joint teacher scheduling prohibitions as review-only preferences', () => {
    const result = validateExtractionPayload({
        results: [{
            sourceId: 'src:c178',
            textHash: 'hash:c178',
            clauses: [{
                intent: 'teacher_unavailable',
                targetKind: 'teacher',
                targetNames: ['张老师'],
                time: { days: [1, 2], periods: [1] },
                strength: 'hard',
                evidence: '张老师不能周一周二都排第一节',
            }],
        }],
    });

    assert.equal(result.requirements[0].intent, 'teacher_avoid_periods');
    assert.equal(result.requirements[0].strength, 'soft');
    assert.equal(result.requirements[0].needsClarification, true);
    assert.match(result.requirements[0].clarification?.question || '', /不能同时满足|确认/);
    assert.equal(resolveEntityRefs(project(), result.requirements).draftRows.length, 0);
});
test('semantic firewall normalizes teacher groups, mutual exclusion, spread and load-balance language', () => {
    const groupLimit = validateExtractionPayload({
        requirements: [{
            intent: 'teacher_daily_limit',
            targetKind: 'derived_group',
            targetNames: ['全部教师'],
            params: { limit: 4 },
            evidence: '每位老师每天最多4节',
        }],
    });
    assert.equal(groupLimit.requirements[0].targetKind, 'teacher');

    const mutualExclusion = validateExtractionPayload({
        requirements: [{
            intent: 'teacher_unavailable',
            targetKind: 'teacher',
            targetNames: ['张老师', '王老师'],
            evidence: '张老师和王老师不能同一节都有课',
        }],
    });
    assert.equal(mutualExclusion.requirements[0].intent, 'teacher_mutual_exclusion');

    const spread = validateExtractionPayload({
        requirements: [{
            intent: 'course_interval',
            targetKind: 'subject',
            targetNames: ['英语'],
            evidence: '英语不要连着几天都排',
        }],
    });
    assert.equal(spread.requirements[0].intent, 'subject_spread');

    const loadBalance = validateExtractionPayload({
        requirements: [{
            intent: 'unknown',
            targetKind: 'global',
            evidence: '高负载老师不要一直被压课，整体负载公平一点',
        }],
    });
    assert.equal(loadBalance.requirements[0].intent, 'teacher_load_balance');
});

test('semantic firewall repairs market terminology, noisy text, role groups and multi-intent maintenance output', () => {
    const validateSource = (rawText, clauses) => {
        const [source] = buildSourceRequirements([{ lineNumber: 1, rawText }], {
            inputType: 'semantic_firewall_test',
            origin: 'manual',
        });
        return validateExtractionPayload({
            results: [{
                sourceId: source.sourceId,
                textHash: source.textHash,
                rawText,
                clauses,
            }],
        }, { sourceRequirements: [source], project: project() });
    };

    const meeting = validateSource('英语备课组周四第7节开会，相关老师不排课', [{
        intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: [], evidence: '相关老师不排课',
    }]);
    assert.equal(meeting.requirements[0].intent, 'teaching_group_meeting');
    assert.equal(meeting.requirements[0].targetKind, 'teaching_group');
    assert.deepEqual(meeting.requirements[0].targetNames, ['英语备课组']);

    const weeklyLimit = validateSource('高负载老师每周不要超过18节', [{
        intent: 'teacher_load_balance', targetKind: 'global', evidence: '高负载老师每周不要超过18节',
    }]);
    assert.equal(weeklyLimit.requirements[0].intent, 'teacher_weekly_limit');
    assert.equal(weeklyLimit.requirements[0].params.limit, 18);

    const loadBalance = validateSource('教师工作量要均衡', [{
        intent: 'unknown', targetKind: 'unknown', evidence: '教师工作量要均衡',
    }]);
    assert.equal(loadBalance.requirements[0].intent, 'teacher_load_balance');
    assert.equal(loadBalance.requirements[0].targetKind, 'global');
    assert.equal(loadBalance.requirements[0].strength, 'soft');

    const staggered = validateSource('王老师和李老师错峰上课', [{
        intent: 'unknown', targetKind: 'unknown', targetNames: [], evidence: '王老师和李老师错峰上课',
    }]);
    assert.equal(staggered.requirements[0].intent, 'teacher_mutual_exclusion');
    assert.deepEqual(staggered.requirements[0].targetNames, ['王老师', '李老师']);

    const maintenance = validateSource('实验室周三维修，实验课避开', [{
        intent: 'subject_avoid_periods', targetKind: 'subject', targetNames: ['实验课'],
        time: { days: [3] }, evidence: '实验课避开',
    }]);
    assert.deepEqual(new Set(maintenance.requirements.map(item => item.intent)), new Set([
        'room_requirement', 'subject_avoid_periods',
    ]));
    assert.ok(maintenance.requirements.every(item => item.needsClarification));

    const morning = validateSource('數學儘量排在上午', [{
        intent: 'subject_morning', targetKind: 'subject', targetNames: ['數學'], evidence: '數學儘量排在上午',
    }]);
    assert.deepEqual(morning.requirements[0].targetNames, ['数学']);
    assert.equal(morning.requirements[0].time.dayPart, 'morning');

    const dailyLimit = validateSource('張老師每天最多4堂課', [{
        intent: 'teacher_daily_limit', targetKind: 'teacher', targetNames: ['張老師'], evidence: '張老師每天最多4堂課',
    }]);
    assert.deepEqual(dailyLimit.requirements[0].targetNames, ['张老师']);
    assert.equal(dailyLimit.requirements[0].params.limit, 4);

    const room = validateSource('物里实验必須在實驗室', [{
        intent: 'room_requirement', targetKind: 'subject', targetNames: ['物里实验'],
        params: { roomNames: ['實驗室'] }, evidence: '物里实验必須在實驗室',
    }]);
    assert.deepEqual(room.requirements[0].targetNames, ['物理', '实验室']);

    const pronoun = validateSource('张老师周一上午请假。李老师周三下午请假。他不能排第6节。', [{
        intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'],
        time: { days: [1], dayPart: 'morning' }, evidence: '张老师周一上午请假',
    }, {
        intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['李老师'],
        time: { days: [3], dayPart: 'afternoon' }, evidence: '李老师周三下午请假',
    }, {
        intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['李老师'],
        evidence: '他不能排第6节',
    }]);
    const pronounClause = pronoun.requirements.find(item => item.evidence === '他不能排第6节');
    assert.equal(pronounClause.needsClarification, true);
    assert.deepEqual(pronounClause.targetNames, []);
    assert.deepEqual(pronounClause.time.periods, [6]);

    const lunch = validateSource('午间管理时段不排普通教学任务', [{
        intent: 'global_unavailable', targetKind: 'global', evidence: '午间管理时段不排普通教学任务',
    }]);
    assert.equal(lunch.requirements[0].intent, 'lunch_protection');
    assert.equal(lunch.requirements[0].activity, '午间管理');
    assert.equal(lunch.requirements[0].needsClarification, true);

    const goldenPeriod = validateSource('音体美信尽量别占黄金段', [{
        intent: 'unknown', targetKind: 'unknown', targetNames: [], evidence: '音体美信尽量别占黄金段',
    }]);
    assert.equal(goldenPeriod.requirements[0].intent, 'subject_avoid_periods');
    assert.deepEqual(goldenPeriod.requirements[0].targetNames, ['体育', '音乐', '美术', '信息技术']);
    assert.equal(goldenPeriod.requirements[0].needsClarification, true);

    const headTeachers = validateSource('班主任会放在周一班会课，全体班主任避开', [{
        intent: 'teaching_group_meeting', targetKind: 'teaching_group', targetNames: ['班主任'],
        evidence: '班主任会放在周一班会课，全体班主任避开',
    }]);
    assert.equal(headTeachers.requirements[0].intent, 'teacher_unavailable');
    assert.equal(headTeachers.requirements[0].targetKind, 'derived_group');
    assert.deepEqual(headTeachers.requirements[0].time.days, [1]);
    assert.equal(headTeachers.requirements[0].activity, '班主任会');
    assert.equal(headTeachers.requirements[0].needsClarification, true);

    const coTeaching = validateSource('双师课两位老师必须同时到班', [{
        intent: 'unknown', targetKind: 'unknown', targetNames: [], evidence: '双师课两位老师必须同时到班',
    }]);
    assert.equal(coTeaching.requirements[0].intent, 'teaching_group_session');
    assert.equal(coTeaching.requirements[0].activity, '双师课');
    assert.equal(coTeaching.requirements[0].needsClarification, true);
});

test('semantic firewall resolves same-source subject ellipsis and maintenance references', () => {
    const ellipsis = validateExtractionPayload({
        results: [{
            sourceId: 'src:c159',
            textHash: 'hash:c159',
            clauses: [{
                intent: 'subject_not_same_day',
                targetKind: 'subject',
                targetNames: ['音乐', '美术'],
                evidence: '音乐和美术不要同一天',
            }, {
                intent: 'subject_spread',
                targetKind: 'subject',
                targetNames: ['体育'],
                evidence: '体育也尽量错开',
            }],
            rawText: '音乐和美术不要同一天，体育也尽量错开',
        }],
    });
    assert.equal(ellipsis.requirements.length, 1);
    assert.equal(ellipsis.requirements[0].intent, 'subject_not_same_day');
    assert.deepEqual(new Set(ellipsis.requirements[0].targetNames), new Set(['音乐', '美术', '体育']));
    assert.equal(ellipsis.requirements[0].needsClarification, true);

    const maintenance = validateExtractionPayload({
        results: [{
            sourceId: 'src:c167',
            textHash: 'hash:c167',
            clauses: [{
                intent: 'room_requirement',
                targetKind: 'subject',
                targetNames: ['物理', '实验室'],
                evidence: '物理实验必须去实验室',
            }, {
                intent: 'unknown',
                targetKind: 'unknown',
                targetNames: ['该课程'],
                evidence: '该课程不要安排在实验室维修时段',
            }],
            rawText: '物理实验必须去实验室。该课程不要安排在实验室维修时段。',
        }],
    });
    assert.deepEqual(maintenance.requirements.map(item => item.intent), [
        'room_requirement',
        'subject_avoid_periods',
    ]);
    assert.deepEqual(maintenance.requirements[1].targetNames, ['物理']);
    assert.equal(maintenance.requirements[1].needsClarification, true);
});

test('semantic firewall marks exclusive room use and joint boundary-period language for review', () => {
    const room = validateExtractionPayload({
        requirements: [{
            intent: 'room_requirement',
            targetKind: 'subject',
            targetNames: ['实验课', '实验室'],
            evidence: '只有实验课才可以使用实验室',
        }],
    });
    assert.deepEqual(room.requirements[0].targetNames, ['实验课', '实验室']);
    assert.equal(room.requirements[0].needsClarification, true);

    const boundary = validateExtractionPayload({
        requirements: [{
            intent: 'unknown',
            targetKind: 'subject',
            targetNames: ['英语'],
            evidence: '英语不能既排第一节又排最后一节',
        }],
    }, { project: project() });
    assert.equal(boundary.requirements[0].intent, 'subject_avoid_periods');
    assert.deepEqual(boundary.requirements[0].time.periods, [1, 7]);
    assert.equal(boundary.requirements[0].needsClarification, true);

    const boundaryWithoutAiTarget = validateExtractionPayload({
        requirements: [{
            intent: 'subject_avoid_periods',
            targetKind: 'subject',
            targetNames: [],
            evidence: '英语不能既排第一节又排最后一节',
        }],
    }, { project: project() });
    assert.deepEqual(boundaryWithoutAiTarget.requirements[0].targetNames, ['英语']);
});
test('semantic firewall distinguishes course interval wording from weekly spread', () => {
    const result = validateExtractionPayload({
        requirements: [{
            intent: 'subject_spread',
            targetKind: 'subject',
            targetNames: ['体育'],
            evidence: '隔天排',
        }],
    });

    assert.equal(result.requirements[0].intent, 'course_interval');
    assert.equal(result.requirements[0].params.minGapDays, 1);
});

test('semantic firewall repairs source-local limits, exceptions, activities and contrastive subject language', () => {
    const validateSource = (rawText, clauses) => validateExtractionPayload({
        results: [{
            sourceId: `src:${rawText}`,
            textHash: `hash:${rawText}`,
            rawText,
            clauses,
        }],
    }, { project: project() });

    const consecutive = validateSource('张老师最多连续2节，下午最好别连着上', [{
        intent: 'teacher_consecutive_limit',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        params: { maxConsecutive: 2 },
        evidence: '张老师最多连续2节',
    }, {
        intent: 'teacher_avoid_periods',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        time: { dayPart: 'afternoon' },
        evidence: '下午最好别连着上',
    }]);
    assert.equal(consecutive.requirements.length, 1);
    assert.equal(consecutive.requirements[0].intent, 'teacher_consecutive_limit');
    assert.equal(consecutive.requirements[0].time.dayPart, 'afternoon');
    assert.equal(consecutive.requirements[0].params.limit, 2);
    assert.equal(consecutive.requirements[0].params.maxConsecutive, 2);

    const consecutiveGapVariant = validateSource('张老师最多连续2节，下午最好别连着上', [{
        intent: 'teacher_consecutive_limit',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        params: { maxConsecutive: 2 },
        evidence: '张老师最多连续2节',
    }, {
        intent: 'teacher_gap_preference',
        targetKind: 'global',
        targetNames: ['张老师'],
        time: { dayPart: 'afternoon' },
        evidence: '下午最好别连着上',
    }]);
    assert.equal(consecutiveGapVariant.requirements.length, 1);
    assert.equal(consecutiveGapVariant.requirements[0].intent, 'teacher_consecutive_limit');
    assert.equal(consecutiveGapVariant.requirements[0].time.dayPart, 'afternoon');

    const remainingSubjects = validateSource('除体育外，其他课不要排最后一节', [{
        intent: 'avoid_last_period',
        targetKind: 'derived_group',
        targetNames: [],
        evidence: '除体育外，其他课不要排最后一节',
    }]);
    assert.equal(remainingSubjects.requirements[0].intent, 'avoid_last_period');
    assert.equal(remainingSubjects.requirements[0].targetKind, 'derived_group');
    assert.deepEqual(remainingSubjects.requirements[0].exceptions, ['体育']);
    assert.equal(remainingSubjects.requirements[0].needsClarification, true);

    const classException = validateSource('除非是班会,否则七年级1班周五第7节不要排课', [{
        intent: 'class_unavailable',
        targetKind: 'class',
        targetNames: ['七年级1班'],
        evidence: '除非是班会,否则七年级1班周五第7节不要排课',
    }]);
    assert.deepEqual(classException.requirements[0].exceptions, ['班会']);

    const contrast = validateSource('不要求数学和英语每天都错开，但同一天时不要连续', [{
        intent: 'unknown',
        targetKind: 'subject',
        targetNames: ['数学', '英语'],
        evidence: '不要求数学和英语每天都错开，但同一天时不要连续',
    }]);
    assert.equal(contrast.requirements[0].intent, 'subject_not_consecutive_with');
    assert.deepEqual(contrast.requirements[0].targetNames, ['数学', '英语']);
    assert.equal(contrast.requirements[0].needsClarification, true);

    const repeatedClass = validateSource('七年级1班周五第7节班会，2班同一时间也安排', [{
        intent: 'class_unavailable',
        targetKind: 'class',
        targetNames: ['七年级1班'],
        time: { days: [5], periods: [7] },
        activity: '班会',
        evidence: '七年级1班周五第7节班会',
    }, {
        intent: 'locked_slot',
        targetKind: 'class',
        targetNames: ['七年级2班'],
        time: { slots: ['5-7'] },
        evidence: '2班同一时间也安排',
    }]);
    const secondClass = repeatedClass.requirements.find(item => item.targetNames.includes('七年级2班'));
    assert.equal(secondClass.intent, 'class_unavailable');
    assert.equal(secondClass.activity, '班会');
    assert.deepEqual(secondClass.time.days, [5]);
    assert.deepEqual(secondClass.time.periods, [7]);

    const breakExercise = validateSource('周三大课间做操，不占学科课', [{
        intent: 'block_preference',
        targetKind: 'global',
        targetNames: ['全校'],
        evidence: '周三大课间做操，不占学科课',
    }]);
    assert.equal(breakExercise.requirements[0].intent, 'global_unavailable');
    assert.equal(breakExercise.requirements[0].activity, '大课间');
    assert.equal(breakExercise.requirements[0].needsClarification, true);

    const eyeExercise = validateSource('眼保健操时段不排新课', [{
        intent: 'unknown',
        targetKind: 'unknown',
        evidence: '眼保健操时段不排新课',
    }]);
    assert.equal(eyeExercise.requirements[0].intent, 'global_unavailable');
    assert.equal(eyeExercise.requirements[0].activity, '眼保健操');
    assert.equal(eyeExercise.requirements[0].needsClarification, true);

    const goldenRange = validateSource('音体美信尽量别占黄金段', [{
        intent: 'subject_avoid_periods',
        targetKind: 'subject',
        targetNames: ['体育', '音乐', '美术', '信息技术'],
        time: { periods: [1, 2, 3, 4] },
        evidence: '音体美信尽量别占黄金段',
    }]);
    assert.equal(goldenRange.requirements[0].intent, 'subject_avoid_periods');

    const reading = validateSource('早读由语文英语轮流占第一节', [{
        intent: 'unknown',
        targetKind: 'unknown',
        evidence: '早读由语文英语轮流占第一节',
    }]);
    assert.equal(reading.requirements[0].intent, 'first_period_assign');
    assert.deepEqual(reading.requirements[0].targetNames, ['语文', '英语']);
    assert.deepEqual(reading.requirements[0].time.periods, [1]);
    assert.equal(reading.requirements[0].activity, '早读');
    assert.equal(reading.requirements[0].needsClarification, true);
});

test('semantic firewall stabilizes ambiguous spacing, weekly attendance, split day-parts and relative periods', () => {
    const validateSource = (rawText, clauses) => validateExtractionPayload({
        results: [{
            sourceId: `src:${rawText}`,
            textHash: `hash:${rawText}`,
            rawText,
            clauses,
        }],
    }, { project: project() });

    const vagueSpacing = validateSource('这几门课错开一点', [{
        intent: 'unknown',
        targetKind: 'subject',
        targetNames: [],
        evidence: '错开一点',
    }]);
    assert.equal(vagueSpacing.requirements[0].intent, 'subject_not_same_day');
    assert.equal(vagueSpacing.requirements[0].needsClarification, true);

    const weeklyAttendance = validateSource('张老师这周只来三天，课往这三天归拢', [{
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        evidence: '张老师这周只来三天，课往这三天归拢',
    }]);
    assert.equal(weeklyAttendance.requirements[0].intent, 'teacher_max_days_per_week');
    assert.deepEqual(weeklyAttendance.requirements[0].targetNames, ['张老师']);
    assert.equal(weeklyAttendance.requirements[0].params.limit, 3);

    const weeklyAttendanceFromSource = validateSource('张老师这周只来三天', [{
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        evidence: '只来三天',
    }]);
    assert.equal(weeklyAttendanceFromSource.requirements[0].intent, 'teacher_max_days_per_week');
    assert.equal(weeklyAttendanceFromSource.requirements[0].params.limit, 3);

    const theoryBeforeExperiment = validateSource('先讲理论，再做实验', [{
        intent: 'unknown',
        targetKind: 'unknown',
        targetNames: [],
        evidence: '先讲理论，再做实验',
    }]);
    assert.equal(theoryBeforeExperiment.requirements[0].intent, 'subject_sequence');
    assert.equal(theoryBeforeExperiment.requirements[0].targetKind, 'subject');
    assert.equal(theoryBeforeExperiment.requirements[0].needsClarification, true);

    const courseInterval = validateSource('物理化学中间至少岔开一天', [{
        intent: 'subject_not_consecutive_with',
        targetKind: 'subject',
        targetNames: ['物理', '化学'],
        evidence: '物理化学中间至少岔开一天',
    }]);
    assert.equal(courseInterval.requirements[0].intent, 'course_interval');
    assert.deepEqual(courseInterval.requirements[0].targetNames, ['物理', '化学']);
    assert.equal(courseInterval.requirements[0].params.minGapDays, 1);

    const splitDayParts = validateSource('张老师周一上午不排，周三下午也不排', [{
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        time: { days: [1, 3], dayPart: 'afternoon' },
        evidence: '张老师周一上午不排，周三下午也不排',
    }]);
    assert.equal(splitDayParts.requirements.length, 2);
    assert.deepEqual(
        splitDayParts.requirements.map(item => item.time),
        [
            { days: [1], dayPart: 'morning' },
            { days: [3], dayPart: 'afternoon' },
        ],
    );

    const relativePeriod = validateSource('培优课尽量排晚自习前一节', [{
        intent: 'unknown',
        targetKind: 'unknown',
        targetNames: [],
        evidence: '培优课尽量排晚自习前一节',
    }]);
    assert.equal(relativePeriod.requirements[0].intent, 'subject_preferred_periods');
    assert.equal(relativePeriod.requirements[0].targetKind, 'subject');
    assert.deepEqual(relativePeriod.requirements[0].targetNames, ['培优课']);
    assert.equal(relativePeriod.requirements[0].needsClarification, true);
});

test('semantic firewall recovers scoped subject groups, unique pronouns and partially merged day-parts', () => {
    const validateSource = (rawText, clauses) => validateExtractionPayload({
        results: [{
            sourceId: `src:${rawText}`,
            textHash: `hash:${rawText}`,
            rawText,
            clauses,
        }],
    }, { project: project() });

    const gradeSubjects = validateSource('高年级主科尽量上午低年级可以下午', [{
        intent: 'unknown',
        targetKind: 'unknown',
        targetNames: [],
        evidence: '高年级主科尽量上午低年级可以下午',
    }]);
    assert.equal(gradeSubjects.requirements[0].intent, 'subject_morning');
    assert.equal(gradeSubjects.requirements[0].needsClarification, true);

    const teachingGroupMeeting = validateSource('语文组周二下午集备，组内老师不要排课', [{
        intent: 'teacher_unavailable',
        targetKind: 'derived_group',
        targetNames: ['语文组'],
        time: { days: [2], dayPart: 'afternoon' },
        evidence: '语文组周二下午集备，组内老师不要排课',
    }]);
    assert.equal(teachingGroupMeeting.requirements[0].intent, 'teaching_group_meeting');
    assert.deepEqual(teachingGroupMeeting.requirements[0].targetNames, ['语文组']);
    assert.equal(teachingGroupMeeting.requirements[0].activity, '集备');

    const researchGroupMeeting = validateSource('数学组周三下午教研，数学课不要排这个时间', [{
        intent: 'subject_avoid_periods',
        targetKind: 'subject',
        targetNames: ['数学'],
        time: { days: [3], dayPart: 'afternoon' },
        evidence: '数学课不要排这个时间',
    }]);
    assert.deepEqual(
        new Set(researchGroupMeeting.requirements.map(item => item.intent)),
        new Set(['teaching_group_meeting', 'teacher_unavailable']),
    );

    const consecutiveAlias = validateSource('张老师的课别排成连轴转，最多连两堂', [{
        intent: 'teacher_consecutive_limit',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        params: { consecutiveLimit: 2 },
        evidence: '张老师的课别排成连轴转，最多连两堂',
    }]);
    assert.equal(consecutiveAlias.requirements[0].params.limit, 2);
    assert.equal(consecutiveAlias.requirements[0].params.maxConsecutive, 2);

    const teachingGroupSession = validateSource('走班课要同开，几个行政班同一节上', [{
        intent: 'unknown',
        targetKind: 'unknown',
        evidence: '走班课要同开，几个行政班同一节上',
    }]);
    assert.equal(teachingGroupSession.requirements[0].intent, 'teaching_group_session');
    assert.equal(teachingGroupSession.requirements[0].needsClarification, true);

    const pronoun = validateSource('王老师这学期带语文。她周三第3节要开会，不能排课。', [{
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: [],
        time: { days: [3], periods: [3], slots: ['3-3'] },
        evidence: '她周三第3节要开会，不能排课。',
        needsClarification: true,
    }]);
    assert.deepEqual(pronoun.requirements[0].targetNames, ['王老师']);
    assert.equal(pronoun.requirements[0].needsClarification, false);

    const partiallyMerged = validateSource('张老师周一上午不排，周三下午也不排', [{
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        time: { days: [1], dayPart: 'morning' },
        evidence: '张老师周一上午不排',
    }, {
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张老师'],
        time: { days: [1, 3], dayPart: 'afternoon' },
        evidence: '张老师周一上午不排，周三下午也不排',
    }]);
    assert.equal(partiallyMerged.requirements.length, 2);
    assert.deepEqual(
        partiallyMerged.requirements.map(item => item.time),
        [
            { days: [1], dayPart: 'morning' },
            { days: [3], dayPart: 'afternoon' },
        ],
    );
});

test('empty AI clauses preserve in-domain ambiguity but keep out-of-domain input unrecognized', () => {
    const [domainSource] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '请帮我把课程排得好看一点',
    }], { inputType: 'manual_test', origin: 'manual' });
    const domain = validateExtractionPayload({
        results: [{
            sourceId: domainSource.sourceId,
            textHash: domainSource.textHash,
            clauses: [],
            unrecognized: true,
            reason: '目标不明确',
        }],
    }, { sourceRequirements: [domainSource] });

    assert.equal(domain.requirements.length, 1);
    assert.equal(domain.requirements[0].intent, 'unknown');
    assert.equal(domain.requirements[0].needsClarification, true);
    assert.equal(domain.unrecognized.length, 0);
    assert.equal(domain.requirements[0].sourceId, domainSource.sourceId);

    const [weatherSource] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '明天天气怎么样',
    }], { inputType: 'manual_test', origin: 'manual' });
    const weather = validateExtractionPayload({
        results: [{
            sourceId: weatherSource.sourceId,
            textHash: weatherSource.textHash,
            clauses: [],
            unrecognized: true,
            reason: '与排课无关',
        }],
    }, { sourceRequirements: [weatherSource] });

    assert.equal(weather.requirements.length, 0);
    assert.equal(weather.unrecognized.length, 1);
});

test('teacher-role time preferences remain review-only and never compile as subject rules', () => {
    const validated = validateExtractionPayload({
        requirements: [{
            intent: 'avoid_first_period',
            targetKind: 'derived_group',
            targetNames: ['班主任'],
            strength: 'soft',
            time: { periods: [1] },
            evidence: '班主任第一节尽量不要有课方便晨检',
        }],
    });

    assert.equal(validated.requirements[0].intent, 'teacher_avoid_periods');
    assert.equal(validated.requirements[0].targetKind, 'derived_group');
    assert.equal(validated.requirements[0].needsClarification, true);
    const resolved = resolveEntityRefs(project(), validated.requirements);
    assert.equal(resolved.draftRows.length, 0);
    assert.equal(resolved.semanticRequirements[0].status, 'needs_review');
});

test('incompatible intent and target kind are routed to review instead of machine rows', () => {
    const validated = validateExtractionPayload({
        requirements: [{
            intent: 'subject_morning',
            targetKind: 'teacher',
            targetNames: ['王老师'],
            evidence: '王老师尽量安排在上午',
            confidence: 0.95,
        }],
    });

    assert.equal(validated.requirements[0].needsClarification, true);
    assert.ok(validated.requirements[0].notes.includes('targetKind'));
    const resolved = resolveEntityRefs(project(), validated.requirements);
    assert.equal(resolved.draftRows.length, 0);
});

test('AI extraction prompt v6 includes target-first semantic boundaries and course scope requirements', () => {
    assert.equal(AI_REQUIREMENT_PROMPT_VERSION, 'timetable_ai_requirement_extract_v6');
    assert.ok(TIMETABLE_REQUIREMENT_INTENTS.includes('teacher_avoid_periods'));
    assert.ok(TIMETABLE_REQUIREMENT_INTENT_GUIDE.some(item => item.intent === 'teacher_unavailable'));
    assert.ok(TIMETABLE_REQUIREMENT_INTENT_GUIDE.some(item => item.intent === 'course_interval'));
    const [systemMessage] = buildAiRequirementExtractionMessages({
        project: project(),
        text: '王老师周五末节不方便',
        sourceInputs: [],
    });
    assert.match(systemMessage.content, /先判断 targetKind/);
    assert.match(systemMessage.content, /领域内含糊/);
    assert.match(systemMessage.content, /隔天排/);
    assert.match(systemMessage.content, /请补充班级或明确全校范围/);
});

test('resolveEntityRefs keeps unknown entities in review and avoids ready rows', () => {
    const result = resolveEntityRefs(project(), [{
        id: 'ai_req_unknown',
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['不存在老师'],
        time: { slots: ['1-1'] },
        strength: 'hard',
        confidence: 0.92,
        evidence: '不存在老师周一第一节不排',
    }]);

    assert.equal(result.draftRows.length, 0);
    assert.equal(result.semanticRequirements[0].status, 'needs_review');
    assert.ok(result.semanticRequirements[0].warnings.some(warning => warning.includes('未找到教师')));
});

test('parseTimetableRules uses AI-first extraction for enabled free text', async () => {
    const result = await parseTimetableRules({
        text: '三1班数学尽量上午，张老师周一第一节不排课',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
        },
        fetchImpl: async (url, options = {}) => {
            const promptPayload = JSON.parse(JSON.parse(options.body).messages[1].content);
            const clauses = [
                { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], params: { classNames: ['三1班'] }, strength: 'soft', confidence: 0.95, evidence: '三1班数学尽量上午' },
                { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { slots: ['1-1'] }, strength: 'hard', confidence: 0.95, evidence: '张老师周一第一节不排课' },
            ];
            const resultsBySource = new Map();
            clauses.forEach(clause => {
                const source = promptPayload.sources.find(item => item.rawText.includes(clause.targetNames[0])) || promptPayload.sources[0];
                const current = resultsBySource.get(source.sourceId) || { sourceId: source.sourceId, textHash: source.textHash, clauses: [] };
                current.clauses.push(clause);
                resultsBySource.set(source.sourceId, current);
            });
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({ results: [...resultsBySource.values()] }),
                    },
                }],
            });
        },
    });

    assert.equal(result.parseSource, 'ai_extract');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.ok(result.draftRules.advancedRules.some(rule => (
        rule.type === 'subject.preferred_day_part'
        && rule.target.matchedIds.includes('math')
        && rule.parameters.classIds.includes('c1')
    )));
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_zhang, ['1-1']);
    assert.equal(result.aiReview.status, 'reviewed');
    assert.equal(result.aiAssistance.mode, 'targeted_review');
});

test('failed targeted review discards unverified AI candidates and returns the local baseline', async () => {
    let calls = 0;
    const result = await parseTimetableRules({
        text: '三1班数学尽量上午',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_CACHE: '0',
        },
        fetchImpl: async (_url, options = {}) => {
            calls += 1;
            if (calls > 1) throw new Error('terminated');
            const promptPayload = JSON.parse(JSON.parse(options.body).messages[1].content);
            const [source] = promptPayload.sources;
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [{
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                clauses: [{
                                    intent: 'subject_morning',
                                    targetKind: 'subject',
                                    targetNames: ['英语'],
                                    strength: 'soft',
                                    confidence: 0.95,
                                    evidence: source.rawText,
                                }],
                            }],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(calls, 2);
    assert.equal(result.parseSource, 'local_text');
    assert.equal(result.aiReview.status, 'unavailable');
    assert.equal(result.aiAssistance.mode, 'local_fallback');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.ok(result.draftRules.advancedRules.some(rule => rule.type === 'subject.preferred_day_part' && rule.parameters.classIds.includes('c1')));
    assert.equal(result.draftRows.some(row => row.targetName === '英语'), false);
});

test('successful targeted review also discards AI-only candidates that review did not explicitly validate', async () => {
    let calls = 0;
    const result = await parseTimetableRules({
        text: '数学尽量安排在上午。',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_CACHE: '0',
        },
        fetchImpl: async (_url, options = {}) => {
            calls += 1;
            const promptPayload = JSON.parse(JSON.parse(options.body).messages[1].content);
            if (promptPayload.aiReviewPromptVersion) {
                return jsonResponse({
                    choices: [{ message: { content: JSON.stringify({ reviewItems: [], warnings: [] }) } }],
                });
            }
            const [source] = promptPayload.sources;
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            results: [{
                                sourceId: source.sourceId,
                                textHash: source.textHash,
                                clauses: [
                                    {
                                        intent: 'subject_morning',
                                        targetKind: 'subject',
                                        targetNames: ['数学'],
                                        strength: 'soft',
                                        confidence: 0.95,
                                        evidence: source.rawText,
                                    },
                                    {
                                        intent: 'subject_afternoon',
                                        targetKind: 'subject',
                                        targetNames: ['数学'],
                                        strength: 'soft',
                                        confidence: 0.95,
                                        evidence: source.rawText,
                                    },
                                ],
                            }],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(calls, 2, 'AI-only semantics must trigger targeted review');
    assert.equal(result.aiReview.status, 'reviewed');
    assert.equal(result.constraintIRs.length, 1);
    assert.equal(result.draftRows.some(row => row.type === 'subject_afternoon'), false);
    assert.equal(result.aiCandidateValidation?.unverifiedCandidateCount, 0);
    assert.ok(result.aiCandidateValidation?.droppedCandidateCount >= 1);
});

test('parseTimetableRules falls back to local parsing when AI-first returns invalid JSON', async () => {
    const result = await parseTimetableRules({
        text: '三1班数学尽量上午',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
        fetchImpl: async () => jsonResponse({
            choices: [{ message: { content: '{not json' } }],
        }),
    });

    assert.equal(result.parseSource, 'local_text');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.ok(result.draftRules.advancedRules.some(rule => rule.type === 'subject.preferred_day_part' && rule.parameters.classIds.includes('c1')));
    assert.ok(result.warnings.some(warning => warning.includes('AI-first 抽取失败')));
    assert.equal(result.sourceRequirements.length, 1);
});

test('parseTimetableRules preserves all sources when AI-first extraction times out', async () => {
    let receivedAbortSignal = false;
    const result = await parseTimetableRules({
        text: '三1班数学尽量上午\n张老师周一第一节不排课',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS: '5',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
        fetchImpl: async (_url, init = {}) => new Promise((resolve, reject) => {
            receivedAbortSignal = Boolean(init.signal);
            const timer = setTimeout(() => resolve(jsonResponse({ choices: [] })), 50);
            init.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }),
    });

    assert.equal(receivedAbortSignal, true);
    assert.equal(result.parseSource, 'local_text');
    assert.equal(result.sourceRequirements.length, 2);
    assert.equal(result.statistics.userInputCount, 2);
    assert.ok(result.draftRows.some(row => row.advancedType === 'subject.preferred_day_part' && row.scopeClassId === 'c1'));
    assert.ok(result.draftRows.some(row => row.type === 'teacher_unavailable'));
    assert.ok(result.warnings.some(warning => warning.includes('AI-first 抽取失败')));
});

test('parseTimetableRules falls back when AI-first is enabled without an API key', async () => {
    const result = await parseTimetableRules({
        text: '三1班数学尽量上午',
        project: project(),
        env: {
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
    });

    assert.equal(result.parseSource, 'local_text');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, []);
    assert.ok(result.draftRules.advancedRules.some(rule => rule.type === 'subject.preferred_day_part' && rule.parameters.classIds.includes('c1')));
    assert.ok(result.warnings.some(warning => warning.includes('AI-first 抽取失败')));
    assert.equal(result.sourceRequirements.length, 1);
});

test('golden corpus fixture has at least 100 lines and records a baseline', async () => {
    const rows = await loadCorpusRows();
    const baseline = await readFile(path.join(process.cwd(), 'test/fixtures/corpus-baseline.md'), 'utf8');
    const intentCounts = new Map();
    let clarificationCount = 0;
    let unrecognizedCount = 0;
    let multiIntentCount = 0;

    for (const row of rows) {
        const expectedIntents = Array.isArray(row.expectedIntents) ? row.expectedIntents : [];
        if (row.needsClarification) clarificationCount += 1;
        if (row.unrecognized) unrecognizedCount += 1;
        if (expectedIntents.length > 1) multiIntentCount += 1;
        expectedIntents.forEach(intent => intentCounts.set(intent, (intentCounts.get(intent) || 0) + 1));
    }

    assert.ok(rows.length >= 100);
    assert.ok(rows.every(row => row.id && row.text && Array.isArray(row.expectedIntents)));
    assert.ok(intentCounts.size >= 30);
    assert.ok(clarificationCount >= 10);
    assert.ok(unrecognizedCount >= 5);
    assert.ok(multiIntentCount >= 10);
    assert.ok(countExpectedFieldChecks(rows) >= 80);
    assert.ok(rows.find(row => row.id === 'c001').expectedClauses.some(item => item.time?.dayPart === 'morning'));
    assert.ok(rows.find(row => row.id === 'c029').expectedClauses.some(item => item.params?.limit === 2));
    assert.ok(rows.find(row => row.id === 'c075').expectedClauses.some(item => item.needsClarification));
    assert.match(baseline, /覆盖率基线/);
    assert.match(baseline, /字段准确率基线/);
});

test('real AI golden corpus meets coverage and latency gates', {
    skip: !['1', 'true', 'yes', 'on'].includes(String(process.env.TIMETABLE_RULE_AI_GOLDEN || '').toLowerCase())
        ? 'set TIMETABLE_RULE_AI_GOLDEN=1 to run external AI golden validation'
        : false,
    timeout: 20 * 60_000,
}, async () => {
    const corpus = await loadConstraintCorpus();
    const allRows = corpus.rows;
    const requestedIds = String(process.env.TIMETABLE_RULE_AI_GOLDEN_IDS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const requestedIdSet = new Set(requestedIds);
    const unknownIds = requestedIds.filter(id => !allRows.some(row => row.id === id));
    assert.deepEqual(unknownIds, [], `unknown golden case ids: ${unknownIds.join(', ')}`);
    const rows = requestedIds.length
        ? allRows.filter(row => requestedIdSet.has(row.id))
        : allRows;
    assert.ok(rows.length > 0, 'real AI golden selection is empty');
    const report = await runTimetableAiGolden({
        rows,
        corpusHash: corpus.hash,
        corpusTotalRows: allRows.length,
        selectedIds: requestedIds,
        project: goldenProject(),
        env: process.env,
        concurrency: process.env.TIMETABLE_RULE_AI_GOLDEN_CONCURRENCY || 2,
        retryLimit: process.env.TIMETABLE_RULE_AI_GOLDEN_RETRIES || 3,
    });
    const reportPath = path.resolve(process.env.TIMETABLE_RULE_AI_GOLDEN_REPORT || '.tmp-timetable-ai-golden-latest.json');
    const markdownPath = path.resolve(process.env.TIMETABLE_RULE_AI_GOLDEN_MARKDOWN_REPORT || '.tmp-timetable-ai-golden-latest.md');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderTimetableAiGoldenMarkdown(report), 'utf8');
    console.log(JSON.stringify({
        reportPath,
        markdownPath,
        model: report.model,
        promptVersion: report.promptVersion,
        corpusHash: report.corpusHash,
        corpusRows: report.corpusRows,
        coverage: report.coverage,
        fieldAccuracy: report.fieldAccuracy,
        sourcePreservationRate: report.sourcePreservationRate,
        sourceAlignmentRate: report.sourceAlignmentRate,
        p95Ms: report.p95Ms,
        sampleMisses: report.misses.slice(0, 50),
    }));

    assert.deepEqual(timetableAiGoldenGateFailures(report), []);
});


test('AI extraction preserves scalar parser provenance and warning values', () => {
    const legacy = validateExtractionPayload({
        requirements: [{
            intent: 'subject_morning',
            targetKind: 'subject',
            targetNames: ['数学'],
            evidence: '数学尽量安排在上午',
            parsedBy: 'local',
        }],
    });
    assert.deepEqual(legacy.requirements[0].parsedBy, ['local', 'ai']);

    const sourceScoped = validateExtractionPayload({
        results: [{
            sourceId: 'src:test',
            textHash: 'hash:test',
            warnings: '单条 AI 警告',
            clauses: [{
                intent: 'subject_morning',
                targetKind: 'subject',
                targetNames: ['数学'],
                evidence: '数学尽量安排在上午',
            }],
        }],
    });
    assert.ok(sourceScoped.warnings.includes('单条 AI 警告'));
    assert.equal(sourceScoped.warnings.includes('单'), false);
});


test('AI entity resolution treats scalar aliases and scalar parameter id lists as complete values', () => {
    const aliasedProject = project({
        teachers: [
            { id: 't_zhang', name: '张老师', aliases: '张主任', subjects: ['math'], unavailableSlots: [] },
            { id: 't_wang', name: '王老师', subjects: ['chinese'], unavailableSlots: [] },
        ],
    });
    const aliasResolved = resolveEntityRefs(aliasedProject, [{
        id: 'alias-teacher',
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: ['张主任'],
        params: { slots: ['1-1'] },
        confidence: 0.9,
    }]);
    assert.deepEqual(aliasResolved.semanticRequirements[0].object.matchedIds, ['t_zhang']);

    const idResolved = resolveEntityRefs(aliasedProject, [{
        id: 'scalar-teacher-id',
        intent: 'teacher_unavailable',
        targetKind: 'teacher',
        targetNames: [],
        params: { teacherIds: 't_zhang', slots: ['1-1'] },
        confidence: 0.9,
    }]);
    assert.deepEqual(idResolved.semanticRequirements[0].object.matchedIds, ['t_zhang']);
});
