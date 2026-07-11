import { createHash } from 'node:crypto';

import {
    getActivePeriods,
    getActiveWeekdays,
    getDayPartPeriods,
    normalizeTimetableProject,
    slotKey,
} from './timetable-project.js';
import {
    AI_REQUIREMENT_PROMPT_VERSION,
    TIMETABLE_REQUIREMENT_INTENTS,
    buildAiRequirementExtractionMessages,
} from './timetable-ai-prompts.js';
import { recordConstraintMetric } from './timetable-constraint-observability.js';
import { normalizeTimetableMarketText } from './timetable-language-normalizer.js';
import {
    buildSourceRequirements,
    sourceInputRowsFromText,
} from './timetable-constraints/source-requirement.js';
import {
    alignAiArtifactsToSources,
    sourceRequirementsToAiInputs,
} from './timetable-constraints/ai-source-alignment.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const INTENT_SET = new Set(TIMETABLE_REQUIREMENT_INTENTS);
const MAX_CACHE_ENTRIES = 200;
const ENTITY_PRUNE_THRESHOLD = 200;
const BATCH_SENTENCE_THRESHOLD = 30;
const BATCH_SENTENCES_PER_CHUNK = 20;

const aiExtractionCache = new Map();

export class TimetableAiExtractionError extends Error {
    constructor(message, reason = 'ai_extract_failed', status = 502) {
        super(message);
        this.name = 'TimetableAiExtractionError';
        this.reason = reason;
        this.status = status;
    }
}

function text(value = '', max = 1000) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function asList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function unique(values = []) {
    return [...new Set(asList(values).map(value => text(value, 160)).filter(Boolean))];
}

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value ?? null));
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function sha256(value) {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeName(value = '') {
    return text(value, 200)
        .toLowerCase()
        .replace(/老师|教师|同学|课程|科目|学科|教研组|备课组|年级|班级|班/g, '')
        .replace(/[\s()（）\-_.]/g, '');
}

function cacheEnabled(env = {}) {
    return !['0', 'false', 'off', 'no'].includes(String(env.TIMETABLE_RULE_AI_CACHE || '1').toLowerCase());
}

function rememberCache(key = '', value = {}) {
    if (!key) return;
    if (aiExtractionCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = aiExtractionCache.keys().next().value;
        if (oldest) aiExtractionCache.delete(oldest);
    }
    aiExtractionCache.set(key, cloneValue(value));
}

function readCache(key = '') {
    if (!key || !aiExtractionCache.has(key)) return null;
    const value = cloneValue(aiExtractionCache.get(key));
    aiExtractionCache.delete(key);
    aiExtractionCache.set(key, cloneValue(value));
    return value;
}

export function resetTimetableAiExtractionCache() {
    aiExtractionCache.clear();
}

export function getTimetableAiExtractionCacheStats() {
    return {
        size: aiExtractionCache.size,
        maxEntries: MAX_CACHE_ENTRIES,
        keys: [...aiExtractionCache.keys()],
    };
}

function normalizeCacheInput(value = '') {
    return text(value, 20_000).toLowerCase();
}

function compactEntityForPrompt(item = {}, kind = '') {
    if (kind === 'class') {
        return {
            id: item.id || '',
            name: item.name || '',
            grade: item.grade || '',
            label: [item.grade, item.name].filter(Boolean).join(''),
            aliases: asList(item.aliases),
        };
    }
    return {
        id: item.id || '',
        name: item.name || item.label || '',
        aliases: asList(item.aliases),
        subjects: asList(item.subjects),
        tags: asList(item.tags),
    };
}

function entityCandidateSnapshot(project = {}) {
    return {
        teachers: (project.teachers || []).map(item => compactEntityForPrompt(item, 'teacher')),
        classes: (project.classes || []).map(item => compactEntityForPrompt(item, 'class')),
        subjects: (project.subjects || []).map(item => compactEntityForPrompt(item, 'subject')),
        rooms: (project.rooms || []).map(item => compactEntityForPrompt(item, 'room')),
    };
}

function projectContextSnapshot(project = {}, contextStats = null) {
    return {
        activeWeekdays: project.activeWeekdays || [],
        activePeriods: project.activePeriods || [],
        dayPartBoundaries: project.dayPartBoundaries || {},
        lessonPlans: (project.lessonPlans || []).map(plan => ({
            id: plan.id || '',
            classId: plan.classId || '',
            subjectId: plan.subjectId || '',
            teacherId: plan.teacherId || '',
            teacherIds: asList(plan.teacherIds),
            weeklyHours: plan.weeklyHours,
            blockPreference: plan.blockPreference || '',
        })),
        rules: project.rules || {},
        contextStats,
    };
}

function buildCacheKey({ model = '', requestText = '', promptProject = {}, contextStats = null, sourceInputs = [] } = {}) {
    return sha256({
        promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
        model,
        normalizedInput: normalizeCacheInput(requestText),
        sourceIdentityHash: sha256(sourceInputs),
        entityCandidateHash: sha256(entityCandidateSnapshot(promptProject)),
        projectContextHash: sha256(projectContextSnapshot(promptProject, contextStats)),
    });
}

function totalEntityCount(project = {}) {
    return ['teachers', 'classes', 'subjects', 'rooms']
        .reduce((sum, key) => sum + (project[key] || []).length, 0);
}

function entityMentionScore(input = '', item = {}, kind = '') {
    const raw = text(input, 20_000);
    const normalizedInput = normalizeName(raw);
    let score = 0;
    for (const alias of entityAliases(item, kind)) {
        const cleanAlias = text(alias, 160);
        const normalizedAlias = normalizeName(cleanAlias);
        if (!cleanAlias && !normalizedAlias) continue;
        if (cleanAlias && raw.includes(cleanAlias)) score += 10;
        if (normalizedAlias && normalizedInput.includes(normalizedAlias)) score += 6;
        if (normalizedAlias && normalizedAlias.length >= 2 && normalizedInput.includes(normalizedAlias.slice(0, 2))) score += 1;
    }
    return score;
}

function relevantEntities(items = [], input = '', kind = '', limit = 80) {
    return items
        .map((item, index) => ({ item, index, score: entityMentionScore(input, item, kind) }))
        .filter(entry => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, limit)
        .map(entry => entry.item);
}

function idsOf(items = []) {
    return new Set(items.map(item => item.id).filter(Boolean));
}

function pruneProjectEntitiesForPrompt(project = {}, input = '') {
    if (totalEntityCount(project) <= ENTITY_PRUNE_THRESHOLD) return { project, pruned: false };
    const teachers = relevantEntities(project.teachers || [], input, 'teacher');
    const classes = relevantEntities(project.classes || [], input, 'class');
    const subjects = relevantEntities(project.subjects || [], input, 'subject');
    const rooms = relevantEntities(project.rooms || [], input, 'room');
    const teacherIds = idsOf(teachers);
    const classIds = idsOf(classes);
    const subjectIds = idsOf(subjects);

    const relatedPlans = (project.lessonPlans || []).filter(plan => (
        teacherIds.has(plan.teacherId)
        || asList(plan.teacherIds).some(teacherId => teacherIds.has(teacherId))
        || classIds.has(plan.classId)
        || subjectIds.has(plan.subjectId)
    ));
    relatedPlans.forEach(plan => {
        if (plan.teacherId) teacherIds.add(plan.teacherId);
        asList(plan.teacherIds).forEach(teacherId => teacherIds.add(teacherId));
        if (plan.classId) classIds.add(plan.classId);
        if (plan.subjectId) subjectIds.add(plan.subjectId);
    });

    return {
        project: {
            ...project,
            teachers: (project.teachers || []).filter(item => teacherIds.has(item.id) || teachers.includes(item)),
            classes: (project.classes || []).filter(item => classIds.has(item.id) || classes.includes(item)),
            subjects: (project.subjects || []).filter(item => subjectIds.has(item.id) || subjects.includes(item)),
            rooms,
            lessonPlans: relatedPlans,
            aiPromptEntityPruned: true,
            aiPromptOriginalEntityCount: totalEntityCount(project),
        },
        pruned: true,
    };
}

export function buildAiExtractionPromptProjectForTests(projectInput = {}, input = '') {
    return pruneProjectEntitiesForPrompt(normalizeTimetableProject(projectInput), input);
}

function resolveAiConfig(env = {}) {
    const apiKey = text(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '', 500);
    const baseUrl = text(env.DEEPSEEK_API_BASE || env.OPENAI_API_BASE || 'https://api.deepseek.com', 500).replace(/\/+$/, '');
    const model = text(env.DEEPSEEK_MODEL || env.OPENAI_MODEL || env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat', 120);
    if (!apiKey) throw new TimetableAiExtractionError('AI-first 抽取未配置 API Key。', 'ai_not_configured', 503);
    return { apiKey, baseUrl, model };
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimetableAiExtractionError('当前环境没有可用 fetch，无法调用 AI-first 抽取。', 'missing_fetch', 503);
}

function timeoutMs(env = {}) {
    const explicit = Number.parseInt(env.TIMETABLE_RULE_AI_EXTRACT_TIMEOUT_MS, 10);
    if (Number.isInteger(explicit) && explicit > 0) return Math.min(explicit, 120_000);
    const legacy = Number.parseInt(env.TIMETABLE_RULE_AI_REVIEW_TIMEOUT_MS, 10);
    if (Number.isInteger(legacy) && legacy > 0) return Math.min(legacy, 120_000);
    return DEFAULT_TIMEOUT_MS;
}

async function fetchWithTimeout(fetchClient, url, options = {}, ms = DEFAULT_TIMEOUT_MS) {
    if (!Number.isInteger(ms) || ms <= 0) return fetchClient(url, options);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutId = null;
    const requestOptions = controller ? { ...options, signal: controller.signal } : options;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            try {
                controller?.abort();
            } catch {
                // The rejection is the authoritative timeout signal.
            }
            reject(new TimetableAiExtractionError('AI-first 抽取超时。', 'ai_extract_timeout', 504));
        }, ms);
    });
    try {
        return await Promise.race([fetchClient(url, requestOptions), timeoutPromise]);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new TimetableAiExtractionError('AI-first 抽取超时。', 'ai_extract_timeout', 504);
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function parseJsonContent(value) {
    if (value && typeof value === 'object') return value;
    const raw = text(value, 200_000);
    if (!raw) throw new TimetableAiExtractionError('AI-first 抽取返回为空。', 'ai_extract_empty', 502);
    try {
        return JSON.parse(raw);
    } catch {
        throw new TimetableAiExtractionError('AI-first 抽取返回内容不是有效 JSON。', 'ai_extract_invalid_json', 502);
    }
}

function normalizedExtractionSources(sourceRequirements = [], requestText = '') {
    if (Array.isArray(sourceRequirements) && sourceRequirements.length) return sourceRequirements;
    return buildSourceRequirements(
        sourceInputRowsFromText(requestText, { inputType: 'text', origin: 'user_input' }),
        { inputType: 'text', origin: 'user_input' }
    );
}

function splitRequirementSentences(input = '') {
    return String(input ?? '').slice(0, 20_000)
        .split(/(?<=[。！？!?；;])|\r?\n+/u)
        .map(sentence => text(sentence, 1000))
        .filter(Boolean);
}

function chunkValues(values = [], size = BATCH_SENTENCES_PER_CHUNK) {
    const chunks = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

async function mapWithConcurrency(values = [], limit = 3, mapper) {
    const results = new Array(values.length);
    let cursor = 0;
    async function worker() {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await mapper(values[index], index);
        }
    }
    await Promise.all(Array.from(
        { length: Math.max(1, Math.min(limit, values.length)) },
        () => worker(),
    ));
    return results;
}

function requirementDedupeKey(item = {}) {
    return sha256({
        sourceId: item.sourceId || item.source?.sourceId || '',
        textHash: item.textHash || item.source?.textHash || '',
        intent: item.intent || '',
        targetKind: item.targetKind || '',
        targetNames: unique(item.targetNames || []),
        targetIds: unique(item.targetIds || []),
        strength: item.strength || '',
        time: item.time || {},
        params: item.params || {},
        evidence: normalizedEvidence(item.evidence || item.rawText || item.text || ''),
    });
}

function mergeBatchExtractionResults(project = {}, results = [], sentenceCount = 0, concurrency = 1) {
    const rawRequirements = [];
    const warnings = [];
    const warningItems = [];
    const unrecognized = [];
    const rejected = [];
    const seen = new Set();
    const seenWarningItems = new Set();
    let cacheHitCount = 0;
    results.forEach((result, chunkIndex) => {
        if (result.cache?.hit) cacheHitCount += 1;
        asList(result.rawRequirements).forEach((requirement, itemIndex) => {
            const key = requirementDedupeKey(requirement);
            if (seen.has(key)) return;
            seen.add(key);
            rawRequirements.push({
                ...requirement,
                id: requirement.id || `ai_batch_${chunkIndex + 1}_${itemIndex + 1}`,
            });
        });
        warnings.push(...asList(result.warnings));
        asList(result.warningItems).forEach(item => {
            const key = sha256(item);
            if (seenWarningItems.has(key)) return;
            seenWarningItems.add(key);
            warningItems.push(item);
        });
        unrecognized.push(...asList(result.unrecognized));
        rejected.push(...asList(result.rejected));
    });
    const resolved = resolveEntityRefs(project, rawRequirements);
    return {
        ...resolved,
        warnings: unique(warnings),
        warningItems,
        unrecognized,
        rejected,
        model: results[0]?.model || '',
        promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
        rawRequirements,
        batch: {
            sentenceCount,
            chunkCount: results.length,
            concurrency,
            cacheHitCount,
            dedupedRequirementCount: rawRequirements.length,
        },
    };
}

function normalizeIntent(value = '') {
    const intent = text(value, 120).toLowerCase().replace(/[-\s]+/g, '_');
    return INTENT_SET.has(intent) ? intent : 'unknown';
}

function normalizedEvidence(value = '') {
    return normalizeTimetableMarketText(text(value, 1000)).replace(/\s+/g, '');
}

function timeHasPeriod(time = {}, period) {
    const periods = unique(time.periods || time.lessonIndexes || []).map(Number);
    if (periods.includes(period)) return true;
    return unique(time.slots || []).some(slot => {
        const [, slotPeriod] = String(slot).split('-').map(Number);
        return slotPeriod === period;
    });
}

const DERIVED_TEACHER_ROLE_PATTERN = /(班主任|年级主任|备课组长|教研组长|学科组长|任课教师|任课老师|全体教师|全部教师|所有教师|教师群体|老师们|教师们)/;
const VAGUE_TEACHER_TIME_PATTERN = /(太早|太晚|过早|过晚|早一些|晚一些|早一点|晚一点)/;
const HARD_TEACHER_UNAVAILABLE_PATTERN = /(没空|无空|不方便|无法|不能|不可|请假|外出|出差|培训|开会|会议|集体备课|教研|听评课|质量分析|学生辅导|个别辅导|不要给.{0,20}安排课|不要排课|不排课)/;
const JOINT_TEACHER_SCHEDULING_PATTERN = /(不能|不可|不要|别).{0,40}(都排|同时排|既.{0,20}又)/;
const TEACHER_MUTUAL_EXCLUSION_PATTERN = /(?:错峰(?:上课|排课)|(?:不能|不可|不要|别).{0,30}(?:同一节|同时).{0,20}(?:都有课|都上课|同时上课|同时排课))/;
const TEACHING_GROUP_MEETING_PATTERN = /(?:备课组|教研组|学科组|[\p{Script=Han}]{1,8}组).{0,20}(?:开会|会议|集体备课|集备|教研(?:活动)?)/u;
const TEACHER_WORKLOAD_BALANCE_PATTERN = /(?:教师|老师)(?:工作量|课时|负载).{0,12}(?:均衡|公平)|(?:工作量|课时分配).{0,12}(?:均衡|公平)/;
const TEACHER_WEEKLY_NUMERIC_LIMIT_PATTERN = /(?:每周|周课时).{0,16}(?:最多|不超过|不得超过|不要超过|上限).{0,6}[一二两三四五六七八九十\d]+(?:节|课)?/;
const SCHEDULING_DOMAIN_DIRECT_PATTERN = /(排课|课表|课程|课时|课量|节次|第[一二三四五六七八九十\d]+节|连堂|空堂|教室|实验室|机房|操场|上课|授课|班会|晨检|学科|主科|早读)/;
const SCHEDULING_ENTITY_PATTERN = /(老师|教师|班主任|班级|年级|教研组|备课组)/;
const SCHEDULING_ACTION_OR_TIME_PATTERN = /(安排|不排|避开|集中|均衡|分散|周[一二三四五六日天]|上午|下午|末节|首节|第一节|最后一节)/;

const INTENT_TARGET_KINDS = new Map([
    ['teacher_unavailable', new Set(['teacher', 'derived_group'])],
    ['teacher_mutual_exclusion', new Set(['teacher'])],
    ['teacher_avoid_periods', new Set(['teacher', 'derived_group'])],
    ['class_unavailable', new Set(['class', 'grade'])],
    ['global_unavailable', new Set(['global'])],
    ['subject_morning', new Set(['subject'])],
    ['subject_afternoon', new Set(['subject'])],
    ['subject_preferred_periods', new Set(['subject'])],
    ['subject_avoid_periods', new Set(['subject', 'derived_group'])],
    ['avoid_first_period', new Set(['subject', 'derived_group'])],
    ['avoid_last_period', new Set(['subject', 'derived_group'])],
    ['golden_hour_preference', new Set(['subject'])],
    ['subject_daily_limit', new Set(['subject'])],
    ['subject_spread', new Set(['subject'])],
    ['course_interval', new Set(['subject'])],
    ['room_requirement', new Set(['subject'])],
    ['block_preference', new Set(['subject'])],
    ['week_pattern', new Set(['subject', 'class', 'global'])],
    ['teacher_daily_limit', new Set(['teacher', 'derived_group', 'global'])],
    ['teacher_consecutive_limit', new Set(['teacher', 'derived_group', 'global'])],
    ['teacher_weekly_limit', new Set(['teacher', 'derived_group', 'global'])],
    ['teacher_max_days_per_week', new Set(['teacher', 'derived_group', 'global'])],
    ['teacher_gap_preference', new Set(['teacher', 'derived_group', 'global'])],
    ['teacher_load_balance', new Set(['teacher', 'derived_group', 'global'])],
    ['teaching_group_meeting', new Set(['teaching_group'])],
    ['subject_not_consecutive_with', new Set(['subject'])],
    ['unknown', new Set(['unknown'])],
]);

function isSchedulingDomainText(value = '') {
    const normalized = normalizedEvidence(value);
    return SCHEDULING_DOMAIN_DIRECT_PATTERN.test(normalized)
        || (SCHEDULING_ENTITY_PATTERN.test(normalized) && SCHEDULING_ACTION_OR_TIME_PATTERN.test(normalized));
}

function isDerivedTeacherRole(targetKind = '', targetNames = [], evidence = '') {
    const hasTeacherRoleEvidence = unique(targetNames).some(name => DERIVED_TEACHER_ROLE_PATTERN.test(name))
        || DERIVED_TEACHER_ROLE_PATTERN.test(evidence);
    if (hasTeacherRoleEvidence) return true;
    return targetKind === 'derived_group' && /(?:教师|老师)/.test(evidence);
}

function isAllTeachersTarget(targetNames = [], evidence = '') {
    return unique([...asList(targetNames), evidence]).some(value => (
        /(全部|所有|全体|每位|每个|各位)(?:任课)?(?:教师|老师)/.test(value)
        && !/(班主任|年级主任|备课组长|教研组长|学科组长)/.test(value)
    ));
}

function canonicalRoomSubjectTargetName(value = '', project = {}) {
    const original = text(normalizeTimetableMarketText(value), 160);
    if (!original) return '';
    const subjects = asList(project.subjects);
    const direct = subjects.find(subject => entityAliases(subject, 'subject').some(alias => (
        normalizeName(alias) === normalizeName(original)
    )));
    if (direct) return text(direct.name || original, 160);
    const base = original.replace(/(?:实验课|实验)$/, '');
    if (!base || base === original) return original;
    const baseMatch = subjects.find(subject => entityAliases(subject, 'subject').some(alias => (
        normalizeName(alias) === normalizeName(base)
    )));
    return text(baseMatch?.name || base, 160);
}

function intervalDaysFromEvidence(evidence = '') {
    const match = evidence.match(/(?:至少)?(?:隔|间隔)([一二两三四五六七八九十\d]+)天/);
    if (!match) return 1;
    const token = match[1];
    const numeric = Number.parseInt(token, 10);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    const chinese = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return chinese[token] || 1;
}


function positiveNumberToken(value = '') {
    const token = text(value, 20);
    const numeric = Number.parseInt(token, 10);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (token === '十') return 10;
    if (token.includes('十')) {
        const [tens, ones] = token.split('十');
        return (tens ? digits[tens] || 0 : 1) * 10 + (ones ? digits[ones] || 0 : 0);
    }
    return digits[token] || null;
}

function limitFromEvidence(evidence = '') {
    const match = evidence.match(/(?:最多|不超过|不得超过|不要超过|上限(?:为|是)?|控制在)(?:连续|连上|连着|连)?([一二两三四五六七八九十\d]+)(?:节|堂|课|天)?/);
    return match ? positiveNumberToken(match[1]) : null;
}

function daysFromEvidence(evidence = '') {
    const dayMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
    return [...evidence.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])/g)]
        .map(match => dayMap[match[1]])
        .filter(Number.isInteger);
}

