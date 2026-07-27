import {
    AI_REQUIREMENT_PROMPT_VERSION,
} from './timetable-ai-prompts.js';
import {
    CONSTRAINT_IR_SCHEMA_VERSION,
} from './timetable-constraints/constraint-ir.js';
import {
    getTimetableConstraintParseCache,
} from './timetable-constraints/parse-cache.js';

import {
    asList,
    asText,
    resolveAiConfig,
} from './timetable-rule-parser-sources.js';
import {
    INVALID_INFERRED_ENTITY_NAMES,
    cloneValue,
    hashValue,
    stableJson,
} from './timetable-rule-parser-artifacts.js';
import {
    AI_CANDIDATE_VALIDATION_VERSION,
    AI_REVIEW_PROMPT_VERSION,
    CAPABILITY_VERSION,
    DEFAULT_AI_REVIEW_TIMEOUT_MS,
    MAX_PARSE_CACHE_ITEMS,
    PARSER_VERSION,
    PARSE_CACHE,
    hasConfiguredAi,
    shouldUseAiExtraction,
} from './timetable-rule-parser-ir.js';

function projectFingerprintForParse(project = {}) {
    return {
        id: project.id || '',
        schoolName: project.schoolName || '',
        term: project.term || '',
        activeWeekdays: project.activeWeekdays || [],
        activePeriods: project.activePeriods || [],
        dayPartBoundaries: project.dayPartBoundaries || {},
        periodTimes: project.periodTimes || {},
        periodTimeSegments: project.periodTimeSegments || null,
        teachers: project.teachers || [],
        classes: project.classes || [],
        subjects: project.subjects || [],
        rooms: project.rooms || [],
        lessonPlans: project.lessonPlans || [],
        constraintEntityAliases: project.constraintEntityAliases || {},
        rules: project.rules || {},
    };
}

function aiReviewDisabled(env = {}) {
    return ['1', 'true', 'yes', 'on'].includes(String(env.TIMETABLE_RULE_AI_REVIEW_DISABLED || '').trim().toLowerCase());
}

function aiReviewTimeoutMs(env = {}) {
    const value = Number.parseInt(env.TIMETABLE_RULE_AI_REVIEW_TIMEOUT_MS, 10);
    if (Number.isInteger(value) && value > 0) return Math.min(value, 120_000);
    return DEFAULT_AI_REVIEW_TIMEOUT_MS;
}

function aiReviewCachePart(env = {}) {
    const aiExtractEnabled = shouldUseAiExtraction('text', env);
    const extractPart = aiExtractEnabled ? `:ai_extract:${AI_REQUIREMENT_PROMPT_VERSION}` : '';
    if (aiReviewDisabled(env)) return `ai_review_disabled${extractPart}`;
    if (!hasConfiguredAi(env)) return 'ai_review_unavailable';
    try {
        const { model } = resolveAiConfig(env);
        return `ai_review:${AI_REVIEW_PROMPT_VERSION}${extractPart}:${model || 'unknown'}`;
    } catch {
        return `ai_review:${AI_REVIEW_PROMPT_VERSION}${extractPart}:unresolved`;
    }
}

function parseCacheKey({ content, inputType = 'text', project, env = {} }) {
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    return `constraint_parse:${hashValue({
        contentHash: hashValue(content, 64),
        inputType,
        projectFingerprint: hashValue(projectFingerprintForParse(project), 64),
        ai: aiReviewCachePart(env),
        extractionPromptVersion: AI_REQUIREMENT_PROMPT_VERSION,
        reviewPromptVersion: AI_REVIEW_PROMPT_VERSION,
        parserVersion: PARSER_VERSION,
        constraintIRVersion: CONSTRAINT_IR_SCHEMA_VERSION,
        capabilityVersion: CAPABILITY_VERSION,
        seed: Number.isInteger(seed) ? seed : null,
    }, 64)}`;
}

function getParseCache(key = '') {
    if (!key || !PARSE_CACHE.has(key)) return null;
    const cached = PARSE_CACHE.get(key);
    PARSE_CACHE.delete(key);
    PARSE_CACHE.set(key, cached);
    return cloneValue(cached);
}

function setParseCache(key = '', value = null) {
    if (!key || !value) return;
    while (PARSE_CACHE.size >= MAX_PARSE_CACHE_ITEMS) {
        const oldestKey = PARSE_CACHE.keys().next().value;
        if (!oldestKey) break;
        PARSE_CACHE.delete(oldestKey);
    }
    PARSE_CACHE.set(key, cloneValue(value));
}

