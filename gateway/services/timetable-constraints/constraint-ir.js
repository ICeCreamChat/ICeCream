export const CONSTRAINT_IR_SCHEMA_VERSION = 1;
export const CONSTRAINT_IR_KIND = 'ConstraintIR';

export const UNDERSTANDING_STATUSES = new Set([
    'parsed',
    'partially_parsed',
    'ambiguous',
    'invalid_reference',
    'unrecognized',
    'irrelevant',
]);

export const EXECUTION_STATUSES = new Set([
    'executable',
    'partially_executable',
    'unsupported_by_solver',
    'conflicted',
    'disabled',
]);

export const REVIEW_STATUSES = new Set([
    'understood',
    'needs_clarification',
    'partially_supported',
    'unsupported',
    'irrelevant',
]);

export const CAPABILITY_SUPPORT_LEVELS = new Set(['full', 'partial', 'none']);
export const CONSTRAINT_LANDINGS = new Set([
    'rule',
    'lesson_plan',
    'optimization',
    'solver_policy',
    'clarification',
    'review',
]);

function text(value = '', max = 1000) {
    return String(value ?? '').trim().slice(0, max);
}

function key(value = '') {
    return text(value, 160)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function uniqueStrings(values = [], max = 1000) {
    return [...new Set(asArray(values).map(value => text(value, max)).filter(Boolean))];
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(name => [name, stableValue(value[name])]));
    }
    return value;
}

function stableJson(value) {
    return JSON.stringify(stableValue(value));
}

function uniqueObjects(values = []) {
    const seen = new Set();
    const result = [];
    for (const value of asArray(values)) {
        if (!value || typeof value !== 'object') continue;
        const normalized = stableValue(value);
        const fingerprint = stableJson(normalized);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        result.push(normalized);
    }
    return result;
}

function normalizeTarget(target = {}) {
    const candidate = target && typeof target === 'object' ? target : {};
    return {
        ...candidate,
        kind: key(candidate.kind || candidate.type || 'global') || 'global',
        name: text(candidate.name || candidate.label || '', 240),
        matchedIds: uniqueStrings(candidate.matchedIds || candidate.ids || candidate.id, 160),
        scope: key(candidate.scope || 'explicit') || 'explicit',
        candidates: uniqueObjects(candidate.candidates),
    };
}

function normalizeLanding(value) {
    return uniqueStrings(value, 80)
        .map(key)
        .filter(item => CONSTRAINT_LANDINGS.has(item));
}

function defaultSupportForExecution(executionStatus) {
    if (executionStatus === 'executable') return 'full';
    if (executionStatus === 'partially_executable') return 'partial';
    return 'none';
}

export function deriveConstraintReviewStatus(understandingStatus = '', executionStatus = '') {
    if (understandingStatus === 'irrelevant') return 'irrelevant';
    if (['partially_parsed', 'ambiguous', 'invalid_reference', 'unrecognized'].includes(understandingStatus)) {
        return 'needs_clarification';
    }
    if (executionStatus === 'conflicted') return 'needs_clarification';
    if (executionStatus === 'partially_executable') return 'partially_supported';
    if (executionStatus === 'unsupported_by_solver') return 'unsupported';
    if (executionStatus === 'executable' || executionStatus === 'disabled') return 'understood';
    return 'needs_clarification';
}

