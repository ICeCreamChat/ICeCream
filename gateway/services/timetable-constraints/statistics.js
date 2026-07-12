function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function uniqueIds(items = [], fields = ['id']) {
    const ids = new Set();
    let anonymous = 0;
    for (const item of asArray(items)) {
        const id = fields.map(field => item?.[field]).find(Boolean);
        if (id) ids.add(String(id));
        else anonymous += 1;
    }
    return ids.size + anonymous;
}

function countUniqueSources(items = [], fallbackFields = []) {
    const ids = new Set();
    let anonymous = 0;
    for (const item of asArray(items)) {
        const id = item?.sourceId
            || item?.source?.sourceId
            || fallbackFields.map(field => item?.[field]).find(Boolean);
        if (id) ids.add(String(id));
        else anonymous += 1;
    }
    return ids.size + anonymous;
}

function sourceCategory(source = {}) {
    const explicit = String(source.status || '').trim().toLowerCase();
    if (['understood', 'needs_clarification', 'partially_supported', 'unsupported', 'irrelevant'].includes(explicit)) {
        return explicit;
    }
    if (explicit === 'actionable') return 'understood';
    if (explicit === 'partially_actionable') return 'partially_supported';
    if (explicit === 'understood_not_executable') return 'unsupported';

    const understanding = String(source.understandingStatus || '').trim().toLowerCase();
    const execution = String(source.executionStatus || '').trim().toLowerCase();
    if (understanding === 'irrelevant') return 'irrelevant';
    if (['ambiguous', 'invalid_reference', 'unrecognized', 'partially_parsed'].includes(understanding)) {
        return 'needs_clarification';
    }
    if (execution === 'partially_executable') return 'partially_supported';
    if (['blocked_by_reference', 'blocked_by_clarification'].includes(execution)) return 'needs_clarification';
    if (['unsupported', 'unsupported_by_solver', 'conflicted'].includes(execution)) return 'unsupported';
    if (understanding === 'parsed' || execution === 'executable') return 'understood';
    return 'needs_clarification';
}

function isNeedsReview(source = {}) {
    return sourceCategory(source) === 'needs_clarification'
        || source.status === 'needs_review'
        || ['blocked_by_reference', 'blocked_by_clarification', 'unsupported_by_solver', 'conflicted'].includes(source.executionStatus);
}

function sourceHasExecution(source = {}, executionStatus = '') {
    return source.executionStatus === executionStatus
        || asArray(source.clauses).some(clause => clause?.executionStatus === executionStatus);
}

export function buildRequirementStatistics({
    sourceRequirements = [],
    systemSupplements = [],
    manualRequirements = [],
    clauses = null,
    machineRules = null,
    draftRows = [],
    semanticActions = [],
} = {}) {
    const sources = asArray(sourceRequirements);
    const allClauses = clauses === null
        ? sources.flatMap(source => asArray(source.clauses))
        : asArray(clauses);
    const rows = asArray(machineRules === null ? draftRows : machineRules);
    const userSources = sources.filter(source => source.origin === 'user_input');
    const manualSources = sources.filter(source => source.origin === 'manual');
    const manualInputs = [
        ...manualSources,
        ...asArray(manualRequirements).filter(item => !item?.origin || item.origin === 'manual'),
    ];
    const parsedSources = sources.filter(source => source.understandingStatus === 'parsed');
    const partiallyParsedSources = sources.filter(source => source.understandingStatus === 'partially_parsed');
    const unrecognizedSources = sources.filter(source => source.understandingStatus === 'unrecognized');
    const categories = sources.map(sourceCategory);
    const executableRows = rows.filter(row => ['effective', 'executable', 'handled', 'suggestion'].includes(row.status || row.executionStatus));
    const unsupportedRows = rows.filter(row => ['unsupported', 'unsupported_by_solver'].includes(row.status || row.executionStatus));

    return {
        sourceRequirementCount: sources.length,
        userInputCount: userSources.length,
        manualInputCount: countUniqueSources(manualInputs, ['requirementId', 'id']),
        systemSupplementCount: uniqueIds(systemSupplements, ['supplementId', 'sourceId', 'id']),
        understoodSourceCount: categories.filter(category => category === 'understood').length,
        needsClarificationSourceCount: categories.filter(category => category === 'needs_clarification').length,
        partiallySupportedSourceCount: categories.filter(category => category === 'partially_supported').length,
        unsupportedSourceCount: categories.filter(category => category === 'unsupported').length,
        irrelevantSourceCount: categories.filter(category => category === 'irrelevant').length,
        parsedCount: parsedSources.length,
        partiallyParsedCount: partiallyParsedSources.length,
        needsReviewCount: sources.filter(isNeedsReview).length,
        blockedReferenceSourceCount: sources.filter(source => sourceHasExecution(source, 'blocked_by_reference')).length,
        blockedClarificationSourceCount: sources.filter(source => sourceHasExecution(source, 'blocked_by_clarification')).length,
        unsupportedSolverSourceCount: sources.filter(source => sourceHasExecution(source, 'unsupported_by_solver')).length,
        unrecognizedCount: unrecognizedSources.length,
        clauseCount: uniqueIds(allClauses, ['clauseId', 'id']),
        machineRuleCount: uniqueIds(rows, ['machineRuleId', 'id', 'stableKey']),
        executableMachineRuleCount: uniqueIds(executableRows, ['machineRuleId', 'id', 'stableKey']),
        unsupportedMachineRuleCount: uniqueIds(unsupportedRows, ['machineRuleId', 'id', 'stableKey']),
        draftRowCount: asArray(draftRows).length,
        semanticActionCount: uniqueIds(semanticActions, ['id', 'semanticActionId', 'rowId', 'requirementId']),
    };
}
