import { createHash } from 'node:crypto';
import path from 'node:path';

import AdmZip from 'adm-zip';

import {
    cleanText,
    getActivePeriods,
    getDayPartPeriods,
    getActiveWeekdays,
    makeTimetableId,
    normalizeTimetableProject,
    normalizeWeekPattern,
    slotKey,
} from './timetable-project.js';
import {
    buildTimetableRosterFromRows,
    previewTimetableRosterFile,
} from './timetable-import.js';
import {
    compileRequirementToRows,
} from './timetable-intent-compiler.js';
import {
    AI_REQUIREMENT_PROMPT_VERSION,
} from './timetable-ai-prompts.js';
import {
    extractRequirementsWithAI,
} from './timetable-ai-extractor.js';
import {
    normalizeTimetableMarketTextWithTrace,
} from './timetable-language-normalizer.js';
import {
    applyClarificationPolicy,
} from './timetable-clarify-policies.js';
import {
    attachArtifactsToSourceRequirements,
    buildLegacyRequirementItemsFromSources,
    buildSourceRequirements,
    finalizeSourceRequirementPresentation,
    linkArtifactToSource,
    sourceInputRowsFromText,
} from './timetable-constraints/source-requirement.js';
import {
    buildRequirementStatistics,
} from './timetable-constraints/statistics.js';
import {
    SOURCE_SCHEMA_VERSION,
} from './timetable-constraints/source-identity.js';
import {
    alignAiArtifactsToSources,
    sourceRequirementsToAiInputs,
} from './timetable-constraints/ai-source-alignment.js';
import {
    createDefaultTimetableCapabilityRegistry,
    legacyArtifactToConstraintIR,
} from './timetable-constraints/capabilities.js';
import {
    compileConstraintIR,
    resolveConstraintCapability,
} from './timetable-constraints/capability-registry.js';
import {
    aggregateConstraintIRStatuses,
    CONSTRAINT_IR_SCHEMA_VERSION,
    normalizeConstraintIR,
} from './timetable-constraints/constraint-ir.js';
import {
    assessConstraintIRExecutionReadiness,
    buildEntityResolution,
    resolveConstraintIRReferences,
} from './timetable-constraints/entity-resolution.js';
import { getTimetableConstraintParseCache } from './timetable-constraints/parse-cache.js';

const MAX_RULE_FILE_BYTES = 5 * 1024 * 1024;
const PARSER_VERSION = 'timetable_rule_parser_constraint_ir_v9';
const AI_REVIEW_PROMPT_VERSION = 'timetable_ai_review_v4';
const CAPABILITY_VERSION = 'timetable_capability_registry_v6';
const AI_CANDIDATE_VALIDATION_VERSION = 'timetable_ai_candidate_validation_v1';
const DEFAULT_AI_REVIEW_TIMEOUT_MS = 30_000;
const PARSE_CACHE = new Map();
const MAX_PARSE_CACHE_ITEMS = 40;
const TIMETABLE_CAPABILITY_REGISTRY = createDefaultTimetableCapabilityRegistry();

const SUPPORTED_EFFECTIVE_TYPES = new Set([
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'global_unavailable',
    'subject_morning',
    'subject_afternoon',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_daily_limit',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'teacher_weekly_limit',
    'teacher_max_days_per_week',
    'teacher_mutual_exclusion',
    'subject_spread',
    'course_interval',
    'room_requirement',
    'class_daily_balance',
    'teacher_gap_preference',
    'teacher_load_balance',
    'subject_not_same_day',
    'subject_sequence',
    'advanced_constraint',
]);

const SUGGESTION_ONLY_TYPES = new Set([
    'quality_subject_later',
    'block_protection',
    'class_subject_spread',
]);

const STATUS_LABELS = new Set(['effective', 'ready', 'needs_review', 'suggestion', 'unsupported', 'invalid', 'ignored']);
const SYSTEM_TEACHER_TIME_CONFLICT_PATTERN = /同一.*教师.*同一.*时间.*(只能|一个班|一门课)|教师.*不能.*同.*时间.*(多个|两个|两个班|上课)/;
const SYSTEM_CLASS_TIME_CONFLICT_PATTERN = /同一.*班级.*同一.*时间.*(只能|一门|一节)|班级.*不能.*同.*时间.*(多个|两门|两节)/;
const SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN = /(每个|各个)?.*班级.*(每门|各门)?.*课程.*(周课时|课时).*(排满|不能少排|不能多排|不少排|不多排)|周课时.*(排满|不能少排|不能多排)/;
const DAY_NAME_TO_NUMBER = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7],
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
]);
const ENGLISH_DAY_NAME_TO_NUMBER = new Map([
    ['monday', 1], ['mon', 1],
    ['tuesday', 2], ['tue', 2], ['tues', 2],
    ['wednesday', 3], ['wed', 3],
    ['thursday', 4], ['thu', 4], ['thur', 4], ['thurs', 4],
    ['friday', 5], ['fri', 5],
    ['saturday', 6], ['sat', 6],
    ['sunday', 7], ['sun', 7],
]);
const CHINESE_NUMBER_TO_VALUE = new Map([
    ['零', 0], ['〇', 0],
    ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
    ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);
const NUMBER_TOKEN_PATTERN = '[0-9一二两三四五六七八九十零〇]{1,4}';

export class TimetableRuleParseError extends Error {
    constructor(message, reason = 'ai_unavailable', status = 503) {
        super(message);
        this.name = 'TimetableRuleParseError';
        this.reason = reason;
        this.status = status;
    }
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function hashValue(value, length = 16) {
    return createHash('sha256')
        .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value))
        .digest('hex')
        .slice(0, length);
}

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

const INVALID_INFERRED_ENTITY_NAMES = new Set([
    '日课量', '至少', '每个班每天课量', '课组内的教师', '固定活动',
    'unsupported', 'need_review', 'needs_review', 'unknown', 'requirement', 'schedule_request',
]);

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

function sourceRowsForParse({ text = '', inputType = 'text', constraintRows = [], origin = 'user_input' } = {}) {
    const rows = asList(constraintRows).filter(row => row && typeof row === 'object');
    if (rows.length) {
        return rows.map((row, index) => ({
            ...row,
            rawText: row.rawText || row.constraintText || row.description || row.reason || '',
            sourceIndex: index,
            inputType,
            origin: row.origin || origin,
        }));
    }
    return sourceInputRowsFromText(text, { inputType, origin });
}

function prepareSourceInputs({ text = '', inputType = 'text', constraintRows = [], fileName = '', origin = 'user_input' } = {}) {
    const sourceRows = sourceRowsForParse({ text, inputType, constraintRows, origin })
        .filter(row => asText(row.rawText || row.constraintText || row.description || row.reason || '', 2000));
    const sourceRequirements = buildSourceRequirements(sourceRows, { inputType, fileName, origin });
    const enrichedRows = sourceRows.map((row, index) => {
        const sourceRequirement = sourceRequirements[index];
        return {
            ...row,
            rawText: sourceRequirement.source.rawText,
            constraintText: row.constraintText || sourceRequirement.source.rawText,
            sourceId: sourceRequirement.sourceId,
            textHash: sourceRequirement.source.textHash,
            origin: sourceRequirement.origin,
            parsedBy: normalizedParsedBy(row.parsedBy, origin === 'manual' ? 'manual' : []),
            sourceSheet: row.sourceSheet || sourceRequirement.source.sheetName || undefined,
            sourceRow: row.sourceRow || sourceRequirement.source.rowNumber || undefined,
            lineNumber: row.lineNumber || sourceRequirement.source.lineNumber || undefined,
        };
    });
    return { sourceRequirements, sourceRows: enrichedRows };
}

function parserActors(parseSource = '') {
    const value = String(parseSource || '').toLowerCase();
    const actors = [];
    if (value.includes('local') || value.includes('xlsx')) actors.push('local');
    if (value.includes('ai')) actors.push('ai');
    if (!actors.length && value) actors.push(value);
    return actors;
}

function asList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function normalizedTextValues(maxLength = 240, ...values) {
    return [...new Set(values
        .flatMap(value => asList(value))
        .map(value => asText(value, maxLength))
        .filter(Boolean))];
}

function normalizedMessageValues(maxLength = 240, ...values) {
    return normalizedTextValues(
        maxLength,
        values.flatMap(value => asList(value)).map(item => (
            item && typeof item === 'object'
                ? item.message || item.reason || item.suggestion || item.description || item.question || ''
                : item
        ))
    );
}

function normalizedParsedBy(...values) {
    return [...new Set(values.flatMap(value => asList(value))
        .map(value => asText(value, 80))
        .filter(Boolean))];
}

function artifactProvenance(artifact = {}, sourcesById = new Map(), actors = []) {
    const artifactSource = artifact.source && typeof artifact.source === 'object' ? artifact.source : {};
    const requestedSourceId = asText(artifact.sourceId || artifactSource.sourceId || '', 300);
    const sourceRequirement = requestedSourceId ? sourcesById.get(requestedSourceId) : null;
    const source = sourceRequirement?.source || {};
    const sourceId = requestedSourceId || sourceRequirement?.sourceId || '';
    const textHash = asText(artifact.textHash || artifactSource.textHash || source.textHash || sourceRequirement?.textHash || '', 128);
    const origin = asText(artifact.origin || artifactSource.origin || sourceRequirement?.origin || '', 40);
    const parsedBy = normalizedParsedBy(
        sourceRequirement?.parsedBy || [],
        artifactSource.parsedBy || [],
        artifact.parsedBy || [],
        actors
    );
    const sourceSheet = asText(
        artifact.sourceSheet
        || artifactSource.sourceSheet
        || artifactSource.sheetName
        || source.sheetName
        || '',
        120
    );
    const sourceRow = Number.parseInt(
        artifact.sourceRow
        ?? artifactSource.sourceRow
        ?? artifactSource.rowNumber
        ?? source.rowNumber,
        10
    ) || null;
    const lineNumber = Number.parseInt(
        artifact.lineNumber
        ?? artifactSource.lineNumber
        ?? source.lineNumber,
        10
    ) || null;
    const rawText = asText(
        artifact.rawText
        || artifactSource.rawText
        || source.rawText
        || artifact.description
        || artifact.reason
        || '',
        2000
    );
    return {
        sourceId,
        textHash,
        origin,
        parsedBy,
        sourceSheet,
        sourceRow,
        lineNumber,
        rawText,
        clauseId: asText(artifact.clauseId || artifactSource.clauseId || '', 300),
        machineRuleId: asText(artifact.machineRuleId || '', 300),
    };
}

function aggregateSourceWarnings(sourceRequirements = [], rows = [], warningItems = []) {
    const warningsBySource = new Map(sourceRequirements.map(source => [source.sourceId, new Set(source.warnings || [])]));
    const add = artifact => {
        const sourceId = artifact?.sourceId || artifact?.source?.sourceId || '';
        const bucket = warningsBySource.get(sourceId);
        if (!bucket) return;
        [...asList(artifact?.warnings), ...asList(artifact?.aiReviewWarnings)]
            .map(message => asText(message, 240))
            .filter(Boolean)
            .forEach(message => bucket.add(message));
    };
    const addWarningItem = item => {
        const sourceId = item?.sourceId || item?.source?.sourceId || '';
        const message = asText(item?.message || item?.reason || item?.description || '', 240);
        const bucket = warningsBySource.get(sourceId);
        if (bucket && message) bucket.add(message);
    };
    sourceRequirements.forEach(source => (source.clauses || []).forEach(add));
    rows.forEach(add);
    warningItems.forEach(addWarningItem);
    return sourceRequirements.map(source => ({
        ...source,
        warnings: [...(warningsBySource.get(source.sourceId) || [])],
    }));
}

function buildWarningItems({ warnings = [], warningItems: existingItems = [], sourceRequirements = [], requirements = [], rows = [], actors = [] } = {}) {
    const sourcesById = new Map(sourceRequirements.map(source => [source.sourceId, source]));
    const result = [];
    const seen = new Set();
    const add = (messageValue, artifact = {}) => {
        const warning = messageValue && typeof messageValue === 'object' ? messageValue : {};
        const message = asText(
            typeof messageValue === 'string'
                ? messageValue
                : warning.message || warning.reason || warning.suggestion || warning.description || '',
            500
        );
        if (!message) return;
        const effectiveArtifact = { ...artifact, ...warning };
        const provenance = artifactProvenance(effectiveArtifact, sourcesById, actors);
        const key = stableJson([
            warning.code || '',
            message,
            provenance.sourceId,
            provenance.clauseId,
            provenance.machineRuleId,
        ]);
        if (seen.has(key)) return;
        seen.add(key);
        result.push({
            ...warning,
            id: warning.id || `warning_${hashValue(key, 24)}`,
            message,
            ...provenance,
        });
    };
    const addArtifactWarnings = artifact => {
        [...asList(artifact?.warnings), ...asList(artifact?.aiReviewWarnings)].forEach(message => add(message, artifact));
    };
    existingItems.forEach(item => add(item, item));
    rows.forEach(addArtifactWarnings);
    requirements.forEach(addArtifactWarnings);
    sourceRequirements.forEach(source => {
        (source.clauses || []).forEach(addArtifactWarnings);
        (source.warnings || []).forEach(message => add(message, source));
    });
    warnings.forEach(message => add(message, {}));
    return result;
}

function enrichSemanticActions(actions = [], requirements = [], rows = [], sourceRequirements = [], actors = []) {
    const sourcesById = new Map(sourceRequirements.map(source => [source.sourceId, source]));
    const requirementById = new Map();
    requirements.forEach(requirement => {
        if (requirement.id) requirementById.set(requirement.id, requirement);
        if (requirement.requirementId) requirementById.set(requirement.requirementId, requirement);
    });
    const rowById = new Map();
    rows.forEach(row => {
        if (row.id) rowById.set(row.id, row);
        if (row.machineRuleId) rowById.set(row.machineRuleId, row);
    });
    return actions.map(action => {
        const requirement = requirementById.get(action.requirementId) || {};
        const rowId = action.rowId || requirement.rowId || action.target?.rowIds?.[0] || '';
        const row = rowById.get(rowId) || {};
        const merged = {
            ...row,
            ...requirement,
            ...action,
            sourceId: action.sourceId || requirement.sourceId || row.sourceId || '',
            textHash: action.textHash || requirement.textHash || row.textHash || '',
            origin: action.origin || requirement.origin || row.origin || '',
            parsedBy: normalizedParsedBy(row.parsedBy || [], requirement.parsedBy || [], action.parsedBy || [], actors),
            sourceSheet: action.sourceSheet || requirement.sourceSheet || requirement.source?.sourceSheet || row.sourceSheet || '',
            sourceRow: action.sourceRow || requirement.sourceRow || requirement.source?.sourceRow || row.sourceRow || null,
            lineNumber: action.lineNumber || requirement.lineNumber || requirement.source?.lineNumber || row.lineNumber || null,
            rawText: action.rawText || requirement.rawText || requirement.source?.rawText || row.rawText || '',
            clauseId: action.clauseId || requirement.clauseId || row.clauseId || '',
            machineRuleId: action.machineRuleId || row.machineRuleId || '',
        };
        const provenance = artifactProvenance(merged, sourcesById, actors);
        return {
            ...action,
            ...provenance,
            source: {
                ...(action.source && typeof action.source === 'object' ? action.source : {}),
                ...provenance,
            },
        };
    });
}

function mergeSystemSupplements(existing = [], requirements = [], actors = []) {
    const supplements = asList(existing).filter(item => item && typeof item === 'object');
    const seen = new Set(supplements.map(item => item.supplementId || item.requirement?.id || item.id).filter(Boolean));
    requirements.forEach((requirement, index) => {
        const normalizedRequirement = {
            ...requirement,
            origin: 'system_supplement',
            parsedBy: normalizedParsedBy(requirement.parsedBy || [], actors),
        };
        const supplementId = requirement.supplementId || `system:requirement:${requirement.id || index + 1}`;
        if (seen.has(supplementId) || (requirement.id && seen.has(requirement.id))) return;
        seen.add(supplementId);
        supplements.push({
            supplementId,
            origin: 'system_supplement',
            parsedBy: normalizedRequirement.parsedBy,
            reason: requirement.source?.rawText || requirement.reason || requirement.description || '',
            requirement: normalizedRequirement,
            machineRuleIds: normalizedTextValues(300, requirement.machineRuleIds),
        });
    });
    return supplements;
}

function uniqueConstraintMessages(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values])
        .map(value => asText(value, 500))
        .filter(Boolean))];
}

function requirementMatchesCompiledRow(requirement = {}, row = {}) {
    if (!requirement || requirement.origin === 'system_supplement') return false;
    if (artifactSourceIdentityConflicts(requirement, row)) return false;
    const ids = [requirement.id, requirement.requirementId, requirement.clauseId].filter(Boolean);
    if (row.requirementId && ids.includes(row.requirementId)) return true;
    if (row.clauseId && ids.includes(row.clauseId)) return true;
    return Boolean(requirement.rowId && requirement.rowId === row.id);
}

function requirementForCompiledRow(requirements = [], row = {}) {
    const matches = requirements.filter(requirement => requirementMatchesCompiledRow(requirement, row));
    return matches.length === 1 ? matches[0] : null;
}

function constraintArtifactFromRow(row = {}, requirement = null) {
    return {
        ...row,
        capabilityId: row.capabilityId || requirement?.capabilityId || '',
        intent: row.intent || requirement?.intent || row.type,
        object: row.object || requirement?.object,
        condition: requirement?.condition || {
            ...(row.slots?.length ? { slots: row.slots } : {}),
            ...(row.weekPattern ? { weekPattern: row.weekPattern } : {}),
        },
        parameters: {
            ...(requirement?.parameters || {}),
            ...(row.parameters || {}),
            legacyRow: { ...row },
        },
        strength: requirement?.strength || row.priority,
        applyTo: requirement?.applyTo || row.applyTo || '',
        legacyClause: requirement ? { ...requirement } : null,
    };
}

function semanticConstraintArtifact(requirement = {}) {
    return {
        ...requirement,
        requirementId: requirement.requirementId || requirement.id || '',
        legacyClause: { ...requirement },
    };
}

function ensureCapabilityArtifactSourceIdentity(artifact = {}, index = 0) {
    if (asText(artifact.sourceId || artifact.source?.sourceId || '', 300)) return artifact;
    const sourceKey = hashValue({
        id: artifact.id || artifact.requirementId || artifact.clauseId || '',
        type: artifact.type || artifact.intent || artifact.capabilityId || '',
        targetId: artifact.targetId || artifact.object?.matchedIds || '',
        targetName: artifact.targetName || artifact.object?.name || '',
        sourceSheet: artifact.sourceSheet || artifact.source?.sourceSheet || artifact.source?.sheetName || '',
        sourceRow: artifact.sourceRow || artifact.source?.sourceRow || artifact.source?.rowNumber || null,
        lineNumber: artifact.lineNumber || artifact.source?.lineNumber || null,
        rawText: artifact.rawText || artifact.source?.rawText || '',
        index,
    }, 20);
    return {
        ...artifact,
        sourceId: 'legacy:' + sourceKey,
    };
}

function fallbackConstraintArtifact(sourceRequirement = {}) {
    const source = sourceRequirement.source || {};
    return {
        sourceId: sourceRequirement.sourceId,
        textHash: source.textHash || sourceRequirement.textHash || '',
        origin: sourceRequirement.origin || 'unknown',
        parsedBy: sourceRequirement.parsedBy || [],
        intent: 'unrecognized',
        object: { kind: 'global', name: '' },
        status: 'needs_review',
        rawText: source.rawText || sourceRequirement.rawText || '',
        sourceSheet: source.sheetName || '',
        sourceRow: source.rowNumber || null,
        lineNumber: source.lineNumber || null,
        warnings: sourceRequirement.warnings || [],
        legacyClause: null,
    };
}

function mergeConstraintIR(left = {}, right = {}) {
    const preferred = left.parameters?.legacyRow ? left : right.parameters?.legacyRow ? right : left;
    return normalizeConstraintIR({
        ...preferred,
        warnings: uniqueConstraintMessages([...asList(left.warnings), ...asList(right.warnings)]),
        clarifications: uniqueConstraintMessages([...asList(left.clarifications), ...asList(right.clarifications)]),
        machineRuleIds: uniqueConstraintMessages([...asList(left.machineRuleIds), ...asList(right.machineRuleIds)]),
        parsedBy: normalizedParsedBy(left.parsedBy || [], right.parsedBy || []),
        legacyClause: preferred.legacyClause || left.legacyClause || right.legacyClause || null,
    });
}

function compactCapabilityIRs(irs = [], rows = []) {
    const removedClauseIds = new Set();
    const semanticallyUnique = [];
    const semanticIndexes = new Map();
    const semanticKey = ir => {
        const { legacyRow, selectorCurrentlyUnmatched, ...parameters } = ir.parameters || {};
        void legacyRow;
        void selectorCurrentlyUnmatched;
        return stableJson({
            sourceId: ir.sourceId,
            capabilityId: ir.capabilityId,
            intent: ir.intent,
            target: ir.target,
            scope: ir.scope,
            time: ir.time,
            relation: ir.relation,
            parameters,
            strength: ir.strength,
        });
    };
    for (const ir of irs) {
        const key = semanticKey(ir);
        const existingIndex = semanticIndexes.get(key);
        if (existingIndex === undefined) {
            semanticIndexes.set(key, semanticallyUnique.length);
            semanticallyUnique.push(ir);
            continue;
        }
        const existing = semanticallyUnique[existingIndex];
        removedClauseIds.add(ir.clauseId);
        semanticallyUnique[existingIndex] = normalizeConstraintIR({
            ...mergeConstraintIR(existing, ir),
            constraintId: existing.constraintId,
            clauseId: existing.clauseId,
            machineRuleIds: existing.machineRuleIds,
            aiReviewStatus: ir.aiReviewStatus || existing.aiReviewStatus || '',
            aiReviewIssueCode: ir.aiReviewIssueCode || existing.aiReviewIssueCode || '',
            aiReviewValidationStatus: ir.aiReviewValidationStatus || existing.aiReviewValidationStatus || '',
            aiReviewBlocking: ir.aiReviewBlocking === true || existing.aiReviewBlocking === true,
            aiReviewValidationEvidence: uniqueConstraintMessages([
                ...asList(existing.aiReviewValidationEvidence),
                ...asList(ir.aiReviewValidationEvidence),
            ]),
            aiReviewWarnings: uniqueConstraintMessages([
                ...asList(existing.aiReviewWarnings),
                ...asList(ir.aiReviewWarnings),
            ]),
        });
    }
    const kept = [];
    const sourcesWithSpecializedRoomRules = new Set(semanticallyUnique
        .filter(ir => ['room.preferred', 'room.forbidden_type'].includes(ir.capabilityId))
        .map(ir => ir.sourceId));
    const specificity = ir => {
        const parameters = ir.parameters || {};
        return [
            ...(parameters.roomIds || []),
            ...(parameters.roomRequirement?.roomIds || []),
            ...(parameters.activityTypes || []),
            ...(parameters.teacherNames || []),
            ...(parameters.requiredTags || []),
        ].length;
    };
    for (const ir of semanticallyUnique) {
        if (
            ir.capabilityId === 'room.required'
            && sourcesWithSpecializedRoomRules.has(ir.sourceId)
            && !(ir.parameters?.roomIds || []).length
            && !(ir.parameters?.roomRequirement?.roomIds || []).length
            && !(ir.parameters?.activityTypes || []).length
        ) {
            removedClauseIds.add(ir.clauseId);
            continue;
        }
        if (ir.capabilityId !== 'room.required') {
            kept.push(ir);
            continue;
        }
        const duplicateIndex = kept.findIndex(existing => (
            existing.capabilityId === ir.capabilityId
            && existing.sourceId === ir.sourceId
            && existing.target?.kind === ir.target?.kind
            && existing.target?.name === ir.target?.name
        ));
        if (duplicateIndex < 0) {
            kept.push(ir);
            continue;
        }
        const existing = kept[duplicateIndex];
        if (specificity(ir) > specificity(existing)) {
            removedClauseIds.add(existing.clauseId);
            kept[duplicateIndex] = ir;
        } else {
            removedClauseIds.add(ir.clauseId);
        }
    }
    return {
        constraintIRs: kept,
        rows: rows.filter(row => !removedClauseIds.has(row.clauseId)),
    };
}

const INTERNAL_OBJECT_NAMES = new Set([
    'unsupported',
    'need_review',
    'needs_review',
    'unknown',
    'requirement',
    'schedule_request',
]);
const OBSOLETE_EXECUTABLE_WARNING_PATTERNS = [
    /当前求解器只支持全部教师级空堂权重/,
    /需求语义和适用范围已保留，但当前求解器不能安全执行/,
    /当前版本只能预览这类建议，暂不会写入排课规则/,
];

function usableSemanticObject(object = null) {
    if (!object || typeof object !== 'object') return false;
    const name = asText(object.name || object.label || '', 120).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return Boolean(name && !INTERNAL_OBJECT_NAMES.has(name));
}

function aiReviewBlocksAutomaticApplication(artifact = {}) {
    return artifact.aiReviewBlocking === true
        && asText(artifact.aiReviewValidationStatus || '', 40).toLowerCase() === 'blocking';
}

function resolvedReferenceWarnings(ir = {}) {
    const references = asList(ir.entityReferences);
    const fullyResolved = references.length
        && references.every(reference => reference.status === 'matched')
        && !asList(ir.referenceIssues).length;
    if (!fullyResolved) return asList(ir.warnings);
    return asList(ir.warnings).filter(warning => !/存在多个候选.*确认后再生效/.test(String(warning || '')));
}

function staleResolvedReferenceReview(row = {}, ir = {}) {
    const references = asList(ir.entityReferences);
    return row.status === 'needs_review'
        && Boolean(row.ambiguity || asList(row.ambiguities).length)
        && references.length > 0
        && references.every(reference => reference.status === 'matched')
        && !asList(ir.referenceIssues).length
        && !aiReviewBlocksAutomaticApplication(row);
}

function compileArtifactsThroughCapabilityRegistry({
    project = {},
    rows = [],
    requirementItems = [],
    sourceRequirements = [],
} = {}) {
    const requirements = asList(requirementItems)
        .filter(requirement => requirement && typeof requirement === 'object' && requirement.origin !== 'system_supplement');
    const rowList = asList(rows).filter(row => row && typeof row === 'object');
    const sourceList = asList(sourceRequirements).filter(item => item && typeof item === 'object');
    const representedRequirements = new Set();
    const rowCandidates = rowList.map((row, index) => {
        const requirement = requirementForCompiledRow(requirements, row);
        if (requirement) representedRequirements.add(requirement.id || requirement.requirementId || requirement.clauseId);
        return {
            artifact: ensureCapabilityArtifactSourceIdentity(constraintArtifactFromRow(row, requirement), index),
            originalRow: row,
        };
    });
    const semanticCandidates = requirements
        .filter(requirement => {
            const id = requirement.id || requirement.requirementId || requirement.clauseId;
            return !id || !representedRequirements.has(id);
        })
        .map((requirement, index) => ({
            artifact: ensureCapabilityArtifactSourceIdentity(semanticConstraintArtifact(requirement), rowList.length + index),
            originalRow: null,
        }));
    const candidates = [...rowCandidates, ...semanticCandidates];
    const sourceIdsWithCandidates = new Set(candidates.map(candidate => candidate.artifact.sourceId).filter(Boolean));
    for (const sourceRequirement of sourceList) {
        if (sourceIdsWithCandidates.has(sourceRequirement.sourceId)) continue;
        candidates.push({ artifact: fallbackConstraintArtifact(sourceRequirement), originalRow: null });
    }

    const compiledRows = [];
    const irById = new Map();
    for (const candidate of candidates) {
        let ir = legacyArtifactToConstraintIR(candidate.artifact, {
            registry: TIMETABLE_CAPABILITY_REGISTRY,
            parsedBy: candidate.artifact.parsedBy || [],
        });
        ir = resolveConstraintIRReferences(ir, project);
        ir = assessConstraintIRExecutionReadiness(ir, project);
        ir = normalizeConstraintIR({ ...ir, warnings: resolvedReferenceWarnings(ir) });
        const capability = resolveConstraintCapability(TIMETABLE_CAPABILITY_REGISTRY, ir);
        let outputRows = [];
        let compileWarnings = [];
        let rowCompileWarnings = [];
        let compileClarifications = [];

        if (capability?.solverSupport !== 'none' && ir.support !== 'none') {
            const compiled = compileConstraintIR(TIMETABLE_CAPABILITY_REGISTRY, ir, {
                project,
                deferEntityValidation: true,
            });
            compileWarnings = compiled.warnings || [];
            const inheritedIrWarnings = new Set(ir.warnings || []);
            const supportWarnings = new Set(compiled.supportWarnings || []);
            rowCompileWarnings = compileWarnings.filter(message => (
                !inheritedIrWarnings.has(message) && !supportWarnings.has(message)
            ));
            compileClarifications = compiled.clarifications || [];
            if (compiled.rows.length) {
                outputRows = compiled.rows;
            } else if (candidate.originalRow) {
                outputRows = [{
                    ...candidate.originalRow,
                    status: ['effective', 'ready'].includes(candidate.originalRow.status) && !compiled.valid
                        ? 'needs_review'
                        : candidate.originalRow.status,
                    generatedBy: capability ? 'capability_registry' : candidate.originalRow.generatedBy,
                    capabilityId: capability?.id || candidate.originalRow.capabilityId || '',
                    compilerVersion: capability?.version || candidate.originalRow.compilerVersion,
                    warnings: uniqueConstraintMessages([
                        ...asList(candidate.originalRow.warnings),
                        ...rowCompileWarnings,
                        ...compiled.errors.map(error => error.message),
                    ]),
                }];
            }
        } else if (candidate.originalRow && !capability) {
            outputRows = [{ ...candidate.originalRow }];
        }

        if (
            capability?.solverSupport === 'none'
            || (
                ir.support === 'none'
                && ir.executionStatus === 'unsupported_by_solver'
                && (
                    capability
                    || ir.reviewStatus === 'needs_clarification'
                    || candidate.originalRow?.executionStatus === 'unsupported_by_solver'
                )
            )
        ) outputRows = [];
        if (
            ir.executionStatus === 'blocked_by_clarification'
            && (
                candidate.artifact.needsClarification === true
                || candidate.artifact.executionStatus === 'unsupported_by_solver'
            )
        ) outputRows = [];
        outputRows = outputRows.map(row => ({
            ...row,
            status: ['blocked_by_reference', 'blocked_by_clarification'].includes(ir.executionStatus)
                ? 'needs_review'
                : ir.executionStatus === 'unsupported_by_solver'
                    ? 'unsupported'
                    : ir.executionStatus === 'partially_executable' || aiReviewBlocksAutomaticApplication(row)
                        ? 'needs_review'
                        : ir.executionStatus === 'executable' && staleResolvedReferenceReview(row, ir)
                            ? 'effective'
                            : row.status,
            capabilityId: row.capabilityId || capability?.id || ir.capabilityId,
            understandingStatus: ir.understandingStatus,
            executionStatus: ir.executionStatus,
            reviewStatus: ir.reviewStatus,
            support: ir.support,
            landing: ir.landing,
            clarifications: uniqueConstraintMessages([...asList(row.clarifications), ...compileClarifications]),
            warnings: uniqueConstraintMessages([...asList(row.warnings), ...rowCompileWarnings]),
        }));
        compiledRows.push(...outputRows);

        ir = normalizeConstraintIR({
            ...ir,
            legacyClause: candidate.artifact.legacyClause || ir.legacyClause || null,
            warnings: uniqueConstraintMessages([...asList(ir.warnings), ...compileWarnings]),
            clarifications: uniqueConstraintMessages([...asList(ir.clarifications), ...compileClarifications]),
            machineRuleIds: ['executable', 'partially_executable'].includes(ir.executionStatus)
                ? outputRows.map(row => row.machineRuleId || row.id).filter(Boolean)
                : [],
        });
        const existing = irById.get(ir.constraintId);
        irById.set(ir.constraintId, existing ? mergeConstraintIR(existing, ir) : ir);
    }

    return compactCapabilityIRs([...irById.values()], compiledRows);
}

function publicConstraintIR(input = {}, machineRuleIds = input.machineRuleIds || []) {
    const ir = normalizeConstraintIR(input);
    const { legacyRow, ...parameters } = ir.parameters || {};
    const { legacyClause, ...publicFields } = ir;
    void legacyRow;
    void legacyClause;
    return normalizeConstraintIR({
        ...publicFields,
        parameters,
        warnings: ir.executionStatus === 'executable' && ir.support === 'full'
            ? asList(ir.warnings).filter(warning => (
                !OBSOLETE_EXECUTABLE_WARNING_PATTERNS.some(pattern => pattern.test(String(warning || '')))
            ))
            : ir.warnings,
        machineRuleIds: ['executable', 'partially_executable'].includes(ir.executionStatus)
            ? normalizedTextValues(300, machineRuleIds)
            : [],
    });
}

function legacyClauseFromConstraintIR(ir = {}) {
    const legacyClause = ir.legacyClause && typeof ir.legacyClause === 'object' ? ir.legacyClause : {};
    const { legacyRow, ...parameters } = ir.parameters || {};
    const legacyRequirementId = legacyClause.id || legacyClause.requirementId || ir.clauseId;
    void legacyRow;
    return {
        ...legacyClause,
        id: legacyRequirementId,
        requirementId: legacyRequirementId,
        clauseId: ir.clauseId,
        sourceId: ir.sourceId,
        textHash: ir.textHash,
        origin: ir.origin,
        parsedBy: ir.parsedBy,
        object: usableSemanticObject(legacyClause.object) ? legacyClause.object : ir.target,
        intent: legacyClause.intent || legacyRow?.intent || legacyRow?.type || ir.intent,
        condition: legacyClause.condition || ir.time,
        parameters,
        strength: legacyClause.strength || ir.strength,
        status: legacyClause.status || (ir.reviewStatus === 'understood' ? 'actionable' : 'needs_review'),
        applyTo: legacyClause.applyTo || ir.landing[0] || 'review',
        capabilityId: ir.capabilityId,
        constraintId: ir.constraintId,
        understandingStatus: ir.understandingStatus,
        executionStatus: ir.executionStatus,
        reviewStatus: ir.reviewStatus,
        support: ir.support,
        landing: ir.landing,
        explanation: ir.explanation,
        warnings: ir.warnings,
        clarifications: ir.clarifications,
        evidence: ir.evidence,
        normalizationTrace: ir.normalizationTrace || [],
        negation: ir.negation ?? null,
        exceptions: ir.exceptions || [],
        activity: ir.activity ?? null,
        confidence: ir.confidence,
        machineRuleIds: ir.machineRuleIds,
    };
}

function compatibilityRequirementIds(artifact = {}) {
    return new Set([
        artifact.id,
        artifact.requirementId,
        artifact.clauseId,
        artifact.constraintId,
        artifact.legacyClause?.id,
        artifact.legacyClause?.requirementId,
        artifact.legacyClause?.clauseId,
    ].map(value => asText(value, 300)).filter(Boolean));
}

function compatibilityRequirementSemanticIdentity(artifact = {}) {
    const candidate = artifact.legacyClause && typeof artifact.legacyClause === 'object'
        ? artifact.legacyClause
        : artifact;
    const { legacyRow, ...parameters } = candidate.parameters || {};
    void legacyRow;
    return stableJson([
        asText(candidate.sourceId || candidate.source?.sourceId || artifact.sourceId || '', 300),
        normalizeRequirementIntentAlias(candidate.intent || candidate.type || artifact.intent || ''),
        candidate.object || candidate.target || artifact.target || {},
        candidate.condition || candidate.time || artifact.time || {},
        parameters,
        asText(candidate.strength || candidate.priority || artifact.strength || '', 40),
        normalizeRequirementApplyToAlias(candidate.applyTo || candidate.landing?.[0] || artifact.landing?.[0] || 'review'),
    ]);
}

function constraintIRForLegacyRequirement(requirement = {}, constraintIRs = [], usedIndexes = new Set()) {
    const sourceId = asText(requirement.sourceId || requirement.source?.sourceId || '', 300);
    const sameSource = constraintIRs
        .map((ir, index) => ({ ir, index }))
        .filter(({ ir, index }) => !usedIndexes.has(index)
            && (!sourceId || asText(ir.sourceId || '', 300) === sourceId));
    const requirementIds = compatibilityRequirementIds(requirement);
    const identityMatches = sameSource.filter(({ ir }) => {
        const irIds = compatibilityRequirementIds(ir);
        return [...requirementIds].some(id => irIds.has(id));
    });
    if (identityMatches.length === 1) return identityMatches[0];

    const semanticIdentity = compatibilityRequirementSemanticIdentity(requirement);
    const semanticMatches = sameSource.filter(({ ir }) => (
        compatibilityRequirementSemanticIdentity(ir) === semanticIdentity
    ));
    return semanticMatches.length === 1 ? semanticMatches[0] : null;
}

function mergeLegacyRequirementWithConstraintIR(requirement = {}, ir = {}) {
    return legacyClauseFromConstraintIR({
        ...ir,
        legacyClause: {
            ...(ir.legacyClause && typeof ir.legacyClause === 'object' ? ir.legacyClause : {}),
            ...requirement,
        },
    });
}

function mergeLegacyRequirementsWithConstraintIRs(requirements = [], constraintIRs = []) {
    const usedIndexes = new Set();
    const requirementByIRIndex = new Map();
    requirements.forEach(requirement => {
        const match = constraintIRForLegacyRequirement(requirement, constraintIRs, usedIndexes);
        if (!match) return;
        usedIndexes.add(match.index);
        requirementByIRIndex.set(match.index, requirement);
    });
    return constraintIRs.map((ir, index) => {
        const requirement = requirementByIRIndex.get(index);
        return requirement
            ? mergeLegacyRequirementWithConstraintIR(requirement, ir)
            : legacyClauseFromConstraintIR(ir);
    });
}

function rowCanOwnMachineRule(row = {}) {
    return ['executable', 'partially_executable'].includes(row.executionStatus)
        && !['needs_review', 'invalid', 'unsupported'].includes(row.status);
}

function sourceAwareParseResult(result = {}, sourceRequirements = [], { parsedBy = '' } = {}) {
    const actors = parserActors(parsedBy || result.parseSource || result.source);
    const inputSources = asList(sourceRequirements).filter(item => item && typeof item === 'object');

    if (!inputSources.length) {
        const constraintIRs = asList(result.constraintIRs).filter(ir => ir && typeof ir === 'object').map(ir => publicConstraintIR(ir));
        const requirementItems = asList(result.requirementItems).filter(requirement => requirement && typeof requirement === 'object').map(requirement => ({
            ...requirement,
            parsedBy: normalizedParsedBy(requirement.parsedBy || [], actors),
        }));
        const systemRequirements = requirementItems.filter(requirement => requirement.origin === 'system_supplement');
        const semanticActions = enrichSemanticActions(
            result.semanticActions || [],
            requirementItems,
            result.draftRows || [],
            [],
            actors
        );
        const systemSupplements = mergeSystemSupplements(result.systemSupplements || [], systemRequirements, actors);
        const warningItems = buildWarningItems({
            warnings: result.warnings || [],
            warningItems: result.warningItems || [],
            requirements: requirementItems,
            rows: result.draftRows || [],
            actors,
        });
        const parsed = {
            ...result,
            schemaVersion: SOURCE_SCHEMA_VERSION,
            sourceRequirements: [],
            systemSupplements,
            manualRequirements: result.manualRequirements || [],
            requirementItems,
            constraintIRs,
            semanticActions,
            warningItems,
            statistics: buildRequirementStatistics({
                sourceRequirements: [],
                systemSupplements,
                manualRequirements: result.manualRequirements || [],
                draftRows: result.draftRows || [],
                semanticActions,
            }),
        };
        return { ...parsed, entityResolution: buildEntityResolution(parsed) };
    }

    const linkedRequirements = [];
    const unlinkedLegacyRequirements = [];
    const systemRequirements = [];
    for (const requirement of asList(result.requirementItems).filter(item => item && typeof item === 'object')) {
        if (requirement.origin === 'system_supplement') {
            systemRequirements.push({
                ...requirement,
                origin: 'system_supplement',
                parsedBy: normalizedParsedBy(requirement.parsedBy || [], actors),
            });
            continue;
        }
        const candidate = {
            ...requirement,
            sourceId: requirement.sourceId || requirement.source?.sourceId || '',
            textHash: requirement.textHash || requirement.source?.textHash || '',
            sourceSheet: requirement.sourceSheet || requirement.source?.sourceSheet || requirement.source?.sheetName || '',
            sourceRow: requirement.sourceRow || requirement.source?.sourceRow || requirement.source?.rowNumber || null,
            lineNumber: requirement.lineNumber || requirement.source?.lineNumber || null,
            rawText: requirement.source?.rawText || requirement.rawText || '',
            parsedBy: normalizedParsedBy(requirement.parsedBy || [], actors),
        };
        const linked = linkArtifactToSource(candidate, inputSources, { parsedBy: actors[0] || '' });
        if (linked.source) {
            linkedRequirements.push(linked.artifact);
        } else {
            unlinkedLegacyRequirements.push({
                ...requirement,
                origin: requirement.origin === 'manual' ? 'manual' : 'unknown',
                parsedBy: normalizedParsedBy(requirement.parsedBy || [], actors),
                provenanceWarning: linked.reason,
            });
        }
    }

    const linkedConstraintIRs = [];
    for (const inputIR of asList(result.constraintIRs).filter(item => item && typeof item === 'object')) {
        const linked = linkArtifactToSource({
            ...inputIR,
            rawText: inputIR.rawText || inputIR.evidence?.[0]?.quote || '',
            parsedBy: normalizedParsedBy(inputIR.parsedBy || [], actors),
        }, inputSources, { parsedBy: actors[0] || '' });
        if (!linked.source) continue;
        linkedConstraintIRs.push(normalizeConstraintIR({
            ...inputIR,
            ...linked.artifact,
            constraintId: inputIR.constraintId || inputIR.clauseId,
            clauseId: inputIR.clauseId || inputIR.constraintId,
            legacyClause: inputIR.legacyClause || null,
        }));
    }

    const allManualSources = inputSources.every(item => item.origin === 'manual');
    const linkedRows = (result.draftRows || []).map(row => {
        const linked = linkArtifactToSource({
            ...row,
            parsedBy: normalizedParsedBy(row.parsedBy || [], actors),
        }, inputSources, { parsedBy: actors[0] || '' });
        return linked.source ? linked.artifact : {
            ...row,
            origin: row.origin || (allManualSources ? 'manual' : 'unknown'),
            parsedBy: normalizedParsedBy(row.parsedBy || [], actors),
            provenanceWarning: linked.reason,
        };
    });

    const constraintClauses = mergeLegacyRequirementsWithConstraintIRs(linkedRequirements, linkedConstraintIRs);
    const machineRows = linkedRows.filter(row => (
        row.origin !== 'system_supplement' && rowCanOwnMachineRule(row)
    ));
    const reviewRows = linkedRows.filter(row => (
        row.origin !== 'system_supplement' && !rowCanOwnMachineRule(row)
    ));
    const canonicalSources = inputSources.map(source => ({
        ...source,
        clauses: [],
        machineRuleIds: [],
    }));
    const attached = attachArtifactsToSourceRequirements(canonicalSources, {
        clauses: constraintClauses,
        machineRules: machineRows,
        parsedBy: actors[0] || '',
    });
    const machineRuleCandidates = [
        ...attached.machineRules.map(row => ({
            ...row,
            machineRuleId: row.machineRuleId || row.id,
            generatedBy: row.generatedBy || 'legacy_timetable_parser',
            compilerVersion: row.compilerVersion || 1,
        })),
        ...reviewRows,
    ];
    const finalRows = [];
    const finalRowIndexes = new Map();
    const statusRank = status => ({ effective: 5, ready: 5, actionable: 4, suggestion: 3, needs_review: 2, unsupported: 1 }[status] || 0);
    for (const row of machineRuleCandidates) {
        const key = JSON.stringify([
            row.sourceId || '', row.clauseId || '', row.type || '',
            row.targetId || row.teacherId || row.classId || row.subjectId || row.targetName || '',
            [...new Set(asList(row.slots))].sort(), row.limit ?? row.minGapDays ?? null,
        ]);
        const existingIndex = finalRowIndexes.get(key);
        if (existingIndex === undefined) {
            finalRowIndexes.set(key, finalRows.length);
            finalRows.push(row);
        } else if (statusRank(row.status) > statusRank(finalRows[existingIndex].status)) {
            finalRows[existingIndex] = row;
        }
    }
    const machineRuleIdsByClause = new Map();
    for (const row of finalRows) {
        const key = `${row.sourceId || ''}|${row.clauseId || ''}`;
        if (!machineRuleIdsByClause.has(key)) machineRuleIdsByClause.set(key, []);
        if (rowCanOwnMachineRule(row) && row.machineRuleId) {
            machineRuleIdsByClause.get(key).push(row.machineRuleId);
        }
    }
    const finalizedInternalConstraintIRs = linkedConstraintIRs.map(ir => ({
        ...ir,
        machineRuleIds: ir.executionStatus === 'unsupported_by_solver'
            ? []
            : uniqueConstraintMessages(machineRuleIdsByClause.get(`${ir.sourceId}|${ir.clauseId}`) || []),
    }));
    const finalizedConstraintIRs = finalizedInternalConstraintIRs.map(ir => publicConstraintIR(ir));
    const finalizedIRByClause = new Map(finalizedInternalConstraintIRs.map(ir => [`${ir.sourceId}|${ir.clauseId}`, ir]));
    const irsBySource = new Map();
    for (const ir of finalizedConstraintIRs) {
        if (!irsBySource.has(ir.sourceId)) irsBySource.set(ir.sourceId, []);
        irsBySource.get(ir.sourceId).push(ir);
    }
    const statusAwareSources = attached.sourceRequirements.map(sourceRequirement => {
        const sourceIRs = irsBySource.get(sourceRequirement.sourceId) || [];
        if (!sourceIRs.length) return sourceRequirement;
        const aggregate = aggregateConstraintIRStatuses(sourceIRs);
        return {
            ...sourceRequirement,
            ...aggregate,
            reviewStatus: aggregate.reviewStatus,
            status: aggregate.reviewStatus,
            clauses: (sourceRequirement.clauses || []).map(clause => {
                const ir = finalizedIRByClause.get(`${sourceRequirement.sourceId}|${clause.clauseId || clause.id || ''}`);
                return ir ? legacyClauseFromConstraintIR(ir) : clause;
            }),
            machineRuleIds: uniqueConstraintMessages(finalRows
                .filter(row => row.sourceId === sourceRequirement.sourceId)
                .map(row => row.machineRuleId)),
            warnings: uniqueConstraintMessages([
                ...asList(sourceRequirement.warnings),
                ...sourceIRs.flatMap(ir => ir.warnings || []),
            ]),
            questions: uniqueConstraintMessages([
                ...asList(sourceRequirement.questions),
                ...sourceIRs.flatMap(ir => ir.clarifications || []),
            ]),
        };
    });
    const finalSources = aggregateSourceWarnings(statusAwareSources, finalRows, result.warningItems || [])
        .map(finalizeSourceRequirementPresentation);
    const sourceLegacyRequirements = buildLegacyRequirementItemsFromSources(finalSources);
    const requirementItems = dedupeRequirements([
        ...sourceLegacyRequirements,
        ...unlinkedLegacyRequirements,
        ...systemRequirements,
    ]);
    const semanticActions = enrichSemanticActions(
        result.semanticActions || [],
        requirementItems,
        finalRows,
        finalSources,
        actors
    );
    const systemSupplements = mergeSystemSupplements(
        result.systemSupplements || [],
        systemRequirements,
        actors
    );
    const manualRequirements = finalSources.filter(item => item.origin === 'manual');
    const warningItems = buildWarningItems({
        warnings: result.warnings || [],
        warningItems: result.warningItems || [],
        sourceRequirements: finalSources,
        requirements: requirementItems,
        rows: finalRows,
        actors,
    });
    const statistics = buildRequirementStatistics({
        sourceRequirements: finalSources,
        systemSupplements,
        manualRequirements: [],
        machineRules: finalRows.filter(rowCanOwnMachineRule),
        draftRows: finalRows,
        semanticActions,
    });
    const parsed = {
        ...result,
        schemaVersion: SOURCE_SCHEMA_VERSION,
        sourceRequirements: finalSources,
        systemSupplements,
        manualRequirements,
        draftRows: finalRows,
        constraintIRs: finalizedConstraintIRs,
        requirementItems,
        semanticActions,
        warningItems,
        statistics,
    };
    return { ...parsed, entityResolution: buildEntityResolution(parsed) };
}

function aiReviewStatusPayload({
    status = 'unavailable',
    reason = '',
    model = '',
    reviewItems = [],
    warnings = [],
    appliedSuggestionCount = 0,
    flaggedCount = 0,
    acceptedCount = 0,
    advisoryCount = 0,
    blockingCount = 0,
} = {}) {
    return {
        status,
        reason: asText(reason, 120),
        model: asText(model, 120),
        reviewedAt: new Date().toISOString(),
        warningCount: warnings.length,
        flaggedCount,
        appliedSuggestionCount,
        acceptedCount,
        correctedCount: appliedSuggestionCount,
        advisoryCount,
        blockingCount,
        reviewItems,
    };
}

function aiAssistancePayload({ mode = 'targeted_review', reviewItems = [], correctedCount = 0 } = {}) {
    return {
        mode,
        acceptedCount: reviewItems.filter(item => item.validationStatus === 'accepted').length,
        correctedCount,
        advisoryCount: reviewItems.filter(item => item.validationStatus === 'advisory').length,
        blockingCount: reviewItems.filter(item => item.validationStatus === 'blocking' && item.blocking === true).length,
    };
}

function withAiReviewUnavailable(result = {}, reason = 'ai_not_configured', message = 'AI 复审不可用，已返回本地识别结果。') {
    const warning = asText(message, 240);
    return {
        ...result,
        warnings: [...new Set([...asList(result.warnings), warning].filter(Boolean))],
        aiReview: aiReviewStatusPayload({
            status: reason === 'disabled' ? 'skipped' : 'unavailable',
            reason,
            warnings: warning ? [warning] : [],
        }),
        aiAssistance: aiAssistancePayload({ mode: 'local_fallback' }),
    };
}

function asText(value, max = 4000) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function cleanRulePromptText(value = '') {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/\r\n?/g, '\n')
        .trim();
}

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function resolveAiConfig(env = {}) {
    const apiKey = String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim();
    const baseUrl = normalizeBaseUrl(env.DEEPSEEK_API_BASE || env.OPENAI_API_BASE || 'https://api.deepseek.com');
    const model = String(env.DEEPSEEK_MODEL || env.OPENAI_MODEL || env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat').trim();
    if (!apiKey) {
        throw new TimetableRuleParseError('智能约束解析未配置，请先配置 API Key。', 'ai_not_configured', 503);
    }
    return { apiKey, baseUrl, model };
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimetableRuleParseError('当前环境没有可用 fetch，无法调用智能解析。', 'missing_fetch', 503);
}

function decodeXml(value = '') {
    return String(value)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function xmlAttrs(value = '') {
    return Object.fromEntries([...String(value).matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function readEntry(zip, name) {
    const entry = zip.getEntry(name);
    return entry ? zip.readAsText(entry, 'utf8') : '';
}

function parseSharedStrings(xml = '') {
    const values = [];
    for (const match of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
        const text = [...match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
            .map(item => decodeXml(item[1]))
            .join('');
        values.push(asText(text, 1000));
    }
    return values;
}

function columnIndex(ref = '') {
    const letters = String(ref).replace(/\d+/g, '');
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    return index - 1;
}

function worksheetRows(xml = '', sharedStrings = []) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const row = [];
        for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            const attrs = xmlAttrs(cellMatch[1]);
            const ref = attrs.r || 'A1';
            const cellXml = cellMatch[2];
            const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
            const inline = [...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(item => decodeXml(item[1])).join('');
            const text = attrs.t === 's' ? sharedStrings[Number(value)] : inline || value;
            row[columnIndex(ref)] = asText(text, 1000);
        }
        if (row.some(Boolean)) rows.push(row.map(value => value || ''));
    }
    return rows;
}

function workbookSheets(file = {}) {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length <= 0) {
        throw new TimetableRuleParseError('上传的约束文件为空。', 'empty_file', 400);
    }
    if (file.buffer.length > MAX_RULE_FILE_BYTES) {
        throw new TimetableRuleParseError('约束文件不能超过 5MB。', 'file_too_large', 413);
    }

    const zip = new AdmZip(file.buffer);
    const sharedStrings = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml'));
    const workbookXml = readEntry(zip, 'xl/workbook.xml');
    const relsXml = readEntry(zip, 'xl/_rels/workbook.xml.rels');
    const rels = {};
    for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
        const attrs = xmlAttrs(match[1]);
        if (attrs.Id && attrs.Target) rels[attrs.Id] = attrs.Target;
    }

    const sheets = [];
    for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
        const attrs = xmlAttrs(match[1]);
        const target = rels[attrs['r:id']];
        if (!target) continue;
        const entryName = target.startsWith('xl/') ? target : `xl/${target.replace(/^\/+/, '')}`;
        const xml = readEntry(zip, entryName);
        if (xml) sheets.push({ name: attrs.name || `Sheet${sheets.length + 1}`, rows: worksheetRows(xml, sharedStrings) });
    }

    if (!sheets.length) {
        for (const entry of zip.getEntries().filter(item => /^xl\/worksheets\/sheet\d+\.xml$/.test(item.entryName))) {
            sheets.push({
                name: `Sheet${sheets.length + 1}`,
                rows: worksheetRows(zip.readAsText(entry, 'utf8'), sharedStrings),
            });
        }
    }
    if (!sheets.length) throw new TimetableRuleParseError('Excel 文件里没有可读取的工作表。', 'empty_file', 400);
    return sheets;
}

function normalizeHeader(value) {
    const text = asText(value, 120).toLowerCase();
    if (/^(id|编号|序号)$/.test(text)) return 'id';
    if (/年级|grade/.test(text)) return 'grade';
    if (/班级|class/.test(text)) return 'className';
    if (/课程|科目|学科|subject|course/.test(text)) return 'subjectName';
    if (/教师|老师|teacher/.test(text)) return 'teacherName';
    if (/周课时|课时|hours|hour/.test(text)) return 'weeklyHours';
    if (/连堂|block/.test(text)) return 'blockPreference';
    if (/自然语言|可复制给ai|约束描述|约束内容|constraint|request|prompt|natural/.test(text)) return 'constraintText';
    if (/约束名称|规则名称|rule name|name/.test(text)) return 'ruleName';
    if (/约束类型|规则类型|类型|type/.test(text)) return 'ruleType';
    if (/对象范围|对象|目标|target|scope/.test(text)) return 'target';
    if (/适用周几|周几|星期|weekday|day/.test(text)) return 'days';
    if (/适用节次|节次|period|time/.test(text)) return 'periods';
    if (/slot|时间格|时间/.test(text)) return 'slots';
    if (/强度|优先级|priority|hard|soft/.test(text)) return 'priority';
    if (/建议权重|权重|weight/.test(text)) return 'weight';
    if (/建议状态|状态|status/.test(text)) return 'enabled';
    if (/生成依据|依据|原因|说明|备注|reason|note|description/.test(text)) return 'description';
    return null;
}

function headerInfo(rows = []) {
    let best = { rowIndex: -1, header: [], score: 0 };
    rows.slice(0, 12).forEach((row, rowIndex) => {
        const header = row.map(normalizeHeader);
        const score = header.filter(Boolean).length;
        if (score > best.score) best = { rowIndex, header, score };
    });
    return best;
}

function scoreConstraintSheet(sheet = {}) {
    const info = headerInfo(sheet.rows || []);
    const keys = new Set(info.header.filter(Boolean));
    const headerScore = [
        'constraintText',
        'ruleName',
        'ruleType',
        'target',
        'days',
        'periods',
        'priority',
    ].filter(key => keys.has(key)).length;
    const nameScore = /ai|约束|规则|建议|constraint|rules?|prompt/i.test(sheet.name || '') ? 3 : 0;
    const text = (sheet.rows || []).slice(0, 30).flat().map(value => asText(value, 80)).join(' ');
    const contentScore = /(约束|规则|不可排|不要排|上午优先|优先|避免|冲突|连堂|自然语言)/.test(text) ? 2 : 0;
    return { ...info, score: headerScore + nameScore + contentScore };
}

function scoreRosterSheet(sheet = {}) {
    const info = headerInfo(sheet.rows || []);
    const keys = new Set(info.header.filter(Boolean));
    const rosterScore = ['className', 'subjectName', 'teacherName', 'weeklyHours']
        .filter(key => keys.has(key)).length;
    return { ...info, score: rosterScore };
}

function classifyWorkbook(sheets = []) {
    const constraints = sheets
        .map(sheet => ({ sheet, ...scoreConstraintSheet(sheet) }))
        .sort((left, right) => right.score - left.score)[0];
    const roster = sheets
        .map(sheet => ({ sheet, ...scoreRosterSheet(sheet) }))
        .sort((left, right) => right.score - left.score)[0];

    if (constraints && constraints.score >= 4) {
        return { inputType: 'xlsx_constraints', sheet: constraints.sheet, header: constraints.header, headerRowIndex: constraints.rowIndex };
    }
    if (roster && roster.score >= 3) {
        return { inputType: 'xlsx_roster', sheet: roster.sheet, header: roster.header, headerRowIndex: roster.rowIndex };
    }
    if (constraints && constraints.score >= 2) {
        return { inputType: 'xlsx_constraints', sheet: constraints.sheet, header: constraints.header, headerRowIndex: constraints.rowIndex };
    }
    throw new TimetableRuleParseError('无法识别 Excel 内容，请上传任课表、智能约束清单或文本约束文件。', 'unknown_xlsx_shape', 400);
}

function rowsToObjects(rows = [], header = null, headerRowIndex = null, sheetName = '') {
    const info = header ? { header, rowIndex: headerRowIndex ?? 0 } : headerInfo(rows);
    const start = info.rowIndex >= 0 ? info.rowIndex + 1 : 0;
    if (info.score <= 0) {
        return rows.map((row, index) => ({
            sourceRow: index + 1,
            sourceSheet: sheetName,
            constraintText: row.map(value => asText(value, 300)).filter(Boolean).join('；'),
        })).filter(item => item.constraintText);
    }
    return rows.slice(start)
        .map((row, index) => {
            const item = { sourceRow: start + index + 1, sourceSheet: sheetName };
            info.header.forEach((key, columnIndex) => {
                if (key) item[key] = row[columnIndex];
            });
            if (!item.constraintText) {
                item.constraintText = row.map(value => asText(value, 240)).filter(Boolean).join('；');
            }
            return item;
        })
        .filter(item => Object.values(item).some(value => asText(value, 200)));
}

function constraintsTextFromSheet({ sheet, header, headerRowIndex }) {
    const rows = rowsToObjects(sheet.rows || [], header, headerRowIndex, sheet.name || '');
    const items = rows.map(item => {
        const direct = asText(item.constraintText, 1500);
        if (direct) return direct;
        return [
            item.ruleName ? `名称：${item.ruleName}` : '',
            item.ruleType ? `类型：${item.ruleType}` : '',
            item.target ? `对象：${item.target}` : '',
            item.days ? `周几：${item.days}` : '',
            item.periods ? `节次：${item.periods}` : '',
            item.slots ? `时间：${item.slots}` : '',
            item.priority ? `强度：${item.priority}` : '',
            item.description ? `说明：${item.description}` : '',
        ].filter(Boolean).join('；');
    }).filter(Boolean);
    if (!items.length) {
        throw new TimetableRuleParseError('约束清单里没有可解析的规则文本。', 'empty_prompt', 400);
    }
    return {
        text: items.map((item, index) => `${index + 1}. ${item}`).join('\n'),
        rows,
    };
}

function textFromConstraintRows(rows = []) {
    return asList(rows)
        .filter(item => item && typeof item === 'object')
        .map((item, index) => {
            const direct = asText(item.constraintText || item.rawText, 1500);
            const text = direct || [
                item.ruleName ? `名称：${item.ruleName}` : '',
                item.ruleType ? `类型：${item.ruleType}` : '',
                item.target ? `对象：${item.target}` : '',
                item.days ? `周几：${item.days}` : '',
                item.periods ? `节次：${item.periods}` : '',
                item.slots ? `时间：${item.slots}` : '',
                item.priority ? `强度：${item.priority}` : '',
                item.description ? `说明：${item.description}` : '',
            ].filter(Boolean).join('；');
            return text ? `${index + 1}. ${text}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function normalizeConstraintType(value) {
    const text = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    const compact = text.replace(/\s+/g, '');
    if (['teacherunavailable', '教师不可排', '教师不排', '教师时间不可用', 'teacher_not_available'].includes(compact)) return 'teacher_unavailable';
    if (['classunavailable', '班级不可排', '班级不排', 'class_not_available'].includes(compact)) return 'class_unavailable';
    if (['globalunavailable', '全校不可排', '公共不可排', '全局不可排', 'school_unavailable'].includes(compact)) return 'global_unavailable';
    if (['subjectmorning', '课程上午优先', '主科上午', '上午优先', 'morning_subject', 'subject_prefer_morning'].includes(compact)) return 'subject_morning';
    if (['subjectafternoon', '课程下午优先', '下午优先', 'afternoon_subject', 'subject_prefer_afternoon'].includes(compact)) return 'subject_afternoon';
    if (['subjectpreferperiods', 'subjectpreferredperiods', '课程偏好节次', '课程优先节次', 'subject_prefer_periods', 'subject_preferred_slots'].includes(compact)) return 'subject_preferred_periods';
    if (['subjectavoidperiods', '课程避开节次', 'subject_avoid_slots'].includes(compact)) return 'subject_avoid_periods';
    if (/课程.*每[天日].*(最多|上限|不超过)|subject.*dail?y?.*(limit|max)/.test(text)) return 'subject_daily_limit';
    if (/教师.*每[天日].*(最多|上限|不超过)|teacher.*dail?y?.*(limit|max)/.test(text)) return 'teacher_daily_limit';
    if (/教师.*(连续|连堂|连排).*(最多|上限|不超过|限制)|teacher.*consecutive/.test(text)) return 'teacher_consecutive_limit';
    // “教师每周最多天数”必须先于宽泛的“教师每周上限”判断，否则会被误识别为周课时上限。
    if (/教师.*(?:每周)?.*(?:最多|上限|不超过).*(?:天数|[天日])|teacher.*max.*days/.test(text)) return 'teacher_max_days_per_week';
    if (/教师.*每周.*(?:最多|上限|不超过).*(?:课时|节)|teacher.*week.*(?:lesson|hour|period)?.*(limit|max)/.test(text)) return 'teacher_weekly_limit';
    if (/教师.*每周.*(最多|上限|不超过)/.test(text)) return 'teacher_weekly_limit';
    if (/教师.*(互斥|不能同时|错开)|mutual.*exclusion/.test(text)) return 'teacher_mutual_exclusion';
    if (/(同科|同一?门?课|同学科).*(分散|不要?连?排?在?同一?天|错开)|subject.*spread/.test(text)) return 'subject_spread';
    if (/课程.*间隔|course.*interval/.test(text)) return 'course_interval';
    // Preserve semantic-only room intents before the broad room matcher below.
    if (['roompreferred', 'room_preferred', 'preferred_room', 'room.preferred'].includes(compact)) return 'room_preferred';
    if (['roomforbiddentype', 'room_forbidden_type', 'forbidden_room_type', 'room.forbidden_type'].includes(compact)) return 'room_forbidden_type';
    if (/教室|场地|实验室|机房|room/.test(text)) return 'room_requirement';
    if (/班级.*(每天|每日).*(均衡|平衡)|class.*daily.*balance/.test(text)) return 'class_daily_balance';
    if (/教师.*空堂|少空堂|teacher.*gap/.test(text)) return 'teacher_gap_preference';
    if (/教师.*(均衡|负载)|teacher.*load/.test(text)) return 'teacher_load_balance';
    if (/课程.*(不同天|不要同天|不能同天)|subject.*not.*same.*day/.test(text)) return 'subject_not_same_day';
    if (/课程.*顺序|先.*后|subject.*sequence/.test(text)) return 'subject_sequence';
    if (/连堂.*(保护|不可拆)|block/.test(text)) return 'block_protection';
    return text;
}

function normalizePriority(value, type) {
    const text = String(value || '').toLowerCase();
    if (/软|soft|建议/.test(text)) return 'soft';
    if (/硬|hard|必须|不可|不能/.test(text)) return 'hard';
    return String(type || '').startsWith('subject_')
        || ['class_daily_balance', 'teacher_gap_preference', 'teacher_load_balance', 'course_interval'].includes(type)
        || SUGGESTION_ONLY_TYPES.has(type)
        ? 'soft'
        : 'hard';
}

function dayNumber(value) {
    return DAY_NAME_TO_NUMBER.get(String(value || '').trim()) || null;
}

function uniqueNumbers(values = []) {
    return [...new Set(values.map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value)))]
        .sort((left, right) => left - right);
}

function parseLooseNumber(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{1,2}$/.test(text)) return Number.parseInt(text, 10);
    if (CHINESE_NUMBER_TO_VALUE.has(text)) return CHINESE_NUMBER_TO_VALUE.get(text);
    if (text === '十') return 10;
    const tenIndex = text.indexOf('十');
    if (tenIndex >= 0) {
        const left = text.slice(0, tenIndex);
        const right = text.slice(tenIndex + 1);
        const tens = left ? CHINESE_NUMBER_TO_VALUE.get(left) : 1;
        const ones = right ? CHINESE_NUMBER_TO_VALUE.get(right) : 0;
        if (Number.isInteger(tens) && Number.isInteger(ones)) return tens * 10 + ones;
    }
    return null;
}

function constraintLimitFromText(type, value = '') {
    const text = asText(value, 1500);
    if (!text) return undefined;
    const token = `(${NUMBER_TOKEN_PATTERN})`;
    const patterns = {
        teacher_daily_limit: [
            `(?:日课量|每日课量|每天课量|单日课量|一天课量)[^，。;；]{0,30}?(?:最多|顶多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*(?:上|排|安排)?\\s*${token}\\s*(?:节|堂|课时)?`,
            `(?:每天|每日|一天|单日)[^，。;；]{0,24}?(?:最多|顶多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*(?:上|排|安排)?\\s*${token}\\s*(?:节|堂|课时)`,
        ],
        teacher_consecutive_limit: [
            `(?:连续|连排|连堂)[^，。;；]{0,24}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:节|课时)`,
        ],
        teacher_weekly_limit: [
            `(?:周课时|每周课时|一周课时)[^，。;；]{0,24}?(?:有|为|是|最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)?\\s*${token}\\s*(?:节|课时)`,
            `每周[^，。;；]{0,24}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:节|课时)`,
        ],
        teacher_max_days_per_week: [
            `(?:集中(?:在|到)|控制在|压缩在|安排在)?\\s*每周\\s*${token}\\s*(?:天|日)(?:内|以内)?`,
            `每周[^，。;；]{0,20}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:天|日)`,
            `(?:这周|本周|一周|每周)[^，。;；]{0,20}?(?:只来|只在|只能来|到校|来校)\\s*${token}\\s*(?:天|日)`,
        ],
        subject_daily_limit: [
            `(?:每天|每日|一天|单日)[^，。;；]{0,24}?(?:最多|上限(?:为|是)?|不超过|不要超过|不多于|至多)\\s*${token}\\s*(?:节|课时)`,
        ],
    };
    for (const pattern of patterns[type] || []) {
        const match = text.match(new RegExp(pattern));
        const parsed = match ? parseLooseNumber(match[1]) : null;
        if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return undefined;
}

function expandRange(left, right, max = 12) {
    const startValue = parseLooseNumber(left);
    const endValue = parseLooseNumber(right);
    const start = Math.max(1, Number.parseInt(startValue, 10));
    const end = Math.min(max, Number.parseInt(endValue, 10));
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    const [from, to] = start <= end ? [start, end] : [end, start];
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function dayPartName(text = '') {
    if (/上午|早上|morning/i.test(text)) return 'morning';
    if (/下午|后半天|afternoon/i.test(text)) return 'afternoon';
    if (/晚间|晚上|晚自习|夜自习|evening|night/i.test(text)) return 'evening';
    return '';
}

function hasExplicitDayExpression(text = '') {
    const value = asText(text, 300);
    return /(?:每周|周|星期|礼拜)[一二三四五六日天1-7]|工作日|全周|每天|每日|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(value);
}

function hasExplicitPeriodExpression(text = '') {
    const value = asText(text, 300);
    const rangePattern = new RegExp(`第?\\s*${NUMBER_TOKEN_PATTERN}\\s*[-~到至]\\s*第?\\s*${NUMBER_TOKEN_PATTERN}\\s*节?`);
    const singlePattern = new RegExp(`第\\s*${NUMBER_TOKEN_PATTERN}\\s*节|${NUMBER_TOKEN_PATTERN}\\s*节`);
    const relativeCountPattern = new RegExp(`(?:前|头|开头|最前|后|最后|末|末尾|尾|倒数)\\s*${NUMBER_TOKEN_PATTERN}\\s*节`);
    const relativeIndexPattern = new RegExp(`倒数\\s*第\\s*${NUMBER_TOKEN_PATTERN}\\s*节|(?:末节|尾节|首节|头节)`);
    return rangePattern.test(value)
        || singlePattern.test(value)
        || relativeCountPattern.test(value)
        || relativeIndexPattern.test(value);
}

function parseDays(value, project, fallback = []) {
    if (Array.isArray(value)) return uniqueNumbers(value);
    const text = asText(value, 300);
    if (!text) return [...fallback];
    if (/全部|全周|每天|all/i.test(text)) return getActiveWeekdays(project);
    if (/工作日|周一.?周五|周一到周五|monday.?friday/i.test(text)) return getActiveWeekdays(project).filter(day => day <= 5);
    const values = [];
    for (const match of text.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/gi)) {
        const number = ENGLISH_DAY_NAME_TO_NUMBER.get(match[1].toLowerCase());
        if (number) values.push(number);
    }
    for (const range of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7])\s*[-~到至]\s*(?:周|星期|礼拜)?([一二三四五六日天1-7])/g)) {
        const start = dayNumber(range[1]);
        const end = dayNumber(range[2]);
        if (start && end) values.push(...expandRange(start, end, 7));
    }
    for (const match of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天1-7])/g)) {
        const number = dayNumber(match[1]);
        if (number) values.push(number);
    }
    if (!values.length && /^[1-7](?:[,，、\s]+[1-7])*$/.test(text)) {
        values.push(...text.split(/[,，、\s]+/).map(item => Number.parseInt(item, 10)));
    }
    return uniqueNumbers(values.length ? values : fallback);
}

function parsePeriods(value, project, fallback = []) {
    if (Array.isArray(value)) return uniqueNumbers(value);
    const text = asText(value, 300);
    if (!text) return [...fallback];
    const active = getActivePeriods(project);
    const maxPeriod = Math.max(...active, 12);
    const values = [];
    const consumedRanges = [];
    if (/全部|全日|all/i.test(text)) return active;

    const consume = match => {
        if (Number.isInteger(match.index)) consumedRanges.push([match.index, match.index + match[0].length]);
    };
    const periodBase = (match, requiredCount = 1) => {
        const part = dayPartName(match[0]);
        const partPeriods = part ? getDayPartPeriods(project, part) : [];
        return partPeriods.length >= requiredCount ? partPeriods : active;
    };

    const reverseIndexPattern = new RegExp(`(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\\s*倒数\\s*第\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'gi');
    for (const match of text.matchAll(reverseIndexPattern)) {
        const indexFromEnd = parseLooseNumber(match[1]);
        const base = periodBase(match, indexFromEnd);
        if (Number.isInteger(indexFromEnd) && indexFromEnd > 0 && indexFromEnd <= base.length) {
            values.push(base[base.length - indexFromEnd]);
        }
        consume(match);
    }

    const relativeCountPattern = new RegExp(`(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\\s*(前|头|开头|最前|后|最后|末|末尾|尾|倒数)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'gi');
    for (const match of text.matchAll(relativeCountPattern)) {
        const count = parseLooseNumber(match[2]);
        if (!Number.isInteger(count) || count <= 0) {
            consume(match);
            continue;
        }
        const base = periodBase(match, count);
        const fromStart = /^(?:前|头|开头|最前)$/.test(match[1]);
        const selected = fromStart ? base.slice(0, count) : base.slice(Math.max(0, base.length - count));
        values.push(...selected);
        consume(match);
    }

    const relativeSinglePattern = /(?:上午|早上|下午|后半天|晚间|晚上|晚自习|夜自习|morning|afternoon|evening|night)?\s*(末节|尾节|首节|头节)/gi;
    for (const match of text.matchAll(relativeSinglePattern)) {
        const base = periodBase(match);
        const fromStart = /(?:首节|头节)/.test(match[1]);
        if (base.length) values.push(fromStart ? base[0] : base[base.length - 1]);
        consume(match);
    }

    const unconsumedText = consumedRanges.length
        ? text.split('').map((char, index) => consumedRanges.some(([start, end]) => index >= start && index < end) ? ' ' : char).join('')
        : text;
    const absoluteText = unconsumedText
        .replace(/\b[A-Za-z]+\d{1,2}-\d{1,2}\s*班?/g, ' ')
        .replace(/\b\d{1,2}-\d{1,2}\s*班/g, ' ');
    const rangePattern = new RegExp(`第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*[-~到至]\\s*第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*节?`, 'g');
    for (const range of absoluteText.matchAll(rangePattern)) {
        values.push(...expandRange(range[1], range[2], maxPeriod));
    }
    const parallelPattern = new RegExp(`第\\s*${NUMBER_TOKEN_PATTERN}(?:\\s*(?:[,，、]|和|及|与)\\s*第?\\s*${NUMBER_TOKEN_PATTERN})+\\s*节`, 'g');
    for (const match of absoluteText.matchAll(parallelPattern)) {
        const tokens = match[0]
            .replace(/\s*节$/, '')
            .replace(/第/g, '')
            .split(/\s*(?:[,，、]|和|及|与)\s*/);
        for (const token of tokens) {
            const period = parseLooseNumber(token);
            if (Number.isInteger(period)) values.push(period);
        }
    }
    const singlePattern = new RegExp(`第?\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`, 'g');
    for (const match of absoluteText.matchAll(singlePattern)) {
        const token = match[1];
        const period = parseLooseNumber(token);
        if (Number.isInteger(period)) {
            values.push(period);
        } else if (/^[一二三四五六七八九]{2,}$/.test(token)) {
            values.push(...[...token].map(parseLooseNumber).filter(Number.isInteger));
        }
    }
    for (const match of absoluteText.matchAll(/\bperiod\s*(\d{1,2})\b/gi)) {
        values.push(Number.parseInt(match[1], 10));
    }
    if (!values.length && /^\d{1,2}$/.test(text)) values.push(Number.parseInt(text, 10));
    if (!values.length && dayPartName(text)) return getDayPartPeriods(project, dayPartName(text));
    return uniqueNumbers(values.length ? values : fallback);
}

function normalizeSlotList(values = []) {
    const source = typeof values === 'string'
        ? String(values || '').split(/[,，;；、\s]+/)
        : asList(values);
    const result = [];
    for (const value of source) {
        if (typeof value === 'string' && /^\d{1,2}-\d{1,2}$/.test(value.trim())) {
            const [day, period] = value.trim().split('-').map(item => Number.parseInt(item, 10));
            result.push(slotKey(day, period));
        } else if (value && Number.isInteger(Number(value.day)) && Number.isInteger(Number(value.period))) {
            result.push(slotKey(value.day, value.period));
        }
    }
    return [...new Set(result)].sort();
}

function slotsFromConstraint(constraint = {}, project = {}) {
    const direct = normalizeSlotList(constraint.slots || constraint.slotKeys || constraint.times || constraint.timeSlots);
    if (direct.length) return direct;
    const days = parseDays(constraint.days || constraint.weekdays || constraint.dayText, project, []);
    const periods = parsePeriods(constraint.periods || constraint.lessonIndexes || constraint.periodIndexes || constraint.periodText, project, []);
    if (!periods.length) return [];
    const targetDays = days.length ? days : getActiveWeekdays(project);
    const slots = [];
    for (const day of targetDays) {
        for (const period of periods) slots.push(slotKey(day, period));
    }
    return [...new Set(slots)].sort();
}

function weekPatternFromText(value = '') {
    const text = asText(value, 300);
    if (/单双周/.test(text)) return 'odd_even';
    if (/单周|奇数周|odd\s*week/i.test(text)) return 'odd';
    if (/双周|偶数周|even\s*week/i.test(text)) return 'even';
    if (/隔周|每隔一周|alternat(?:e|ing)\s*week/i.test(text)) return 'alternating';
    return '';
}

function normalizeName(value) {
    return asText(value, 120).toLowerCase().replace(/\s+/g, '');
}

function normalizeEntityName(value) {
    return normalizeName(value)
        .replace(/[·\-_/()（）【】\[\]]/g, '')
        .replace(/年级/g, '')
        .replace(/班级/g, '班');
}

function entityLabel(item = {}) {
    if (item.grade && item.name && !item.name.startsWith(item.grade)) {
        return `${item.grade}${item.name}`;
    }
    return item.name || item.id || '';
}

function entityItemsForType(project = {}, targetType = '') {
    if (targetType === 'teacher') return project.teachers || [];
    if (targetType === 'class') return project.classes || [];
    if (targetType === 'subject') return project.subjects || [];
    return [];
}

function entityNamesForMatch(item = {}, targetType = '') {
    const names = [item.id, item.name, entityLabel(item)].map(value => asText(value, 120)).filter(Boolean);
    if (targetType === 'teacher' && item.name) {
        names.push(`${item.name}老师`, `${item.name}教师`);
    }
    return [...new Set(names)];
}

function candidatePreview(item = {}, targetType = '', confidence = 0) {
    return {
        id: item.id || '',
        name: item.name || entityLabel(item) || item.id || '',
        label: targetType === 'class' ? entityLabel(item) : (item.name || entityLabel(item) || item.id || ''),
        type: targetType,
        confidence,
        score: confidence,
    };
}

function isAllTeachersTarget(row = {}) {
    const text = [
        row.targetId,
        row.targetName,
        row.target,
        row.teacherId,
        row.teacherName,
        row.teacher,
        row.rawText,
        row.description,
    ].map(value => String(value || '')).join(' ');
    return /(全部|全体|所有|每位|每个|各位|任课|任意)\s*(教师|老师)|all\s+teachers?/i.test(text);
}

function shouldNormalizeAllTeachersTarget(row = {}, type = row.type || '') {
    if (!isAllTeachersTarget(row)) return false;
    return row.targetType === 'all_teachers'
        || type === 'teacher_daily_limit'
        || type === 'teacher_consecutive_limit'
        || String(type || '').startsWith('teacher_');
}

function normalizeAllTeachersTargetRow(row = {}) {
    return {
        ...row,
        targetType: 'all_teachers',
        targetId: '__all_teachers',
        targetName: '全部教师',
        ambiguity: null,
        ambiguities: [],
    };
}

function systemHandledIntentFromText(text = '') {
    const sourceText = asText(text, 1600);
    if (SYSTEM_TEACHER_TIME_CONFLICT_PATTERN.test(sourceText)) return 'teacher_time_conflict';
    if (SYSTEM_CLASS_TIME_CONFLICT_PATTERN.test(sourceText)) return 'class_time_conflict';
    if (SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN.test(sourceText)) return 'lesson_hours_completeness';
    return '';
}

function isSystemHandledDraftRow(row = {}) {
    const text = [row.rawText, row.description, row.reason, row.constraintText, row.ruleName]
        .map(value => asText(value, 1200))
        .filter(Boolean)
        .join('。');
    if (!systemHandledIntentFromText(text)) return false;
    return ['teacher_unavailable', 'class_unavailable', 'unsupported'].includes(normalizeConstraintType(row.type || row.ruleType));
}

function matchEntityCandidates(project = {}, targetText = '', targetType = '', { targetId = '' } = {}) {
    const items = entityItemsForType(project, targetType);
    const query = asText(targetText || targetId, 160);
    if (!items.length || (!query && !targetId)) return { candidates: [], confidence: 0, targetText: query };

    const scored = new Map();
    const add = (item, confidence, matchType = 'fuzzy') => {
        if (!item?.id) return;
        const current = scored.get(item.id);
        if (!current || confidence > current.confidence) {
            scored.set(item.id, {
                ...candidatePreview(item, targetType, confidence),
                matchType,
            });
        }
    };

    const aliasMap = project.constraintEntityAliases?.[targetType] || {};
    const normalizedAliasQuery = normalizeEntityName(query);
    const aliasTargetId = Object.entries(aliasMap).find(([alias]) => (
        normalizeEntityName(alias) === normalizedAliasQuery
    ))?.[1];
    if (aliasTargetId) {
        const aliasTarget = items.find(item => item.id === aliasTargetId);
        if (aliasTarget) {
            const candidate = { ...candidatePreview(aliasTarget, targetType, 1), matchType: 'alias' };
            return { candidates: [candidate], confidence: 1, targetText: query, targetType, matchType: 'alias' };
        }
    }

    if (targetId) {
        const exactId = items.find(item => item.id === targetId);
        if (exactId) {
            // targetId 已明确指向一个实体时(如追问回填后),直接返回唯一候选
            const candidate = { ...candidatePreview(exactId, targetType, 1), matchType: 'exact' };
            return { candidates: [candidate], confidence: 1, targetText: query, targetType, matchType: 'exact' };
        }
    }

    const normalizedQuery = normalizeEntityName(query);
    for (const item of items) {
        const names = entityNamesForMatch(item, targetType);
        if (names.some(name => name === query)) add(item, 1, 'exact');
        if (normalizedQuery && names.map(normalizeEntityName).some(name => name === normalizedQuery)) add(item, 0.96, 'normalized');
    }

    if (normalizedQuery) {
        for (const item of items) {
            const names = entityNamesForMatch(item, targetType).map(normalizeEntityName).filter(Boolean);
            if (names.some(name => name.includes(normalizedQuery) || normalizedQuery.includes(name))) {
                add(item, normalizedQuery.length <= 2 ? 0.72 : 0.82, 'contains');
            }
        }
    }

    if (targetType === 'teacher' && /老师|教师/.test(query)) {
        const stem = normalizeEntityName(query.replace(/老师|教师/g, ''));
        if (stem) {
            for (const item of items) {
                const teacherName = normalizeEntityName(item.name || '');
                if (!teacherName) continue;
                if (stem.length === 1 ? teacherName.startsWith(stem) : teacherName.includes(stem)) {
                    add(item, stem.length === 1 ? 0.72 : 0.86, 'fuzzy');
                }
            }
        }
    }

    const candidates = [...scored.values()].sort((left, right) => {
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        return left.label.localeCompare(right.label, 'zh-Hans-CN');
    });
    return {
        candidates,
        confidence: candidates.length > 1 ? Math.min(candidates[0]?.confidence || 0, 0.7) : candidates[0]?.confidence || 0,
        targetText: query,
        targetType,
        matchType: candidates.length ? candidates[0].matchType || 'fuzzy' : 'none',
    };
}

function findEntity(items = [], { targetId = '', targetName = '', target = '', aliases = [] } = {}) {
    const candidates = [targetId, targetName, target, ...aliases].map(value => asText(value, 120)).filter(Boolean);
    for (const candidate of candidates) {
        const exact = items.find(item => item.id === candidate || item.name === candidate || entityLabel(item) === candidate);
        if (exact) return exact;
    }
    const normalized = candidates.map(normalizeName).filter(Boolean);
    for (const candidate of normalized) {
        const fuzzy = items.find(item => {
            const names = [item.id, item.name, entityLabel(item)].map(normalizeName);
            return names.some(name => name === candidate || name.includes(candidate) || candidate.includes(name));
        });
        if (fuzzy) return fuzzy;
    }
    return null;
}

function targetTypeFor(type, row = {}) {
    if (row.targetType) return row.targetType;
    if (type === 'teacher_unavailable') return 'teacher';
    if (type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit' || type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week') return 'teacher';
    if (type === 'teacher_gap_preference') {
        const target = asText(row.target || row.targetName || row.teacherName || row.teacher || '', 200);
        if (/(全部|所有|全体|整体).*(教师|老师)|^(全部教师|所有教师|全体教师)$/.test(target)) return 'teacher_group';
        return target ? 'teacher' : 'teacher_group';
    }
    if (type === 'class_unavailable') return 'class';
    if (type === 'locked_slot') return 'locked_slot';
    if (type === 'global_unavailable' || type === 'class_daily_balance' || type === 'teacher_load_balance' || type === 'teacher_mutual_exclusion' || type === 'subject_not_same_day' || type === 'subject_sequence') return 'global';
    if (type === 'room_requirement' || type === 'course_interval') return 'subject';
    if (type.startsWith('subject_')) return 'subject';
    return 'global';
}

function findTarget(project, row, type) {
    const targetType = targetTypeFor(type, row);
    if (targetType === 'teacher') return findEntity(project.teachers, row);
    if (targetType === 'class') return findEntity(project.classes, row);
    if (targetType === 'subject') return findEntity(project.subjects, row);
    return null;
}

function resolveEntityList(items = [], values = []) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
        const text = asText(value, 160);
        if (!text) continue;
        const match = findEntity(items, { targetId: text, targetName: text });
        if (match && !seen.has(match.id)) {
            seen.add(match.id);
            result.push(match);
        }
    }
    return result;
}

function addSlots(map, id, slots) {
    if (!id || !slots.length) return;
    map[id] = [...new Set([...(map[id] || []), ...slots])].sort();
}

function addMorningSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.morningSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.morningSubjects = current;
}

function addAfternoonSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.afternoonSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.afternoonSubjects = current;
}

function addSubjectPeriodPreference(rules, subjectId, { prefer = [], avoid = [], weight = 20, weekPattern = '' } = {}) {
    if (!subjectId) return;
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    const current = rules.softRules.subjectPreferredPeriods[subjectId] || { prefer: [], avoid: [], weight };
    rules.softRules.subjectPreferredPeriods[subjectId] = {
        prefer: [...new Set([...(current.prefer || []), ...prefer])].sort(),
        avoid: [...new Set([...(current.avoid || []), ...avoid])].sort(),
        weight: Math.max(1, Math.min(100, Number.parseInt(weight ?? current.weight ?? 20, 10) || 20)),
        ...(weekPattern ? { weekPattern: normalizeWeekPattern(weekPattern) } : current.weekPattern ? { weekPattern: current.weekPattern } : {}),
    };
}

function addTeacherLimit(rules, teacherId, { daily, consecutive } = {}) {
    if (!teacherId) return;
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    const current = { ...(rules.softRules.teacherLimits[teacherId] || {}) };
    if (Number.isInteger(daily) && daily > 0) current.daily = Math.min(12, daily);
    if (Number.isInteger(consecutive) && consecutive > 0) current.consecutive = Math.min(12, consecutive);
    if (Object.keys(current).length) rules.softRules.teacherLimits[teacherId] = current;
}

function addSpreadSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.spreadSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.spreadSubjects = current;
}

function addCourseInterval(rules, subjectId, minGapDays = 1) {
    addSpreadSubject(rules, subjectId);
    rules.softRules.spreadSubjectGaps = { ...(rules.softRules.spreadSubjectGaps || {}) };
    const gap = Math.max(1, Math.min(7, Number.parseInt(minGapDays, 10) || 1));
    const current = Number.parseInt(rules.softRules.spreadSubjectGaps[subjectId], 10);
    rules.softRules.spreadSubjectGaps[subjectId] = Number.isInteger(current) ? Math.max(current, gap) : gap;
}

function addGlobalUnavailable(rules, slots = []) {
    rules.hardRules.globalUnavailable = [...new Set([...(rules.hardRules.globalUnavailable || []), ...slots])].sort();
}

function setIntLimit(map, id, limit, min = 1, max = 40, preferLower = true) {
    const value = Number.parseInt(limit, 10);
    if (!id || !Number.isInteger(value) || value <= 0) return;
    const clamped = Math.max(min, Math.min(max, value));
    const current = Number.parseInt(map[id], 10);
    if (Number.isInteger(current)) {
        map[id] = preferLower ? Math.min(current, clamped) : Math.max(current, clamped);
    } else {
        map[id] = clamped;
    }
}

function addSubjectDailyLimit(rules, subjectId, limit) {
    rules.hardRules.subjectDailyLimit = { ...(rules.hardRules.subjectDailyLimit || {}) };
    setIntLimit(rules.hardRules.subjectDailyLimit, subjectId, limit, 1, 8, true);
}

function addTeacherWeeklyLimit(rules, teacherId, limit) {
    rules.hardRules.teacherWeeklyLimit = { ...(rules.hardRules.teacherWeeklyLimit || {}) };
    setIntLimit(rules.hardRules.teacherWeeklyLimit, teacherId, limit, 1, 40, true);
}

function addTeacherMaxDaysPerWeek(rules, teacherId, limit) {
    rules.hardRules.teacherMaxDaysPerWeek = { ...(rules.hardRules.teacherMaxDaysPerWeek || {}) };
    setIntLimit(rules.hardRules.teacherMaxDaysPerWeek, teacherId, limit, 1, 7, true);
}

function addTeacherMutualExclusion(rules, teacherIds = []) {
    const ids = normalizedTextValues(120, teacherIds).sort();
    if (ids.length < 2) return;
    const key = ids.join('|');
    const current = rules.hardRules.teacherMutualExclusion || [];
    if (!current.some(group => normalizedTextValues(120, group.teacherIds).sort().join('|') === key)) {
        current.push({ teacherIds: ids });
    }
    rules.hardRules.teacherMutualExclusion = current;
}

function addSubjectNotSameDay(rules, subjectIds = [], classIds = []) {
    const subjects = normalizedTextValues(120, subjectIds).slice(0, 2);
    if (subjects.length < 2) return;
    const classes = normalizedTextValues(120, classIds).sort();
    const key = `${subjects.slice().sort().join('|')}::${classes.join('|')}`;
    const current = rules.hardRules.subjectNotSameDay || [];
    if (!current.some(item => `${normalizedTextValues(120, item.subjectIds).sort().join('|')}::${normalizedTextValues(120, item.classIds).sort().join('|')}` === key)) {
        current.push({ subjectIds: subjects, classIds: classes });
    }
    rules.hardRules.subjectNotSameDay = current;
}

function addRoomRequirement(rules, subjectId, { roomIds = [], requiredTags = [] } = {}) {
    if (!subjectId) return;
    const rooms = [...new Set(roomIds.map(id => asText(id, 120)).filter(Boolean))];
    const tags = [...new Set(requiredTags.map(id => asText(id, 120)).filter(Boolean))];
    if (!rooms.length && !tags.length) return;
    rules.hardRules.roomRequirements = { ...(rules.hardRules.roomRequirements || {}) };
    const current = rules.hardRules.roomRequirements[subjectId] || { roomIds: [], requiredTags: [] };
    rules.hardRules.roomRequirements[subjectId] = {
        roomIds: [...new Set([...(current.roomIds || []), ...rooms])],
        requiredTags: [...new Set([...(current.requiredTags || []), ...tags])],
    };
}

function setClassDailyBalance(rules, { mainSubjectDailyMax = 0 } = {}) {
    const current = rules.softRules.classDailyBalance || {};
    rules.softRules.classDailyBalance = {
        enabled: true,
        mainSubjectDailyMax: Math.max(
            Number.parseInt(current.mainSubjectDailyMax, 10) || 0,
            Math.max(0, Math.min(8, Number.parseInt(mainSubjectDailyMax, 10) || 0)),
        ),
    };
}

function setTeacherLoadBalance(rules, weight = 1) {
    rules.softRules.teacherLoadBalance = {
        enabled: true,
        weight: Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1)),
        explicit: true,
    };
    rules.softRules.balancedTeacherLoad = true;
}

function setTeacherGapWeight(rules, weight = 1) {
    rules.softRules.teacherGapWeight = Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1));
}

function addSubjectSequence(rules, { beforeSubjectId, afterSubjectId, classIds = [], weight = 1 } = {}) {
    if (!beforeSubjectId || !afterSubjectId || beforeSubjectId === afterSubjectId) return;
    const classes = normalizedTextValues(120, classIds).sort();
    const key = `${beforeSubjectId}|${afterSubjectId}|${classes.join('|')}`;
    const current = rules.softRules.subjectSequence || [];
    if (!current.some(item => `${item.beforeSubjectId}|${item.afterSubjectId}|${normalizedTextValues(120, item.classIds).sort().join('|')}` === key)) {
        current.push({
            beforeSubjectId,
            afterSubjectId,
            classIds: classes,
            weight: Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1)),
        });
    }
    rules.softRules.subjectSequence = current;
}

function ensureComplexModel(project = {}) {
    project.timetableModelVersion = 'complex_v1';
    project.complexModelEnabled = true;
    project.campuses = asList(project.campuses).filter(item => item && typeof item === 'object');
    project.rooms = asList(project.rooms).filter(item => item && typeof item === 'object');
    project.teachingGroups = asList(project.teachingGroups).filter(item => item && typeof item === 'object');
    project.commuteRules = project.commuteRules && typeof project.commuteRules === 'object'
        ? project.commuteRules
        : { defaultGapPeriods: 1, teacherGapPeriods: {} };
    project.rules = project.rules || {};
    project.rules.softRules = project.rules.softRules || {};
}

function ensureRoom(project = {}, room = {}) {
    const name = asText(room.name || room.roomName, 120);
    const id = asText(room.id, 120) || (name ? makeTimetableId('room', name) : '');
    if (!id || !name) return null;
    project.rooms = asList(project.rooms).filter(item => item && typeof item === 'object');
    let existing = project.rooms.find(item => item.id === id || item.name === name);
    if (!existing) {
        existing = {
            id,
            name,
            campusId: asText(room.campusId || room.campus, 120),
            capacity: Number.isInteger(Number(room.capacity)) ? Number(room.capacity) : 0,
            tags: normalizedTextValues(80, room.tags, room.requiredTags),
        };
        project.rooms.push(existing);
    } else {
        existing.id = existing.id || id;
        existing.name = existing.name || name;
        if (room.campusId || room.campus) existing.campusId = asText(room.campusId || room.campus, 120);
        if (Number.isInteger(Number(room.capacity))) existing.capacity = Number(room.capacity);
        const tags = [...new Set([...(existing.tags || []), ...((room.tags || room.requiredTags || []).map(value => asText(value, 80)).filter(Boolean))])];
        existing.tags = tags;
    }
    return existing;
}

function lessonPlanTargetsForAction(project = {}, action = {}) {
    const explicitPlanIds = new Set((action.target?.lessonPlanIds || []).map(value => asText(value, 120)).filter(Boolean));
    const subjectIds = new Set((action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean));
    return (project.lessonPlans || []).filter(plan => (
        explicitPlanIds.has(plan.id)
        || (!explicitPlanIds.size && subjectIds.has(plan.subjectId))
    ));
}

function applyComplexModelPatch(project = {}, action = {}) {
    ensureComplexModel(project);
    let changed = false;
    const patch = action.patch || {};
    const targetPlans = lessonPlanTargetsForAction(project, action);

    if (patch.timetableModelVersion === 'complex_v1' || patch.complexModelEnabled === true) {
        changed = true;
    }

    if (patch.weekPattern) {
        const weekPattern = normalizeWeekPattern(patch.weekPattern);
        targetPlans.forEach(plan => {
            plan.weekPattern = weekPattern;
            changed = true;
        });
        const subjectIds = (action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean);
        if (subjectIds.length && (patch.preferredSlots?.length || patch.avoidSlots?.length)) {
            subjectIds.forEach(subjectId => addSubjectPeriodPreference(project.rules, subjectId, {
                prefer: patch.preferredSlots || [],
                avoid: patch.avoidSlots || [],
                weight: patch.weight || 30,
                weekPattern,
            }));
            changed = true;
        }
    }

    if (patch.roomRequirement && typeof patch.roomRequirement === 'object') {
        const roomIds = [...new Set([
            ...(patch.roomRequirement.preferredRoomIds || []),
            ...(patch.roomRequirement.roomIds || []),
        ].map(value => asText(value, 120)).filter(Boolean))];
        const roomName = asText(patch.roomRequirement.roomName || patch.roomRequirement.name, 120);
        if (roomName && !roomIds.length) {
            const room = ensureRoom(project, {
                id: makeTimetableId('room', roomName),
                name: roomName,
                tags: patch.roomRequirement.requiredTags || [],
                campusId: patch.roomRequirement.campusId,
                capacity: patch.roomRequirement.capacity,
            });
            if (room) roomIds.push(room.id);
        } else if (roomName && roomIds.length) {
            ensureRoom(project, {
                id: roomIds[0],
                name: roomName,
                tags: patch.roomRequirement.requiredTags || [],
                campusId: patch.roomRequirement.campusId,
                capacity: patch.roomRequirement.capacity,
            });
        }
        if (roomIds.length || patch.roomRequirement.requiredTags?.length) {
            targetPlans.forEach(plan => {
                plan.roomRequirement = {
                    ...(plan.roomRequirement || {}),
                    preferredRoomIds: [...new Set([...(plan.roomRequirement?.preferredRoomIds || []), ...roomIds])],
                    allowedRoomIds: [...new Set([...(plan.roomRequirement?.allowedRoomIds || []), ...(patch.roomRequirement.allowedRoomIds || [])])],
                    requiredTags: [...new Set([...(plan.roomRequirement?.requiredTags || []), ...(patch.roomRequirement.requiredTags || [])])],
                };
                if (roomIds[0]) {
                    plan.roomId = plan.roomId || roomIds[0];
                    plan.allowedRoomIds = [...new Set([...(plan.allowedRoomIds || []), ...roomIds])];
                }
                changed = true;
            });
        }
    }

    if (patch.teachingGroup && typeof patch.teachingGroup === 'object') {
        const classIds = normalizedTextValues(120, patch.teachingGroup.classIds);
        const subjectIds = normalizedTextValues(120, patch.teachingGroup.subjectIds, action.target?.subjectIds);
        const name = asText(patch.teachingGroup.name, 160)
            || [classIds.join('、'), subjectIds.join('、'), '教学组'].filter(Boolean).join('-');
        if (classIds.length && subjectIds.length) {
            const id = asText(patch.teachingGroup.id, 120) || makeTimetableId('tg', `${name}-${classIds.join('-')}-${subjectIds.join('-')}`);
            let group = (project.teachingGroups || []).find(item => item.id === id || item.name === name);
            if (!group) {
                group = {
                    id,
                    name,
                    mode: ['combined_class', 'rotation', 'split_class'].includes(patch.teachingGroup.mode) ? patch.teachingGroup.mode : 'combined_class',
                    classIds,
                    subjectIds,
                    teacherIds: normalizedTextValues(120, patch.teachingGroup.teacherIds),
                    roomIds: normalizedTextValues(120, patch.teachingGroup.roomIds),
                };
                project.teachingGroups.push(group);
            }
            (project.lessonPlans || [])
                .filter(plan => classIds.includes(plan.classId) && subjectIds.includes(plan.subjectId))
                .forEach(plan => {
                    plan.teachingGroupId = group.id;
                });
            changed = true;
        }
    }

    if (patch.commuteRules && typeof patch.commuteRules === 'object') {
        const defaultGap = Number.parseInt(patch.commuteRules.defaultGapPeriods ?? patch.commuteRules.defaultGap ?? patch.commuteRules.gapPeriods, 10);
        project.commuteRules = project.commuteRules || { defaultGapPeriods: 1, teacherGapPeriods: {} };
        if (Number.isInteger(defaultGap) && defaultGap >= 0) {
            project.commuteRules.defaultGapPeriods = Math.min(12, defaultGap);
            changed = true;
        }
        const teacherGapPeriods = patch.commuteRules.teacherGapPeriods || {};
        project.commuteRules.teacherGapPeriods = project.commuteRules.teacherGapPeriods || {};
        Object.entries(teacherGapPeriods).forEach(([teacherIdRaw, gapRaw]) => {
            const teacherId = asText(teacherIdRaw, 120);
            const gap = Number.parseInt(gapRaw, 10);
            if (teacherId && Number.isInteger(gap) && gap >= 0) {
                project.commuteRules.teacherGapPeriods[teacherId] = Math.min(12, gap);
                changed = true;
            }
        });
    }

    return changed;
}

function parseFirstSlot(slots = []) {
    const [first] = asList(slots);
    const match = String(first || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;
    return {
        day: Number.parseInt(match[1], 10),
        period: Number.parseInt(match[2], 10),
    };
}

function findLockedLessonPlan(project, { classId, subjectId, teacherId }) {
    return (project.lessonPlans || []).find(plan => (
        plan.classId === classId
        && plan.subjectId === subjectId
        && (plan.teacherId === teacherId || asList(plan.teacherIds).includes(teacherId))
    )) || null;
}

function addLockedSlot(rules, locked) {
    if (!locked) return;
    const keyFor = item => [
        item.day,
        item.period,
        item.classId,
        item.subjectId,
        item.teacherId,
        item.lessonPlanId || '',
    ].join('|');
    const existing = new Set((rules.hardRules.lockedSlots || []).map(keyFor));
    if (!existing.has(keyFor(locked))) rules.hardRules.lockedSlots.push(locked);
}

function normalizeDraftRow(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const slots = slotsFromConstraint(row, project);
    const rawText = asText(row.rawText || row.constraintText || row.text || row.description || row.reason || '', 2000);
    const status = STATUS_LABELS.has(row.status) ? row.status : SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : 'suggestion';
    const idList = values => normalizedTextValues(120, values);
    const numberList = values => [...new Set((Array.isArray(values) ? values : [values])
        .map(value => Number.parseInt(value, 10))
        .filter(Number.isInteger))];
    return {
        id: asText(row.id, 240) || `rule_draft_${index + 1}`,
        machineRuleId: asText(row.machineRuleId || '', 240),
        requirementId: asText(row.requirementId || '', 240),
        clauseId: asText(row.clauseId || '', 300),
        constraintId: asText(row.constraintId || '', 300),
        capabilityId: asText(row.capabilityId || '', 160),
        intent: asText(row.intent || '', 160),
        sourceId: asText(row.sourceId || '', 300),
        textHash: asText(row.textHash || '', 128),
        origin: asText(row.origin || '', 40),
        parsedBy: normalizedParsedBy(row.parsedBy),
        stableKey: asText(row.stableKey || '', 240),
        parseSource: asText(row.parseSource || row.source || '', 80),
        generatedBy: asText(row.generatedBy || '', 80),
        compilerVersion: Number.parseInt(row.compilerVersion, 10) || undefined,
        constraintIrVersion: Number.parseInt(row.constraintIrVersion, 10) || undefined,
        source: asText(row.source || row.sourceSheet || '', 120),
        sourceSheet: asText(row.sourceSheet || row.sheetName || '', 120),
        sourceRow: Number.parseInt(row.sourceRow, 10) || null,
        lineNumber: Number.parseInt(row.lineNumber, 10) || null,
        rawText,
        normalizationTrace: asList(row.normalizationTrace || row.source?.normalizationTrace)
            .filter(item => item && typeof item === 'object')
            .map(item => ({ ...item })),
        negation: row.negation && typeof row.negation === 'object' ? { ...row.negation } : (row.negation ?? null),
        exceptions: asList(row.exceptions).map(item => item && typeof item === 'object' ? { ...item } : item),
        activity: row.activity && typeof row.activity === 'object' ? { ...row.activity } : (row.activity ?? null),
        type,
        targetType: targetTypeFor(type, row),
        targetId: asText(row.targetId || row.teacherId || row.classId || row.subjectId || '', 120),
        targetName: asText(row.targetName || row.target || row.teacher || row.teacherName || row.class || row.className || row.subject || row.subjectName || '', 200),
        classId: asText(row.classId || '', 120),
        className: asText(row.className || row.class || '', 200),
        subjectId: asText(row.subjectId || '', 120),
        subjectName: asText(row.subjectName || row.subject || '', 200),
        teacherId: asText(row.teacherId || '', 120),
        teacherName: asText(row.teacherName || row.teacher || '', 200),
        teacherIds: idList(row.teacherIds || row.teachers || []),
        subjectIds: idList(row.subjectIds || row.subjects || []),
        classIds: idList(row.classIds || row.classes || []),
        gradeNames: idList(row.gradeNames || row.grades || row.parameters?.gradeNames || []),
        blockPreference: asText(row.blockPreference || row.parameters?.blockPreference || '', 40),
        minOccurrences: Number.parseInt(row.minOccurrences ?? row.parameters?.minOccurrences, 10) || undefined,
        avoidDayParts: idList(row.avoidDayParts || row.parameters?.avoidDayParts || []),
        subjectNames: idList(row.subjectNames || row.parameters?.subjectNames || []),
        activityTypes: idList(row.activityTypes || row.parameters?.activityTypes || []),
        preferredActivityTypes: idList(row.preferredActivityTypes || row.parameters?.preferredActivityTypes || []),
        requiredResourceTypes: idList(row.requiredResourceTypes || row.parameters?.requiredResourceTypes || []),
        sameDay: typeof (row.sameDay ?? row.parameters?.sameDay) === 'boolean'
            ? (row.sameDay ?? row.parameters?.sameDay)
            : undefined,
        roomIds: idList(row.roomIds || row.allowedRoomIds || row.rooms || []),
        roomName: asText(row.roomName || row.room || '', 200),
        requiredTags: idList(row.requiredTags || row.roomTags || []),
        beforeSubjectId: asText(row.beforeSubjectId || row.before || '', 120),
        afterSubjectId: asText(row.afterSubjectId || row.after || row.nextSubjectId || '', 120),
        slots,
        days: parseDays(row.days || row.weekdays || '', project, []),
        periods: parsePeriods(row.periods || row.lessonIndexes || '', project, []),
        boundaryPeriods: numberList(row.boundaryPeriods || row.parameters?.boundaryPeriods || []),
        priority: normalizePriority(row.priority || row.strength, type),
        status: status === 'ready' ? 'effective' : status,
        sourceStatus: STATUS_LABELS.has(row.status) ? row.status : '',
        confidence: row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        description: asText(row.description || row.reason || row.note || '', 500),
        warnings: normalizedMessageValues(200, row.warnings),
        clarifications: normalizedMessageValues(500, row.clarifications, row.questions),
        understandingStatus: asText(row.understandingStatus || '', 40),
        executionStatus: asText(row.executionStatus || '', 40),
        reviewStatus: asText(row.reviewStatus || '', 40),
        support: asText(row.support || '', 20),
        landing: normalizedTextValues(80, row.landing),
        scope: row.scope && typeof row.scope === 'object' ? { ...row.scope } : {},
        parameters: row.parameters && typeof row.parameters === 'object' ? { ...row.parameters } : {},
        aiReviewStatus: asText(row.aiReviewStatus || '', 40),
        aiReviewIssueCode: asText(row.aiReviewIssueCode || '', 80),
        aiReviewValidationStatus: asText(row.aiReviewValidationStatus || '', 40),
        aiReviewBlocking: row.aiReviewBlocking === true,
        aiReviewValidationEvidence: normalizedMessageValues(500, row.aiReviewValidationEvidence),
        aiReviewWarnings: normalizedMessageValues(240, row.aiReviewWarnings),
        reviewEvidence: row.reviewEvidence && typeof row.reviewEvidence === 'object'
            ? {
                quote: asText(row.reviewEvidence.quote || row.reviewEvidence.text || '', 500),
                reason: asText(row.reviewEvidence.reason || row.reviewEvidence.message || '', 500),
                sourceSheet: asText(row.reviewEvidence.sourceSheet || '', 120),
                sourceRow: Number.parseInt(row.reviewEvidence.sourceRow, 10) || null,
            }
            : null,
        reviewedParseSource: asText(row.reviewedParseSource || '', 80),
        ambiguity: row.ambiguity || null,
        ambiguities: asList(row.ambiguities)
            .filter(item => item && typeof item === 'object')
            .map(item => ({ ...item })),
        weekPattern: asText(row.weekPattern || row.week || '', 60) || weekPatternFromText(rawText),
        weight: Number.parseInt(row.weight, 10) || undefined,
        limit: Number.parseInt(row.limit ?? row.value ?? row.max ?? row.count, 10) || undefined,
        minGapDays: Number.parseInt(row.minGapDays ?? row.gapDays ?? (type === 'course_interval' ? (row.limit ?? row.value) : undefined), 10) || undefined,
    };
}

function splitGroupedTargetText(value = '') {
    const text = asText(value, 600);
    if (!/[,，、;；|\r\n]/.test(text)) return [];
    return [...new Set(text
        .split(/\s*[,，、;；|\r\n]+\s*/)
        .map(item => asText(item, 160))
        .filter(Boolean))];
}

function expandGroupedEntityTarget(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const targetType = targetTypeFor(type, row);
    if (!['teacher', 'class', 'subject'].includes(targetType)) return [row];

    const specificId = targetType === 'teacher'
        ? row.teacherId
        : targetType === 'class'
            ? row.classId
            : row.subjectId;
    if (row.targetId || specificId) return [row];

    const targetText = row.targetName
        || row.target
        || (targetType === 'teacher' ? row.teacherName || row.teacher : '')
        || (targetType === 'class' ? row.className || row.class : '')
        || (targetType === 'subject' ? row.subjectName || row.subject : '');
    const parts = splitGroupedTargetText(targetText);
    if (parts.length < 2) return [row];

    const hadGroupedAmbiguity = Boolean(row.ambiguity)
        || asList(row.ambiguities).length > 0
        || asList(row.warnings).some(warning => /多个候选|不会自动猜测/.test(String(warning || '')));
    const baseId = asText(row.id, 120) || `rule_draft_${index + 1}`;

    return parts.map((part, partIndex) => {
        const match = matchEntityCandidates(project, part, targetType);
        const exact = match.candidates.length === 1 && match.candidates[0].confidence >= 0.96
            ? match.candidates[0]
            : null;
        const next = {
            ...row,
            id: `${baseId}__${partIndex + 1}`,
            targetType,
            targetId: exact?.id || '',
            targetName: exact?.label || part,
            ambiguity: null,
            ambiguities: [],
            warnings: (row.warnings || []).filter(warning => !/多个候选|不会自动猜测/.test(String(warning || ''))),
            status: hadGroupedAmbiguity && row.status === 'needs_review' ? 'effective' : row.status,
        };

        if (targetType === 'teacher') {
            next.teacherId = exact?.id || '';
            next.teacherName = exact?.label || part;
        } else if (targetType === 'class') {
            next.classId = exact?.id || '';
            next.className = exact?.label || part;
        } else if (targetType === 'subject') {
            next.subjectId = exact?.id || '';
            next.subjectName = exact?.label || part;
        }
        return next;
    });
}

function validateTimeExpression(row = {}, project = {}) {
    const activeDays = new Set(getActiveWeekdays(project));
    const activePeriods = new Set(getActivePeriods(project));
    const invalidSlots = [];
    const slots = (row.slots || []).filter(slot => {
        const match = String(slot || '').match(/^(\d{1,2})-(\d{1,2})$/);
        if (!match) {
            invalidSlots.push(String(slot || ''));
            return false;
        }
        const day = Number.parseInt(match[1], 10);
        const period = Number.parseInt(match[2], 10);
        const valid = activeDays.has(day) && activePeriods.has(period);
        if (!valid) invalidSlots.push(slotKey(day, period));
        return true;
    });
    return {
        slots,
        invalidSlots,
        warnings: invalidSlots.length
            ? [`节次 ${invalidSlots.join('、')} 不在当前排课范围内。`]
            : [],
    };
}

function statusWithConfidence(row = {}, confidence = null) {
    if (row.status === 'ignored') return 'ignored';
    const value = row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence))
        ? Number(row.confidence)
        : confidence;
    if (Number.isFinite(value) && value < 0.85 && row.status === 'effective') return 'needs_review';
    return row.status === 'ready' ? 'effective' : row.status;
}

function rowNeedsSlots(type) {
    return ['teacher_unavailable', 'class_unavailable', 'locked_slot', 'global_unavailable', 'subject_preferred_periods', 'subject_avoid_periods'].includes(type);
}

function applySingleTarget(row, project, targetType) {
    const items = entityItemsForType(project, targetType);
    // 如果 targetId 已明确指向一个有效实体(如追问回填后),直接采用,无需模糊匹配
    if (row.targetId) {
        const directMatch = items.find(item => item.id === row.targetId);
        if (directMatch) {
            const label = directMatch.label || directMatch.name || row.targetName || row.targetId;
            const confidence = Math.max(
                row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.9,
                0.9,
            );
            return {
                ...row,
                targetType,
                targetId: directMatch.id,
                targetName: label,
                confidence,
                warnings: [...asList(row.warnings)],
                status: statusWithConfidence({ ...row, confidence }, confidence),
            };
        }
    }
    const match = matchEntityCandidates(project, row.targetName || row.targetId, targetType, { targetId: row.targetId });
    const warnings = [...asList(row.warnings)];
    const next = { ...row, targetType };

    if (match.candidates.length === 1 && (match.candidates[0].confidence || 0) >= 0.96) {
        const [candidate] = match.candidates;
        next.targetId = candidate.id;
        next.targetName = candidate.label;
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Math.min(Number(next.confidence), candidate.confidence || 1)
            : candidate.confidence || 0.9;
        return { ...next, warnings, status: statusWithConfidence(next, candidate.confidence || 0.9) };
    }

    if (match.candidates.length >= 1) {
        const ambiguity = {
            field: 'target',
            targetType,
            targetText: match.targetText || row.targetName || row.targetId || '',
            candidates: match.candidates,
        };
        warnings.push(match.candidates.length > 1
            ? `${ambiguity.targetText || '规则对象'} 存在多个候选，请确认后再生效。`
            : `${ambiguity.targetText || '规则对象'} 只有低置信候选，请确认后再生效。`);
        return {
            ...next,
            status: 'needs_review',
            confidence: Math.min(
                next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.7,
                match.confidence || 0.7,
            ),
            ambiguity,
            ambiguities: [...(next.ambiguities || []), ambiguity],
            warnings,
        };
    }

    warnings.push(`${row.targetName || row.targetId || '规则对象'} 在当前项目中没有匹配对象。`);
    return {
        ...next,
        status: 'needs_review',
        confidence: Math.min(
            next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.55,
            0.55,
        ),
        warnings,
    };
}

function matchLockedField(project, row, field, targetType, text, id = '') {
    const match = matchEntityCandidates(project, text || id, targetType, { targetId: id });
    if (match.candidates.length === 1) return { field, targetType, match: match.candidates[0] };
    return {
        field,
        targetType,
        targetText: match.targetText || text || id || '',
        candidates: match.candidates,
    };
}

function classifyDraftRow(row = {}, project = {}) {
    let next = { ...row, warnings: [...asList(row.warnings)] };
    const type = next.type;
    const time = validateTimeExpression(next, project);
    next = { ...next, slots: time.slots.length ? time.slots : next.slots, warnings: [...next.warnings, ...time.warnings] };

    if (next.status === 'ignored') return next;
    if (shouldNormalizeAllTeachersTarget(next, type)) {
        next = normalizeAllTeachersTargetRow(next);
    }
    if (!SUPPORTED_EFFECTIVE_TYPES.has(type)) {
        const status = SUGGESTION_ONLY_TYPES.has(type) ? 'suggestion' : 'unsupported';
        return {
            ...next,
            status,
            priority: normalizePriority(next.priority, type),
            warnings: status === 'unsupported'
                ? [...next.warnings, '当前版本只能预览这类建议，暂不会写入排课规则。']
                : next.warnings,
        };
    }
    if (next.status === 'suggestion') {
        next.status = 'effective';
    }

    if (time.invalidSlots.length) {
        next.status = 'invalid';
    }
    if (rowNeedsSlots(type) && !(next.slots || []).length) {
        next.status = 'needs_review';
        next.warnings.push('缺少明确节次，请补充后再生效。');
    }

    if (type === 'locked_slot') {
        const fields = [
            matchLockedField(project, next, 'teacher', 'teacher', next.teacherName || '', next.teacherId || ''),
            matchLockedField(project, next, 'class', 'class', next.className || next.targetName || '', next.classId || ''),
            matchLockedField(project, next, 'subject', 'subject', next.subjectName || '', next.subjectId || ''),
        ];
        const ambiguities = fields.filter(item => item.candidates && item.candidates.length !== 1);
        const matched = Object.fromEntries(fields.filter(item => item.match).map(item => [item.field, item.match]));

        if (ambiguities.length) {
            ambiguities.forEach(item => {
                next.warnings.push(`${item.targetText || item.field} ${item.candidates.length ? '存在多个候选' : '没有匹配对象'}，请确认。`);
            });
            return {
                ...next,
                targetType: 'locked_slot',
                status: 'needs_review',
                confidence: Math.min(
                    next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.65,
                    0.75,
                ),
                ambiguities,
                ambiguity: ambiguities[0] || null,
            };
        }

        next.teacherId = matched.teacher.id;
        next.teacherName = matched.teacher.label;
        next.classId = matched.class.id;
        next.className = matched.class.label;
        next.subjectId = matched.subject.id;
        next.subjectName = matched.subject.label;
        next.targetType = 'locked_slot';
        next.targetId = `${next.classId}:${next.subjectId}:${next.teacherId}`;
        next.targetName = `${next.className} / ${next.subjectName} / ${next.teacherName}`;
        next.priority = 'hard';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.9;
        next.status = statusWithConfidence(next, 0.9);
        return next;
    }

    if ((type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit' || type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week') && isAllTeachersTarget(next)) {
        next.targetType = 'all_teachers';
        next.targetId = '__all_teachers';
        next.targetName = '全部教师';
        next.priority = type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week' ? 'hard' : 'soft';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Number(next.confidence)
            : 0.9;
        next.status = statusWithConfidence(next, next.confidence);
    }

    const targetType = targetTypeFor(type, next);
    if (['teacher', 'class', 'subject'].includes(targetType)) {
        next = applySingleTarget(next, project, targetType);
    }

    if (['teacher_daily_limit', 'teacher_consecutive_limit', 'teacher_weekly_limit', 'teacher_max_days_per_week', 'subject_daily_limit'].includes(type)
        && (!Number.isInteger(Number(next.limit)) || Number(next.limit) <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的节数上限。');
    }
    if (type === 'course_interval' && (!Number.isInteger(Number(next.minGapDays)) || Number(next.minGapDays) <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的间隔天数。');
    }
    if (type === 'room_requirement') {
        if (!(project.rooms || []).length) {
            next.status = 'needs_review';
            next.warnings.push('项目还没录入教室，先去基础数据添加教室后才能应用教室要求。');
        }
        if (!((next.roomIds || []).length || (next.requiredTags || []).length || next.roomName)) {
            next.status = 'needs_review';
            next.warnings.push('缺少教室、场地或教室标签。');
        }
    }
    if (type === 'teacher_mutual_exclusion' && normalizedTextValues(120, next.teacherIds).length < 2) {
        next.status = 'needs_review';
        next.warnings.push('教师互斥至少需要两位教师。');
    }
    if (type === 'subject_not_same_day' && normalizedTextValues(120, next.subjectIds).length < 2) {
        next.status = 'needs_review';
        next.warnings.push('课程不同天至少需要两门课程。');
    }
    if (type === 'subject_sequence' && !(next.beforeSubjectId && next.afterSubjectId)) {
        next.status = 'needs_review';
        next.warnings.push('课程顺序需要明确先上和后上的课程。');
    }

    if (next.confidence === null || next.confidence === undefined || !Number.isFinite(Number(next.confidence))) {
        next.confidence = next.status === 'effective' ? 0.9 : next.status === 'needs_review' ? 0.65 : 0.5;
    }
    next.status = statusWithConfidence(next, Number(next.confidence));
    if (next.weekPattern) {
        if (complexModelIsEnabled(project)) {
            next.status = next.status === 'invalid' ? 'invalid' : 'effective';
            next.confidence = Math.max(Number(next.confidence) || 0.9, 0.9);
        } else {
            next.status = 'needs_review';
            if (!next.warnings.some(warning => /单双周|不会自动生效/.test(warning))) {
                next.warnings.push('当前规则模型暂不支持单双周，不会自动生效。');
            }
            next.confidence = Math.min(Number(next.confidence) || 0.65, 0.68);
        }
    }
    return next;
}

function previewFromRow(row = {}) {
    return {
        id: row.id,
        stableKey: row.stableKey || '',
        parseSource: row.parseSource || row.source || '',
        type: row.type,
        targetId: row.targetId || '',
        targetName: row.targetName || '',
        slots: row.slots || [],
        priority: row.priority || 'hard',
        description: row.description || row.rawText || '',
        status: row.status === 'effective' ? 'ready' : row.status,
        effective: row.status === 'effective',
        confidence: row.confidence,
    };
}

function emptyRulesFrom(project) {
    const rules = cloneValue(project.rules);
    rules.advancedRules = [...(rules.advancedRules || [])];
    rules.hardRules = rules.hardRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
    rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
    rules.hardRules.globalUnavailable = [...(rules.hardRules.globalUnavailable || [])];
    rules.hardRules.subjectDailyLimit = { ...(rules.hardRules.subjectDailyLimit || {}) };
    rules.hardRules.teacherWeeklyLimit = { ...(rules.hardRules.teacherWeeklyLimit || {}) };
    rules.hardRules.teacherMaxDaysPerWeek = { ...(rules.hardRules.teacherMaxDaysPerWeek || {}) };
    rules.hardRules.teacherMutualExclusion = [...(rules.hardRules.teacherMutualExclusion || [])];
    rules.hardRules.subjectNotSameDay = [...(rules.hardRules.subjectNotSameDay || [])];
    rules.hardRules.roomRequirements = { ...(rules.hardRules.roomRequirements || {}) };
    rules.softRules = rules.softRules || {};
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];
    rules.softRules.afternoonSubjects = [...(rules.softRules.afternoonSubjects || [])];
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    rules.softRules.spreadSubjects = [...(rules.softRules.spreadSubjects || [])];
    rules.softRules.spreadSubjectGaps = { ...(rules.softRules.spreadSubjectGaps || {}) };
    rules.softRules.subjectDailySoftLimit = { ...(rules.softRules.subjectDailySoftLimit || {}) };
    rules.softRules.subjectSequence = [...(rules.softRules.subjectSequence || [])];
    rules.softRules.teacherGapWeight = Number.parseInt(rules.softRules.teacherGapWeight, 10) || 0;
    rules.softRules.classDailyBalance = { ...(rules.softRules.classDailyBalance || {}) };
    rules.softRules.teacherLoadBalance = { ...(rules.softRules.teacherLoadBalance || {}) };
    return rules;
}

function previewRows(rows = []) {
    return rows.map(previewFromRow);
}

function sourceFromRow(row = {}) {
    return {
        rawText: row.rawText || row.description || '',
        source: row.source || '',
        sourceId: row.sourceId || '',
        textHash: row.textHash || '',
        origin: row.origin || 'unknown',
        parsedBy: row.parsedBy || [],
        sourceSheet: row.sourceSheet || '',
        sourceRow: row.sourceRow || null,
        lineNumber: row.lineNumber || null,
        parseSource: row.parseSource || row.source || '',
        stableKey: row.stableKey || '',
    };
}

function entityObject(kind, name = '', matchedIds = [], scope = 'explicit') {
    return {
        kind,
        name: asText(name, 200),
        matchedIds: [...new Set((Array.isArray(matchedIds) ? matchedIds : [matchedIds]).map(item => asText(item, 120)).filter(Boolean))],
        scope,
    };
}

function unsupportedComplexModelSupport(capability = '', message = '') {
    return {
        supported: false,
        capability: asText(capability, 80),
        requiredModel: 'complex_v1',
        phase: 'phase_2',
        message: asText(message || '当前需要复杂排课模型支持，暂不会自动生效。', 240),
    };
}

function complexModelIsEnabled(project = {}) {
    return project?.timetableModelVersion === 'complex_v1' || project?.complexModelEnabled === true;
}

function supportedComplexModelSupport(capability = '', message = '') {
    return {
        supported: true,
        capability: asText(capability, 80),
        requiredModel: 'complex_v1',
        phase: 'phase_2',
        message: asText(message || '已启用 complex_v1，可写入复杂排课模型字段。', 240),
    };
}

function modelSupportForRow(row = {}, project = {}) {
    if (row.weekPattern) {
        if (complexModelIsEnabled(project)) {
            return supportedComplexModelSupport('weekPattern', '已启用 complex_v1，单双周需求将写入模型字段。');
        }
        return unsupportedComplexModelSupport('weekPattern', '当前规则模型暂不支持单双周自动生效，需要 complex_v1 模型后参与求解。');
    }
    return null;
}

function rowRequirementObject(row = {}) {
    if (row.targetType === 'all_teachers' || shouldNormalizeAllTeachersTarget(row, row.type)) {
        return entityObject('teacher_group', '全部教师', ['__all_teachers'], 'group');
    }
    if (row.targetType === 'teacher_group') {
        return entityObject('teacher_group', row.targetName || '教师组', row.targetId || row.teacherIds, 'group');
    }
    if (row.targetType === 'derived_group') {
        return entityObject(
            'derived_group',
            row.targetName || row.target || '派生课程组',
            row.targetId || row.subjectIds || row.subjectNames,
            'group',
        );
    }
    if (row.targetType === 'class_group') {
        return entityObject('class_group', row.targetName || '班级组', row.targetId || row.classIds, 'group');
    }
    if (row.targetType === 'grade') {
        return entityObject('grade', row.targetName || row.gradeName || '年级', row.targetId || row.gradeIds || row.gradeNames);
    }
    if (row.targetType === 'teaching_group') {
        return entityObject(
            'teaching_group',
            row.targetName || row.target || row.subjectNames?.join('、') || '教研组',
            row.targetId || row.subjectIds || row.teacherIds,
            'group',
        );
    }
    if (row.targetType === 'teacher') return entityObject('teacher', row.targetName || row.teacherName || '教师', row.targetId || row.teacherId);
    if (row.targetType === 'class') return entityObject('class', row.targetName || row.className || '班级', row.targetId || row.classId);
    if (row.targetType === 'subject') return entityObject('subject', row.targetName || row.subjectName || '课程', row.targetId || row.subjectId);
    if (row.targetType === 'subject_group') {
        return entityObject(
            'subject_group',
            row.targetName || row.subjectNames?.join('、') || '课程组',
            row.subjectIds?.length ? row.subjectIds : row.subjectNames,
            'group',
        );
    }
    if (row.targetType === 'locked_slot') return entityObject('lesson_slot', row.targetName || '固定课节', row.targetId, 'explicit');
    return entityObject('global', row.targetName || row.type || '全局', row.targetId, 'global');
}

function intentForRow(row = {}) {
    const map = {
        teacher_unavailable: 'unavailable_periods',
        class_unavailable: 'unavailable_periods',
        global_unavailable: 'unavailable_periods',
        locked_slot: 'locked_slot',
        subject_morning: 'preferred_day_part',
        subject_afternoon: 'preferred_day_part',
        subject_preferred_periods: 'preferred_periods',
        subject_avoid_periods: 'avoid_periods',
        subject_daily_limit: 'subject_daily_limit',
        teacher_daily_limit: 'teacher_daily_limit',
        teacher_consecutive_limit: 'teacher_consecutive_limit',
        teacher_weekly_limit: 'teacher_weekly_limit',
        teacher_max_days_per_week: 'teacher_max_days_per_week',
        teacher_mutual_exclusion: 'teacher_mutual_exclusion',
        subject_spread: 'subject_spread',
        course_interval: 'course_interval',
        room_requirement: 'room_requirement',
        teacher_gap_preference: 'teacher_gap_preference',
        teacher_load_balance: 'teacher_load_balance',
        block_protection: 'block_integrity',
        class_daily_balance: 'class_daily_balance',
        class_subject_spread: 'class_subject_spread',
        quality_subject_later: 'quality_subject_later',
        subject_not_same_day: 'subject_not_same_day',
        subject_sequence: 'subject_sequence',
    };
    return row.intent || map[row.type] || row.type || 'unknown';
}

function applyToForRow(row = {}, project = {}) {
    if (row.weekPattern && complexModelIsEnabled(project)) return 'model_extension';
    if (SUPPORTED_EFFECTIVE_TYPES.has(row.type)) return 'rule';
    if (row.type === 'class_subject_spread') return 'optimization';
    if (row.type === 'block_protection') return 'solver_policy';
    return row.status === 'ignored' ? 'solver_policy' : 'review';
}

function requirementStatusForRow(row = {}, project = {}) {
    if (row.weekPattern && complexModelIsEnabled(project) && row.status === 'effective') return 'actionable';
    if (row.status === 'effective') return 'actionable';
    if (row.status === 'suggestion' && ['teacher_load_balance', 'class_daily_balance', 'class_subject_spread'].includes(row.type)) return 'actionable';
    if (row.status === 'ignored' || row.type === 'block_protection') return 'handled';
    return 'needs_review';
}

function parametersForRow(row = {}) {
    return {
        ...(row.parameters && typeof row.parameters === 'object' ? row.parameters : {}),
        ...(row.slots?.length ? { slots: row.slots } : {}),
        ...(row.days?.length ? { days: row.days } : {}),
        ...(row.periods?.length ? { periods: row.periods } : {}),
        ...(row.boundaryPeriods?.length ? { boundaryPeriods: row.boundaryPeriods } : {}),
        ...(row.limit ? { limit: row.limit } : {}),
        ...(row.minGapDays ? { minGapDays: row.minGapDays } : {}),
        ...(row.weight ? { weight: row.weight } : {}),
        ...(row.weekPattern ? { weekPattern: row.weekPattern } : {}),
        ...(row.teacherIds?.length ? { teacherIds: row.teacherIds } : {}),
        ...(row.classIds?.length ? { classIds: row.classIds } : {}),
        ...(row.gradeNames?.length ? { gradeNames: row.gradeNames } : {}),
        ...(row.blockPreference ? { blockPreference: row.blockPreference } : {}),
        ...(row.minOccurrences ? { minOccurrences: row.minOccurrences } : {}),
        ...(row.avoidDayParts?.length ? { avoidDayParts: row.avoidDayParts } : {}),
        ...(row.subjectNames?.length ? { subjectNames: row.subjectNames } : {}),
        ...(row.activityTypes?.length ? { activityTypes: row.activityTypes } : {}),
        ...(row.preferredActivityTypes?.length ? { preferredActivityTypes: row.preferredActivityTypes } : {}),
        ...(row.requiredResourceTypes?.length ? { requiredResourceTypes: row.requiredResourceTypes } : {}),
        ...(typeof row.sameDay === 'boolean' ? { sameDay: row.sameDay } : {}),
        ...(row.subjectIds?.length ? { subjectIds: row.subjectIds } : {}),
        ...(row.roomIds?.length ? { roomIds: row.roomIds } : {}),
        ...(row.requiredTags?.length ? { requiredTags: row.requiredTags } : {}),
        ...(row.roomName ? { roomName: row.roomName } : {}),
    };
}

function requirementFromRow(row = {}, index = 0, project = {}) {
    return {
        id: `req_${row.id || index + 1}`,
        rowId: row.id || '',
        requirementId: row.requirementId || '',
        clauseId: row.clauseId || '',
        constraintId: row.constraintId || '',
        capabilityId: row.capabilityId || '',
        sourceId: row.sourceId || '',
        textHash: row.textHash || '',
        origin: row.origin || 'unknown',
        parsedBy: row.parsedBy || [],
        object: rowRequirementObject(row),
        intent: intentForRow(row),
        condition: {
            ...(row.slots?.length ? { slots: row.slots } : {}),
            ...(row.weekPattern ? { weekPattern: row.weekPattern } : {}),
        },
        parameters: parametersForRow(row),
        strength: row.priority === 'hard' ? 'hard' : 'soft',
        status: requirementStatusForRow(row, project),
        understandingStatus: row.understandingStatus || '',
        executionStatus: row.executionStatus || '',
        reviewStatus: row.reviewStatus || '',
        support: row.support || '',
        scope: row.scope && typeof row.scope === 'object' ? { ...row.scope } : {},
        applyTo: applyToForRow(row, project),
        landing: row.landing || [],
        confidence: row.confidence,
        normalizationTrace: asList(row.normalizationTrace).map(item => item && typeof item === 'object' ? { ...item } : item),
        negation: row.negation && typeof row.negation === 'object' ? { ...row.negation } : (row.negation ?? null),
        exceptions: asList(row.exceptions).map(item => item && typeof item === 'object' ? { ...item } : item),
        activity: row.activity && typeof row.activity === 'object' ? { ...row.activity } : (row.activity ?? null),
        source: sourceFromRow(row),
        warnings: row.warnings || [],
        clarifications: row.clarifications || [],
        modelSupport: modelSupportForRow(row, project),
    };
}

function requirementSourceText(item = {}) {
    return asText(item.source?.rawText || item.rawText || item.description || item.reason || item.reviewEvidence?.quote || '', 1200);
}

function rowSourceText(row = {}) {
    return asText(row.rawText || row.constraintText || row.text || row.description || row.reason || row.reviewEvidence?.quote || '', 1200);
}

function textFingerprint(value = '') {
    return asText(value, 1200)
        .replace(/\s+/g, '')
        .replace(/[，,。.;；：:、]/g, '')
        .toLowerCase();
}

function textLooksRelated(left = '', right = '') {
    const a = textFingerprint(left);
    const b = textFingerprint(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= 8 && longer.includes(shorter);
}

function slotsFromRequirementItem(item = {}, project = {}) {
    const params = item.parameters || item.params || {};
    const condition = item.condition || {};
    const direct = normalizeSlotList(params.slots || params.slotKeys || condition.slots || condition.slotKeys || []);
    if (direct.length) return direct;
    const days = parseDays(params.days || condition.days || item.days || '', project, []);
    const periods = parsePeriods(params.periods || condition.periods || item.periods || '', project, []);
    if (days.length && periods.length) {
        return [...new Set(days.flatMap(day => periods.map(period => slotKey(day, period))))].sort();
    }
    const source = requirementSourceText(item);
    const sourceDays = parseDays(source, project, []);
    const sourcePeriods = parsePeriods(source, project, []);
    if (sourceDays.length && sourcePeriods.length) {
        return [...new Set(sourceDays.flatMap(day => sourcePeriods.map(period => slotKey(day, period))))].sort();
    }
    return [];
}

function rowTargetIds(row = {}) {
    return [
        row.targetId,
        row.teacherId,
        row.classId,
        row.subjectId,
        ...asList(row.teacherIds),
        ...asList(row.classIds),
        ...asList(row.subjectIds),
    ].map(value => asText(value, 120)).filter(Boolean);
}

function rowTargetNames(row = {}) {
    return [
        row.targetName,
        row.teacherName,
        row.teacher,
        row.className,
        row.class,
        row.subjectName,
        row.subject,
    ].map(value => asText(value, 200)).filter(Boolean);
}

function requirementTargetIds(item = {}) {
    const params = item.parameters || item.params || {};
    return [
        item.targetId,
        item.object?.id,
        ...asList(item.object?.matchedIds),
        ...asList(params.teacherIds),
        ...asList(params.classIds),
        ...asList(params.subjectIds),
    ].map(value => asText(value, 120)).filter(Boolean);
}

function requirementTargetNames(item = {}) {
    const params = item.parameters || item.params || {};
    return [
        item.targetName,
        item.target,
        item.object?.name,
        ...asList(params.teacherNames),
        ...asList(params.classNames),
        ...asList(params.subjectNames),
    ].map(value => asText(value, 200)).filter(Boolean);
}

function normalizedEntityName(value = '') {
    return asText(value, 200).replace(/老师|教师|同学|班级|课程/g, '').replace(/\s+/g, '').toLowerCase();
}

function requirementTargetMatchesRow(item = {}, row = {}) {
    const reqIds = requirementTargetIds(item);
    const ids = rowTargetIds(row);
    if (reqIds.length && ids.some(id => reqIds.includes(id))) return true;
    const reqNames = requirementTargetNames(item).map(normalizedEntityName).filter(Boolean);
    const names = rowTargetNames(row).map(normalizedEntityName).filter(Boolean);
    if (reqNames.length && names.some(name => reqNames.includes(name))) return true;
    const source = normalizedEntityName(requirementSourceText(item));
    return Boolean(source && names.some(name => name && source.includes(name)));
}

function requirementIntentMatchesRow(item = {}, row = {}) {
    const intent = normalizeRequirementIntentAlias(item.intent || item.type || '');
    const rowIntent = normalizeRequirementIntentAlias(row.type || row.intent || '');
    if (!intent || intent === 'unknown' || intent === 'schedule_request') return true;
    if (intent === rowIntent) return true;
    if (intent === 'block_preference' && rowIntent === 'block_integrity') {
        const expectedBlockPreference = asText(item.parameters?.blockPreference || '', 40);
        const rowBlockPreference = blockPreferenceFromText(rowSourceText(row));
        return Boolean(rowBlockPreference && (!expectedBlockPreference || rowBlockPreference === expectedBlockPreference));
    }
    if (intent === 'unavailable_periods' && ['teacher_unavailable', 'class_unavailable', 'global_unavailable'].includes(row.type)) return true;
    if (normalizeRequirementApplyToAlias(item.applyTo || '') === 'review') return true;
    return false;
}

function requirementTimeMatchesRow(item = {}, row = {}, project = {}) {
    const reqSlots = slotsFromRequirementItem(item, project);
    const slots = normalizeSlotList(row.slots || []);
    if (reqSlots.length && slots.length) {
        const reqSlotSet = new Set(reqSlots);
        return slots.some(slot => reqSlotSet.has(slot));
    }
    if (!reqSlots.length && !slots.length) return true;
    return textLooksRelated(requirementSourceText(item), rowSourceText(row));
}

function semanticRequirementMatchesRow(item = {}, row = {}, project = {}) {
    if (!item?.id || item.origin === 'system_supplement') return false;
    if (!requirementIntentMatchesRow(item, row)) return false;
    if (!requirementTargetMatchesRow(item, row)) return false;
    return requirementTimeMatchesRow(item, row, project);
}

function artifactSourceIdentityConflicts(left = {}, right = {}) {
    const leftSourceId = asText(left.sourceId || left.source?.sourceId || '', 300);
    const rightSourceId = asText(right.sourceId || right.source?.sourceId || '', 300);
    if (leftSourceId && rightSourceId && leftSourceId !== rightSourceId) return true;
    const leftHash = asText(left.textHash || left.source?.textHash || '', 128);
    const rightHash = asText(right.textHash || right.source?.textHash || '', 128);
    if (leftHash && rightHash && leftHash !== rightHash) return true;
    const leftSheet = asText(left.sourceSheet || left.source?.sourceSheet || left.source?.sheetName || '', 120);
    const rightSheet = asText(right.sourceSheet || right.source?.sourceSheet || right.source?.sheetName || '', 120);
    const leftRow = Number.parseInt(left.sourceRow ?? left.source?.sourceRow ?? left.source?.rowNumber, 10) || null;
    const rightRow = Number.parseInt(right.sourceRow ?? right.source?.sourceRow ?? right.source?.rowNumber, 10) || null;
    if (leftRow && rightRow && leftRow !== rightRow) return true;
    if (leftRow && rightRow && leftSheet && rightSheet && leftSheet !== rightSheet) return true;
    const leftLine = Number.parseInt(left.lineNumber ?? left.source?.lineNumber, 10) || null;
    const rightLine = Number.parseInt(right.lineNumber ?? right.source?.lineNumber, 10) || null;
    return Boolean(leftLine && rightLine && leftLine !== rightLine);
}

function rowHasSourceIdentity(row = {}) {
    return Boolean(
        row.sourceId
        || row.textHash
        || row.sourceRow
        || row.lineNumber
        || row.source?.sourceId
        || row.source?.textHash
        || row.source?.rowNumber
        || row.source?.lineNumber
    );
}

function sourceScopedRequirementCandidates(row = {}, requirements = []) {
    const sourceId = asText(row.sourceId || row.source?.sourceId || '', 300);
    if (sourceId) return requirements.filter(item => item.sourceId === sourceId);

    const sourceSheet = asText(row.sourceSheet || row.source?.sourceSheet || row.source?.sheetName || '', 120);
    const sourceRow = Number.parseInt(row.sourceRow ?? row.source?.sourceRow ?? row.source?.rowNumber, 10) || null;
    if (sourceRow) {
        return requirements.filter(item => item.sourceRow === sourceRow
            && (!sourceSheet || !item.sourceSheet || item.sourceSheet === sourceSheet));
    }

    const lineNumber = Number.parseInt(row.lineNumber ?? row.source?.lineNumber, 10) || null;
    if (lineNumber) return requirements.filter(item => item.lineNumber === lineNumber);

    const textHash = asText(row.textHash || row.source?.textHash || '', 128);
    if (textHash) return requirements.filter(item => item.textHash === textHash);
    return [];
}

function linkRowToRequirement(row = {}, requirement = {}) {
    return {
        ...row,
        requirementId: requirement.id || requirement.requirementId || row.requirementId || '',
        clauseId: requirement.clauseId || row.clauseId || '',
    };
}

function linkRowsToSemanticRequirements(rows = [], semanticRequirements = [], project = {}) {
    const requirements = externalRequirementItems(semanticRequirements)
        .filter(item => item.id && item.origin !== 'system_supplement');
    if (!requirements.length) return rows;
    return rows.map(row => {
        const explicitClauseId = asText(row.clauseId || '', 300);
        if (explicitClauseId) {
            const matches = requirements.filter(item => item.clauseId === explicitClauseId
                && !artifactSourceIdentityConflicts(row, item));
            if (matches.length === 1) return linkRowToRequirement(row, matches[0]);
        }

        const explicitRequirementId = asText(row.requirementId || '', 240);
        if (explicitRequirementId) {
            const matches = requirements.filter(item => (item.id === explicitRequirementId || item.requirementId === explicitRequirementId)
                && !artifactSourceIdentityConflicts(row, item));
            if (matches.length === 1) return linkRowToRequirement(row, matches[0]);
        }

        const scoped = sourceScopedRequirementCandidates(row, requirements);
        if (scoped.length) {
            const semanticMatches = scoped.filter(item => semanticRequirementMatchesRow(item, row, project));
            if (semanticMatches.length === 1) return linkRowToRequirement(row, semanticMatches[0]);
            if (!semanticMatches.length && scoped.length === 1) return linkRowToRequirement(row, scoped[0]);
            return row;
        }

        if (rowHasSourceIdentity(row)) return row;
        const legacyMatches = requirements.filter(item => semanticRequirementMatchesRow(item, row, project));
        if (legacyMatches.length !== 1) return row;
        return linkRowToRequirement(row, legacyMatches[0]);
    });
}

function highLoadTeacherIds(project = {}, threshold = 14) {
    const hours = new Map();
    for (const plan of project.lessonPlans || []) {
        const value = Number(plan.weeklyHours || 0);
        const ids = [plan.teacherId, ...asList(plan.teacherIds)].filter(Boolean);
        ids.forEach(id => hours.set(id, (hours.get(id) || 0) + value));
    }
    return [...hours.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([id]) => id);
}

function teacherNamesById(project = {}, ids = []) {
    const map = new Map((project.teachers || []).map(teacher => [teacher.id, teacher.name || teacher.id]));
    return ids.map(id => map.get(id) || id).filter(Boolean);
}

function lessonPlansForSubjectIds(project = {}, subjectIds = []) {
    const subjectSet = new Set(subjectIds);
    return (project.lessonPlans || []).filter(plan => subjectSet.has(plan.subjectId));
}

function blockPreferenceFromText(text = '') {
    if (/混合|单双|单双混排|mixed/i.test(text)) return 'mixed';
    if (/不要连堂|不连堂|避免连堂|默认单节|按单节|单节|single/i.test(text)) return 'single';
    if (/双连堂|连堂|连续两节|连排|double|block/i.test(text)) return 'double';
    return '';
}

function gradeNamesFromText(text = '') {
    const aliases = {
        初一: '七年级',
        初二: '八年级',
        初三: '九年级',
        G7: '七年级',
        G8: '八年级',
        G9: '九年级',
    };
    const grades = [];
    for (const match of String(text || '').matchAll(/(?:[一二三四五六七八九十]{1,3}年级|初[一二三]|高[一二三]|G(?:[1-9]|1[0-2]))/gi)) {
        const token = match[0];
        const normalizedToken = /^g/i.test(token) ? token.toUpperCase() : token;
        grades.push(aliases[normalizedToken] || normalizedToken);
    }
    return [...new Set(grades)];
}
function firstMentionedEntity(items = [], text = '', targetType = '') {
    const sourceText = asText(text, 1200);
    const candidates = [];
    for (const item of items || []) {
        const names = entityNamesForMatch(item, targetType)
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
        const matchedName = names.find(name => sourceText.includes(name));
        if (matchedName) {
            candidates.push({ item, index: sourceText.indexOf(matchedName), length: matchedName.length });
        }
    }
    candidates.sort((left, right) => left.index - right.index || right.length - left.length);
    return candidates[0]?.item || null;
}

function mentionedEntities(items = [], text = '', targetType = '') {
    const sourceText = asText(text, 1200);
    const candidates = [];
    const seen = new Set();
    for (const item of items || []) {
        const names = entityNamesForMatch(item, targetType)
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
        const matchedName = names.find(name => sourceText.includes(name));
        if (matchedName && !seen.has(item.id)) {
            seen.add(item.id);
            candidates.push({ item, index: sourceText.indexOf(matchedName), length: matchedName.length });
        }
    }
    return candidates
        .sort((left, right) => left.index - right.index || right.length - left.length)
        .map(candidate => candidate.item);
}

function maxConsecutiveAcrossCampusFromText(text = '') {
    const sourceText = asText(text, 400);
    const match = sourceText.match(new RegExp(`连续\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
    const value = match ? parseLooseNumber(match[1]) : null;
    if (!Number.isFinite(value) || value <= 0) return null;
    if (/不要|不能|避免|不许/.test(sourceText)) return Math.max(1, value - 1);
    return value;
}

function textRequirementBase(id, object, intent, sourceText, {
    condition = {},
    parameters = {},
    strength = 'soft',
    status = 'actionable',
    applyTo = 'review',
    confidence = 0.8,
    warnings = [],
    clarification = null,
    modelSupport = null,
    origin = '',
} = {}) {
    const inferredOrigin = origin
        || (/^req_system_/.test(String(id || '')) ? 'system_supplement' : 'user_input');
    return {
        id,
        origin: inferredOrigin,
        object,
        intent,
        condition,
        parameters,
        strength,
        status,
        applyTo,
        confidence,
        source: { rawText: asText(sourceText, 1000) },
        warnings,
        clarification,
        modelSupport,
    };
}

function complexRequirementState(project = {}, capability = '', unsupportedMessage = '') {
    if (complexModelIsEnabled(project)) {
        return {
            status: 'actionable',
            modelSupport: supportedComplexModelSupport(capability, '已启用 complex_v1，可写入复杂排课模型字段。'),
            clarification: null,
            warnings: [],
        };
    }
    return {
        status: 'needs_review',
        modelSupport: unsupportedComplexModelSupport(capability, unsupportedMessage),
        clarification: {
            id: `clarify_${capability || 'complex_model'}_model_support`,
            kind: 'model_support',
            field: 'complexModel',
            question: '该需求需要先启用复杂排课模型后才能生效。',
            defaultValue: 'complex_v1',
        },
        warnings: [],
    };
}

function roomTagsFromText(roomName = '', sourceText = '') {
    const text = `${roomName} ${sourceText}`;
    const tags = [];
    if (/操场|体育馆|体育|运动|场地/.test(text)) tags.push('sport');
    if (/实验室|实验/.test(text)) tags.push('lab');
    if (/机房|信息|电脑|计算机/.test(text)) tags.push('computer');
    if (/音乐/.test(text)) tags.push('music');
    if (/美术/.test(text)) tags.push('art');
    return [...new Set(tags)];
}

function complexRequirementsFromText(project = {}, text = '') {
    const sourceText = asText(text, 1200);
    const requirements = [];

    if (/(跨校区|校区|通勤)/.test(sourceText) && /(连续|连着|间隔|赶课)/.test(sourceText)) {
        const teacher = firstMentionedEntity(project.teachers || [], sourceText, 'teacher');
        const maxConsecutive = maxConsecutiveAcrossCampusFromText(sourceText);
        const support = complexRequirementState(
            project,
            'campus_commute',
            '跨校区通勤需要 complex_v1 项目模型和求解器支持，当前不会自动生效。',
        );
        const object = teacher
            ? entityObject('teacher', teacher.name || entityLabel(teacher), teacher.id)
            : entityObject('teacher_group', '教师', [], 'derived');
        requirements.push(textRequirementBase(
            'req_complex_campus_commute_gap',
            object,
            'campus_commute_gap',
            sourceText,
            {
                parameters: {
                    commuteScope: 'cross_campus',
                    ...(maxConsecutive ? { maxConsecutiveAcrossCampus: maxConsecutive } : {}),
                },
                strength: 'hard',
                status: teacher && maxConsecutive && complexModelIsEnabled(project) ? support.status : 'needs_review',
                applyTo: 'model_extension',
                confidence: teacher ? 0.82 : 0.68,
                warnings: teacher ? support.warnings : ['未识别到唯一教师，当前只保留为跨校区通勤需求候选。'],
                modelSupport: support.modelSupport,
                clarification: teacher && maxConsecutive ? support.clarification : {
                    id: 'clarify_req_complex_campus_commute_parameters',
                    kind: 'model_support',
                    field: 'complexModel',
                    question: '跨校区通勤规则需要先确认教师和通勤间隔后才能生效。',
                    defaultValue: 'complex_v1',
                },
            },
        ));
    }

    if (/(合班|合上|走班|教学组)/.test(sourceText)) {
        const classes = mentionedEntities(project.classes || [], sourceText, 'class');
        const subject = firstMentionedEntity(project.subjects || [], sourceText, 'subject');
        const support = complexRequirementState(
            project,
            'teachingGroup',
            '合班/走班需要 complex_v1 教学组模型支持，当前不会自动生效。',
        );
        if (classes.length >= 2) {
            const classIds = classes.map(item => item.id).filter(Boolean);
            const classNames = classes.map(item => entityLabel(item)).filter(Boolean);
            requirements.push(textRequirementBase(
                'req_complex_teaching_group_session',
                entityObject('teaching_group', classNames.join('、') || '教学组', classIds, 'derived'),
                'teaching_group_session',
                sourceText,
                {
                    parameters: {
                        classIds,
                        classNames,
                        ...(subject?.id ? { subjectIds: [subject.id], subjectName: subject.name || entityLabel(subject) } : {}),
                        mode: /走班/.test(sourceText) ? 'rotation' : 'combined_class',
                    },
                    strength: /必须|不能|不要|固定/.test(sourceText) ? 'hard' : 'soft',
                    status: subject && complexModelIsEnabled(project) ? support.status : 'needs_review',
                    applyTo: 'model_extension',
                    confidence: subject ? 0.82 : 0.72,
                    warnings: subject ? support.warnings : ['未识别到唯一课程，当前只保留为教学组需求候选。'],
                    modelSupport: support.modelSupport,
                    clarification: subject ? support.clarification : {
                        id: 'clarify_req_complex_teaching_group_parameters',
                        kind: 'model_support',
                        field: 'complexModel',
                        question: '合班/走班需要先确认成员班级和课程后才能生效。',
                        defaultValue: 'complex_v1',
                    },
                },
            ));
        }
    }

    if (/(操场|体育馆|实验室|机房|音乐室|美术室|功能室|场地|教室)/.test(sourceText) && /(安排|排|上|使用|去|在)/.test(sourceText)) {
        const subject = firstMentionedEntity(project.subjects || [], sourceText, 'subject');
        const roomMatch = sourceText.match(/(操场|体育馆|实验室|机房|音乐室|美术室|功能室|[\u4e00-\u9fa5A-Za-z0-9_-]{1,12}(?:教室|场地|室|馆))/);
        const roomName = asText(roomMatch?.[1] || '', 120);
        const support = complexRequirementState(
            project,
            'room_attributes',
            '教室/场地偏好需要 complex_v1 教室属性模型支持，当前不会自动生效。',
        );
        if (subject && roomName) {
            requirements.push(textRequirementBase(
                'req_complex_room_requirement',
                entityObject('subject', subject.name || entityLabel(subject), subject.id),
                'room_requirement',
                sourceText,
                {
                    parameters: {
                        subjectIds: [subject.id],
                        roomName,
                        requiredTags: roomTagsFromText(roomName, sourceText),
                    },
                    strength: /必须|不能|不要|固定/.test(sourceText) ? 'hard' : 'soft',
                    status: complexModelIsEnabled(project) ? support.status : 'needs_review',
                    applyTo: 'model_extension',
                    confidence: 0.88,
                    modelSupport: support.modelSupport,
                    clarification: support.clarification,
                },
            ));
        }
    }

    return requirements;
}

function systemRequirementsFromText(text = '') {
    const requirements = [];
    const sourceText = asText(text, 1200);
    if (SYSTEM_TEACHER_TIME_CONFLICT_PATTERN.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_teacher_time_conflict',
            entityObject('global', '全部教师', [], 'global'),
            'teacher_time_conflict',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.98,
                warnings: ['这是系统内置硬规则，求解时已自动处理。'],
            },
        ));
    }
    if (SYSTEM_CLASS_TIME_CONFLICT_PATTERN.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_class_time_conflict',
            entityObject('global', '全部班级', [], 'global'),
            'class_time_conflict',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.98,
                warnings: ['这是系统内置硬规则，求解时已自动处理。'],
            },
        ));
    }
    if (SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_lesson_hours_completeness',
            entityObject('global', '任课计划周课时', [], 'global'),
            'lesson_hours_completeness',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.94,
                warnings: ['求解时会按任课计划周课时排满，不需要额外生成不可排规则。'],
            },
        ));
    }
    if (/未注明.*默认.*单节|默认.*单节|没有.*连堂.*单节/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_default_single',
            entityObject('global', '默认课时块策略', [], 'global'),
            'default_block_policy',
            sourceText,
            {
                parameters: { blockPreference: 'single' },
                strength: 'default',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.95,
                warnings: ['未指定连堂的任课计划默认按单节处理。'],
            },
        ));
    }
    if (/连堂块.*(不能|不可|不要|不应).*(拆|拆开|打散)|连堂.*(保护|整段|整块)|块.*完整/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_system_block_integrity',
            entityObject('lesson_block', '所有连堂课时块', [], 'global'),
            'block_integrity',
            sourceText,
            {
                strength: 'hard',
                status: 'handled',
                applyTo: 'solver_policy',
                confidence: 0.94,
                warnings: ['连堂课时块在求解和修复中按整段处理。'],
            },
        ));
    }
    return requirements;
}

function blockPreferenceRequirementsFromText(project = {}, text = '') {
    const requirements = [];
    if (/物化生/.test(text) && /(?:大连堂|连排两节)/.test(text)) return requirements;
    splitSentences(parserShadowText(text)).forEach((sentenceGroup, groupIndex) => {
        splitClauses(sentenceGroup).forEach((sentence, clauseIndex) => {
            if (!/(连堂|连排|连续两节|双连堂|单节|混合|单双)/.test(sentence)) return;
            if (/默认.*单节|未注明.*单节/.test(sentence)) return;
            const blockPreference = blockPreferenceFromText(sentence);
            if (!blockPreference) return;
            const gradeNames = gradeNamesFromText(sentence);
            const detectedSubjects = textSubjectTargets(sentence, project);
            const subjects = detectedSubjects.length > 1
                ? detectedSubjects.filter(subject => subject.name !== '实验课')
                : detectedSubjects;
            const idBase = `req_block_${groupIndex + 1}_${clauseIndex + 1}`;
            if (!subjects.length) {
                if (/(?:学校叫|俗称|也叫)/.test(sentence)) return;
                requirements.push(textRequirementBase(
                    idBase,
                    entityObject('subject', '未明确课程', [], 'unknown'),
                    'block_preference',
                    sentence,
                    {
                        parameters: {
                            blockPreference,
                            blockSize: blockPreference === 'double' ? 2 : 1,
                            ...(gradeNames.length ? { gradeNames } : {}),
                        },
                        strength: /必须|要求|不能|不要/.test(sentence) ? 'hard' : 'soft',
                        status: 'needs_review',
                        applyTo: 'lesson_plan',
                        confidence: 0.62,
                        warnings: ['缺少明确课程，不能直接修改任课计划。'],
                    },
                ));
                return;
            }
            subjects.forEach((subject, subjectIndex) => {
                const subjectIds = subject.id ? [subject.id] : [];
                const plans = lessonPlansForSubjectIds(project, subjectIds);
                requirements.push(textRequirementBase(
                    `${idBase}_${subjectIndex + 1}`,
                    entityObject('subject', subject.name, subjectIds, subject.id ? 'explicit' : 'unknown'),
                    'block_preference',
                    sentence,
                    {
                        parameters: {
                            blockPreference,
                            blockSize: blockPreference === 'double' ? 2 : 1,
                            ...(gradeNames.length ? { gradeNames } : {}),
                            lessonPlanIds: plans.map(plan => plan.id),
                        },
                        strength: /必须|要求|不能|不要/.test(sentence) ? 'hard' : 'soft',
                        status: subject.id && plans.length ? 'actionable' : 'needs_review',
                        applyTo: 'lesson_plan',
                        confidence: subject.id ? 0.9 : 0.64,
                        warnings: plans.length ? [] : ['没有找到可修改的任课计划，请先确认任课数据。'],
                    },
                ));
            });
        });
    });
    return requirements;
}

function optimizationRequirementsFromText(project = {}, text = '') {
    const sourceText = asText(text, 1200);
    const requirements = [];
    if (/高负载教师|教师.*负载|负载.*教师|连续.*太多|不要.*连续.*太多|(?:老师|教师).*课?.*太密|课.*太密/.test(sourceText)) {
        const teacherIds = highLoadTeacherIds(project);
        const names = teacherIds.length ? teacherNamesById(project, teacherIds).join('、') : '高负载教师';
        const thresholdMatch = sourceText.match(new RegExp(`(?:连续|连排).*?(?:最多|不超过|不多于|超过)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
        const maxConsecutive = thresholdMatch ? parseLooseNumber(thresholdMatch[1]) : null;
        const needsClarification = !Number.isFinite(maxConsecutive) || maxConsecutive <= 0;
        requirements.push(textRequirementBase(
            'req_optimization_high_load_teachers',
            entityObject('derived_group', names, teacherIds, 'derived'),
            'teacher_load_protection',
            sourceText,
            {
                parameters: {
                    ...(needsClarification ? {} : { maxConsecutive }),
                    balancedTeacherLoad: true,
                },
                strength: 'soft',
                status: needsClarification ? 'needs_review' : 'actionable',
                applyTo: 'optimization',
                confidence: teacherIds.length ? 0.88 : 0.78,
                warnings: teacherIds.length ? [] : ['当前数据未识别出达到高负载阈值的教师，将先启用教师负载均衡目标。'],
                clarification: needsClarification ? {
                    id: 'clarify_req_optimization_high_load_teachers_max_consecutive',
                    kind: 'number',
                    field: 'maxConsecutive',
                    question: '连续超过几节算太多？',
                    defaultValue: 3,
                    min: 1,
                    max: Math.max(3, Number(project.periodsPerDay) || getActivePeriods(project).length || 8),
                } : null,
            },
        ));
    }
    if (/班级.*(每天|每日).*(均衡|平衡)|班级.*(均衡|平衡).*(每天|每日)/.test(sourceText)) {
        requirements.push(textRequirementBase(
            'req_optimization_class_daily_balance',
            entityObject('global', '全部班级', [], 'global'),
            'class_daily_balance',
            sourceText,
            {
                strength: 'soft',
                status: 'handled',
                applyTo: 'optimization',
                confidence: 0.82,
                warnings: ['班级每日均衡已纳入课表质量评分。'],
            },
        ));
    }
    return requirements;
}

function normalizeRequirementIntentAlias(value = '') {
    const text = asText(value, 120).trim().toLowerCase().replace(/[-\s]+/g, '_');
    const compact = text.replace(/_/g, '');
    if (!text) return 'unknown';
    const aliases = {
        preferred_periods: 'preferred_periods',
        subject_preferred_periods: 'preferred_periods',
        period_preference: 'preferred_periods',
        periods_preference: 'preferred_periods',
        preferred_slots: 'preferred_periods',
        preferred_day_part: 'preferred_day_part',
        subject_morning: 'preferred_day_part',
        subject_afternoon: 'preferred_day_part',
        morning_preference: 'preferred_day_part',
        afternoon_preference: 'preferred_day_part',
        morning: 'preferred_day_part',
        afternoon: 'preferred_day_part',
        avoid_periods: 'avoid_periods',
        subject_avoid_periods: 'avoid_periods',
        unavailable_periods: 'unavailable_periods',
        teacher_unavailable: 'unavailable_periods',
        class_unavailable: 'unavailable_periods',
        global_unavailable: 'unavailable_periods',
        locked_slot: 'locked_slot',
        subject_daily_limit: 'subject_daily_limit',
        teacher_daily_limit: 'teacher_daily_limit',
        teacher_consecutive_limit: 'teacher_consecutive_limit',
        teacher_weekly_limit: 'teacher_weekly_limit',
        teacher_max_days_per_week: 'teacher_max_days_per_week',
        teacher_mutual_exclusion: 'teacher_mutual_exclusion',
        spread: 'subject_spread',
        subject_spread: 'subject_spread',
        course_spread: 'subject_spread',
        course_interval: 'course_interval',
        room_requirement: 'room_requirement',
        block: 'block_preference',
        block_preference: 'block_preference',
        double_block: 'block_preference',
        default_block_policy: 'default_block_policy',
        block_integrity: 'block_integrity',
        block_protection: 'block_integrity',
        teacher_gap_preference: 'teacher_gap_preference',
        teacher_load_balance: 'teacher_load_balance',
        teacher_load_protection: 'teacher_load_protection',
        teacher_time_conflict: 'teacher_time_conflict',
        class_time_conflict: 'class_time_conflict',
        class_daily_balance: 'class_daily_balance',
        class_subject_spread: 'class_subject_spread',
        quality_subject_later: 'quality_subject_later',
        subject_not_same_day: 'subject_not_same_day',
        subject_sequence: 'subject_sequence',
    };
    if (aliases[text]) return aliases[text];
    if (compact === 'morningpreference' || compact === 'subjectmorning') return 'preferred_day_part';
    if (compact === 'periodpreference' || compact === 'preferredslots') return 'preferred_periods';
    if (compact === 'spread' || compact === 'subjectspread' || compact === 'coursespread') return 'subject_spread';
    return text;
}

function normalizeRequirementStatusAlias(value = '') {
    const text = asText(value, 40).trim().toLowerCase().replace(/[-\s]+/g, '_');
    if (!text) return 'needs_review';
    if (['handled', 'ignored', 'system_handled', 'already_handled'].includes(text)) return 'handled';
    if (['actionable', 'ready', 'effective', 'applicable'].includes(text)) return 'actionable';
    if (['needs_review', 'need_review', 'review', 'pending_review', 'candidate', 'pending', 'draft'].includes(text)) return 'needs_review';
    return 'needs_review';
}

function normalizeRequirementApplyToAlias(value = '') {
    const text = asText(value, 80).trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    return {
        rules: 'rule',
        constraint: 'rule',
        constraint_rule: 'rule',
        lesson_plan: 'lesson_plan',
        lesson_plans: 'lesson_plan',
        lessonplan: 'lesson_plan',
        roster: 'lesson_plan',
        optimization: 'optimization',
        optimize: 'optimization',
        solver_policy: 'solver_policy',
        system_policy: 'solver_policy',
        handled: 'solver_policy',
        review: 'review',
        needs_review: 'review',
    }[text] || text || 'review';
}

function normalizeRequirementClarification(clarification = null, requirementId = '') {
    if (!clarification || typeof clarification !== 'object') return null;
    const field = asText(clarification.field || 'value', 80);
    const kind = asText(clarification.kind || clarification.type || 'text', 40);
    const id = asText(clarification.id, 160) || `clarify_${requirementId || 'requirement'}_${field}`;
    const result = {
        id,
        kind,
        field,
        question: asText(clarification.question || '请补充这个需求的必要参数。', 240),
        defaultValue: clarification.defaultValue ?? clarification.default ?? null,
        value: clarification.value ?? null,
        options: asList(clarification.options).map(option => {
            const value = option && typeof option === 'object' ? option : { label: option, value: option };
            return {
                label: asText(value.label || value.name || value.value || value.id, 120),
                value: asText(value.value || value.id || value.label, 120),
            };
        }).filter(option => option.label && option.value),
    };
    if (clarification.min !== undefined && clarification.min !== null && Number.isFinite(Number(clarification.min))) {
        result.min = Number(clarification.min);
    }
    if (clarification.max !== undefined && clarification.max !== null && Number.isFinite(Number(clarification.max))) {
        result.max = Number(clarification.max);
    }
    return result;
}

function normalizeRequirementModelSupport(modelSupport = null) {
    if (!modelSupport || typeof modelSupport !== 'object') return null;
    return {
        supported: Boolean(modelSupport.supported),
        capability: asText(modelSupport.capability || modelSupport.kind || '', 80),
        requiredModel: asText(modelSupport.requiredModel || modelSupport.model || '', 80),
        phase: asText(modelSupport.phase || '', 80),
        message: asText(modelSupport.message || modelSupport.reason || '', 240),
    };
}

function externalRequirementItems(items = []) {
    return asList(items).filter(item => item && typeof item === 'object').map((item, index) => {
        const id = asText(item.id || item.requirementId, 120) || `req_external_${index + 1}`;
        const requirementId = asText(item.requirementId || id, 240);
        const clauseId = asText(item.clauseId || item.source?.clauseId || '', 300);
        const sourceId = asText(item.sourceId || item.source?.sourceId || '', 300);
        const textHash = asText(item.textHash || item.source?.textHash || '', 128);
        const origin = asText(item.origin || item.source?.origin || 'unknown', 40);
        const parsedBy = normalizedParsedBy(item.parsedBy, item.source?.parsedBy);
        const sourceSheet = asText(item.sourceSheet || item.source?.sourceSheet || item.source?.sheetName || '', 120);
        const sourceRow = Number.parseInt(item.sourceRow ?? item.source?.sourceRow ?? item.source?.rowNumber, 10) || null;
        const lineNumber = Number.parseInt(item.lineNumber ?? item.source?.lineNumber, 10) || null;
        const sourceRawText = asText(
            item.source?.rawText
            || item.source?.text
            || item.rawText
            || item.reason
            || item.description
            || item.reviewEvidence?.quote
            || '',
            1000
        );
        const source = {
            ...(item.source && typeof item.source === 'object' ? item.source : {}),
            sourceId,
            textHash,
            origin,
            parsedBy,
            sourceSheet,
            sourceRow,
            sheetName: sourceSheet,
            rowNumber: sourceRow,
            lineNumber,
            rawText: sourceRawText,
            clauseId,
        };
        return {
            id,
            requirementId,
            clauseId,
            machineRuleIds: normalizedTextValues(300, item.machineRuleIds),
            rowId: asText(item.rowId || '', 240),
            sourceId,
            textHash,
            origin,
            parsedBy,
            sourceSheet,
            sourceRow,
            lineNumber,
            rawText: sourceRawText,
            normalizationTrace: asList(item.normalizationTrace || item.source?.normalizationTrace)
                .filter(entry => entry && typeof entry === 'object')
                .map(entry => ({ ...entry })),
            negation: item.negation && typeof item.negation === 'object' ? { ...item.negation } : (item.negation ?? null),
            exceptions: asList(item.exceptions).map(entry => entry && typeof entry === 'object' ? { ...entry } : entry),
            activity: item.activity && typeof item.activity === 'object' ? { ...item.activity } : (item.activity ?? null),
            object: item.object && typeof item.object === 'object'
                ? {
                    kind: asText(item.object.kind || item.object.type || 'global', 80),
                    name: asText(item.object.name || item.object.label || item.targetName || item.target || '', 200),
                    matchedIds: normalizedTextValues(120, item.object.matchedIds),
                    scope: asText(item.object.scope || 'explicit', 80),
                }
                : entityObject(asText(item.targetType || 'global', 80), asText(item.targetName || item.target || '', 200), item.targetId || '', 'explicit'),
            intent: normalizeRequirementIntentAlias(item.intent || item.type || 'unknown'),
            condition: item.condition && typeof item.condition === 'object' ? item.condition : {},
            parameters: item.parameters && typeof item.parameters === 'object' ? item.parameters : {},
            strength: asText(item.strength || item.priority || 'soft', 40),
            status: normalizeRequirementStatusAlias(item.status || 'needs_review'),
            applyTo: normalizeRequirementApplyToAlias(item.applyTo || 'review'),
            confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
            clarificationHistory: asList(item.clarificationHistory).map(entry => {
                const value = entry && typeof entry === 'object' ? entry : { question: entry };
                return {
                    question: asText(value.question || value.message || '', 500),
                    field: asText(value.field || '', 80),
                    kind: asText(value.kind || '', 40),
                    answer: value.answer,
                    answerLabel: asText(value.answerLabel || '', 200),
                    at: asText(value.at || '', 80),
                };
            }).filter(entry => entry.question || entry.field || entry.answer !== undefined),
            source,
            warnings: normalizedMessageValues(240, item.warnings),
            aiReviewStatus: asText(item.aiReviewStatus || '', 40),
            aiReviewIssueCode: asText(item.aiReviewIssueCode || '', 80),
            aiReviewValidationStatus: asText(item.aiReviewValidationStatus || '', 40),
            aiReviewBlocking: item.aiReviewBlocking === true,
            aiReviewValidationEvidence: normalizedMessageValues(500, item.aiReviewValidationEvidence),
            aiReviewWarnings: normalizedMessageValues(240, item.aiReviewWarnings),
            reviewEvidence: item.reviewEvidence && typeof item.reviewEvidence === 'object'
                ? {
                    quote: asText(item.reviewEvidence.quote || item.reviewEvidence.text || '', 500),
                    reason: asText(item.reviewEvidence.reason || item.reviewEvidence.message || '', 500),
                    sourceSheet: asText(item.reviewEvidence.sourceSheet || '', 120),
                    sourceRow: Number.parseInt(item.reviewEvidence.sourceRow, 10) || null,
                }
                : null,
            reviewedParseSource: asText(item.reviewedParseSource || '', 80),
            clarification: normalizeRequirementClarification(item.clarification, id),
            modelSupport: normalizeRequirementModelSupport(item.modelSupport),
        };
    });
}

function dedupeRequirements(items = []) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const sourceIdentity = item.sourceId
            || item.source?.sourceId
            || (item.sourceRow ? `${item.sourceSheet || item.source?.sourceSheet || item.source?.sheetName || ''}:${item.sourceRow}` : '')
            || (item.lineNumber ? `line:${item.lineNumber}` : '')
            || (item.textHash || item.source?.textHash ? `hash:${item.textHash || item.source?.textHash}` : '')
            || item.id
            || '';
        const key = stableJson([
            sourceIdentity,
            item.clauseId || '',
            normalizeRequirementIntentAlias(item.intent || item.type || 'unknown'),
            normalizeRequirementApplyToAlias(item.applyTo || 'review'),
            item.object?.kind || 'global',
            item.object?.name || '',
            asList(item.object?.matchedIds).map(String).sort(),
            item.condition || {},
            item.parameters || {},
            item.strength || item.priority || 'soft',
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ ...item, id: item.id || `req_${result.length + 1}` });
    }
    return result;
}

function actionForRequirement(project = {}, requirement = {}, index = 0) {
    if (requirement.status === 'handled') {
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'handled_notice',
            status: 'handled',
            applyTo: requirement.applyTo,
        };
    }
    if (requirement.status !== 'actionable') return null;
    const matchedIds = normalizedTextValues(120, requirement.object?.matchedIds);
    if (requirement.applyTo === 'lesson_plan' && requirement.intent === 'block_preference') {
        const explicitLessonPlanIds = normalizedTextValues(120, requirement.parameters?.lessonPlanIds);
        const lessonPlanIds = explicitLessonPlanIds.length
            ? explicitLessonPlanIds
            : lessonPlansForSubjectIds(project, matchedIds).map(plan => plan.id);
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'lesson_plan_patch',
            target: {
                subjectIds: matchedIds,
                lessonPlanIds,
            },
            patch: { blockPreference: requirement.parameters?.blockPreference },
            status: lessonPlanIds.length ? 'ready' : 'needs_review',
            requiresConfirmation: true,
        };
    }
    if (requirement.applyTo === 'optimization' && requirement.intent === 'teacher_load_protection') {
        const teacherLimits = { consecutive: requirement.parameters?.maxConsecutive || 3 };
        const dailyLimit = Number(requirement.parameters?.maxDaily || requirement.parameters?.dailyLimit);
        if (Number.isFinite(dailyLimit) && dailyLimit > 0) teacherLimits.daily = dailyLimit;
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'soft_rules_patch',
            target: { teacherIds: matchedIds, derivedGroup: 'high_load_teachers' },
            patch: {
                balancedTeacherLoad: true,
                teacherLimits,
            },
            status: 'ready',
            requiresConfirmation: true,
        };
    }
    if (requirement.applyTo === 'model_extension') {
        if (!complexModelIsEnabled(project) || requirement.modelSupport?.supported === false) {
            return null;
        }
        if (requirement.intent === 'preferred_periods' && requirement.parameters?.weekPattern) {
            const subjectIds = matchedIds;
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { subjectIds },
                patch: {
                    weekPattern: requirement.parameters.weekPattern,
                    preferredSlots: requirement.parameters.slots || [],
                },
                status: subjectIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'avoid_periods' && requirement.parameters?.weekPattern) {
            const subjectIds = matchedIds;
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { subjectIds },
                patch: {
                    weekPattern: requirement.parameters.weekPattern,
                    avoidSlots: requirement.parameters.slots || [],
                },
                status: subjectIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'campus_commute_gap') {
            const teacherIds = requirement.object?.kind === 'teacher' ? matchedIds : [];
            const maxConsecutive = Number.parseInt(requirement.parameters?.maxConsecutiveAcrossCampus, 10);
            const gap = Number.isInteger(maxConsecutive) ? Math.max(0, maxConsecutive) : 1;
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { teacherIds },
                patch: {
                    commuteRules: {
                        defaultGapPeriods: gap,
                        teacherGapPeriods: Object.fromEntries(teacherIds.map(teacherId => [teacherId, gap])),
                    },
                },
                status: teacherIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'teaching_group_session') {
            const classIds = normalizedTextValues(120, requirement.parameters?.classIds, matchedIds);
            const subjectIds = normalizedTextValues(120, requirement.parameters?.subjectIds);
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { classIds, subjectIds },
                patch: {
                    teachingGroup: {
                        name: requirement.object?.name || '教学组',
                        classIds,
                        subjectIds,
                        mode: requirement.parameters?.mode || 'combined_class',
                    },
                },
                status: classIds.length >= 2 && subjectIds.length ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
        if (requirement.intent === 'room_requirement') {
            const subjectIds = normalizedTextValues(120, requirement.parameters?.subjectIds, matchedIds);
            const roomName = asText(requirement.parameters?.roomName, 120);
            return {
                id: `act_${requirement.id || index + 1}`,
                requirementId: requirement.id,
                kind: 'complex_model_patch',
                target: { subjectIds },
                patch: {
                    roomRequirement: {
                        roomName,
                        requiredTags: normalizedTextValues(120, requirement.parameters?.requiredTags),
                    },
                },
                status: subjectIds.length && roomName ? 'ready' : 'needs_review',
                requiresConfirmation: true,
            };
        }
    }
    if (requirement.applyTo === 'rule' && requirement.rowId) {
        return {
            id: `act_${requirement.id || index + 1}`,
            requirementId: requirement.id,
            kind: 'rules_patch',
            target: { rowIds: [requirement.rowId] },
            status: 'ready',
            requiresConfirmation: true,
        };
    }
    return null;
}

function requirementWithSourceProvenance(requirement = {}, sourceRequirement = {}, disambiguateId = false) {
    const source = sourceRequirement.source || {};
    const baseId = asText(requirement.id || '', 160) || 'req_text';
    const id = disambiguateId ? `${baseId}_${hashValue(sourceRequirement.sourceId || source.rawText || baseId, 12)}` : baseId;
    const parsedBy = normalizedParsedBy(requirement.parsedBy, sourceRequirement.parsedBy);
    return {
        ...requirement,
        id,
        requirementId: requirement.requirementId || id,
        sourceId: sourceRequirement.sourceId || '',
        textHash: source.textHash || sourceRequirement.textHash || '',
        origin: sourceRequirement.origin || requirement.origin || 'unknown',
        parsedBy,
        sourceSheet: source.sheetName || '',
        sourceRow: source.rowNumber || null,
        lineNumber: source.lineNumber || null,
        rawText: source.rawText || requirement.rawText || requirement.source?.rawText || '',
        source: {
            ...(requirement.source || {}),
            sourceId: sourceRequirement.sourceId || '',
            textHash: source.textHash || sourceRequirement.textHash || '',
            origin: sourceRequirement.origin || requirement.origin || 'unknown',
            parsedBy,
            sourceSheet: source.sheetName || '',
            sourceRow: source.rowNumber || null,
            sheetName: source.sheetName || '',
            rowNumber: source.rowNumber || null,
            lineNumber: source.lineNumber || null,
            rawText: source.rawText || requirement.source?.rawText || '',
        },
    };
}

function generatedTextRequirementSupersedesRow(requirement = {}, row = {}, project = {}) {
    const intent = normalizeRequirementIntentAlias(requirement.intent || requirement.type || '');
    const rowIntent = normalizeRequirementIntentAlias(row.intent || row.type || '');
    if (intent !== 'block_preference' || rowIntent !== 'block_integrity') return false;
    return semanticRequirementMatchesRow(requirement, row, project);
}

function buildRequirementSemantics(project = {}, rows = [], {
    originalText = '',
    semanticRequirements = [],
    sourceRequirements = [],
} = {}) {
    const sources = asList(sourceRequirements).filter(item => item && typeof item === 'object');
    const systemText = asText(originalText, 100000)
        || sources.map(item => item.source?.rawText || item.rawText || '').filter(Boolean).join('\\n');
    const systemRequirements = systemRequirementsFromText(systemText);
    const textRequirements = sources.length
        ? sources.flatMap(sourceRequirement => {
            const sourceText = sourceRequirement.source?.rawText || sourceRequirement.rawText || '';
            const generated = [
                ...blockPreferenceRequirementsFromText(project, sourceText),
                ...optimizationRequirementsFromText(project, sourceText),
                ...complexRequirementsFromText(project, sourceText),
            ];
            return generated.map(requirement => requirementWithSourceProvenance(requirement, sourceRequirement, sources.length > 1));
        })
        : [
            ...blockPreferenceRequirementsFromText(project, originalText),
            ...optimizationRequirementsFromText(project, originalText),
            ...complexRequirementsFromText(project, originalText),
        ];
    const externalRequirements = externalRequirementItems(semanticRequirements);
    const externalIds = new Set(externalRequirements.flatMap(item => [item.id, item.requirementId]).filter(Boolean));
    const rowRequirements = asList(rows).filter(row => row && typeof row === 'object')
        .filter(row => !row.requirementId || !externalIds.has(row.requirementId))
        .filter(row => {
            const supersedingRequirements = textRequirements
                .filter(requirement => generatedTextRequirementSupersedesRow(requirement, row, project));
            return supersedingRequirements.length !== 1;
        })
        .map((row, index) => requirementFromRow(row, index, project));
    const requirementItems = dedupeRequirements([
        ...externalRequirements,
        ...systemRequirements,
        ...textRequirements,
        ...rowRequirements,
    ]).map(item => (item.status === 'needs_review' ? applyClarificationPolicy(project, item) : item));
    const semanticActions = requirementItems
        .map((requirement, index) => actionForRequirement(project, requirement, index))
        .filter(Boolean);
    return { requirementItems, semanticActions };
}

export function applyTimetableRequirementActions({
    project: inputProject = {},
    actions = [],
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const next = normalizeTimetableProject({
        ...project,
        lessonPlans: (project.lessonPlans || []).map(plan => ({ ...plan })),
        rules: cloneValue(project.rules || {}),
    });
    next.rules = emptyRulesFrom(next);
    const applied = [];
    const skipped = [];
    const needsReview = [];

    const actionList = asList(actions).filter(action => action && typeof action === 'object');
    for (const action of actionList) {
        const id = asText(action?.id, 120) || `action_${applied.length + skipped.length + needsReview.length + 1}`;
        const kind = asText(action?.kind, 80);
        if (action?.status && !['ready', 'actionable'].includes(action.status)) {
            skipped.push({ id, kind, reason: '动作尚未确认或不可应用。' });
            continue;
        }

        if (kind === 'lesson_plan_patch') {
            const blockPreference = asText(action.patch?.blockPreference, 40);
            if (!['single', 'double', 'mixed'].includes(blockPreference)) {
                needsReview.push({ id, kind, reason: '缺少有效连堂设置。' });
                continue;
            }
            const explicitPlanIds = new Set(normalizedTextValues(120, action.target?.lessonPlanIds));
            const subjectIds = new Set(normalizedTextValues(120, action.target?.subjectIds));
            const targets = next.lessonPlans.filter(plan => explicitPlanIds.has(plan.id) || (!explicitPlanIds.size && subjectIds.has(plan.subjectId)));
            if (!targets.length) {
                needsReview.push({ id, kind, reason: '没有找到可修改的任课计划。' });
                continue;
            }
            targets.forEach(plan => {
                plan.blockPreference = blockPreference;
            });
            applied.push({ id, kind, count: targets.length });
            continue;
        }

        if (kind === 'soft_rules_patch') {
            let changed = false;
            next.rules.softRules = next.rules.softRules || {};
            if (action.patch?.balancedTeacherLoad !== undefined) {
                next.rules.softRules.balancedTeacherLoad = action.patch.balancedTeacherLoad !== false;
                changed = true;
            }
            const teacherLimitPatch = action.patch?.teacherLimits || {};
            const hasTeacherLimitPatch = Number.isInteger(Number(teacherLimitPatch.daily))
                || Number.isInteger(Number(teacherLimitPatch.consecutive));
            if (hasTeacherLimitPatch) {
                const teacherIds = normalizedTextValues(120, action.target?.teacherIds);
                const validTeacherIds = new Set((next.teachers || []).map(teacher => teacher.id));
                const matched = teacherIds.filter(idValue => validTeacherIds.has(idValue));
                const missing = teacherIds.filter(idValue => !validTeacherIds.has(idValue));
                matched.forEach(teacherId => addTeacherLimit(next.rules, teacherId, {
                    daily: Number.isInteger(Number(teacherLimitPatch.daily)) ? Number(teacherLimitPatch.daily) : undefined,
                    consecutive: Number.isInteger(Number(teacherLimitPatch.consecutive)) ? Number(teacherLimitPatch.consecutive) : undefined,
                }));
                if (matched.length) changed = true;
                if (missing.length) {
                    needsReview.push({ id, kind, reason: `教师 ${missing.join('、')} 不存在，未写入这些对象。` });
                }
                if (!matched.length && teacherIds.length) {
                    continue;
                }
            }
            const spreadSubjectIds = normalizedTextValues(120, action.patch?.spreadSubjectIds, action.target?.subjectIds);
            if (spreadSubjectIds.length && action.patch?.spreadSubjects !== false) {
                const validSubjectIds = new Set((next.subjects || []).map(subject => subject.id));
                spreadSubjectIds.filter(subjectId => validSubjectIds.has(subjectId)).forEach(subjectId => addSpreadSubject(next.rules, subjectId));
                changed = true;
            }
            if (changed) {
                applied.push({ id, kind });
            } else {
                needsReview.push({ id, kind, reason: '没有可写入的优化目标参数。' });
            }
            continue;
        }

        if (kind === 'complex_model_patch') {
            const changed = applyComplexModelPatch(next, action);
            if (changed) {
                applied.push({ id, kind });
            } else {
                needsReview.push({ id, kind, reason: '没有可写入的复杂模型参数。' });
            }
            continue;
        }

        if (kind === 'rules_patch') {
            skipped.push({ id, kind, reason: '规则类动作请继续通过现有规则应用流程写入。' });
            continue;
        }

        if (kind === 'handled_notice') {
            skipped.push({ id, kind, reason: '该需求已由系统自动处理。' });
            continue;
        }

        skipped.push({ id, kind, reason: '未知语义动作类型。' });
    }

    return {
        project: normalizeTimetableProject(next),
        applied,
        skipped,
        needsReview,
    };
}

function confidenceBucket(row = {}) {
    const value = Number(row.confidence);
    if (Number.isFinite(value) && value >= 0.85) return 'high';
    if (Number.isFinite(value) && value >= 0.65) return 'medium';
    return 'low';
}

function confidenceSummary(rows = []) {
    return rows.reduce((summary, row) => {
        summary[confidenceBucket(row)] += 1;
        return summary;
    }, { high: 0, medium: 0, low: 0 });
}

function buildMissingInfo(rows = []) {
    const items = [];
    rows.forEach((row, index) => {
        if (!['needs_review', 'invalid'].includes(row.status)) return;
        const text = row.targetName || row.targetId || row.className || row.teacherName || row.subjectName || row.rawText || '规则对象';
        const hasCandidates = (row.ambiguities || []).some(item => (item.candidates || []).length);
        if (hasCandidates) return;
        if (!row.warnings?.length && row.status !== 'invalid') return;
        items.push({
            id: `missing_${index + 1}`,
            message: row.warnings?.[0] || `${text} 信息不完整，请补充。`,
            relatedRuleIds: [row.id],
        });
    });
    return items;
}

function buildClarifyingQuestions(project = {}, rows = []) {
    const questions = [];
    const questionMap = new Map();
    rows.forEach(row => {
        if (isAllTeachersTarget(row)) return;
        const ambiguityMap = new Map();
        [...(row.ambiguities || []), row.ambiguity].filter(Boolean).forEach(item => {
            if (isAllTeachersTarget({
                targetId: item.targetId,
                targetName: item.targetText,
                target: item.target,
                rawText: item.targetText,
            })) return;
            const key = JSON.stringify([
                item.field || '',
                item.targetType || '',
                item.targetText || '',
                (item.candidates || []).map(candidate => candidate.id || candidate.value || candidate.label).sort(),
            ]);
            if (!ambiguityMap.has(key)) ambiguityMap.set(key, item);
        });
        const ambiguities = [...ambiguityMap.values()];
        ambiguities.forEach((ambiguity, index) => {
            const seenOptions = new Set();
            const options = (ambiguity.candidates || []).map(candidate => ({
                label: asText(candidate.label || candidate.name || candidate.value || candidate.id, 120),
                value: asText(candidate.id || candidate.value, 120),
            })).filter(option => {
                if (!option.label || !option.value || seenOptions.has(option.value)) return false;
                seenOptions.add(option.value);
                return true;
            });
            if (!options.length) return;
            const targetText = ambiguity.targetText || row.targetName || row.rawText || '这个对象';
            const typeLabel = {
                teacher: '老师',
                class: '班级',
                subject: '课程',
            }[ambiguity.targetType] || '对象';
            questions.push({
                id: `q_${row.id}_${ambiguity.field || index}`,
                question: `你说的${targetText}是哪一个${typeLabel}？`,
                reason: `存在多个可匹配的${typeLabel}，系统不会自动猜测。`,
                targetType: ambiguity.targetType || row.targetType || '',
                targetText,
                options,
                relatedRuleIds: [row.id],
            });
        });
    });
    const merged = [];
    questions.forEach(question => {
        const key = JSON.stringify([
            question.question || '',
            (question.options || []).map(option => option.value || option.id || option.label).sort(),
        ]);
        const existing = questionMap.get(key);
        if (existing) {
            existing.relatedRuleIds = [...new Set([...(existing.relatedRuleIds || []), ...(question.relatedRuleIds || [])].filter(Boolean))];
            return;
        }
        questionMap.set(key, question);
        merged.push(question);
    });
    return merged;
}

function buildRequirementClarifyingQuestions(requirementItems = []) {
    const seen = new Set();
    return asList(requirementItems).filter(item => item && typeof item === 'object').flatMap(item => {
        const clarification = normalizeRequirementClarification(item?.clarification, item?.id || '');
        if (!clarification) return [];
        const requirementId = asText(item.id, 120);
        const id = clarification.id || `clarify_${requirementId}_${clarification.field || 'value'}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{
            id,
            requirementId,
            question: clarification.question,
            reason: '这个需求缺少必要参数，系统不会自动猜测。',
            kind: clarification.kind,
            field: clarification.field,
            defaultValue: clarification.defaultValue,
            min: clarification.min,
            max: clarification.max,
            options: clarification.options || [],
            relatedRequirementIds: requirementId ? [requirementId] : [],
        }];
    });
}

function detectRuleConflicts(project = {}, draftRows = []) {
    const conflicts = [];
    const teacherUnavailable = new Map();
    const classUnavailable = new Map();
    const subjectAvoid = new Map();
    const teacherLimits = new Map();
    const teacherWeeklyLimits = new Map();
    const locked = [];

    const addMapSlots = (map, id, slots = [], ruleId = '') => {
        if (!id) return;
        const current = map.get(id) || [];
        asList(slots).forEach(slot => current.push({ slot, ruleId }));
        map.set(id, current);
    };

    Object.entries(project.rules?.hardRules?.teacherUnavailable || {}).forEach(([teacherId, slots]) => addMapSlots(teacherUnavailable, teacherId, slots, 'saved_teacher_unavailable'));
    Object.entries(project.rules?.hardRules?.classUnavailable || {}).forEach(([classId, slots]) => addMapSlots(classUnavailable, classId, slots, 'saved_class_unavailable'));
    Object.entries(project.rules?.softRules?.subjectPreferredPeriods || {}).forEach(([subjectId, rule]) => addMapSlots(subjectAvoid, subjectId, rule?.avoid || [], 'saved_subject_avoid'));
    Object.entries(project.rules?.softRules?.teacherLimits || {}).forEach(([teacherId, limits]) => {
        if (Number.isInteger(Number(limits?.daily))) teacherLimits.set(teacherId, { limit: Number(limits.daily), ruleId: 'saved_teacher_daily_limit' });
    });
    Object.entries(project.rules?.hardRules?.teacherWeeklyLimit || {}).forEach(([teacherId, limit]) => {
        if (Number.isInteger(Number(limit))) teacherWeeklyLimits.set(teacherId, { limit: Number(limit), ruleId: 'saved_teacher_weekly_limit' });
    });
    asList(project.rules?.hardRules?.lockedSlots).filter(slot => slot && typeof slot === 'object').forEach((slot, index) => locked.push({
        id: `saved_locked_${index + 1}`,
        teacherId: slot.teacherId,
        classId: slot.classId,
        subjectId: slot.subjectId,
        slot: slotKey(slot.day, slot.period),
    }));

    asList(draftRows).filter(row => row && typeof row === 'object' && row.status === 'effective').forEach(row => {
        if (row.type === 'teacher_unavailable') addMapSlots(teacherUnavailable, row.targetId, row.slots, row.id);
        if (row.type === 'class_unavailable') addMapSlots(classUnavailable, row.targetId, row.slots, row.id);
        if (row.type === 'subject_avoid_periods') addMapSlots(subjectAvoid, row.targetId, row.slots, row.id);
        if (row.type === 'global_unavailable') {
            (project.classes || []).forEach(klass => addMapSlots(classUnavailable, klass.id, row.slots, row.id));
        }
        if (row.type === 'teacher_daily_limit') {
            if (isAllTeachersTarget(row)) {
                (project.teachers || []).forEach(teacher => {
                    teacherLimits.set(teacher.id, { limit: row.limit, ruleId: row.id });
                });
            } else {
                teacherLimits.set(row.targetId, { limit: row.limit, ruleId: row.id });
            }
        }
        if (row.type === 'teacher_weekly_limit') {
            if (isAllTeachersTarget(row)) {
                (project.teachers || []).forEach(teacher => {
                    teacherWeeklyLimits.set(teacher.id, { limit: row.limit, ruleId: row.id });
                });
            } else {
                teacherWeeklyLimits.set(row.targetId, { limit: row.limit, ruleId: row.id });
            }
        }
        if (row.type === 'locked_slot') {
            const [slot] = asList(row.slots);
            if (slot) locked.push({
                id: row.id,
                teacherId: row.teacherId,
                classId: row.classId,
                subjectId: row.subjectId,
                slot,
            });
        }
    });

    const lockedByTeacherSlot = new Map();
    const lockedByClassSlot = new Map();
    locked.forEach(item => {
        const teacherKey = `${item.teacherId}|${item.slot}`;
        const classKey = `${item.classId}|${item.slot}`;
        lockedByTeacherSlot.set(teacherKey, [...(lockedByTeacherSlot.get(teacherKey) || []), item]);
        lockedByClassSlot.set(classKey, [...(lockedByClassSlot.get(classKey) || []), item]);
    });

    lockedByTeacherSlot.forEach(items => {
        const uniqueClasses = new Set(items.map(item => item.classId));
        if (items.length > 1 && uniqueClasses.size > 1) {
            conflicts.push({
                level: 'blocking',
                message: '同一老师在同一节被多个锁定课节占用。',
                relatedRuleIds: items.map(item => item.id),
                suggestion: '请只保留其中一个锁定课节，或更换教师/节次。',
            });
        }
    });
    lockedByClassSlot.forEach(items => {
        const uniqueSubjects = new Set(items.map(item => item.subjectId));
        if (items.length > 1 && uniqueSubjects.size > 1) {
            conflicts.push({
                level: 'blocking',
                message: '同一班级同一节被多个课程锁定。',
                relatedRuleIds: items.map(item => item.id),
                suggestion: '请取消重复锁定，或改到不同节次。',
            });
        }
    });

    locked.forEach(item => {
        const teacherBlocked = (teacherUnavailable.get(item.teacherId) || []).filter(rule => rule.slot === item.slot);
        teacherBlocked.forEach(rule => conflicts.push({
            level: 'blocking',
            message: '老师不可排时间与锁定课节冲突。',
            relatedRuleIds: [item.id, rule.ruleId].filter(Boolean),
            suggestion: '请取消其中一个硬约束，或把锁定课节改到可用时间。',
        }));
        const classBlocked = (classUnavailable.get(item.classId) || []).filter(rule => rule.slot === item.slot);
        classBlocked.forEach(rule => conflicts.push({
            level: 'blocking',
            message: '班级不可排时间与锁定课节冲突。',
            relatedRuleIds: [item.id, rule.ruleId].filter(Boolean),
            suggestion: '请取消其中一个硬约束，或调整班级不可排时间。',
        }));
        const subjectAvoided = (subjectAvoid.get(item.subjectId) || []).filter(rule => rule.slot === item.slot);
        subjectAvoided.forEach(rule => conflicts.push({
            level: 'warning',
            message: '课程避开节次与锁定课节存在偏好冲突。',
            relatedRuleIds: [item.id, rule.ruleId].filter(Boolean),
            suggestion: '如果必须锁定，可保留；否则建议调整避开节次或锁定节次。',
        }));
    });

    teacherLimits.forEach(({ limit, ruleId }, teacherId) => {
        if (!Number.isInteger(Number(limit)) || Number(limit) <= 0) return;
        const lockedByDay = new Map();
        locked.filter(item => item.teacherId === teacherId).forEach(item => {
            const day = String(item.slot).split('-')[0];
            lockedByDay.set(day, [...(lockedByDay.get(day) || []), item]);
        });
        lockedByDay.forEach(items => {
            if (items.length > Number(limit)) {
                conflicts.push({
                    level: 'blocking',
                    message: '教师每日最多节数小于已有硬锁定课节数。',
                    relatedRuleIds: [ruleId, ...items.map(item => item.id)].filter(Boolean),
                    suggestion: '请放宽教师每日上限，或减少当天锁定课节。',
                });
            }
        });
    });

    teacherWeeklyLimits.forEach(({ limit, ruleId }, teacherId) => {
        if (!Number.isInteger(Number(limit)) || Number(limit) <= 0) return;
        const load = (project.lessonPlans || []).reduce((sum, plan) => {
            const ids = [...new Set([...asList(plan.teacherIds), plan.teacherId].filter(Boolean))];
            return ids.includes(teacherId) ? sum + (Number.parseInt(plan.weeklyHours, 10) || 0) : sum;
        }, 0);
        if (load > Number(limit)) {
            const teacher = (project.teachers || []).find(item => item.id === teacherId);
            conflicts.push({
                level: 'blocking',
                message: `${teacher?.name || teacherId} 每周上限 ${Number(limit)} 节，但任课计划共 ${load} 节，无解。`,
                relatedRuleIds: [ruleId].filter(Boolean),
                suggestion: '请放宽教师每周上限，或调整该教师任课计划课时。',
            });
        }
    });

    const seen = new Set();
    return conflicts.filter(conflict => {
        const key = JSON.stringify([conflict.level, conflict.message, conflict.relatedRuleIds]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function createRuleReport(sourceKind = 'rules') {
    const entries = [];
    const seen = new Set();
    const add = (category, { source = null, field = '', reason = '', originalValue } = {}) => {
        const key = JSON.stringify([category, source, field, reason]);
        if (seen.has(key)) return null;
        seen.add(key);
        const entry = { category, source, field, reason };
        if (originalValue !== undefined) entry.originalValue = originalValue;
        entries.push(entry);
        return entry;
    };
    return {
        kept: info => add('kept', info),
        degraded: info => add('degraded', info),
        dropped: info => add('dropped', info),
        review: info => add('review', info),
        toJSON() {
            const summary = { total: entries.length, kept: 0, degraded: 0, dropped: 0, review: 0 };
            entries.forEach(entry => {
                if (summary[entry.category] !== undefined) summary[entry.category] += 1;
            });
            return {
                sourceKind,
                summary,
                entries: entries.slice(),
                hasIssues: entries.some(entry => entry.category !== 'kept'),
            };
        },
    };
}

function ruleReportSource(row = {}, inputType = '') {
    return {
        rowId: row.id || null,
        inputType: inputType || null,
    };
}

function ruleReportLabel(row = {}) {
    return row.targetName || row.targetId || row.teacherName || row.className || row.subjectName || row.rawText || row.type || '规则';
}

function buildTimetableRuleReport({
    rows = [],
    autoAcceptable = [],
    needReview = [],
    unsupportedItems = [],
    clarifyingQuestions = [],
    missingInfo = [],
    conflicts = [],
    warnings = [],
    inputType = '',
} = {}) {
    const report = createRuleReport('rules');
    const autoIds = new Set(autoAcceptable.map(row => row.id).filter(Boolean));
    const needReviewIds = new Set(needReview.map(row => row.id).filter(Boolean));
    const unsupportedIds = new Set(unsupportedItems.map(row => row.id).filter(Boolean));

    autoAcceptable.forEach(row => report.kept({
        source: ruleReportSource(row, inputType),
        field: row.type || 'rule',
        reason: `${ruleReportLabel(row)} 高置信度规则，可确认后写入。`,
    }));

    needReview.forEach(row => {
        const category = row.status === 'invalid' || row.sourceStatus === 'invalid' ? 'dropped' : 'review';
        report[category]({
            source: ruleReportSource(row, inputType),
            field: row.type || 'rule',
            reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 需要复核后才能生效。`,
        });
    });

    unsupportedItems.forEach(row => report.degraded({
        source: ruleReportSource(row, inputType),
        field: row.type || 'rule',
        reason: row.description || row.message || `${ruleReportLabel(row)} 当前只能作为建议展示，不会直接写入规则。`,
    }));

    rows.forEach(row => {
        if (!row.id || autoIds.has(row.id) || needReviewIds.has(row.id) || unsupportedIds.has(row.id)) return;
        if (row.status === 'invalid') {
            report.dropped({
                source: ruleReportSource(row, inputType),
                field: row.type || 'rule',
                reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 无法应用，请删除或重写。`,
            });
        } else if (row.status === 'suggestion' || row.status === 'unsupported') {
            report.degraded({
                source: ruleReportSource(row, inputType),
                field: row.type || 'rule',
                reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 当前只能作为建议展示，不会直接写入规则。`,
            });
        } else if (row.status === 'needs_review') {
            report.review({
                source: ruleReportSource(row, inputType),
                field: row.type || 'rule',
                reason: (row.warnings || [])[0] || `${ruleReportLabel(row)} 需要复核后才能生效。`,
            });
        }
    });

    clarifyingQuestions.forEach(question => report.review({
        source: { rowId: (question.relatedRuleIds || [])[0] || null, inputType: inputType || null },
        field: question.targetType || 'clarifying_question',
        reason: question.reason || question.question || '需要补充信息后才能继续。',
    }));

    missingInfo.forEach(item => report.review({
        source: { rowId: (item.relatedRuleIds || [])[0] || null, inputType: inputType || null },
        field: item.targetType || 'missing_info',
        reason: item.message || '缺少必要信息，需要复核。',
    }));

    conflicts.forEach(item => {
        const category = item.level === 'blocking' || item.severity === 'blocking' ? 'dropped' : 'review';
        report[category]({
            source: { rowId: (item.relatedRuleIds || [])[0] || null, inputType: inputType || null },
            field: 'conflict',
            reason: item.message || item.suggestion || '规则之间存在冲突。',
        });
    });

    warnings.forEach(item => report.review({
        source: { rowId: null, inputType: inputType || null },
        field: 'warning',
        reason: item,
    }));

    return report.toJSON();
}

function buildRuleReviewResult({
    project,
    rows,
    warnings = [],
    warningItems = [],
    rejected = [],
    unsupportedItems = [],
    source,
    inputType,
    contextStats,
    draftRules,
    previewItems,
    requirementItems = [],
    semanticActions = [],
    constraintIRs = [],
    parserVersion = PARSER_VERSION,
    parseSource = source,
    cacheHit = false,
}) {
    const conflicts = detectRuleConflicts(project, rows);
    const clarifyingQuestions = [
        ...buildClarifyingQuestions(project, rows),
        ...buildRequirementClarifyingQuestions(requirementItems),
    ];
    const missingInfo = buildMissingInfo(rows);
    const blockingRuleIds = new Set(conflicts.filter(item => item.level === 'blocking').flatMap(item => item.relatedRuleIds || []));
    const autoAcceptable = rows.filter(row => (
        row.status === 'effective'
        && SUPPORTED_EFFECTIVE_TYPES.has(row.type)
        && Number(row.confidence || 0) >= 0.85
        && !(row.warnings || []).length
        && !(row.ambiguity || (row.ambiguities || []).length)
        && !blockingRuleIds.has(row.id)
    ));
    const needReview = rows.filter(row => (
        ['needs_review', 'invalid'].includes(row.status)
        || (
            SUPPORTED_EFFECTIVE_TYPES.has(row.type)
            && row.status === 'effective'
            && (
                Number(row.confidence || 0) < 0.85
                || (row.warnings || []).length
                || row.ambiguity
                || (row.ambiguities || []).length
            )
        )
    ));
    const nextAction = clarifyingQuestions.length || missingInfo.length
        ? 'ask_user'
        : !rows.length && !requirementItems.length
            ? 'no_result'
            : conflicts.some(item => item.level === 'blocking') || needReview.length || unsupportedItems.length || autoAcceptable.length < rows.filter(row => row.status === 'effective').length
                ? 'review'
                : 'ready_to_apply';
    const ruleReport = buildTimetableRuleReport({
        rows,
        autoAcceptable,
        needReview,
        unsupportedItems,
        clarifyingQuestions,
        missingInfo,
        conflicts,
        warnings,
        inputType,
    });

    return {
        draftRules,
        draftRows: rows,
        previewItems,
        requirementItems,
        semanticActions,
        constraintIRs,
        autoAcceptable,
        needReview,
        clarifyingQuestions,
        missingInfo,
        conflicts,
        warnings,
        warningItems,
        rejected,
        unsupportedItems,
        ruleReport,
        confidenceSummary: confidenceSummary(rows),
        nextAction,
        source,
        parseSource: parseSource || source,
        inputType,
        contextStats,
        parserVersion,
        cacheHit: Boolean(cacheHit),
    };
}

function splitParseResult(options = {}) {
    return buildRuleReviewResult(options);
}

function applyClarifyingAnswers(draftRows = [], answers = []) {
    const rowList = asList(draftRows).filter(row => row && typeof row === 'object');
    const byQuestion = new Map(asList(answers).filter(answer => answer && typeof answer === 'object').map(answer => [
        asText(answer.questionId || answer.id, 160),
        answer,
    ]));
    if (!byQuestion.size) return rowList;
    return rowList.map(row => {
        const next = cloneValue(row);
        const ambiguities = [...asList(next.ambiguities), next.ambiguity]
            .filter(ambiguity => ambiguity && typeof ambiguity === 'object');
        for (const ambiguity of ambiguities) {
            const questionId = `q_${next.id}_${ambiguity.field || 'target'}`;
            const answer = byQuestion.get(questionId);
            if (!answer?.value) continue;
            const selected = asList(ambiguity.candidates)
                .filter(candidate => candidate && typeof candidate === 'object')
                .find(candidate => candidate.id === answer.value || candidate.value === answer.value) || {
                id: answer.value,
                value: answer.value,
                label: answer.label,
                name: answer.label,
            };
            if (ambiguity.field === 'teacher' || ambiguity.targetType === 'teacher') {
                next.teacherId = selected.id || selected.value;
                next.teacherName = selected.label || selected.name || answer.label || answer.value;
                if (next.targetType === 'teacher') {
                    next.targetId = next.teacherId;
                    next.targetName = next.teacherName;
                }
            } else if (ambiguity.field === 'class' || ambiguity.targetType === 'class') {
                next.classId = selected.id || selected.value;
                next.className = selected.label || selected.name || answer.label || answer.value;
                if (next.targetType === 'class') {
                    next.targetId = next.classId;
                    next.targetName = next.className;
                }
            } else if (ambiguity.field === 'subject' || ambiguity.targetType === 'subject') {
                next.subjectId = selected.id || selected.value;
                next.subjectName = selected.label || selected.name || answer.label || answer.value;
                if (next.targetType === 'subject') {
                    next.targetId = next.subjectId;
                    next.targetName = next.subjectName;
                }
            }
            next.ambiguity = null;
            next.ambiguities = [];
            next.status = 'effective';
            next.confidence = Math.max(Number(next.confidence) || 0, 0.88);
            next.warnings = asList(next.warnings).filter(warning => !/多个候选|请确认/.test(String(warning || '')));
        }
        return next;
    });
}

function requirementAnswerKey(answer = {}) {
    return [
        asText(answer.requirementId || answer.id || '', 120),
        asText(answer.field || '', 80),
    ].join(':');
}

function requirementObjectKey(object = {}) {
    return JSON.stringify([
        asText(object?.kind || '', 80),
        asText(object?.name || '', 200),
        normalizedTextValues(120, object?.matchedIds).sort(),
    ]);
}

function looseRequirementObjectKey(object = {}) {
    return JSON.stringify([
        asText(object?.kind || '', 80),
        asText(object?.name || '', 200),
    ]);
}

function normalizeClarificationValue(clarification = null, rawValue = null) {
    if (clarification?.kind === 'number') {
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return rawValue;
        const min = Number.isFinite(Number(clarification.min)) ? Number(clarification.min) : null;
        const max = Number.isFinite(Number(clarification.max)) ? Number(clarification.max) : null;
        return Math.min(max ?? value, Math.max(min ?? value, value));
    }
    return rawValue;
}

function selectedOptionLabel(clarification = {}, value = '') {
    const option = asList(clarification.options).find(item => String(item?.value ?? item?.id ?? item?.label ?? item) === String(value));
    return asText(option?.label || option?.name || '', 200);
}

function applyRequirementClarifyingAnswers(requirementItems = [], answers = [], project = {}) {
    const answerList = asList(answers).filter(answer => answer && typeof answer === 'object');
    const itemList = asList(requirementItems).filter(item => item && typeof item === 'object');
    const answerMap = new Map(answerList.map(answer => [
        requirementAnswerKey(answer),
        answer,
    ]));
    if (!answerMap.size) return itemList;
    const itemById = new Map(itemList
        .map(item => [asText(item?.id, 120), item])
        .filter(([id]) => id));
    const answeredSignatures = new Map();
    const looseAnsweredSignatures = new Map();
    answerList.forEach(answer => {
        const requirement = itemById.get(asText(answer.requirementId || answer.id, 120));
        if (!requirement) return;
        const signature = [
            normalizeRequirementIntentAlias(requirement.intent || ''),
            normalizeRequirementApplyToAlias(requirement.applyTo || ''),
            requirementObjectKey(requirement.object || {}),
            asText(answer.field || '', 80),
        ];
        answeredSignatures.set(JSON.stringify(signature), answer);
        looseAnsweredSignatures.set(JSON.stringify([
            signature[0],
            signature[1],
            looseRequirementObjectKey(requirement.object || {}),
            signature[3],
        ]), answer);
    });
    return itemList.map(item => {
        const next = cloneValue(item);
        const clarification = normalizeRequirementClarification(next.clarification, next.id || '');
        if (!clarification) return next;
        const directAnswer = answerMap.get(requirementAnswerKey({
            requirementId: next.id,
            field: clarification.field,
        }));
        const signatureAnswer = answeredSignatures.get(JSON.stringify([
            normalizeRequirementIntentAlias(next.intent || ''),
            normalizeRequirementApplyToAlias(next.applyTo || ''),
            requirementObjectKey(next.object || {}),
            clarification.field,
        ]));
        const looseSignatureAnswer = looseAnsweredSignatures.get(JSON.stringify([
            normalizeRequirementIntentAlias(next.intent || ''),
            normalizeRequirementApplyToAlias(next.applyTo || ''),
            looseRequirementObjectKey(next.object || {}),
            clarification.field,
        ]));
        const answer = directAnswer || signatureAnswer || looseSignatureAnswer;
        if (!answer || answer.value === undefined || answer.value === null || String(answer.value).trim() === '') return next;
        const value = normalizeClarificationValue(clarification, answer.value);
        next.parameters = {
            ...(next.parameters && typeof next.parameters === 'object' ? next.parameters : {}),
            [clarification.field]: value,
        };
        next.clarificationHistory = [
            ...asList(next.clarificationHistory),
            {
                question: clarification.question || '',
                field: clarification.field || '',
                kind: clarification.kind || '',
                answer: value,
                answerLabel: answer.label || selectedOptionLabel(clarification, value) || String(value),
                at: new Date().toISOString(),
            },
        ];
        const policyResult = applyClarificationPolicy(project, {
            ...next,
            status: 'actionable',
            clarification: null,
        });
        next.parameters = policyResult.parameters || next.parameters;
        next.status = policyResult.status || 'actionable';
        next.applyTo = policyResult.applyTo || next.applyTo;
        next.clarification = policyResult.clarification || null;
        next.confidence = Math.max(Number(next.confidence) || 0, 0.86);
        next.warnings = (next.warnings || []).filter(warning => !/缺少|补充|确认/.test(warning));
        return next;
    });
}

export function continueTimetableRuleConversation({
    project: inputProject = {},
    draftRows = [],
    answers = [],
    inputType = 'clarification',
    contextStats = null,
    originalText = '',
    previousResult = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: applyClarifyingAnswers(draftRows, answers),
        source: 'clarification',
        inputType,
        contextStats,
    });
    return {
        ...result,
        originalText,
        answers,
        previousResult,
    };
}

function requirementItemsForClarification(previousResult = {}) {
    const legacyItems = externalRequirementItems(previousResult?.requirementItems || []);
    if (legacyItems.length) return legacyItems;

    return externalRequirementItems(buildLegacyRequirementItemsFromSources(
        previousResult?.sourceRequirements || [],
    ));
}

export function continueTimetableRequirementClarification({
    project: inputProject = {},
    previousResult = {},
    answers = [],
    inputType = 'requirement_clarification',
    contextStats = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const sourceRequirements = cloneValue(asList(previousResult?.sourceRequirements)
        .filter(item => item && typeof item === 'object'));
    const rows = cloneValue(asList(previousResult?.draftRows)
        .filter(item => item && typeof item === 'object'));
    const requirementItems = applyRequirementClarifyingAnswers(
        requirementItemsForClarification(previousResult),
        answers,
        project,
    );
    const semanticActions = requirementItems
        .map((requirement, index) => actionForRequirement(project, requirement, index))
        .filter(Boolean);
    const constraintLayer = compileArtifactsThroughCapabilityRegistry({
        project,
        rows,
        requirementItems,
        sourceRequirements,
    });
    const reviewRows = constraintLayer.rows;
    const result = buildRuleReviewResult({
        project,
        draftRules: previousResult?.draftRules || emptyRulesFrom(project),
        rows: reviewRows,
        previewItems: previewRows(reviewRows),
        requirementItems,
        semanticActions,
        constraintIRs: constraintLayer.constraintIRs,
        warnings: previousResult?.warnings || [],
        warningItems: previousResult?.warningItems || [],
        rejected: previousResult?.rejected || [],
        unsupportedItems: previousResult?.unsupportedItems || [],
        source: 'clarification',
        inputType: inputType || previousResult?.inputType || 'requirement_clarification',
        contextStats: contextStats || previousResult?.contextStats || null,
        parserVersion: previousResult?.parserVersion || PARSER_VERSION,
        parseSource: previousResult?.parseSource || 'clarification',
        cacheHit: false,
    });
    return sourceAwareParseResult({
        ...result,
        originalText: previousResult?.originalText || '',
        answers: cloneValue(answers),
        systemSupplements: cloneValue(previousResult?.systemSupplements || []),
        manualRequirements: cloneValue(previousResult?.manualRequirements || []),
    }, sourceRequirements, { parsedBy: 'clarification' });
}

function nameById(items = [], id = '', fallback = '') {
    const item = (items || []).find(entry => entry.id === id);
    return item?.name || entityLabel(item) || fallback || id;
}

export function diagnoseTimetableRules({
    project: inputProject = {},
    draftRows = [],
    solverFailure = null,
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const normalized = normalizeTimetableRuleDraftRows({
        project,
        draftRows,
        source: 'diagnose',
        inputType: 'diagnose',
    });
    const teacherUnavailable = Object.entries(project.rules?.hardRules?.teacherUnavailable || {})
        .map(([teacherId, slots]) => ({
            label: `${nameById(project.teachers, teacherId)}：${(slots || []).length} 个不可排节次`,
            count: (slots || []).length,
        }))
        .sort((left, right) => right.count - left.count);
    const classUnavailable = Object.entries(project.rules?.hardRules?.classUnavailable || {})
        .map(([classId, slots]) => ({
            label: `${nameById(project.classes, classId)}：${(slots || []).length} 个不可排节次`,
            count: (slots || []).length,
        }))
        .sort((left, right) => right.count - left.count);
    const blockingRules = [
        ...normalized.conflicts.filter(item => item.level === 'blocking').map(item => item.message),
        ...teacherUnavailable.filter(item => item.count >= Math.max(3, getActivePeriods(project).length - 1)).map(item => item.label),
        ...classUnavailable.filter(item => item.count >= Math.max(3, getActivePeriods(project).length - 1)).map(item => item.label),
    ];
    const suggestedRelaxations = blockingRules.length
        ? [
            '优先检查硬性不可排、锁定课节和教师每日上限。',
            '非必须的时间偏好建议改为软约束，或缩小到更少节次。',
        ]
        : ['当前没有发现明显规则级无解风险，可继续试排并查看质量建议。'];
    return {
        summary: blockingRules.length
            ? '当前无解风险主要来自硬性约束过强或锁定课节冲突。'
            : (solverFailure?.message || solverFailure?.reason)
                ? '暂未发现明确规则冲突，建议结合求解失败详情继续检查。'
                : '当前约束没有明显无解风险。',
        blockingRules,
        suggestedRelaxations,
        questions: normalized.clarifyingQuestions || [],
        conflicts: normalized.conflicts || [],
    };
}

function rowIdentityNeedsStabilizing(row = {}, source = '') {
    return ['local_xlsx', 'ai_supplement', 'cache', 'mixed_xlsx'].includes(row.parseSource || source);
}

function stableRowSortKey(row = {}) {
    return [
        row.sourceSheet || '',
        String(row.sourceRow || '').padStart(6, '0'),
        row.type || '',
        row.targetId || row.targetName || row.teacherId || row.classId || row.subjectId || '',
        (row.slots || []).join(','),
        row.rawText || '',
    ].join('|');
}

function stableKeyForRow(row = {}) {
    return hashValue({
        sourceSheet: row.sourceSheet || '',
        sourceRow: row.sourceRow || null,
        type: row.type || '',
        targetType: row.targetType || '',
        targetId: row.targetId || '',
        targetName: row.targetName || '',
        teacherId: row.teacherId || '',
        classId: row.classId || '',
        subjectId: row.subjectId || '',
        slots: row.slots || [],
        days: row.days || [],
        periods: row.periods || [],
        limit: row.limit || null,
        weekPattern: row.weekPattern || '',
        rawText: row.rawText || '',
    }, 20);
}

function stabilizeParsedRows(rows = [], source = '') {
    return [...rows]
        .sort((left, right) => stableRowSortKey(left).localeCompare(stableRowSortKey(right), 'zh-Hans-CN'))
        .map((row, index) => {
            if (!rowIdentityNeedsStabilizing(row, source)) return row;
            const stableKey = row.stableKey || stableKeyForRow(row);
            return {
                ...row,
                stableKey,
                id: `rule_${stableKey}`,
                parseSource: row.parseSource || source,
                source: row.source || row.parseSource || source,
                sourceOrder: index + 1,
            };
        });
}

export function normalizeTimetableRuleDraftRows({
    project: inputProject = {},
    draftRows = [],
    source = 'review',
    inputType = 'review',
    contextStats = null,
    initialWarnings = [],
    rejected = [],
    originalText = '',
    semanticRequirements = [],
    sourceRequirements = [],
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const rules = emptyRulesFrom(project);
    const initialWarningItems = [...initialWarnings].filter(item => item && typeof item === 'object');
    const warnings = [...initialWarnings]
        .map(item => typeof item === 'string' ? item : item?.message || item?.reason || item?.description || '')
        .map(item => asText(item, 240))
        .filter(Boolean);
    let unsupportedItems = [];
    let effectiveDraftRows = asList(draftRows).filter(item => item && typeof item === 'object');
    let effectiveSourceRequirements = asList(sourceRequirements).filter(item => item && typeof item === 'object');
    const parseActor = inputType === 'manual' ? 'manual' : source;
    if (inputType === 'manual' && !effectiveSourceRequirements.length && effectiveDraftRows.length) {
        const prepared = prepareSourceInputs({
            inputType: 'manual',
            constraintRows: effectiveDraftRows,
            origin: 'manual',
        });
        effectiveDraftRows = prepared.sourceRows;
        effectiveSourceRequirements = prepared.sourceRequirements;
    }
    const effectiveSemanticRequirements = asList(semanticRequirements)
        .filter(requirement => requirement && typeof requirement === 'object')
        .map(requirement => {
        if (!effectiveSourceRequirements.length || requirement.origin === 'system_supplement') return requirement;
        const linked = linkArtifactToSource(requirement, effectiveSourceRequirements, {
            parsedBy: parserActors(parseActor)[0] || '',
        });
        return linked.source ? linked.artifact : requirement;
    });
    const compiledRows = effectiveSemanticRequirements
        .flatMap((requirement, index) => {
            if (requirement.executionStatus === 'unsupported_by_solver'
                || requirement.executionStatus === 'needs_clarification'
                || requirement.support === 'none') return [];
            const rows = compileRequirementToRows(requirement, project);
            if (!rows) return [];
            const requirementSource = requirement.source && typeof requirement.source === 'object' ? requirement.source : {};
            return rows.map((row, rowIndex) => ({
                ...row,
                id: row.id || `compiled_${index + 1}_${rowIndex + 1}`,
                requirementId: requirement.id || requirement.requirementId || row.requirementId || '',
                clauseId: requirement.clauseId || row.clauseId || '',
                sourceId: requirement.sourceId || requirementSource.sourceId || row.sourceId || '',
                textHash: requirement.textHash || requirementSource.textHash || row.textHash || '',
                origin: requirement.origin || requirementSource.origin || row.origin || (inputType === 'manual' ? 'manual' : 'unknown'),
                parsedBy: normalizedParsedBy(requirement.parsedBy, requirementSource.parsedBy, row.parsedBy),
                sourceSheet: requirement.sourceSheet || requirementSource.sourceSheet || requirementSource.sheetName || row.sourceSheet || '',
                sourceRow: requirement.sourceRow || requirementSource.sourceRow || requirementSource.rowNumber || row.sourceRow || null,
                lineNumber: requirement.lineNumber || requirementSource.lineNumber || row.lineNumber || null,
                rawText: row.rawText || requirement.rawText || requirementSource.rawText || '',
                normalizationTrace: row.normalizationTrace?.length
                    ? row.normalizationTrace
                    : (requirement.normalizationTrace || requirementSource.normalizationTrace || []),
                negation: row.negation ?? requirement.negation ?? null,
                exceptions: row.exceptions?.length ? row.exceptions : (requirement.exceptions || []),
                activity: row.activity ?? requirement.activity ?? null,
                aiReviewStatus: row.aiReviewStatus || requirement.aiReviewStatus || '',
                aiReviewIssueCode: row.aiReviewIssueCode || requirement.aiReviewIssueCode || '',
                aiReviewValidationStatus: row.aiReviewValidationStatus || requirement.aiReviewValidationStatus || '',
                aiReviewBlocking: row.aiReviewBlocking === true || requirement.aiReviewBlocking === true,
                aiReviewValidationEvidence: uniqueConstraintMessages([
                    ...asList(requirement.aiReviewValidationEvidence),
                    ...asList(row.aiReviewValidationEvidence),
                ]),
                aiReviewWarnings: uniqueConstraintMessages([
                    ...asList(requirement.aiReviewWarnings),
                    ...asList(row.aiReviewWarnings),
                ]),
            }));
        });

    const candidateDraftRows = [...effectiveDraftRows, ...compiledRows]
        .filter(row => !isSystemHandledDraftRow(row));
    const draftRowStatusRank = status => ({ effective: 5, ready: 5, actionable: 4, suggestion: 3, needs_review: 2, unsupported: 1 }[status] || 0);
    const dedupedDraftRows = [];
    const draftRowIndexes = new Map();
    for (const row of candidateDraftRows) {
        const requirementId = row.requirementId || row.clauseId || '';
        if (!requirementId) {
            dedupedDraftRows.push(row);
            continue;
        }
        const key = JSON.stringify([
            requirementId,
            row.type || '',
            row.targetId || row.teacherId || row.classId || row.subjectId || row.targetName || '',
            [...new Set(asList(row.slots))].sort(),
            row.limit ?? row.minGapDays ?? null,
        ]);
        const existingIndex = draftRowIndexes.get(key);
        if (existingIndex === undefined) {
            draftRowIndexes.set(key, dedupedDraftRows.length);
            dedupedDraftRows.push(row);
        } else if (draftRowStatusRank(row.status) > draftRowStatusRank(dedupedDraftRows[existingIndex].status)) {
            dedupedDraftRows[existingIndex] = row;
        }
    }

    let rows = dedupedDraftRows
        .flatMap((row, index) => expandGroupedEntityTarget(row, index, project))
        .map((row, index) => classifyDraftRow(normalizeDraftRow(row, index, project), project))
        .map(row => {
            if (['ignored', 'suggestion', 'unsupported', 'invalid', 'needs_review'].includes(row.status)) {
                if (row.status === 'needs_review' && (row.targetName || row.targetId)) {
                    warnings.push(`${row.targetName || row.targetId} 需要复核后才能生效。`);
                }
                if (row.status === 'suggestion' || row.status === 'unsupported') unsupportedItems.push(previewFromRow(row));
                return row;
            }

            if (!SUPPORTED_EFFECTIVE_TYPES.has(row.type)) {
                const next = {
                    ...row,
                    status: SUGGESTION_ONLY_TYPES.has(row.type) ? 'suggestion' : 'unsupported',
                    warnings: [...row.warnings, '当前版本只能预览这类建议，暂不会写入排课规则。'],
                };
                unsupportedItems.push(previewFromRow(next));
                return next;
            }

            if (row.type === 'locked_slot') {
                const classTarget = findEntity(project.classes, {
                    targetId: row.classId,
                    targetName: row.className || row.targetName,
                });
                const subjectTarget = findEntity(project.subjects, {
                    targetId: row.subjectId,
                    targetName: row.subjectName || row.targetName,
                });
                const teacherTarget = findEntity(project.teachers, {
                    targetId: row.teacherId,
                    targetName: row.teacherName || row.targetName,
                });
                const slot = parseFirstSlot(row.slots);
                if (!classTarget || !subjectTarget || !teacherTarget || !slot) {
                    const reason = `${row.targetName || row.rawText || '锁定课节'} 缺少可匹配的班级、课程、教师或节次，请复核。`;
                    warnings.push(reason);
                    return {
                        ...row,
                        status: 'needs_review',
                        targetType: 'locked_slot',
                        warnings: [...row.warnings, reason],
                    };
                }
                const plan = findLockedLessonPlan(project, {
                    classId: classTarget.id,
                    subjectId: subjectTarget.id,
                    teacherId: teacherTarget.id,
                });
                const locked = {
                    id: row.id,
                    day: slot.day,
                    period: slot.period,
                    classId: classTarget.id,
                    subjectId: subjectTarget.id,
                    teacherId: teacherTarget.id,
                    lessonPlanId: plan?.id || null,
                    roomId: plan?.roomId || null,
                };
                addLockedSlot(rules, locked);
                return {
                    ...row,
                    targetType: 'locked_slot',
                    targetId: `${classTarget.id}:${subjectTarget.id}:${teacherTarget.id}`,
                    targetName: `${entityLabel(classTarget)} / ${subjectTarget.name || subjectTarget.id} / ${teacherTarget.name || teacherTarget.id}`,
                    classId: classTarget.id,
                    className: entityLabel(classTarget),
                    subjectId: subjectTarget.id,
                    subjectName: subjectTarget.name || row.subjectName,
                    teacherId: teacherTarget.id,
                    teacherName: teacherTarget.name || row.teacherName,
                    slots: [slotKey(slot.day, slot.period)],
                    priority: 'hard',
                    status: 'effective',
                };
            }

            const target = findTarget(project, row, row.type);
            const targetType = targetTypeFor(row.type, row);
            const slots = row.slots || [];

            if (row.type === 'teacher_unavailable') {
                if (!target || !slots.length) {
                    const reason = `${row.targetName || row.targetId || '教师'} 缺少可匹配教师或节次，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'teacher', warnings: [...row.warnings, reason] };
                }
                addSlots(rules.hardRules.teacherUnavailable, target.id, slots);
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, status: 'effective' };
            }

            if (row.type === 'class_unavailable') {
                if (!target || !slots.length) {
                    const reason = `${row.targetName || row.targetId || '班级'} 缺少可匹配班级或节次，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'class', warnings: [...row.warnings, reason] };
                }
                addSlots(rules.hardRules.classUnavailable, target.id, slots);
                return { ...row, targetType, targetId: target.id, targetName: entityLabel(target), status: 'effective' };
            }

            if (row.type === 'global_unavailable') {
                if (!slots.length) {
                    const reason = '全校不可排缺少明确节次，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', targetName: '全校', warnings: [...row.warnings, reason] };
                }
                addGlobalUnavailable(rules, slots);
                return { ...row, targetType: 'global', targetId: '__global__', targetName: '全校', priority: 'hard', status: 'effective' };
            }

            if (row.type === 'advanced_constraint') {
                const advancedRule = {
                    id: row.machineRuleId || row.id,
                    type: row.advancedType || row.capabilityId,
                    capabilityId: row.capabilityId || row.advancedType,
                    strength: row.priority || 'soft',
                    sourceId: row.sourceId || '',
                    clauseId: row.clauseId || '',
                    target: {
                        kind: row.targetType || 'global',
                        name: row.targetName || '',
                        matchedIds: [...new Set([...(row.targetIds || []), row.targetId].filter(Boolean))],
                    },
                    scope: row.scope || {},
                    parameters: {
                        ...(row.parameters || {}),
                        ...(row.slots?.length ? { slots: row.slots } : {}),
                    },
                    enabled: row.enabled !== false,
                };
                const existingIndex = rules.advancedRules.findIndex(item => item.id === advancedRule.id);
                if (existingIndex >= 0) rules.advancedRules[existingIndex] = advancedRule;
                else rules.advancedRules.push(advancedRule);
                return {
                    ...row,
                    targetId: advancedRule.target.matchedIds[0] || row.targetId || '__global__',
                    status: 'effective',
                };
            }

            if (row.type === 'subject_morning') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addMorningSubject(rules, target.id);
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, status: 'effective' };
            }

            if (row.type === 'subject_afternoon') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addAfternoonSubject(rules, target.id);
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, priority: 'soft', status: 'effective' };
            }

            if (row.type === 'subject_preferred_periods' || row.type === 'subject_avoid_periods') {
                if (!target || !slots.length) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程或节次，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addSubjectPeriodPreference(rules, target.id, {
                    prefer: row.type === 'subject_preferred_periods' ? slots : [],
                    avoid: row.type === 'subject_avoid_periods' ? slots : [],
                    weight: row.weight,
                });
                return { ...row, targetType, targetId: target.id, targetName: target.name || row.targetName, status: 'effective' };
            }

            if (row.type === 'subject_daily_limit') {
                const limit = Number.parseInt(row.limit ?? row.weight ?? row.value, 10);
                if (!target || !Number.isInteger(limit) || limit <= 0) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程或有效的每日上限，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addSubjectDailyLimit(rules, target.id, limit);
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, priority: 'hard', status: 'effective' };
            }

            if (row.type === 'teacher_daily_limit' || row.type === 'teacher_consecutive_limit' || row.type === 'teacher_weekly_limit' || row.type === 'teacher_max_days_per_week') {
                const limit = Number.parseInt(row.limit ?? row.weight ?? row.value, 10);
                if (isAllTeachersTarget(row)) {
                    if (!Number.isInteger(limit) || limit <= 0 || !(project.teachers || []).length) {
                        const reason = `${row.targetName || '全部教师'} 缺少有效的节数上限或当前项目没有教师，请复核。`;
                        warnings.push(reason);
                        return { ...row, status: 'needs_review', targetType: 'all_teachers', targetId: '__all_teachers', targetName: '全部教师', warnings: [...row.warnings, reason] };
                    }
                    (project.teachers || []).forEach(teacher => {
                        if (row.type === 'teacher_daily_limit') addTeacherLimit(rules, teacher.id, { daily: limit });
                        else if (row.type === 'teacher_consecutive_limit') addTeacherLimit(rules, teacher.id, { consecutive: limit });
                        else if (row.type === 'teacher_weekly_limit') addTeacherWeeklyLimit(rules, teacher.id, limit);
                        else addTeacherMaxDaysPerWeek(rules, teacher.id, limit);
                    });
                    return { ...row, targetType: 'all_teachers', targetId: '__all_teachers', targetName: '全部教师', priority: ['teacher_weekly_limit', 'teacher_max_days_per_week'].includes(row.type) ? 'hard' : 'soft', status: 'effective' };
                }
                const teacher = findEntity(project.teachers, row);
                if (!teacher || !Number.isInteger(limit) || limit <= 0) {
                    const reason = `${row.targetName || row.targetId || '教师'} 缺少可匹配教师或有效的节数上限，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'teacher', warnings: [...row.warnings, reason] };
                }
                if (row.type === 'teacher_daily_limit') addTeacherLimit(rules, teacher.id, { daily: limit });
                else if (row.type === 'teacher_consecutive_limit') addTeacherLimit(rules, teacher.id, { consecutive: limit });
                else if (row.type === 'teacher_weekly_limit') addTeacherWeeklyLimit(rules, teacher.id, limit);
                else addTeacherMaxDaysPerWeek(rules, teacher.id, limit);
                return { ...row, targetType: 'teacher', targetId: teacher.id, targetName: teacher.name || row.targetName, priority: ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(row.type) ? 'soft' : 'hard', status: 'effective' };
            }

            if (row.type === 'subject_spread') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addSpreadSubject(rules, target.id);
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, priority: 'soft', status: 'effective' };
            }

            if (row.type === 'course_interval') {
                const minGapDays = Number.parseInt(row.minGapDays ?? row.limit ?? row.value, 10);
                if (!target || !Number.isInteger(minGapDays) || minGapDays <= 0) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程或有效间隔天数，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addCourseInterval(rules, target.id, minGapDays);
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, minGapDays, priority: 'soft', status: 'effective' };
            }

            if (row.type === 'room_requirement') {
                if (!target) {
                    const reason = `${row.targetName || row.targetId || '课程'} 缺少可匹配课程，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                const roomMatches = resolveEntityList(project.rooms || [], [...(row.roomIds || []), row.roomName].filter(Boolean));
                const roomIds = roomMatches.map(room => room.id);
                const requiredTags = row.requiredTags || roomTagsFromText(row.roomName, row.rawText || row.description || '');
                if (!roomIds.length && !requiredTags.length) {
                    const reason = '教室要求缺少可匹配教室或教室标签，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'subject', warnings: [...row.warnings, reason] };
                }
                addRoomRequirement(rules, target.id, { roomIds, requiredTags });
                return { ...row, targetType: 'subject', targetId: target.id, targetName: target.name || row.targetName, roomIds, requiredTags, priority: 'hard', status: 'effective' };
            }

            if (row.type === 'class_daily_balance') {
                setClassDailyBalance(rules, { mainSubjectDailyMax: row.limit || row.mainSubjectDailyMax || 0 });
                return { ...row, targetType: 'global', targetId: '__all_classes', targetName: '全部班级', priority: 'soft', status: 'effective' };
            }

            if (row.type === 'teacher_gap_preference') {
                if (isAllTeachersTarget(row) || ['global', 'teacher_group', 'all_teachers'].includes(targetType)) {
                    setTeacherGapWeight(rules, row.weight || row.limit || 1);
                    return { ...row, targetType: 'global', targetId: '__all_teachers', targetName: '全部教师', priority: 'soft', status: 'effective' };
                }
                const teacher = target || findEntity(project.teachers, row);
                if (!teacher) {
                    const reason = `${row.targetName || row.targetId || '教师'} 缺少可匹配教师，请复核。`;
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'teacher', warnings: [...row.warnings, reason] };
                }
                const reason = `已理解 ${teacher.name || row.targetName || teacher.id} 的指定教师少空堂偏好，但当前求解器只支持全部教师级空堂权重；本次不会扩大为全部教师。`;
                warnings.push(reason);
                return {
                    ...row,
                    targetType: 'teacher',
                    targetId: teacher.id,
                    targetName: teacher.name || row.targetName,
                    priority: 'soft',
                    status: 'unsupported',
                    executionStatus: 'unsupported_by_solver',
                    warnings: [...row.warnings, reason],
                };
            }

            if (row.type === 'teacher_load_balance') {
                setTeacherLoadBalance(rules, row.weight || row.limit || 1);
                return { ...row, targetType: 'global', targetId: '__all_teachers', targetName: '全部教师', priority: 'soft', status: 'effective' };
            }

            if (row.type === 'teacher_mutual_exclusion') {
                const teachers = resolveEntityList(project.teachers || [], normalizedTextValues(120, row.teacherIds));
                if (teachers.length < 2) {
                    const reason = '教师互斥至少需要两位可匹配教师，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', warnings: [...row.warnings, reason] };
                }
                addTeacherMutualExclusion(rules, teachers.map(teacher => teacher.id));
                return { ...row, teacherIds: teachers.map(teacher => teacher.id), targetType: 'global', targetId: teachers.map(teacher => teacher.id).join('|'), targetName: teachers.map(teacher => teacher.name || teacher.id).join('、'), priority: 'hard', status: 'effective' };
            }

            if (row.type === 'subject_not_same_day') {
                const subjects = resolveEntityList(project.subjects || [], row.subjectIds || []);
                const classes = resolveEntityList(project.classes || [], row.classIds || []);
                if (subjects.length < 2) {
                    const reason = '课程不同天至少需要两门可匹配课程，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', warnings: [...row.warnings, reason] };
                }
                addSubjectNotSameDay(rules, subjects.map(subject => subject.id), classes.map(klass => klass.id));
                return { ...row, subjectIds: subjects.map(subject => subject.id), classIds: classes.map(klass => klass.id), targetType: 'global', targetId: subjects.map(subject => subject.id).join('|'), targetName: subjects.map(subject => subject.name || subject.id).join('、'), priority: 'hard', status: 'effective' };
            }

            if (row.type === 'subject_sequence') {
                const [before] = resolveEntityList(project.subjects || [], [row.beforeSubjectId || row.beforeSubjectName || row.subjectIds?.[0]]);
                const [after] = resolveEntityList(project.subjects || [], [row.afterSubjectId || row.afterSubjectName || row.subjectIds?.[1]]);
                const classes = resolveEntityList(project.classes || [], row.classIds || []);
                if (!before || !after || before.id === after.id) {
                    const reason = '课程顺序需要两门不同的可匹配课程，请复核。';
                    warnings.push(reason);
                    return { ...row, status: 'needs_review', targetType: 'global', warnings: [...row.warnings, reason] };
                }
                addSubjectSequence(rules, { beforeSubjectId: before.id, afterSubjectId: after.id, classIds: classes.map(klass => klass.id), weight: row.weight || 1 });
                return { ...row, beforeSubjectId: before.id, afterSubjectId: after.id, classIds: classes.map(klass => klass.id), targetType: 'global', targetId: `${before.id}>${after.id}`, targetName: `${before.name || before.id} 先于 ${after.name || after.id}`, priority: 'soft', status: 'effective' };
            }

            return { ...row, status: 'unsupported' };
        });
    rows = stabilizeParsedRows(rows, source);
    unsupportedItems = rows
        .filter(row => row.status === 'suggestion' || row.status === 'unsupported')
        .map(previewFromRow);

    rows = linkRowsToSemanticRequirements(rows, effectiveSemanticRequirements, project);

    const semanticLayer = buildRequirementSemantics(project, rows, {
        originalText,
        semanticRequirements: effectiveSemanticRequirements,
        sourceRequirements: effectiveSourceRequirements,
    });

    rows = linkRowsToSemanticRequirements(rows, semanticLayer.requirementItems, project);

    const constraintLayer = compileArtifactsThroughCapabilityRegistry({
        project,
        rows,
        requirementItems: semanticLayer.requirementItems,
        sourceRequirements: effectiveSourceRequirements,
    });
    rows = constraintLayer.rows;
    unsupportedItems = rows
        .filter(row => row.status === 'suggestion' || row.status === 'unsupported')
        .map(previewFromRow);

    const legacyResult = splitParseResult({
        project,
        draftRules: normalizeTimetableProject({ ...project, rules }).rules,
        rows,
        previewItems: previewRows(rows),
        requirementItems: semanticLayer.requirementItems,
        semanticActions: semanticLayer.semanticActions,
        constraintIRs: constraintLayer.constraintIRs,
        warnings: [...new Set(warnings.filter(Boolean))],
        warningItems: initialWarningItems,
        rejected,
        source,
        inputType,
        contextStats,
        unsupportedItems,
    });
    return sourceAwareParseResult(legacyResult, effectiveSourceRequirements, { parsedBy: parseActor });
}

export function rebindTimetableRuleResult({
    project = {},
    previousResult = {},
} = {}) {
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: previousResult.draftRows || [],
        semanticRequirements: previousResult.requirementItems || [],
        sourceRequirements: previousResult.sourceRequirements || [],
        source: 'entity_rebind',
        inputType: previousResult.inputType || 'entity_rebind',
        contextStats: previousResult.contextStats || null,
        initialWarnings: previousResult.warningItems || previousResult.warnings || [],
        rejected: previousResult.rejected || [],
        originalText: previousResult.originalText || '',
    });
}

function normalizeAiContent(content) {
    if (typeof content === 'object' && content) return content;
    const text = String(content || '').trim();
    if (!text) return {};
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse(fenced ? fenced[1] : text);
}

function aiDraftRowsFromParsed(parsed = {}) {
    if (parsed.draftRows !== undefined && parsed.draftRows !== null) return asList(parsed.draftRows);
    const groupedRows = [
        ...asList(parsed.autoAcceptable),
        ...asList(parsed.needReview),
        ...asList(parsed.unsupportedItems),
    ];
    if (groupedRows.length) return groupedRows;
    if (parsed.constraints !== undefined && parsed.constraints !== null) return asList(parsed.constraints);
    if (parsed.rules !== undefined && parsed.rules !== null) return asList(parsed.rules);
    return [];
}

function warningMessagesFromAi(value = []) {
    return normalizedMessageValues(240, value);
}

function buildPrompt({ project, text, inputType = 'text', contextStats = null, constraintRows = [] }) {
    return [
        {
            role: 'system',
            content: [
                '你是中文中小学排课约束候选抽取助手。你只负责从自然语言、TXT、XLSX 内容中抽取候选约束，不负责最终生效判断。',
                '只输出 JSON 对象，不要 markdown，不要解释文字。优先输出完整 Agent schema：{"requirementItems":[],"draftRows":[],"autoAcceptable":[],"needReview":[],"clarifyingQuestions":[],"missingInfo":[],"conflicts":[],"warnings":[],"unsupportedItems":[],"confidenceSummary":{"high":0,"medium":0,"low":0},"nextAction":"review"}。',
                'requirementItems 用于表达“对象是谁 + 需求是什么 + 应该落到哪里”；draftRows 用于兼容旧规则草稿。系统会重新校验和重分组。',
                'Every returned requirementItems[] and draftRows[] item must copy sourceId and textHash from exactly one provided constraintRows[] item.',
                'Never align output to input by array index. If source identity cannot be proven, omit the executable row and add a warning.',
                'requirementItems 每条建议包含 object, intent, condition, parameters, strength, status, applyTo, confidence, source, warnings。',
                'object.kind 可用 teacher/class/subject/teacher_group/derived_group/global/lesson_block；applyTo 可用 rule/lesson_plan/solver_policy/optimization/review。',
                '例如“数学必须连堂”输出 requirementItems: object=数学课程, intent=block_preference, parameters.blockPreference=double, applyTo=lesson_plan。',
                '例如“未注明默认单节”“连堂块不能拆开”“教师同时间只能上一个班”属于 handled/system policy，不要生成 teacher_unavailable 全周全节次噪音规则。',
                'draftRows 必须包含所有能映射到旧规则模型的候选约束；autoAcceptable/needReview/unsupportedItems 只是你给出的初步分组，系统会重新校验和重分组。',
                'nextAction 只能是 ask_user、ready_to_apply、review、no_result。遇到歧义或缺失信息时优先 ask_user，不要猜。',
                '系统会在你输出后做确定性实体匹配、歧义检测、冲突预检和最终 normalize；不要把不确定内容强行标记为可生效。',
                '',
                '【可生效约束类型】（会真正影响排课，请尽量归类到这些）：',
                '- teacher_unavailable：某教师在某些时间不能上课。需 targetId/target + slots（或 days+periods）。priority=hard。',
                '- class_unavailable：某班级在某些时间不排课。需 targetId/target + slots。priority=hard。',
                '- locked_slot：把某班某课某师固定在某个具体时间。需 class/subject/teacher + 单个 slot。priority=hard。',
                '- global_unavailable：全校在某些时间不排常规课。需 slots。priority=hard。',
                '- subject_morning：某课程优先排在上午。需 targetId/target（课程）。priority=soft。',
                '- subject_afternoon：某课程优先排在下午。需 targetId/target（课程）。priority=soft。',
                '- subject_preferred_periods：某课程偏好某些节次。需课程 + slots/periods。priority=soft。',
                '- subject_avoid_periods：某课程避开某些节次。需课程 + slots/periods。priority=soft。',
                '- subject_daily_limit：某课程同一班每天最多几节。需课程 + limit。priority=hard。',
                '- teacher_daily_limit：某教师每天最多上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_consecutive_limit：某教师最多连续上几节。需教师 + limit（整数）。priority=soft。',
                '- teacher_weekly_limit：某教师每周最多上几节。需教师 + limit。priority=hard。',
                '- teacher_max_days_per_week：某教师每周最多上几天。需教师 + limit。priority=hard。',
                '- teacher_mutual_exclusion：多位教师不能同节上课。需 teacherIds/teachers 至少两个。priority=hard。',
                '- subject_spread：某课程一周内要分散，不要同一天扎堆。需课程。priority=soft。',
                '- course_interval：某课程两次课之间至少间隔几天。需课程 + minGapDays。priority=soft。',
                '- room_requirement：某课程必须使用指定教室/场地。需课程 + roomIds/roomName/requiredTags。priority=hard。',
                '- class_daily_balance：班级每日课时尽量均衡。priority=soft。',
                '- teacher_gap_preference：教师尽量少空堂。priority=soft。',
                '- teacher_load_balance：教师工作量尽量均衡。priority=soft。',
                '- subject_not_same_day：两门课程不能排同一天。需 subjectIds 至少两个，可带 classIds。priority=hard。',
                '- subject_sequence：同一天课程前后顺序。需 beforeSubjectId + afterSubjectId。priority=soft。',
                '',
                '【仅建议类型】（暂不写入排课，仅供复核展示）：block_protection, class_subject_spread, quality_subject_later。无法确定或属于通用常识时，写进 warnings 或 needs_review，不要编造硬约束。',
                '',
                '【严禁猜测】',
                '- 不允许编造老师、班级、课程、节次；只能使用用户原文或下方项目上下文。',
                '- 如果目标不在 teachers/classes/subjects 中，把原文放在 target/targetName，并降低 confidence。',
                '- 如果存在多个候选，必须在该规则中返回 ambiguity，例如 {"targetText":"王老师","candidates":[{"label":"王明","value":"t1"},{"label":"王华","value":"t2"}]}。',
                '- 低置信度、歧义、缺少目标或缺少节次时，不要强行 effective；confidence 低于 0.65 的内容必须保守。',
                '',
                '【字段规范】：',
                '- slots 用 "day-period" 字符串，day 为周几(1-7)，period 为第几节，例如周三第4节="3-4"。',
                '- 也可用 days:[1,2] + periods:[3,4] 让系统自动展开。',
                '- target 用教师/班级/课程的名称（从下方上下文里匹配），匹配不到就照原文填，targetId 留空。',
                '- 每条规则都必须包含：rawText, type, targetType, targetName, days, periods, priority, reason, confidence, ambiguity。',
                '- locked_slot 必须尽量包含 class/className, subject/subjectName, teacher/teacherName 和单个 slots。',
                '',
                '【强弱判断】',
                '- 用户表达“尽量、最好、优先、希望、建议”时 priority=soft。',
                '- 用户表达“禁止、必须、不能、不要、没空、不可排”时 priority=hard，除非语义明显是偏好。',
                '',
                '【示例】',
                '输入："王老师周三下午都没空" → {"type":"teacher_unavailable","target":"王老师","days":[3],"periods":[5,6,7],"priority":"hard","reason":"王老师周三下午不可排","confidence":0.95}',
                '输入："数学尽量排上午" → {"type":"subject_morning","target":"数学","priority":"soft","reason":"数学优先上午","confidence":0.9}',
                '输入："李老师必须周三第3节上高一1班数学" → {"type":"locked_slot","teacher":"李老师","class":"高一1班","subject":"数学","slots":["3-3"],"priority":"hard","reason":"固定课节","confidence":0.9}',
                '输入："李老师每天最多上3节课" → {"type":"teacher_daily_limit","target":"李老师","limit":3,"priority":"soft","reason":"控制李老师每日工作量","confidence":0.9}',
                '输入："体育不要连着上两节" → {"type":"teacher_consecutive_limit"或"subject_spread","target":"体育","limit":1,"priority":"soft","reason":"体育课分散","confidence":0.8}',
                '输入："美术第一节不要排" → {"type":"subject_avoid_periods","target":"美术","periods":[1],"priority":"soft","reason":"美术避开第一节","confidence":0.85}',
            ].join('\n'),
        },
        {
            role: 'user',
            content: JSON.stringify({
                inputType,
                request: text,
                contextStats,
                constraintRows,
                teachers: project.teachers.map(({ id, name }) => ({ id, name })),
                classes: project.classes.map(({ id, grade, name }) => ({ id, name: `${grade}${name}` })),
                subjects: project.subjects.map(({ id, name }) => ({ id, name })),
                activeWeekdays: project.activeWeekdays,
                activePeriods: project.activePeriods,
            }),
        },
    ];
}

async function callAi({ project, text, inputType, contextStats, constraintRows, env, fetchImpl }) {
    const { apiKey, baseUrl, model } = resolveAiConfig(env);
    const fetchClient = resolveFetch(fetchImpl);
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    const response = await fetchClient(`${baseUrl}/chat/completions`, {
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
            messages: buildPrompt({ project, text, inputType, contextStats, constraintRows }),
        }),
    });
    const raw = await response.text();
    let payload = {};
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        throw new TimetableRuleParseError('智能解析返回内容不是有效 JSON。', 'ai_invalid_json', 502);
    }
    if (!response.ok) {
        throw new TimetableRuleParseError(payload.error?.message || '智能约束解析失败。', 'ai_failed', response.status || 502);
    }

    const content = payload.choices?.[0]?.message?.content ?? payload;
    try {
        return normalizeAiContent(content);
    } catch {
        throw new TimetableRuleParseError('智能解析结果不是有效 JSON。', 'ai_invalid_json', 502);
    }
}

function compactProjectDictionary(project = {}) {
    return {
        teachers: (project.teachers || []).map(({ id, name }) => ({ id, name })),
        classes: (project.classes || []).map(item => ({ id: item.id, name: entityLabel(item) })),
        subjects: (project.subjects || []).map(({ id, name }) => ({ id, name })),
        lessonPlans: (project.lessonPlans || []).map(plan => ({
            id: plan.id,
            classId: plan.classId,
            subjectId: plan.subjectId,
            teacherId: plan.teacherId,
            teacherIds: normalizedTextValues(120, plan.teacherIds, plan.teacherId),
            weeklyHours: plan.weeklyHours,
            blockPreference: plan.blockPreference || '',
        })),
        activeWeekdays: project.activeWeekdays,
        activePeriods: project.activePeriods,
        timetableModelVersion: project.timetableModelVersion || 'legacy',
        complexModelEnabled: complexModelIsEnabled(project),
    };
}

function compactParseResultForReview(result = {}) {
    return {
        inputType: result.inputType,
        source: result.source,
        parseSource: result.parseSource,
        draftRows: (result.draftRows || []).map(row => ({
            id: row.id,
            requirementId: row.requirementId,
            clauseId: row.clauseId,
            stableKey: row.stableKey,
            sourceId: row.sourceId,
            textHash: row.textHash,
            origin: row.origin,
            parsedBy: row.parsedBy || [],
            sourceSheet: row.sourceSheet,
            sourceRow: row.sourceRow,
            lineNumber: row.lineNumber,
            rawText: row.rawText,
            capabilityId: row.capabilityId,
            intent: row.intent,
            type: row.type,
            targetType: row.targetType,
            targetId: row.targetId,
            targetName: row.targetName,
            slots: row.slots,
            days: row.days,
            periods: row.periods,
            priority: row.priority,
            status: row.status,
            confidence: row.confidence,
            warnings: row.warnings || [],
        })),
        requirementItems: (result.requirementItems || []).map(item => ({
            id: item.id,
            sourceId: item.sourceId || item.source?.sourceId,
            textHash: item.textHash || item.source?.textHash,
            origin: item.origin || item.source?.origin,
            parsedBy: item.parsedBy || item.source?.parsedBy || [],
            sourceSheet: item.sourceSheet || item.source?.sourceSheet,
            sourceRow: item.sourceRow ?? item.source?.sourceRow,
            lineNumber: item.lineNumber ?? item.source?.lineNumber,
            rawText: item.rawText || item.source?.rawText,
            object: item.object,
            intent: item.intent,
            parameters: item.parameters,
            strength: item.strength,
            status: item.status,
            applyTo: item.applyTo,
            confidence: item.confidence,
            source: item.source,
            warnings: item.warnings || [],
        })),
        semanticActions: (result.semanticActions || []).map(action => ({
            id: action.id,
            requirementId: action.requirementId,
            sourceId: action.sourceId || action.source?.sourceId,
            textHash: action.textHash || action.source?.textHash,
            origin: action.origin || action.source?.origin,
            parsedBy: action.parsedBy || action.source?.parsedBy || [],
            kind: action.kind,
            status: action.status,
            target: action.target || {},
            patch: action.patch || {},
        })),
    };
}

function buildAiReviewPrompt({
    project,
    text,
    inputType,
    contextStats = null,
    constraintRows = [],
    candidateResult = {},
    applicationResult = {},
}) {
    return [
        {
            role: 'system',
            content: [
                '你是中文中小学排课需求识别结果的复审核查员。你复审 AI 候选与本地安全基线的差异，不直接生成最终规则。',
                '只输出 JSON 对象，不要 markdown，不要解释文字。格式：{"reviewItems":[],"warnings":[]}。',
                'reviewItems 每项必须包含 verdict、issueCode、target、fieldPath、reason、evidence，可选 patch 或 suggestedRequirement。',
                'Every reviewItems[] item must copy sourceId and textHash from exactly one provided sources[] item.',
                'The review item and its target must use the same sourceId/textHash. Never review, flag, or patch across source identities.',
                'Never align review output to input by array index. If source identity cannot be proven, omit the review item and add a warning.',
                'verdict 只能是 accept、flag、suggest_patch、missed_requirement、unsupported。',
                'issueCode 只能是 entity_missing、entity_ambiguous、required_parameter_missing、slot_out_of_range、activity_scope_ambiguous、semantic_interpretation_conflict、rule_conflict、unsupported_capability；没有这些问题时留空。',
                '普通优化建议、低置信度和无法用项目数据验证的担忧只能作为建议，不能要求阻断。系统会独立验证 issueCode，未复现的问题会降为 advisory。',
                'target 用于定位本地结果，可包含 rowId、requirementId、stableKey、sourceSheet、sourceRow、targetId、type。',
                'evidence 必须包含 quote 或 sourceRow，说明建议来自哪句原文或哪一行 xlsx。',
                'suggest_patch 只能提出字段级建议，系统会重新做本地实体匹配、时间校验和能力校验；不要假设建议会自动生效。',
                'missed_requirement 只能指出漏识别的自然语言需求，不能直接写入项目。',
                'candidateResult 只是诊断候选集，applicationBaseline 才是待修改的正式基线。未在 reviewItems 中明确处理的 AI-only 候选会被丢弃。',
                'accept 只用于确认 candidateResult 与 applicationBaseline 已经一致的候选，不能用 accept 新增规则。',
                'AI-only 的独立语义如果确实应用，必须返回 missed_requirement 并给出完整 suggestedRequirement；信息不完整时返回 flag。',
                'suggest_patch 必须精确指向 applicationBaseline 中的 rowId 或 requirementId，不得把 candidateResult 中的临时 ID 当成正式补丁目标。',
                '系统基础规则如“同一位教师同一时间只能给一个班上课”“同一班级同一时间只能一门课”属于已处理系统不变量，不要建议生成全教师/全班级不可排。',
                '“默认单节”“连堂块不能拆开”属于系统策略或任课计划策略，不要建议生成无意义的 teacher_unavailable/class_unavailable。',
                '“高负载教师不要连续太多”缺少阈值时应 flag 或 missed_requirement 并要求确认阈值，不要猜成固定 3 节。',
                '具体节次优先于宽泛时段；例如“上午第1-3节”应核查为具体 slots，而不是只保留 subject_morning。',
                '对象或时间不唯一时必须 flag，不能猜。',
                '如果 targetedReviewSourceIds 非空，只复审这些来源；其他来源不要返回 reviewItems。',
            ].join('\n'),
        },
        {
            role: 'user',
            content: JSON.stringify({
                aiReviewPromptVersion: AI_REVIEW_PROMPT_VERSION,
                inputType,
                request: text,
                contextStats,
                targetedReviewSourceIds: asList(contextStats?.targetedReviewSourceIds),
                constraintRows,
                sources: sourceRequirementsToAiInputs(
                    applicationResult.sourceRequirements || candidateResult.sourceRequirements || [],
                ),
                project: compactProjectDictionary(project),
                supportedCapabilities: {
                    ruleTypes: [...SUPPORTED_EFFECTIVE_TYPES],
                    suggestionTypes: [...SUGGESTION_ONLY_TYPES],
                    semanticDestinations: ['rule', 'lesson_plan', 'optimization', 'solver_policy', 'model_extension', 'review'],
                    complexModelEnabled: complexModelIsEnabled(project),
                },
                localResult: compactParseResultForReview(candidateResult),
                candidateResult: compactParseResultForReview(candidateResult),
                applicationBaseline: compactParseResultForReview(applicationResult),
            }),
        },
    ];
}

function normalizeAiReviewContent(content) {
    const parsed = normalizeAiContent(content);
    const candidateItems = parsed.reviewItems !== undefined && parsed.reviewItems !== null
        ? parsed.reviewItems
        : parsed.items !== undefined && parsed.items !== null
            ? parsed.items
            : parsed.reviews;
    return {
        reviewItems: asList(candidateItems).filter(item => item && typeof item === 'object'),
        warnings: warningMessagesFromAi(parsed.warnings || parsed.messages || []),
    };
}

function aiReviewTimeoutError() {
    return new TimetableRuleParseError('AI 复审超时。', 'ai_review_timeout', 504);
}

async function fetchAiReviewWithTimeout(fetchClient, url, options = {}, timeoutMs = DEFAULT_AI_REVIEW_TIMEOUT_MS) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        return fetchClient(url, options);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutId = null;
    const requestOptions = controller ? { ...options, signal: controller.signal } : options;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            try {
                controller?.abort();
            } catch {
                // Abort is best-effort; the timeout rejection below is authoritative.
            }
            reject(aiReviewTimeoutError());
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            fetchClient(url, requestOptions),
            timeoutPromise,
        ]);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw aiReviewTimeoutError();
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function callAiReview({
    project,
    text,
    inputType,
    contextStats,
    constraintRows,
    candidateResult,
    applicationResult,
    env,
    fetchImpl,
}) {
    const { apiKey, baseUrl, model } = resolveAiConfig(env);
    const fetchClient = resolveFetch(fetchImpl);
    const seed = Number.parseInt(env.TIMETABLE_RULE_AI_SEED, 10);
    const response = await fetchAiReviewWithTimeout(fetchClient, `${baseUrl}/chat/completions`, {
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
            messages: buildAiReviewPrompt({
                project,
                text,
                inputType,
                contextStats,
                constraintRows,
                candidateResult,
                applicationResult,
            }),
        }),
    }, aiReviewTimeoutMs(env));
    const raw = await response.text();
    let payload = {};
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        throw new TimetableRuleParseError('AI 复审返回内容不是有效 JSON。', 'ai_review_invalid_json', 502);
    }
    if (!response.ok) {
        throw new TimetableRuleParseError(payload.error?.message || 'AI 复审失败。', 'ai_review_failed', response.status || 502);
    }

    const content = payload.choices?.[0]?.message?.content ?? payload;
    try {
        return { ...normalizeAiReviewContent(content), model };
    } catch {
        throw new TimetableRuleParseError('AI 复审结果不是有效 JSON。', 'ai_review_invalid_json', 502);
    }
}

function rawRowsFromConstraints(constraints = [], { source = 'ai' } = {}) {
    const values = asList(constraints).filter(item => item && typeof item === 'object');
    const rows = values.map((constraint, index) => {
        const type = normalizeConstraintType(constraint.type || constraint.ruleType);
        const idList = items => normalizedTextValues(120, items);
        return {
            id: asText(constraint.id, 240) || `rule_draft_${index + 1}`,
            machineRuleId: constraint.machineRuleId || '',
            requirementId: constraint.requirementId || '',
            clauseId: constraint.clauseId || '',
            constraintId: constraint.constraintId || '',
            capabilityId: constraint.capabilityId || '',
            intent: constraint.intent || '',
            sourceId: constraint.sourceId || constraint.source?.sourceId || '',
            textHash: constraint.textHash || constraint.source?.textHash || '',
            origin: constraint.origin || constraint.source?.origin || (source === 'local_roster_fallback' ? 'system_supplement' : 'unknown'),
            parsedBy: normalizedParsedBy(constraint.parsedBy, source.includes('ai') ? 'ai' : 'local'),
            parseSource: source,
            source,
            generatedBy: constraint.generatedBy || '',
            compilerVersion: constraint.compilerVersion,
            constraintIrVersion: constraint.constraintIrVersion,
            sourceSheet: constraint.sourceSheet || constraint.source?.sourceSheet || constraint.source?.sheetName || '',
            sourceRow: constraint.sourceRow ?? constraint.source?.sourceRow ?? constraint.source?.rowNumber ?? null,
            lineNumber: constraint.lineNumber ?? constraint.source?.lineNumber ?? null,
            rawText: constraint.rawText || constraint.constraintText || constraint.source?.rawText || constraint.reason || constraint.description || '',
            normalizationTrace: asList(constraint.normalizationTrace || constraint.source?.normalizationTrace)
                .filter(item => item && typeof item === 'object')
                .map(item => ({ ...item })),
            negation: constraint.negation && typeof constraint.negation === 'object'
                ? { ...constraint.negation }
                : (constraint.negation ?? null),
            exceptions: asList(constraint.exceptions).map(item => item && typeof item === 'object' ? { ...item } : item),
            activity: constraint.activity && typeof constraint.activity === 'object'
                ? { ...constraint.activity }
                : (constraint.activity ?? null),
            type,
            targetType: constraint.targetType || targetTypeFor(type, constraint),
            targetId: constraint.targetId || constraint.teacherId || constraint.classId || constraint.subjectId || '',
            targetName: constraint.targetName || constraint.target || constraint.teacher || constraint.class || constraint.subject || '',
            classId: constraint.classId || '',
            className: constraint.className || constraint.class || '',
            subjectId: constraint.subjectId || '',
            subjectName: constraint.subjectName || constraint.subject || '',
            teacherId: constraint.teacherId || '',
            teacherName: constraint.teacherName || constraint.teacher || '',
            teacherIds: idList(constraint.teacherIds || constraint.teachers || []),
            subjectIds: idList(constraint.subjectIds || constraint.subjects || []),
            classIds: idList(constraint.classIds || constraint.classes || []),
            gradeNames: idList(constraint.gradeNames || constraint.grades || constraint.parameters?.gradeNames || []),
            blockPreference: constraint.blockPreference || constraint.parameters?.blockPreference || '',
            minOccurrences: constraint.minOccurrences ?? constraint.parameters?.minOccurrences,
            avoidDayParts: idList(constraint.avoidDayParts || constraint.parameters?.avoidDayParts || []),
            subjectNames: idList(constraint.subjectNames || constraint.parameters?.subjectNames || []),
            activityTypes: idList(constraint.activityTypes || constraint.parameters?.activityTypes || []),
            preferredActivityTypes: idList(constraint.preferredActivityTypes || constraint.parameters?.preferredActivityTypes || []),
            requiredResourceTypes: idList(constraint.requiredResourceTypes || constraint.parameters?.requiredResourceTypes || []),
            sameDay: typeof (constraint.sameDay ?? constraint.parameters?.sameDay) === 'boolean'
                ? (constraint.sameDay ?? constraint.parameters?.sameDay)
                : undefined,
            roomIds: idList(constraint.roomIds || constraint.allowedRoomIds || constraint.rooms || []),
            roomName: constraint.roomName || constraint.room || '',
            requiredTags: idList(constraint.requiredTags || constraint.roomTags || []),
            beforeSubjectId: constraint.beforeSubjectId || constraint.before || '',
            afterSubjectId: constraint.afterSubjectId || constraint.after || constraint.nextSubjectId || '',
            slots: constraint.slots || constraint.slotKeys || [],
            days: constraint.days || constraint.weekdays || '',
            periods: constraint.periods || constraint.lessonIndexes || '',
            boundaryPeriods: constraint.boundaryPeriods || constraint.parameters?.boundaryPeriods || [],
            priority: constraint.priority || constraint.strength,
            status: STATUS_LABELS.has(constraint.status)
                ? constraint.status
                : SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : SUGGESTION_ONLY_TYPES.has(type) ? 'suggestion' : 'unsupported',
            confidence: constraint.confidence ?? null,
            ambiguity: constraint.ambiguity || null,
            ambiguities: asList(constraint.ambiguities).filter(item => item && typeof item === 'object'),
            description: constraint.reason || constraint.description || constraint.note || '',
            warnings: normalizedMessageValues(240, constraint.warnings),
            clarifications: normalizedMessageValues(500, constraint.clarifications, constraint.questions),
            understandingStatus: constraint.understandingStatus || '',
            executionStatus: constraint.executionStatus || '',
            reviewStatus: constraint.reviewStatus || '',
            support: constraint.support || '',
            landing: normalizedTextValues(80, constraint.landing),
            scope: constraint.scope && typeof constraint.scope === 'object' ? { ...constraint.scope } : {},
            parameters: constraint.parameters && typeof constraint.parameters === 'object'
                ? { ...constraint.parameters }
                : {},
            weekPattern: constraint.weekPattern || '',
            weight: constraint.weight,
            limit: constraint.limit ?? constraint.value ?? constraint.max ?? constraint.maxPerDay ?? constraint.maxConsecutive,
            minGapDays: constraint.minGapDays ?? constraint.gapDays,
        };
    });
    return {
        rows,
        warningItems: [],
        rejected: [],
    };
}

function hasExplicitAiSourceIdentity(artifact = {}) {
    return Boolean(
        asText(artifact.sourceId || artifact.source?.sourceId || artifact.target?.sourceId || artifact.evidence?.sourceId || '', 300)
        || asText(artifact.textHash || artifact.source?.textHash || artifact.target?.textHash || artifact.evidence?.textHash || '', 128)
        || Number.parseInt(
            artifact.sourceRow
            ?? artifact.rowNumber
            ?? artifact.source?.sourceRow
            ?? artifact.source?.rowNumber
            ?? artifact.target?.sourceRow
            ?? artifact.evidence?.sourceRow,
            10
        ) > 0
        || Number.parseInt(
            artifact.lineNumber
            ?? artifact.source?.lineNumber
            ?? artifact.target?.lineNumber
            ?? artifact.evidence?.lineNumber,
            10
        ) > 0
    );
}

function sourceRequirementById(sourceRequirements = [], sourceId = '') {
    const normalizedId = asText(sourceId, 300);
    if (!normalizedId) return null;
    return asList(sourceRequirements).find(item => item?.sourceId === normalizedId) || null;
}

function attachSourceRequirementToAiConstraint(constraint = {}, sourceRequirement = {}, requirement = null) {
    const source = sourceRequirement.source || {};
    return {
        ...constraint,
        requirementId: constraint.requirementId || requirement?.id || requirement?.requirementId || '',
        clauseId: constraint.clauseId || requirement?.clauseId || '',
        sourceId: sourceRequirement.sourceId || constraint.sourceId || '',
        textHash: source.textHash || sourceRequirement.textHash || constraint.textHash || '',
        origin: sourceRequirement.origin || constraint.origin || 'unknown',
        parsedBy: normalizedParsedBy([
            ...asList(sourceRequirement.parsedBy),
            ...asList(constraint.parsedBy),
        ], 'ai'),
        sourceSheet: source.sheetName || sourceRequirement.sourceSheet || constraint.sourceSheet || '',
        sourceRow: source.rowNumber ?? sourceRequirement.sourceRow ?? constraint.sourceRow ?? null,
        lineNumber: source.lineNumber ?? sourceRequirement.lineNumber ?? constraint.lineNumber ?? null,
        rawText: source.rawText || sourceRequirement.rawText || constraint.rawText || constraint.constraintText || '',
    };
}

function buildLegacyAiSourceEvidence(project = {}, sourceRequirements = []) {
    return asList(sourceRequirements)
        .filter(item => item && typeof item === 'object' && item.sourceId)
        .map(sourceRequirement => {
            const source = sourceRequirement.source || {};
            const rawText = asText(source.rawText || sourceRequirement.rawText || '', 2000);
            if (!rawText) return { sourceRequirement, requirements: [] };
            const sourceMeta = {
                sourceId: sourceRequirement.sourceId,
                textHash: source.textHash || sourceRequirement.textHash || '',
                origin: sourceRequirement.origin || 'unknown',
                parsedBy: normalizedParsedBy(sourceRequirement.parsedBy, 'local'),
                parser: 'local',
                sourceSheet: source.sheetName || sourceRequirement.sourceSheet || '',
                sourceRow: source.rowNumber ?? sourceRequirement.sourceRow ?? null,
                lineNumber: source.lineNumber ?? sourceRequirement.lineNumber ?? null,
                rawText,
            };
            const localRows = rawRowsFromConstraints(
                localTextConstraints(project, rawText, sourceMeta),
                { source: 'local_ai_source_evidence' }
            ).rows;
            return {
                sourceRequirement,
                requirements: localRows.map(requirementFromRow),
            };
        });
}

function legacyAiRowSourceMatch(row = {}, {
    project = {},
    sourceRequirements = [],
    semanticRequirements = [],
    localEvidence = [],
} = {}) {
    const semanticMatches = externalRequirementItems(semanticRequirements)
        .filter(item => item.id && item.sourceId && semanticRequirementMatchesRow(item, row, project));
    const semanticSourceIds = [...new Set(semanticMatches.map(item => item.sourceId).filter(Boolean))];
    if (semanticSourceIds.length === 1) {
        const sourceRequirement = sourceRequirementById(sourceRequirements, semanticSourceIds[0]);
        if (sourceRequirement) {
            return {
                sourceRequirement,
                requirement: semanticMatches.length === 1 ? semanticMatches[0] : null,
            };
        }
    }
    if (semanticSourceIds.length > 1) return null;

    const localMatches = localEvidence.filter(entry => entry.requirements
        .some(item => semanticRequirementMatchesRow(item, row, project)));
    if (localMatches.length !== 1) return null;
    return {
        sourceRequirement: localMatches[0].sourceRequirement,
        requirement: null,
    };
}

function rowsFromAiConstraints(constraints = [], {
    source = 'ai',
    sourceRequirements = [],
    semanticRequirements = [],
    project = {},
} = {}) {
    const values = asList(constraints).filter(item => item && typeof item === 'object');
    const sourceList = asList(sourceRequirements).filter(item => item && typeof item === 'object');
    const shouldAlign = source.includes('ai') && sourceList.length > 0;
    if (!shouldAlign) return rawRowsFromConstraints(values, { source });

    const localEvidence = buildLegacyAiSourceEvidence(project, sourceList);
    const rows = [];
    const warningItems = [];
    const rejected = [];

    values.forEach((constraint, index) => {
        const exact = alignAiArtifactsToSources([constraint], sourceList, {
            artifactKind: 'constraint',
            parsedBy: 'ai',
            allowLegacyEvidence: true,
        });
        let alignedConstraint = exact.artifacts[0] || null;
        if (!alignedConstraint && !hasExplicitAiSourceIdentity(constraint)) {
            const provisionalRow = rawRowsFromConstraints([constraint], { source }).rows[0];
            const legacyMatch = provisionalRow && legacyAiRowSourceMatch(provisionalRow, {
                project,
                sourceRequirements: sourceList,
                semanticRequirements,
                localEvidence,
            });
            if (legacyMatch?.sourceRequirement) {
                alignedConstraint = attachSourceRequirementToAiConstraint(
                    constraint,
                    legacyMatch.sourceRequirement,
                    legacyMatch.requirement
                );
            }
        }
        if (!alignedConstraint) {
            warningItems.push(...exact.warnings.map(item => ({ ...item, artifactIndex: index })));
            rejected.push(...exact.rejected.map(item => ({ ...item, index })));
            return;
        }
        const normalizedRow = rawRowsFromConstraints([alignedConstraint], { source }).rows[0];
        if (normalizedRow) rows.push(normalizedRow);
    });

    return { rows, warningItems, rejected };
}
function rosterContext(preview = {}) {
    const rows = asList(preview.draftRows).filter(row => row && typeof row === 'object');
    const subjects = new Map();
    const teachers = new Map();
    const classes = new Set();
    for (const row of rows) {
        if (row.className) classes.add(`${row.grade}${row.className}`);
        if (row.subjectName) {
            const subject = subjects.get(row.subjectName) || { name: row.subjectName, rows: 0, hours: 0, blocks: new Set() };
            subject.rows += 1;
            subject.hours += Number(row.weeklyHours || 0);
            subject.blocks.add(row.blockPreference || 'single');
            subjects.set(row.subjectName, subject);
        }
        for (const teacherName of String(row.teacherName || '').split(/[、，,；;\s]+/).filter(Boolean)) {
            teachers.set(teacherName, (teachers.get(teacherName) || 0) + Number(row.weeklyHours || 0));
        }
    }
    const highLoadTeachers = [...teachers.entries()]
        .filter(([, hours]) => hours >= 14)
        .sort((left, right) => right[1] - left[1])
        .map(([name, hours]) => ({ name, hours }));
    const mixedSubjects = [...subjects.values()]
        .filter(subject => subject.blocks.has('mixed') || subject.blocks.has('double'))
        .map(subject => subject.name);
    return {
        ...(preview.stats || {}),
        classes: classes.size,
        subjects: [...subjects.values()].map(subject => ({
            name: subject.name,
            rows: subject.rows,
            hours: subject.hours,
            blocks: [...subject.blocks],
        })),
        highLoadTeachers,
        mixedSubjects,
        totalLessons: preview.stats?.totalLessons || rows.reduce((sum, row) => sum + Number(row.weeklyHours || 0), 0),
    };
}

function mergeEntitiesByName(existing = [], inferred = [], labelFor = item => item.name || item.id || '') {
    const result = asList(existing).filter(item => item && typeof item === 'object');
    const seen = new Set(result.map(item => normalizeName(labelFor(item))).filter(Boolean));
    for (const item of asList(inferred).filter(entry => entry && typeof entry === 'object')) {
        const key = normalizeName(labelFor(item));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function projectWithRosterPreview(project, preview) {
    try {
        const roster = buildTimetableRosterFromRows(preview.draftRows || [], { project });
        return normalizeTimetableProject({
            ...project,
            teachers: mergeEntitiesByName(project.teachers, roster.teachers, item => item.name || item.id),
            classes: mergeEntitiesByName(project.classes, roster.classes, entityLabel),
            subjects: mergeEntitiesByName(project.subjects, roster.subjects, item => item.name || item.id),
            lessonPlans: (project.lessonPlans || []).length ? project.lessonPlans : roster.lessonPlans,
        });
    } catch {
        return project;
    }
}

function localRosterConstraints(project, context) {
    const constraints = [];
    const subjectNames = new Set((context.subjects || []).map(subject => normalizeName(subject.name)));
    const mainSubjects = project.subjects.filter(subject => {
        const name = normalizeName(subject.name);
        return subjectNames.has(name) && /(语文|数学|英语|chinese|math|english)/i.test(subject.name);
    });
    mainSubjects.forEach(subject => {
        constraints.push({
            type: 'subject_morning',
            targetId: subject.id,
            reason: '主科课时较多，建议上午优先。',
        });
    });

    const later = [];
    const laterPeriods = [...new Set([
        ...getDayPartPeriods(project, 'afternoon'),
        ...getDayPartPeriods(project, 'evening'),
    ])];
    for (const day of getActiveWeekdays(project)) {
        laterPeriods.forEach(period => later.push(slotKey(day, period)));
    }
    project.subjects
        .filter(subject => /(体育|音乐|美术|信息|劳动|pe|music|art|ict|labor)/i.test(subject.name) && subjectNames.has(normalizeName(subject.name)))
        .forEach(subject => constraints.push({
            type: 'subject_preferred_periods',
            targetId: subject.id,
            slots: later,
            priority: 'soft',
            reason: '素质课建议分布到后半天，平衡主科负载。',
        }));

    (context.mixedSubjects || []).forEach(subjectName => constraints.push({
        type: 'block_protection',
        target: subjectName,
        priority: 'soft',
        reason: '连堂或混合课程建议保留连续块，手动调整时整段处理。',
    }));

    if ((context.highLoadTeachers || []).length) {
        constraints.push({
            type: 'teacher_load_balance',
            target: context.highLoadTeachers.map(item => item.name).join('、'),
            priority: 'soft',
            reason: '高负载教师建议减少连续授课和碎片空堂。',
        });
    }
    return constraints;
}

function normalizeRosterFallback({ project, preview, contextStats, initialWarnings = [] }) {
    const constraints = localRosterConstraints(project, contextStats);
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: rowsFromAiConstraints(constraints, { source: 'local_roster_fallback' }).rows,
        source: 'local_roster_fallback',
        inputType: 'xlsx_roster',
        contextStats,
        initialWarnings,
    });
}

export function parserShadowTextWithTrace(text = '') {
    return normalizeTimetableMarketTextWithTrace(text);
}

function parserShadowText(text = '') {
    return parserShadowTextWithTrace(text).text;
}

function splitSentences(text = '') {
    return String(text)
        .split(/[\n。；;!?！？]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function splitClauses(sentence = '') {
    return String(sentence)
        .split(/[，,]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseTimeSpec(sentence, project) {
    const days = parseDays(sentence, project, []);
    const periods = parsePeriods(sentence, project, []);
    const weekPattern = weekPatternFromText(sentence);
    const targetDays = periods.length
        ? (days.length ? days : getActiveWeekdays(project))
        : [];
    const slots = targetDays.flatMap(day => periods.map(period => slotKey(day, period)));
    return {
        days,
        periods,
        slots,
        weekPattern,
    };
}

function textSlots(sentence, project) {
    return parseTimeSpec(sentence, project).slots || [];
}

function uniqueTargets(targets = []) {
    const seen = new Set();
    return targets.filter(target => {
        const key = normalizeEntityName(target.name || target.id || '');
        if (!target.name && !target.id) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function textTeacherTargets(sentence = '', project = {}) {
    const targets = [];
    project.teachers.forEach(teacher => {
        if (teacher.name && sentence.includes(teacher.name)) targets.push({ id: teacher.id, name: teacher.name });
    });
    for (const match of sentence.matchAll(/([A-Za-z][A-Za-z ]{1,40}Teacher|[\u4e00-\u9fa5]{1,4}(?:老师|教师))/g)) {
        const name = match[1];
        const overlapsExactTeacher = (project.teachers || []).some(teacher => teacher.name && name !== teacher.name && name.endsWith(teacher.name));
        if (!overlapsExactTeacher) targets.push({ id: '', name });
    }
    return uniqueTargets(targets);
}

function teacherNamesFromText(sentence = '', project = {}) {
    const source = String(sentence || '');
    const mentions = [];
    const coveredRanges = [];
    let order = 0;
    const append = (value, index = source.length) => {
        const rawName = asText(value, 80).replace(/\s+/g, '');
        const context = source.slice(Math.max(0, index - 8), index);
        const combined = `${context}${rawName}`;
        const boundary = context.length;
        let name = rawName;
        for (const prefix of ['尤其是', '特别是', '包括', '例如', '比如', '涉及', '其中', '由']) {
            const prefixIndex = combined.lastIndexOf(prefix);
            const prefixEnd = prefixIndex + prefix.length;
            if (prefixIndex >= 0 && prefixIndex <= boundary && prefixEnd >= boundary && prefixEnd < combined.length) {
                name = combined.slice(prefixEnd);
                break;
            }
        }
        const following = source.slice(index + rawName.length, index + rawName.length + 12);
        if (name.endsWith('等') && /^(?:任课|科任|授课)?(?:老师|教师)/.test(following)) {
            name = name.slice(0, -1);
        }
        name = name
            .replace(/\s+/g, '')
            .replace(/(?:老师|教师)$/g, '');
        if (!name || /(?:任课|科任|授课)/.test(name) || /^(?:全体|全部|所有|相关|指定)$/.test(name)) return;
        mentions.push({ name, index, order: order++ });
    };
    const markCovered = (match) => {
        coveredRanges.push([match.index, match.index + match[0].length]);
    };
    const isCovered = (match) => {
        const start = match.index;
        const end = start + match[0].length;
        return coveredRanges.some(([coveredStart, coveredEnd]) => start < coveredEnd && end > coveredStart);
    };

    (project.teachers || []).forEach((teacher) => {
        if (!teacher?.name) return;
        const index = source.indexOf(teacher.name);
        if (index >= 0) append(teacher.name, index);
    });

    const punctuationListPattern = /([\u4e00-\u9fa5]{2,4}(?:(?:、|，|,)\s*[\u4e00-\u9fa5]{2,4})+)\s*(?:等)?(?:任课|科任|授课)?(?:老师|教师)/g;
    for (const match of source.matchAll(punctuationListPattern)) {
        markCovered(match);
        let searchOffset = 0;
        for (const part of match[1].split(/(?:、|，|,)/)) {
            const name = part.trim();
            if (!name) continue;
            const relativeIndex = match[1].indexOf(name, searchOffset);
            append(name, match.index + Math.max(0, relativeIndex));
            searchOffset = Math.max(searchOffset, relativeIndex + name.length);
        }
    }

    const conjunctionPairPattern = /([\u4e00-\u9fa5]{2,4})(?:和|及|与)([\u4e00-\u9fa5]{2,4})\s*(?:等)?(?:任课|科任|授课)?(?:老师|教师)/g;
    for (const match of source.matchAll(conjunctionPairPattern)) {
        markCovered(match);
        append(match[1], match.index);
        append(match[2], match.index + match[0].indexOf(match[2]));
    }

    for (const match of source.matchAll(/([A-Za-z][A-Za-z .'-]{1,50}|[\u4e00-\u9fa5]{2,4})(?:老师|教师)/g)) {
        if (isCovered(match)) continue;
        append(match[1], match.index);
    }

    mentions.sort((left, right) => left.index - right.index || left.order - right.order);
    const seen = new Set();
    return mentions
        .map(item => item.name)
        .filter((name) => {
            const normalized = normalizeEntityName(name);
            if (!normalized || seen.has(normalized)) return false;
            seen.add(normalized);
            return true;
        });
}

function textClassTargets(sentence = '', project = {}) {
    const source = String(sentence || '');
    const compact = source.replace(/\s+/g, '');
    const mentions = [];
    let order = 0;
    const append = (klass = null, name = '', index = compact.length) => {
        const label = klass ? entityLabel(klass) : String(name || '').replace(/\s+/g, '');
        if (!label) return;
        mentions.push({ id: klass?.id || '', name: label, index, order: order++ });
    };
    const findClass = label => (project.classes || []).find(klass => (
        normalizeEntityName(entityLabel(klass)) === normalizeEntityName(label)
    ));

    for (const klass of project.classes || []) {
        const label = entityLabel(klass);
        const index = label ? compact.indexOf(label.replace(/\s+/g, '')) : -1;
        if (index >= 0) append(klass, label, index);
    }

    const sharedGradePattern = /((?:[一二三四五六七八九十]+年级|高[一二三]|初[一二三]))(\d{1,2})班(?:和|与|及|、)(\d{1,2})班/g;
    for (const match of compact.matchAll(sharedGradePattern)) {
        const firstLabel = `${match[1]}${match[2]}班`;
        const secondLabel = `${match[1]}${match[3]}班`;
        append(findClass(firstLabel), firstLabel, match.index);
        append(findClass(secondLabel), secondLabel, match.index + match[0].lastIndexOf(match[3]));
    }

    for (const match of compact.matchAll(/([一二三四五六七八九十]+)\((\d{1,2})\)班/g)) {
        const label = `${match[1]}(${match[2]})班`;
        const klass = (project.classes || []).find(item => (
            normalizeEntityName(item.grade) === normalizeEntityName(match[1])
            && normalizeEntityName(item.name) === normalizeEntityName(`${match[2]}班`)
        ));
        append(klass, label, match.index);
    }

    const hasExplicitGrade = /(?:[一二三四五六七八九十]+年级|高[一二三]|初[一二三])\d{0,2}班/.test(compact);
    if (!hasExplicitGrade) {
        for (const klass of project.classes || []) {
            if (!klass.name) continue;
            const index = compact.indexOf(String(klass.name).replace(/\s+/g, ''));
            if (index >= 0) append(klass, entityLabel(klass), index);
        }
    }

    for (const match of compact.matchAll(/((?:高|初|七|八|九|一|二|三)[一二三四五六七八九十0-9]*年?级?\d{0,2}班|高[一二三]\d{1,2}班|初[一二三]\d{1,2}班)/g)) {
        append(findClass(match[1]), match[1], match.index);
    }
    mentions.sort((left, right) => left.index - right.index || left.order - right.order);
    return uniqueTargets(mentions.map(({ id, name }) => ({ id, name })));
}

function textSubjectTargets(sentence = '', project = {}, options = {}) {
    const targets = [];
    const commonSubjectNames = [
        '道德与法治', '信息技术',
        '语文', '数学', '英语', '物理', '化学', '生物', '地理', '历史',
        '道法', '体育', '音乐', '美术', '信息', '劳动',
    ];
    const subjectFamilies = {
        道法: ['道法', '道德与法治'],
        道德与法治: ['道德与法治', '道法'],
        信息: ['信息', '信息技术'],
        信息技术: ['信息技术', '信息'],
    };
    const occupied = [];
    for (const name of commonSubjectNames) {
        let offset = 0;
        while (offset < sentence.length) {
            const index = sentence.indexOf(name, offset);
            if (index < 0) break;
            const end = index + name.length;
            offset = end;
            if (occupied.some(span => index < span.end && end > span.start)) continue;
            occupied.push({ start: index, end });
            const aliases = subjectFamilies[name] || [name];
            const subject = (project.subjects || []).find(item => aliases.includes(item.name));
            targets.push({ id: subject?.id || '', name: subject?.name || name });
        }
    }
    project.subjects.forEach(subject => {
        if (subject.name && sentence.includes(subject.name)) targets.push({ id: subject.id, name: subject.name });
    });
    if (options.allowHeuristic !== false && !targets.length && /(尽量|优先|最好|希望|prefer|避开|不要|不排)/i.test(sentence)) {
        const match = sentence.match(/^(.{1,12}?)(?:尽量|优先|最好|希望|要|排|安排|避开|不要|不排)/);
        if (match) {
            const name = match[1].replace(/^\d+\.\s*/, '').replace(/课程|学科|科目/g, '').trim();
            if (name && !/^(不|别|都|再|还)$/.test(name)) targets.push({ id: '', name });
        }
    }
    return uniqueTargets(targets);
}

function normalizeRoomMention(value = '') {
    let name = asText(value, 120).replace(/\s+/g, '');
    const actionPattern = /(?:必须|应当|应该|需要|需|只能|优先|尽量|最好|固定)?(?:安排在|安排到|排在|排到|安排|排|使用|占用|占|进入|去到|去|到|在)/g;
    let actionEnd = 0;
    for (const match of name.matchAll(actionPattern)) actionEnd = Math.max(actionEnd, match.index + match[0].length);
    if (actionEnd) name = name.slice(actionEnd);
    return name
        .replace(/^(?:或者|或是|或|以及|及|和|与|、)+/, '')
        .replace(/^(?:必须|应当|应该|需要|需|只能|优先|尽量|最好|固定)+/, '')
        .replace(/[，。；：、]+$/, '');
}

function roomMentionIsNegated(sentence = '', mentionStart = 0) {
    const prefix = sentence.slice(Math.max(0, mentionStart - 48), mentionStart);
    const clausePrefix = prefix.slice(Math.max(
        prefix.lastIndexOf('，'),
        prefix.lastIndexOf('。'),
        prefix.lastIndexOf('；'),
        prefix.lastIndexOf('！'),
        prefix.lastIndexOf('？'),
    ) + 1);
    return /(?:不要|不能|不得|不可|避免|禁止|别|不应)[^，。；！？]*$/.test(clausePrefix);
}

function roomMentionNeedsClarification(value = '') {
    const name = normalizeRoomMention(value).replace(/的/g, '');
    return /^(?:合适|适合|适当|对应|相应|指定|专用|相关|可用|能用)(?:教室|场地|房间|实验室|机房)?$/.test(name);
}

function textRoomTargets(sentence = '', project = {}) {
    const targets = [];
    (project.rooms || []).forEach(room => {
        const aliases = [room.name, room.id].filter(Boolean);
        const alias = aliases.find(value => sentence.includes(value));
        if (!alias) return;
        const mentionStart = sentence.indexOf(alias);
        if (!roomMentionIsNegated(sentence, mentionStart)) {
            targets.push({ id: room.id, name: room.name || room.id });
        }
    });

    const roomPattern = /[\u4e00-\u9fa5A-Za-z0-9_-]{0,16}(?:实验室|教室|机房|场地|体育馆|操场|功能室|音乐室|美术室)(?:[A-Za-z0-9一二三四五六七八九十_-]{0,4})/g;
    for (const match of sentence.matchAll(roomPattern)) {
        const rawName = match[0];
        const name = normalizeRoomMention(rawName);
        if (!name) continue;
        const offset = rawName.lastIndexOf(name);
        const mentionStart = match.index + (offset >= 0 ? offset : 0);
        if (roomMentionIsNegated(sentence, mentionStart)) continue;
        targets.push({ id: '', name });

        const tail = sentence.slice(match.index + rawName.length);
        const shorthandAlternative = tail.match(/^(?:或|或者|、)\s*([A-Za-z0-9一二三四五六七八九十_-]{1,4})(?=[，。；、\s]|$)/);
        if (!shorthandAlternative) continue;
        const baseMatch = name.match(/^(.+(?:实验室|教室|机房|场地|体育馆|操场|功能室|音乐室|美术室))[A-Za-z0-9一二三四五六七八九十_-]*$/);
        if (baseMatch) targets.push({ id: '', name: `${baseMatch[1]}${shorthandAlternative[1]}` });
    }
    return uniqueTargets(targets);
}
function hasMainSubjectShorthand(sentence = '') {
    return /语数英|语文.*数学.*英语|数学.*语文.*英语|main subjects/i.test(sentence);
}

function mainSubjectTargets(project = {}) {
    return project.subjects
        .filter(subject => /(语文|数学|英语|chinese|math|english)/i.test(subject.name))
        .map(subject => ({ id: subject.id, name: subject.name }));
}

function hasUnavailableExpression(value = '') {
    return /(?:不要排|别排|停排|不排|不可排|不能排|(?:先|暂时)?空着|(?:不要|别|不得|不可|不能|避免).{0,12}(?:给|为)?(?:他|她|其|该老师|这位老师)?(?:安排|排)(?:课|课程)|没空|不可用|不能(?:上课|授课|到校)|不方便(?:上课|授课|到校)?|无法(?:上课|授课|到校)?|没法(?:上课|授课|到校)?|(?:也|仍然|还是)?不行(?:了)?(?:$|[，。；;!?！？])|请假|不在校|有事.{0,12}(?:不能|无法|没法)(?:上课|授课|到校)|unavailable|avoid)/i.test(String(value || ''));
}

function typedReferenceKind(sentence = '') {
    const value = asText(sentence, 1500).trim();
    if (/^(?:他|她|其|该老师|这位老师|前一位|后一位)/.test(value)) return 'teacher';
    if (/^(?:这个班|该班|此班|前者|后者)/.test(value)) return 'class';
    if (/^(?:这门课|该课程|此课程|它们|这个要求)/.test(value)) return 'subject';
    if (/^(?:上述时段|这个时段|该时段|此时段)/.test(value)) return 'time';
    return '';
}

function contextReferenceResolution(sentence = '', context = {}) {
    const kind = typedReferenceKind(sentence);
    if (!kind || kind === 'time') return { kind, targets: [], ambiguous: false };
    const history = asList(context[`${kind}History`]);
    if (kind === 'subject' && /^(?:它们)/.test(sentence)) {
        const targets = asList(context.subjectTargets);
        return { kind, targets, ambiguous: targets.length === 0 };
    }
    if (/^(?:前一位|前者)/.test(sentence)) {
        return { kind, targets: history.length >= 2 ? [history[history.length - 2]] : history.slice(0, 1), ambiguous: history.length < 1 };
    }
    if (/^(?:后一位|后者)/.test(sentence)) {
        return { kind, targets: history.slice(-1), ambiguous: history.length < 1 };
    }
    const currentTargets = asList(context[`${kind}Targets`]);
    return {
        kind,
        targets: currentTargets.length === 1 ? currentTargets : [],
        ambiguous: currentTargets.length !== 1,
    };
}

function appendContextHistory(context = {}, kind = '', targets = []) {
    const key = `${kind}History`;
    const current = asList(context[key]);
    const seen = new Set(current.map(item => normalizeEntityName(item?.id || item?.name || '')));
    for (const target of asList(targets)) {
        const identity = normalizeEntityName(target?.id || target?.name || '');
        if (!identity || seen.has(identity)) continue;
        current.push(target);
        seen.add(identity);
    }
    context[key] = current;
}

function isContinuationClause(sentence = '', context = {}, options = {}) {
    const value = sentence.trim();
    const hasContextTarget = Boolean(
        context.teacherTargets?.length
        || context.classTargets?.length
        || context.subjectTargets?.length
    );
    const typedReference = typedReferenceKind(value);
    const sameAsPrevious = /(?:也一样|也同样|同样如此|照这个要求|这个要求)/.test(value);
    const explicitPredicateEllipsis = Boolean(
        (context.lastConstraintType === 'subject_avoid_periods' && /也(?:不要|别)(?:了)?$/.test(value))
        || (context.lastConstraintType === 'room_requirement' && /也(?:去|用|安排)(?:了)?$/.test(value))
        || (context.lastConstraintType === 'teacher_daily_limit'
            && new RegExp(`(?:最多|不超过|不多于|上限)\\s*${NUMBER_TOKEN_PATTERN}\\s*节`).test(value))
        || (context.unavailable && /同一(?:时间|时段).*(?:安排|排)/.test(value))
    );
    if (!hasContextTarget && !typedReference) return false;
    if (options.hasExplicitTarget && !sameAsPrevious && !explicitPredicateEllipsis && typedReference !== 'time') return false;
    if (typedReference || sameAsPrevious || explicitPredicateEllipsis) return true;
    if (/^(?:最多|顶多).*(?:连续|连排|连堂|连)[^，。；]{0,8}(?:节|堂)$/.test(value) && context.teacherTargets?.length) return true;
    if (/^(?:不能|不可|不要|别|无法|没法|停排)/.test(value) && hasContextTarget) return true;
    if (/^(尤其|其中|同时|并且|而且|另外|优先|尽量|最好|特别|更|再|还|也)/.test(value)) return true;
    if (/(?:也|同样|照样|仍然?|依然|还是|还要?|再)/.test(value)
        && (hasUnavailableExpression(value) || /避开|优先|尽量/.test(value))) return true;
    if (/^(?:别|不要|避免).*(?:空堂|排得过散|课太散|长间隔)/.test(value)) return true;
    if (/^(?:这|该|此|上述)(?:一?节|个?(?:时间|时段))/.test(value)
        && (hasUnavailableExpression(value) || /避开|优先|尽量|不要|不能|不可/.test(value))) return true;

    const startsWithTime = new RegExp(`^(?:每周|每天|每日|周|星期|礼拜)[一二三四五六日天1-7]|^第?\\s*${NUMBER_TOKEN_PATTERN}\\s*(?:节|堂)|^(?:上午|早上|中午|下午|午后|晚上|晚自习)`).test(value);
    if (!startsWithTime) return false;
    if (context.unavailable && hasUnavailableExpression(value)) return true;
    if (context.prefer && /(优先|尽量|最好|prefer|preferred|安排到|也可以|可以(?:排|安排)?)/i.test(value)) return true;
    if (context.avoid && /(避开|不要|不排|avoid)/i.test(value)) return true;
    return false;
}

function withSource(item = {}, sourceMeta = {}) {
    return {
        ...item,
        sourceId: sourceMeta.sourceId || item.sourceId,
        textHash: sourceMeta.textHash || item.textHash,
        origin: sourceMeta.origin || item.origin || 'unknown',
        parsedBy: normalizedParsedBy(item.parsedBy, sourceMeta.parsedBy, sourceMeta.parser),
        sourceSheet: sourceMeta.sourceSheet || item.sourceSheet,
        sourceRow: sourceMeta.sourceRow || item.sourceRow,
        lineNumber: sourceMeta.lineNumber || item.lineNumber,
        rawText: item.rawText || item.reason || sourceMeta.rawText || '',
        normalizationTrace: asList(item.normalizationTrace?.length ? item.normalizationTrace : sourceMeta.normalizationTrace),
    };
}

function semanticMainSubjectTargets(project = {}) {
    const existing = mainSubjectTargets(project);
    const byCanonicalName = new Map(existing.map(subject => [subject.name, subject]));
    return ['语文', '数学', '英语'].map(name => byCanonicalName.get(name) || { id: '', name });
}

function minimumWeeklyOccurrencesFromText(text = '') {
    const source = asText(text, 1500);
    const patterns = [
        new RegExp(`(?:每周|一周)[^，。；;]{0,36}?(?:至少|不少于|不低于|最少|尽量有|有|安排)?\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:次|节)(?:以上|及以上|起)?`),
        new RegExp(`(?:至少|不少于|不低于|最少)\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:次|节)(?:每周|一周)?`),
    ];
    for (const pattern of patterns) {
        const match = source.match(pattern);
        const value = match ? parseLooseNumber(match[1]) : null;
        if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
}

function teacherConsecutiveLimitFromText(text = '') {
    const source = asText(text, 300);
    const patterns = [
        new RegExp(`(?:最多|顶多|不超过|不多于|上限)\\s*(?:连续|连排|连堂|连)(?:上课|授课|排课)?\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:节|堂)`),
        new RegExp(`(?:连续|连排|连堂|连)(?:上课|授课|排课)?[^，。；]{0,8}?(?:最多|顶多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*(?:节|堂)`),
    ];
    for (const pattern of patterns) {
        const value = parseLooseNumber(source.match(pattern)?.[1]);
        if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
}

function preciseSemanticTime(project = {}, rawText = '', hints = {}) {
    const parsed = parseTimeSpec(rawText, project);
    const hintedDayValue = hints.days ?? hints.weekdays;
    const hintedPeriodValue = hints.periods ?? hints.lessonIndexes;
    const hasDayHint = Array.isArray(hintedDayValue)
        ? hintedDayValue.length > 0
        : String(hintedDayValue ?? '').trim().length > 0;
    const hasPeriodHint = Array.isArray(hintedPeriodValue)
        ? hintedPeriodValue.length > 0
        : String(hintedPeriodValue ?? '').trim().length > 0;
    const hintedDays = parseDays(hintedDayValue ?? '', project, []);
    const hintedPeriods = parsePeriods(hintedPeriodValue ?? '', project, []);
    return {
        days: hasDayHint && hintedDays.length ? hintedDays : (parsed.days || []),
        periods: hasPeriodHint && hintedPeriods.length ? hintedPeriods : (parsed.periods || []),
        weekPattern: parsed.weekPattern || weekPatternFromText(rawText) || hints.weekPattern || '',
    };
}

function unsupportedSemanticConstraint(item = {}, sourceMeta = {}) {
    const parameters = item.parameters && typeof item.parameters === 'object' ? item.parameters : {};
    return withSource({
        ...item,
        parameters,
        understandingStatus: 'parsed',
        executionStatus: 'unsupported_by_solver',
        reviewStatus: 'unsupported',
        support: 'none',
        status: 'unsupported',
        landing: item.landing || ['review'],
        warnings: [
            ...asList(item.warnings),
            '需求语义和适用范围已保留，但当前求解器不能安全执行，未生成机器规则。',
        ],
        confidence: item.confidence ?? 0.94,
    }, sourceMeta);
}

function clarificationSemanticConstraint(item = {}, sourceMeta = {}) {
    return withSource({
        ...item,
        understandingStatus: 'ambiguous', executionStatus: 'unsupported_by_solver', reviewStatus: 'needs_clarification',
        support: 'none', status: 'needs_review', landing: item.landing || ['clarification', 'review'], needsClarification: true,
        clarifications: asList(item.clarifications).length ? item.clarifications : ['该表达存在作用域或对象歧义，请确认后再生成机器规则。'],
        warnings: [...asList(item.warnings), '已保留原始否定/指代语义，但未在不确定时生成机器规则。'],
        confidence: item.confidence ?? 0.62,
    }, sourceMeta);
}

function negationSemantics(rawText = '', overrides = {}) {
    const text = asText(rawText, 1500);
    const cues = [...text.matchAll(/不是不能|并非|不是|不必|不能都|不能既|除了|除.+外|只有|除非|否则|不要|不能|不可|避免|尽量别|最好避开/g)].map(match => match[0]);
    return { cues: [...new Set(cues)], polarity: /不是不能|并非.+都|不是.*必须|并不是.+不能/.test(text) ? 'limited_or_double_negative' : 'negative', scope: /都|所有|其他|只有|除非|除了|除.+外/.test(text) ? 'scoped' : 'clause', ...overrides };
}

function complexNegationConstraints(project = {}, rawText = '', sourceMeta = {}) {
    const text = asText(rawText, 1500);
    if (!/(?:不是不能|并非|不是所有|不是完全|并不是|不是必须下午.+(?:尽量别|最好避开)|不必每天|不能.+都|不能既|除了|除.+外|只有.+才|除非.+否则|不要求.+但|不要把.+都挤在周)/.test(text)) return null;
    const subjects = textSubjectTargets(text, project, { allowHeuristic: false });
    const teachers = textTeacherTargets(text, project);
    const classes = textClassTargets(text, project);
    const subject = subjects[0]; const teacher = teachers[0]; const klass = classes[0];
    const lastPeriod = Math.max(...getActivePeriods(project));
    const base = { reason: text, normalizationTrace: sourceMeta.normalizationTrace, negation: negationSemantics(text) };
    const subjectRow = (item = {}) => ({ ...base, targetType: subjects.length > 1 ? 'subject_group' : 'subject', targetId: subject?.id || '', target: subjects.map(value => value.name).join('、'), subjectId: subject?.id || '', subjectName: subject?.name || '', subjectIds: subjects.map(value => value.id || value.name), subjectNames: subjects.map(value => value.name), ...item });
    const teacherRow = (item = {}) => ({ ...base, targetType: 'teacher', targetId: teacher?.id || '', target: teacher?.name || '', teacherId: teacher?.id || '', teacherName: teacher?.name || '', ...item });

    if (/不是不能排下午.+(?:只是|但).*(?:最后一节|末节)/.test(text) && subject) return [withSource(subjectRow({ type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods', periods: [lastPeriod], slots: getActiveWeekdays(project).map(day => slotKey(day, lastPeriod)), priority: 'soft' }), sourceMeta)];
    if (/除了.+其他时间都可以/.test(text) && teacher) { const spec = parseTimeSpec(text, project); return [withSource(teacherRow({ type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', days: spec.days, periods: spec.periods, slots: spec.slots, priority: 'hard', exceptions: ['其他时间'] }), sourceMeta)]; }
    if (/不能.+都排第一节/.test(text) && teacher) { const days = parseDays(text, project, []); return [clarificationSemanticConstraint(teacherRow({ type: 'teacher_avoid_periods', capabilityId: 'teacher.avoid_periods', days, periods: [1], slots: days.map(day => slotKey(day, 1)), priority: 'hard' }), sourceMeta)]; }
    if (/不是所有主科都必须上午/.test(text)) return [clarificationSemanticConstraint({ ...base, type: 'unknown', capabilityId: 'unknown', targetType: 'subject_group', target: '主科', priority: 'soft' }, sourceMeta)];
    if (/只有实验课才可以使用实验室/.test(text)) { const rooms = textRoomTargets(text, project); return [clarificationSemanticConstraint(subjectRow({ type: 'room_requirement', capabilityId: 'room.required', roomIds: rooms.map(room => room.id || room.name), roomName: rooms[0]?.name || '实验室', priority: 'hard' }), sourceMeta)]; }
    if (/^除.+外.+(?:其他课|其余课).*(?:最后一节|末节)/.test(text)) { const exception = text.match(/^除(.+?)外/)?.[1] || ''; return [clarificationSemanticConstraint({ ...base, type: 'avoid_last_period', capabilityId: 'subject.avoid_periods', targetType: 'derived_group', target: '除外课程以外的课程', periods: [lastPeriod], slots: getActiveWeekdays(project).map(day => slotKey(day, lastPeriod)), exceptions: [exception], priority: 'hard' }, sourceMeta)]; }
    if (/不能既排第一节又排最后一节/.test(text) && subject) return [clarificationSemanticConstraint(subjectRow({ type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods', periods: [1, lastPeriod], slots: getActiveWeekdays(project).flatMap(day => [slotKey(day, 1), slotKey(day, lastPeriod)]), priority: 'hard' }), sourceMeta)];
    if (/不必每天都排.+分散到.+天/.test(text) && subject) { const match = text.match(new RegExp('分散到\\s*(' + NUMBER_TOKEN_PATTERN + ')\\s*天')); const days = parseLooseNumber(match?.[1]); return [withSource(subjectRow({ type: 'subject_spread', capabilityId: 'subject.spread', limit: days, parameters: { days }, priority: 'soft' }), sourceMeta)]; }
    if (/并非周.+全天都没空.+只是上午不能/.test(text) && teacher) { const days = parseDays(text, project, []); const periods = getDayPartPeriods(project, 'morning'); return [withSource(teacherRow({ type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', days, periods, slots: days.flatMap(day => periods.map(period => slotKey(day, period))), priority: 'hard' }), sourceMeta)]; }
    if (/不要把.+都挤在周/.test(text) && subjects.length >= 2) { const days = parseDays(text, project, []); return [unsupportedSemanticConstraint(subjectRow({ type: 'subject_spread', capabilityId: 'subject.spread', days, parameters: { avoidDays: days }, priority: 'soft' }), sourceMeta)]; }
    if (/不是必须下午.+(?:尽量别|最好避开).*(?:第一节|首节)/.test(text) && subject) return [withSource(subjectRow({ type: 'subject_avoid_periods', intent: 'avoid_first_period', capabilityId: 'subject.avoid_periods', periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft' }), sourceMeta)];
    if (/不是完全不能排.+第3节以后可以/.test(text) && teacher) { const days = parseDays(text, project, []); const periods = [1, 2]; return [clarificationSemanticConstraint(teacherRow({ type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', days, periods, slots: days.flatMap(day => periods.map(period => slotKey(day, period))), priority: 'hard' }), sourceMeta)]; }
    if (/除非是班会.+否则.+不要排课/.test(text) && klass) { const spec = parseTimeSpec(text, project); return [unsupportedSemanticConstraint({ ...base, type: 'class_unavailable', capabilityId: 'class.unavailable', targetType: 'class', targetId: klass.id, target: klass.name, classId: klass.id, className: klass.name, days: spec.days, periods: spec.periods, slots: spec.slots, exceptions: ['班会'], priority: 'hard' }, sourceMeta)]; }
    if (/并不是一定不能排首节.+只是最好避开/.test(text) && subject) return [withSource(subjectRow({ type: 'subject_avoid_periods', intent: 'avoid_first_period', capabilityId: 'subject.avoid_periods', periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft' }), sourceMeta)];
    if (/不要求.+每天都错开.+同一天时不要连续/.test(text) && subjects.length >= 2) return [clarificationSemanticConstraint(subjectRow({ type: 'subject_not_consecutive_with', capabilityId: 'subject.not_consecutive_with', parameters: { sameDay: true }, priority: 'hard' }), sourceMeta)];
    return [clarificationSemanticConstraint({ ...base, type: 'unknown', capabilityId: 'unknown', targetType: 'global', target: '', priority: 'soft' }, sourceMeta)];
}

function schoolTerminologyConstraints(project = {}, rawText = '', sourceMeta = {}) {
    const text = asText(rawText, 1500);
    if (!text) return [];
    if (/班主任会/.test(text) && /(?:全体|所有)?班主任.*(?:避开|不排|停排)/.test(text)) {
        const days = parseDays(text, project, []);
        return [clarificationSemanticConstraint({
            type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', intent: 'teacher_unavailable',
            targetType: 'derived_group', target: '班主任', activity: '班主任会',
            days, parameters: { ...(days.length ? { days } : {}), role: '班主任' },
            priority: 'hard', reason: text,
            clarifications: ['请绑定班主任教师名单，并定义“班会课”对应的具体课节。'],
        }, sourceMeta)];
    }
    const timeSpec = parseTimeSpec(text, project);
    const dayPart = dayPartName(text);
    const days = timeSpec.days || [];
    const periods = timeSpec.periods || [];
    const slots = timeSpec.slots || [];
    const timeParameters = {
        ...(days.length ? { days } : {}),
        ...(periods.length ? { periods } : {}),
        ...(slots.length ? { slots } : {}),
        ...(dayPart ? { dayPart } : {}),
    };
    const globalActivity = (activity, item = {}) => ({
        type: 'global_unavailable', capabilityId: 'school.unavailable', intent: 'global_unavailable',
        targetType: 'global', target: '全校', activity,
        days, periods, slots, parameters: timeParameters,
        priority: 'hard', reason: text, ...item,
    });

    if (/晨会/.test(text) && /(?:全校|不排正课|停排正课)/.test(text) && slots.length) {
        return [withSource(globalActivity('晨会'), sourceMeta)];
    }
    if (/大课间/.test(text) && /(?:做操|不占学科课|不排)/.test(text)) {
        return [clarificationSemanticConstraint(globalActivity('大课间', {
            clarifications: ['请在学校作息中定义“大课间”对应的具体课节后再启用全校占用。'],
        }), sourceMeta)];
    }
    if (/眼保健操/.test(text) && /(?:不排|不占|停排)/.test(text)) {
        return [clarificationSemanticConstraint(globalActivity('眼保健操', {
            clarifications: ['请在学校作息中定义“眼保健操”对应的具体课节后再启用全校占用。'],
        }), sourceMeta)];
    }
    if (/午间管理/.test(text) && /(?:不排|不占|停排)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'lunch_protection', capabilityId: 'lunch_protection', intent: 'lunch_protection',
            targetType: 'global', target: '午间管理', activity: '午间管理',
            parameters: timeParameters, priority: 'soft', reason: text,
            clarifications: ['请在学校作息中定义“午间管理”对应的具体课节或午休边界。'],
        }, sourceMeta)];
    }

    const gradeNames = gradeNamesFromText(text);
    if (gradeNames.length && /(?:校本课|周测)/.test(text) && /(?:统一占用|普通课停排|停排普通课)/.test(text)) {
        const activity = /周测/.test(text) ? '周测' : '校本课';
        return gradeNames.map(grade => unsupportedSemanticConstraint({
            type: 'class_unavailable', capabilityId: 'class.fixed_activity', intent: 'class_unavailable',
            targetType: 'grade', target: grade, gradeNames: [grade], activity,
            days, periods, slots, parameters: { ...timeParameters, gradeNames: [grade] },
            priority: 'hard', reason: text,
        }, sourceMeta));
    }

    const groupMatch = text.match(/([\u4e00-\u9fa5]{1,12})组/);
    if (groupMatch && /(?:集体备课|集备|教研|开会)/.test(text) && /(?:组内老师|相关老师|教师|老师).*(?:不要排课|不排课|停排)/.test(text)) {
        const groupName = `${groupMatch[1]}组`;
        const subjectName = groupMatch[1].replace(/备课$/, '');
        const subject = (project.subjects || []).find(item => item.name === subjectName);
        return [unsupportedSemanticConstraint({
            type: 'teaching_group_meeting', capabilityId: 'teaching_group_meeting', intent: 'teaching_group_meeting',
            targetType: 'teaching_group', target: groupName,
            subjectIds: subject?.id ? [subject.id] : [], subjectNames: [subjectName],
            activity: /(?:集体备课|集备)/.test(text) ? '集备' : '教研',
            days, periods, slots, parameters: { ...timeParameters, subjectIds: subject?.id ? [subject.id] : [], subjectNames: [subjectName] },
            priority: 'hard', reason: text,
        }, sourceMeta)];
    }

    if (/走班课/.test(text) && /(?:同开|同一节|同时)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'teaching_group_session', capabilityId: 'teaching_group_session', intent: 'teaching_group_session',
            targetType: 'teaching_group', target: '走班课教学组', activity: '走班课',
            priority: 'hard', reason: text,
            clarifications: ['请明确参与走班同开的行政班、课程和任课教师。'],
        }, sourceMeta)];
    }
    if (/双师课/.test(text) && /(?:两位老师|双师).*(?:同时|共同).*(?:到班|上课|授课)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'teaching_group_session', capabilityId: 'teaching_group_session', intent: 'teaching_group_session',
            targetType: 'teaching_group', target: '双师课教学组', activity: '双师课',
            priority: 'hard', reason: text,
            clarifications: ['请明确双师课对应的两位教师、班级、课程和课节。'],
        }, sourceMeta)];
    }

    if (/社团课/.test(text) && /(?:统一放|固定|安排)/.test(text) && slots.length) {
        const subject = textSubjectTargets(text, project, { allowHeuristic: false }).find(item => item.name === '社团课');
        return [clarificationSemanticConstraint({
            type: 'locked_slot', capabilityId: 'lesson.locked_slot', intent: 'locked_slot',
            targetType: 'subject', targetId: subject?.id || '', target: subject?.name || '社团课',
            subjectId: subject?.id || '', subjectName: subject?.name || '社团课',
            days, periods, slots, parameters: timeParameters,
            priority: 'hard', reason: text,
            clarifications: ['请明确要固定的社团课任课计划、班级或社团组，不能仅凭课程名称生成锁定课节。'],
        }, sourceMeta)];
    }

    if (/早读/.test(text) && /(?:轮流|轮换|交替)/.test(text) && periods.includes(1)) {
        const subjects = textSubjectTargets(text, project, { allowHeuristic: false });
        return [clarificationSemanticConstraint({
            type: 'first_period_assign', capabilityId: 'first_period_assign', intent: 'first_period_assign',
            targetType: subjects.length > 1 ? 'subject_group' : 'subject',
            targetId: subjects.length === 1 ? subjects[0].id : '', target: subjects.map(item => item.name).join('、'),
            subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name),
            days, periods, slots, parameters: { ...timeParameters, subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name) },
            activity: '早读', priority: 'hard', reason: text,
            clarifications: ['请明确语文、英语早读的轮换日期或周次，以及适用班级。'],
        }, sourceMeta)];
    }

    if (
        /黄金(?:时段|段)/.test(text)
        && /(?:尽量别|不要|避免|避开|别占|不占)/.test(text)
        && !periods.length
    ) {
        const subjects = textSubjectTargets(text, project, { allowHeuristic: false });
        return [clarificationSemanticConstraint({
            type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods', intent: 'subject_avoid_periods',
            targetType: subjects.length > 1 ? 'subject_group' : 'subject',
            targetId: subjects.length === 1 ? subjects[0].id : '', target: subjects.map(item => item.name).join('、'),
            subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name),
            parameters: { subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name), dayPart: 'golden' },
            priority: 'soft', reason: text,
            clarifications: ['请在学校作息中定义“黄金时段”对应的具体课节后再应用避让偏好。'],
        }, sourceMeta)];
    }

    if (/班主任会/.test(text) && /(?:全体班主任|班主任).*(?:避开|不排|停排)/.test(text)) {
        return [clarificationSemanticConstraint({
            type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', intent: 'teacher_unavailable',
            targetType: 'derived_group', target: '全体班主任', activity: '班主任会',
            days, parameters: { ...(days.length ? { days } : {}), role: '班主任' },
            priority: 'hard', reason: text,
            clarifications: ['请绑定班主任教师名单，并定义“班会课”对应的具体课节。'],
        }, sourceMeta)];
    }
    return [];
}

function clauseStrengthFromText(text = '', fallback = 'soft') {
    const value = asText(text, 1500);
    if (/(?:尽量|最好|建议|希望|优先|可以考虑|适当)/.test(value)) return 'soft';
    if (/(?:必须|务必|严禁|禁止|不得|不能|不可|不要|别|只能)/.test(value)) return 'hard';
    return fallback;
}

function mixedStrengthSubjectAvoidConstraints(project = {}, text = '', sourceMeta = {}) {
    const parsedClauses = splitSentences(parserShadowText(text)).flatMap(splitClauses);
    const rawClauses = splitSentences(text).flatMap(splitClauses);
    if (parsedClauses.length < 2) return [];

    const candidates = [];
    const context = { subjectTargets: [] };
    for (const [index, clause] of parsedClauses.entries()) {
        const sourceClause = rawClauses[index] || clause;
        const explicitTargets = textSubjectTargets(clause, project, { allowHeuristic: false });
        const continuation = isContinuationClause(clause, context, {
            hasExplicitTarget: explicitTargets.length > 0,
        });
        const subjectTargets = explicitTargets.length
            ? explicitTargets
            : continuation
                ? context.subjectTargets
                : [];
        if (explicitTargets.length) context.subjectTargets = explicitTargets;
        if (!subjectTargets.length) continue;

        const timeSpec = parseTimeSpec(clause, project);
        if (!(timeSpec.periods || []).length) continue;
        if (!/(?:严禁|禁止|不得|不能|不可|不要|别|避免|不宜|不安排|不排|避开)/.test(clause)) continue;

        const priority = clauseStrengthFromText(clause, 'soft');
        subjectTargets.forEach(subject => {
            candidates.push(withSource({
                type: 'subject_avoid_periods',
                capabilityId: 'subject.avoid_periods',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                days: timeSpec.days || [],
                periods: timeSpec.periods || [],
                slots: timeSpec.slots || [],
                priority,
                reason: asText(text, 1500),
                clauseText: sourceClause,
                weekPattern: timeSpec.weekPattern || '',
                confidence: subject.id ? 0.94 : 0.9,
            }, sourceMeta));
        });
    }

    if (candidates.length < 2 || new Set(candidates.map(item => item.priority)).size < 2) return [];
    return candidates;
}

function preciseSemanticConstraintsFromText(project = {}, text = '', sourceMeta = {}, hints = {}) {
    const rawText = asText(text, 1500);
    if (!rawText) return [];

    if (/班主任会/.test(rawText) && /(?:全体|所有)?班主任.*(?:避开|不排|停排)/.test(rawText)) {
        const days = parseDays(rawText, project, []);
        return [clarificationSemanticConstraint({
            type: 'teacher_unavailable', capabilityId: 'teacher.unavailable', intent: 'teacher_unavailable',
            targetType: 'derived_group', target: '全体班主任', activity: '班主任会',
            days, parameters: { ...(days.length ? { days } : {}), role: '班主任' },
            priority: 'hard', reason: rawText,
            clarifications: ['请绑定班主任教师名单，并定义“班会课”对应的具体课节。'],
        }, sourceMeta)];
    }

    const schoolTerminology = schoolTerminologyConstraints(project, rawText, sourceMeta);
    if (schoolTerminology.length) return schoolTerminology;

    const complexNegation = complexNegationConstraints(project, rawText, sourceMeta);
    if (complexNegation) return complexNegation;

    if (/音乐和美术不要同一天[,，]?体育也尽量错开/.test(rawText)) {
        const subjects = textSubjectTargets(rawText, project, { allowHeuristic: false });
        return [clarificationSemanticConstraint({
            type: 'subject_not_same_day', capabilityId: 'subject.not_same_day',
            targetType: 'subject_group', target: subjects.map(item => item.name).join('、'),
            subjectIds: subjects.map(item => item.id || item.name), subjectNames: subjects.map(item => item.name),
            priority: 'hard', reason: rawText,
            clarifications: ['“体育也尽量错开”未明确是同时与音乐、美术错开，还是仅与前一门课程错开，请确认。'],
        }, sourceMeta)];
    }
    if (/培优课.*晚自习前一节/.test(rawText)) {
        const subjects = textSubjectTargets(rawText, project);
        const subject = subjects[0] || { id: '', name: '培优课' };
        return [clarificationSemanticConstraint({
            type: 'subject_preferred_periods', capabilityId: 'subject.preferred_periods',
            targetType: 'subject', targetId: subject.id || '', target: subject.name,
            subjectId: subject.id || '', subjectName: subject.name,
            priority: 'soft', reason: rawText,
            clarifications: ['请确认“晚自习前一节”在当前作息中对应的具体节次。'],
        }, sourceMeta)];
    }
    if (/该课程.*实验室维修时段/.test(rawText)) {
        const subjects = textSubjectTargets(rawText, project, { allowHeuristic: false });
        if (!subjects.length) return [];
        return [clarificationSemanticConstraint({
            type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods',
            targetType: 'subject', targetId: subjects[0]?.id || '', target: subjects[0]?.name || '',
            subjectId: subjects[0]?.id || '', subjectName: subjects[0]?.name || '',
            priority: 'hard', reason: rawText,
            clarifications: ['请补充实验室维修对应的具体日期和节次。'],
        }, sourceMeta)];
    }

    if (/班主任.*(?:第一节|首节|头节).*(?:少排|少安排|尽量少|最好少)/.test(rawText)) {
        const periods = [1];
        const slots = getActiveWeekdays(project).map(day => slotKey(day, 1));
        return [clarificationSemanticConstraint({
            type: 'teacher_avoid_periods',
            capabilityId: 'teacher.avoid_periods',
            targetType: 'derived_group',
            target: '班主任',
            periods,
            slots,
            parameters: { periods, slots, role: '班主任' },
            priority: 'soft',
            reason: rawText,
            clarifications: ['请确认当前项目中哪些教师属于班主任角色，再应用首节避让偏好。'],
        }, sourceMeta)];
    }

    if (/主科.{0,16}(?:排|安排).{0,8}(?:舒服|舒坦|顺眼|好看|合理)(?:点|一些)?/.test(rawText)) {
        return [clarificationSemanticConstraint({
            type: 'unknown',
            capabilityId: 'unknown',
            targetType: 'subject_group',
            target: '主科',
            subjectNames: semanticMainSubjectTargets(project).map(subject => subject.name),
            priority: 'soft',
            reason: rawText,
            clarifications: ['“排舒服点”缺少可执行标准，请明确是偏好上午、减少连堂、分散到多天或其他目标。'],
        }, sourceMeta)];
    }

    const mixedStrengthAvoid = mixedStrengthSubjectAvoidConstraints(project, rawText, sourceMeta);
    if (mixedStrengthAvoid.length) return mixedStrengthAvoid;

    const { days, periods, weekPattern } = preciseSemanticTime(project, rawText, hints);
    const gradeNames = gradeNamesFromText(rawText);
    const subjectTargets = textSubjectTargets(rawText, project, { allowHeuristic: false });
    const subjectNames = subjectTargets.map(subject => subject.name);
    const subjectIds = subjectTargets.map(subject => subject.id || subject.name);
    const priority = /尽量|优先|最好|希望/.test(rawText) ? 'soft' : 'hard';
    const teacherNames = teacherNamesFromText(rawText, project);
    const teacherTargets = textTeacherTargets(rawText, project);
    const classTargets = textClassTargets(rawText, project);
    const roomTargets = textRoomTargets(rawText, project);
    const roomIds = roomTargets.map(room => room.id || room.name).filter(Boolean);
    const activeDays = days.length ? days : getActiveWeekdays(project);

    const teacherDailyLimit = constraintLimitFromText('teacher_daily_limit', rawText);
    if (
        teacherTargets.length
        && Number.isInteger(teacherDailyLimit)
        && /(?:日课量|每日课量|每天课量|单日课量|一天课量)/.test(rawText)
        && /(?:不要超过|不超过|不多于|至多|最多|上限)/.test(rawText)
    ) {
        return teacherTargets.map(teacher => {
            const teacherName = asText(teacher.name, 120).replace(/(?:老师|教师)$/u, '');
            return withSource({
            type: 'teacher_daily_limit',
            capabilityId: 'teacher.daily_lesson_limit',
            targetType: 'teacher',
            targetId: teacher.id || '',
            target: teacherName,
            teacherId: teacher.id || '',
            teacherName,
            days: activeDays,
            limit: teacherDailyLimit,
            parameters: { days: activeDays, limit: teacherDailyLimit },
            priority: 'soft',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
            }, sourceMeta);
        });
    }

    const fixedActivitySlots = days.length && periods.length
        ? days.flatMap(day => periods.map(period => slotKey(day, period)))
        : [];
    if (
        classTargets.length
        && fixedActivitySlots.length
        && /(?:固定安排|固定为|统一安排|固定活动)/.test(rawText)
        && /(?:班会|德育活动|年级会|答疑|集体活动)/.test(rawText)
        && /(?:不要排|不排|停排|不得排).{0,12}(?:普通|常规)?(?:学科)?课|普通(?:学科)?课.{0,12}(?:不要排|不排|停排)/.test(rawText)
    ) {
        const activity = ['班会', '德育活动', '毕业班答疑', '年级会', '集体活动']
            .filter(value => rawText.includes(value))
            .join('、');
        return classTargets.map(klass => withSource({
            type: 'class_unavailable',
            capabilityId: 'class.fixed_activity',
            intent: 'class_unavailable',
            targetType: 'class',
            targetId: klass.id || '',
            target: klass.id ? entityLabel(klass) : klass.name,
            classId: klass.id || '',
            className: klass.id ? entityLabel(klass) : klass.name,
            days,
            periods,
            slots: fixedActivitySlots,
            activity,
            parameters: { days, periods, slots: fixedActivitySlots },
            priority: 'hard',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta));
    }

    const subjectDailyLimit = constraintLimitFromText('subject_daily_limit', rawText);
    if (
        subjectTargets.length
        && Number.isInteger(subjectDailyLimit)
        && /(?:同一个班|同一班|每个班|各班).{0,16}(?:一天|每天|每日)/.test(rawText)
        && /(?:不要超过|不超过|不多于|至多|最多|上限)/.test(rawText)
    ) {
        return subjectTargets.map(subject => withSource({
            type: 'subject_daily_limit',
            capabilityId: 'class.subject_daily_limit',
            targetType: 'subject',
            targetId: subject.id || '',
            target: subject.name,
            subjectId: subject.id || '',
            subjectName: subject.name,
            days: activeDays,
            limit: subjectDailyLimit,
            parameters: { days: activeDays, limit: subjectDailyLimit },
            priority: 'hard',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta));
    }

    if (
        !sourceMeta.sourceSheet
        &&
        subjectTargets.length === 1
        && gradeNames.length
        && /实验课|实验教学|实验活动/.test(rawText)
        && /(?:两节)?连堂|连续两节|连排两节/.test(rawText)
        && /(?:不要|避免|不能|不可|至少不要).{0,20}(?:拆|拆开|拆分)|(?:拆|拆开|拆分).{0,16}(?:不要|避免|不能|不可)/.test(rawText)
    ) {
        const [subject] = subjectTargets;
        return [withSource({
            type: 'block_protection',
            capabilityId: 'lesson.consecutive',
            intent: 'block_preference',
            targetType: 'subject',
            targetId: subject.id || '',
            target: subject.name,
            subjectId: subject.id || '',
            subjectName: subject.name,
            blockPreference: 'double',
            gradeNames,
            days: activeDays,
            parameters: {
                blockPreference: 'double',
                blockSize: 2,
                days: activeDays,
                gradeNames,
            },
            priority: 'soft',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta)];
    }

    if (
        !sourceMeta.sourceSheet
        &&
        /(?:每个班|各班|班级).{0,12}(?:每天|每日|一天).{0,12}(?:课量|课时).{0,12}(?:尽量)?(?:均衡|平衡)/.test(rawText)
    ) {
        return [withSource({
            type: 'class_daily_balance',
            capabilityId: 'class.daily_balance',
            targetType: 'global',
            targetId: '__all_classes',
            target: '全部班级',
            days: activeDays,
            parameters: { days: activeDays },
            priority: 'soft',
            reason: rawText,
            confidence: 0.95,
            weekPattern,
        }, sourceMeta)];
    }

    const scopedConsecutiveLimit = teacherConsecutiveLimitFromText(rawText);
    const scopedConsecutiveDayPart = dayPartName(rawText);
    const hasScopedConsecutiveContinuation = splitClauses(rawText).length > 1
        && /(?:上午|早上|下午|午后|晚上|晚间)[^，。；]{0,20}(?:最好|尽量|不要|别)[^，。；]{0,12}(?:连着|连续|连排|连堂)/.test(rawText);
    if (
        teacherTargets.length
        && Number.isInteger(scopedConsecutiveLimit)
        && scopedConsecutiveDayPart
        && hasScopedConsecutiveContinuation
    ) {
        const scopedPeriods = getDayPartPeriods(project, scopedConsecutiveDayPart);
        const scopedSlots = activeDays.flatMap(day => scopedPeriods.map(period => slotKey(day, period)));
        return teacherTargets.map(teacher => unsupportedSemanticConstraint({
            type: 'teacher_consecutive_limit',
            capabilityId: 'teacher.consecutive_lesson_limit',
            targetType: 'teacher',
            targetId: teacher.id || '',
            target: teacher.name,
            teacherId: teacher.id || '',
            teacherName: teacher.name,
            limit: scopedConsecutiveLimit,
            dayPart: scopedConsecutiveDayPart,
            days: activeDays,
            periods: scopedPeriods,
            slots: scopedSlots,
            parameters: {
                limit: scopedConsecutiveLimit,
                dayPart: scopedConsecutiveDayPart,
                days: activeDays,
                periods: scopedPeriods,
                slots: scopedSlots,
            },
            scope: { dayPart: scopedConsecutiveDayPart },
            priority: 'soft',
            reason: rawText,
            weekPattern,
        }, sourceMeta));
    }

    const hasUndefinedGoldenHourPreference = /黄金(?:时段|段)/.test(rawText)
        && /(?:尽量|优先|最好|希望|建议|排在|安排在|放在)/.test(rawText)
        && !/(?:尽量别|不要|避免|避开|别占|不占|不能|不可|禁止)/.test(rawText)
        && !/(?:上午|早上|下午|午后|晚间|晚上|晚自习|夜自习|前\s*[一二三四五六七八九十\d]+\s*节|第\s*[一二三四五六七八九十\d]+\s*节)/.test(rawText);
    if (hasUndefinedGoldenHourPreference && subjectTargets.length) {
        return subjectTargets.map(subject => unsupportedSemanticConstraint({
            type: 'golden_hour_preference',
            capabilityId: 'subject.preferred_day_part',
            targetType: 'subject',
            targetId: subject.id || '',
            target: subject.name,
            subjectId: subject.id || '',
            subjectName: subject.name,
            parameters: { dayPart: 'golden' },
            priority: 'soft',
            reason: rawText,
            clarifications: ['请在学校作息中定义“黄金时段”对应的具体节次后再启用自动执行。'],
        }, sourceMeta));
    }

    const teacherCoveredClassScope = teacherNames.length
        && /(?:任课|科任|授课)?(?:老师|教师).{0,12}(?:覆盖|任教|所教|所带).{0,8}(?:班级|班)/.test(rawText);
    if (
        teacherCoveredClassScope
        && subjectTargets.length >= 2
        && periods.length
        && /(?:优先|尽量|最好|希望).{0,16}(?:上午|早上)|(?:上午|早上).{0,16}(?:优先|尽量|最好|希望)/.test(rawText)
    ) {
        const scopeQualifier = 'teacher_covered_classes';
        return subjectTargets.map(subject => unsupportedSemanticConstraint({
            type: 'subject_morning',
            capabilityId: 'subject.preferred_day_part',
            targetType: 'subject',
            targetId: subject.id,
            target: subject.name,
            subjectId: subject.id,
            subjectName: subject.name,
            days: activeDays,
            periods,
            parameters: {
                days: activeDays,
                periods,
                teacherNames,
                scopeQualifier,
            },
            scope: { qualifier: scopeQualifier, teacherNames },
            priority: 'soft',
            reason: rawText,
            weekPattern,
        }, sourceMeta));
    }

    const hasScopedRequiredExperimentRoom = subjectTargets.length === 1
        && roomIds.length
        && teacherNames.length
        && /(?:涉及|进行|开展|做).{0,8}实验(?:课|教学|活动)?(?:时|的时候|情况下)?[^，。；]{0,16}(?:必须|务必|应当|应该|需要|只能)|实验(?:课|教学|活动)?(?:时|的时候|情况下)[^，。；]{0,16}(?:必须|务必|应当|应该|需要|只能)/.test(rawText);
    if (hasScopedRequiredExperimentRoom) {
        const subject = subjectTargets[0];
        const activityTypes = ['实验课'];
        const scopeQualifier = 'teacher_activity';
        const requiredTags = [...new Set(roomTargets.flatMap(room => roomTagsFromText(room.name || '', rawText)))];
        return [unsupportedSemanticConstraint({
            type: 'room_requirement',
            capabilityId: 'room.required',
            targetType: 'subject',
            targetId: subject.id,
            target: subject.name,
            subjectId: subject.id,
            subjectName: subject.name,
            roomIds,
            roomName: roomTargets[0]?.name || '',
            requiredTags,
            activityTypes,
            teacherNames,
            parameters: {
                activityTypes,
                teacherNames,
                scopeQualifier,
            },
            scope: { qualifier: scopeQualifier, activityTypes, teacherNames },
            priority: 'hard',
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const hasPreferredExperimentRoom = subjectTargets.length === 1
        && roomIds.length
        && /实验(?:课|教学|活动)/.test(rawText)
        && /(?:优先|尽量|最好|建议).{0,20}(?:实验室|实验场地|功能室)|(?:实验室|实验场地|功能室).{0,20}(?:优先|尽量|最好|建议)/.test(rawText);
    const hasTeacherExperimentOrdinaryRoomBan = teacherNames.length
        && /实验(?:课|教学|活动)/.test(rawText)
        && /(?:不要|不得|不能|不可|禁止|避免)[^，。；]{0,24}(?:普通教室|常规教室|普通课堂)|(?:普通教室|常规教室|普通课堂)[^，。；]{0,24}(?:不要|不得|不能|不可|禁止|避免)/.test(rawText);
    if (hasPreferredExperimentRoom && hasTeacherExperimentOrdinaryRoomBan) {
        const subject = subjectTargets[0];
        const activityTypes = ['实验课'];
        const preferredScopeQualifier = 'activity';
        const forbiddenScopeQualifier = 'teacher_activity';
        return [
            unsupportedSemanticConstraint({
                type: 'room_preferred',
                capabilityId: 'room.preferred',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                preferredRoomIds: roomIds,
                activityTypes,
                parameters: {
                    preferredRoomIds: roomIds,
                    activityTypes,
                    scopeQualifier: preferredScopeQualifier,
                },
                scope: { qualifier: preferredScopeQualifier, activityTypes },
                priority: 'soft',
                landing: ['clarification', 'optimization'],
                reason: rawText,
                weekPattern,
            }, sourceMeta),
            unsupportedSemanticConstraint({
                type: 'room_forbidden_type',
                capabilityId: 'room.forbidden_type',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                forbiddenRoomTypes: ['ordinary_classroom'],
                activityTypes,
                teacherNames,
                parameters: {
                    forbiddenRoomTypes: ['ordinary_classroom'],
                    activityTypes,
                    teacherNames,
                    scopeQualifier: forbiddenScopeQualifier,
                },
                scope: { qualifier: forbiddenScopeQualifier, activityTypes, teacherNames },
                priority: 'hard',
                landing: ['clarification', 'solver_policy'],
                reason: rawText,
                weekPattern,
            }, sourceMeta),
        ];
    }

    if (
        /(?:同一|各个?|每个?)备课组(?:内|内部)/.test(rawText)
        && /(?:教师|老师)/.test(rawText)
        && /(?:均衡|平衡|公平|平均).{0,20}(?:一周|五天|每天)|(?:分布).{0,20}(?:一周|五天)/.test(rawText)
    ) {
        const consecutiveFullAfternoonMatch = rawText.match(new RegExp(`连续\\s*(${NUMBER_TOKEN_PATTERN})\\s*天[^，。；]{0,12}(?:下午|午后)[^，。；]{0,8}(?:满课|排满)`));
        const forbiddenRunLength = consecutiveFullAfternoonMatch ? parseLooseNumber(consecutiveFullAfternoonMatch[1]) : null;
        const parameters = {
            comparisonScope: 'preparation_group',
            fairnessMode: 'within_group',
            distributionDays: [1, 2, 3, 4, 5],
            maxConsecutiveFullAfternoons: Number.isInteger(forbiddenRunLength) && forbiddenRunLength > 0
                ? Math.max(0, forbiddenRunLength - 1)
                : 1,
            avoidFullDayIdle: /(?:全天|整天|一整天)[^，。；]{0,8}(?:空着|没课|无课|空课)/.test(rawText),
        };
        return [unsupportedSemanticConstraint({
            type: 'prep_group_fairness',
            capabilityId: 'teacher.prep_group_fairness',
            targetType: 'teacher_group',
            target: '同一备课组内教师',
            object: {
                kind: 'teacher_group',
                name: '同一备课组内教师',
                matchedIds: [],
                scope: 'group',
            },
            parameters,
            scope: { qualifier: 'preparation_group' },
            priority: 'soft',
            landing: ['clarification', 'optimization'],
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const requiredResourceTypes = [
        ...(/实验室|实验场地/.test(rawText) ? ['lab'] : []),
        ...(/机房|计算机教室|电脑教室/.test(rawText) ? ['computer_room'] : []),
    ];
    if (
        requiredResourceTypes.length
        && periods.length
        && /(?:不要|不宜|避免|尽量不|不安排|不排)/.test(rawText)
        && /(?:需要|使用|占用|依赖).{0,16}(?:实验室|实验场地|机房|计算机教室|电脑教室)|(?:实验室|实验场地|机房|计算机教室|电脑教室).{0,12}(?:的课|课程)/.test(rawText)
    ) {
        const parameters = { requiredResourceTypes, days, periods };
        return [unsupportedSemanticConstraint({
            type: 'lesson_resource_attribute_avoid_periods',
            capabilityId: 'lesson.resource_attribute_avoid_periods',
            targetType: 'global',
            target: '需要特定教学资源的课程',
            days,
            periods,
            requiredResourceTypes,
            parameters,
            priority,
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const activityTypes = /新授课|新课|新授/.test(rawText) ? ['新授课'] : [];
    const preferredActivityTypes = ['教研', '社团', '答疑'].filter(name => rawText.includes(name));
    if (
        activityTypes.length
        && preferredActivityTypes.length
        && periods.length
        && /主科|语数英|语文.{0,12}数学.{0,12}英语/.test(rawText)
    ) {
        const mainSubjects = semanticMainSubjectTargets(project);
        const mainNames = mainSubjects.map(subject => subject.name);
        const mainIds = mainSubjects.map(subject => subject.id || subject.name);
        const parameters = {
            subjectNames: mainNames,
            subjectIds: mainIds,
            activityTypes,
            preferredActivityTypes,
            days,
            periods,
        };
        return [unsupportedSemanticConstraint({
            type: 'lesson_activity_scope_period_policy',
            capabilityId: 'lesson.activity_scope_period_policy',
            targetType: 'subject_group',
            target: mainNames.join('、'),
            subjectIds: mainIds,
            subjectNames: mainNames,
            activityTypes,
            preferredActivityTypes,
            days,
            periods,
            parameters,
            priority: 'soft',
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    if (
        subjectTargets.length >= 2
        && /(?:同一天|同日)/.test(rawText)
        && /(?:不要|不能|不可|避免|尽量不).{0,16}(?:连续|连着|相邻)|(?:连续|连着|相邻).{0,12}(?:错开|避免)/.test(rawText)
    ) {
        const parameters = { subjectNames, subjectIds, sameDay: true };
        return [unsupportedSemanticConstraint({
            type: 'subject_not_consecutive_with',
            capabilityId: 'subject.not_consecutive_with',
            targetType: 'subject_group',
            target: subjectNames.join('、'),
            subjectIds,
            subjectNames,
            sameDay: true,
            parameters,
            priority,
            reason: rawText,
            weekPattern,
        }, sourceMeta)];
    }

    const minOccurrences = minimumWeeklyOccurrencesFromText(rawText);
    if (
        gradeNames.length
        && subjectTargets.length >= 2
        && periods.length
        && minOccurrences
        && /(?:排在|安排在|放在|优先|尽量)/.test(rawText)
    ) {
        const avoidDayParts = /(?:不要|避免|不宜|尽量不).{0,16}(?:下午|午后)|(?:下午|午后).{0,12}(?:不要|避免|不集中)/.test(rawText)
            ? ['afternoon']
            : [];
        return subjectTargets.map(subject => {
            const parameters = { gradeNames, days, periods, minOccurrences, avoidDayParts };
            return unsupportedSemanticConstraint({
                type: 'subject_preferred_periods',
                capabilityId: 'subject.preferred_periods',
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                gradeNames,
                days,
                periods,
                minOccurrences,
                avoidDayParts,
                parameters,
                scope: { gradeNames },
                priority: 'soft',
                reason: rawText,
                weekPattern,
            }, sourceMeta);
        });
    }

    if (
        gradeNames.length
        && subjectTargets.length >= 2
        && periods.length
        && /(?:不要排|不排|别排|避免|不宜|尽量不排|优先|尽量安排|最好安排)/.test(rawText)
    ) {
        const avoid = /(?:不要排|不排|别排|避免|不宜|尽量不排)/.test(rawText);
        const type = avoid ? 'subject_avoid_periods' : 'subject_preferred_periods';
        const capabilityId = avoid ? 'subject.avoid_periods' : 'subject.preferred_periods';
        return subjectTargets.map(subject => {
            const parameters = { gradeNames, days, periods };
            return unsupportedSemanticConstraint({
                type,
                capabilityId,
                targetType: 'subject',
                targetId: subject.id,
                target: subject.name,
                subjectId: subject.id,
                subjectName: subject.name,
                gradeNames,
                days,
                periods,
                parameters,
                scope: { gradeNames },
                priority,
                reason: rawText,
                weekPattern,
            }, sourceMeta);
        });
    }

    return [];
}

function slotSetIsSubset(left = [], right = []) {
    if (!left.length || !right.length || left.length >= right.length) return false;
    const rightSet = new Set(right);
    return left.every(slot => rightSet.has(slot));
}

function compactLocalConstraints(constraints = []) {
    const kept = [];
    for (const item of constraints) {
        if (item.type === 'subject_preferred_periods' && (item.slots || []).length) {
            const keyFor = value => JSON.stringify([
                value.type,
                value.targetId || '',
                value.target || '',
                value.sourceSheet || '',
                value.sourceRow || '',
                value.weekPattern || '',
            ]);
            const key = keyFor(item);
            const existingIndex = kept.findIndex(value => keyFor(value) === key);
            if (existingIndex >= 0) {
                const existing = kept[existingIndex];
                if (slotSetIsSubset(item.slots || [], existing.slots || [])) {
                    kept[existingIndex] = item;
                    continue;
                }
                if (slotSetIsSubset(existing.slots || [], item.slots || [])) continue;
            }
        }
        kept.push(item);
    }
    const seen = new Set();
    return kept.filter(item => {
        const key = JSON.stringify([item.type, item.targetId, item.target, item.slots || [], item.limit ?? null, item.sourceSheet || '', item.sourceRow || '', item.weekPattern || '']);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function crossVenueBoundaryPeriods(project, text = '') {
    const normalizedText = asText(text, 1500);
    if (
        !/(跨场地|场地转移|转场)/.test(normalizedText)
        || !/(之间|连续课程|连续排课|连堂)/.test(normalizedText)
    ) {
        return [];
    }
    const periods = parsePeriods(normalizedText, project, []);
    return periods.length >= 2 ? periods.slice(0, 2) : [];
}

function updateLocalContextFromPreciseConstraints(context = {}, project = {}, sentence = '', rawSentence = '', preciseConstraints = []) {
    const teacherTargets = textTeacherTargets(sentence, project);
    const classTargets = textClassTargets(sentence, project);
    const subjectTargets = textSubjectTargets(sentence, project, { allowHeuristic: false });
    const roomTargets = textRoomTargets(sentence, project);
    if (teacherTargets.length) {
        context.teacherTargets = teacherTargets;
        appendContextHistory(context, 'teacher', teacherTargets);
    }
    if (classTargets.length) {
        context.classTargets = classTargets;
        appendContextHistory(context, 'class', classTargets);
    }
    if (subjectTargets.length) {
        context.subjectTargets = subjectTargets;
        appendContextHistory(context, 'subject', subjectTargets);
    }
    if (roomTargets.length) {
        const matchedRooms = roomTargets.filter(room => room.id);
        context.roomTargets = matchedRooms.length ? matchedRooms : roomTargets;
    }
    const timeSpec = parseTimeSpec(sentence, project);
    if (timeSpec.days.length) context.days = timeSpec.days;
    if (timeSpec.periods.length) context.periods = timeSpec.periods;
    if (timeSpec.slots.length) context.slots = timeSpec.slots;
    if (dayPartName(sentence)) context.dayPart = dayPartName(sentence);
    if (timeSpec.weekPattern) context.weekPattern = timeSpec.weekPattern;
    const types = preciseConstraints.map(item => item?.type || item?.intent).filter(Boolean);
    if (types.length) context.lastConstraintType = types.at(-1);
    if (types.some(type => /unavailable|avoid_periods|fixed_activity/.test(type))
        || (classTargets.length && /(?:班会|活动)/.test(sentence))) context.unavailable = true;
    if (types.some(type => /preferred|morning|afternoon/.test(type))) context.prefer = true;
    if (types.some(type => /avoid/.test(type))) context.avoid = true;
    if (teacherTargets.length || classTargets.length || subjectTargets.length || timeSpec.days.length || timeSpec.periods.length || types.length) {
        context.rawText = rawSentence || sentence;
    }
}

function categorizedMarketFallbackConstraints(project = {}, text = '', sourceMeta = {}, existing = []) {
    const value = asText(text, 1500);
    const result = [...existing];
    const has = type => result.some(item => (item.intent || item.type) === type);
    const add = (type, item = {}) => {
        result.push(withSource({
            type,
            intent: item.intent || type,
            reason: value,
            confidence: item.confidence ?? 0.9,
            ...item,
        }, sourceMeta));
    };
    const addClarification = (type, item = {}, question = '请补充约束对象、时段或执行范围。') => {
        result.push(clarificationSemanticConstraint({
            type,
            intent: item.intent || type,
            reason: value,
            clarifications: [question],
            ...item,
        }, sourceMeta));
    };
    const teachers = textTeacherTargets(value, project);
    const subjects = textSubjectTargets(value, project, { allowHeuristic: false });
    const subjectByName = name => (project.subjects || []).find(subject => subject.name === name)
        || { id: '', name };
    const expandSubjects = (names = []) => uniqueTargets(names.map(subjectByName));
    const marketSubjects = (() => {
        const expanded = [...subjects];
        if (/物化生/.test(value)) expanded.push(...expandSubjects(['物理', '化学', '生物']));
        if (/音体美信/.test(value)) expanded.push(...expandSubjects(['音乐', '体育', '美术', '信息技术']));
        const unique = uniqueTargets(expanded);
        return /(?:物化生|物理、化学、生物)/.test(value) && unique.length > 1
            ? unique.filter(subject => subject.name !== '实验课')
            : unique;
    })();
    const timeSpec = parseTimeSpec(value, project);
    const dayPart = dayPartName(value);
    const dayPartPeriods = dayPart ? getDayPartPeriods(project, dayPart) : [];
    const days = timeSpec.days || [];
    const periods = timeSpec.periods?.length ? timeSpec.periods : dayPartPeriods;
    const slotDays = days.length ? days : getActiveWeekdays(project);
    const slots = periods.length ? slotDays.flatMap(day => periods.map(period => slotKey(day, period))) : [];
    const subjectFields = targets => ({
        targetType: targets.length > 1 ? 'subject_group' : 'subject',
        targetId: targets.length === 1 ? targets[0]?.id || '' : '',
        target: targets.map(item => item.name).join('、'),
        subjectId: targets[0]?.id || '',
        subjectName: targets[0]?.name || '',
        subjectIds: targets.map(item => item.id || item.name),
        subjectNames: targets.map(item => item.name),
    });

    if (!has('teacher_unavailable') && teachers.length
        && /(?:先空着|空着|别给.{0,12}(?:塞|排)课|不要太早上课|那几天不方便上课)/.test(value)) {
        const vague = !days.length || (!periods.length && !dayPart);
        const item = {
            targetType: 'teacher', targetId: teachers[0].id || '', target: teachers[0].name,
            teacherId: teachers[0].id || '', teacherName: teachers[0].name,
            days, periods, slots, priority: 'hard',
        };
        if (vague) addClarification('teacher_unavailable', item, '请明确教师不能上课的具体日期和节次。');
        else add('teacher_unavailable', item);
    }

    if (!has('teacher_daily_limit') && /(?:每天|每日|一天).{0,16}(?:最多|顶多|不要超过|不超过|至多).{0,6}[一二两三四五六七八九十\d]+(?:节|堂|课)/.test(value)) {
        const limit = constraintLimitFromText('teacher_daily_limit', value);
        const targets = teachers.length ? teachers : [{ id: '__all_teachers', name: '全部教师' }];
        targets.forEach(teacher => add('teacher_daily_limit', {
            targetType: 'teacher', targetId: teacher.id || '', target: teacher.name,
            teacherId: teacher.id || '', teacherName: teacher.name,
            limit, parameters: { limit }, priority: 'soft',
        }));
    }
    if (!has('teacher_consecutive_limit') && !has('cross_venue_boundary') && !has('block_preference')
        && !/高负载教师/.test(value)
        && !/(?:物化生|物理、化学、生物|实验课).*(?:连排两节|大连堂)/.test(value)
        && /(?:连轴转|连续|连堂|连排|排太密)/.test(value)) {
        const limit = teacherConsecutiveLimitFromText(value)
            || constraintLimitFromText('teacher_consecutive_limit', value)
            || parseLooseNumber(value.match(new RegExp(`最多连\s*(${NUMBER_TOKEN_PATTERN})\s*(?:节|堂|课)`))?.[1]);
        const targets = teachers.length ? teachers : [{ id: '__all_teachers', name: '全部教师' }];
        targets.forEach(teacher => {
            const item = {
                targetType: 'teacher', targetId: teacher.id || '', target: teacher.name,
                teacherId: teacher.id || '', teacherName: teacher.name,
                ...(limit ? { limit, parameters: { limit } } : {}), priority: 'soft',
            };
            if (limit) add('teacher_consecutive_limit', item);
            else addClarification('teacher_consecutive_limit', item, '请明确“排太密”允许的最大连续课节数。');
        });
    }
    if (!has('teacher_max_days_per_week') && /(?:这周|本周|每周|一周).{0,20}(?:只来|只能来|最多来|不超过).{0,6}[一二两三四五六七八九十\d]+天/.test(value)) {
        const limit = constraintLimitFromText('teacher_max_days_per_week', value)
            || parseLooseNumber(value.match(new RegExp(`(?:只来|只能来|最多来|不超过)\s*(${NUMBER_TOKEN_PATTERN})\s*天`))?.[1]);
        const targets = teachers.length ? teachers : [{ id: '', name: '教师组' }];
        targets.forEach(teacher => add('teacher_max_days_per_week', {
            targetType: 'teacher', targetId: teacher.id || '', target: teacher.name,
            teacherId: teacher.id || '', teacherName: teacher.name,
            limit, parameters: { limit }, priority: 'hard',
        }));
    }
    if (!has('teacher_avoid_periods') && /班主任.{0,12}(?:头节|首节|第一节).{0,12}(?:少排|别排|不要排)/.test(value)) {
        addClarification('teacher_avoid_periods', {
            targetType: 'derived_group', target: '班主任', periods: [1],
            slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft', activity: '早读',
        }, '请确认班主任角色组包含的教师范围。');
    }

    if (!has('subject_avoid_periods') && marketSubjects.length
        && /(?:收尾那节|最后一节|末节)/.test(value)
        && /(?:别|不要|避免|避开)/.test(value)
        && !/^除.+外.+(?:其他课|其余课)/.test(value)) {
        const lastPeriod = Math.max(...getActivePeriods(project));
        add('subject_avoid_periods', {
            ...subjectFields(marketSubjects), intent: 'avoid_last_period', periods: [lastPeriod],
            slots: getActiveWeekdays(project).map(day => slotKey(day, lastPeriod)), priority: 'soft',
        });
    }
    if (!has('subject_preferred_periods') && marketSubjects.length && /(?:第二三节|第?2[、,，]?3节).*(?:优先|安排)/.test(value)) {
        add('subject_preferred_periods', {
            ...subjectFields(marketSubjects), periods: [2, 3],
            slots: getActiveWeekdays(project).flatMap(day => [slotKey(day, 2), slotKey(day, 3)]), priority: 'soft',
        });
    }
    if (!has('course_interval') && marketSubjects.length >= 2 && /(?:岔开|隔开|间隔).{0,8}(?:一|1)天/.test(value)) {
        add('course_interval', {
            ...subjectFields(marketSubjects), minGapDays: 1,
            parameters: { minGapDays: 1 }, priority: 'soft',
        });
    }

    if (!has('unknown') && /(?:课程|主科).{0,12}(?:排得好看|排舒服|舒服点)/.test(value)) {
        addClarification('unknown', { targetType: 'subject_group', target: /主科/.test(value) ? '主科' : '课程', priority: 'soft' }, '请说明“好看/舒服”具体指均衡、集中、少空堂还是时段偏好。');
    }

    if (!has('global_unavailable') && /晨会/.test(value) && /全校.*(?:不排|停排)/.test(value)) {
        add('global_unavailable', { targetType: 'global', target: '全校', days, periods: timeSpec.periods, slots: timeSpec.slots, priority: 'hard', activity: '晨会' });
    }
    if (!has('global_unavailable') && /大课间/.test(value) && /(?:做操|不占|不排)/.test(value)) {
        addClarification('global_unavailable', { targetType: 'global', target: '全校', days, priority: 'hard', activity: '大课间' }, '请补充大课间对应的具体节次。');
    }
    if (!has('global_unavailable') && /眼保健操/.test(value) && /(?:不排|不占)/.test(value)) {
        addClarification('global_unavailable', { targetType: 'global', target: '全校', priority: 'hard', activity: '眼保健操' }, '请补充眼保健操对应的具体节次。');
    }

    const gradeNames = gradeNamesFromText(value);
    if (!has('class_unavailable') && gradeNames.length && /校本课/.test(value) && /统一占用/.test(value)) {
        add('class_unavailable', { targetType: 'grade', target: gradeNames[0], gradeNames, days, periods: timeSpec.periods, slots: timeSpec.slots, priority: 'hard', activity: '校本课' });
    }
    if (!has('class_unavailable') && gradeNames.length && /周测/.test(value) && /(?:停排|不排)/.test(value)) {
        add('class_unavailable', { targetType: 'grade', target: gradeNames[0], gradeNames, days, periods, slots, priority: 'hard', activity: '周测' });
    }

    if (!has('teaching_group_meeting') && /(?:备课组|教研组|学科组|[语数英物化生政史地体音美信劳]组).{0,20}(?:集备|集体备课|教研|开会)/.test(value)) {
        const groupName = value.match(/([\u4e00-\u9fa5]{1,8}(?:备课组|教研组|学科组)|[语数英物化生政史地体音美信劳]组)/)?.[1] || '';
        add('teaching_group_meeting', { targetType: 'teaching_group', target: groupName, targetName: groupName, days, periods, slots, dayPart, priority: 'hard', activity: /集备|集体备课/.test(value) ? '集备' : '教研' });
    }
    if (!has('teaching_group_session') && /走班课?.*(?:同开|同一节|同一时间)/.test(value)) {
        addClarification('teaching_group_session', { targetType: 'teaching_group', target: '走班课', priority: 'hard', activity: '走班课' }, '请明确参与同步开课的行政班、课程和教师。');
    }
    if (!has('teaching_group_session') && /双师课.*(?:同时到班|共同到班)/.test(value)) {
        addClarification('teaching_group_session', { targetType: 'teaching_group', target: '双师课', priority: 'hard', activity: '双师课' }, '请明确双师课涉及的课程、班级和两位教师。');
    }

    if (!has('locked_slot') && /社团课.*(?:统一放|固定).*(?:最后两节|末两节)/.test(value)) {
        const activePeriods = getActivePeriods(project);
        const lastTwo = activePeriods.slice(-2);
        addClarification('locked_slot', {
            targetType: 'subject', target: '社团课', subjectName: '社团课', days,
            periods: lastTwo, slots: days.flatMap(day => lastTwo.map(period => slotKey(day, period))), priority: 'hard', activity: '社团课',
        }, '请确认社团课对应的班级、教师和具体课程。');
    }
    if (!has('first_period_assign') && /早读.*(?:语文|英语).*(?:轮流|轮换).*(?:第一节|首节)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects(['语文', '英语']);
        addClarification('first_period_assign', { ...subjectFields(targets), periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'hard', activity: '早读' }, '请明确语文和英语早读的具体轮换日期。');
    }
    if (!has('lunch_protection') && /午间管理/.test(value)) {
        addClarification('lunch_protection', { targetType: 'global', target: '全校', priority: 'hard', activity: '午间管理' }, '请补充午间管理对应的具体节次。');
    }
    if (!has('block_preference') && /(?:物化生|实验课).*(?:连排两节|大连堂)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects(['物理', '化学', '生物']);
        add('block_preference', { ...subjectFields(targets), blockPreference: 'double', limit: 2, parameters: { blockSize: 2 }, priority: 'soft' });
    }
    if (!has('subject_avoid_periods') && /音体美信.*(?:别占|不占|避开).*黄金/.test(value)) {
        const targets = expandSubjects(['音乐', '体育', '美术', '信息技术']);
        addClarification('subject_avoid_periods', { ...subjectFields(targets), priority: 'soft' }, '请确认“黄金段”在当前作息中对应的具体节次。');
    }
    if (!result.some(item => (item.intent || item.type) === 'teacher_unavailable' && item.targetType === 'derived_group')
        && /班主任会/.test(value) && /(?:全体|所有)?班主任.*(?:避开|不排)/.test(value)) {
        addClarification('teacher_unavailable', { targetType: 'derived_group', target: '班主任', days, periods, slots, priority: 'hard', activity: '班主任会' }, '请确认班会课对应的具体节次，以及班主任角色组成员。');
    }

    const classes = textClassTargets(value, project);
    if (!has('class_unavailable') && classes.length
        && !/班主任会/.test(value)
        && /(?:社团活动|考试|班会|年级会|集体活动)/.test(value)
        && /(?:不排|停排|占用|活动|考试|班会)/.test(value)) {
        classes.forEach(klass => add('class_unavailable', {
            targetType: 'class', targetId: klass.id || '', target: klass.name,
            classId: klass.id || '', className: klass.name,
            days, periods, slots, priority: 'hard',
            activity: value.match(/社团活动|考试|班会|年级会|集体活动/)?.[0] || '',
        }));
    }

    if (!has('global_unavailable') && /全校/.test(value)
        && /(?:早读|社团|教研|大扫除|活动)/.test(value)
        && /(?:不排|停排|腾出来|大扫除|教研)/.test(value)) {
        add('global_unavailable', {
            targetType: 'global', target: '全校', days, periods, slots,
            priority: 'hard', activity: value.match(/早读|社团|教研|大扫除|活动/)?.[0] || '',
        });
    }
    if (!has('lunch_protection') && /(?:午休前后|午饭前后|中午最后一节.*下午第一节|午间)/.test(value)
        && /(?:保护|不要连排|不要压得太紧|不排)/.test(value)) {
        const item = { targetType: 'global', target: '全校', priority: 'soft', activity: /午间/.test(value) ? '午间管理' : '午休' };
        if (periods.length) add('lunch_protection', { ...item, days, periods, slots });
        else addClarification('lunch_protection', item, '请明确午休或午间管理边界对应的具体节次。');
    }

    const teachingGroupMatch = value.match(/([\u4e00-\u9fa5]{1,8}?)(?:备课组|教研组|学科组)|((?:语文|数学|英语|物理|化学|生物|历史|地理|道法|政治|体育|音乐|美术|信息技术|信息|劳动)组)/);
    if (!has('teaching_group_meeting') && teachingGroupMatch
        && /(?:集备|集体备课|集体教研|教研|开会|会议)/.test(value)) {
        const fullName = teachingGroupMatch[0];
        const baseName = teachingGroupMatch[1] || fullName.replace(/组$/, '');
        add('teaching_group_meeting', {
            targetType: 'teaching_group', target: baseName,
            targetName: baseName, subjectNames: [baseName, fullName],
            days, periods, slots, dayPart, priority: 'hard',
            activity: /集备|集体备课/.test(value) ? '集备' : '教研',
        });
    }
    if (!has('teacher_unavailable') && teachingGroupMatch
        && /(?:相关|组内|该组).{0,8}(?:老师|教师)|(?:课程|课).{0,8}(?:不要排|不排).{0,8}(?:这个|该)时间/.test(value)) {
        addClarification('teacher_unavailable', {
            targetType: 'derived_group', target: teachingGroupMatch[0],
            days, periods, slots, priority: 'hard', activity: /集备|集体备课/.test(value) ? '集备' : '教研',
        }, '请确认该备课组包含的教师范围。');
    }

    if (!has('locked_slot') && /(?:固定|锁定|统一放)/.test(value)
        && (timeSpec.periods.length || /最后两节|末两节/.test(value))) {
        const fixedPeriods = timeSpec.periods.length ? timeSpec.periods : getActivePeriods(project).slice(-2);
        const fixedSlots = days.length ? days.flatMap(day => fixedPeriods.map(period => slotKey(day, period))) : [];
        const target = classes[0]?.name || marketSubjects[0]?.name || value.match(/班会|社团课|校会/)?.[0] || '固定活动';
        const item = {
            targetType: classes.length ? 'class' : marketSubjects.length ? 'subject' : 'global',
            targetId: classes[0]?.id || marketSubjects[0]?.id || '', target,
            classId: classes[0]?.id || '', className: classes[0]?.name || '',
            subjectId: marketSubjects[0]?.id || '', subjectName: marketSubjects[0]?.name || '',
            days, periods: fixedPeriods, slots: fixedSlots, priority: 'hard', activity: value.match(/班会|社团课|校会/)?.[0] || '',
        };
        if (classes.length || marketSubjects.length) add('locked_slot', item);
        else addClarification('locked_slot', item, '请明确固定活动对应的班级、课程和教师。');
    }
    if (!has('first_period_assign') && marketSubjects.length
        && /(?:早读.*(?:第1节|第一节)|(?:首节|第一节).*(?:固定|早读))/.test(value)) {
        add('first_period_assign', {
            ...subjectFields(marketSubjects), days, periods: [1],
            slots: (days.length ? days : getActiveWeekdays(project)).map(day => slotKey(day, 1)),
            priority: 'hard', activity: /早读/.test(value) ? '早读' : '',
        });
    }

    const afternoonSegment = value.match(/([^，,。；;]*?(?:体育|音乐|美术|信息技术|信息|劳动)[^，,。；;]*?)(?:尽量|优先|最好|放到|安排到|排到)?下午/);
    if (!has('subject_afternoon') && afternoonSegment) {
        const targets = textSubjectTargets(afternoonSegment[0], project, { allowHeuristic: false });
        if (targets.length) targets.forEach(subject => add('subject_afternoon', {
            ...subjectFields([subject]), dayPart: 'afternoon', periods: getDayPartPeriods(project, 'afternoon'),
            slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'afternoon').map(period => slotKey(day, period))), priority: 'soft',
        }));
    }
    const morningSegment = value.match(/([^，,。；;]*?(?:语文|数学|英语|物理|化学|生物|主科)[^，,。；;]*?)(?:尽量|优先|最好|安排到|排到)?上午/);
    if (!has('subject_morning') && morningSegment && !hasExplicitPeriodExpression(value)) {
        const targets = textSubjectTargets(morningSegment[0], project, { allowHeuristic: false });
        if (targets.length) targets.forEach(subject => add('subject_morning', {
            ...subjectFields([subject]), dayPart: 'morning', periods: getDayPartPeriods(project, 'morning'),
            slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'morning').map(period => slotKey(day, period))), priority: 'soft',
        }));
    }

    if (!has('subject_daily_limit') && marketSubjects.length
        && /(?:每天|每日|一天|同一个班一天).{0,20}(?:最多|不要上超过|不超过).{0,6}[一二两三四五六七八九十\d]+(?:节|堂|课)/.test(value)) {
        const limit = constraintLimitFromText('subject_daily_limit', value)
            || parseLooseNumber(value.match(new RegExp(`(?:最多|不要上超过|不超过)\s*(${NUMBER_TOKEN_PATTERN})\s*(?:节|堂|课)`))?.[1]);
        marketSubjects.forEach(subject => add('subject_daily_limit', { ...subjectFields([subject]), limit, parameters: { limit }, priority: 'hard' }));
    }
    if (!has('teacher_daily_limit')
        && /(?:每位|所有|全部)?老师.*(?:每天|一天).*(?:最多|顶多|不超过)/.test(value)) {
        const limit = constraintLimitFromText('teacher_daily_limit', value);
        add('teacher_daily_limit', { targetType: 'teacher', target: '全部教师', limit, parameters: { limit }, priority: 'soft' });
    }
    if (!has('teacher_consecutive_limit')
        && /老师.*(?:连续|连堂|连排).*(?:最多|不超过)/.test(value)) {
        const limit = teacherConsecutiveLimitFromText(value) || constraintLimitFromText('teacher_consecutive_limit', value);
        add('teacher_consecutive_limit', { targetType: 'teacher', target: '全部教师', limit, parameters: { limit }, priority: 'soft' });
    }
    if (!has('teacher_weekly_limit') && /(?:高负载|兼职|任课)?老师.*(?:每周|一周).*(?:最多|不要超过|不超过).*[一二两三四五六七八九十\d]+(?:节|课时)/.test(value)) {
        const limit = constraintLimitFromText('teacher_weekly_limit', value);
        add('teacher_weekly_limit', { targetType: teachers.length ? 'teacher' : 'derived_group', target: teachers[0]?.name || '教师组', limit, parameters: { limit }, priority: 'hard' });
    }

    if (!has('teacher_mutual_exclusion') && (teachers.length >= 2 || /跨校老师|跨校区老师/.test(value))
        && /(?:不能同一节|不能同时|错峰|尽量错开)/.test(value)) {
        add('teacher_mutual_exclusion', {
            targetType: 'teacher', target: teachers.map(item => item.name).join('、') || '跨校教师',
            teacherIds: teachers.map(item => item.id || item.name), teacherNames: teachers.map(item => item.name),
            priority: 'hard',
        });
    }
    if (!has('subject_spread') && marketSubjects.length
        && /(?:不要连着几天|别连着几天|分散|摊开|别扎堆)/.test(value)) {
        marketSubjects.forEach(subject => add('subject_spread', { ...subjectFields([subject]), priority: 'soft' }));
    }
    if (!has('class_daily_balance') && /(?:每个班|班级|主科).*(?:不要堆太多|别太集中|每天.*均衡)/.test(value)) {
        const item = { targetType: 'global', target: '全部班级', priority: 'soft' };
        if (/太集中/.test(value)) addClarification('class_daily_balance', item, '请明确主科每天允许的数量或期望均衡方式。');
        else add('class_daily_balance', item);
    }
    if (!has('teacher_gap_preference') && /(?:教师|老师).*(?:连贯|空档|一会儿有课一会儿没课)/.test(value)) {
        add('teacher_gap_preference', { targetType: 'global', target: '全部教师', priority: 'soft' });
    }
    if (!has('teacher_load_balance') && /(?:老师别太累|工作量.*均衡|整体负载.*公平)/.test(value)) {
        const item = { targetType: 'global', target: '全部教师', priority: 'soft' };
        if (/别太累/.test(value)) addClarification('teacher_load_balance', item, '请明确“别太累”对应日课量、连续课、空堂还是周负载指标。');
        else add('teacher_load_balance', item);
    }
    if (!result.some(item => (item.intent || item.type) === 'subject_not_same_day' && item.targetType === 'subject')
        && marketSubjects.length >= 2 && /(?:不要排在同一天|别放同一天|错峰|错开|别撞一天)/.test(value)) {
        add('subject_not_same_day', { ...subjectFields(marketSubjects), priority: 'hard' });
    }
    if (!has('subject_not_same_day') && /这几门课.*错开/.test(value)) {
        addClarification('subject_not_same_day', { targetType: 'subject', target: '这几门课', priority: 'soft' }, '请明确“这几门课”具体包含哪些课程，以及错开到不同天还是不同节。');
    }
    if (!result.some(item => (item.intent || item.type) === 'subject_sequence' && item.targetType === 'subject')
        && /(?:先.*再|先.*后|之后)/.test(value)) {
        const targets = marketSubjects.length >= 2 ? marketSubjects
            : /理论.*实验/.test(value) ? expandSubjects(['理论课', '实验课']) : [];
        if (targets.length >= 2) add('subject_sequence', {
            ...subjectFields(targets), beforeSubjectId: targets[0].id || targets[0].name,
            afterSubjectId: targets[1].id || targets[1].name, priority: 'soft',
        });
    }

    if (!has('block_preference') && /(?:作文课|课程|实验课).*(?:两节连上|连堂|连排两节)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects([value.match(/[\u4e00-\u9fa5]{1,8}课/)?.[0] || '课程']);
        add('block_preference', { ...subjectFields(targets), limit: 2, blockPreference: 'double', parameters: { blockSize: 2 }, priority: 'soft' });
    }
    if (!has('week_pattern') && /(?:单双周|单周|双周)/.test(value)) {
        addClarification('week_pattern', { ...subjectFields(marketSubjects), weekPattern: /只在单周|单周上/.test(value) ? 'odd' : /只在双周|双周上/.test(value) ? 'even' : 'alternating', priority: 'hard' }, '请确认单双周课程对应的班级、教师和课时安排。');
    }
    if (!has('campus_commute_gap') && /(?:跨校区|校区).*(?:通勤|留出|至少隔一节)/.test(value)) {
        addClarification('campus_commute_gap', { targetType: 'teacher', target: teachers.map(item => item.name).join('、') || '跨校区教师', priority: 'hard' }, '请明确涉及的校区、教师及最小通勤间隔。');
    }
    if (!has('teaching_group_session') && /(?:合班|一起上|大课)/.test(value) && marketSubjects.length) {
        addClarification('teaching_group_session', { ...subjectFields(marketSubjects), targetType: 'teaching_group', priority: 'hard' }, '请明确参加合班课程的班级、教师和课程。');
    }
    if (!has('room_requirement') && !has('subject_avoid_periods')
        && /(?:实验室|机房|功能室).*(?:维修|维护|检修)/.test(value)
        && /实验课.*(?:避开|不排)/.test(value)) {
        const targets = marketSubjects.length ? marketSubjects : expandSubjects(['实验课']);
        addClarification('room_requirement', { ...subjectFields(targets), roomName: '实验室', parameters: { roomName: '实验室' }, priority: 'hard', activity: '实验室维修' }, '请明确维修影响的实验室和具体时段。');
        addClarification('subject_avoid_periods', { ...subjectFields(targets), days, priority: 'soft', activity: '实验室维修' }, '请明确实验课需要避开的具体节次。');
    }
    if (!has('teacher_avoid_periods') && /班主任.*(?:第一节|首节).*(?:不要有课|少排|别排)/.test(value)) {
        addClarification('teacher_avoid_periods', { targetType: 'derived_group', target: '班主任', periods: [1], slots: getActiveWeekdays(project).map(day => slotKey(day, 1)), priority: 'soft', activity: '晨检' }, '请确认班主任角色组包含的教师范围。');
    }

    const canonicalTargetKinds = new Map([
        ['teacher_daily_limit', 'teacher'],
        ['teacher_consecutive_limit', 'teacher'],
        ['teacher_mutual_exclusion', 'teacher'],
        ['subject_not_same_day', 'subject'],
        ['subject_sequence', 'subject'],
    ]);
    result.forEach(item => {
        const expectedKind = canonicalTargetKinds.get(item.intent || item.type);
        if (expectedKind) item.targetType = expectedKind;
        if ((item.intent || item.type) === 'subject_sequence' && marketSubjects.length >= 2) {
            item.target = marketSubjects.map(subject => subject.name).join('、');
            item.subjectIds = marketSubjects.map(subject => subject.id || subject.name);
            item.subjectNames = marketSubjects.map(subject => subject.name);
            item.beforeSubjectId = marketSubjects[0].id || marketSubjects[0].name;
            item.afterSubjectId = marketSubjects[1].id || marketSubjects[1].name;
        }
    });

    return result;
}

function localTextConstraints(project, text, sourceMeta = {}) {
    const constraints = [];
    const normalized = parserShadowTextWithTrace(text);
    const sentences = splitSentences(normalized.text);
    const rawSentences = splitSentences(text);
    const tracedSourceMeta = { ...sourceMeta, normalizationTrace: normalized.trace };
    const preferPattern = /(优先|尽量|prefer|preferred|安排到|可以(?:排|安排)?|适合)/i;
    const avoidPattern = /(避开|不要|不排|别(?:老)?(?:排|压|放|塞|搁)|avoid)/i;
    const context = {
        teacherTargets: [], classTargets: [], subjectTargets: [], roomTargets: [],
        teacherHistory: [], classHistory: [], subjectHistory: [],
        prefer: false, avoid: false, unavailable: false,
        days: [], periods: [], slots: [], dayPart: '', rawText: '', weekPattern: '', lastConstraintType: '',
    };

    for (const [sentenceGroupIndex, sentenceGroup] of sentences.entries()) {
        const rawSentenceGroup = rawSentences[sentenceGroupIndex] || sentenceGroup;
        const preciseConstraints = preciseSemanticConstraintsFromText(project, sentenceGroup, tracedSourceMeta);
        if (preciseConstraints.length) {
            constraints.push(...preciseConstraints);
            updateLocalContextFromPreciseConstraints(context, project, sentenceGroup, rawSentenceGroup, preciseConstraints);
            continue;
        }
        const parsedClauses = splitClauses(sentenceGroup);
        const rawClauses = splitClauses(rawSentenceGroup);

        for (const [clauseIndex, sentence] of parsedClauses.entries()) {
            const sourceSentence = rawClauses[clauseIndex] || sentence;
            const timeSpec = parseTimeSpec(sentence, project);
            const teacherTargets = textTeacherTargets(sentence, project);
            const classTargets = textClassTargets(sentence, project);
            const explicitSubjectTargets = textSubjectTargets(sentence, project, { allowHeuristic: false });
            const reference = contextReferenceResolution(sentence, context);
            const hasExplicitTarget = Boolean(teacherTargets.length || classTargets.length || explicitSubjectTargets.length);
            const continuation = isContinuationClause(sentence, context, { hasExplicitTarget });
            const refersToPreviousTime = reference.kind === 'time'
                || /^(?:这|该|此|上述)(?:一?节|个?(?:时间|时段))/.test(sentence)
                || /(?:这个要求|也一样|也同样|照这个要求|同一(?:时间|时段))/.test(sentence);
            const inheritsPredicateTime = continuation
                && context.slots.length > 0
                && (
                    hasUnavailableExpression(sentence)
                    || (context.avoid && /(?:不要|别|避开)/.test(sentence))
                    || (context.prefer && /(?:优先|尽量|最好|可以)/.test(sentence))
                )
                && !hasExplicitDayExpression(sentence)
                && !hasExplicitPeriodExpression(sentence)
                && !dayPartName(sentence);
            const inheritsPreviousTime = refersToPreviousTime || inheritsPredicateTime;
            const inheritWholeTime = inheritsPreviousTime
                && !hasExplicitDayExpression(sentence)
                && !hasExplicitPeriodExpression(sentence)
                && !dayPartName(sentence);
            const currentDays = inheritWholeTime ? [] : timeSpec.days;
            const currentPeriods = inheritWholeTime ? [] : timeSpec.periods;
            const inheritedDays = !currentDays.length
                && currentPeriods.length
                && (continuation || reference.kind)
                ? asList(context.days)
                : [];
            const effectiveDays = currentDays.length ? currentDays : inheritedDays;
            const parsedSlots = currentPeriods.length
                ? (effectiveDays.length ? effectiveDays : getActiveWeekdays(project))
                    .flatMap(day => currentPeriods.map(period => slotKey(day, period)))
                : [];
            const slots = parsedSlots.length ? parsedSlots : inheritsPreviousTime ? context.slots : [];
            const roomTargets = textRoomTargets(sentence, project);
            const matchedRoomTargets = roomTargets.filter(room => room.id);
            const explicitRoomTargets = matchedRoomTargets.length ? matchedRoomTargets : roomTargets;
            const effectiveRoomTargets = explicitRoomTargets.length
                ? explicitRoomTargets
                : continuation && context.lastConstraintType === 'room_requirement'
                    ? context.roomTargets
                    : [];
            let subjectTargets = explicitSubjectTargets.length
                ? explicitSubjectTargets
                : reference.kind === 'subject' && !reference.ambiguous
                    ? reference.targets
                    : continuation && !hasExplicitTarget
                        ? context.subjectTargets
                        : textSubjectTargets(sentence, project, {
                            allowHeuristic: teacherTargets.length === 0
                                && classTargets.length === 0
                                && !/(?:全校|全部|所有|统一|全体)/.test(sentence),
                        });
            if (hasMainSubjectShorthand(sentence)) subjectTargets = mainSubjectTargets(project);
            const effectiveTeacherTargets = teacherTargets.length
                ? teacherTargets
                : reference.kind === 'teacher' && !reference.ambiguous
                    ? reference.targets
                    : continuation && reference.kind !== 'class' && reference.kind !== 'subject'
                        ? context.teacherTargets : [];
            const effectiveClassTargets = classTargets.length
                ? classTargets
                : reference.kind === 'class' && !reference.ambiguous
                    ? reference.targets
                    : continuation && reference.kind !== 'teacher' && reference.kind !== 'subject'
                        ? context.classTargets : [];
            const effectiveSubjectTargets = subjectTargets.length
                ? subjectTargets
                : continuation && reference.kind !== 'teacher' && reference.kind !== 'class'
                    ? context.subjectTargets : [];

            if (reference.ambiguous && reference.kind && reference.kind !== 'time') {
                const ambiguousType = reference.kind === 'teacher' ? 'teacher_unavailable'
                    : reference.kind === 'class' ? 'class_unavailable' : 'subject_avoid_periods';
                constraints.push(clarificationSemanticConstraint({
                    type: ambiguousType,
                    capabilityId: reference.kind === 'teacher' ? 'teacher.unavailable'
                        : reference.kind === 'class' ? 'class.unavailable' : 'subject.avoid_periods',
                    targetType: reference.kind,
                    days: timeSpec.days, periods: timeSpec.periods, slots: parsedSlots,
                    priority: 'hard', reason: sourceSentence,
                    clarifications: [`“${sentence.match(/^(?:他|她|其|该老师|这位老师|前一位|后一位|这个班|该班|此班|前者|后者|这门课|该课程|此课程|它们|这个要求)/)?.[0] || '该指代'}”存在多个或缺失先行词，请明确对象。`],
                }, tracedSourceMeta));
                continue;
            }
            const hasPrefer = preferPattern.test(sentence) || (continuation && context.prefer);
            const hasAvoid = avoidPattern.test(sentence) || (continuation && context.avoid);
            const hasFixedClassActivity = effectiveClassTargets.length > 0
                && /(?:班会|校会|年级会|固定活动|集体活动)/.test(sentence)
                && slots.length > 0;
            const hasGlobalBlockingActivity = !effectiveTeacherTargets.length
                && !effectiveClassTargets.length
                && /(?:全校|全部|所有|统一|全体).{0,16}(?:开会|会议|集会|升旗|活动)/.test(sentence)
                && slots.length > 0;
            const hasUnavailable = hasUnavailableExpression(sentence)
                || hasFixedClassActivity
                || hasGlobalBlockingActivity
                || (continuation && context.unavailable);
            const unavailableDays = effectiveDays.length
                ? effectiveDays
                : inheritsPreviousTime ? asList(context.days) : [];
            const unavailablePeriods = currentPeriods.length
                ? currentPeriods
                : inheritsPreviousTime ? asList(context.periods) : [];
            const unavailableSlots = slots.length
                ? slots
                : hasUnavailable && unavailableDays.length
                    ? unavailableDays.flatMap(day => getActivePeriods(project).map(period => slotKey(day, period)))
                    : [];
            const rawText = continuation && context.rawText ? `${context.rawText}，${sourceSentence}` : sourceSentence;
            const weekPattern = timeSpec.weekPattern || weekPatternFromText(sentence) || (continuation ? context.weekPattern : '');
            if (/该课程.*实验室维修时段/.test(sentence) && effectiveSubjectTargets.length) {
                const subject = effectiveSubjectTargets[0];
                constraints.push(clarificationSemanticConstraint({
                    type: 'subject_avoid_periods', capabilityId: 'subject.avoid_periods',
                    targetType: 'subject', targetId: subject.id || '', target: subject.name,
                    subjectId: subject.id || '', subjectName: subject.name,
                    priority: 'hard', reason: rawText,
                    clarifications: ['请补充实验室维修对应的具体日期和节次。'],
                }, tracedSourceMeta));
                continue;
            }
            const effectiveDayPart = dayPartName(sentence)
                || (continuation && context.dayPart && !hasExplicitPeriodExpression(sentence) ? context.dayPart : '');
            const broadDayPartOnly = Boolean(effectiveDayPart) && !hasExplicitPeriodExpression(sentence);

            const boundaryPeriods = crossVenueBoundaryPeriods(project, sentence);
            if (boundaryPeriods.length) {
                constraints.push(withSource({
                    type: 'cross_venue_boundary',
                    capabilityId: 'schedule.cross_venue_boundary',
                    targetType: 'global',
                    target: '全校',
                    boundaryPeriods: boundaryPeriods.slice(0, 2),
                    priority: 'hard',
                    status: 'unsupported',
                    reason: rawText,
                    confidence: 0.92,
                    weekPattern,
                }, tracedSourceMeta));
                continue;
            }

            const concentrationSubjects = effectiveSubjectTargets.length
                ? effectiveSubjectTargets
                : context.subjectTargets;
            const concentrationDays = parseDays(sentence, project, []);
            if (
                concentrationSubjects.length
                && concentrationDays.length
                && /(?:不要|别)(?:都)?(?:挤|集中|堆)(?:在|到)|不要集中到/.test(sentence)
            ) {
                const concentrationRawText = context.rawText ? `${context.rawText}，${sentence}` : rawText;
                constraints.push(withSource({
                    type: 'avoid_weekday_concentration',
                    capabilityId: 'subject.avoid_weekday_concentration',
                    targetType: concentrationSubjects.length > 1 ? 'subject_group' : 'subject',
                    targetId: concentrationSubjects.length === 1 ? concentrationSubjects[0].id : '',
                    target: concentrationSubjects.map(subject => subject.name).join('、'),
                    subjectIds: concentrationSubjects.map(subject => subject.id || subject.name),
                    days: concentrationDays,
                    priority: 'soft',
                    status: 'unsupported',
                    reason: concentrationRawText,
                    confidence: 0.9,
                    weekPattern,
                }, tracedSourceMeta));
                continue;
            }

            if (unavailableSlots.length && hasUnavailable && /(全校|全部|所有|统一|学生课|升旗|早读|午休|大课间|广播操|全体)/.test(sentence) && !effectiveTeacherTargets.length && !effectiveClassTargets.length) {
                constraints.push(withSource({
                    type: 'global_unavailable',
                    target: '全校',
                    days: unavailableDays,
                    periods: unavailablePeriods,
                    slots: unavailableSlots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (effectiveTeacherTargets.length >= 2 && /(不能|不可|不要).*(同时|同一节|同节)|互斥|错开/.test(sentence)) {
                constraints.push(withSource({
                    type: 'teacher_mutual_exclusion',
                    teacherIds: effectiveTeacherTargets.map(teacher => teacher.id || teacher.name),
                    target: effectiveTeacherTargets.map(teacher => teacher.name).join('、'),
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.88,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (effectiveSubjectTargets.length >= 2 && /(不要|不能|不可).*(同一天|同日)|不同天|错开/.test(sentence)) {
                constraints.push(withSource({
                    type: 'subject_not_same_day',
                    subjectIds: effectiveSubjectTargets.map(subject => subject.id || subject.name),
                    classIds: effectiveClassTargets.map(klass => klass.id || klass.name),
                    target: effectiveSubjectTargets.map(subject => subject.name).join('、'),
                    priority: 'hard',
                    reason: rawText,
                    confidence: 0.88,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (effectiveSubjectTargets.length >= 2 && /(先.*后|先.*再|之后|后再|顺序)/.test(sentence)) {
                const [before, after] = effectiveSubjectTargets;
                constraints.push(withSource({
                    type: 'subject_sequence',
                    beforeSubjectId: before.id || before.name,
                    afterSubjectId: after.id || after.name,
                    subjectIds: [before.id || before.name, after.id || after.name],
                    classIds: effectiveClassTargets.map(klass => klass.id || klass.name),
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (/班级.*(每天|每日).*(均衡|平衡)|班级.*(均衡|平衡).*(每天|每日)/.test(sentence)) {
                const maxMatch = sentence.match(new RegExp(`主科.*?(?:最多|不超过|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                constraints.push(withSource({
                    type: 'class_daily_balance',
                    target: '全部班级',
                    limit: maxMatch ? parseLooseNumber(maxMatch[1]) : undefined,
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (/教师.*(均衡|平衡|公平)|负载.*(均衡|平衡|公平)/.test(sentence)) {
                constraints.push(withSource({
                    type: 'teacher_load_balance',
                    target: '全部教师',
                    priority: 'soft',
                    reason: rawText,
                    confidence: 0.86,
                    weekPattern,
                }, tracedSourceMeta));
            }

            if (/少空堂|别有空堂|不要.*空堂|空堂.*少|课.*连着上|排得?紧凑|课表.*紧凑|长空堂/.test(sentence)) {
                const gapTargets = effectiveTeacherTargets.length
                    ? effectiveTeacherTargets
                    : [{ id: '__all_teachers', name: '全部教师', group: true }];
                gapTargets.forEach(teacher => constraints.push(withSource({
                    type: 'teacher_gap_preference',
                    targetType: teacher.group ? 'teacher_group' : 'teacher',
                    targetId: teacher.id,
                    target: teacher.name,
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.group ? 0.86 : teacher.id ? 0.88 : 0.74,
                    weekPattern,
                }, tracedSourceMeta)));
            }

            if (/(必须|固定|锁定|指定)/.test(sentence) && slots.length && effectiveTeacherTargets.length && effectiveClassTargets.length && effectiveSubjectTargets.length) {
                const teacher = effectiveTeacherTargets[0];
                const klass = effectiveClassTargets[0];
                const subject = effectiveSubjectTargets[0];
                constraints.push(withSource({
                type: 'locked_slot',
                teacherId: teacher.id,
                teacher: teacher.name,
                classId: klass.id,
                class: klass.name,
                subjectId: subject.id,
                subject: subject.name,
                slots: [slots[0]],
                priority: 'hard',
                reason: rawText,
                confidence: 0.88,
                weekPattern,
                }, tracedSourceMeta));
                continue;
            }

            effectiveTeacherTargets.forEach(teacher => {
                if (hasUnavailable && unavailableSlots.length) {
                    constraints.push(withSource({
                    type: 'teacher_unavailable',
                    targetId: teacher.id,
                    target: teacher.name,
                    days: unavailableDays,
                    periods: unavailablePeriods,
                    slots: unavailableSlots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.74,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const explicitDailyLimit = constraintLimitFromText('teacher_daily_limit', sentence);
                const inheritedDailyMatch = (
                    context.lastConstraintType === 'teacher_daily_limit'
                        ? sentence.match(
                            new RegExp(`(?:(?:这个|该|此)?上限.{0,16}?(?:改成|改为|调成|调整为|为|是)?|(?:最多|不超过|不多于)\\s*)(${NUMBER_TOKEN_PATTERN})\\s*节`)
                        )
                        : null
                );
                const dailyLimit = Number.isInteger(explicitDailyLimit)
                    ? explicitDailyLimit
                    : parseLooseNumber(inheritedDailyMatch?.[1]);
                if (Number.isInteger(dailyLimit)) {
                    constraints.push(withSource({
                    type: 'teacher_daily_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: dailyLimit,
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.id ? 0.82 : 0.7,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const consecutiveLimit = teacherConsecutiveLimitFromText(sentence);
                if (Number.isInteger(consecutiveLimit)) {
                    constraints.push(withSource({
                    type: 'teacher_consecutive_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: consecutiveLimit,
                    priority: 'soft',
                    reason: rawText,
                    confidence: teacher.id ? 0.8 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const weeklyMatch = sentence.match(new RegExp(`每周.*?(?:最多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                if (weeklyMatch) {
                    constraints.push(withSource({
                    type: 'teacher_weekly_limit',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: parseLooseNumber(weeklyMatch[1]),
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.7,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const maxDaysPerWeek = constraintLimitFromText('teacher_max_days_per_week', sentence);
                if (Number.isInteger(maxDaysPerWeek)) {
                    constraints.push(withSource({
                    type: 'teacher_max_days_per_week',
                    targetId: teacher.id,
                    target: teacher.name,
                    limit: maxDaysPerWeek,
                    priority: 'hard',
                    reason: rawText,
                    confidence: teacher.id ? 0.88 : 0.7,
                    weekPattern,
                    }, tracedSourceMeta));
                }
            });
            effectiveClassTargets.forEach(klass => {
                if (hasUnavailable && unavailableSlots.length) {
                    constraints.push(withSource({
                    type: 'class_unavailable',
                    targetId: klass.id,
                    target: klass.name,
                    days: unavailableDays,
                    periods: unavailablePeriods,
                    slots: unavailableSlots,
                    priority: 'hard',
                    reason: rawText,
                    confidence: klass.id ? 0.84 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                }
            });
            effectiveSubjectTargets.forEach(subject => {
                const teacherUnavailableSentence = effectiveTeacherTargets.length > 0
                    && hasUnavailable
                    && !hasPrefer
                    && !effectiveClassTargets.length;
                if (teacherUnavailableSentence) return;
                if (slots.length && hasPrefer && !broadDayPartOnly) {
                    constraints.push(withSource({
                    type: 'subject_preferred_periods',
                    targetId: subject.id,
                    target: subject.name,
                    periods: currentPeriods.length ? currentPeriods : inheritsPreviousTime ? asList(context.periods) : [],
                    slots,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.9 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                } else if (slots.length && hasAvoid) {
                    constraints.push(withSource({
                    type: 'subject_avoid_periods',
                    intent: /(?:最后一节|末节|收尾)/.test(sentence)
                        ? 'avoid_last_period'
                        : /(?:第一节|首节)/.test(sentence) ? 'avoid_first_period' : undefined,
                    targetId: subject.id,
                    target: subject.name,
                    days: effectiveDays,
                    periods: currentPeriods.length ? currentPeriods : inheritsPreviousTime ? asList(context.periods) : [],
                    slots,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.9 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                } else if (effectiveDayPart === 'morning' && hasPrefer) {
                    constraints.push(withSource({
                    type: 'subject_morning',
                    targetId: subject.id,
                    target: subject.name,
                    dayPart: 'morning',
                    periods: getDayPartPeriods(project, 'morning'),
                    slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'morning').map(period => slotKey(day, period))),
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                } else if (effectiveDayPart === 'afternoon' && hasPrefer) {
                    constraints.push(withSource({
                    type: 'subject_afternoon',
                    targetId: subject.id,
                    target: subject.name,
                    dayPart: 'afternoon',
                    periods: getDayPartPeriods(project, 'afternoon'),
                    slots: getActiveWeekdays(project).flatMap(day => getDayPartPeriods(project, 'afternoon').map(period => slotKey(day, period))),
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const subjectDailyMatch = sentence.match(new RegExp(`(?:每天|每日).*?(?:最多|不超过|不多于|上限)\\s*(${NUMBER_TOKEN_PATTERN})\\s*节`));
                if (subjectDailyMatch && !/教师|老师/.test(sentence)) {
                    constraints.push(withSource({
                    type: 'subject_daily_limit',
                    targetId: subject.id,
                    target: subject.name,
                    limit: parseLooseNumber(subjectDailyMatch[1]),
                    priority: 'hard',
                    reason: rawText,
                    confidence: subject.id ? 0.88 : 0.68,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const intervalMatch = sentence.match(new RegExp(`(?:间隔|隔开|岔开|至少间隔|至少隔|至少岔开).*?(${NUMBER_TOKEN_PATTERN})\\s*天|(${NUMBER_TOKEN_PATTERN})\\s*天.*?(?:间隔|隔开|岔开)`));
                const intervalDays = /(?:隔天|隔日|间隔一天|至少隔一天|至少岔开一天|不要连续两天)/.test(sentence)
                    ? 1
                    : intervalMatch
                        ? parseLooseNumber(intervalMatch[1] || intervalMatch[2])
                        : null;
                if (Number.isInteger(intervalDays) && intervalDays > 0) {
                    constraints.push(withSource({
                    type: 'course_interval',
                    capabilityId: 'subject.minimum_day_gap',
                    targetId: subject.id,
                    target: subject.name,
                    minGapDays: intervalDays,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                if (/(?:尽量|最好|需要|要).*(?:分散|摊开)|(?:一周|每周)?.*(?:分散(?:点|些|一点)?|摊开)|(?:不要|别|避免).*(?:扎堆|挤在一起)/.test(sentence)) {
                    constraints.push(withSource({
                    type: 'subject_spread',
                    capabilityId: 'subject.spread',
                    targetId: subject.id,
                    target: subject.name,
                    priority: 'soft',
                    reason: rawText,
                    confidence: subject.id ? 0.86 : 0.64,
                    weekPattern,
                    }, tracedSourceMeta));
                }
                const hasSpecializedRoomConstraint = constraints.some(item => (
                    ['room.required', 'room.preferred', 'room.forbidden_type'].includes(item.capabilityId)
                    && (item.targetId || item.subjectId || '') === (subject.id || '')
                ));
                if (
                    !hasSpecializedRoomConstraint
                    && effectiveRoomTargets.length
                    && /(教室|场地|实验室|机房|操场|体育馆|音乐室|美术室|功能室|安排|使用|去|在)/.test(sentence)
                ) {
                    const roomName = effectiveRoomTargets[0]?.name || '';
                    const roomConstraint = {
                        type: 'room_requirement',
                        capabilityId: 'room.required',
                        targetType: 'subject',
                        targetId: subject.id,
                        target: subject.name,
                        roomIds: effectiveRoomTargets.map(room => room.id || room.name),
                        roomName,
                        requiredTags: roomTagsFromText(roomName, sentence),
                        priority: 'hard',
                        reason: rawText,
                        confidence: subject.id ? 0.88 : 0.64,
                        weekPattern,
                    };
                    const needsRoomClarification = effectiveRoomTargets.every(room => (
                        !room.id && roomMentionNeedsClarification(room.name)
                    ));
                    constraints.push(needsRoomClarification
                        ? clarificationSemanticConstraint({
                            ...roomConstraint,
                            roomIds: [],
                            requiredTags: [],
                            clarifications: ['请明确具体教室，或补充可验证的教室资源类型。'],
                        }, tracedSourceMeta)
                        : withSource(roomConstraint, tracedSourceMeta));
                }
            });

            if (teacherTargets.length) {
                context.teacherTargets = teacherTargets;
                appendContextHistory(context, 'teacher', teacherTargets);
            }
            if (classTargets.length) {
                context.classTargets = classTargets;
                appendContextHistory(context, 'class', classTargets);
            }
            if (explicitSubjectTargets.length) {
                context.subjectTargets = explicitSubjectTargets;
                appendContextHistory(context, 'subject', explicitSubjectTargets);
            } else if (subjectTargets.length && reference.kind !== 'subject') {
                context.subjectTargets = subjectTargets;
                appendContextHistory(context, 'subject', subjectTargets);
            }
            if (explicitRoomTargets.length) context.roomTargets = explicitRoomTargets;
            if (hasPrefer) context.prefer = true;
            if (hasAvoid) context.avoid = true;
            if (hasUnavailable || (classTargets.length && /(?:班会|活动)/.test(sentence))) context.unavailable = true;
            if (currentDays.length) context.days = currentDays;
            if (currentPeriods.length) context.periods = currentPeriods;
            if (slots.length) context.slots = slots;
            if (dayPartName(sentence)) context.dayPart = dayPartName(sentence);
            if (weekPattern) context.weekPattern = weekPattern;
            const latestConstraint = constraints.at(-1);
            if (latestConstraint?.type) context.lastConstraintType = latestConstraint.type;
            if (teacherTargets.length || classTargets.length || subjectTargets.length || slots.length || hasPrefer || hasAvoid || hasUnavailable) {
                context.rawText = rawText;
            }
        }
    }

    // Prepared parse inputs already represent one stable SourceRequirement. Running the
    // legacy whole-prompt fallback again invents extra targets from clause fragments.
    const needsRegisteredAliasExpansion = /(?:物化生|物理、化学、生物|音体美信|音乐、体育、美术、信息技术)/.test(normalized.text);
    const augmentedConstraints = tracedSourceMeta.sourceId && !needsRegisteredAliasExpansion
        ? constraints
        : categorizedMarketFallbackConstraints(project, normalized.text, tracedSourceMeta, constraints);
    return compactLocalConstraints(augmentedConstraints);
}

function structuredConstraintFromRow(project, row = {}) {
    const type = normalizeConstraintType(row.ruleType || row.type || '');
    const rawTarget = asText(row.target || row.targetName || row.teacherName || row.className || row.subjectName || '', 200);
    const target = targetTypeFor(type, row) === 'teacher'
        ? rawTarget.replace(/(?:老师|教师)$/u, '')
        : rawTarget;
    const rawText = asText(row.constraintText || row.description || row.ruleName || '', 1500)
        || [
            row.ruleName ? `名称：${row.ruleName}` : '',
            row.ruleType ? `类型：${row.ruleType}` : '',
            target ? `对象：${target}` : '',
            row.days ? `周几：${row.days}` : '',
            row.periods ? `节次：${row.periods}` : '',
            row.slots ? `时间：${row.slots}` : '',
        ].filter(Boolean).join('；');
    const sourceMeta = {
        sourceId: row.sourceId,
        textHash: row.textHash,
        origin: row.origin || 'unknown',
        parsedBy: normalizedParsedBy(row.parsedBy, 'local'),
        parser: 'local',
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        lineNumber: row.lineNumber,
        rawText,
    };
    const preciseConstraints = preciseSemanticConstraintsFromText(project, rawText, sourceMeta, row);
    if (preciseConstraints.length) return preciseConstraints;
    if (!SUPPORTED_EFFECTIVE_TYPES.has(type) && !SUGGESTION_ONLY_TYPES.has(type)) return null;

    const targetType = targetTypeFor(type, row);
    const base = {
        type,
        target,
        targetName: target,
        targetType,
        slots: normalizeSlotList(row.slots || row.timeSlots || ''),
        days: row.days || row.weekdays || '',
        periods: row.periods || row.lessonIndexes || '',
        priority: row.priority || row.strength,
        weight: row.weight,
        limit: row.limit ?? row.value ?? row.max ?? constraintLimitFromText(type, rawText),
        minGapDays: row.minGapDays || row.gapDays,
        teacherIds: normalizedTextValues(120, row.teacherIds),
        subjectIds: normalizedTextValues(120, row.subjectIds),
        classIds: normalizedTextValues(120, row.classIds),
        roomIds: normalizedTextValues(120, row.roomIds, row.allowedRoomIds),
        roomName: row.roomName || row.room || '',
        requiredTags: normalizedTextValues(120, row.requiredTags, row.roomTags),
        beforeSubjectId: row.beforeSubjectId || row.before || '',
        afterSubjectId: row.afterSubjectId || row.after || '',
        reason: row.description || rawText,
        confidence: 0.95,
        sourceId: row.sourceId,
        textHash: row.textHash,
        origin: row.origin || 'unknown',
        parsedBy: normalizedParsedBy(row.parsedBy, 'local'),
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        lineNumber: row.lineNumber,
    };

    if (type === 'room_requirement') {
        const extractedRooms = textRoomTargets(rawText, project);
        const extractedRoomIds = extractedRooms.map(room => room.id || room.name).filter(Boolean);
        const extractedRoomNames = extractedRooms.map(room => room.name || room.id).filter(Boolean);
        base.roomIds = [...new Set([...(base.roomIds || []), ...extractedRoomIds])];
        base.roomName = base.roomName || extractedRoomNames[0] || '';
        base.requiredTags = [...new Set([
            ...(base.requiredTags || []),
            ...roomTagsFromText(extractedRoomNames.join('、'), rawText),
        ])];
    }
    if (type === 'block_protection') {
        const subjects = textSubjectTargets(rawText, project);
        const [subject] = subjects;
        if (subjects.length === 1) {
            base.targetType = 'subject';
            base.target = subject.name;
            base.targetName = subject.name;
            base.targetId = subject.id || '';
            base.subjectId = subject.id || '';
            base.subjectName = subject.name;
            base.subject = subject.name;
        }
        base.blockPreference = blockPreferenceFromText(rawText) || row.blockPreference || '';
        base.gradeNames = gradeNamesFromText(rawText);
    }
    if (targetType === 'teacher') {
        base.teacherId = row.teacherId || row.targetId || '';
        base.teacher = row.teacherName || target;
    } else if (targetType === 'class') {
        base.classId = row.classId || row.targetId || '';
        base.class = row.className || target;
    } else if (targetType === 'subject') {
        base.subjectId = row.subjectId || row.targetId || '';
        base.subject = row.subjectName || target;
    }

    if (!base.slots.length && (base.days || base.periods)) {
        base.slots = slotsFromConstraint(base, project);
    }
    if (row.weekPattern) base.weekPattern = row.weekPattern;
    if (rawText) base.rawText = rawText;

    return base;
}

function localTextConstraintsFromInput(project, text, constraintRows = [], options = {}) {
    const rowList = asList(constraintRows).filter(row => row && typeof row === 'object');
    if (rowList.length) {
        const constraints = rowList.flatMap(row => {
            const rowText = asText(row.constraintText || row.rawText || row.description || '', 1500);
            if (!rowText) return [];
            const sourceMeta = {
                sourceId: row.sourceId,
                textHash: row.textHash,
                origin: row.origin || 'unknown',
                parsedBy: normalizedParsedBy(row.parsedBy, 'local'),
                parser: 'local',
                sourceSheet: row.sourceSheet,
                sourceRow: row.sourceRow,
                lineNumber: row.lineNumber,
                rawText: rowText,
            };

            // 结构化 Excel 列可能只是人工摘要，不能覆盖原文中更具体的关系语义。
            // 例如“第4节和第5节之间不要安排跨场地连续课程”不是普通课程间隔。
            if (crossVenueBoundaryPeriods(project, rowText).length) {
                return localTextConstraints(project, rowText, sourceMeta);
            }
            if (options.preferStructuredRows) {
                const structured = structuredConstraintFromRow(project, row);
                if (structured) return Array.isArray(structured) ? structured : [structured];
            }
            return localTextConstraints(project, rowText, sourceMeta);
        });
        return compactLocalConstraints(constraints);
    }
    const sourceList = asList(options.sourceRequirements).filter(item => item && typeof item === 'object');
    if (sourceList.length) {
        return compactLocalConstraints(sourceList.flatMap((sourceRequirement) => {
            const source = sourceRequirement.source || {};
            const rawText = asText(source.rawText || sourceRequirement.rawText || '', 1500);
            if (!rawText) return [];
            return localTextConstraints(project, rawText, {
                sourceId: sourceRequirement.sourceId || source.sourceId,
                textHash: source.textHash || sourceRequirement.textHash || '',
                origin: sourceRequirement.origin || source.origin || 'unknown',
                parsedBy: normalizedParsedBy(sourceRequirement.parsedBy, source.parsedBy, 'local'),
                parser: 'local',
                sourceSheet: source.sheetName || sourceRequirement.sourceSheet || '',
                sourceRow: source.rowNumber ?? sourceRequirement.sourceRow ?? null,
                lineNumber: source.lineNumber ?? sourceRequirement.lineNumber ?? null,
                rawText,
            });
        }));
    }
    return localTextConstraints(project, text);
}

function parseConstraintsWithLocalFallback({ project, text, inputType, contextStats = null, constraintRows = [], sourceRequirements = [], error = null }) {
    const localSource = localParseSourceForInput(inputType);
    const constraints = localTextConstraintsFromInput(project, text, constraintRows, {
        preferStructuredRows: inputType === 'xlsx_constraints',
        sourceRequirements,
    });
    if (!constraints.length) {
        const semanticOnly = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [],
            source: localSource,
            inputType,
            contextStats,
            originalText: text,
            sourceRequirements,
            initialWarnings: error ? [`智能解析不可用，已仅提取明确需求：${error.reason || error.message}`] : [],
        });
        if ((semanticOnly.requirementItems || []).length) return semanticOnly;
        if (error) throw error;
        throw new TimetableRuleParseError('需要配置智能解析服务才能解析这类约束。', 'ai_not_configured', 503);
    }
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: rowsFromAiConstraints(constraints, { source: localSource }).rows,
        source: localSource,
        inputType,
        contextStats,
        originalText: text,
        sourceRequirements,
        initialWarnings: error ? [`智能解析不可用，已仅提取明确规则：${error.reason || error.message}`] : [],
    });
}

function hasConfiguredAi(env = {}) {
    return Boolean(String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim());
}

function shouldUseLocalFirst(inputType = '') {
    return ['text', 'txt', 'csv_text', 'xlsx_constraints'].includes(inputType);
}

function shouldUseAiExtraction(inputType = '', env = {}) {
    if (!['text', 'txt', 'csv_text'].includes(inputType)) return false;
    const configured = String(env.TIMETABLE_RULE_AI_EXTRACT || '').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(configured)) return false;
    if (['1', 'true', 'yes', 'on'].includes(configured)) return true;
    // The HTTP runtime passes process.env. Injected environments remain opt-in so offline callers stay deterministic.
    return env === process.env && hasConfiguredAi(env);
}

function candidateSemanticSignature(row = {}) {
    return stableJson({
        sourceId: row.sourceId || row.source?.sourceId || '',
        textHash: row.textHash || row.source?.textHash || '',
        capability: row.capabilityId || row.type || row.intent || '',
        targetType: row.targetType || row.object?.kind || '',
        targetIds: normalizedTextValues(160,
            row.targetId,
            row.teacherId,
            row.classId,
            row.subjectId,
            row.object?.matchedIds,
        ).sort(),
        targetName: row.targetName || row.target || row.object?.name || '',
        slots: normalizedTextValues(40, row.slots, row.condition?.slots, row.parameters?.slots).sort(),
        days: asList(row.days || row.parameters?.days).map(Number).filter(Number.isInteger).sort((left, right) => left - right),
        periods: asList(row.periods || row.parameters?.periods).map(Number).filter(Number.isInteger).sort((left, right) => left - right),
        parameters: row.parameters || {},
        priority: row.priority || row.strength || '',
    });
}

function mergeAiFirstCandidateRows(aiRows = [], localRows = []) {
    const merged = [];
    const seen = new Set();
    for (const row of [...asList(aiRows), ...asList(localRows)]) {
        if (!row || typeof row !== 'object') continue;
        const signature = candidateSemanticSignature(row);
        if (seen.has(signature)) continue;
        seen.add(signature);
        merged.push(row);
    }
    return merged;
}

function candidateSignatureSet(rows = []) {
    return new Set(asList(rows)
        .filter(row => row && typeof row === 'object')
        .map(candidateSemanticSignature));
}

function constraintIRSignatureSet(irs = []) {
    return new Set(asList(irs)
        .filter(ir => ir && typeof ir === 'object')
        .map(cacheConstraintIRSignature));
}

function aiLocalAgreementCount(aiRows = [], localRows = []) {
    const aiSignatures = candidateSignatureSet(aiRows);
    const localSignatures = candidateSignatureSet(localRows);
    return [...aiSignatures].filter(signature => localSignatures.has(signature)).length;
}

function withValidatedAiFirstResult({
    result = {},
    diagnosticResult = {},
    localBaselineResult = {},
    targetedSourceIds = [],
} = {}) {
    const diagnosticIRs = asList(diagnosticResult.constraintIRs);
    const baselineIRs = asList(localBaselineResult.constraintIRs);
    const formalIRs = asList(result.constraintIRs);
    const diagnosticSignatures = constraintIRSignatureSet(diagnosticIRs);
    const baselineSignatures = constraintIRSignatureSet(baselineIRs);
    const formalSignatures = constraintIRSignatureSet(formalIRs);
    const promotedIRs = formalIRs.filter(ir => !baselineSignatures.has(cacheConstraintIRSignature(ir)));
    const unverifiedPromoted = promotedIRs.filter(ir => ir.aiReviewValidationStatus !== 'accepted');
    return {
        ...result,
        parseSource: 'ai_extract',
        warningItems: [...new Map([
            ...asList(result.warningItems),
            ...asList(diagnosticResult.warningItems),
        ].map(item => [stableJson(item), item])).values()],
        rejected: [...new Map([
            ...asList(result.rejected),
            ...asList(diagnosticResult.rejected),
        ].map(item => [stableJson(item), item])).values()],
        aiCandidateValidation: {
            version: AI_CANDIDATE_VALIDATION_VERSION,
            formalBase: 'local_baseline',
            diagnosticCandidateCount: diagnosticSignatures.size,
            baselineCandidateCount: baselineSignatures.size,
            formalCandidateCount: formalSignatures.size,
            promotedCandidateCount: new Set(promotedIRs.map(cacheConstraintIRSignature)).size,
            droppedCandidateCount: [...diagnosticSignatures].filter(signature => !formalSignatures.has(signature)).length,
            unverifiedCandidateCount: new Set(unverifiedPromoted.map(cacheConstraintIRSignature)).size,
            targetedSourceCount: new Set(asList(targetedSourceIds).filter(Boolean)).size,
        },
    };
}

function targetedReviewSourceIds(sourceRequirements = [], aiRows = [], localRows = []) {
    const aiBySource = new Map();
    const localBySource = new Map();
    const add = (map, row) => {
        const sourceId = row?.sourceId || row?.source?.sourceId || '';
        if (!sourceId) return;
        const values = map.get(sourceId) || [];
        values.push(row);
        map.set(sourceId, values);
    };
    asList(aiRows).forEach(row => add(aiBySource, row));
    asList(localRows).forEach(row => add(localBySource, row));
    const targeted = new Set();
    for (const source of asList(sourceRequirements)) {
        const aiCandidates = aiBySource.get(source.sourceId) || [];
        const localCandidates = localBySource.get(source.sourceId) || [];
        if (!aiCandidates.length || !localCandidates.length) {
            targeted.add(source.sourceId);
            continue;
        }
        const aiSignatures = candidateSignatureSet(aiCandidates);
        const localSignatures = candidateSignatureSet(localCandidates);
        if (
            aiSignatures.size !== localSignatures.size
            || [...aiSignatures].some(signature => !localSignatures.has(signature))
        ) targeted.add(source.sourceId);
    }
    return [...targeted];
}

function localParseSourceForInput(inputType = '') {
    return inputType === 'xlsx_constraints' ? 'local_xlsx' : 'local_text';
}

function localResultIsDecisive(result = {}) {
    const rows = asList(result.draftRows).filter(row => row && typeof row === 'object');
    if (!rows.length) return false;
    return rows.some(row => row.status === 'effective' || row.weekPattern);
}

function localResultCanSkipAi(text = '', result = {}, inputType = '', constraintRows = []) {
    if (inputType === 'xlsx_constraints') {
        const rows = asList(result.draftRows).filter(row => row && typeof row === 'object');
        const resolvedRows = new Set(
            rows
                .filter(row => ['effective', 'suggestion', 'ignored'].includes(row.status))
                .map(row => row.sourceRow)
                .filter(value => value !== undefined && value !== null && value !== '')
                .map(String)
        );
        const totalSourceRows = new Set(
            asList(constraintRows)
                .filter(row => row && typeof row === 'object')
                .map(row => row.sourceRow)
                .filter(value => value !== undefined && value !== null && value !== '')
                .map(String)
        );
        return Boolean(rows.length)
            && (!totalSourceRows.size || [...totalSourceRows].every(row => resolvedRows.has(row)))
            && rows.every(row => ['effective', 'suggestion', 'ignored'].includes(row.status))
            && rows.some(row => row.status === 'effective');
    }
    if (/[A-Za-z]/.test(text)) return false;
    return localResultIsDecisive(result);
}

function unresolvedConstraintRowsForAi(constraintRows = [], localResult = {}) {
    const resolvedRows = new Set(
        asList(localResult.draftRows)
            .filter(row => row && typeof row === 'object')
            .filter(row => ['effective', 'suggestion', 'ignored'].includes(row.status))
            .map(row => row.sourceRow)
            .filter(value => value !== undefined && value !== null && value !== '')
            .map(String)
    );
    return asList(constraintRows)
        .filter(row => row && typeof row === 'object')
        .filter(row => !resolvedRows.has(String(row.sourceRow || '')));
}

function normalizeReviewVerdict(value = '') {
    const key = asText(value || '', 80).toLowerCase().replace(/[-\s]+/g, '_');
    return {
        accepted: 'accept',
        ok: 'accept',
        pass: 'accept',
        warning: 'flag',
        needs_review: 'flag',
        review: 'flag',
        patch: 'suggest_patch',
        suggestion: 'suggest_patch',
        missed: 'missed_requirement',
        missing: 'missed_requirement',
        unsupported_item: 'unsupported',
    }[key] || (['accept', 'flag', 'suggest_patch', 'missed_requirement', 'unsupported'].includes(key) ? key : 'flag');
}

function normalizeReviewEvidence(item = {}, target = {}) {
    const evidence = item.evidence && typeof item.evidence === 'object' ? item.evidence : {};
    return {
        sourceId: asText(evidence.sourceId || target.sourceId || item.sourceId || '', 300),
        textHash: asText(evidence.textHash || target.textHash || item.textHash || '', 128),
        quote: asText(evidence.quote || evidence.text || item.quote || item.rawText || '', 500),
        reason: asText(evidence.reason || item.reason || item.message || item.suggestion || '', 500),
        sourceSheet: asText(evidence.sourceSheet || target.sourceSheet || item.sourceSheet || '', 120),
        sourceRow: Number.parseInt(evidence.sourceRow ?? target.sourceRow ?? item.sourceRow, 10) || null,
        lineNumber: Number.parseInt(evidence.lineNumber ?? target.lineNumber ?? item.lineNumber, 10) || null,
    };
}

function normalizeAiReviewItems(items = []) {
    return asList(items).filter(item => item && typeof item === 'object').map((item, index) => {
        const target = item.target && typeof item.target === 'object' ? item.target : {};
        const verdict = normalizeReviewVerdict(item.verdict || item.status || item.action || item.type);
        const reason = asText(item.reason || item.message || item.suggestion || '', 500);
        const evidence = normalizeReviewEvidence({ ...item, reason }, target);
        const sourceId = asText(item.sourceId || item.source?.sourceId || target.sourceId || evidence.sourceId || '', 300);
        const textHash = asText(item.textHash || item.source?.textHash || target.textHash || evidence.textHash || '', 128);
        const sourceSheet = asText(item.sourceSheet || item.source?.sourceSheet || target.sourceSheet || evidence.sourceSheet || '', 120);
        const sourceRow = Number.parseInt(item.sourceRow ?? item.source?.sourceRow ?? target.sourceRow ?? evidence.sourceRow, 10) || null;
        const lineNumber = Number.parseInt(item.lineNumber ?? item.source?.lineNumber ?? target.lineNumber ?? evidence.lineNumber, 10) || null;
        return {
            id: asText(item.id, 120) || `review_${index + 1}`,
            sourceId,
            textHash,
            origin: item.origin || item.source?.origin || 'unknown',
            parsedBy: normalizedParsedBy(item.parsedBy, 'ai_review'),
            sourceSheet,
            sourceRow,
            lineNumber,
            rawText: asText(item.rawText || item.source?.rawText || evidence.quote || '', 1000),
            verdict,
            issueCode: asText(item.issueCode || item.code || '', 80).toLowerCase(),
            fieldPath: asText(item.fieldPath || item.path || '', 240),
            validationStatus: ['accepted', 'advisory', 'blocking', 'rejected'].includes(asText(item.validationStatus || '', 40).toLowerCase())
                ? asText(item.validationStatus, 40).toLowerCase()
                : '',
            blocking: item.blocking === true,
            validationEvidence: asList(item.validationEvidence)
                .map(value => asText(typeof value === 'object' ? value.message || value.code || stableJson(value) : value, 500))
                .filter(Boolean),
            target: {
                sourceId,
                textHash,
                rowId: asText(target.rowId || target.draftRowId || item.rowId || '', 120),
                requirementId: asText(target.requirementId || item.requirementId || '', 120),
                stableKey: asText(target.stableKey || item.stableKey || '', 240),
                sourceSheet,
                sourceRow,
                lineNumber,
                targetId: asText(target.targetId || item.targetId || '', 120),
                type: normalizeConstraintType(target.type || item.ruleType || item.constraintType || ''),
            },
            reason,
            evidence: {
                ...evidence,
                sourceId,
                textHash,
                sourceSheet,
                sourceRow,
                lineNumber,
            },
            patch: item.patch && typeof item.patch === 'object' ? item.patch : null,
            suggestedRequirement: item.suggestedRequirement && typeof item.suggestedRequirement === 'object'
                ? item.suggestedRequirement
                : null,
        };
    });
}

function appendUniqueText(values = [], next = '') {
    return normalizedTextValues(240, values, next);
}

function reviewTargetMatchesSource(artifact = {}, target = {}) {
    const artifactSource = artifact.source && typeof artifact.source === 'object' ? artifact.source : {};
    const sourceId = artifact.sourceId || artifactSource.sourceId || '';
    const textHash = artifact.textHash || artifactSource.textHash || '';
    if (target.sourceId && sourceId !== target.sourceId) return false;
    if (target.textHash && textHash !== target.textHash) return false;
    return true;
}

function reviewTargetMatchesRow(row = {}, target = {}) {
    if (!reviewTargetMatchesSource(row, target)) return false;
    const selectors = [];
    if (target.rowId) selectors.push(row.id === target.rowId);
    if (target.requirementId) selectors.push(
        row.requirementId === target.requirementId || row.clauseId === target.requirementId,
    );
    if (target.stableKey) selectors.push(row.stableKey === target.stableKey);
    if (target.sourceRow) {
        selectors.push(
            Number(row.sourceRow) === Number(target.sourceRow)
            && (!target.sourceSheet || !row.sourceSheet || target.sourceSheet === row.sourceSheet),
        );
    }
    if (target.lineNumber) selectors.push(Number(row.lineNumber) === Number(target.lineNumber));
    if (target.targetId) selectors.push(row.targetId === target.targetId);
    if (target.type) selectors.push(row.type === target.type);
    return selectors.length ? selectors.every(Boolean) : Boolean(target.sourceId || target.textHash);
}

function reviewTargetMatchesRequirement(item = {}, target = {}) {
    if (!reviewTargetMatchesSource(item, target)) return false;
    const selectors = [];
    if (target.requirementId) selectors.push(
        item.id === target.requirementId || item.requirementId === target.requirementId || item.clauseId === target.requirementId,
    );
    if (target.sourceRow) {
        const sourceRow = item.sourceRow ?? item.source?.sourceRow ?? item.source?.rowNumber;
        const sourceSheet = item.sourceSheet || item.source?.sourceSheet || item.source?.sheetName || '';
        selectors.push(
            Number(sourceRow) === Number(target.sourceRow)
            && (!target.sourceSheet || !sourceSheet || target.sourceSheet === sourceSheet),
        );
    }
    if (target.lineNumber) {
        selectors.push(Number(item.lineNumber ?? item.source?.lineNumber) === Number(target.lineNumber));
    }
    if (target.targetId) selectors.push(asList(item.object?.matchedIds).includes(target.targetId));
    if (target.type) selectors.push((item.intent || item.type) === target.type);
    return selectors.length ? selectors.every(Boolean) : Boolean(target.sourceId || target.textHash);
}

const BLOCKING_AI_REVIEW_ISSUE_CODES = new Set([
    'entity_missing',
    'entity_ambiguous',
    'required_parameter_missing',
    'slot_out_of_range',
    'activity_scope_ambiguous',
    'semantic_interpretation_conflict',
    'rule_conflict',
    'unsupported_capability',
]);

function sourceArtifactsForReview(result = {}, item = {}, rows = [], requirements = []) {
    const target = item.target || {};
    const matchingRows = rows.filter(row => reviewTargetMatchesRow(row, target));
    const matchingRequirements = requirements.filter(requirement => reviewTargetMatchesRequirement(requirement, target));
    const matchingIRs = asList(result.constraintIRs).filter(ir => reviewTargetMatchesSource(ir, target));
    const matchingSources = asList(result.sourceRequirements).filter(source => reviewTargetMatchesSource(source, target));
    return { matchingRows, matchingRequirements, matchingIRs, matchingSources };
}

function rowContainsOutOfRangeSlot(row = {}, project = {}) {
    const activeDays = new Set(getActiveWeekdays(project).map(Number));
    const activePeriods = new Set(getActivePeriods(project).map(Number));
    const slots = [
        ...asList(row.slots),
        ...asList(row.condition?.slots),
        ...asList(row.parameters?.slots),
    ];
    return slots.some(slot => {
        const [day, period] = String(slot || '').split('-').map(Number);
        return Number.isInteger(day) && Number.isInteger(period)
            && (!activeDays.has(day) || !activePeriods.has(period));
    }) || [
        ...asList(row.periods),
        ...asList(row.parameters?.periods),
        ...asList(row.parameters?.boundaryPeriods),
    ].map(Number).some(period => Number.isInteger(period) && !activePeriods.has(period));
}

function validateAiReviewFinding({ item = {}, result = {}, rows = [], requirements = [], project = {} } = {}) {
    if (item.verdict === 'accept') {
        return { validationStatus: 'accepted', blocking: false, validationEvidence: ['本地解析制品已存在。'] };
    }
    if (!['flag', 'unsupported'].includes(item.verdict)) {
        return { validationStatus: 'advisory', blocking: false, validationEvidence: [] };
    }

    const issueCode = item.issueCode || (item.verdict === 'unsupported' ? 'unsupported_capability' : '');
    if (!BLOCKING_AI_REVIEW_ISSUE_CODES.has(issueCode)) {
        return {
            validationStatus: 'advisory',
            blocking: false,
            validationEvidence: ['AI 提示没有可由本地验证器确认的阻断原因码。'],
        };
    }

    const artifacts = sourceArtifactsForReview(result, item, rows, requirements);
    const allArtifacts = [
        ...artifacts.matchingRows,
        ...artifacts.matchingRequirements,
        ...artifacts.matchingIRs,
        ...artifacts.matchingSources,
    ];
    const clarifications = allArtifacts.flatMap(artifact => [
        ...asList(artifact.clarifications),
        ...asList(artifact.questions),
        ...asList(artifact.reviewReasons).map(reason => reason?.message || reason?.code),
    ]).map(value => String(value || ''));
    const referenceIssues = artifacts.matchingIRs.flatMap(ir => asList(ir.referenceIssues));
    let reproduced = false;
    let evidence = '';

    if (issueCode === 'entity_missing') {
        reproduced = referenceIssues.some(reference => reference.status === 'missing')
            || allArtifacts.some(artifact => artifact.understandingStatus === 'invalid_reference');
        evidence = '本地实体解析确认目标不存在。';
    } else if (issueCode === 'entity_ambiguous') {
        reproduced = referenceIssues.some(reference => reference.status === 'ambiguous')
            || allArtifacts.some(artifact => artifact.understandingStatus === 'ambiguous'
                && (asList(artifact.target?.candidates).length > 1 || asList(artifact.object?.candidates).length > 1));
        evidence = '本地实体解析确认存在多个候选。';
    } else if (issueCode === 'required_parameter_missing') {
        reproduced = allArtifacts.some(artifact => artifact.executionStatus === 'blocked_by_clarification')
            || clarifications.some(message => /缺少|尚未配置|请补充|请确认/.test(message));
        evidence = '本地参数校验确认缺少执行所需参数。';
    } else if (issueCode === 'slot_out_of_range') {
        reproduced = artifacts.matchingRows.some(row => rowContainsOutOfRangeSlot(row, project))
            || clarifications.some(message => /不在当前排课范围|作息尚未配置第/.test(message));
        evidence = '本地作息校验确认节次超出范围。';
    } else if (issueCode === 'activity_scope_ambiguous') {
        reproduced = allArtifacts.some(artifact => artifact.executionStatus === 'blocked_by_clarification')
            && clarifications.some(message => /课型|活动|课程属性|适用范围|实验课|新授课/.test(message));
        evidence = '本地课程活动范围校验确认适用范围不完整。';
    } else if (issueCode === 'semantic_interpretation_conflict') {
        reproduced = allArtifacts.some(artifact => artifact.understandingStatus === 'ambiguous'
            && !asList(artifact.referenceIssues).length)
            || allArtifacts.some(artifact => artifact.executionStatus === 'conflicted');
        evidence = '本地语义归并确认存在无法自动裁决的解释。';
    } else if (issueCode === 'rule_conflict') {
        reproduced = allArtifacts.some(artifact => artifact.executionStatus === 'conflicted')
            || asList(result.conflicts).some(conflict => reviewTargetMatchesSource(conflict, item.target));
        evidence = '本地冲突检测确认规则冲突。';
    } else if (issueCode === 'unsupported_capability') {
        reproduced = artifacts.matchingIRs.some(ir => ir.executionStatus === 'unsupported_by_solver')
            || allArtifacts.some(artifact => artifact.support === 'none');
        evidence = '本地能力注册表确认当前求解器不支持该语义。';
    }

    return reproduced
        ? { validationStatus: 'blocking', blocking: true, validationEvidence: [evidence] }
        : {
            validationStatus: 'advisory',
            blocking: false,
            validationEvidence: [`本地验证器未复现 ${issueCode}，该提示仅作参考。`],
        };
}

function markRowWithAiReview(row = {}, status = 'accepted', reviewItem = {}, warning = '') {
    const parseSource = row.parseSource || row.source || 'local';
    const blockingWarning = warning && reviewItem.blocking === true ? warning : '';
    return {
        ...row,
        aiReviewStatus: status,
        aiReviewIssueCode: reviewItem.issueCode || '',
        aiReviewValidationStatus: reviewItem.validationStatus || 'advisory',
        aiReviewBlocking: reviewItem.blocking === true,
        aiReviewValidationEvidence: asList(reviewItem.validationEvidence),
        aiReviewWarnings: warning ? appendUniqueText(row.aiReviewWarnings || [], warning) : row.aiReviewWarnings || [],
        reviewEvidence: reviewItem.evidence || row.reviewEvidence || null,
        reviewedParseSource: `${parseSource}_ai_reviewed`,
        warnings: blockingWarning ? appendUniqueText(row.warnings || [], blockingWarning) : row.warnings || [],
    };
}

function markRequirementWithAiReview(item = {}, status = 'accepted', reviewItem = {}, warning = '') {
    const blockingWarning = warning && reviewItem.blocking === true ? warning : '';
    return {
        ...item,
        aiReviewStatus: status,
        aiReviewIssueCode: reviewItem.issueCode || '',
        aiReviewValidationStatus: reviewItem.validationStatus || 'advisory',
        aiReviewBlocking: reviewItem.blocking === true,
        aiReviewValidationEvidence: asList(reviewItem.validationEvidence),
        aiReviewWarnings: warning ? appendUniqueText(item.aiReviewWarnings || [], warning) : item.aiReviewWarnings || [],
        reviewEvidence: reviewItem.evidence || item.reviewEvidence || null,
        reviewedParseSource: `${item.source?.parseSource || item.parseSource || 'local'}_ai_reviewed`,
        warnings: blockingWarning ? appendUniqueText(item.warnings || [], blockingWarning) : item.warnings || [],
    };
}

function sanitizedReviewPatch(patch = {}) {
    const allowed = [
        'type', 'ruleType', 'targetType', 'targetId', 'targetName',
        'teacherId', 'teacherName', 'teacher',
        'classId', 'className', 'class',
        'subjectId', 'subjectName', 'subject',
        'slots', 'days', 'periods', 'priority', 'status',
        'confidence', 'weekPattern', 'limit', 'weight',
        'rawText', 'description', 'reason',
    ];
    return Object.fromEntries(allowed
        .filter(key => Object.prototype.hasOwnProperty.call(patch, key))
        .map(key => [key, patch[key]]));
}

function reviewPatchEffectKey(item = {}) {
    const target = item.target || {};
    return stableJson({
        sourceId: item.sourceId || target.sourceId || '',
        textHash: item.textHash || target.textHash || '',
        target: {
            rowId: target.rowId || '',
            stableKey: target.stableKey || '',
            sourceSheet: target.sourceSheet || '',
            sourceRow: target.sourceRow || null,
            targetId: target.targetId || '',
            type: target.type || '',
        },
        patch: sanitizedReviewPatch(item.patch || {}),
    });
}

function reviewPatchAlreadyApplied(row = {}, item = {}) {
    if (row.aiReviewStatus !== 'patched') return false;
    const patch = sanitizedReviewPatch(item.patch || {});
    const patchEntries = Object.entries(patch);
    return patchEntries.length > 0
        && patchEntries.every(([key, value]) => stableJson(row[key]) === stableJson(value));
}

function validatedReviewPatchRow(project = {}, row = {}, patch = {}, { inputType = '', contextStats = null, originalText = '' } = {}) {
    const candidate = {
        ...row,
        ...sanitizedReviewPatch(patch),
        id: row.id,
        stableKey: row.stableKey,
        sourceId: row.sourceId,
        textHash: row.textHash,
        origin: row.origin,
        parsedBy: row.parsedBy,
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
        lineNumber: row.lineNumber,
        rawText: row.rawText,
        parseSource: row.parseSource,
        source: row.source,
        warnings: [],
        ambiguity: null,
        ambiguities: [],
    };
    const normalized = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [candidate],
        source: candidate.parseSource || row.parseSource || 'ai_review',
        inputType,
        contextStats,
        originalText,
    });
    const [validated] = normalized.draftRows || [];
    if (!validated || (normalized.draftRows || []).length !== 1) return null;
    if (['needs_review', 'invalid', 'unsupported'].includes(validated.status)) return null;
    if ((validated.warnings || []).length || validated.ambiguity || (validated.ambiguities || []).length) return null;
    if (['teacher', 'class', 'subject'].includes(validated.targetType) && !validated.targetId) return null;
    if (rowNeedsSlots(validated.type) && !(validated.slots || []).length) return null;
    return validated;
}

function missedRequirementFromReviewItem(reviewItem = {}, index = 0) {
    const suggested = reviewItem.suggestedRequirement || {};
    const sourceSheet = reviewItem.sourceSheet || reviewItem.evidence?.sourceSheet || '';
    const sourceRow = reviewItem.sourceRow || reviewItem.evidence?.sourceRow || null;
    const lineNumber = reviewItem.lineNumber || reviewItem.evidence?.lineNumber || null;
    const rawText = reviewItem.rawText || reviewItem.evidence?.quote || reviewItem.reason || '';
    const parsedBy = normalizedParsedBy(reviewItem.parsedBy, 'ai_review');
    const intent = normalizeRequirementIntentAlias(suggested.intent || suggested.type || 'unknown');
    const complete = intent !== 'unknown' && Boolean(suggested.object || suggested.targetName || suggested.target);
    const source = {
        sourceId: reviewItem.sourceId || '',
        textHash: reviewItem.textHash || '',
        origin: reviewItem.origin || 'unknown',
        parsedBy,
        rawText,
        sourceSheet,
        sheetName: sourceSheet,
        sourceRow,
        rowNumber: sourceRow,
        lineNumber,
    };
    return {
        id: asText(suggested.id, 120) || `req_ai_review_missed_${index + 1}`,
        sourceId: source.sourceId,
        textHash: source.textHash,
        origin: source.origin,
        parsedBy,
        sourceSheet,
        sourceRow,
        lineNumber,
        rawText,
        object: suggested.object || { kind: 'global', name: asText(suggested.targetName || suggested.target || '待确认需求', 120), matchedIds: [], scope: 'unknown' },
        intent,
        condition: suggested.condition || {},
        parameters: suggested.parameters || {},
        strength: asText(suggested.strength || suggested.priority || 'soft', 40),
        status: normalizeRequirementStatusAlias(suggested.status || (complete ? 'actionable' : 'needs_review')),
        applyTo: normalizeRequirementApplyToAlias(suggested.applyTo || (complete ? 'rule' : 'review')),
        confidence: Number.isFinite(Number(suggested.confidence)) ? Number(suggested.confidence) : 0.55,
        source,
        warnings: [reviewItem.reason || 'AI 复审发现可能漏识别的需求，请人工确认。'],
        aiReviewStatus: 'missed',
        aiReviewIssueCode: reviewItem.issueCode || (complete ? '' : 'required_parameter_missing'),
        aiReviewValidationStatus: complete ? 'accepted' : 'blocking',
        aiReviewBlocking: !complete,
        aiReviewValidationEvidence: complete
            ? ['AI 补充语义已进入本地实体和能力编译。']
            : ['AI 补充语义缺少可编译的意图或对象。'],
        aiReviewWarnings: [reviewItem.reason || 'AI 复审发现可能漏识别的需求，请人工确认。'],
        reviewEvidence: reviewItem.evidence || null,
    };
}

export function applyAiReviewToParseResult({
    project,
    result,
    review,
    text = '',
    inputType = '',
    contextStats = null,
}) {
    const sourceRequirements = result.sourceRequirements || [];
    const reviewAlignment = sourceRequirements.length
        ? alignAiArtifactsToSources(review.reviewItems || [], sourceRequirements, {
            artifactKind: 'review_item',
            parsedBy: 'ai_review',
            allowLegacyEvidence: true,
        })
        : {
            artifacts: review.reviewItems || [],
            warnings: [],
            rejected: [],
        };
    const reviewItems = normalizeAiReviewItems(reviewAlignment.artifacts);
    const alignmentWarningMessages = reviewAlignment.warnings
        .map(item => item.message)
        .filter(Boolean);
    let rows = cloneValue(result.draftRows || []);
    let requirements = cloneValue(result.requirementItems || []);
    const warnings = [
        ...asList(result.warnings),
        ...asList(review.warnings),
        ...alignmentWarningMessages,
    ];
    const missedRequirements = [];
    const appliedPatchEffects = new Set();
    let appliedSuggestionCount = 0;
    let flaggedCount = 0;
    let formalArtifactsChanged = false;

    reviewItems.forEach((item, index) => {
        const rowIndexes = rows
            .map((row, rowIndex) => reviewTargetMatchesRow(row, item.target) ? rowIndex : -1)
            .filter(rowIndex => rowIndex >= 0);
        const requirementIndexes = requirements
            .map((requirement, requirementIndex) => reviewTargetMatchesRequirement(requirement, item.target) ? requirementIndex : -1)
            .filter(requirementIndex => requirementIndex >= 0);
        const reason = item.reason || 'AI 复审提示需要人工确认。';
        const validation = validateAiReviewFinding({ item, result, rows, requirements, project });
        Object.assign(item, validation);

        if (item.verdict === 'accept') {
            return;
        }

        if (item.verdict === 'flag' || item.verdict === 'unsupported') {
            flaggedCount += Math.max(1, rowIndexes.length || requirementIndexes.length);
            if (!item.blocking) return;
            rowIndexes.forEach(rowIndex => {
                const row = rows[rowIndex];
                const marked = markRowWithAiReview(
                    row,
                    item.verdict === 'unsupported' ? 'unsupported' : 'flagged',
                    item,
                    reason,
                );
                rows[rowIndex] = item.blocking && row.status !== 'ignored'
                    ? { ...marked, status: 'needs_review' }
                    : marked;
                formalArtifactsChanged = true;
            });
            requirementIndexes.forEach(requirementIndex => {
                const requirement = requirements[requirementIndex];
                const marked = markRequirementWithAiReview(
                    requirement,
                    item.verdict === 'unsupported' ? 'unsupported' : 'flagged',
                    item,
                    reason,
                );
                requirements[requirementIndex] = item.blocking && requirement.status !== 'handled'
                    ? { ...marked, status: 'needs_review', applyTo: 'review' }
                    : marked;
                formalArtifactsChanged = true;
            });
            return;
        }

        if (item.verdict === 'suggest_patch') {
            const patchEffectKey = reviewPatchEffectKey(item);
            if (appliedPatchEffects.has(patchEffectKey)) return;
            appliedPatchEffects.add(patchEffectKey);
            if (!item.patch || !rowIndexes.length) {
                Object.assign(item, { validationStatus: 'advisory', blocking: false, validationEvidence: ['没有可本地校验的补丁目标。'] });
                warnings.push(`AI 复审建议未通过本地校验：${reason}`);
                return;
            }
            rowIndexes.forEach(rowIndex => {
                if (reviewPatchAlreadyApplied(rows[rowIndex], item)) {
                    appliedSuggestionCount += 1;
                    return;
                }
                const patched = validatedReviewPatchRow(project, rows[rowIndex], item.patch, {
                    inputType,
                    contextStats,
                    originalText: text,
                });
                if (!patched) {
                    Object.assign(item, { validationStatus: 'advisory', blocking: false, validationEvidence: ['补丁未通过实体、时间或能力校验。'] });
                    warnings.push(`AI 复审建议未通过本地校验：${reason}`);
                    return;
                }
                Object.assign(item, { validationStatus: 'accepted', blocking: false, validationEvidence: ['补丁已通过本地实体、时间和能力校验。'] });
                rows[rowIndex] = markRowWithAiReview({ ...patched, id: rows[rowIndex].id, stableKey: rows[rowIndex].stableKey }, 'patched', item);
                appliedSuggestionCount += 1;
                formalArtifactsChanged = true;
            });
            return;
        }

        if (item.verdict === 'missed_requirement') {
            flaggedCount += 1;
            const missed = missedRequirementFromReviewItem(item, index);
            Object.assign(item, {
                issueCode: missed.aiReviewIssueCode,
                validationStatus: missed.aiReviewValidationStatus,
                blocking: missed.aiReviewBlocking,
                validationEvidence: missed.aiReviewValidationEvidence,
            });
            missedRequirements.push(missed);
            formalArtifactsChanged = true;
        }
    });

    const reviewAssistance = aiAssistancePayload({
        mode: 'targeted_review',
        reviewItems,
        correctedCount: appliedSuggestionCount,
    });
    const assistance = {
        ...reviewAssistance,
        acceptedCount: Number(result.aiAssistance?.acceptedCount || 0) + reviewAssistance.acceptedCount,
        correctedCount: Number(result.aiAssistance?.correctedCount || 0) + reviewAssistance.correctedCount,
        advisoryCount: Number(result.aiAssistance?.advisoryCount || 0) + reviewAssistance.advisoryCount,
        blockingCount: Number(result.aiAssistance?.blockingCount || 0) + reviewAssistance.blockingCount,
    };
    const aiReview = aiReviewStatusPayload({
        status: 'reviewed',
        model: review.model || '',
        reviewItems,
        warnings,
        appliedSuggestionCount,
        flaggedCount,
        ...assistance,
    });
    if (!formalArtifactsChanged) {
        return {
            ...result,
            warnings: [...new Set(warnings.filter(Boolean))],
            warningItems: [...new Map([
                ...asList(result.warningItems),
                ...reviewAlignment.warnings,
            ].map(item => [stableJson(item), item])).values()],
            rejected: [...new Map([
                ...asList(result.rejected),
                ...reviewAlignment.rejected,
            ].map(item => [stableJson(item), item])).values()],
            aiAssistance: assistance,
            aiReview,
        };
    }

    const rebuilt = normalizeTimetableRuleDraftRows({
        project,
        draftRows: rows,
        source: result.source || result.parseSource || 'ai_review',
        inputType: result.inputType || inputType,
        contextStats: result.contextStats || contextStats,
        originalText: text,
        semanticRequirements: [...requirements, ...missedRequirements],
        sourceRequirements,
        initialWarnings: [
            ...(result.warningItems || []),
            ...reviewAlignment.warnings,
            ...[...new Set(warnings.filter(Boolean))],
        ],
        rejected: [
            ...(result.rejected || []),
            ...reviewAlignment.rejected,
        ],
    });
    return {
        ...rebuilt,
        parseSource: result.parseSource || rebuilt.parseSource,
        warningItems: [...new Map([
            ...asList(result.warningItems),
            ...asList(rebuilt.warningItems),
        ].map(item => [stableJson(item), item])).values()],
        rejected: [...new Map([
            ...asList(result.rejected),
            ...asList(rebuilt.rejected),
        ].map(item => [stableJson(item), item])).values()],
        aiAssistance: assistance,
        aiReview,
    };
}

async function reviewTimetableParseResult({
    project,
    text,
    inputType,
    contextStats = null,
    constraintRows = [],
    result,
    diagnosticResult = result,
    applicationResult = result,
    env,
    fetchImpl,
}) {
    if (aiReviewDisabled(env)) {
        return withAiReviewUnavailable(applicationResult, 'disabled', 'AI 复审已禁用，已返回本地识别结果。');
    }
    if (!hasConfiguredAi(env)) {
        return withAiReviewUnavailable(applicationResult, 'ai_not_configured', 'AI 复审不可用，已返回本地识别结果：ai_not_configured');
    }
    try {
        const review = await callAiReview({
            project,
            text,
            inputType,
            contextStats,
            constraintRows,
            candidateResult: diagnosticResult,
            applicationResult,
            env,
            fetchImpl,
        });
        return applyAiReviewToParseResult({
            project,
            result: applicationResult,
            review,
            text,
            inputType,
            contextStats,
        });
    } catch (error) {
        const reason = error instanceof TimetableRuleParseError ? error.reason : 'ai_review_failed';
        const message = error?.message || reason;
        return withAiReviewUnavailable(applicationResult, reason, `AI 复审未完成，已返回本地识别结果：${message}`);
    }
}

async function parseAiOrLocal({ project, text, inputType, contextStats = null, constraintRows = [], fileName = '', env, fetchImpl }) {
    const preparedSources = prepareSourceInputs({ text, inputType, constraintRows, fileName, origin: 'user_input' });
    const sourceRequirements = preparedSources.sourceRequirements;
    constraintRows = preparedSources.sourceRows;
    const aiExtractWarnings = [];
    if (shouldUseAiExtraction(inputType, env)) {
        try {
            const localConstraints = localTextConstraintsFromInput(project, text, constraintRows, {
                preferStructuredRows: inputType === 'xlsx_constraints',
            });
            const localConversion = rowsFromAiConstraints(localConstraints, {
                source: localParseSourceForInput(inputType),
                project,
            });
            const localBaselineResult = normalizeTimetableRuleDraftRows({
                project,
                draftRows: localConversion.rows,
                source: localParseSourceForInput(inputType),
                inputType,
                contextStats,
                originalText: text,
                sourceRequirements,
            });
            const extracted = await extractRequirementsWithAI({
                project,
                text,
                contextStats,
                sourceRequirements,
                env,
                fetchImpl,
            });
            const reviewSourceIds = targetedReviewSourceIds(
                sourceRequirements,
                extracted.draftRows,
                localConversion.rows,
            );
            const normalized = normalizeTimetableRuleDraftRows({
                project,
                draftRows: mergeAiFirstCandidateRows(extracted.draftRows, localConversion.rows),
                source: 'ai_extract',
                inputType,
                contextStats: {
                    ...(contextStats || {}),
                    aiExtractModel: extracted.model || '',
                    aiExtractPromptVersion: extracted.promptVersion || '',
                    aiExtractRequirementCount: extracted.rawRequirements?.length || 0,
                },
                originalText: text,
                semanticRequirements: extracted.semanticRequirements,
                sourceRequirements,
                initialWarnings: [...asList(extracted.warningItems), ...asList(extracted.warnings)],
                rejected: extracted.rejected || [],
            });
            const aiFirstResult = {
                ...normalized,
                parseSource: 'ai_extract',
                aiAssistance: {
                    mode: 'ai_first',
                    acceptedCount: normalized.constraintIRs?.filter(item => item.executionStatus === 'executable').length || 0,
                    correctedCount: 0,
                    advisoryCount: 0,
                    blockingCount: normalized.sourceRequirements?.filter(item => item.requiresHumanReview).length || 0,
                },
                aiReview: aiReviewStatusPayload({
                    status: 'skipped',
                    reason: 'ai_extract',
                    model: extracted.model || '',
                    warnings: [],
                }),
            };
            const formalBaselineResult = {
                ...localBaselineResult,
                parseSource: 'ai_extract',
                aiAssistance: {
                    mode: 'ai_first',
                    acceptedCount: aiLocalAgreementCount(extracted.draftRows, localConversion.rows),
                    correctedCount: 0,
                    advisoryCount: 0,
                    blockingCount: 0,
                },
                aiReview: aiReviewStatusPayload({
                    status: 'skipped',
                    reason: 'ai_local_agreement',
                    model: extracted.model || '',
                    warnings: [],
                }),
            };
            if (reviewSourceIds.length) {
                const reviewed = await reviewTimetableParseResult({
                    project,
                    text,
                    inputType,
                    contextStats: {
                        ...(contextStats || {}),
                        targetedReviewSourceIds: reviewSourceIds,
                        targetedReviewReason: 'ai_local_disagreement_or_missing_candidate',
                    },
                    constraintRows,
                    result: formalBaselineResult,
                    diagnosticResult: aiFirstResult,
                    applicationResult: formalBaselineResult,
                    env,
                    fetchImpl,
                });
                if (reviewed.aiReview?.status !== 'reviewed') {
                    return withAiReviewUnavailable(
                        localBaselineResult,
                        reviewed.aiReview?.reason || 'ai_review_failed',
                        reviewed.aiReview?.warnings?.[0] || '定向 AI 复审未完成，已丢弃未验证候选并返回本地识别结果。',
                    );
                }
                return withValidatedAiFirstResult({
                    result: reviewed,
                    diagnosticResult: aiFirstResult,
                    localBaselineResult,
                    targetedSourceIds: reviewSourceIds,
                });
            }
            return withValidatedAiFirstResult({
                result: formalBaselineResult,
                diagnosticResult: aiFirstResult,
                localBaselineResult,
                targetedSourceIds: [],
            });
        } catch (error) {
            const reason = error?.reason || 'ai_extract_failed';
            const message = error?.message || reason;
            aiExtractWarnings.push(`AI-first 抽取失败，已降级到本地识别：${message}`);
        }
    }
    let localConstraints = [];
    let localResult = null;
    if (shouldUseLocalFirst(inputType)) {
        const localSource = localParseSourceForInput(inputType);
        localConstraints = localTextConstraintsFromInput(project, text, constraintRows, {
            preferStructuredRows: inputType === 'xlsx_constraints',
        });
        if (localConstraints.length) {
            localResult = normalizeTimetableRuleDraftRows({
                project,
                draftRows: rowsFromAiConstraints(localConstraints, { source: localSource }).rows,
                source: localSource,
                inputType,
                contextStats,
                originalText: text,
                sourceRequirements,
                initialWarnings: [...aiExtractWarnings, ...(hasConfiguredAi(env) ? [] : ['智能解析不可用，已仅提取明确规则：ai_not_configured'])],
            });
            if (aiExtractWarnings.length) {
                return withAiReviewUnavailable(localResult, 'ai_extract_failed', aiExtractWarnings[0]);
            }
            if (!hasConfiguredAi(env)) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
            }
            if (localResultCanSkipAi(text, localResult, inputType, constraintRows)) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
            }
        } else if (!hasConfiguredAi(env)) {
            const semanticOnly = normalizeTimetableRuleDraftRows({
                project,
                draftRows: [],
                source: localSource,
                inputType,
                contextStats,
                originalText: text,
                sourceRequirements,
                initialWarnings: [...aiExtractWarnings, '智能解析不可用，已仅提取明确需求：ai_not_configured'],
            });
            if ((semanticOnly.requirementItems || []).length) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: semanticOnly, env, fetchImpl });
            }
        }
    }
    try {
        const aiConstraintRows = inputType === 'xlsx_constraints' && localResult
            ? unresolvedConstraintRowsForAi(constraintRows, localResult)
            : constraintRows;
        if (inputType === 'xlsx_constraints' && localResult && !aiConstraintRows.length) {
            return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
        }
        const aiText = inputType === 'xlsx_constraints'
            ? textFromConstraintRows(aiConstraintRows) || text
            : text;
        const parsed = await callAi({
            project,
            text: aiText,
            inputType,
            contextStats,
            constraintRows: aiConstraintRows,
            env,
            fetchImpl,
        });
        const constraints = aiDraftRowsFromParsed(parsed);
        const aiSource = inputType === 'xlsx_constraints' ? 'ai_supplement' : 'ai';
        const localSource = localParseSourceForInput(inputType);
        const warnings = [
            ...warningMessagesFromAi(parsed.warnings),
            ...warningMessagesFromAi(parsed.missingInfo),
            ...warningMessagesFromAi(parsed.conflicts),
        ];
        const aiRequirements = alignAiArtifactsToSources(
            parsed.requirementItems || [],
            sourceRequirements,
            {
                artifactKind: 'requirement',
                parsedBy: 'ai',
                allowLegacyEvidence: true,
            }
        );
        const localConversion = rowsFromAiConstraints(localConstraints, {
            source: localSource,
            project,
        });
        const aiConversion = rowsFromAiConstraints(constraints, {
            source: aiSource,
            sourceRequirements,
            semanticRequirements: aiRequirements.artifacts,
            project,
        });
        const normalized = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [
                ...(inputType === 'xlsx_constraints' && localConstraints.length
                    ? localConversion.rows
                    : []),
                ...aiConversion.rows,
            ],
            source: inputType === 'xlsx_constraints' && localConstraints.length ? 'mixed_xlsx' : aiSource,
            inputType,
            contextStats,
            originalText: text,
            semanticRequirements: aiRequirements.artifacts,
            sourceRequirements,
            initialWarnings: [
                ...aiExtractWarnings,
                ...warnings,
                ...aiConversion.warningItems,
                ...aiRequirements.warnings,
            ],
            rejected: [
                ...aiConversion.rejected,
                ...aiRequirements.rejected,
            ],
        });
        return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: normalized, env, fetchImpl });
    } catch (error) {
        if (error instanceof TimetableRuleParseError && ['ai_not_configured', 'missing_fetch'].includes(error.reason)) {
            const fallback = parseConstraintsWithLocalFallback({ project, text, inputType, contextStats, constraintRows, sourceRequirements, error });
            return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: fallback, env, fetchImpl });
        }
        throw error;
    }
}

async function parseRosterWorkbookRules({ file, project, env, fetchImpl }) {
    const preview = previewTimetableRosterFile(file, { project });
    const contextStats = rosterContext(preview);
    const rosterProject = projectWithRosterPreview(project, preview);
    void env;
    void fetchImpl;
    return normalizeRosterFallback({
        project: rosterProject,
        preview,
        contextStats,
    });
}

async function parseConstraintWorkbookRules({ classified, file, project, env, fetchImpl }) {
    const extracted = constraintsTextFromSheet(classified);
    const contextStats = {
        rowCount: extracted.rows.length,
        sheetName: classified.sheet.name,
    };
    return parseAiOrLocal({
        project,
        text: extracted.text,
        inputType: 'xlsx_constraints',
        contextStats,
        constraintRows: extracted.rows,
        fileName: file?.filename || '',
        env,
        fetchImpl,
    });
}

function uploadText(file = {}) {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length <= 0) {
        throw new TimetableRuleParseError('上传的约束文件为空。', 'empty_file', 400);
    }
    if (file.buffer.length > MAX_RULE_FILE_BYTES) {
        throw new TimetableRuleParseError('约束文件不能超过 5MB。', 'file_too_large', 413);
    }
    return file.buffer.toString('utf8');
}

export async function parseTimetableRules({
    text = '',
    file = null,
    project: inputProject = {},
    env = process.env,
    fetchImpl,
} = {}) {
    const project = normalizeTimetableProject(inputProject);

    if (file?.buffer) {
        const ext = path.extname(file.filename || '').toLowerCase();
        if (['.xlsx', '.xls'].includes(ext)) {
            const cacheKey = parseCacheKey({ content: file.buffer, inputType: 'xlsx', project, env });
            const producer = async () => {
                const sheets = workbookSheets(file);
                const classified = classifyWorkbook(sheets);
                if (classified.inputType === 'xlsx_roster') {
                    return parseRosterWorkbookRules({ file, project, env, fetchImpl });
                }
                return parseConstraintWorkbookRules({ classified, file, project, env, fetchImpl });
            };
            if (persistentParseCacheEnabled(env)) {
                return parseWithPersistentCache({ cacheKey, env, producer });
            }
            const cached = getParseCache(cacheKey);
            if (cached) {
                return withParseMetadata(cached, { cacheKey, cacheHit: true, env });
            }
            const normalizedResult = withParseMetadata(await producer(), { cacheKey, cacheHit: false, env });
            setParseCache(cacheKey, normalizedResult);
            return normalizedResult;
        }
        if (['.txt', '.csv'].includes(ext)) {
            const fileText = uploadText(file);
            const combinedText = cleanRulePromptText([text, fileText].filter(Boolean).join('\n'));
            const inputType = ext === '.csv' ? 'csv_text' : 'txt';
            const cacheKey = parseCacheKey({ content: combinedText, inputType, project, env });
            const producer = () => parseAiOrLocal({
                project, text: combinedText, inputType, fileName: file.filename || '', env, fetchImpl,
            });
            if (persistentParseCacheEnabled(env)) return parseWithPersistentCache({ cacheKey, env, producer });
            return withParseMetadata(await producer(), { cacheKey, cacheHit: false, env });
        }
        throw new TimetableRuleParseError('智能约束文件只支持 .txt、.csv、.xlsx、.xls。', 'unsupported_file_type', 400);
    }

    const prompt = cleanRulePromptText(text);
    if (!prompt) {
        throw new TimetableRuleParseError('请先输入要解析的排课约束。', 'empty_prompt', 400);
    }

    const cacheKey = parseCacheKey({ content: prompt, inputType: 'text', project, env });
    const producer = () => parseAiOrLocal({ project, text: prompt, inputType: 'text', env, fetchImpl });
    if (persistentParseCacheEnabled(env)) return parseWithPersistentCache({ cacheKey, env, producer });
    return withParseMetadata(await producer(), { cacheKey, cacheHit: false, env });
}
