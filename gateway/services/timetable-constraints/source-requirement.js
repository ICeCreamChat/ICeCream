import {
    SOURCE_SCHEMA_VERSION,
    buildClauseId,
    buildMachineRuleId,
    buildSourceId,
    buildTextHash,
    normalizeSourceDisplayText,
    normalizeSourceText,
    validateUniqueSourceIds,
} from './source-identity.js';

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}
function uniqueStrings(values = []) {
    return [...new Set(asArray(values).map(value => normalizeSourceText(value)).filter(Boolean))];
}

function rawTextFromRow(row = {}) {
    return normalizeSourceDisplayText(
        row.rawText
        ?? row.constraintText
        ?? row.text
        ?? row.description
        ?? row.reason
        ?? ''
    );
}

function normalizeOrigin(value = '', fallback = 'user_input') {
    const origin = normalizeSourceText(value || fallback).toLowerCase();
    if (['user_input', 'manual', 'system_supplement', 'unknown'].includes(origin)) return origin;
    return fallback;
}

function sourceKind(row = {}, context = {}) {
    const inputType = normalizeSourceText(row.inputType || context.inputType || '').toLowerCase();
    if (row.sourceSheet || row.sheetName || inputType.startsWith('xlsx')) return 'xlsx';
    if (inputType === 'csv_text' || inputType === 'csv') return 'csv';
    if (inputType === 'txt') return 'txt';
    if (inputType === 'manual' || normalizeOrigin(row.origin || context.origin) === 'manual') return 'manual';
    return 'text';
}

function locationForRow(row = {}, context = {}, index = 0) {
    const rowNumber = Number(row.sourceRow ?? row.rowNumber);
    const lineNumber = Number(row.lineNumber ?? (Number.isInteger(rowNumber) ? null : index + 1));
    return {
        kind: sourceKind(row, context),
        inputType: normalizeSourceText(row.inputType || context.inputType || 'text'),
        fileName: normalizeSourceText(row.fileName || context.fileName || ''),
        sheetName: normalizeSourceText(row.sourceSheet || row.sheetName || context.sourceSheet || context.sheetName || ''),
        rowNumber: Number.isInteger(rowNumber) && rowNumber > 0 ? rowNumber : null,
        lineNumber: Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null,
        sourceIndex: index,
    };
}

export function buildSourceRequirement(row = {}, context = {}, index = 0) {
    const rawText = rawTextFromRow(row);
    const location = locationForRow(row, context, index);
    const textHash = normalizeSourceText(row.textHash || row.source?.textHash || '') || buildTextHash(rawText);
    const origin = normalizeOrigin(row.origin || context.origin, 'user_input');
    const sourceId = normalizeSourceText(row.sourceId || '') || buildSourceId({
        ...location,
        rawText,
        uploadId: row.uploadId || context.uploadId || '',
    }, context);
    return {
        sourceId,
        origin,
        source: {
            kind: location.kind,
            inputType: location.inputType,
            fileName: location.fileName,
            sheetName: location.sheetName,
            rowNumber: location.rowNumber,
            lineNumber: location.lineNumber,
            rawText,
            textHash,
        },
        rawText,
        textHash,
        status: 'needs_review',
        understandingStatus: 'unrecognized',
        executionStatus: 'unsupported_by_solver',
        parsedBy: uniqueStrings(asArray(row.parsedBy)),
        clauses: asArray(row.clauses),
        machineRuleIds: uniqueStrings(asArray(row.machineRuleIds)),
        warnings: uniqueStrings(asArray(row.warnings)),
        questions: uniqueStrings([
            ...asArray(row.questions),
            ...asArray(row.clarifications),
        ]),
        confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
        enabled: row.enabled !== false,
        schemaVersion: SOURCE_SCHEMA_VERSION,
    };
}

export function buildSourceRequirements(inputRows = [], context = {}) {
    const result = asArray(inputRows)
        .map((row, index) => buildSourceRequirement(row, context, index))
        .filter(item => item.source.rawText);
    const validation = validateUniqueSourceIds(result);
    if (!validation.valid) {
        throw new Error(`Duplicate timetable source identities: ${validation.duplicates.join(', ')}`);
    }
    return result;
}

