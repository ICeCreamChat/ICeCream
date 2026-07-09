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

function unique(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values]).map(value => text(value, 160)).filter(Boolean))];
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
            aliases: item.aliases || [],
        };
    }
    return {
        id: item.id || '',
        name: item.name || item.label || '',
        aliases: item.aliases || [],
        subjects: item.subjects || [],
        tags: item.tags || [],
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
            teacherIds: plan.teacherIds || [],
            weeklyHours: plan.weeklyHours,
            blockPreference: plan.blockPreference || '',
        })),
        rules: project.rules || {},
        contextStats,
    };
}

function buildCacheKey({ model = '', requestText = '', promptProject = {}, contextStats = null } = {}) {
    return sha256({
        promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
        model,
        normalizedInput: normalizeCacheInput(requestText),
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
        || (plan.teacherIds || []).some(teacherId => teacherIds.has(teacherId))
        || classIds.has(plan.classId)
        || subjectIds.has(plan.subjectId)
    ));
    relatedPlans.forEach(plan => {
        if (plan.teacherId) teacherIds.add(plan.teacherId);
        (plan.teacherIds || []).forEach(teacherId => teacherIds.add(teacherId));
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

function splitRequirementSentences(input = '') {
    return text(input, 20_000)
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
    const unrecognized = [];
    const seen = new Set();
    let cacheHitCount = 0;
    results.forEach((result, chunkIndex) => {
        if (result.cache?.hit) cacheHitCount += 1;
        (result.rawRequirements || []).forEach((requirement, itemIndex) => {
            const key = requirementDedupeKey(requirement);
            if (seen.has(key)) return;
            seen.add(key);
            rawRequirements.push({
                ...requirement,
                id: requirement.id || `ai_batch_${chunkIndex + 1}_${itemIndex + 1}`,
            });
        });
        warnings.push(...(result.warnings || []));
        unrecognized.push(...(result.unrecognized || []));
    });
    const resolved = resolveEntityRefs(project, rawRequirements);
    return {
        ...resolved,
        warnings: unique(warnings),
        unrecognized,
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
    return text(value, 1000).replace(/\s+/g, '');
}

function timeHasPeriod(time = {}, period) {
    const periods = unique(time.periods || time.lessonIndexes || []).map(Number);
    if (periods.includes(period)) return true;
    return unique(time.slots || []).some(slot => {
        const [, slotPeriod] = String(slot).split('-').map(Number);
        return slotPeriod === period;
    });
}

function canonicalizeRequirement(item = {}) {
    const next = { ...item, time: item.time && typeof item.time === 'object' ? { ...item.time } : {} };
    next.params = item.params && typeof item.params === 'object'
        ? { ...item.params }
        : item.parameters && typeof item.parameters === 'object'
            ? { ...item.parameters }
            : {};
    const evidence = normalizedEvidence(item.evidence || item.rawText || item.text || item.reason || item.description || '');
    const targetNames = unique(item.targetNames || item.targets || item.names || item.target || item.targetName || []);

    if (/跨校区|通勤|南北校区|校区连续/.test(evidence)) {
        next.intent = 'campus_commute_gap';
        next.targetKind = next.targetKind || 'teacher';
    }

    if (/全校.*(社团|升旗|大扫除|活动|教研)|不排主课/.test(evidence)) {
        next.intent = 'global_unavailable';
        next.targetKind = 'global';
    }

    if (!/(老师|教师)/.test(evidence) && /(连堂|两节连上|两节连排|大课)/.test(evidence)) {
        next.intent = 'block_preference';
        next.targetKind = next.targetKind || 'subject';
    }

    if (/隔天排|至少隔|间隔/.test(evidence) && /课/.test(evidence)) {
        next.intent = 'course_interval';
        next.targetKind = next.targetKind || 'subject';
    }

    if (/(老师|教师).*别太累|老师别太累|教师别太累/.test(evidence)) {
        next.intent = 'teacher_load_balance';
        next.targetKind = 'global';
        next.needsClarification = true;
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

    if (/这几门课.*错开|几门课.*错开/.test(evidence)) {
        next.intent = 'subject_not_same_day';
        next.targetKind = 'subject';
        next.needsClarification = true;
    }

    if (/(单双周|单周|双周|隔周)/.test(evidence)) {
        next.intent = 'week_pattern';
    }

    if (/(合班|一起上|走班.*(对齐|同一时间)|同一时间对齐)/.test(evidence)) {
        next.intent = 'teaching_group_session';
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

    if ((next.intent === 'subject_morning' || next.intent === 'subject_preferred_periods')
        && /(黄金|前四节|主科|数理化)/.test(evidence)) {
        next.intent = 'golden_hour_preference';
    }

    if (next.intent === 'global_unavailable'
        && /(午休|中午最后一节|下午第一节|午饭前后)/.test(evidence)
        && !targetNames.length) {
        next.intent = 'lunch_protection';
    }

    if (next.intent === 'subject_avoid_periods') {
        if (/(第一节|首节|第1节|上午第一节)/.test(evidence) || timeHasPeriod(next.time, 1)) {
            next.intent = 'avoid_first_period';
        } else if (/(最后一节|放学前|末节)/.test(evidence)) {
            next.intent = 'avoid_last_period';
        }
        if (next.intent === 'avoid_first_period' || next.intent === 'avoid_last_period') {
            next.strength = 'soft';
        }
    }

    if (next.intent === 'course_interval') {
        next.params.minGapDays = next.params.minGapDays || next.params.intervalDays || next.params.gapDays || next.params.days;
    }
    if (next.intent === 'room_requirement') {
        const roomNames = unique(next.params.roomNames || next.params.roomName || next.params.rooms || []);
        if (roomNames.length && !next.params.roomName) next.params.roomName = roomNames[0];
        if (/合适(教室|场地|功能室)|合适教室/.test(evidence)) {
            next.needsClarification = true;
            next.confidence = Math.min(confidenceOf(next.confidence), 0.6);
        }
    }
    if (next.intent === 'teacher_gap_preference' || next.intent === 'teacher_load_balance') {
        next.targetKind = 'global';
    }

    if (['teacher_unavailable', 'class_unavailable', 'global_unavailable', 'locked_slot', 'subject_daily_limit', 'teacher_weekly_limit', 'teacher_max_days_per_week', 'teacher_mutual_exclusion', 'subject_not_same_day', 'room_requirement', 'teaching_group_meeting', 'teaching_group_session', 'campus_commute_gap'].includes(next.intent)) {
        next.strength = 'hard';
    }
    if (['subject_morning', 'subject_afternoon', 'subject_preferred_periods', 'subject_avoid_periods', 'avoid_first_period', 'avoid_last_period', 'golden_hour_preference', 'teacher_daily_limit', 'teacher_consecutive_limit', 'subject_spread', 'course_interval', 'class_daily_balance', 'teacher_gap_preference', 'teacher_load_balance', 'subject_sequence', 'block_preference', 'week_pattern', 'lunch_protection'].includes(next.intent)) {
        next.strength = 'soft';
    }

    return next;
}

function confidenceOf(value) {
    const confidence = Number(value);
    if (!Number.isFinite(confidence)) return 0.72;
    return Math.max(0, Math.min(1, confidence));
}

export function validateExtractionPayload(payload = {}) {
    const parsed = parseJsonContent(payload);
    const rawRequirements = Array.isArray(parsed.requirements)
        ? parsed.requirements
        : Array.isArray(parsed.items)
            ? parsed.items
            : [];
    if (!Array.isArray(rawRequirements)) {
        throw new TimetableAiExtractionError('AI-first 抽取缺少 requirements 数组。', 'ai_extract_schema_invalid', 502);
    }
    const warnings = [];
    const requirements = [];
    rawRequirements.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            warnings.push(`第 ${index + 1} 条 AI 结果不是对象，已忽略。`);
            return;
        }
        const canonical = canonicalizeRequirement(item);
        const intent = normalizeIntent(canonical.intent || canonical.type);
        const evidence = text(canonical.evidence || canonical.rawText || canonical.text || canonical.reason || canonical.description, 1000);
        if (intent === 'unknown') {
            warnings.push(`第 ${index + 1} 条 AI 结果 intent 不在目录内，已转人工复核。`);
        }
        requirements.push({
            id: text(canonical.id, 120) || `ai_req_${index + 1}`,
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
            notes: text(canonical.notes || canonical.reason || '', 500),
        });
    });
    return {
        requirements,
        unrecognized: Array.isArray(parsed.unrecognized) ? parsed.unrecognized : [],
        warnings: [...warnings, ...unique(parsed.warnings || [])],
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
        ...(item.aliases || []),
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
            ids.push(plan.teacherId, ...(plan.teacherIds || []));
        });
        (project.teachers || []).forEach(teacher => {
            if ((teacher.subjects || []).includes(subjectId)) ids.push(teacher.id);
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
        ...(params.subjectNames || []),
        ...(params.teacherNames || []),
        ...(params.classNames || []),
    ]);
    let object = { kind: targetKind, name: baseNames.join('、') || '全局', matchedIds: [], scope: 'explicit' };
    let clarification = requirement.clarification;
    let status = requirement.needsClarification || requirement.confidence < 0.6 ? 'needs_review' : 'actionable';

    if (targetKind === 'global') {
        object = { kind: 'global', name: baseNames.join('、') || '全局', matchedIds: [], scope: 'global' };
    } else if (targetKind === 'teacher') {
        const names = unique([...targetIds, ...baseNames, ...(params.teacherIds || [])]);
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
        const names = unique([...targetIds, ...baseNames, ...(params.classIds || [])]);
        const resolved = matchEntities(project.classes || [], names, 'class');
        params.classIds = resolved.matches.map(item => item.id);
        object = { kind: 'class', name: resolved.matches.map(item => item.name).join('、') || names.join('、'), matchedIds: params.classIds, scope: 'explicit' };
        if (resolved.unresolved.length || resolved.ambiguous.length) {
            status = 'needs_review';
            warnings.push(...resolved.unresolved.map(item => `未找到班级：${item.name}`));
        }
    } else if (targetKind === 'subject' || targetKind === 'teaching_group') {
        const names = unique([...targetIds, ...baseNames, ...(params.subjectIds || [])]);
        const subjectNames = targetKind === 'teaching_group'
            ? names.map(name => name.replace(/教研组|备课组|组/g, ''))
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
    const source = { rawText: requirement.evidence || requirement.notes || '', parseSource: 'ai_extract' };
    return {
        id: requirement.id,
        origin: 'user_input',
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
    return {
        id: `ai_${requirement.id || index + 1}`,
        requirementId: requirement.id || '',
        rawText: requirement.source?.rawText || '',
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
    env = {},
    fetchImpl = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const requestText = text(inputText, 20_000);
    if (!requestText) throw new TimetableAiExtractionError('AI-first 抽取文本为空。', 'empty_prompt', 400);
    const { apiKey, baseUrl, model } = resolveAiConfig(env);
    const fetchClient = resolveFetch(fetchImpl);
    const sentences = splitRequirementSentences(requestText);
    if (sentences.length > BATCH_SENTENCE_THRESHOLD) {
        const chunks = chunkValues(sentences);
        const concurrency = Math.max(1, Math.min(
            Number.parseInt(env.TIMETABLE_RULE_AI_BATCH_CONCURRENCY, 10) || 3,
            chunks.length,
        ));
        const results = await mapWithConcurrency(chunks, concurrency, (chunk, index) => extractRequirementsWithAISingle({
            project,
            requestText: chunk.join('。'),
            contextStats: {
                ...(contextStats || {}),
                batchIndex: index + 1,
                batchCount: chunks.length,
                batchSentenceCount: chunk.length,
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
    contextStats = null,
    env = {},
    fetchClient,
    apiKey = '',
    baseUrl = '',
    model = '',
} = {}) {
    const { project: promptProject, pruned } = pruneProjectEntitiesForPrompt(project, requestText);
    const cacheKey = buildCacheKey({ model, requestText, promptProject, contextStats });
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
            messages: buildAiRequirementExtractionMessages({ project: promptProject, text: requestText, contextStats }),
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
    const validated = validateExtractionPayload(content);
    const resolved = resolveEntityRefs(project, validated.requirements);
    const unrecognizedWarnings = (validated.unrecognized || [])
        .map(item => `AI 未识别：${text(item.text || item.reason || '', 180)}`)
        .filter(Boolean);
    const result = {
        ...resolved,
        warnings: [...validated.warnings, ...unrecognizedWarnings],
        model,
        promptVersion: AI_REQUIREMENT_PROMPT_VERSION,
        rawRequirements: validated.requirements,
        unrecognized: validated.unrecognized || [],
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