function periodsFromEvidence(evidence = '') {
    return [...evidence.matchAll(/第([一二两三四五六七八九十\d]+)节/g)]
        .map(match => positiveNumberToken(match[1]))
        .filter(Number.isInteger);
}

function teacherNamesFromEvidence(evidence = '') {
    return unique([...evidence.matchAll(/[\p{Script=Han}]{1,10}?(?:老师|教师)/gu)]
        .map(match => match[0].replace(/^[和与及、，,]+/, '')));
}

function teachingGroupNamesFromEvidence(evidence = '') {
    const formalNames = [...evidence.matchAll(/[\p{Script=Han}A-Za-z0-9]{1,12}(?:备课组|教研组|学科组)/gu)].map(match => match[0]);
    const shortNames = [...evidence.matchAll(/((?:语文|数学|英语|物理|化学|生物|历史|地理|道法|政治|体育|音乐|美术|信息技术|信息|劳动)组)(?=(?:周|星期|礼拜|在|于|要|需|集备|教研|开会|会议))/gu)].map(match => match[1]);
    return unique([...formalNames, ...shortNames]);
}

function knownSubjectNamesFromEvidence(evidence = '') {
    const known = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道法', '政治', '体育', '音乐', '美术', '信息技术', '信息', '劳动'];
    const found = known.filter(name => evidence.includes(name));
    return found.filter(name => !found.some(other => other !== name && other.includes(name)));
}

function clarificationQuestion(question = '', fallback = '') {
    return text(question, 500) || fallback;
}

function markNeedsClarification(item = {}, question = '', note = '') {
    item.needsClarification = true;
    item.confidence = Math.min(confidenceOf(item.confidence), 0.55);
    item.clarification = {
        ...(item.clarification && typeof item.clarification === 'object' ? item.clarification : {}),
        question: clarificationQuestion(item.clarification?.question, question),
    };
    if (note) item.notes = [text(item.notes, 500), note].filter(Boolean).join('；').slice(0, 500);
    return item;
}

function applyIntentTargetCompatibility(item = {}) {
    const intent = normalizeIntent(item.intent || item.type);
    const targetKind = text(item.targetKind || item.targetType || 'unknown', 80).toLowerCase();
    const allowed = INTENT_TARGET_KINDS.get(intent);
    if (!allowed || targetKind === 'unknown' || allowed.has(targetKind)) return item;
    return markNeedsClarification(
        item,
        `当前识别的对象类型“${targetKind}”与意图“${intent}”不兼容，请确认约束对象和期望行为。`,
        `intent ${intent} 与 targetKind ${targetKind} 不兼容，已阻止自动编译`,
    );
}

