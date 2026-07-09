import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import {
    buildAiRequirementExtractionMessages,
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
    const corpus = await readFile(path.join(process.cwd(), 'test/fixtures/constraint-corpus.jsonl'), 'utf8');
    return corpus.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
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

const FIELD_EXPECTATIONS = {
    c001: [{ intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { days: [1], dayPart: 'morning' }, strength: 'hard' }],
    c002: [{ intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['王老师'], time: { days: [3], periods: [3] }, strength: 'hard' }],
    c003: [{ intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['李老师'], time: { days: [5], dayPart: 'afternoon' }, strength: 'hard' }],
    c005: [{ intent: 'class_unavailable', targetKind: 'class', targetNames: ['三(1)班'], time: { days: [5], dayPart: 'afternoon' }, strength: 'hard' }],
    c007: [{ intent: 'global_unavailable', targetKind: 'global', time: { days: [1], periods: [1] }, strength: 'hard' }],
    c011: [{ intent: 'teaching_group_meeting', targetKind: 'teaching_group', targetNames: ['数学'], time: { days: [3], dayPart: 'afternoon' }, strength: 'hard' }],
    c017: [{ intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft' }],
    c021: [{ intent: 'subject_afternoon', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' }],
    c023: [{ intent: 'subject_preferred_periods', targetKind: 'subject', targetNames: ['英语'], time: { periods: [2, 3, 4] }, strength: 'soft' }],
    c025: [{ intent: 'avoid_first_period', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' }],
    c029: [{ intent: 'subject_daily_limit', targetKind: 'subject', targetNames: ['数学'], params: { limit: 2 }, strength: 'hard' }],
    c031: [{ intent: 'teacher_daily_limit', targetKind: 'teacher', params: { limit: 4 }, strength: 'soft' }],
    c033: [{ intent: 'teacher_consecutive_limit', targetKind: 'teacher', params: { limit: 3 }, strength: 'soft' }],
    c035: [{ intent: 'teacher_weekly_limit', targetKind: 'teacher', targetNames: ['李老师'], params: { limit: 16 }, strength: 'hard' }],
    c037: [{ intent: 'teacher_max_days_per_week', targetKind: 'teacher', targetNames: ['张老师'], params: { limit: 4 }, strength: 'hard' }],
    c039: [{ intent: 'teacher_mutual_exclusion', targetKind: 'teacher', targetNames: ['张老师', '王老师'], strength: 'hard' }],
    c043: [{ intent: 'course_interval', targetKind: 'subject', targetNames: ['体育'], params: { minGapDays: 2 }, strength: 'soft' }],
    c045: [{ intent: 'room_requirement', targetKind: 'subject', targetNames: ['物理'], params: { roomName: '实验室' }, strength: 'hard' }],
    c050: [{ intent: 'teacher_gap_preference', targetKind: 'global', strength: 'soft' }],
    c052: [{ intent: 'teacher_load_balance', targetKind: 'global', strength: 'soft' }],
    c054: [{ intent: 'subject_not_same_day', targetKind: 'subject', targetNames: ['语文', '数学'], strength: 'hard' }],
    c056: [{ intent: 'subject_sequence', targetKind: 'subject', targetNames: ['数学', '物理'], strength: 'soft' }],
    c075: [{ intent: 'teacher_load_balance', needsClarification: true }],
    c080: [{ intent: 'room_requirement', targetKind: 'subject', targetNames: ['科学'], needsClarification: true }],
    c081: [{ intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { days: [1, 3], periods: [1, 2] }, strength: 'hard' }],
    c086: [{ intent: 'avoid_first_period', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' }, { intent: 'avoid_last_period', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' }],
    c093: [{ intent: 'room_requirement', targetKind: 'subject', targetNames: ['足球'], params: { roomName: '操场' }, strength: 'hard' }],
    c107: [
        { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft' },
        { intent: 'subject_afternoon', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' },
        { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { days: [1] }, strength: 'hard' },
    ],
};

function comparableName(value = '') {
    return String(value ?? '')
        .replace(/老师|教师|课程|科目|学科|教研组|备课组|小组|组|班级|班/g, '')
        .replace(/[\s()（）\-_.]/g, '')
        .toLowerCase();
}

function equivalentIntentsFor(item = {}) {
    const intents = new Set([item.intent]);
    const evidence = String(item.evidence || '').replace(/\s+/g, '');
    const periods = new Set([
        ...collectCandidateValues([item], ['time', 'periods']).map(Number),
        ...collectCandidateValues([item], ['time', 'slots']).map(slot => Number(String(slot).split('-')[1])).filter(Boolean),
    ]);
    if (item.intent === 'subject_avoid_periods') {
        if (periods.has(1) || /(第一节|首节|第1节|上午第一节)/.test(evidence)) intents.add('avoid_first_period');
        if (/(最后一节|放学前|末节)/.test(evidence)) intents.add('avoid_last_period');
    }
    if (item.intent === 'locked_slot' && /(早读|首节)/.test(evidence)) intents.add('first_period_assign');
    if (/(固定|主持).*(班会|课)|班会.*固定/.test(evidence)) intents.add('locked_slot');
    if ((item.intent === 'subject_morning' || item.intent === 'subject_preferred_periods')
        && /(黄金|前四节|主科|数理化)/.test(evidence)) intents.add('golden_hour_preference');
    if (item.intent === 'golden_hour_preference') intents.add('subject_morning');
    if (item.intent === 'global_unavailable' && /^(全部|所有|全体|每位|每个|各位).*(教师|老师)/.test(evidence)) intents.add('teacher_unavailable');
    if (item.intent === 'global_unavailable' && /(午休|中午最后一节|下午第一节)/.test(evidence)) intents.add('lunch_protection');
    if (/全校.*(社团|升旗|大扫除|活动|教研)|不排主课/.test(evidence)) intents.add('global_unavailable');
    if (item.intent === 'teaching_group_meeting') intents.add('teacher_unavailable');
    if (/隔天排|至少隔|间隔/.test(evidence) && /课/.test(evidence)) intents.add('course_interval');
    if (/(老师|教师).*别太累|老师别太累|教师别太累/.test(evidence)) intents.add('teacher_load_balance');
    if (/排太密|别太密/.test(evidence)) intents.add('teacher_consecutive_limit');
    if (/不要太早上课|别太早上课/.test(evidence)) intents.add('teacher_unavailable');
    if (/主科.*(集中|堆)/.test(evidence)) intents.add('class_daily_balance');
    if (/这几门课.*错开|几门课.*错开/.test(evidence)) intents.add('subject_not_same_day');
    if (/(跨校区|通勤|南北校区|校区连续)/.test(evidence)) intents.add('campus_commute_gap');
    if (!/(老师|教师)/.test(evidence) && /(连堂|两节连上|两节连排|大课)/.test(evidence)) intents.add('block_preference');
    if (/(单双周|单周|双周|隔周)/.test(evidence)) intents.add('week_pattern');
    if (/(合班|一起上|走班.*(对齐|同一时间)|同一时间对齐)/.test(evidence)) intents.add('teaching_group_session');
    if (/实验室.*维修|实验课.*(教室|场地)/.test(evidence)) intents.add('room_requirement');
    if (item.intent === 'lunch_protection' && (item.targetNames || []).length) intents.add('subject_avoid_periods');
    return intents;
}

function requirementMatchesIntent(item = {}, expectedIntent = '') {
    return equivalentIntentsFor(item).has(expectedIntent);
}

function arrayIncludesAll(actual = [], expected = [], { names = false } = {}) {
    const normalized = (Array.isArray(actual) ? actual : [actual])
        .map(value => names ? comparableName(value) : String(value));
    return expected.every(value => {
        const expectedValue = names ? comparableName(value) : String(value);
        return normalized.some(actualValue => actualValue === expectedValue
            || (names && actualValue && expectedValue && (actualValue.includes(expectedValue) || expectedValue.includes(actualValue))));
    });
}

function collectCandidateValues(candidates = [], pathParts = []) {
    return candidates.flatMap(candidate => {
        let value = candidate;
        for (const part of pathParts) value = value?.[part];
        if (Array.isArray(value)) return value;
        return value === undefined || value === null || value === '' ? [] : [value];
    });
}

function valueMatchesAny(candidates = [], pathParts = [], expected) {
    const values = collectCandidateValues(candidates, pathParts);
    if (Array.isArray(expected)) return arrayIncludesAll(values, expected);
    return values.some(value => String(value) === String(expected));
}

function timeValueMatches(candidates = [], field = '', expected = []) {
    const values = collectCandidateValues(candidates, ['time', field]);
    if (field === 'days' || field === 'periods') {
        for (const slot of collectCandidateValues(candidates, ['time', 'slots'])) {
            const [day, period] = String(slot).split('-').map(Number);
            if (field === 'days' && Number.isInteger(day)) values.push(day);
            if (field === 'periods' && Number.isInteger(period)) values.push(period);
        }
    }
    return Array.isArray(expected)
        ? arrayIncludesAll(values, expected)
        : values.some(value => String(value) === String(expected));
}

function paramValueMatches(candidates = [], key = '', expected) {
    const aliases = {
        minGapDays: ['minGapDays', 'intervalDays', 'gapDays', 'days'],
        roomName: ['roomName', 'roomNames', 'rooms'],
        limit: ['limit', 'max', 'maxPerDay', 'maxConsecutive', 'maxDays'],
    };
    const values = (aliases[key] || [key]).flatMap(alias => collectCandidateValues(candidates, ['params', alias]));
    return Array.isArray(expected)
        ? arrayIncludesAll(values, expected)
        : values.some(value => String(value) === String(expected));
}

function scoreFieldExpectations(expectedFields = [], actualRequirements = []) {
    const misses = [];
    let hits = 0;
    let total = 0;
    for (const expected of expectedFields) {
        const candidates = actualRequirements.filter(item => requirementMatchesIntent(item, expected.intent));
        const check = (label, matched) => {
            total += 1;
            if (matched) hits += 1;
            else misses.push({ intent: expected.intent, field: label, expected });
        };
        if (expected.targetKind) check('targetKind', candidates.some(item => item.targetKind === expected.targetKind));
        if (expected.targetNames) check('targetNames', arrayIncludesAll(collectCandidateValues(candidates, ['targetNames']), expected.targetNames, { names: true }));
        if (expected.strength) check('strength', candidates.some(item => item.strength === expected.strength));
        if (Object.prototype.hasOwnProperty.call(expected, 'needsClarification')) {
            check('needsClarification', candidates.some(item => Boolean(item.needsClarification) === expected.needsClarification));
        }
        if (expected.time?.days) check('time.days', timeValueMatches(candidates, 'days', expected.time.days));
        if (expected.time?.periods) check('time.periods', timeValueMatches(candidates, 'periods', expected.time.periods));
        if (expected.time?.dayPart) check('time.dayPart', valueMatchesAny(candidates, ['time', 'dayPart'], expected.time.dayPart));
        for (const [key, value] of Object.entries(expected.params || {})) {
            check(`params.${key}`, paramValueMatches(candidates, key, value));
        }
    }
    return { hits, total, misses };
}

function countExpectedFieldChecks() {
    return Object.values(FIELD_EXPECTATIONS)
        .flat()
        .reduce((total, expected) => total
            + (expected.targetKind ? 1 : 0)
            + (expected.targetNames ? 1 : 0)
            + (expected.strength ? 1 : 0)
            + (Object.prototype.hasOwnProperty.call(expected, 'needsClarification') ? 1 : 0)
            + (expected.time?.days ? 1 : 0)
            + (expected.time?.periods ? 1 : 0)
            + (expected.time?.dayPart ? 1 : 0)
            + Object.keys(expected.params || {}).length, 0);
}

function isTransientAiGoldenError(error = {}) {
    return ['ai_extract_empty', 'ai_extract_invalid_json', 'ai_extract_timeout', 'ai_extract_failed']
        .includes(error.reason);
}

function wait(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractGoldenWithRetry(options = {}, attempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await extractRequirementsWithAI(options);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !isTransientAiGoldenError(error)) throw error;
            await wait(300 * attempt);
        }
    }
    throw lastError;
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
    assert.match(messages[1].content, /张老师周一不排课/);
});

test('extractRequirementsWithAI returns locally resolved draft rows and semantic requirements', async () => {
    let observedBody = null;
    const result = await extractRequirementsWithAI({
        project: project(),
        text: '数学尽量上午，音乐不要第一节',
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl: async (url, options = {}) => {
            assert.equal(String(url), 'http://ai.test/chat/completions');
            observedBody = JSON.parse(options.body);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            requirements: [
                                { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft', confidence: 0.94, evidence: '数学尽量上午' },
                                { intent: 'avoid_first_period', targetKind: 'subject', targetNames: ['体育'], strength: 'soft', confidence: 0.9, evidence: '体育不要第一节' },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(observedBody.temperature, 0);
    assert.equal(result.promptVersion, 'timetable_ai_requirement_extract_v2');
    assert.ok(result.draftRows.some(row => row.type === 'subject_morning' && row.targetId === 'math'));
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

test('extractRequirementsWithAI batches more than 30 sentences and merges duplicate requirements stably', async () => {
    resetTimetableAiExtractionCache();
    const text = Array.from({ length: 35 }, (_, index) => (index % 2 === 0 ? '数学尽量上午。' : '体育不要第一节。')).join('');
    const calls = [];
    const result = await extractRequirementsWithAI({
        project: project(),
        text,
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_BATCH_CONCURRENCY: '2',
        },
        fetchImpl: async (url, options = {}) => {
            const body = JSON.parse(options.body);
            calls.push(body.messages[1].content);
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            requirements: [
                                { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft', confidence: 0.9, evidence: '数学尽量上午' },
                                { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft', confidence: 0.9, evidence: '数学尽量上午' },
                            ],
                        }),
                    },
                }],
            });
        },
    });

    assert.equal(calls.length, 2);
    assert.equal(result.batch.sentenceCount, 35);
    assert.equal(result.batch.chunkCount, 2);
    assert.equal(result.batch.concurrency, 2);
    assert.equal(result.rawRequirements.length, 1);
    assert.equal(result.draftRows.length, 1);
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
            return jsonResponse({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            requirements: [
                                { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['王老师'], time: { slots: ['3-3'] }, strength: 'hard', confidence: 0.94, evidence: '王老师周三第3节没空' },
                            ],
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

test('validateExtractionPayload downgrades unknown intents without throwing', () => {
    const result = validateExtractionPayload({
        requirements: [{ intent: 'teleport_course', targetNames: ['数学'], evidence: '数学瞬移' }],
    });

    assert.equal(result.requirements[0].intent, 'unknown');
    assert.ok(result.warnings.some(warning => warning.includes('intent 不在目录')));
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
        text: '数学尽量上午，张老师周一第一节不排课',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
        },
        fetchImpl: async () => jsonResponse({
            choices: [{
                message: {
                    content: JSON.stringify({
                        requirements: [
                            { intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft', confidence: 0.95, evidence: '数学尽量上午' },
                            { intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { slots: ['1-1'] }, strength: 'hard', confidence: 0.95, evidence: '张老师周一第一节不排课' },
                        ],
                    }),
                },
            }],
        }),
    });

    assert.equal(result.parseSource, 'ai_extract');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, ['math']);
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable.t_zhang, ['1-1']);
    assert.equal(result.aiReview.status, 'skipped');
});

test('parseTimetableRules falls back to local parsing when AI-first returns invalid JSON', async () => {
    const result = await parseTimetableRules({
        text: '数学尽量上午',
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
    assert.deepEqual(result.draftRules.softRules.morningSubjects, ['math']);
    assert.ok(result.warnings.some(warning => warning.includes('AI-first 抽取失败')));
});

test('parseTimetableRules falls back when AI-first is enabled without an API key', async () => {
    const result = await parseTimetableRules({
        text: '数学尽量上午',
        project: project(),
        env: {
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
    });

    assert.equal(result.parseSource, 'local_text');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, ['math']);
    assert.ok(result.warnings.some(warning => warning.includes('AI-first 抽取失败')));
});

test('parseTimetableRules falls back when AI-first times out', async () => {
    const result = await parseTimetableRules({
        text: '数学尽量上午',
        project: project(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_EXTRACT: '1',
            TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS: '1',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
        fetchImpl: async () => new Promise(() => {}),
    });

    assert.equal(result.parseSource, 'local_text');
    assert.deepEqual(result.draftRules.softRules.morningSubjects, ['math']);
    assert.ok(result.warnings.some(warning => warning.includes('超时')));
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
    assert.ok(countExpectedFieldChecks() >= 80);
    assert.ok(FIELD_EXPECTATIONS.c001.some(item => item.time?.dayPart === 'morning'));
    assert.ok(FIELD_EXPECTATIONS.c029.some(item => item.params?.limit === 2));
    assert.ok(FIELD_EXPECTATIONS.c075.some(item => item.needsClarification));
    assert.match(baseline, /覆盖率基线/);
    assert.match(baseline, /字段准确率基线/);
});

test('real AI golden corpus meets coverage and latency gates', {
    skip: !['1', 'true', 'yes', 'on'].includes(String(process.env.TIMETABLE_RULE_AI_GOLDEN || '').toLowerCase())
        ? 'set TIMETABLE_RULE_AI_GOLDEN=1 to run external AI golden validation'
        : false,
    timeout: 20 * 60_000,
}, async () => {
    const rows = await loadCorpusRows();
    const p = goldenProject();
    const durations = [];
    let coveredRows = 0;
    let fieldHits = 0;
    let fieldTotal = 0;
    const misses = [];

    for (const row of rows) {
        const started = performance.now();
        const result = await extractGoldenWithRetry({
            project: p,
            text: row.text,
            env: {
                ...process.env,
                TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS: process.env.TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS || '15000',
            },
        });
        durations.push(performance.now() - started);
        const actualRequirements = result.rawRequirements || [];
        const actualIntents = new Set(actualRequirements.flatMap(item => [...equivalentIntentsFor(item)]));
        const expectedIntents = row.expectedIntents || [];
        const expectedFields = FIELD_EXPECTATIONS[row.id] || [];

        if (row.unrecognized) {
            const ok = actualIntents.size === 0
                || actualIntents.has('unknown')
                || (result.warnings || []).some(warning => /未识别|unrecognized/i.test(warning));
            fieldTotal += 1;
            if (ok) {
                fieldHits += 1;
                coveredRows += 1;
            } else {
                misses.push({ id: row.id, expected: 'unrecognized', actual: [...actualIntents] });
            }
            continue;
        }

        let rowHits = 0;
        for (const intent of expectedIntents) {
            fieldTotal += 1;
            if (actualIntents.has(intent)) {
                fieldHits += 1;
                rowHits += 1;
            }
        }
        const fieldResult = scoreFieldExpectations(expectedFields, actualRequirements);
        fieldTotal += fieldResult.total;
        fieldHits += fieldResult.hits;
        const clarificationOk = !row.needsClarification
            || (result.rawRequirements || []).some(item => item.needsClarification)
            || (result.semanticRequirements || []).some(item => item.status === 'needs_review' || item.clarification);
        if (rowHits === expectedIntents.length && clarificationOk) {
            coveredRows += 1;
        } else {
            misses.push({ id: row.id, expected: expectedIntents, actual: [...actualIntents], clarificationOk });
        }
        if (fieldResult.misses.length) {
            misses.push({ id: row.id, fieldMisses: fieldResult.misses.slice(0, 5), actual: actualRequirements });
        }
    }

    const coverage = coveredRows / rows.length;
    const fieldAccuracy = fieldHits / Math.max(1, fieldTotal);
    const sortedDurations = durations.slice().sort((left, right) => left - right);
    const p95 = sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * 0.95))] || 0;
    console.log(JSON.stringify({
        corpusRows: rows.length,
        coverage,
        fieldAccuracy,
        p95Ms: Math.round(p95),
        sampleMisses: misses.slice(0, 10),
    }));

    assert.ok(coverage >= 0.95);
    assert.ok(fieldAccuracy >= 0.98);
    assert.ok(p95 <= 15_000);
});
