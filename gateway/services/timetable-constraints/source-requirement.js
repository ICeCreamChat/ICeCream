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

const OBSOLETE_EXECUTABLE_WARNING_PATTERNS = [
    /当前求解器只支持全部教师级空堂权重/,
    /需求语义和适用范围已保留，但当前求解器不能安全执行/,
    /当前版本只能预览这类建议，暂不会写入排课规则/,
];

function aiReviewRequiresHumanReview(artifact = {}) {
    return artifact.aiReviewBlocking === true
        && normalizeSourceText(artifact.aiReviewValidationStatus || '').toLowerCase() === 'blocking';
}

function executableArtifact(artifact = {}) {
    return artifact.executionStatus === 'executable'
        && artifact.understandingStatus !== 'ambiguous'
        && !aiReviewRequiresHumanReview(artifact);
}

function reconcileExecutableClause(clause = {}) {
    if (!executableArtifact(clause)) return clause;
    const explicitTarget = normalizeSourceText(clause.applyTo || '').toLowerCase();
    const applicationTarget = explicitTarget && !['review', 'needs_review'].includes(explicitTarget)
        ? clause.applyTo
        : asArray(clause.machineRuleIds).length
            ? 'rule'
            : asArray(clause.landing).includes('lesson_plan')
                ? 'lesson_plan'
                : asArray(clause.landing).includes('optimization')
                    ? 'optimization'
                    : clause.applyTo || '';
    return {
        ...clause,
        status: 'actionable',
        reviewStatus: 'understood',
        support: 'full',
        ...(applicationTarget ? { applyTo: applicationTarget } : {}),
        warnings: uniqueStrings(asArray(clause.warnings).filter(warning => (
            !OBSOLETE_EXECUTABLE_WARNING_PATTERNS.some(pattern => pattern.test(warning))
        ))),
    };
}

function reviewReason(code, message, artifactIds = [], metadata = {}) {
    return {
        code,
        message,
        artifactIds: uniqueStrings(artifactIds),
        origin: metadata.origin || 'local',
        verified: metadata.verified !== false,
    };
}

function sourceReviewReasons(item = {}, executionStatus = '', understandingStatus = '') {
    const artifacts = asArray(item.clauses);
    const artifactIds = artifacts.flatMap(artifact => [artifact.clauseId, artifact.constraintId, artifact.id]);
    const reasons = [];
    if (executionStatus === 'conflicted') {
        reasons.push(reviewReason('conflicted', '约束之间存在冲突，需要人工处理。', artifactIds));
    } else if (executionStatus === 'blocked_by_reference') {
        reasons.push(reviewReason('blocked_by_reference', '约束对象尚未完成绑定。', artifactIds));
    } else if (executionStatus === 'blocked_by_clarification') {
        reasons.push(reviewReason('blocked_by_clarification', '约束缺少执行所需参数或课程属性。', artifactIds));
    } else if (executionStatus === 'partially_executable') {
        reasons.push(reviewReason('partially_executable', '约束只有部分语义可以执行。', artifactIds));
    } else if (executionStatus === 'unsupported_by_solver') {
        reasons.push(reviewReason('unsupported_by_solver', '当前求解器尚未实现这项完整语义。', artifactIds));
    }
    if (['ambiguous', 'invalid_reference', 'unrecognized', 'partially_parsed'].includes(understandingStatus)) {
        reasons.push(reviewReason('semantic_ambiguity', '约束语义或对象仍需确认。', artifactIds));
    }
    artifacts.filter(aiReviewRequiresHumanReview).forEach(artifact => {
        reasons.push(reviewReason(
            `ai_review_${normalizeSourceText(artifact.aiReviewIssueCode || artifact.aiReviewStatus).toLowerCase()}`,
            asArray(artifact.aiReviewWarnings)[0] || 'AI复审要求人工确认这项识别结果。',
            [artifact.clauseId, artifact.constraintId, artifact.id],
            { origin: 'ai', verified: true },
        ));
    });
    return [...new Map(reasons.map(reason => [reason.code, reason])).values()];
}