function canonicalizeRequirement(item = {}, { project = {} } = {}) {
    const next = { ...item, time: item.time && typeof item.time === 'object' ? { ...item.time } : {} };
    next.params = item.params && typeof item.params === 'object'
        ? { ...item.params }
        : item.parameters && typeof item.parameters === 'object'
            ? { ...item.parameters }
            : {};
    const evidence = normalizedEvidence(item.evidence || item.rawText || item.text || item.reason || item.description || '');
    const sourceEvidence = normalizedEvidence(item.rawText || item.source?.rawText || '');
    const fullEvidence = sourceEvidence || evidence;
    const targetNames = unique(item.targetNames || item.targets || item.names || item.target || item.targetName || [])
        .map(name => text(normalizeTimetableMarketText(name), 160));
    next.targetNames = targetNames;

    // Deterministic semantic firewall for common market phrasing. The AI remains
    // responsible for clause extraction, while these rules repair intent/field
    // drift using only the source evidence (never corpus ids).
    const evidenceDays = daysFromEvidence(evidence);
    const evidencePeriods = periodsFromEvidence(evidence);
    if (!asList(next.time.days).length && evidenceDays.length) next.time.days = evidenceDays;
    if (!asList(next.time.periods).length && evidencePeriods.length) next.time.periods = evidencePeriods;
    if (!next.time.dayPart && /上午/.test(evidence)) next.time.dayPart = 'morning';
    if (!next.time.dayPart && /下午|午后/.test(evidence)) next.time.dayPart = 'afternoon';

    const explicitGrade = evidence.match(/([一二三四五六七八九十]+年级)/)?.[1] || '';
    if (explicitGrade && next.targetKind === 'class') {
        next.targetNames = unique(next.targetNames.map(name => (/^\d{1,2}班$/.test(name) ? explicitGrade + name : name)));
    }

    if (/(?:每周|一周).{0,12}(?:最多|不超过|不得超过).{0,6}(?:来校|到校|在校).{0,4}[一二两三四五六七八九十\d]+天|(?:每周|一周).{0,12}(?:来校|到校|在校).{0,8}(?:最多|不超过).{0,4}[一二两三四五六七八九十\d]+天|(?:这周|本周|每周|一周).{0,8}(?:只|最多|至多|只能)?(?:来|到|在)(?:校)?[一二两三四五六七八九十\d]+天/.test(fullEvidence)) {
        next.intent = 'teacher_max_days_per_week';
        next.targetKind = 'teacher';
        const dayToken = fullEvidence.match(/(?:来校|到校|在校|来|到|在)([一二两三四五六七八九十\d]+)天/)?.[1];
        const limit = limitFromEvidence(fullEvidence) || positiveNumberToken(dayToken);
        if (limit) next.params.limit = limit;
        if (!next.targetNames.length) next.targetNames = teacherNamesFromEvidence(fullEvidence);
    }
    if (/(?:先(?:讲|上|学|做|进行)?理论(?:课)?[,，]?再(?:做|上|进行)?实验(?:课)?|实验(?:课)?要?排?在理论(?:课)?之后)/.test(fullEvidence)) {
        next.intent = 'subject_sequence';
        next.targetKind = 'subject';
        next.targetNames = unique([
            canonicalRoomSubjectTargetName('理论课', project),
            canonicalRoomSubjectTargetName('实验课', project),
        ]).filter(Boolean);
        next.params.beforeSubjectName = next.targetNames[0] || '理论课';
        next.params.afterSubjectName = next.targetNames[1] || '实验课';
        markNeedsClarification(next, '请确认“理论”和“实验”分别对应当前项目中的具体课程。');
    }
    if (/(?:跨校|跨校区).{0,8}(?:老师|教师).{0,12}(?:错开|错峰)/.test(evidence)) {
        next.intent = 'teacher_mutual_exclusion';
        next.targetKind = next.targetNames.length >= 2 ? 'teacher' : 'derived_group';
        next.strength = 'hard';
    }
    if (/(?:老师|教师).{0,16}(?:少空堂|减少空堂|空堂少|别一会儿有课一会儿没课|课表.*(?:紧凑|连贯))/.test(evidence)) {
        next.intent = 'teacher_gap_preference';
        next.targetKind = 'global';
        next.targetNames = [];
        next.needsClarification = false;
    }
    if (/(?:科学|物理|化学|生物).{0,8}(?:实验|实验课).{0,12}(?:合适教室|合适场地|适合的教室)/.test(evidence)) {
        const subject = knownSubjectNamesFromEvidence(evidence)[0] || evidence.match(/^(科学|物理|化学|生物)/)?.[1] || '';
        next.intent = 'room_requirement';
        next.targetKind = 'subject';
        next.targetNames = subject ? [subject] : next.targetNames;
        markNeedsClarification(next, '请明确实验课需要使用的具体教室、实验室或场地。');
    }
    if (next.targetKind === 'subject' && /午饭前后|午休前后|午餐前后/.test(evidence)) {
        next.intent = 'subject_avoid_periods';
        next.strength = 'soft';
    }
    const pronounTeacherUnavailable = /(?:他|她|其).{0,12}(?:没空|不能排|不可排|无法上课)/.test(evidence);
    if (pronounTeacherUnavailable && !teacherNamesFromEvidence(evidence).length) {
        const sourceTeachers = teacherNamesFromEvidence(sourceEvidence);
        next.intent = 'teacher_unavailable';
        next.targetKind = 'teacher';
        if (sourceTeachers.length === 1) {
            next.targetNames = sourceTeachers;
            next.needsClarification = false;
            next.clarification = null;
        } else {
            next.targetNames = [];
            markNeedsClarification(
                next,
                sourceTeachers.length > 1
                    ? '代词前存在多位教师，无法安全判断所指教师，请明确姓名。'
                    : '代词缺少唯一明确的教师先行词，请明确具体教师。',
            );
        }
    }
    if (/(?:高年级|毕业年级).{0,8}(?:主科|语数英).{0,8}(?:尽量|最好|优先)?.{0,4}上午/.test(sourceEvidence || evidence)
        && ['unknown', 'subject_morning'].includes(next.intent)) {
        next.intent = 'subject_morning';
        next.targetKind = 'subject';
        const subjects = knownSubjectNamesFromEvidence(sourceEvidence || evidence);
        next.targetNames = subjects.length ? subjects : ['主科'];
        markNeedsClarification(next, '请明确“高年级”和“主科”分别包含哪些年级与课程。');
    }
    if (/除.{1,20}外.{0,20}(?:其他课|其余课程).{0,16}(?:最后一节|末节)/.test(evidence)) {
        const exceptions = knownSubjectNamesFromEvidence(evidence);
        next.intent = 'avoid_last_period';
        next.targetKind = 'derived_group';
        next.targetNames = [];
        next.exceptions = exceptions;
        next.params.exceptions = exceptions;
        next.params.excludeSubjects = exceptions;
        markNeedsClarification(next, '请确认“其他课”包含的具体课程范围。');
    }
    if (/(?:不必|不用|无需).{0,8}每天都排.{0,12}(?:分散|安排)到[一二两三四五六七八九十\d]+天/.test(evidence)) {
        next.intent = 'subject_spread';
        next.targetKind = 'subject';
        const dayToken = evidence.match(/(?:分散|安排)到([一二两三四五六七八九十\d]+)天/)?.[1];
        const count = positiveNumberToken(dayToken);
        if (count) next.params.days = count;
    }
    if (/(?:不要|别).{0,8}(?:把)?[^，。]{1,30}(?:挤|堆|集中)在(?:周|星期|礼拜)[一二三四五六日天]/.test(evidence)) {
        next.intent = 'subject_spread';
        next.targetKind = 'subject';
        next.strength = 'soft';
    }
    if (/同一天时?.{0,8}(?:不要|不能|不可).{0,6}(?:连续|连着|相邻)/.test(evidence)) {
        next.intent = 'subject_not_consecutive_with';
        next.targetKind = 'subject';
        markNeedsClarification(next, '请确认两门课程在同一天时需要间隔至少几节。');
    }
    if (/不是完全不能排|并非完全不能排|第[一二两三四五六七八九十\d]+节以后可以/.test(evidence)) {
        markNeedsClarification(next, '该句包含部分否定和开放边界，请确认实际不可排的具体节次。');
    }
    if (/除非是?([^，,。]{1,12})[，,]?否则/.test(evidence)) {
        const exception = evidence.match(/除非是?([^，,。]{1,12})[，,]?否则/)?.[1]
            ?.replace(/^[，,、；;：:\s]+|[，,、；;：:\s]+$/g, '');
        if (exception) {
            next.exceptions = [exception];
            next.params.exceptions = [exception];
        }
    }
    const allTeachersTarget = isAllTeachersTarget(targetNames, evidence);
    const derivedTeacherRole = !allTeachersTarget && isDerivedTeacherRole(next.targetKind, targetNames, evidence);
    if (allTeachersTarget) {
        next.targetKind = 'teacher';
    } else if (derivedTeacherRole && ['teacher', 'unknown', '', undefined].includes(next.targetKind)) {
        next.targetKind = 'derived_group';
    }
    const teacherTarget = next.targetKind === 'teacher';
    const vagueTeacherTime = teacherTarget && VAGUE_TEACHER_TIME_PATTERN.test(evidence);
    const teacherMutualExclusion = teacherTarget
        && targetNames.length >= 2
        && TEACHER_MUTUAL_EXCLUSION_PATTERN.test(evidence);
    const jointTeacherSchedulingRestriction = teacherTarget
        && !teacherMutualExclusion
        && JOINT_TEACHER_SCHEDULING_PATTERN.test(evidence);
    const hardTeacherUnavailable = (teacherTarget || derivedTeacherRole)
        && next.intent !== 'teacher_max_days_per_week'
        && !teacherMutualExclusion
        && !jointTeacherSchedulingRestriction
        && HARD_TEACHER_UNAVAILABLE_PATTERN.test(evidence);
    const teacherPeriodPreference = ['avoid_first_period', 'avoid_last_period', 'subject_avoid_periods', 'teacher_avoid_periods'].includes(next.intent)
        && (teacherTarget || derivedTeacherRole);

    if (teacherMutualExclusion) {
        next.intent = 'teacher_mutual_exclusion';
        next.targetKind = 'teacher';
        next.strength = 'hard';
    } else if (jointTeacherSchedulingRestriction) {
        next.intent = 'teacher_avoid_periods';
        next.targetKind = 'teacher';
        next.strength = 'soft';
        markNeedsClarification(
            next,
            '该约束表示多个候选时段不能同时满足，而不是每个时段都禁排；请确认允许保留哪些时段。',
        );
    } else if (vagueTeacherTime || hardTeacherUnavailable) {
        next.intent = 'teacher_unavailable';
        next.targetKind = allTeachersTarget ? 'teacher' : derivedTeacherRole ? 'derived_group' : 'teacher';
        next.strength = 'hard';
        if (vagueTeacherTime) {
            markNeedsClarification(next, '“太早/太晚”具体指哪些课节？请给出明确节次或时间范围。');
        }
    } else if (teacherPeriodPreference || (derivedTeacherRole && /(第一节|首节|第1节|最后一节|末节|放学前)/.test(evidence))) {
        next.intent = 'teacher_avoid_periods';
        next.targetKind = derivedTeacherRole ? 'derived_group' : 'teacher';
        next.strength = 'soft';
        if (derivedTeacherRole) {
            markNeedsClarification(next, '请确认该教师角色组包含哪些教师，或在项目中配置角色成员。');
        }
    }

    if (TEACHING_GROUP_MEETING_PATTERN.test(sourceEvidence) && !/班主任会/.test(sourceEvidence)) {
        next.intent = 'teaching_group_meeting';
        next.targetKind = 'teaching_group';
        next.targetNames = teachingGroupNamesFromEvidence(sourceEvidence).length
            ? teachingGroupNamesFromEvidence(sourceEvidence)
            : targetNames;
        next.activity = next.activity || (/集备/.test(sourceEvidence) ? '集备' : /集体备课/.test(sourceEvidence) ? '集体备课' : '备课组会议');
    }

    if (TEACHER_WEEKLY_NUMERIC_LIMIT_PATTERN.test(evidence) && !/(?:来校|到校|在校).{0,8}[一二两三四五六七八九十\d]+天/.test(evidence)) {
        next.intent = 'teacher_weekly_limit';
        next.targetKind = next.targetKind === 'teacher' && targetNames.length ? 'teacher' : 'derived_group';
        const limit = limitFromEvidence(evidence);
        if (limit) next.params.limit = limit;
    } else if (TEACHER_WORKLOAD_BALANCE_PATTERN.test(evidence)) {
        next.intent = 'teacher_load_balance';
        next.targetKind = 'global';
        next.needsClarification = false;
    }

    if (/错峰(?:上课|排课)/.test(evidence)) {
        const namedTeachers = teacherNamesFromEvidence(evidence);
        if (namedTeachers.length >= 2) {
            next.intent = 'teacher_mutual_exclusion';
            next.targetKind = 'teacher';
            next.targetNames = namedTeachers;
        }
    }

    if (/班主任会/.test(sourceEvidence) && /(?:全体|所有|全部)?班主任.{0,8}(?:避开|不排|不要排)/.test(sourceEvidence)) {
        next.intent = 'teacher_unavailable';
        next.targetKind = 'derived_group';
        next.targetNames = ['班主任'];
        next.activity = '班主任会';
        const days = daysFromEvidence(sourceEvidence);
        if (days.length) next.time.days = unique([...asList(next.time.days), ...days]).map(Number);
        markNeedsClarification(next, '请确认周一班会课的具体节次，以及班主任角色组包含哪些教师。');
    }

    if (/双师课/.test(sourceEvidence) && /(?:两位|多位|两名).{0,8}(?:老师|教师).{0,8}(?:同时到班|同时上课|共同到班)/.test(sourceEvidence)) {
        next.intent = 'teaching_group_session';
        next.targetKind = 'teaching_group';
        next.activity = '双师课';
        markNeedsClarification(next, '请补充双师课对应的班级、课程和需要同时到班的教师。');
    }

    if (/(?:午间管理|午间值守|午间活动).{0,12}(?:不排|避开|不要排).{0,12}(?:普通教学任务|普通课程|课程|课)/.test(sourceEvidence)) {
        next.intent = 'lunch_protection';
        next.targetKind = 'global';
        next.targetNames = [];
        next.activity = sourceEvidence.match(/午间管理|午间值守|午间活动/)?.[0] || '午间活动';
        markNeedsClarification(next, '请确认午间管理时段对应的具体课节或起止时间。');
    }

    if (/(?:黄金时段).{0,8}(?:别占|不要占|避开)|(?:尽量|最好).{0,8}(?:别|不要|避免).{0,8}(?:占|排在).{0,8}黄金时段/.test(sourceEvidence)) {
        const subjectNames = knownSubjectNamesFromEvidence(sourceEvidence);
        if (subjectNames.length) {
            next.intent = 'subject_avoid_periods';
            next.targetKind = 'subject';
            next.targetNames = subjectNames;
            markNeedsClarification(next, '请确认“黄金时段”具体对应哪些课节。');
        }
    }

    if (next.intent === 'teacher_unavailable' && /^[他她](?:不能|不可|不要|没法)/.test(evidence)) {
        const sourceTeachers = teacherNamesFromEvidence(sourceEvidence);
        if (sourceTeachers.length >= 2) {
            next.targetNames = [];
            const periods = periodsFromEvidence(evidence);
            if (periods.length) next.time.periods = unique([...asList(next.time.periods), ...periods]).map(Number);
            markNeedsClarification(next, `“${evidence[0]}”可能指代${sourceTeachers.join('或')}，请确认具体教师。`);
        }
    }

    if (/跨校区|通勤|南北校区|校区连续/.test(evidence)) {
        next.intent = 'campus_commute_gap';
        next.targetKind = next.targetKind || 'teacher';
    }

    if (/全校.*(社团|升旗|大扫除|活动|教研)|不排主课/.test(evidence)) {
        next.intent = 'global_unavailable';
        next.targetKind = 'global';
    }

    if (!/(老师|教师)/.test(evidence)
        && !/大课间/.test(evidence)
        && /(连堂|两节连上|两节连排|大课)/.test(evidence)) {
        next.intent = 'block_preference';
        next.targetKind = next.targetKind || 'subject';
    }

    if (/(不要|别|避免).{0,12}(连着|连续).{0,8}(几天|多天|每天).{0,8}(都)?排/.test(evidence)
        && !['teacher', 'derived_group'].includes(next.targetKind)) {
        next.intent = 'subject_spread';
        next.targetKind = 'subject';
        next.strength = 'soft';
    }
    if (/(隔天排|至少隔[一二两三四五六七八九十\d]*天|间隔[一二两三四五六七八九十\d]*天|至少(?:岔开|错开|隔开)[一二两三四五六七八九十\d]+天)/.test(evidence)
        && !['teacher', 'derived_group'].includes(next.targetKind)) {
        next.intent = 'course_interval';
        next.targetKind = 'subject';
        const colloquialGap = evidence.match(/至少(?:岔开|错开|隔开)([一二两三四五六七八九十\d]+)天/)?.[1];
        next.params.minGapDays = next.params.minGapDays
            || (colloquialGap ? positiveNumberToken(colloquialGap) : intervalDaysFromEvidence(evidence));
    }

    if (!TEACHER_WEEKLY_NUMERIC_LIMIT_PATTERN.test(evidence)
        && (/(老师|教师).*别太累|老师别太累|教师别太累|高负载老师|整体负载公平|负载公平|教师负载.*(均衡|公平)/.test(evidence))) {
        next.intent = 'teacher_load_balance';
        next.targetKind = 'global';
        next.needsClarification = !/(整体负载公平|负载公平|教师负载.*(均衡|公平))/.test(evidence);
    }

    if (/排太密|别太密/.test(evidence)) {
        next.intent = 'teacher_consecutive_limit';
        next.targetKind = next.targetKind || 'teacher';
        next.needsClarification = true;
    }

    if (/主科.*(集中|堆)/.test(evidence)) {
        next.intent = 'class_daily_balance';
        next.targetKind = 'global';
        next.needsClarification = true;
    }

    if (/这几门课.*错开|几门课.*错开/.test(sourceEvidence || evidence)) {
        next.intent = 'subject_not_same_day';
        next.targetKind = 'subject';
        next.needsClarification = true;
    }

    if (/(单双周|单周|双周|隔周)/.test(evidence)) {
        next.intent = 'week_pattern';
    }

    if (/(合班|一起上|走班.{0,20}(?:对齐|同一时间|同开|同一节)|同一时间对齐)/.test(evidence)) {
        next.intent = 'teaching_group_session';
        next.targetKind = 'teaching_group';
        if (/走班/.test(evidence) && !next.targetNames.length) {
            markNeedsClarification(next, '请明确走班课程、参与班级和需要同步到班的教师。');
        }
    }

    if (next.intent === 'global_unavailable' && /^(全部|所有|全体|每位|每个|各位).*(教师|老师)/.test(evidence)) {
        next.intent = 'teacher_unavailable';
        next.targetKind = 'teacher';
        next.targetNames = targetNames.length ? targetNames : ['全部教师'];
    }

    if (next.intent === 'locked_slot' && /(早读|首节)/.test(evidence)) {
        next.intent = 'first_period_assign';
        next.targetKind = next.targetKind || 'subject';
    }

    if (next.intent === 'subject_morning' && /上午/.test(evidence)) next.time.dayPart = 'morning';
    if (next.intent === 'subject_afternoon' && /下午/.test(evidence)) next.time.dayPart = 'afternoon';
    if (['teacher_daily_limit', 'teacher_weekly_limit', 'teacher_consecutive_limit', 'teacher_max_days_per_week'].includes(next.intent) && !next.params.limit) {
        const limit = limitFromEvidence(evidence);
        if (limit) next.params.limit = limit;
    }

    if ((next.intent === 'subject_morning' || next.intent === 'subject_preferred_periods')
        && /(黄金|前四节)/.test(evidence)) {
        next.intent = 'golden_hour_preference';
    }

    if (next.intent === 'global_unavailable'
        && /(午休|中午最后一节|下午第一节|午饭前后)/.test(evidence)
        && !targetNames.length) {
        next.intent = 'lunch_protection';
    }

    if (next.intent === 'subject_avoid_periods') {
        const explicitPeriods = unique(next.time?.periods || next.time?.lessonIndexes || []).map(Number);
        if (/(第一节|首节|第1节|上午第一节)/.test(evidence)
            || (explicitPeriods.length === 1 && timeHasPeriod(next.time, 1))) {
            next.intent = 'avoid_first_period';
        } else if (/(最后一节|放学前|末节)/.test(evidence)) {
            next.intent = 'avoid_last_period';
        }
        if (next.intent === 'avoid_first_period' || next.intent === 'avoid_last_period') {
            next.strength = 'soft';
        }
    }

    if (next.intent === 'course_interval') {
        next.params.minGapDays = next.params.minGapDays || next.params.intervalDays || next.params.gapDays || next.params.days || intervalDaysFromEvidence(evidence);
    }
    if (/(该课程|这门课|上述课程)?.{0,12}(实验室|机房|功能室).{0,12}(维修|维护|检修).{0,8}时段/.test(evidence)) {
        next.intent = 'subject_avoid_periods';
        next.targetKind = 'subject';
        next.strength = 'soft';
        markNeedsClarification(next, '请确认维修时段的具体日期、课节以及“该课程”指代的课程。');
    }

    if (/(不能|不可|不要|别).{0,8}既.{0,16}(第一节|首节).{0,16}又.{0,16}(最后一节|末节)/.test(evidence)
        && !['teacher', 'derived_group'].includes(next.targetKind)) {
        next.intent = 'subject_avoid_periods';
        next.targetKind = 'subject';
        next.strength = 'soft';
        const activePeriods = getActivePeriods(project);
        const lastPeriod = activePeriods.length ? Math.max(...activePeriods) : null;
        next.time.periods = [...new Set([
            ...asList(next.time.periods).map(Number).filter(Number.isFinite),
            1,
            ...(Number.isFinite(lastPeriod) ? [lastPeriod] : []),
        ])];
        markNeedsClarification(next, '该约束表示首节和末节不能同时出现；请确认是二选一限制，还是两个时段都尽量避开。');
    }

    if (next.intent === 'subject_spread'
        && /(也|同样|一样).{0,8}错开/.test(evidence)
        && /(不要同一天|不能同一天|别撞一天)/.test(sourceEvidence)) {
        next.intent = 'subject_not_same_day';
        next.targetKind = 'subject';
        markNeedsClarification(next, '请确认“也错开”是要求与前述所有课程都不同天，还是只与其中一门错开。');
    }
    const rawSourceEvidence = text(item.rawText || item.source?.rawText || '', 1500);
    if (/同一天(?:时)?[^。；;]{0,12}(?:不要|不能|不可|别)[^。；;]{0,8}(?:连续|连着|相邻)/.test(evidence)) {
        next.intent = 'subject_not_consecutive_with';
        next.targetKind = 'subject';
        const subjects = knownSubjectNamesFromEvidence(sourceEvidence || evidence);
        if (subjects.length) next.targetNames = subjects;
        markNeedsClarification(next, '请确认两门课程在同一天时需要间隔至少几节。');
    }
    if (/早读/.test(evidence) && /(?:轮流|轮换|交替).{0,12}(?:第一节|首节|第1节)/.test(evidence)) {
        next.intent = 'first_period_assign';
        next.targetKind = 'subject';
        next.targetNames = knownSubjectNamesFromEvidence(sourceEvidence || evidence);
        next.time.periods = [1];
        next.activity = '早读';
        markNeedsClarification(next, '请确认各课程轮流占用第一节的具体日期或轮换规则。');
    }
    if (/大课间/.test(evidence) && /(?:做操|活动|不占|不排)/.test(evidence)) {
        next.intent = 'global_unavailable';
        next.targetKind = 'global';
        next.targetNames = ['全校'];
        next.activity = '大课间';
        markNeedsClarification(next, '请补充大课间对应的具体节次。');
    }
    if (/眼保健操/.test(evidence) && /(?:不排|停排|不占).{0,8}(?:新课|正课|学科课|课程|课)/.test(evidence)) {
        next.intent = 'global_unavailable';
        next.targetKind = 'global';
        next.targetNames = ['全校'];
        next.activity = '眼保健操';
        markNeedsClarification(next, '请补充眼保健操对应的具体节次。');
    }
    if (/(?:尽量|最好).{0,8}(?:排|安排).{0,8}(?:晚自习|自习).{0,4}(?:前一节|前1节)/.test(evidence)) {
        const courseName = (sourceEvidence || evidence).match(/([\p{Script=Han}A-Za-z0-9]{1,12}课)(?:尽量|最好)/u)?.[1] || '';
        next.intent = 'subject_preferred_periods';
        next.targetKind = 'subject';
        if (courseName) next.targetNames = [courseName];
        markNeedsClarification(next, '请明确晚自习对应的具体节次，以确定“前一节”。');
    }
    if (/最多连续[一二两三四五六七八九十\d]+节/.test(evidence) && /下午.{0,8}(?:别|不要|避免).{0,6}(?:连着|连续)/.test(evidence)) {
        next.intent = 'teacher_consecutive_limit';
        next.targetKind = 'teacher';
        next.time.dayPart = 'afternoon';
        const limit = limitFromEvidence(evidence);
        if (limit) { next.params.limit = limit; next.params.maxConsecutive = limit; }
    }
    if (next.intent === 'avoid_last_period' && /(?:周|星期|礼拜)[一二三四五六日天].{0,8}(?:尤其|特别|重点)?(?:不要|不排|避开)?/.test(evidence)) {
        const days = daysFromEvidence(evidence);
        if (days.length) next.time.days = days;
    }
    if (/班会/.test(evidence) && next.targetKind === 'class') {
        next.intent = 'class_unavailable';
        next.activity = '班会';
    }
    if (/校本课/.test(evidence) && /[一二三四五六七八九十]+年级.{0,8}(?:统一|全部|全体).{0,6}(?:占用|安排)/.test(evidence)) {
        next.intent = 'class_unavailable';
        next.targetKind = 'grade';
        next.targetNames = explicitGrade ? [explicitGrade] : next.targetNames;
        next.activity = '校本课';
    }
    if (/周测/.test(evidence) && /普通课.{0,6}(?:停排|不排)/.test(evidence)) {
        next.intent = 'class_unavailable';
        next.targetKind = 'grade';
        next.targetNames = explicitGrade ? [explicitGrade] : next.targetNames;
        next.activity = '周测';
    }
    if (/晨会/.test(evidence)) next.activity = '晨会';
    if (/大课间/.test(evidence)) { next.activity = '大课间'; markNeedsClarification(next, '请补充大课间对应的具体节次。'); }
    if (/眼保健操/.test(evidence)) { next.activity = '眼保健操'; markNeedsClarification(next, '请补充眼保健操对应的具体节次。'); }
    if (next.intent === 'teaching_group_meeting' && /集备|集体备课/.test(evidence)) {
        next.activity = /集备/.test(rawSourceEvidence) ? '集备' : '集体备课';
    }
    if (next.intent === 'locked_slot' && /最后两节|末两节/.test(evidence)) {
        markNeedsClarification(next, '请确认“最后两节”在当前作息中对应的具体节次。');
    }
    if (next.intent === 'first_period_assign' && /轮流|轮换|交替/.test(evidence)) {
        markNeedsClarification(next, '请确认各课程轮流占用第一节的具体日期或轮换规则。');
    }

    if (next.intent === 'room_requirement') {
        const roomNames = unique(next.params.roomNames || next.params.roomName || next.params.rooms || [])
            .map(name => text(normalizeTimetableMarketText(name), 160));
        if (roomNames.length && !next.params.roomName) next.params.roomName = roomNames[0];
        const subjectTargets = unique(next.targetNames || next.targets || next.names || next.target || next.targetName || [])
            .map(name => canonicalRoomSubjectTargetName(name, project));
        next.targetNames = unique([...subjectTargets, ...roomNames]);
        if (/合适(教室|场地|功能室)|合适教室/.test(evidence)) {
            next.needsClarification = true;
            next.confidence = Math.min(confidenceOf(next.confidence), 0.6);
        }
        if (/只有.{0,30}才(?:可以|能).{0,12}(?:使用|占用)/.test(evidence)) {
            markNeedsClarification(
                next,
                '请确认这是实验室的排他使用规则，还是仅表示实验课必须使用实验室；两者的约束方向不同。',
            );
        }
    }
    if (next.intent === 'teacher_gap_preference' || next.intent === 'teacher_load_balance') {
        next.targetKind = 'global';
    }
    if (next.intent === 'teacher_consecutive_limit') {
        const limit = next.params.limit
            || next.params.maxConsecutive
            || next.params.consecutiveLimit
            || limitFromEvidence(fullEvidence);
        if (limit) {
            next.params.limit = limit;
            next.params.maxConsecutive = limit;
        }
    }
    if (next.targetKind === 'subject' && !next.targetNames.length) {
        const inferredSubjects = knownSubjectNamesFromEvidence(fullEvidence);
        if (inferredSubjects.length) next.targetNames = inferredSubjects;
    }

    if (['teacher_unavailable', 'class_unavailable', 'global_unavailable', 'locked_slot', 'subject_daily_limit', 'teacher_weekly_limit', 'teacher_max_days_per_week', 'teacher_mutual_exclusion', 'subject_not_same_day', 'room_requirement', 'teaching_group_meeting', 'teaching_group_session', 'campus_commute_gap'].includes(next.intent)) {
        next.strength = 'hard';
    }
    if (['subject_morning', 'subject_afternoon', 'subject_preferred_periods', 'subject_avoid_periods', 'avoid_first_period', 'avoid_last_period', 'teacher_avoid_periods', 'golden_hour_preference', 'teacher_daily_limit', 'teacher_consecutive_limit', 'subject_spread', 'course_interval', 'class_daily_balance', 'teacher_gap_preference', 'teacher_load_balance', 'subject_sequence', 'block_preference', 'week_pattern', 'lunch_protection'].includes(next.intent)) {
        next.strength = 'soft';
    }

    return applyIntentTargetCompatibility(next);
}