export function normalizeConstraintIR(input = {}, defaults = {}) {
    const candidate = input && typeof input === 'object' ? input : {};
    const fallback = defaults && typeof defaults === 'object' ? defaults : {};
    const understandingStatus = UNDERSTANDING_STATUSES.has(candidate.understandingStatus)
        ? candidate.understandingStatus
        : UNDERSTANDING_STATUSES.has(fallback.understandingStatus)
            ? fallback.understandingStatus
            : 'unrecognized';
    const executionStatus = EXECUTION_STATUSES.has(candidate.executionStatus)
        ? candidate.executionStatus
        : EXECUTION_STATUSES.has(fallback.executionStatus)
            ? fallback.executionStatus
            : 'unsupported_by_solver';
    const supportCandidate = key(candidate.support || candidate.solverSupport || fallback.support || '');
    const support = CAPABILITY_SUPPORT_LEVELS.has(supportCandidate)
        ? supportCandidate
        : defaultSupportForExecution(executionStatus);
    const capabilityId = text(candidate.capabilityId || candidate.capability || fallback.capabilityId || '', 160).toLowerCase();
    const intent = key(candidate.intent || candidate.type || fallback.intent || capabilityId);
    const reviewStatus = deriveConstraintReviewStatus(understandingStatus, executionStatus);
    const target = normalizeTarget(candidate.target || candidate.object || fallback.target || fallback.object || {});
    const warnings = uniqueStrings([
        ...asArray(fallback.warnings),
        ...asArray(candidate.warnings),
    ], 500);
    const clarifications = uniqueStrings([
        ...asArray(fallback.clarifications),
        ...asArray(fallback.questions),
        ...asArray(candidate.clarifications),
        ...asArray(candidate.questions),
    ], 500);
    const parsedBy = uniqueStrings([
        ...asArray(fallback.parsedBy),
        ...asArray(candidate.parsedBy),
    ], 80);
    const landing = normalizeLanding(candidate.landing || candidate.applyTo || fallback.landing || fallback.applyTo || []);

    return {
        ...candidate,
        kind: CONSTRAINT_IR_KIND,
        schemaVersion: CONSTRAINT_IR_SCHEMA_VERSION,
        constraintId: text(candidate.constraintId || candidate.irId || candidate.clauseId || fallback.constraintId || '', 300),
        clauseId: text(candidate.clauseId || fallback.clauseId || '', 300),
        sourceId: text(candidate.sourceId || candidate.source?.sourceId || fallback.sourceId || '', 300),
        textHash: text(candidate.textHash || candidate.source?.textHash || fallback.textHash || '', 160),
        origin: key(candidate.origin || candidate.source?.origin || fallback.origin || 'unknown') || 'unknown',
        parsedBy,
        capabilityId,
        intent,
        target,
        scope: candidate.scope && typeof candidate.scope === 'object' ? stableValue(candidate.scope) : {},
        time: candidate.time && typeof candidate.time === 'object' ? stableValue(candidate.time) : {},
        relation: candidate.relation && typeof candidate.relation === 'object' ? stableValue(candidate.relation) : {},
        parameters: candidate.parameters && typeof candidate.parameters === 'object' ? stableValue(candidate.parameters) : {},
        strength: key(candidate.strength || candidate.priority || fallback.strength || 'soft') === 'hard' ? 'hard' : 'soft',
        priority: Number.isFinite(Number(candidate.priorityWeight ?? candidate.weight ?? fallback.priorityWeight))
            ? Number(candidate.priorityWeight ?? candidate.weight ?? fallback.priorityWeight)
            : null,
        understandingStatus,
        executionStatus,
        reviewStatus,
        support,
        landing,
        machineRuleIds: uniqueStrings(candidate.machineRuleIds || [], 300),
        warnings,
        clarifications,
        evidence: uniqueObjects(candidate.evidence || []),
        explanation: text(candidate.explanation || fallback.explanation || '', 1000),
        confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : null,
        enabled: candidate.enabled !== false,
    };
}

function validationError(code, message, path = '') {
    return { code, message, path };
}

