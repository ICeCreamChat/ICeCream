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
import {
    validateSemanticRelationGraph,
} from './timetable-constraints/semantic-planning.js';
import {
    TimetableAiExtractionError,
    text,
    asList,
    sha256,
    normalizeName,
    entityAliases,
    first,
    unique,
    normalizedEvidence,
    validateExtractionPayload,
    resolveEntityRefs,
} from './timetable-ai-extraction-validator.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const MAX_CACHE_ENTRIES = 200;

const ENTITY_PRUNE_THRESHOLD = 200;

const BATCH_SENTENCE_THRESHOLD = 30;

const BATCH_SENTENCES_PER_CHUNK = 20;

const aiExtractionCache = new Map();

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value ?? null));
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

function resetTimetableAiExtractionCache() {
    aiExtractionCache.clear();
}

function getTimetableAiExtractionCacheStats() {
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

function buildAiExtractionPromptProjectForTests(projectInput = {}, input = '') {
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
        scope: item.scope || {},
        relation: item.relation || {},
        quantifier: item.quantifier || {},
        evidence: normalizedEvidence(item.evidence || item.rawText || item.text || ''),
    });
}

function mergeBatchExtractionResults(project = {}, results = [], sentenceCount = 0, concurrency = 1) {
    const rawRequirements = [];
    const warnings = [];
    const warningItems = [];
    const unrecognized = [];
    const rejected = [];
    const sourceRationales = [];
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
        sourceRationales.push(...asList(result.sourceRationales));
    });
    const resolved = resolveEntityRefs(project, rawRequirements);
    return {
        ...resolved,
        warnings: unique(warnings),
        warningItems,
        unrecognized,
        rejected,
        sourceRationales,
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

async function extractRequirementsWithAI({
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
        sourceRationales: asList(validated.rationales),
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

export {
    TimetableAiExtractionError,
    resetTimetableAiExtractionCache,
    getTimetableAiExtractionCacheStats,
    buildAiExtractionPromptProjectForTests,
    extractRequirementsWithAI,
};
export {
    validateExtractionPayload,
    resolveEntityRefs,
} from './timetable-ai-extraction-validator.js';