function confidenceOf(value) {
    const confidence = Number(value);
    if (!Number.isFinite(confidence)) return 0.72;
    return Math.max(0, Math.min(1, confidence));
}

function sourceRequirementRawText(source = {}) {
    return text(source?.rawText || source?.source?.rawText || '', 1000);
}

function sourceForIdentity(sourceRequirements = [], identity = {}) {
    const sourceId = text(identity.sourceId, 300);
    const textHash = text(identity.textHash, 128);
    if (sourceId) {
        const byId = sourceRequirements.find(source => source.sourceId === sourceId);
        if (byId && (!textHash || (byId.textHash || byId.source?.textHash) === textHash)) return byId;
        return null;
    }
    if (!textHash) return null;
    const byHash = sourceRequirements.filter(source => (source.textHash || source.source?.textHash) === textHash);
    return byHash.length === 1 ? byHash[0] : null;
}

function mergeTime(left = {}, right = {}) {
    const merged = { ...left, ...right };
    for (const field of ['slots', 'days', 'periods', 'weekdays', 'lessonIndexes']) {
        const values = unique([...asList(left[field]), ...asList(right[field])]);
        if (values.length) merged[field] = ['days', 'periods', 'weekdays', 'lessonIndexes'].includes(field)
            ? values.map(Number).filter(Number.isFinite)
            : values;
    }
    return merged;
}

