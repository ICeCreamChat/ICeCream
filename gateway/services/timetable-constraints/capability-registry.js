import {
    CAPABILITY_SUPPORT_LEVELS,
    CONSTRAINT_LANDINGS,
    normalizeConstraintIR,
    validateConstraintIR,
} from './constraint-ir.js';

function text(value = '', max = 1000) {
    return String(value ?? '').trim().slice(0, max);
}

export function normalizeCapabilityAlias(value = '') {
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

function uniqueStrings(values = [], max = 300) {
    return [...new Set(asArray(values).map(value => text(value, max)).filter(Boolean))];
}

function normalizeLanding(value) {
    return uniqueStrings(value, 80)
        .map(normalizeCapabilityAlias)
        .filter(item => CONSTRAINT_LANDINGS.has(item));
}

function normalizeDefinition(definition = {}) {
    const id = text(definition.id || definition.capabilityId || '', 160).toLowerCase();
    if (!id) throw new Error('Capability id is required.');
    const aliases = uniqueStrings([
        id,
        ...asArray(definition.aliases),
        ...asArray(definition.intents),
        ...asArray(definition.rowTypes),
    ], 160).map(normalizeCapabilityAlias);
    const objectTypes = uniqueStrings(definition.objectTypes || ['global'], 80).map(normalizeCapabilityAlias);
    const requiredParameters = uniqueStrings(definition.requiredParameters || [], 160);
    const defaultStrength = normalizeCapabilityAlias(definition.defaultStrength || 'soft') === 'hard' ? 'hard' : 'soft';
    const solverSupport = normalizeCapabilityAlias(definition.solverSupport || definition.support || 'none');
    if (!CAPABILITY_SUPPORT_LEVELS.has(solverSupport)) {
        throw new Error(`Capability ${id} has invalid solver support: ${solverSupport}`);
    }
    const landing = normalizeLanding(definition.landing || 'review');
    if (!landing.length) throw new Error(`Capability ${id} must declare at least one landing.`);
    return {
        ...definition,
        id,
        version: Number.isInteger(Number(definition.version)) ? Number(definition.version) : 1,
        aliases,
        intents: uniqueStrings(definition.intents || [], 160).map(normalizeCapabilityAlias),
        rowTypes: uniqueStrings(definition.rowTypes || [], 160).map(normalizeCapabilityAlias),
        objectTypes,
        requiredParameters,
        defaultStrength,
        solverSupport,
        landing,
        machineRuleTypes: uniqueStrings(definition.machineRuleTypes || [], 160).map(normalizeCapabilityAlias),
        fulfillmentEvaluable: definition.fulfillmentEvaluable === true,
        validate: typeof definition.validate === 'function' ? definition.validate : null,
        compile: typeof definition.compile === 'function' ? definition.compile : null,
        explain: typeof definition.explain === 'function' ? definition.explain : null,
    };
}

export function createConstraintCapabilityRegistry(definitions = [], options = {}) {
    const registry = {
        capabilities: new Map(),
        aliases: new Map(),
        legacyCompiler: typeof options.legacyCompiler === 'function' ? options.legacyCompiler : null,
        version: Number.isInteger(Number(options.version)) ? Number(options.version) : 1,
    };
    asArray(definitions).forEach(definition => registerConstraintCapability(registry, definition));
    return registry;
}

function assertRegistry(registry) {
    if (!registry?.capabilities || !registry?.aliases) throw new Error('Invalid capability registry.');
}

export function registerConstraintCapability(registry, definition = {}) {
    assertRegistry(registry);
    const normalized = normalizeDefinition(definition);
    if (registry.capabilities.has(normalized.id)) {
        throw new Error(`Capability id already registered: ${normalized.id}`);
    }
    for (const alias of normalized.aliases) {
        const existingId = registry.aliases.get(alias);
        if (existingId && existingId !== normalized.id) {
            throw new Error(`Capability alias already registered: ${alias} -> ${existingId}`);
        }
    }
    registry.capabilities.set(normalized.id, normalized);
    normalized.aliases.forEach(alias => registry.aliases.set(alias, normalized.id));
    return normalized;
}

export function resolveConstraintCapability(registry, value = '') {
    assertRegistry(registry);
    if (value && typeof value === 'object') {
        const candidates = [value.capabilityId, value.capability, value.type, value.rowType, value.intent];
        for (const candidate of candidates) {
            const resolved = resolveConstraintCapability(registry, candidate);
            if (resolved) return resolved;
        }
        return null;
    }
    const raw = text(value, 160).toLowerCase();
    if (!raw) return null;
    if (registry.capabilities.has(raw)) return registry.capabilities.get(raw);
    const id = registry.aliases.get(normalizeCapabilityAlias(raw));
    return id ? registry.capabilities.get(id) || null : null;
}

export function listConstraintCapabilities(registry) {
    assertRegistry(registry);
    return [...registry.capabilities.values()]
        .map(definition => ({ ...definition }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

function getPath(value = {}, path = '') {
    return String(path || '').split('.').filter(Boolean).reduce((current, name) => current?.[name], value);
}

function parameterValue(ir = {}, name = '') {
    const candidates = [
        getPath(ir.parameters, name),
        getPath(ir.time, name),
        getPath(ir.scope, name),
        getPath(ir.relation, name),
        getPath(ir, name),
    ];
    return candidates.find(value => value !== undefined && value !== null && value !== '');
}

function hasValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== undefined && value !== null && value !== '';
}

function normalizeValidationResult(result = {}) {
    const errors = asArray(result.errors).filter(Boolean);
    const supportWarnings = uniqueStrings(result.supportWarnings || [], 500);
    const warnings = uniqueStrings([...asArray(result.warnings), ...supportWarnings], 500);
    const clarifications = uniqueStrings([...asArray(result.clarifications), ...asArray(result.questions)], 500);
    return {
        valid: result.valid === undefined ? errors.length === 0 : Boolean(result.valid) && errors.length === 0,
        errors,
        warnings,
        supportWarnings,
        clarifications,
    };
}

export function validateCapabilityIR(registry, input = {}, context = {}) {
    assertRegistry(registry);
    const ir = normalizeConstraintIR(input);
    const schemaValidation = validateConstraintIR(ir, { normalize: false });
    const capability = resolveConstraintCapability(registry, ir);
    const errors = [...schemaValidation.errors];
    const warnings = [...ir.warnings];
    const supportWarnings = [];
    const clarifications = [...ir.clarifications];

    if (!capability) {
        errors.push({ code: 'unknown_capability', message: `能力 ${ir.capabilityId || ir.intent || '(missing)'} 尚未注册。`, path: 'capabilityId' });
        warnings.push('该语义已保留为 ConstraintIR，但当前能力注册表没有可执行编译器。');
        return normalizeValidationResult({ valid: false, errors, warnings, supportWarnings, clarifications });
    }

    if (capability.objectTypes.length && !capability.objectTypes.includes(ir.target.kind)) {
        errors.push({
            code: 'invalid_object_type',
            message: `能力 ${capability.id} 不支持对象类型 ${ir.target.kind || '(missing)'}。`,
            path: 'target.kind',
        });
    }
    for (const name of capability.requiredParameters) {
        if (hasValue(parameterValue(ir, name))) continue;
        errors.push({ code: 'missing_parameter', message: `缺少必要参数：${name}。`, path: `parameters.${name}` });
        clarifications.push(`请补充“${name}”后再应用这条约束。`);
    }

    if (capability.validate) {
        const custom = normalizeValidationResult(capability.validate(ir, context) || {});
        errors.push(...custom.errors);
        warnings.push(...custom.warnings);
        clarifications.push(...custom.clarifications);
    }
    if (capability.solverSupport === 'none') {
        supportWarnings.push('这条需求已理解，但当前求解器尚不支持自动执行。');
    } else if (capability.solverSupport === 'partial') {
        supportWarnings.push('这条需求当前只能由求解器部分或近似执行。');
    }
    return normalizeValidationResult({ valid: errors.length === 0, errors, warnings, supportWarnings, clarifications });
}

function normalizeCompileResult(result) {
    if (Array.isArray(result)) return { rows: result, warnings: [], clarifications: [] };
    if (!result || typeof result !== 'object') return { rows: [], warnings: [], clarifications: [] };
    return {
        rows: asArray(result.rows).filter(Boolean),
        warnings: uniqueStrings(result.warnings || [], 500),
        clarifications: uniqueStrings([...asArray(result.clarifications), ...asArray(result.questions)], 500),
    };
}

function decorateRow(row = {}, ir = {}, capability = {}, index = 0) {
    const targetId = ir.target.matchedIds[index] || ir.target.matchedIds[0] || '';
    return {
        ...row,
        id: row.id || `${ir.clauseId}:compiled:${index + 1}`,
        requirementId: row.requirementId || ir.clauseId,
        clauseId: ir.clauseId,
        sourceId: ir.sourceId,
        textHash: ir.textHash,
        origin: ir.origin,
        parsedBy: [...ir.parsedBy],
        normalizationTrace: row.normalizationTrace?.length ? row.normalizationTrace : (ir.normalizationTrace || []),
        negation: row.negation ?? ir.negation ?? null,
        exceptions: row.exceptions?.length ? row.exceptions : (ir.exceptions || []),
        activity: row.activity ?? ir.activity ?? null,
        capabilityId: capability.id,
        constraintIrVersion: ir.schemaVersion,
        targetType: row.targetType || ir.target.kind,
        targetId: row.targetId || targetId,
        targetName: row.targetName || ir.target.name,
        priority: row.priority || ir.strength,
        status: row.status || (ir.executionStatus === 'executable' ? 'effective' : 'suggestion'),
        rawText: row.rawText || ir.evidence?.[0]?.quote || '',
        generatedBy: 'capability_registry',
        compilerVersion: capability.version,
    };
}

export function compileConstraintIR(registry, input = {}, context = {}) {
    assertRegistry(registry);
    const ir = normalizeConstraintIR(input);
    const capability = resolveConstraintCapability(registry, ir);
    const validation = validateCapabilityIR(registry, ir, context);
    const result = {
        valid: validation.valid,
        ir,
        capability,
        rows: [],
        errors: validation.errors,
        warnings: validation.warnings,
        supportWarnings: validation.supportWarnings,
        clarifications: validation.clarifications,
    };
    if (!capability || !validation.valid || !ir.enabled) return result;
    const deferredReviewCompile = context.deferEntityValidation === true
        && Boolean(ir.parameters?.legacyRow)
        && ['invalid_reference', 'partially_parsed'].includes(ir.understandingStatus);
    if (!['executable', 'partially_executable'].includes(ir.executionStatus) && !deferredReviewCompile) return result;
    if (capability.solverSupport === 'none') return result;

    let compiled = null;
    if (capability.compile) {
        compiled = capability.compile(ir, context);
    } else if (registry.legacyCompiler) {
        compiled = registry.legacyCompiler({
            ...ir,
            id: ir.clauseId,
            object: ir.target,
            condition: ir.time,
            applyTo: capability.landing[0] || 'review',
        }, context.project || context);
    }
    const normalized = normalizeCompileResult(compiled);
    result.rows = normalized.rows.map((row, index) => decorateRow(row, ir, capability, index));
    result.warnings = uniqueStrings([...result.warnings, ...normalized.warnings], 500);
    result.clarifications = uniqueStrings([...result.clarifications, ...normalized.clarifications], 500);
    return result;
}

export function explainConstraintIR(registry, input = {}, context = {}) {
    assertRegistry(registry);
    const ir = normalizeConstraintIR(input);
    const capability = resolveConstraintCapability(registry, ir);
    if (capability?.explain) return text(capability.explain(ir, context), 1000);
    if (!capability) return `已识别意图“${ir.intent || ir.capabilityId}”，但尚无已注册的执行能力。`;
    return `已识别能力“${capability.id}”。`;
}