export function validateConstraintIR(input = {}, options = {}) {
    const ir = options.normalize === false ? input : normalizeConstraintIR(input, options.defaults || {});
    const errors = [];
    if (!ir || typeof ir !== 'object') {
        return {
            valid: false,
            errors: [validationError('invalid_ir', 'ConstraintIR 必须是对象。')],
            value: ir,
        };
    }
    if (ir.kind !== CONSTRAINT_IR_KIND) errors.push(validationError('invalid_kind', 'kind 必须为 ConstraintIR。', 'kind'));
    if (Number(ir.schemaVersion) !== CONSTRAINT_IR_SCHEMA_VERSION) {
        errors.push(validationError('invalid_schema_version', `schemaVersion 必须为 ${CONSTRAINT_IR_SCHEMA_VERSION}。`, 'schemaVersion'));
    }
    if (!text(ir.sourceId, 300)) errors.push(validationError('missing_source_id', '缺少 sourceId。', 'sourceId'));
    if (!text(ir.clauseId, 300)) errors.push(validationError('missing_clause_id', '缺少 clauseId。', 'clauseId'));
    if (!text(ir.capabilityId, 160)) errors.push(validationError('missing_capability_id', '缺少 capabilityId。', 'capabilityId'));
    if (!UNDERSTANDING_STATUSES.has(ir.understandingStatus)) {
        errors.push(validationError('invalid_understanding_status', 'understandingStatus 不在允许枚举内。', 'understandingStatus'));
    }
    if (!EXECUTION_STATUSES.has(ir.executionStatus)) {
        errors.push(validationError('invalid_execution_status', 'executionStatus 不在允许枚举内。', 'executionStatus'));
    }
    if (!REVIEW_STATUSES.has(ir.reviewStatus)) {
        errors.push(validationError('invalid_review_status', 'reviewStatus 不在允许枚举内。', 'reviewStatus'));
    }
    if (ir.support && !CAPABILITY_SUPPORT_LEVELS.has(ir.support)) {
        errors.push(validationError('invalid_support', 'support 必须为 full、partial 或 none。', 'support'));
    }
    if (ir.landing && (!Array.isArray(ir.landing) || ir.landing.some(item => !CONSTRAINT_LANDINGS.has(item)))) {
        errors.push(validationError('invalid_landing', 'landing 包含未知落点。', 'landing'));
    }
    return { valid: errors.length === 0, errors, value: ir };
}

function aggregateUnderstanding(statuses = []) {
    if (!statuses.length) return 'unrecognized';
    if (statuses.every(status => status === 'irrelevant')) return 'irrelevant';
    const relevantStatuses = statuses.filter(status => status !== 'irrelevant');
    if (relevantStatuses.every(status => status === 'parsed')) return 'parsed';
    const issueStatuses = relevantStatuses.filter(status => (
        ['ambiguous', 'invalid_reference', 'unrecognized', 'partially_parsed'].includes(status)
    ));
    if (!issueStatuses.length) return 'partially_parsed';
    if (relevantStatuses.some(status => status === 'parsed')) return 'partially_parsed';
    for (const status of ['unrecognized', 'invalid_reference', 'ambiguous', 'partially_parsed']) {
        if (issueStatuses.includes(status)) return status;
    }
    return 'partially_parsed';
}

function aggregateExecution(statuses = []) {
    if (!statuses.length) return 'unsupported_by_solver';
    if (statuses.every(status => status === 'disabled')) return 'disabled';
    if (statuses.some(status => status === 'conflicted')) return 'conflicted';
    if (statuses.every(status => status === 'executable' || status === 'disabled')) return 'executable';
    if (statuses.some(status => ['executable', 'partially_executable'].includes(status))) return 'partially_executable';
    return 'unsupported_by_solver';
}

export function aggregateConstraintIRStatuses(values = []) {
    const irs = asArray(values).map(value => normalizeConstraintIR(value));
    const understandingStatus = aggregateUnderstanding(irs.map(ir => ir.understandingStatus));
    const executionStatus = aggregateExecution(irs.map(ir => ir.executionStatus));
    return {
        understandingStatus,
        executionStatus,
        reviewStatus: deriveConstraintReviewStatus(understandingStatus, executionStatus),
    };
}