function semanticTargetTokens(item = {}) {
    return new Set([
        ...unique(item.targetIds || []).map(value => `id:${value}`),
        ...unique(item.targetNames || []).map(value => `name:${normalizeName(value)}`).filter(value => value !== 'name:'),
    ]);
}

function targetsOverlap(left = {}, right = {}) {
    const leftTokens = semanticTargetTokens(left);
    const rightTokens = semanticTargetTokens(right);
    if (!leftTokens.size || !rightTokens.size) return false;
    return [...leftTokens].some(token => rightTokens.has(token));
}

function sourceSemanticKey(item = {}) {
    return item.sourceId || item.textHash || '';
}

function semanticTimeScope(item = {}) {
    const time = item.time && typeof item.time === 'object' ? item.time : {};
    const params = item.params && typeof item.params === 'object' ? item.params : {};
    const slots = unique([...asList(time.slots), ...asList(params.slots)]);
    const days = unique([...asList(time.days), ...asList(time.weekdays), ...asList(params.days)])
        .map(Number)
        .filter(Number.isFinite);
    const periods = unique([...asList(time.periods), ...asList(time.lessonIndexes), ...asList(params.periods)])
        .map(Number)
        .filter(Number.isFinite);
    slots.forEach(slot => {
        const [day, period] = String(slot).split('-').map(Number);
        if (Number.isFinite(day)) days.push(day);
        if (Number.isFinite(period)) periods.push(period);
    });
    return {
        days: [...new Set(days)],
        periods: [...new Set(periods)],
        dayParts: unique([time.dayPart, params.dayPart]),
        scoped: Boolean(slots.length || days.length || periods.length || time.dayPart || params.dayPart),
    };
}

function timeDimensionOverlaps(left = [], right = []) {
    if (!left.length || !right.length) return true;
    const rightSet = new Set(right);
    return left.some(value => rightSet.has(value));
}

function timeScopesOverlap(left = {}, right = {}) {
    const leftScope = semanticTimeScope(left);
    const rightScope = semanticTimeScope(right);
    if (!leftScope.scoped || !rightScope.scoped) {
        return normalizedEvidence(left.evidence || left.rawText || '')
            === normalizedEvidence(right.evidence || right.rawText || '');
    }
    return timeDimensionOverlaps(leftScope.days, rightScope.days)
        && timeDimensionOverlaps(leftScope.periods, rightScope.periods)
        && timeDimensionOverlaps(leftScope.dayParts, rightScope.dayParts);
}

function semanticDuplicateKey(item = {}) {
    return sha256({
        source: sourceSemanticKey(item),
        intent: item.intent,
        targetKind: item.targetKind,
        targetIds: unique(item.targetIds || []).sort(),
        targetNames: unique(item.targetNames || []).map(normalizeName).sort(),
        evidence: normalizedEvidence(item.evidence || item.rawText || ''),
    });
}

function mergeSemanticRequirements(left = {}, right = {}) {
    return {
        ...left,
        ...right,
        time: mergeTime(left.time, right.time),
        params: { ...(left.params || {}), ...(right.params || {}) },
        targetNames: unique([...asList(left.targetNames), ...asList(right.targetNames)]),
        targetIds: unique([...asList(left.targetIds), ...asList(right.targetIds)]),
        needsClarification: Boolean(left.needsClarification || right.needsClarification),
        clarification: right.clarification || left.clarification || null,
        confidence: Math.max(confidenceOf(left.confidence), confidenceOf(right.confidence)),
        parsedBy: unique([...asList(left.parsedBy), ...asList(right.parsedBy)]),
    };
}

const SUBJECT_REFERENCE_PATTERN = /^(该课程|这门课|上述课程|本课程|此课程|它)$/;
const NON_SUBJECT_TARGET_PATTERN = /^(实验室|教室|机房|操场|体育馆|功能室|场地|实验室[AB甲乙]?|计算机教室[AB甲乙]?|物理实验室[AB甲乙]?|化学实验室[AB甲乙]?|生物实验室[AB甲乙]?)$/;

function targetLiteral(value = '') {
    return text(value, 160).replace(/[\s()（）\-_.]/g, '');
}

function concreteSubjectTargetNames(item = {}) {
    return unique(item.targetNames || []).filter(name => (
        !SUBJECT_REFERENCE_PATTERN.test(targetLiteral(name))
        && !NON_SUBJECT_TARGET_PATTERN.test(targetLiteral(name))
    ));
}

function resolveSourceLocalReferences(items = [], warnings = []) {
    const resolved = [];
    for (const rawItem of items) {
        let item = rawItem;
        const sourceKey = sourceSemanticKey(item);
        const evidence = normalizedEvidence(item.evidence || item.rawText || '');
        const names = unique(item.targetNames || []);
        const referenceOnly = item.targetKind === 'subject'
            && (names.length === 0 || names.every(name => SUBJECT_REFERENCE_PATTERN.test(targetLiteral(name))))
            && /(该课程|这门课|上述课程|本课程|此课程|它)/.test(evidence);

        if (sourceKey && referenceOnly) {
            const antecedent = [...resolved].reverse().find(candidate => (
                sourceSemanticKey(candidate) === sourceKey
                && candidate.targetKind === 'subject'
                && concreteSubjectTargetNames(candidate).length
            ));
            if (antecedent) {
                item = {
                    ...item,
                    targetNames: concreteSubjectTargetNames(antecedent),
                    targetIds: unique([...asList(item.targetIds), ...asList(antecedent.targetIds)]),
                };
                warnings.push(`同一来源内已将课程指代继承为“${item.targetNames.join('、')}”（${sourceKey}）。`);
            }
        }

        const repeatedClassActivity = sourceKey
            && item.targetKind === 'class'
            && /(?:同一时间|同一时段|这个时间).{0,8}(?:也)?(?:安排|进行|占用)/.test(evidence);
        if (repeatedClassActivity) {
            const antecedent = [...resolved].reverse().find(candidate => (
                sourceSemanticKey(candidate) === sourceKey
                && candidate.targetKind === 'class'
                && candidate.intent === 'class_unavailable'
                && candidate.activity
            ));
            if (antecedent) {
                item = {
                    ...item,
                    intent: 'class_unavailable',
                    activity: antecedent.activity,
                    time: mergeTime(antecedent.time, item.time),
                    strength: 'hard',
                };
                warnings.push(`同一来源内已将班级“同一时间也安排”继承为 ${antecedent.activity} 活动（${sourceKey}）。`);
            }
        }

        const continuationNotSameDay = sourceKey
            && item.intent === 'subject_not_same_day'
            && /(也|同样|一样).{0,8}(?:尽量)?错开/.test(evidence);
        if (continuationNotSameDay) {
            const antecedentIndex = resolved.findLastIndex(candidate => (
                sourceSemanticKey(candidate) === sourceKey
                && candidate.intent === 'subject_not_same_day'
                && candidate.targetKind === 'subject'
            ));
            if (antecedentIndex >= 0) {
                const merged = mergeSemanticRequirements(resolved[antecedentIndex], item);
                resolved[antecedentIndex] = markNeedsClarification(
                    merged,
                    item.clarification?.question
                        || '请确认“也错开”是要求与前述所有课程都不同天，还是只与其中一门错开。',
                );
                warnings.push(`同一来源内已合并“也错开”的省略表达（${sourceKey}）。`);
                continue;
            }
        }

        resolved.push(item);
    }
    return resolved;
}

function resolveSourceLocalSemanticConflicts(items = [], warnings = []) {
    const referencedItems = resolveSourceLocalReferences(items, warnings);
    const consumedIndexes = new Set();
    const sourceMergedItems = referencedItems.map((item, index) => {
        if (consumedIndexes.has(index) || item.intent !== 'teacher_consecutive_limit') return item;
        const companionIndex = referencedItems.findIndex((candidate, candidateIndex) => (
            candidateIndex !== index
            && !consumedIndexes.has(candidateIndex)
            && ['teacher_avoid_periods', 'teacher_gap_preference', 'unknown'].includes(candidate.intent)
            && sourceSemanticKey(candidate)
            && sourceSemanticKey(candidate) === sourceSemanticKey(item)
            && targetsOverlap(candidate, item)
            && /下午.{0,8}(?:别|不要|避免|最好别).{0,8}(?:连着|连续)/.test(
                normalizedEvidence(candidate.evidence || candidate.rawText || ''),
            )
        ));
        if (companionIndex < 0) return item;

        const companion = referencedItems[companionIndex];
        const merged = mergeSemanticRequirements(companion, item);
        const limit = item.params?.limit
            || item.params?.maxConsecutive
            || limitFromEvidence(normalizedEvidence(item.evidence || item.rawText || ''));
        consumedIndexes.add(companionIndex);
        warnings.push(`同一来源内已将下午连续授课偏好合并到 teacher_consecutive_limit（${item.sourceId || item.textHash}）。`);
        return {
            ...merged,
            intent: 'teacher_consecutive_limit',
            targetKind: 'teacher',
            evidence: item.evidence,
            time: mergeTime(item.time, companion.time),
            params: {
                ...(companion.params || {}),
                ...(item.params || {}),
                ...(limit ? { limit, maxConsecutive: limit } : {}),
            },
        };
    }).filter((_item, index) => !consumedIndexes.has(index));

    const deduped = [];
    const duplicateIndex = new Map();
    for (const item of sourceMergedItems) {
        const key = semanticDuplicateKey(item);
        const existingIndex = duplicateIndex.get(key);
        if (existingIndex !== undefined) {
            deduped[existingIndex] = mergeSemanticRequirements(deduped[existingIndex], item);
            continue;
        }
        duplicateIndex.set(key, deduped.length);
        deduped.push(item);
    }

    return deduped.filter((item, index) => {
        if (!['teacher_avoid_periods', 'avoid_first_period', 'avoid_last_period'].includes(item.intent)) return true;
        const stronger = deduped.find((candidate, candidateIndex) => candidateIndex !== index
            && candidate.intent === 'teacher_unavailable'
            && sourceSemanticKey(candidate)
            && sourceSemanticKey(candidate) === sourceSemanticKey(item)
            && targetsOverlap(candidate, item)
            && timeScopesOverlap(candidate, item));
        if (!stronger) return true;
        warnings.push(`同一来源内教师不可用与弱时段偏好重叠，已优先保留 teacher_unavailable（${item.sourceId || item.textHash}）。`);
        return false;
    });
}