export function sourceInputRowsFromText(text = '', context = {}) {
    const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const rows = [];
    lines.forEach((line, index) => {
        const rawText = normalizeSourceDisplayText(line);
        if (!rawText) return;
        rows.push({
            rawText,
            lineNumber: index + 1,
            inputType: context.inputType || 'text',
            origin: context.origin || 'user_input',
        });
    });
    const fallbackRawText = normalizeSourceDisplayText(normalized);
    if (!rows.length && fallbackRawText) {
        rows.push({
            rawText: fallbackRawText,
            lineNumber: 1,
            inputType: context.inputType || 'text',
            origin: context.origin || 'user_input',
        });
    }
    return rows;
}

function artifactRawText(artifact = {}) {
    return normalizeSourceDisplayText(
        artifact.rawText
        ?? artifact.constraintText
        ?? artifact.text
        ?? artifact.source?.rawText
        ?? artifact.description
        ?? artifact.reason
        ?? artifact.reviewEvidence?.quote
        ?? ''
    );
}

function findSourceByIdentity(sourceRequirements = [], artifact = {}) {
    const sources = asArray(sourceRequirements);
    const requestedId = normalizeSourceText(artifact.sourceId || artifact.source?.sourceId || '');
    const requestedHash = normalizeSourceText(artifact.textHash || artifact.source?.textHash || '');
    const rawText = artifactRawText(artifact);
    const evidenceHash = requestedHash || (rawText ? buildTextHash(rawText) : '');
    const validateEvidenceHash = source => {
        if (evidenceHash && source.source.textHash !== evidenceHash) {
            return { source: null, reason: 'text_hash_mismatch' };
        }
        return { source, reason: '' };
    };

    if (requestedId) {
        const direct = sources.find(item => item.sourceId === requestedId);
        if (!direct) return { source: null, reason: 'unknown_source_id' };
        return validateEvidenceHash(direct);
    }

    const sourceSheet = normalizeSourceText(artifact.sourceSheet || artifact.sheetName || artifact.source?.sheetName || artifact.source?.sourceSheet || '');
    const sourceRow = Number(artifact.sourceRow ?? artifact.rowNumber ?? artifact.source?.rowNumber ?? artifact.source?.sourceRow);
    if (Number.isInteger(sourceRow) && sourceRow > 0) {
        const positional = sources.filter(item => item.source.rowNumber === sourceRow
            && (!sourceSheet || item.source.sheetName === sourceSheet));
        if (positional.length === 1) return validateEvidenceHash(positional[0]);
        if (positional.length > 1) return { source: null, reason: 'ambiguous_source_position' };
    }

    const lineNumber = Number(artifact.lineNumber ?? artifact.source?.lineNumber);
    if (Number.isInteger(lineNumber) && lineNumber > 0) {
        const positional = sources.filter(item => item.source.lineNumber === lineNumber);
        if (positional.length === 1) return validateEvidenceHash(positional[0]);
        if (positional.length > 1) return { source: null, reason: 'ambiguous_source_position' };
    }

    if (evidenceHash) {
        const matches = sources.filter(item => item.source.textHash === evidenceHash);
        if (matches.length === 1) return { source: matches[0], reason: '' };
        if (matches.length > 1) return { source: null, reason: 'ambiguous_text_hash' };
    }
    return { source: null, reason: 'missing_source_identity' };
}

export function linkArtifactToSource(artifact = {}, sourceRequirements = [], options = {}) {
    const { source, reason } = findSourceByIdentity(sourceRequirements, artifact);
    if (!source) {
        return {
            artifact: { ...artifact },
            source: null,
            reason,
        };
    }
    const artifactParser = typeof artifact.source === 'string' ? artifact.source : '';
    const parsedBy = uniqueStrings([
        ...asArray(source.parsedBy),
        ...asArray(artifact.parsedBy),
        ...asArray(options.parsedBy),
        ...asArray(artifact.generatedBy),
        ...asArray(artifactParser),
    ]);
    return {
        artifact: {
            ...artifact,
            sourceId: source.sourceId,
            textHash: source.source.textHash,
            origin: source.origin,
            sourceSheet: artifact.sourceSheet || source.source.sheetName || undefined,
            sourceRow: artifact.sourceRow || source.source.rowNumber || undefined,
            lineNumber: artifact.lineNumber || source.source.lineNumber || undefined,
            rawText: artifactRawText(artifact) || source.source.rawText,
            parsedBy,
        },
        source,
        reason: '',
    };
}

function canonicalClause(clause = {}, sourceRequirement = {}, index = 0) {
    const sourceId = sourceRequirement.sourceId;
    const clauseId = buildClauseId(sourceId, clause, index);
    return {
        ...clause,
        clauseId,
        id: clause.id || clauseId,
        sourceId,
        origin: sourceRequirement.origin,
        textHash: sourceRequirement.source.textHash,
        parsedBy: uniqueStrings([...asArray(sourceRequirement.parsedBy), ...asArray(clause.parsedBy)]),
    };
}