function sourceApplicationTarget(item = {}, executionStatus = '', reviewReasons = []) {
    if (executionStatus === 'partially_executable' && asArray(item.machineRuleIds).length) return 'rule';
    if (reviewReasons.length) return 'review';
    if (executionStatus === 'disabled' || item.origin === 'system_supplement') return 'handled';
    if (executionStatus !== 'executable') return 'review';
    if (asArray(item.machineRuleIds).length) return 'rule';
    const landings = new Set(asArray(item.clauses).flatMap(clause => [
        ...asArray(clause.landing),
        clause.applyTo,
    ]).filter(Boolean));
    if (landings.has('lesson_plan')) return 'lesson_plan';
    if (landings.has('optimization')) return 'optimization';
    if (landings.has('handled')) return 'handled';
    return 'review';
}

export function finalizeSourceRequirementPresentation(rawItem = {}) {
    const item = {
        ...rawItem,
        clauses: asArray(rawItem.clauses).map(reconcileExecutableClause),
    };
    const understandingStatus = item.understandingStatus || understandingFromArtifacts(item.clauses, []);
    const executionStatus = item.executionStatus || executionFromArtifacts(item.clauses, []);
    const reviewReasons = sourceReviewReasons(item, executionStatus, understandingStatus);
    let applicationTarget = sourceApplicationTarget(item, executionStatus, reviewReasons);
    if (applicationTarget === 'review' && !reviewReasons.length) {
        reviewReasons.push(reviewReason('missing_application_artifact', '已理解约束，但尚未生成可应用的排课制品。'));
        applicationTarget = 'review';
    }
    const applicableMachineRuleIds = uniqueStrings(item.clauses
        .filter(clause => ['executable', 'partially_executable'].includes(clause.executionStatus))
        .flatMap(clause => clause.machineRuleIds));
    const unresolvedClauseIds = uniqueStrings(item.clauses
        .filter(clause => !['executable', 'disabled'].includes(clause.executionStatus))
        .map(clause => clause.clauseId || clause.constraintId || clause.id));
    const partiallyApplicable = applicableMachineRuleIds.length > 0 && unresolvedClauseIds.length > 0;
    const requiresHumanReview = applicationTarget === 'review' || unresolvedClauseIds.length > 0;
    return {
        ...item,
        understandingStatus,
        executionStatus,
        status: displayStatus(understandingStatus, executionStatus),
        reviewStatus: partiallyApplicable ? 'partially_supported' : requiresHumanReview ? 'needs_review' : 'understood',
        applicationTarget,
        requiresHumanReview,
        partiallyApplicable,
        applicableMachineRuleIds,
        unresolvedClauseIds,
        reviewReasons,
        warnings: uniqueStrings(asArray(item.warnings).filter(warning => (
            executionStatus !== 'executable'
            || !OBSOLETE_EXECUTABLE_WARNING_PATTERNS.some(pattern => pattern.test(warning))
        ))),
    };
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
        applicationTarget: 'review',
        requiresHumanReview: true,
        reviewReasons: [reviewReason('missing_application_artifact', '尚未生成可应用的排课制品。')],
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
    if (statuses.some(status => status === 'blocked_by_reference')) return 'blocked_by_reference';
    if (statuses.some(status => status === 'blocked_by_clarification')) return 'blocked_by_clarification';
    return 'unsupported_by_solver';
}

function displayStatus(understandingStatus, executionStatus) {
    if (understandingStatus === 'irrelevant') return 'irrelevant';
    if (['ambiguous', 'invalid_reference', 'unrecognized', 'partially_parsed'].includes(understandingStatus)) return 'needs_review';
    if (executionStatus === 'executable') return 'actionable';
    if (executionStatus === 'partially_executable') return 'partially_actionable';
    if (executionStatus === 'blocked_by_reference' || executionStatus === 'blocked_by_clarification') return 'needs_review';
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

    const finalized = result.map(rawItem => {
        const item = {
            ...rawItem,
            clauses: asArray(rawItem.clauses).map(reconcileExecutableClause),
        };
        const rows = linkedRules.filter(row => row.sourceId === item.sourceId);
        const understandingStatus = understandingFromArtifacts(item.clauses, rows);
        const executionStatus = executionFromArtifacts(item.clauses, rows);
        return finalizeSourceRequirementPresentation({
            ...item,
            understandingStatus,
            executionStatus,
            parsedBy: uniqueStrings([
                ...asArray(item.parsedBy),
                ...asArray(parsedBy),
            ]),
            confidence: item.clauses.length
                ? Math.min(...item.clauses.map(clause => Number.isFinite(Number(clause.confidence)) ? Number(clause.confidence) : 1))
                : item.confidence,
        });
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