function augmentSourceDerivedRequirements(items = [], warnings = [], { project = {}, sourceRequirements = [] } = {}) {
    const augmented = [...items];
    const groups = new Map();
    items.forEach((item, index) => {
        const key = sourceSemanticKey(item)
            || `text:${normalizedEvidence(item.rawText || item.evidence || '')}`
            || `index:${index}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });

    for (const [sourceKey, group] of groups) {
        const sourceEvidence = normalizedEvidence(group[0]?.rawText || group.map(item => item.evidence).join('。'));
        if (!/(实验室|机房|功能室).{0,12}(维修|维护|检修)/.test(sourceEvidence)
            || !/(实验课|课程|课).{0,8}(避开|不排|不要排)/.test(sourceEvidence)) continue;

        const base = group[0] || {};
        const days = unique(group.flatMap(item => asList(item.time?.days)).concat(daysFromEvidence(sourceEvidence))).map(Number);
        const existingSubjectNames = unique(group.flatMap(item => concreteSubjectTargetNames(item)));
        const inferredSubjectNames = existingSubjectNames.length
            ? existingSubjectNames
            : [canonicalRoomSubjectTargetName('实验课', project)];
        const roomNames = sourceEvidence.includes('机房') ? ['机房']
            : sourceEvidence.includes('功能室') ? ['功能室'] : ['实验室'];
        const clarification = {
            question: '请确认维修影响的具体房间、课节，以及需要避开的实验课程范围。',
        };
        group.filter(item => ['room_requirement', 'subject_avoid_periods'].includes(item.intent)).forEach(item => {
            markNeedsClarification(item, clarification.question);
            item.activity = item.activity || `${roomNames[0]}维修`;
        });

        if (!group.some(item => item.intent === 'room_requirement')) {
            augmented.push({
                ...base,
                id: `${base.id || 'ai_req'}_maintenance_room`,
                intent: 'room_requirement',
                targetKind: 'subject',
                targetNames: unique([...inferredSubjectNames, ...roomNames]),
                targetIds: [],
                strength: 'hard',
                time: { ...(base.time || {}), ...(days.length ? { days } : {}) },
                params: { roomName: roomNames[0], roomNames },
                confidence: Math.min(confidenceOf(base.confidence), 0.55),
                needsClarification: true,
                clarification,
                activity: `${roomNames[0]}维修`,
                evidence: sourceEvidence,
                notes: '由同一来源中的场地维修与课程避开双向语义补全。',
            });
            warnings.push(`已为场地维修语句补全 room_requirement 复核项（${sourceKey}）。`);
        }
        if (!group.some(item => item.intent === 'subject_avoid_periods')) {
            augmented.push({
                ...base,
                id: `${base.id || 'ai_req'}_maintenance_avoid`,
                intent: 'subject_avoid_periods',
                targetKind: 'subject',
                targetNames: inferredSubjectNames,
                targetIds: [],
                strength: 'soft',
                time: { ...(base.time || {}), ...(days.length ? { days } : {}) },
                params: {},
                confidence: Math.min(confidenceOf(base.confidence), 0.55),
                needsClarification: true,
                clarification,
                activity: `${roomNames[0]}维修`,
                evidence: sourceEvidence,
                notes: '由同一来源中的场地维修与课程避开双向语义补全。',
            });
            warnings.push(`已为场地维修语句补全 subject_avoid_periods 复核项（${sourceKey}）。`);
        }
    }
    for (const [sourceKey, group] of groups) {
        const sourceEvidence = normalizedEvidence(group[0]?.rawText || group.map(item => item.evidence).join('。'));
        if (!TEACHING_GROUP_MEETING_PATTERN.test(sourceEvidence)) continue;

        const base = group.slice().sort((left, right) => confidenceOf(right.confidence) - confidenceOf(left.confidence))[0] || {};
        const groupNames = teachingGroupNamesFromEvidence(sourceEvidence);
        const days = daysFromEvidence(sourceEvidence);
        const dayParts = unique([
            /上午/.test(sourceEvidence) ? 'morning' : '',
            /下午|午后/.test(sourceEvidence) ? 'afternoon' : '',
        ]);
        const time = {
            ...(base.time || {}),
            ...(days.length ? { days } : {}),
            ...(dayParts.length === 1 ? { dayPart: dayParts[0] } : {}),
        };
        const activity = /集备|集体备课/.test(sourceEvidence) ? '集备' : '教研';
        if (!group.some(item => item.intent === 'teaching_group_meeting')) {
            augmented.push({
                ...base,
                id: `${base.id || 'ai_req'}_teaching_group_meeting`,
                intent: 'teaching_group_meeting',
                targetKind: 'teaching_group',
                targetNames: groupNames,
                targetIds: [],
                strength: 'hard',
                time,
                activity,
                evidence: sourceEvidence,
            });
        }

        const blocksGroupTeachers = /(?:组内|该组|全组).{0,8}(?:老师|教师).{0,8}(?:不要排|不排|不能排)|(?:课程|课).{0,8}(?:不要排|不排|避开).{0,8}(?:这个|该|同一)?时间/.test(sourceEvidence);
        if (blocksGroupTeachers && !group.some(item => item.intent === 'teacher_unavailable')) {
            augmented.push({
                ...base,
                id: `${base.id || 'ai_req'}_teaching_group_unavailable`,
                intent: 'teacher_unavailable',
                targetKind: 'derived_group',
                targetNames: groupNames,
                targetIds: [],
                strength: 'hard',
                time,
                activity,
                confidence: Math.min(confidenceOf(base.confidence), 0.75),
                needsClarification: true,
                clarification: { question: '请确认该备课组包含的教师范围。' },
                evidence: sourceEvidence,
                notes: '由同一来源中的备课组会议及对应时段停排语义补全。',
            });
        }
        warnings.push(`已按备课组会议语义核对组内教师停排约束（${sourceKey}）。`);
    }
    for (const [sourceKey, group] of groups) {
        const sourceEvidence = normalizedEvidence(group[0]?.rawText || group.map(item => item.evidence).join('。'));
        const teacherItems = group.filter(item => item.intent === 'teacher_unavailable');
        const dayPartMatches = [...sourceEvidence.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])(?:的)?(上午|下午)[^，,。；;]{0,16}(?:不排|不要排|没空|不能排)/g)];
        const sourceTeachers = teacherNamesFromEvidence(sourceEvidence);
        if (!teacherItems.length || dayPartMatches.length < 2 || sourceTeachers.length > 1) continue;

        const dayMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
        const expectedScopes = dayPartMatches.map(match => ({
            day: dayMap[match[1]],
            dayPart: match[2] === '上午' ? 'morning' : 'afternoon',
        }));
        const alreadySplit = expectedScopes.every(scope => teacherItems.some(item => {
            const itemDays = asList(item.time?.days).map(Number);
            return itemDays.length === 1 && itemDays[0] === scope.day && item.time?.dayPart === scope.dayPart;
        }));
        if (alreadySplit) continue;

        const base = teacherItems.slice().sort((left, right) => confidenceOf(right.confidence) - confidenceOf(left.confidence))[0];
        teacherItems.forEach(item => {
            const itemIndex = augmented.indexOf(item);
            if (itemIndex >= 0) augmented.splice(itemIndex, 1);
        });
        dayPartMatches.forEach((match, index) => {
            augmented.push({
                ...base,
                id: `${base.id || 'ai_req'}_daypart_${index + 1}`,
                targetNames: sourceTeachers.length === 1 ? sourceTeachers : base.targetNames,
                time: {
                    days: [dayMap[match[1]]],
                    dayPart: match[2] === '上午' ? 'morning' : 'afternoon',
                },
                evidence: match[0],
            });
        });
        warnings.push(`同一来源内已将多个教师半天不可用时段拆分为独立 clause（${sourceKey}）。`);
    }

    for (const sourceRequirement of asList(sourceRequirements)) {
        const rawText = sourceRequirementRawText(sourceRequirement);
        const normalizedText = normalizedEvidence(rawText);
        if (!/(?:音乐、体育、美术、信息技术|音乐体育美术信息技术).{0,12}(?:别占|不占|避开|不要占).{0,8}黄金时段/.test(normalizedText)) continue;
        const sourceId = sourceRequirement.sourceId || sourceRequirement.source?.sourceId || '';
        const textHash = sourceRequirement.textHash || sourceRequirement.source?.textHash || '';
        const hasMatching = augmented.some(item => (sourceId && item.sourceId === sourceId) || (textHash && item.textHash === textHash));
        if (hasMatching) continue;
        augmented.push({
            id: 'ai_req_market_subject_avoid_' + (sourceId || textHash || augmented.length),
            sourceId, textHash,
            origin: sourceRequirement.origin || 'user_input',
            parsedBy: unique([...asList(sourceRequirement.parsedBy), 'local_semantic_firewall']),
            lineNumber: sourceRequirement.lineNumber || sourceRequirement.source?.lineNumber || null,
            rawText,
            intent: 'subject_avoid_periods', targetKind: 'subject',
            targetNames: ['音乐', '体育', '美术', '信息技术'], targetIds: [],
            strength: 'soft', time: {}, params: {}, confidence: 0.55,
            needsClarification: true,
            clarification: { question: '请确认“黄金时段”在当前作息中对应的具体节次。' },
            evidence: normalizedText, activity: '',
            notes: 'AI 漏项后由通用市场术语语义防火墙补全。',
        });
        warnings.push('AI 未返回音体美信黄金时段约束，已补全待确认项。');
    }
    return augmented;
}

export function validateExtractionPayload(payload = {}, { sourceRequirements = [], project = {} } = {}) {
    const parsed = parseJsonContent(payload);
    const warnings = [];
    const unrecognized = [];
    let rawRequirements = [];

    if (Object.prototype.hasOwnProperty.call(parsed, 'results')) {
        const seenResultSources = new Set();
        asList(parsed.results).forEach((result, resultIndex) => {
            if (!result || typeof result !== 'object') {
                warnings.push(`第 ${resultIndex + 1} 个 AI source result 不是对象，已忽略。`);
                return;
            }
            const sourceIdentity = {
                sourceId: text(result.sourceId || result.source?.sourceId, 300),
                textHash: text(result.textHash || result.source?.textHash, 128),
                sourceSheet: text(result.sourceSheet || result.source?.sourceSheet || result.source?.sheetName, 160),
                sourceRow: result.sourceRow ?? result.source?.sourceRow ?? result.source?.rowNumber ?? null,
                lineNumber: result.lineNumber ?? result.source?.lineNumber ?? null,
            };
            if (sourceIdentity.sourceId && seenResultSources.has(sourceIdentity.sourceId)) {
                warnings.push(`AI 对 sourceId ${sourceIdentity.sourceId} 返回了多个顶层 result，已按 clause 合并处理。`);
            }
            if (sourceIdentity.sourceId) seenResultSources.add(sourceIdentity.sourceId);
            const matchedSource = sourceForIdentity(sourceRequirements, sourceIdentity);
            const resultRawText = text(
                result.rawText || result.text || result.source?.rawText || sourceRequirementRawText(matchedSource),
                1000,
            );
            const clauses = result.clauses !== undefined
                ? asList(result.clauses)
                : asList(result.requirements);
            clauses.forEach(clause => {
                if (!clause || typeof clause !== 'object') {
                    warnings.push(`第 ${resultIndex + 1} 个 AI source result 含非对象 clause，已忽略。`);
                    return;
                }
                rawRequirements.push({
                    ...clause,
                    ...sourceIdentity,
                    rawText: text(resultRawText || clause.rawText || clause.source?.rawText, 1000),
                    origin: 'unknown',
                    parsedBy: ['ai'],
                });
            });
            if (!clauses.length) {
                const sourceText = resultRawText;
                if (isSchedulingDomainText(sourceText)) {
                    rawRequirements.push({
                        ...sourceIdentity,
                        rawText: sourceText,
                        intent: 'unknown',
                        targetKind: 'unknown',
                        targetNames: [],
                        strength: 'soft',
                        confidence: 0.35,
                        needsClarification: true,
                        clarification: {
                            question: '请说明希望优化的具体对象、时段、数量或排课指标。',
                        },
                        evidence: sourceText,
                        notes: text(result.reason || '排课领域输入缺少可执行的具体目标。', 500),
                        origin: 'unknown',
                        parsedBy: ['ai'],
                    });
                    warnings.push(`第 ${resultIndex + 1} 个 AI source result 属于排课领域但语义不完整，已保留为 unknown 并请求澄清。`);
                } else if (result.unrecognized || result.reason) {
                    unrecognized.push({
                        ...sourceIdentity,
                        text: sourceText,
                        reason: text(result.reason || 'AI 未识别该输入。', 500),
                        parsedBy: ['ai'],
                    });
                }
            }
            warnings.push(...unique(result.warnings || []));
        });
    } else {
        rawRequirements = parsed.requirements !== undefined
            ? asList(parsed.requirements)
            : asList(parsed.items);
        unrecognized.push(...asList(parsed.unrecognized));
    }

    const requirements = [];
    rawRequirements.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            warnings.push(`第 ${index + 1} 条 AI 结果不是对象，已忽略。`);
            return;
        }
        const canonical = canonicalizeRequirement(item, { project });
        const intent = normalizeIntent(canonical.intent || canonical.type);
        const evidence = text(canonical.evidence || canonical.rawText || canonical.text || canonical.reason || canonical.description, 1000);
        if (intent === 'unknown') {
            warnings.push(`第 ${index + 1} 条 AI 结果 intent 不在目录内，已转人工复核。`);
        }
        requirements.push({
            id: text(canonical.id, 120) || `ai_req_${index + 1}`,
            sourceId: text(canonical.sourceId || canonical.source?.sourceId, 300),
            textHash: text(canonical.textHash || canonical.source?.textHash, 128),
            origin: canonical.origin || 'unknown',
            parsedBy: unique([...asList(canonical.parsedBy), 'ai']),
            sourceSheet: text(canonical.sourceSheet || canonical.source?.sourceSheet || canonical.source?.sheetName, 160),
            sourceRow: canonical.sourceRow ?? canonical.source?.sourceRow ?? canonical.source?.rowNumber ?? null,
            lineNumber: canonical.lineNumber ?? canonical.source?.lineNumber ?? null,
            rawText: text(canonical.rawText || canonical.source?.rawText || '', 1000),
            intent,
            targetKind: text(canonical.targetKind || canonical.targetType || 'unknown', 80).toLowerCase(),
            targetNames: unique(canonical.targetNames || canonical.targets || canonical.names || canonical.target || canonical.targetName || []),
            targetIds: unique(canonical.targetIds || canonical.ids || canonical.targetId || []),
            strength: /hard|硬|必须|不能|不可|固定/.test(text(canonical.strength || canonical.priority, 80).toLowerCase()) ? 'hard' : 'soft',
            time: canonical.time && typeof canonical.time === 'object' ? canonical.time : {},
            params: canonical.params && typeof canonical.params === 'object' ? canonical.params : canonical.parameters && typeof canonical.parameters === 'object' ? canonical.parameters : {},
            confidence: confidenceOf(canonical.confidence),
            needsClarification: Boolean(canonical.needsClarification || canonical.clarify),
            clarification: canonical.clarification && typeof canonical.clarification === 'object' ? canonical.clarification : null,
            evidence,
            activity: text(canonical.activity || canonical.params?.activity || '', 160),
            exceptions: unique(canonical.exceptions || canonical.params?.exceptions || canonical.params?.excludeSubjects || [])
                .map(value => text(value, 160).replace(/^[，,、；;：:\s]+|[，,、；;：:\s]+$/g, ''))
                .filter(Boolean),
            notes: text(canonical.notes || canonical.reason || '', 500),
        });
    });

    const augmentedRequirements = augmentSourceDerivedRequirements(requirements, warnings, { project, sourceRequirements });
    const conflictResolvedRequirements = resolveSourceLocalSemanticConflicts(augmentedRequirements, warnings);
    const alignedRequirements = sourceRequirements.length
        ? alignAiArtifactsToSources(conflictResolvedRequirements, sourceRequirements, {
            artifactKind: 'requirement',
            parsedBy: 'ai',
            allowLegacyEvidence: true,
        })
        : { artifacts: conflictResolvedRequirements, rejected: [], warnings: [] };
    const alignedUnrecognized = sourceRequirements.length
        ? alignAiArtifactsToSources(unrecognized, sourceRequirements, {
            artifactKind: 'unrecognized',
            parsedBy: 'ai',
            allowLegacyEvidence: true,
        })
        : { artifacts: unrecognized, rejected: [], warnings: [] };
    const alignmentWarnings = [...alignedRequirements.warnings, ...alignedUnrecognized.warnings];

    return {
        requirements: alignedRequirements.artifacts,
        unrecognized: alignedUnrecognized.artifacts,
        warnings: [...warnings, ...unique(parsed.warnings || []), ...alignmentWarnings.map(item => item.message)],
        warningItems: alignmentWarnings,
        rejected: [...alignedRequirements.rejected, ...alignedUnrecognized.rejected],
    };
}

function entityLabel(item = {}, kind = '') {
    if (kind === 'class') return [item.grade, item.name].filter(Boolean).join('') || item.name || item.id || '';
    return item.name || item.label || item.id || '';
}

function entityAliases(item = {}, kind = '') {
    return unique([
        item.id,
        item.name,
        item.label,
        entityLabel(item, kind),
        ...asList(item.aliases),
    ]);
}

function matchEntities(items = [], names = [], kind = '') {
    const result = [];
    const unresolved = [];
    const ambiguous = [];
    const seen = new Set();
    for (const name of unique(names)) {
        if (!name) continue;
        if (/^(全部|所有|全体|每位|每个|各位|任课|all)\s*(教师|老师|teachers?)?$/i.test(name)) {
            result.push({ id: '__all__', name, all: true });
            continue;
        }
        const normalized = normalizeName(name);
        const exact = items.filter(item => entityAliases(item, kind).some(alias => alias === name || normalizeName(alias) === normalized));
        const contains = exact.length ? exact : items.filter(item => {
            const aliases = entityAliases(item, kind).map(normalizeName).filter(Boolean);
            return aliases.some(alias => alias && normalized && (alias.includes(normalized) || normalized.includes(alias)));
        });
        if (contains.length === 1) {
            const item = contains[0];
            if (!seen.has(item.id)) {
                seen.add(item.id);
                result.push({ id: item.id, name: entityLabel(item, kind), item });
            }
        } else if (contains.length > 1) {
            ambiguous.push({
                name,
                kind,
                candidates: contains.map(item => ({ id: item.id, label: entityLabel(item, kind) })),
            });
        } else {
            unresolved.push({ name, kind });
        }
    }
    return { matches: result, unresolved, ambiguous };
}

function subjectTeachers(project = {}, subjectIds = []) {
    const ids = [];
    for (const subjectId of subjectIds) {
        (project.lessonPlans || []).forEach(plan => {
            if (plan.subjectId !== subjectId) return;
            ids.push(plan.teacherId, ...asList(plan.teacherIds));
        });
        (project.teachers || []).forEach(teacher => {
            if (asList(teacher.subjects).includes(subjectId)) ids.push(teacher.id);
        });
    }
    return unique(ids);
}

function inferTargetKind(intent = '', targetKind = '') {
    const kind = targetKind && targetKind !== 'unknown' ? targetKind : '';
    if (kind) return kind;
    if (intent.startsWith('teacher_')) return 'teacher';
    if (intent.startsWith('class_')) return 'class';
    if (intent.startsWith('subject_') || ['avoid_first_period', 'avoid_last_period', 'course_interval', 'room_requirement', 'first_period_assign', 'golden_hour_preference'].includes(intent)) return 'subject';
    if (['teaching_group_meeting', 'teaching_group_session'].includes(intent)) return 'teaching_group';
    if (['global_unavailable', 'lunch_protection', 'teacher_load_balance', 'teacher_gap_preference', 'class_daily_balance'].includes(intent)) return 'global';
    return 'global';
}

function slotsFromTime(project = {}, time = {}, params = {}) {
    const explicitSlots = unique(time.slots || params.slots || params.slotKeys || []);
    if (explicitSlots.length) return explicitSlots.filter(slot => /^\d{1,2}-\d{1,2}$/.test(slot));
    const activeDays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    const days = unique(time.days || time.weekdays || params.days || []).map(Number).filter(day => activeDays.includes(day));
    let periods = unique(time.periods || time.lessonIndexes || params.periods || []).map(Number).filter(period => activePeriods.includes(period));
    const dayPart = text(time.dayPart || params.dayPart || '', 40);
    if (!periods.length && dayPart) {
        periods = getDayPartPeriods(project, dayPart === 'all_day' ? '' : dayPart);
    }
    if (!periods.length) return [];
    const effectiveDays = days.length ? days : activeDays;
    return effectiveDays.flatMap(day => periods.map(period => slotKey(day, period)));
}

function optionClarification(id = '', field = '', question = '', options = []) {
    return {
        id: `clarify_${id}_${field}`,
        kind: options.length ? 'choice' : 'text',
        field,
        question,
        options,
    };
}

function buildResolvedRequirement(project = {}, requirement = {}) {
    const intent = requirement.intent;
    const targetKind = inferTargetKind(intent, requirement.targetKind);
    const params = { ...(requirement.params || {}) };
    const warnings = [];
    const slots = slotsFromTime(project, requirement.time, params);
    const targetIds = unique(requirement.targetIds || []);
    const targetNames = unique(requirement.targetNames || []);
    const baseNames = unique([
        ...targetNames,
        ...asList(params.subjectNames),
        ...asList(params.teacherNames),
        ...asList(params.classNames),
    ]);
    let object = { kind: targetKind, name: baseNames.join('、') || '全局', matchedIds: [], scope: 'explicit' };
    let clarification = requirement.clarification;
    let status = requirement.needsClarification || requirement.confidence < 0.6 ? 'needs_review' : 'actionable';

    if (targetKind === 'global') {
        object = { kind: 'global', name: baseNames.join('、') || '全局', matchedIds: [], scope: 'global' };
    } else if (targetKind === 'teacher') {
        const names = unique([...targetIds, ...baseNames, ...asList(params.teacherIds)]);
        const allTeachers = names.some(name => /全部|所有|全体|每位|每个|all\s*teachers?/i.test(name));
        if (allTeachers) {
            params.teacherIds = (project.teachers || []).map(teacher => teacher.id);
            object = { kind: 'teacher_group', name: '全部教师', matchedIds: params.teacherIds, scope: 'global' };
        } else {
            const resolved = matchEntities(project.teachers || [], names, 'teacher');
            params.teacherIds = resolved.matches.map(item => item.id);
            object = { kind: 'teacher', name: resolved.matches.map(item => item.name).join('、') || names.join('、'), matchedIds: params.teacherIds, scope: 'explicit' };
            if (resolved.unresolved.length || resolved.ambiguous.length) {
                status = 'needs_review';
                warnings.push(...resolved.unresolved.map(item => `未找到教师：${item.name}`));
                resolved.ambiguous.forEach(item => warnings.push(`${item.name} 匹配到多位教师，请确认。`));
                const ambiguous = resolved.ambiguous[0];
                clarification = ambiguous ? optionClarification(requirement.id, 'teacherId', `你说的${ambiguous.name}是哪位老师？`, ambiguous.candidates.map(candidate => ({ label: candidate.label, value: candidate.id }))) : clarification;
            }
        }
    } else if (targetKind === 'class') {
        const names = unique([...targetIds, ...baseNames, ...asList(params.classIds)]);
        const resolved = matchEntities(project.classes || [], names, 'class');
        params.classIds = resolved.matches.map(item => item.id);
        object = { kind: 'class', name: resolved.matches.map(item => item.name).join('、') || names.join('、'), matchedIds: params.classIds, scope: 'explicit' };
        if (resolved.unresolved.length || resolved.ambiguous.length) {
            status = 'needs_review';
            warnings.push(...resolved.unresolved.map(item => `未找到班级：${item.name}`));
        }
    } else if (targetKind === 'subject' || targetKind === 'teaching_group') {
        const names = unique([...targetIds, ...baseNames, ...asList(params.subjectIds)]);
        const configuredRoomNames = unique(params.roomNames || params.roomName || params.rooms || []);
        const subjectNames = targetKind === 'teaching_group'
            ? names.map(name => name.replace(/教研组|备课组|组/g, ''))
            : intent === 'room_requirement'
                ? names.filter(name => !configuredRoomNames.some(roomName => normalizeName(roomName) === normalizeName(name)))
                : names;
        const resolved = matchEntities(project.subjects || [], subjectNames, 'subject');
        params.subjectIds = resolved.matches.map(item => item.id);
        object = { kind: targetKind === 'teaching_group' ? 'teaching_group' : 'subject', name: resolved.matches.map(item => item.name).join('、') || names.join('、'), matchedIds: params.subjectIds, scope: 'explicit' };
        if (targetKind === 'teaching_group') {
            params.teacherIds = subjectTeachers(project, params.subjectIds);
            object.matchedIds = params.teacherIds;
            object.name = `${object.name || names.join('、')}教研组`;
        }
        if (resolved.unresolved.length || resolved.ambiguous.length || (targetKind === 'teaching_group' && !params.teacherIds.length)) {
            status = 'needs_review';
            warnings.push(...resolved.unresolved.map(item => `未找到课程：${item.name}`));
            if (targetKind === 'teaching_group' && !params.teacherIds.length) warnings.push('没有找到该教研组对应教师。');
        }
    }

    if (intent === 'room_requirement') {
        const roomNames = unique(params.roomNames || params.roomName || params.rooms || []);
        const resolvedRooms = matchEntities(project.rooms || [], roomNames, 'room');
        params.roomIds = resolvedRooms.matches.map(item => item.id);
        params.roomName = roomNames[0] || '';
        params.requiredTags = unique(params.requiredTags || (params.roomName ? [params.roomName] : []));
    }

    if (slots.length) params.slots = slots;
    const sourceId = requirement.sourceId || requirement.source?.sourceId || '';
    const textHash = requirement.textHash || requirement.source?.textHash || '';
    const origin = requirement.origin || requirement.source?.origin || 'unknown';
    const parsedBy = unique([...asList(requirement.parsedBy), ...asList(requirement.source?.parsedBy), 'ai']);
    const sourceSheet = requirement.sourceSheet || requirement.source?.sourceSheet || requirement.source?.sheetName || '';
    const sourceRow = requirement.sourceRow ?? requirement.source?.sourceRow ?? requirement.source?.rowNumber ?? null;
    const lineNumber = requirement.lineNumber ?? requirement.source?.lineNumber ?? null;
    const rawText = requirement.rawText || requirement.source?.rawText || requirement.evidence || requirement.notes || '';
    const source = {
        sourceId,
        textHash,
        rawText,
        sourceSheet,
        sourceRow,
        lineNumber,
        origin,
        parsedBy,
        parseSource: 'ai_extract',
    };
    return {
        id: requirement.id,
        sourceId,
        textHash,
        origin,
        parsedBy,
        sourceSheet,
        sourceRow,
        lineNumber,
        rawText,
        object,
        intent,
        condition: requirement.time || {},
        parameters: params,
        strength: requirement.strength,
        status,
        applyTo: status === 'actionable' ? 'rule' : 'review',
        confidence: requirement.confidence,
        source,
        warnings,
        clarification,
        reviewedParseSource: 'ai_extract',
        reviewEvidence: requirement.evidence ? { quote: requirement.evidence, reason: 'AI-first 结构化抽取' } : null,
    };
}

function first(values = []) {
    return unique(values)[0] || '';
}

function rowBase(requirement = {}, index = 0) {
    const requirementSource = requirement.source && typeof requirement.source === 'object' ? requirement.source : {};
    return {
        id: `ai_${requirement.id || index + 1}`,
        requirementId: requirement.id || '',
        sourceId: requirement.sourceId || requirementSource.sourceId || '',
        textHash: requirement.textHash || requirementSource.textHash || '',
        origin: requirement.origin || requirementSource.origin || 'unknown',
        parsedBy: unique([...asList(requirement.parsedBy), ...asList(requirementSource.parsedBy), 'ai']),
        sourceSheet: requirement.sourceSheet || requirementSource.sourceSheet || requirementSource.sheetName || '',
        sourceRow: requirement.sourceRow ?? requirementSource.sourceRow ?? requirementSource.rowNumber ?? null,
        lineNumber: requirement.lineNumber ?? requirementSource.lineNumber ?? null,
        rawText: requirement.rawText || requirementSource.rawText || '',
        source: 'ai_extract',
        parseSource: 'ai_extract',
        priority: requirement.strength || 'soft',
        status: requirement.status === 'actionable' ? 'effective' : 'needs_review',
        confidence: requirement.confidence ?? 0.72,
        warnings: requirement.warnings || [],
    };
}

function rowsForRequirement(requirement = {}, index = 0) {
    if (requirement.status !== 'actionable') return [];
    const intent = requirement.intent;
    const p = requirement.parameters || {};
    const row = rowBase(requirement, index);
    const subjectIds = unique(p.subjectIds || requirement.object?.matchedIds || []);
    const teacherIds = unique(p.teacherIds || requirement.object?.matchedIds || []);
    const classIds = unique(p.classIds || requirement.object?.matchedIds || []);
    const slots = unique(p.slots || []);
    if (intent === 'teacher_unavailable') return teacherIds.map((teacherId, itemIndex) => ({ ...row, id: `${row.id}_${itemIndex + 1}`, type: 'teacher_unavailable', targetType: 'teacher', targetId: teacherId, slots, priority: 'hard' }));
    if (intent === 'class_unavailable') return classIds.map((classId, itemIndex) => ({ ...row, id: `${row.id}_${itemIndex + 1}`, type: 'class_unavailable', targetType: 'class', targetId: classId, slots, priority: 'hard' }));
    if (intent === 'global_unavailable') return [{ ...row, type: 'global_unavailable', targetType: 'global', targetName: '全校', slots, priority: 'hard' }];
    if (intent === 'locked_slot') return [{ ...row, type: 'locked_slot', targetType: 'locked_slot', classId: first(classIds), subjectId: first(subjectIds), teacherId: first(teacherIds), slots, priority: 'hard' }];
    if (intent === 'subject_morning') return subjectIds.map(subjectId => ({ ...row, type: 'subject_morning', targetType: 'subject', targetId: subjectId, priority: 'soft' }));
    if (intent === 'subject_afternoon') return subjectIds.map(subjectId => ({ ...row, type: 'subject_afternoon', targetType: 'subject', targetId: subjectId, priority: 'soft' }));
    if (intent === 'subject_preferred_periods') return subjectIds.map(subjectId => ({ ...row, type: 'subject_preferred_periods', targetType: 'subject', targetId: subjectId, slots, priority: 'soft' }));
    if (intent === 'subject_avoid_periods') return subjectIds.map(subjectId => ({ ...row, type: 'subject_avoid_periods', targetType: 'subject', targetId: subjectId, slots, priority: 'soft' }));
    if (intent === 'subject_spread') return subjectIds.map(subjectId => ({ ...row, type: 'subject_spread', targetType: 'subject', targetId: subjectId, priority: 'soft' }));
    if (intent === 'course_interval') return subjectIds.map(subjectId => ({ ...row, type: 'course_interval', targetType: 'subject', targetId: subjectId, minGapDays: p.minGapDays || p.gapDays || p.days || 1, priority: 'soft' }));
    if (intent === 'subject_daily_limit') return subjectIds.map(subjectId => ({ ...row, type: 'subject_daily_limit', targetType: 'subject', targetId: subjectId, limit: p.limit || p.maxPerDay || p.max || 1, priority: 'hard' }));
    if (intent === 'teacher_daily_limit' || intent === 'teacher_consecutive_limit' || intent === 'teacher_weekly_limit' || intent === 'teacher_max_days_per_week') {
        const targetIds = teacherIds.length ? teacherIds : ['__all_teachers'];
        return targetIds.map(teacherId => ({ ...row, type: intent, targetType: teacherId === '__all_teachers' ? 'all_teachers' : 'teacher', targetId: teacherId, targetName: teacherId === '__all_teachers' ? '全部教师' : '', limit: p.limit || p.max || p.maxPerDay || p.maxConsecutive || p.maxDays || 1, priority: intent.includes('weekly') || intent.includes('max_days') ? 'hard' : 'soft' }));
    }
    if (intent === 'teacher_mutual_exclusion') return [{ ...row, type: 'teacher_mutual_exclusion', targetType: 'global', teacherIds, priority: 'hard' }];
    if (intent === 'subject_not_same_day') return [{ ...row, type: 'subject_not_same_day', targetType: 'global', subjectIds, classIds, priority: 'hard' }];
    if (intent === 'subject_sequence') return [{ ...row, type: 'subject_sequence', targetType: 'global', beforeSubjectId: p.beforeSubjectId || subjectIds[0] || '', afterSubjectId: p.afterSubjectId || subjectIds[1] || '', subjectIds, classIds, priority: 'soft' }];
    if (intent === 'room_requirement') return subjectIds.map(subjectId => ({ ...row, type: 'room_requirement', targetType: 'subject', targetId: subjectId, roomIds: p.roomIds || [], roomName: p.roomName || '', requiredTags: p.requiredTags || [], priority: 'hard' }));
    if (intent === 'class_daily_balance') return [{ ...row, type: 'class_daily_balance', targetType: 'global', targetName: '全部班级', limit: p.mainSubjectDailyMax || p.limit || 0, priority: 'soft' }];
    if (intent === 'teacher_gap_preference') return [{ ...row, type: 'teacher_gap_preference', targetType: 'global', targetName: '全部教师', weight: p.weight || 1, priority: 'soft' }];
    if (intent === 'teacher_load_balance') return [{ ...row, type: 'teacher_load_balance', targetType: 'global', targetName: '全部教师', weight: p.weight || 1, priority: 'soft' }];
    return [];
}

export function resolveEntityRefs(projectInput = {}, requirements = []) {
    const project = normalizeTimetableProject(projectInput);
    const semanticRequirements = requirements.map(item => buildResolvedRequirement(project, item));
    const draftRows = semanticRequirements.flatMap((requirement, index) => rowsForRequirement(requirement, index));
    return { semanticRequirements, draftRows };
}

export async function extractRequirementsWithAI({
    project: inputProject = {},
    text: inputText = '',
    contextStats = null,
    sourceRequirements: inputSourceRequirements = [],
    env = {},
    fetchImpl = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const rawRequestText = String(inputText ?? '').replace(/^\uFEFF/, '').slice(0, 20_000).trim();
    const requestText = text(rawRequestText, 20_000);
    const sourceRequirements = normalizedExtractionSources(inputSourceRequirements, rawRequestText);
    if (!requestText) throw new TimetableAiExtractionError('AI-first 抽取文本为空。', 'empty_prompt', 400);
    const { apiKey, baseUrl, model } = resolveAiConfig(env);
    const fetchClient = resolveFetch(fetchImpl);
    const sentences = splitRequirementSentences(rawRequestText);
    if (sourceRequirements.length > BATCH_SENTENCE_THRESHOLD) {
        const chunks = chunkValues(sourceRequirements);
        const concurrency = Math.max(1, Math.min(
            Number.parseInt(env.TIMETABLE_RULE_AI_BATCH_CONCURRENCY, 10) || 3,
            chunks.length,
        ));
        const results = await mapWithConcurrency(chunks, concurrency, (chunk, index) => extractRequirementsWithAISingle({
            project,
            requestText: chunk.map(source => source.source?.rawText || '').filter(Boolean).join('\n'),
            sourceRequirements: chunk,
            contextStats: {
                ...(contextStats || {}),
                batchIndex: index + 1,
                batchCount: chunks.length,
                batchSourceCount: chunk.length,
            },
            env,
            fetchClient,
            apiKey,
            baseUrl,
            model,
        }));
        const merged = mergeBatchExtractionResults(project, results, sentences.length, concurrency);
        void recordConstraintMetric({
            phase: 'ai',
            success: true,
            requirementCount: merged.rawRequirements.length,
            ai: {
                model,
                promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
                cacheHit: false,
                batchChunkCount: merged.batch.chunkCount,
                batchSentenceCount: merged.batch.sentenceCount,
                batchCacheHitCount: merged.batch.cacheHitCount,
            },
        });
        return merged;
    }
    return extractRequirementsWithAISingle({
        project,
        requestText,
        sourceRequirements,
        contextStats,
        env,
        fetchClient,
        apiKey,
        baseUrl,
        model,
    });
}

async function extractRequirementsWithAISingle({
    project = {},
    requestText = '',
    sourceRequirements = [],
    contextStats = null,
    env = {},
    fetchClient,
    apiKey = '',
    baseUrl = '',
    model = '',
} = {}) {
    const { project: promptProject, pruned } = pruneProjectEntitiesForPrompt(project, requestText);
    const sourceInputs = sourceRequirementsToAiInputs(sourceRequirements);
    const cacheKey = buildCacheKey({ model, requestText, promptProject, contextStats, sourceInputs });
    if (cacheEnabled(env)) {
        const cached = readCache(cacheKey);
        if (cached) {
            void recordConstraintMetric({
                phase: 'ai',
                success: true,
                requirementCount: cached.rawRequirements?.length || 0,
                ai: {
                    model,
                    promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
                    cacheHit: true,
                    entityPruned: cached.entityCandidates?.pruned || false,
                },
            });
            return {
                ...cached,
                cache: { hit: true, key: cacheKey },
            };
        }
    }
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    const response = await fetchWithTimeout(fetchClient, `${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            ...(Number.isInteger(seed) ? { seed } : {}),
            response_format: { type: 'json_object' },
            messages: buildAiRequirementExtractionMessages({ project: promptProject, text: requestText, contextStats, sourceInputs }),
        }),
    }, timeoutMs(env));
    const raw = await response.text();
    let payload = {};
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        throw new TimetableAiExtractionError('AI-first 抽取响应不是有效 JSON。', 'ai_extract_invalid_json', 502);
    }
    if (!response.ok) {
        throw new TimetableAiExtractionError(payload.error?.message || 'AI-first 抽取失败。', 'ai_extract_failed', response.status || 502);
    }
    const content = payload.choices?.[0]?.message?.content ?? payload;
    const validated = validateExtractionPayload(content, { sourceRequirements, project });
    const resolved = resolveEntityRefs(project, validated.requirements);
    const unrecognizedWarnings = asList(validated.unrecognized)
        .map(item => `AI 未识别：${text(item.text || item.reason || '', 180)}`)
        .filter(Boolean);
    const result = {
        ...resolved,
        warnings: [...validated.warnings, ...unrecognizedWarnings],
        warningItems: validated.warningItems || [],
        rejected: asList(validated.rejected),
        model,
        promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
        rawRequirements: asList(validated.requirements),
        unrecognized: asList(validated.unrecognized),
        cache: { hit: false, key: cacheKey },
        entityCandidates: {
            pruned,
            originalCount: totalEntityCount(project),
            promptCount: totalEntityCount(promptProject),
        },
    };
    if (cacheEnabled(env)) rememberCache(cacheKey, result);
    void recordConstraintMetric({
        phase: 'ai',
        success: true,
        requirementCount: result.rawRequirements.length,
        ai: {
            model,
            promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
            cacheHit: false,
            entityPruned: pruned,
        },
    });
    return result;
}