export function upsertClause(sourceRequirement = {}, clause = {}, index = 0) {
    const nextClause = canonicalClause(clause, sourceRequirement, index);
    const clauses = asArray(sourceRequirement.clauses);
    const existingIndex = clauses.findIndex(item => item.clauseId === nextClause.clauseId);
    const nextClauses = [...clauses];
    if (existingIndex >= 0) nextClauses[existingIndex] = { ...nextClauses[existingIndex], ...nextClause };
    else nextClauses.push(nextClause);
    return { ...sourceRequirement, clauses: nextClauses };
}

export function upsertMachineRule(sourceRequirement = {}, rule = {}, clauseId = '', index = 0) {
    const resolvedClauseId = clauseId || rule.clauseId || sourceRequirement.clauses?.[0]?.clauseId || buildClauseId(sourceRequirement.sourceId, rule, 0);
    const machineRuleId = buildMachineRuleId(sourceRequirement.sourceId, resolvedClauseId, rule, index);
    return {
        sourceRequirement: {
            ...sourceRequirement,
            machineRuleIds: uniqueStrings([...asArray(sourceRequirement.machineRuleIds), machineRuleId]),
        },
        machineRule: {
            ...rule,
            id: rule.id || machineRuleId,
            machineRuleId,
            sourceId: sourceRequirement.sourceId,
            clauseId: resolvedClauseId,
            origin: sourceRequirement.origin,
            textHash: sourceRequirement.source.textHash,
        },
    };
}

function understandingFromArtifacts(clauses = [], rows = []) {
    const statuses = [...clauses, ...rows].map(item => item.understandingStatus || item.status || '').filter(Boolean);
    if (!statuses.length) return 'unrecognized';
    if (statuses.every(status => status === 'irrelevant')) return 'irrelevant';
    if (statuses.some(status => ['ambiguous', 'invalid_reference', 'unrecognized', 'partially_parsed'].includes(status))) return 'partially_parsed';
    if (statuses.some(status => ['needs_review', 'unsupported', 'invalid'].includes(status))) return 'partially_parsed';
    return 'parsed';
}

function executionFromArtifacts(clauses = [], rows = []) {
    const statuses = [...clauses, ...rows].map(item => item.executionStatus || item.status || '').filter(Boolean);
    if (!statuses.length) return 'unsupported_by_solver';
    const executable = statuses.filter(status => ['executable', 'effective', 'handled', 'suggestion'].includes(status)).length;
    if (executable === statuses.length) return 'executable';
    if (executable > 0) return 'partially_executable';
    if (statuses.some(status => status === 'conflicted')) return 'conflicted';
    return 'unsupported_by_solver';
}

function displayStatus(understandingStatus, executionStatus) {
    if (understandingStatus === 'irrelevant') return 'irrelevant';
    if (['ambiguous', 'invalid_reference', 'unrecognized', 'partially_parsed'].includes(understandingStatus)) return 'needs_review';
    if (executionStatus === 'executable') return 'actionable';
    if (executionStatus === 'partially_executable') return 'partially_actionable';
    if (executionStatus === 'disabled') return 'disabled';
    return 'understood_not_executable';
}