function determinismMetadata(cacheKey = '', env = {}, cacheHit = false) {
    let model = '';
    try {
        if (hasConfiguredAi(env)) model = resolveAiConfig(env).model;
    } catch {
        model = '';
    }
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    return {
        cacheKey,
        cacheHit: Boolean(cacheHit),
        parserVersion: PARSER_VERSION,
        promptVersions: {
            extraction: AI_REQUIREMENT_PROMPT_VERSION,
            review: AI_REVIEW_PROMPT_VERSION,
        },
        model,
        seed: Number.isInteger(seed) ? seed : null,
    };
}

function withParseMetadata(result = {}, overrides = {}) {
    const cacheHit = Boolean(overrides.cacheHit ?? result.cacheHit);
    return {
        ...result,
        parserVersion: result.parserVersion || PARSER_VERSION,
        parseSource: overrides.parseSource || result.parseSource || result.source || '',
        cacheHit,
        determinism: determinismMetadata(overrides.cacheKey || result.determinism?.cacheKey || '', overrides.env || {}, cacheHit),
    };
}

function persistentParseCacheEnabled(env = {}) {
    return env === process.env || ['1', 'true', 'yes', 'on'].includes(String(env.TIMETABLE_RULE_PERSISTENT_CACHE || '').trim().toLowerCase());
}

function cacheConstraintIRSignature(ir = {}) {
    const { legacyRow, selectorCurrentlyUnmatched, ...parameters } = ir.parameters || {};
    void legacyRow;
    void selectorCurrentlyUnmatched;
    return stableJson({
        sourceId: ir.sourceId || '',
        capabilityId: ir.capabilityId || '',
        intent: ir.intent || '',
        target: ir.target || {},
        scope: ir.scope || {},
        time: ir.time || {},
        relation: ir.relation || {},
        parameters,
        strength: ir.strength || '',
    });
}

function parseResultPassesCacheAdmission(result = {}) {
    if (result.inputType === 'xlsx_roster') return true;
    const sources = asList(result.sourceRequirements).filter(item => item && typeof item === 'object');
    const irs = asList(result.constraintIRs).filter(item => item && typeof item === 'object');
    if (!sources.length || !irs.length) return false;

    const sourceIds = sources.map(source => asText(source.sourceId, 300));
    const sourceIdSet = new Set(sourceIds.filter(Boolean));
    if (sourceIdSet.size !== sources.length) return false;
    if (irs.some(ir => !sourceIdSet.has(asText(ir.sourceId, 300)) || !asText(ir.textHash, 128))) return false;

    const signatures = irs.map(cacheConstraintIRSignature);
    if (new Set(signatures).size !== signatures.length) return false;

    const applicationTargets = new Set(['rule', 'lesson_plan', 'optimization', 'handled', 'review']);
    if (sources.some(source => !applicationTargets.has(source.applicationTarget))) return false;
    if (sources.some(source => source.requiresHumanReview && asList(source.reviewReasons).some(reason => (
        reason?.origin === 'ai' && reason?.verified !== true
    )))) return false;

    if (result.parseSource === 'ai_extract') {
        const validation = result.aiCandidateValidation || {};
        if (result.aiReview?.status === 'unavailable') return false;
        if (validation.version !== AI_CANDIDATE_VALIDATION_VERSION) return false;
        if (validation.formalBase !== 'local_baseline') return false;
        if (Number(validation.unverifiedCandidateCount || 0) !== 0) return false;
    }
    if (irs.some(ir => {
        const kind = asText(ir.target?.kind, 80);
        const name = asText(ir.target?.name, 120).toLowerCase();
        return ['teacher', 'class', 'subject', 'room'].includes(kind) && INVALID_INFERRED_ENTITY_NAMES.has(name);
    })) return false;
    return true;
}

async function parseWithPersistentCache({ cacheKey, env, producer }) {
    const cache = getTimetableConstraintParseCache(env);
    const cached = await cache.getOrCreate(cacheKey, async () => withParseMetadata(await producer(), {
        cacheKey,
        cacheHit: false,
        env,
    }), { shouldCache: parseResultPassesCacheAdmission });
    return withParseMetadata(cached.value, { cacheKey, cacheHit: cached.cacheHit, env });
}

export {
    aiReviewDisabled,
    aiReviewTimeoutMs,
    cacheConstraintIRSignature,
    determinismMetadata,
    getParseCache,
    parseCacheKey,
    parseWithPersistentCache,
    parseResultPassesCacheAdmission,
    persistentParseCacheEnabled,
    projectFingerprintForParse,
    setParseCache,
    withParseMetadata,
};