export function attachArtifactsToSourceRequirements(sourceRequirements = [], {
    clauses = [],
    machineRules = [],
    parsedBy = '',
} = {}) {
    const result = asArray(sourceRequirements).map(item => ({
        ...item,
        parsedBy: uniqueStrings(item.parsedBy),
        clauses: asArray(item.clauses),
        machineRuleIds: uniqueStrings(item.machineRuleIds),
        warnings: uniqueStrings(item.warnings),
        questions: uniqueStrings([
            ...asArray(item.questions),
            ...asArray(item.clarifications),
        ]),
    }));
    const indexById = new Map(result.map((item, index) => [item.sourceId, index]));

    asArray(clauses).forEach((candidate, clauseIndex) => {
        const linked = linkArtifactToSource(candidate, result, { parsedBy });
        if (!linked.source) return;
        const sourceIndex = indexById.get(linked.source.sourceId);
        result[sourceIndex] = upsertClause(result[sourceIndex], linked.artifact, clauseIndex);
        result[sourceIndex].parsedBy = uniqueStrings([
            ...asArray(result[sourceIndex].parsedBy),
            ...asArray(parsedBy),
        ]);
    });

    const linkedRules = [];
    asArray(machineRules).forEach((candidate, ruleIndex) => {
        const linked = linkArtifactToSource(candidate, result, { parsedBy });
        if (!linked.source) {
            linkedRules.push({ ...candidate });
            return;
        }
        const sourceIndex = indexById.get(linked.source.sourceId);
        let current = result[sourceIndex];
        const matchingClause = current.clauses.find(clause => clause.clauseId === candidate.clauseId)
            || current.clauses.find(clause => clause.id === candidate.requirementId)
            || current.clauses[0];
        if (!matchingClause) {
            current = upsertClause(current, {
                intent: candidate.intent || candidate.type || 'legacy_rule',
                strength: candidate.priority === 'hard' ? 'hard' : 'soft',
                status: candidate.status,
                understandingStatus: candidate.status === 'effective' ? 'parsed' : 'partially_parsed',
                executionStatus: candidate.status === 'effective' ? 'executable' : 'unsupported_by_solver',
                source: { rawText: linked.source.source.rawText },
            }, current.clauses.length);
        }
        const clause = current.clauses.find(item => item.clauseId === candidate.clauseId)
            || current.clauses.find(item => item.id === candidate.requirementId)
            || current.clauses.at(-1);
        const upserted = upsertMachineRule(current, linked.artifact, clause?.clauseId || '', ruleIndex);
        result[sourceIndex] = upserted.sourceRequirement;
        linkedRules.push(upserted.machineRule);
    });

    const finalized = result.map(item => {
        const rows = linkedRules.filter(row => row.sourceId === item.sourceId);
        const understandingStatus = understandingFromArtifacts(item.clauses, rows);
        const executionStatus = executionFromArtifacts(item.clauses, rows);
        return {
            ...item,
            understandingStatus,
            executionStatus,
            status: displayStatus(understandingStatus, executionStatus),
            parsedBy: uniqueStrings([
                ...asArray(item.parsedBy),
                ...asArray(parsedBy),
            ]),
            confidence: item.clauses.length
                ? Math.min(...item.clauses.map(clause => Number.isFinite(Number(clause.confidence)) ? Number(clause.confidence) : 1))
                : item.confidence,
        };
    });

    return { sourceRequirements: finalized, machineRules: linkedRules };
}

export function buildLegacyRequirementItemsFromSources(sourceRequirements = []) {
    return asArray(sourceRequirements).flatMap(source => {
        const sourceFields = {
            sourceId: source.sourceId,
            textHash: source.source.textHash,
            origin: source.origin,
            parsedBy: uniqueStrings(source.parsedBy),
            sourceSheet: source.source.sheetName || '',
            sourceRow: source.source.rowNumber || null,
            lineNumber: source.source.lineNumber || null,
            rawText: source.source.rawText,
        };
        if (source.clauses.length) {
            return source.clauses.map(clause => ({
                ...clause,
                ...sourceFields,
                id: clause.id || clause.clauseId,
                requirementId: clause.id || clause.clauseId,
                clauseId: clause.clauseId,
                machineRuleIds: uniqueStrings(clause.machineRuleIds?.length ? clause.machineRuleIds : source.machineRuleIds),
                rowId: clause.rowId || '',
                parsedBy: uniqueStrings([...sourceFields.parsedBy, ...asArray(clause.parsedBy)]),
                source: {
                    ...(clause.source || {}),
                    ...sourceFields,
                    sheetName: source.source.sheetName || '',
                    rowNumber: source.source.rowNumber || null,
                    clauseId: clause.clauseId,
                },
            }));
        }
        const id = `${source.sourceId}:unrecognized`;
        return [{
            id,
            requirementId: id,
            clauseId: '',
            machineRuleIds: uniqueStrings(source.machineRuleIds),
            rowId: '',
            ...sourceFields,
            object: { kind: 'global', name: '' },
            intent: 'unrecognized',
            condition: {},
            parameters: {},
            strength: 'soft',
            status: 'needs_review',
            applyTo: 'review',
            confidence: source.confidence,
            source: {
                ...source.source,
                ...sourceFields,
                sourceSheet: source.source.sheetName || '',
                sourceRow: source.source.rowNumber || null,
                sheetName: source.source.sheetName || '',
                rowNumber: source.source.rowNumber || null,
            },
            warnings: source.warnings,
            modelSupport: 'review_only',
        }];
    });
}
