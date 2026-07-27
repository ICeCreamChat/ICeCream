import {
    createHash,
} from 'node:crypto';
import path from 'node:path';
import {
    getActivePeriods,
    getActiveWeekdays,
    slotKey,
} from './timetable-project.js';
import {
    applyClarificationPolicy,
} from './timetable-clarify-policies.js';
import {
    attachArtifactsToSourceRequirements,
    buildLegacyRequirementItemsFromSources,
    finalizeSourceRequirementPresentation,
    linkArtifactToSource,
} from './timetable-constraints/source-requirement.js';
import {
    buildRequirementStatistics,
} from './timetable-constraints/statistics.js';
import {
    SOURCE_SCHEMA_VERSION,
} from './timetable-constraints/source-identity.js';
import {
    sourceRequirementsToAiInputs,
} from './timetable-constraints/ai-source-alignment.js';
import {
    legacyArtifactToConstraintIR,
} from './timetable-constraints/capabilities.js';
import {
    compileConstraintIR,
    resolveConstraintCapability,
} from './timetable-constraints/capability-registry.js';
import {
    aggregateConstraintIRStatuses,
    normalizeConstraintIR,
} from './timetable-constraints/constraint-ir.js';
import {
    assessConstraintIRExecutionReadiness,
    buildEntityResolution,
    resolveConstraintIRReferences,
} from './timetable-constraints/entity-resolution.js';

import {
    TimetableRuleParseError,
    asList,
    asText,
    compactParseResultForReview,
    compactProjectDictionary,
    entityLabel,
    entityNamesForMatch,
    isAllTeachersTarget,
    normalizeAiContent,
    normalizeConstraintType,
    normalizeSlotList,
    normalizedMessageValues,
    normalizedParsedBy,
    normalizedTextValues,
    parseDays,
    parseLooseNumber,
    parsePeriods,
    parserActors,
    parserShadowText,
    preciseSemanticConstraintsFromText,
    resolveAiConfig,
    resolveFetch,
    shouldNormalizeAllTeachersTarget,
    splitClauses,
    splitSentences,
    targetTypeFor,
    textClassTargets,
    textSubjectTargets,
    textTeacherTargets,
    warningMessagesFromAi,
} from './timetable-rule-parser-sources.js';
import {
    AI_CANDIDATE_VALIDATION_VERSION,
    AI_REVIEW_PROMPT_VERSION,
    DEFAULT_AI_REVIEW_TIMEOUT_MS,
    NUMBER_TOKEN_PATTERN,
    PARSER_VERSION,
    STATUS_LABELS,
    SUGGESTION_ONLY_TYPES,
    SUPPORTED_EFFECTIVE_TYPES,
    SYSTEM_CLASS_TIME_CONFLICT_PATTERN,
    SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN,
    SYSTEM_TEACHER_TIME_CONFLICT_PATTERN,
    TIMETABLE_CAPABILITY_REGISTRY,
    compactCapabilityIRs,
    hasConfiguredAi,
    mergeConstraintIR,
    normalizeDraftRow,
    normalizedRequirementQuantifier,
    requirementForCompiledRow,
    rowNeedsSlots,
    sourceFromRow,
    usableSemanticObject,
    warningsForConstraintExecution,
} from './timetable-rule-parser-ir.js';
import {
    aiReviewDisabled,
    aiReviewTimeoutMs,
    cacheConstraintIRSignature,
} from './timetable-rule-parser-cache.js';
import {
    applyAiReviewToParseResult,
    normalizeTimetableRuleDraftRows,
} from './timetable-rule-parser.js';

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

const INVALID_INFERRED_ENTITY_NAMES = new Set([
    '日课量', '至少', '每个班每天课量', '课组内的教师', '固定活动',
    'unsupported', 'need_review', 'needs_review', 'unknown', 'requirement', 'schedule_request',
]);

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

function dedupeCapabilityCandidateRows(rows = []) {
    const statusRank = status => ({
        effective: 5,
        ready: 5,
        actionable: 4,
        suggestion: 3,
        needs_review: 2,
        unsupported: 1,
    }[status] || 0);
    const result = [];
    const indexes = new Map();
    for (const row of asList(rows)) {
        const sourceIdentity = row.sourceId
            || (row.sourceRow ? `${row.sourceSheet || ''}:${row.sourceRow}` : '')
            || (row.lineNumber ? `line:${row.lineNumber}` : '')
            || row.textHash
            || '';
        const capability = resolveConstraintCapability(TIMETABLE_CAPABILITY_REGISTRY, {
            capabilityId: row.capabilityId || row.advancedType || '',
            intent: row.intent || row.type || '',
            type: row.type || '',
        });
        const semanticType = capability?.id
            || row.capabilityId
            || row.advancedType
            || normalizeRequirementIntentAlias(row.intent || row.type || 'unknown');
        const key = stableJson([
            sourceIdentity,
            row.clauseId || row.requirementId || '',
            semanticType,
            row.targetType || '',
            row.targetId || row.teacherId || row.classId || row.subjectId || row.targetName || '',
            normalizeSlotList(row.slots || []),
            row.limit ?? row.minGapDays ?? null,
            row.parameters || {},
            row.scope || {},
            row.relation || {},
            row.priority || row.strength || '',
        ]);
        const existingIndex = indexes.get(key);
        if (existingIndex === undefined) {
            indexes.set(key, result.length);
            result.push(row);
        } else if (statusRank(row.status) > statusRank(result[existingIndex].status)) {
            result[existingIndex] = row;
        }
    }
    return result;
}

function compileArtifactsThroughCapabilityRegistry({
    project = {},
    rows = [],
    requirementItems = [],
    sourceRequirements = [],
} = {}) {
    const requirements = asList(requirementItems)
        .filter(requirement => requirement && typeof requirement === 'object' && requirement.origin !== 'system_supplement');
    const rowList = dedupeCapabilityCandidateRows(
        asList(rows).filter(row => row && typeof row === 'object'),
    );
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
        ) outputRows = candidate.artifact.courseScopeClarification === true && candidate.originalRow
            ? [candidate.originalRow]
            : [];
        outputRows = outputRows.map(row => ({
            ...row,
            parameters: {
                ...(candidate.artifact.legacyClause?.parameters || {}),
                ...(row.parameters || {}),
            },
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
            warnings: uniqueConstraintMessages(warningsForConstraintExecution([
                ...asList(row.warnings),
                ...rowCompileWarnings,
            ], ir)),
        }));
        compiledRows.push(...outputRows);

        ir = normalizeConstraintIR({
            ...ir,
            parameters: {
                ...(candidate.artifact.legacyClause?.parameters || {}),
                ...(ir.parameters || {}),
            },
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
    const { legacyRow, ...parameters } = {
        ...(ir.legacyClause?.parameters || {}),
        ...(ir.parameters || {}),
    };
    const { legacyClause, ...publicFields } = ir;
    void legacyRow;
    void legacyClause;
    return normalizeConstraintIR({
        ...publicFields,
        parameters,
        warnings: warningsForConstraintExecution(ir.warnings, ir),
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
            stableJson(row.scope || {}),
            stableJson(row.relation || {}),
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
            rationales: [
                ...asList(sourceRequirement.rationales),
                ...semanticRationalesFromText(sourceRequirement.source?.rawText || sourceRequirement.rawText || ''),
            ],
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
        relation: row.relation && typeof row.relation === 'object' ? { ...row.relation } : {},
        quantifier: normalizedRequirementQuantifier(row.quantifier, row.minOccurrences ?? row.parameters?.minOccurrences),
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
    if (reqIds.length || reqNames.length) return false;
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
            scope: item.scope && typeof item.scope === 'object' ? { ...item.scope } : {},
            relation: item.relation && typeof item.relation === 'object' ? { ...item.relation } : {},
            quantifier: normalizedRequirementQuantifier(item.quantifier, item.parameters?.minOccurrences),
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
            item.scope || {},
            item.relation || {},
            item.quantifier || {},
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
    const intent = normalizeRequirementIntentAlias(requirement.intent);
    const matchedIds = normalizedTextValues(120, requirement.object?.matchedIds);
    if (requirement.applyTo === 'lesson_plan' && intent === 'block_preference') {
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
    if (requirement.applyTo === 'optimization' && intent === 'teacher_load_protection') {
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
        if (intent === 'preferred_periods' && requirement.parameters?.weekPattern) {
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
        if (intent === 'avoid_periods' && requirement.parameters?.weekPattern) {
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
        if (intent === 'campus_commute_gap') {
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
        if (intent === 'teaching_group_session') {
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
        if (intent === 'room_requirement') {
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
    const baseId = asText(requirement.id || '', 160) || `req_text_${hashValue({
        capabilityId: requirement.capabilityId || '',
        intent: requirement.intent || requirement.type || '',
        object: requirement.object || null,
        targetType: requirement.targetType || '',
        targetId: requirement.targetId || '',
        targetName: requirement.targetName || requirement.target || '',
        condition: requirement.condition || null,
        parameters: requirement.parameters || {},
        scope: requirement.scope || {},
        relation: requirement.relation || {},
        quantifier: requirement.quantifier || {},
        strength: requirement.strength || requirement.priority || 'soft',
    }, 20)}`;
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

function resolveSemanticRequirementRelations(requirements = []) {
    const items = asList(requirements).filter(item => item && typeof item === 'object');
    const clauseIdBySemanticKey = new Map();
    items.forEach(requirement => {
        const semanticKey = asText(requirement.relation?.semanticKey || '', 240);
        if (!semanticKey || !requirement.sourceId) return;
        const { semanticKey: ignoredSemanticKey, parentSemanticKey: ignoredParentSemanticKey, ...relation } = requirement.relation || {};
        void ignoredSemanticKey;
        void ignoredParentSemanticKey;
        const ir = legacyArtifactToConstraintIR({ ...requirement, relation }, {
            registry: TIMETABLE_CAPABILITY_REGISTRY,
            parsedBy: requirement.parsedBy || [],
        });
        clauseIdBySemanticKey.set(`${requirement.sourceId}|${semanticKey}`, ir.clauseId);
    });
    return items.map(requirement => {
        const { semanticKey: ignoredSemanticKey, parentSemanticKey: ignoredParentSemanticKey, ...relation } = requirement.relation || {};
        void ignoredSemanticKey;
        void ignoredParentSemanticKey;
        const parentSemanticKey = asText(requirement.relation?.parentSemanticKey || '', 240);
        const parentClauseId = parentSemanticKey && requirement.sourceId
            ? clauseIdBySemanticKey.get(`${requirement.sourceId}|${parentSemanticKey}`) || ''
            : asText(requirement.relation?.parentClauseId || '', 300);
        const related = {
            ...requirement,
            relation: {
                ...relation,
                ...(parentClauseId ? { parentClauseId } : {}),
            },
        };
        const ir = legacyArtifactToConstraintIR(related, {
            registry: TIMETABLE_CAPABILITY_REGISTRY,
            parsedBy: related.parsedBy || [],
        });
        return {
            ...related,
            clauseId: ir.clauseId,
            constraintId: ir.constraintId,
        };
    });
}

function preciseSemanticRequirementsFromText(project = {}, text = '') {
    return preciseSemanticConstraintsFromText(project, text).map((row, index) => {
        const normalizedRow = normalizeDraftRow(row, index, project);
        return {
            ...requirementFromRow(normalizedRow, index, project),
            type: normalizedRow.type,
            intent: normalizedRow.intent || normalizedRow.type,
        };
    });
}

function generatedTextRequirementSupersedesRow(requirement = {}, row = {}, project = {}) {
    const intent = normalizeRequirementIntentAlias(requirement.intent || requirement.type || '');
    const rowIntent = normalizeRequirementIntentAlias(row.intent || row.type || '');
    if (intent !== 'block_preference' || rowIntent !== 'block_integrity') return false;
    return semanticRequirementMatchesRow(requirement, row, project);
}

function scopedRowSupersedesGeneratedRequirement(row = {}, generated = {}, project = {}) {
    if (artifactSourceIdentityConflicts(row, generated)) return false;
    if (row.capabilityId !== 'subject.avoid_periods' || generated.capabilityId !== row.capabilityId) return false;
    const sourceText = `${rowSourceText(row)} ${requirementSourceText(generated)}`;
    if (!/(?:最后一节|末节|收尾)/.test(sourceText)) return false;
    if (!requirementTargetMatchesRow(generated, row)) return false;
    return !requirementTimeMatchesRow(generated, row, project);
}

const SCOPED_COURSE_RULE_TYPES = new Set([
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_morning',
    'subject_afternoon',
    'subject_spread',
]);

const SCOPED_COURSE_CAPABILITIES = Object.freeze({
    subject_preferred_periods: 'subject.preferred_periods',
    subject_avoid_periods: 'subject.avoid_periods',
    subject_morning: 'subject.preferred_day_part',
    subject_afternoon: 'subject.preferred_day_part',
    subject_spread: 'subject.spread',
});

function isExplicitSchoolCourseScope(text = '') {
    return /(?:全校|全体班级|所有班级|全体学生|全局)/.test(asText(text, 1200));
}

function courseRuleScopeLabel(project = {}, subjectId = '', classIds = [], teacherIds = []) {
    const classesById = new Map((project.classes || []).map(item => [item.id, item]));
    const teachersById = new Map((project.teachers || []).map(item => [item.id, item]));
    const subject = (project.subjects || []).find(item => item.id === subjectId);
    const classNames = classIds.map(id => entityLabel(classesById.get(id) || { id })).filter(Boolean);
    const teacherNames = teacherIds.map(id => entityLabel(teachersById.get(id) || { id })).filter(Boolean);
    return [
        ...classNames,
        subject ? entityLabel(subject) : subjectId,
        teacherNames.length ? teacherNames.join('、') : '不限教师',
    ].filter(Boolean).join(' · ');
}

function courseScopeIdsFromRow(project = {}, row = {}) {
    const parameters = row.parameters || {};
    const scope = row.scope || {};
    const rawText = rowSourceText(row);
    const namedClassIds = normalizedTextValues(200, parameters.classNames, scope.classNames)
        .flatMap(name => textClassTargets(name, project).map(item => item.id));
    const namedTeacherIds = normalizedTextValues(200, parameters.teacherNames, scope.teacherNames)
        .flatMap(name => textTeacherTargets(name, project).map(item => item.id));
    const textMatchedTeacherIds = textTeacherTargets(rawText, project).map(item => item.id);
    const explicitClassIds = normalizedTextValues(120,
        parameters.classIds,
        scope.classIds,
        row.classIds,
        namedClassIds,
        textClassTargets(rawText, project).map(item => item.id),
    );
    const scopeQualifier = asText(parameters.scopeQualifier || scope.scopeQualifier || scope.qualifier || '', 80).toLowerCase();
    const hasTeacherScope = scopeQualifier === 'teacher_covered_classes'
        || normalizedTextValues(120, parameters.teacherIds, scope.teacherIds, row.teacherIds).length > 0
        || normalizedTextValues(120, parameters.teacherNames, scope.teacherNames).length > 0
        || textMatchedTeacherIds.length > 0;
    const teacherIds = normalizedTextValues(120,
        parameters.teacherIds,
        scope.teacherIds,
        row.teacherIds,
        namedTeacherIds,
        hasTeacherScope ? textMatchedTeacherIds : [],
    );
    const gradeNames = normalizedTextValues(40,
        parameters.gradeNames,
        scope.gradeNames,
        row.gradeNames,
        gradeNamesFromText(rawText),
    );
    return { explicitClassIds, teacherIds, gradeNames, rawText };
}

function normalizedGradeScopeName(value = '') {
    const aliases = {
        初一: '7', 七: '7', '7': '7', G7: '7',
        初二: '8', 八: '8', '8': '8', G8: '8',
        初三: '9', 九: '9', '9': '9', G9: '9',
        高一: '10', 十: '10', '10': '10', G10: '10',
        高二: '11', 十一: '11', '11': '11', G11: '11',
        高三: '12', 十二: '12', '12': '12', G12: '12',
    };
    const compact = asText(value, 80).toUpperCase().replace(/年级|GRADE|\s+/g, '');
    if (aliases[compact]) return aliases[compact];
    const number = compact.match(/\d{1,2}/)?.[0];
    return number || compact;
}

function classGradeScopeName(klass = {}) {
    return normalizedGradeScopeName(klass.grade || klass.gradeName || klass.name || '');
}

function derivedCourseScope(project = {}, row = {}, subjectId = '') {
    const { explicitClassIds, teacherIds, gradeNames, rawText } = courseScopeIdsFromRow(project, row);
    const scopeQualifier = asText(row.parameters?.scopeQualifier || row.scope?.scopeQualifier || row.scope?.qualifier || '', 80).toLowerCase();
    const explicitSchool = isExplicitSchoolCourseScope(rawText) || ['school', 'global', 'all_school'].includes(scopeQualifier);
    const teacherCovered = scopeQualifier === 'teacher_covered_classes' || teacherIds.length > 0;
    const normalizedGrades = new Set(gradeNames.map(normalizedGradeScopeName).filter(Boolean));
    const classesById = new Map(asList(project.classes).map(item => [item.id, item]));
    let plans = asList(project.lessonPlans).filter(plan => plan.subjectId === subjectId);
    if (explicitClassIds.length) plans = plans.filter(plan => explicitClassIds.includes(plan.classId));
    if (normalizedGrades.size) {
        plans = plans.filter(plan => normalizedGrades.has(classGradeScopeName(classesById.get(plan.classId))));
    }
    if (teacherIds.length) {
        plans = plans.filter(plan => [plan.teacherId, ...asList(plan.teacherIds)]
            .filter(Boolean)
            .some(id => teacherIds.includes(id)));
    }
    const classIds = normalizedTextValues(120, plans.map(plan => plan.classId));
    const kind = explicitClassIds.length
        ? 'explicit_classes'
        : normalizedGrades.size
            ? 'grade_classes'
            : teacherCovered
                ? 'teacher_covered_classes'
                : explicitSchool
                    ? 'school'
                    : 'subject_offering_classes';
    return {
        classIds,
        teacherIds,
        gradeNames,
        rawText,
        kind,
        scopeQualifier: scopeQualifier || kind,
        explicitClassIds,
    };
}

function scopeParsedCoursePreferenceRows(project = {}, rows = []) {
    return asList(rows).map(row => {
        const rawText = rowSourceText(row);
        const normalizedType = normalizeConstraintType(row.type || row.intent || '');
        const preferredDayPart = asText(row.parameters?.dayPart || row.dayPart || '', 40).toLowerCase();
        const type = normalizedType === 'preferred_day_part'
            ? (preferredDayPart === 'afternoon' || /(?:下午|午后)/.test(rawText) ? 'subject_afternoon' : 'subject_morning')
            : normalizedType === 'subject_preferred_periods'
            && /(?:上午|早上).*(?:优先|尽量|最好)|(?:优先|尽量|最好).*(?:上午|早上)/.test(rawText)
                ? 'subject_morning'
                : normalizedType;
        if (!SCOPED_COURSE_RULE_TYPES.has(type) || row.type === 'advanced_constraint') return row;

        const subjectIds = normalizedTextValues(120,
            row.targetId,
            row.subjectId,
            row.parameters?.subjectIds,
            row.subjectIds,
        );
        const subjectId = subjectIds.length === 1 ? subjectIds[0] : '';
        if (!subjectIds.length) return row;
        const derivedScope = derivedCourseScope(project, row, subjectId);
        const { classIds, teacherIds, gradeNames, kind, scopeQualifier, explicitClassIds } = derivedScope;
        if (!classIds.length) {
            const clarification = asList(project.lessonPlans).length
                ? '当前项目中没有与课程范围条件匹配的任课计划。'
                : '项目尚未提供可用于派生课程范围的任课计划。';
            return {
                ...row,
                status: 'needs_review',
                executionStatus: 'blocked_by_reference',
                reviewStatus: 'needs_clarification',
                support: 'none',
                needsClarification: true,
                courseScopeClarification: true,
                landing: ['clarification', 'review'],
                clarifications: uniqueConstraintMessages([...asList(row.clarifications), clarification]),
                warnings: uniqueConstraintMessages([...asList(row.warnings), '课程范围无法从当前任课计划安全派生，未生成机器规则。']),
            };
        }
        if (!subjectId) {
            return {
                ...row,
                status: 'needs_review',
                executionStatus: 'blocked_by_clarification',
                reviewStatus: 'needs_clarification',
                support: 'none',
                needsClarification: true,
                courseScopeClarification: true,
                landing: ['clarification', 'review'],
                clarifications: uniqueConstraintMessages([...asList(row.clarifications), '请将课程范围拆分为单门课程后再指定班级。']),
                warnings: uniqueConstraintMessages([...asList(row.warnings), '多门课程不能共享同一条精确课程范围规则，未生成机器规则。']),
            };
        }

        const plans = (project.lessonPlans || []).filter(plan => (
            plan.subjectId === subjectId
            && classIds.includes(plan.classId)
            && (!teacherIds.length || [plan.teacherId, ...asList(plan.teacherIds)].filter(Boolean).some(id => teacherIds.includes(id)))
        ));
        if (!plans.length) {
            const teacherPart = teacherIds.length ? '和教师' : '';
            return {
                ...row,
                status: 'needs_review',
                executionStatus: 'blocked_by_reference',
                reviewStatus: 'needs_clarification',
                support: 'none',
                needsClarification: true,
                courseScopeClarification: true,
                landing: ['clarification', 'review'],
                clarifications: uniqueConstraintMessages([...asList(row.clarifications), `所选课程、班级${teacherPart}没有匹配的任课安排。`]),
                warnings: uniqueConstraintMessages([...asList(row.warnings), '课程范围未匹配现有任课计划，未生成机器规则。']),
            };
        }

        const scopedParameters = {
            ...(row.parameters || {}),
            classIds,
            ...(gradeNames.length ? { gradeNames } : {}),
            scopeQualifier,
            ...(teacherIds.length ? { teacherIds } : {}),
        };
        return {
            ...row,
            type: 'advanced_constraint',
            intent: row.intent || type,
            advancedType: SCOPED_COURSE_CAPABILITIES[type],
            capabilityId: row.capabilityId || SCOPED_COURSE_CAPABILITIES[type],
            targetType: 'subject',
            targetId: subjectId,
            subjectId,
            parameters: scopedParameters,
            scope: {
                ...(row.scope || {}),
                kind,
                classIds,
                ...(gradeNames.length ? { gradeNames } : {}),
                ...(teacherIds.length ? { teacherIds } : {}),
            },
            scopeClassId: classIds[0] || '',
            scopeTeacherId: teacherIds[0] || '',
            scopeLabel: gradeNames.length
                ? `${gradeNames.join('、')} · ${classIds.length}个班`
                : explicitClassIds.length <= 3
                    ? courseRuleScopeLabel(project, subjectId, classIds, teacherIds)
                    : `${classIds.length}个开课班级`,
        };
    });
}

function scopeParsedCoursePreferenceRequirements(project = {}, requirements = []) {
    return asList(requirements).map(requirement => {
        const target = requirement.object && typeof requirement.object === 'object' ? requirement.object : {};
        const capabilityId = asText(requirement.capabilityId || '', 120);
        const scopedCourseType = normalizeConstraintType(requirement.intent || requirement.type || capabilityId);
        const classIds = normalizedTextValues(120,
            requirement.parameters?.classIds,
            requirement.scope?.classIds,
        );
        const isAlreadyScopedCourseRequirement = (
            (SCOPED_COURSE_RULE_TYPES.has(scopedCourseType)
                || Object.values(SCOPED_COURSE_CAPABILITIES).includes(capabilityId))
            && target.kind === 'subject'
            && asList(target.matchedIds).length === 1
            && classIds.length > 0
        );
        if (isAlreadyScopedCourseRequirement) {
            const teacherIds = normalizedTextValues(120,
                requirement.parameters?.teacherIds,
                requirement.scope?.teacherIds,
            );
            const gradeNames = normalizedTextValues(40,
                requirement.parameters?.gradeNames,
                requirement.scope?.gradeNames,
            );
            return {
                ...requirement,
                parameters: {
                    ...(requirement.parameters || {}),
                    classIds,
                    ...(teacherIds.length ? { teacherIds } : {}),
                    ...(gradeNames.length ? { gradeNames } : {}),
                    scopeQualifier: requirement.parameters?.scopeQualifier
                        || requirement.scope?.qualifier
                        || requirement.scope?.kind,
                },
            };
        }
        const row = {
            type: requirement.intent || requirement.type || requirement.capabilityId || '',
            intent: requirement.intent || '',
            capabilityId: requirement.capabilityId || '',
            targetType: target.kind || '',
            targetId: asList(target.matchedIds)[0] || '',
            targetName: target.name || '',
            subjectIds: target.kind === 'subject_group' ? asList(target.matchedIds) : [],
            parameters: requirement.parameters || {},
            scope: requirement.scope || {},
            relation: requirement.relation || {},
            quantifier: requirement.quantifier || {},
            rawText: requirementSourceText(requirement),
            status: requirement.status === 'actionable' ? 'effective' : requirement.status,
            executionStatus: requirement.executionStatus || '',
            reviewStatus: requirement.reviewStatus || '',
            support: requirement.support || '',
            landing: requirement.landing || requirement.applyTo || [],
            warnings: requirement.warnings || [],
            clarifications: requirement.clarifications || [],
        };
        const scoped = scopeParsedCoursePreferenceRows(project, [row])[0];
        if (scoped === row) return requirement;
        const needsClarification = scoped.status === 'needs_review';
        return {
            ...requirement,
            parameters: scoped.parameters || requirement.parameters || {},
            scope: scoped.scope || requirement.scope || {},
            status: needsClarification ? 'needs_review' : requirement.status,
            courseScopeClarification: needsClarification,
            executionStatus: scoped.executionStatus || requirement.executionStatus || '',
            reviewStatus: scoped.reviewStatus || requirement.reviewStatus || '',
            support: scoped.support || requirement.support || '',
            needsClarification: scoped.needsClarification === true || requirement.needsClarification === true,
            landing: scoped.landing || requirement.landing || [],
            applyTo: needsClarification ? 'review' : requirement.applyTo,
            warnings: uniqueConstraintMessages([...asList(requirement.warnings), ...asList(scoped.warnings)]),
            clarifications: uniqueConstraintMessages([...asList(requirement.clarifications), ...asList(scoped.clarifications)]),
        };
    });
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

function requirementItemsForClarification(previousResult = {}) {
    const legacyItems = externalRequirementItems(previousResult?.requirementItems || []);
    if (legacyItems.length) return legacyItems;

    return externalRequirementItems(buildLegacyRequirementItemsFromSources(
        previousResult?.sourceRequirements || [],
    ));
}

function nameById(items = [], id = '', fallback = '') {
    const item = (items || []).find(entry => entry.id === id);
    return item?.name || entityLabel(item) || fallback || id;
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

function artifactSourceId(item = {}) {
    return asText(item.sourceId || item.source?.sourceId || '', 300);
}

function editedSourceRationales(values = [], rawText = '') {
    return asList(values).map((item, index) => {
        const value = item && typeof item === 'object' ? item : { text: item };
        const rationaleText = asText(value.text || value.reason || value.rationale || '', 1000);
        const evidence = asText(value.evidence?.quote || value.evidence || '', 1000);
        if (!rationaleText) return null;
        if (evidence && !rawText.includes(evidence)) {
            throw new TimetableRuleParseError(
                `第 ${index + 1} 条原因说明的证据不在来源原文中。`,
                'source_rationale_evidence_mismatch',
                400,
            );
        }
        return {
            id: asText(value.id || '', 240) || `rationale_${index + 1}`,
            text: rationaleText,
            ...(evidence ? { evidence } : {}),
        };
    }).filter(Boolean);
}

const EDITED_SOURCE_SCOPE_PARAMETER_KEYS = [
    'classIds',
    'teacherIds',
    'teacherNames',
    'gradeNames',
    'scopeQualifier',
];

const EDITED_SOURCE_PARAMETER_KEYS = new Map([
    ['teacher.unavailable', ['days', 'periods', 'slots']],
    ['teacher.avoid_periods', ['days', 'periods', 'slots']],
    ['class.fixed_activity', ['days', 'periods', 'slots']],
    ['school.unavailable', ['days', 'periods', 'slots']],
    ['lesson.locked_slot', ['days', 'periods', 'slots', 'lessonPlanId', 'roomId', 'weekPattern']],
    ['teacher.daily_lesson_limit', ['limit']],
    ['teacher.consecutive_lesson_limit', ['limit']],
    ['teacher.weekly_lesson_limit', ['limit']],
    ['teacher.max_teaching_days', ['limit']],
    ['teacher.compact_day', ['weight', 'maxGaps']],
    ['teacher.mutual_exclusion', ['teacherIds']],
    ['subject.preferred_day_part', ['dayPart', 'days', 'periods', 'slots']],
    ['subject.preferred_periods', ['days', 'periods', 'slots', 'minOccurrences']],
    ['subject.avoid_periods', ['days', 'periods', 'slots']],
    ['class.subject_daily_limit', ['limit']],
    ['subject.spread', ['weight']],
    ['subject.minimum_day_gap', ['minGapDays']],
    ['subject.not_same_day', ['subjectIds']],
    ['subject.sequence', ['beforeSubjectId', 'afterSubjectId']],
    ['room.preferred', ['preferredRoomIds', 'activityTypes', 'teacherIds', 'weight']],
    ['room.forbidden_type', ['forbiddenRoomTypes', 'activityTypes', 'teacherIds']],
    ['room.required', ['roomRequirement', 'roomIds', 'requiredTags', 'activityTypes', 'teacherIds']],
    ['lesson.consecutive', ['blockSize', 'minBlockSize', 'maxBlockSize', 'activityTypes', 'weight']],
    ['class.subject_spread', ['weight']],
    ['subject.later_preference', ['days', 'periods', 'slots', 'weight']],
    ['teacher.load_balance', ['teacherIds', 'weight']],
    ['class.daily_balance', ['classIds', 'weight']],
    ['subject.avoid_weekday_concentration', ['days', 'weight']],
    ['subject.avoid_day_part_concentration', ['dayPart']],
    ['schedule.cross_venue_boundary', ['boundaryPeriods', 'activityTypes']],
    ['subject.not_consecutive_with', ['subjectIds', 'subjectNames', 'sameDay']],
    ['lesson.activity_scope_period_policy', ['subjectIds', 'subjectNames', 'activityTypes', 'preferredActivityTypes', 'periods']],
    ['lesson.resource_attribute_avoid_periods', ['requiredResourceTypes', 'periods']],
    ['teacher.prep_group_fairness', ['teacherIds', 'weight']],
]);

function editedSourceParameterKeys(clause = {}) {
    return new Set([
        ...EDITED_SOURCE_SCOPE_PARAMETER_KEYS,
        ...(EDITED_SOURCE_PARAMETER_KEYS.get(asText(clause.capabilityId || '', 160)) || []),
    ]);
}

function mergeEditedObject(original = {}, edited = {}, allowedKeys = new Set()) {
    const next = { ...(original && typeof original === 'object' ? original : {}) };
    allowedKeys.forEach(key => {
        if (Object.hasOwn(edited || {}, key)) next[key] = cloneValue(edited[key]);
        else delete next[key];
    });
    return next;
}

function sanitizeEditedSourceClause(project = {}, clause = {}, sourceRequirement = {}, index = 0, originalClause = {}) {
    const source = sourceRequirement.source || {};
    const rawText = source.rawText || sourceRequirement.rawText || '';
    const trustedClause = originalClause && typeof originalClause === 'object' ? originalClause : clause;
    const allowedParameterKeys = editedSourceParameterKeys(trustedClause);
    const parameters = mergeEditedObject(
        trustedClause.parameters,
        clause.parameters && typeof clause.parameters === 'object' ? clause.parameters : {},
        allowedParameterKeys,
    );
    const allowedScopeKeys = new Set(['kind', 'classIds', 'teacherIds', 'teacherNames', 'gradeNames']);
    const scope = mergeEditedObject(
        trustedClause.scope,
        clause.scope && typeof clause.scope === 'object' ? clause.scope : {},
        allowedScopeKeys,
    );
    const teacherNamesById = new Map(asList(project.teachers).map(item => [item.id, entityLabel(item)]));
    const derivedScopeKind = asText(scope.kind || parameters.scopeQualifier || '', 80);
    if (derivedScopeKind === 'teacher_covered_classes') {
        const teacherNames = normalizedTextValues(160,
            scope.teacherNames,
            parameters.teacherNames,
            normalizedTextValues(120, scope.teacherIds, parameters.teacherIds)
                .map(id => teacherNamesById.get(id)),
        );
        delete scope.classIds;
        delete scope.teacherIds;
        delete parameters.classIds;
        delete parameters.teacherIds;
        if (teacherNames.length) {
            scope.teacherNames = teacherNames;
            parameters.teacherNames = teacherNames;
        }
    } else if (['grade_classes', 'subject_offering_classes', 'school'].includes(derivedScopeKind)) {
        delete scope.classIds;
        delete parameters.classIds;
    } else if (derivedScopeKind === 'explicit_classes') {
        const validClassIds = new Set(asList(project.classes).map(item => item.id));
        const classIds = normalizedTextValues(120, scope.classIds, parameters.classIds)
            .filter(id => validClassIds.has(id));
        scope.classIds = classIds;
        parameters.classIds = classIds;
    }

    const originalObject = trustedClause.object && typeof trustedClause.object === 'object' ? trustedClause.object : {};
    const editedObject = clause.object && typeof clause.object === 'object' ? clause.object : {};
    const object = {
        ...originalObject,
        name: asText(editedObject.name || originalObject.name || '', 300),
        matchedIds: normalizedTextValues(160, editedObject.matchedIds),
    };
    const objectKind = asText(object.kind || '', 80).toLowerCase();
    const hasTypedObjectCatalog = objectKind.includes('teacher')
        || objectKind.includes('class')
        || objectKind.includes('room')
        || objectKind.includes('subject')
        || objectKind.includes('course');
    const objectEntities = objectKind.includes('teacher')
        ? asList(project.teachers)
        : objectKind.includes('class')
            ? asList(project.classes)
            : objectKind.includes('room')
                ? asList(project.rooms)
                : (objectKind.includes('subject') || objectKind.includes('course'))
                    ? asList(project.subjects)
                    : [];
    const requestedTargetIds = normalizedTextValues(160, object.matchedIds);
    if (requestedTargetIds.length && hasTypedObjectCatalog) {
        const entitiesById = new Map(objectEntities.map(item => [String(item.id), item]));
        const invalidTargetIds = requestedTargetIds.filter(id => !entitiesById.has(id));
        if (invalidTargetIds.length) {
            throw new TimetableRuleParseError(
                `第 ${index + 1} 个子约束选择的对象与“${object.kind || '当前对象类型'}”不匹配。`,
                'source_clause_object_mismatch',
                400,
            );
        }
        object.matchedIds = requestedTargetIds;
        object.name = requestedTargetIds
            .map(id => entityLabel(entitiesById.get(id)))
            .filter(Boolean)
            .join('、');
    } else if (requestedTargetIds.length) {
        const validTargetIds = new Set([
            ...asList(project.teachers).map(item => String(item.id)),
            ...asList(project.classes).map(item => String(item.id)),
            ...asList(project.subjects).map(item => String(item.id)),
            ...asList(project.rooms).map(item => String(item.id)),
        ]);
        const invalidTargetIds = requestedTargetIds.filter(id => !validTargetIds.has(id));
        if (invalidTargetIds.length) {
            throw new TimetableRuleParseError(
                `第 ${index + 1} 个子约束包含当前项目中不存在的对象。`,
                'source_clause_object_mismatch',
                400,
            );
        }
        object.matchedIds = requestedTargetIds;
    }

    const clauseId = asText(trustedClause.clauseId || trustedClause.constraintId || trustedClause.id || '', 300);
    const allowedTimeKeys = new Set(['days', 'periods', 'slots', 'dayPart', 'weekPattern']);
    const condition = mergeEditedObject(
        trustedClause.condition,
        clause.condition && typeof clause.condition === 'object' ? clause.condition : {},
        allowedTimeKeys,
    );
    const time = mergeEditedObject(
        trustedClause.time,
        clause.time && typeof clause.time === 'object' ? clause.time : {},
        allowedTimeKeys,
    );
    const quantifier = mergeEditedObject(
        trustedClause.quantifier,
        clause.quantifier && typeof clause.quantifier === 'object' ? clause.quantifier : {},
        new Set(['unit', 'min', 'max']),
    );
    const relation = mergeEditedObject(
        trustedClause.relation,
        clause.relation && typeof clause.relation === 'object' ? clause.relation : {},
        new Set(['kind', 'parentClauseId']),
    );
    return {
        ...trustedClause,
        id: asText(trustedClause.id || trustedClause.requirementId || clauseId, 300) || `edited_clause_${index + 1}`,
        requirementId: asText(trustedClause.requirementId || trustedClause.id || clauseId, 300) || `edited_clause_${index + 1}`,
        ...(clauseId ? { clauseId, constraintId: clauseId } : {}),
        sourceId: sourceRequirement.sourceId,
        textHash: source.textHash || sourceRequirement.textHash || '',
        origin: sourceRequirement.origin || 'user_input',
        parsedBy: normalizedParsedBy(trustedClause.parsedBy, sourceRequirement.parsedBy, 'manual_semantic_edit'),
        rawText,
        source: {
            ...(clause.source && typeof clause.source === 'object' ? clause.source : {}),
            sourceId: sourceRequirement.sourceId,
            textHash: source.textHash || sourceRequirement.textHash || '',
            origin: sourceRequirement.origin || 'user_input',
            rawText,
            sourceSheet: source.sheetName || source.sourceSheet || '',
            sourceRow: source.rowNumber || source.sourceRow || null,
            lineNumber: source.lineNumber || null,
        },
        object,
        parameters,
        scope,
        ...(Object.keys(condition).length ? { condition } : { condition: undefined }),
        ...(Object.keys(time).length ? { time } : { time: undefined }),
        ...(Object.keys(quantifier).length ? { quantifier } : { quantifier: undefined }),
        ...(Object.keys(relation).length ? { relation } : { relation: undefined }),
        strength: clause.strength === 'hard' ? 'hard' : clause.strength === 'soft' ? 'soft' : trustedClause.strength,
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
    const sanitizedPatch = sanitizedReviewPatch(patch);
    const candidate = {
        ...row,
        ...sanitizedPatch,
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
    const patchedTargetType = asText(sanitizedPatch.targetType || candidate.targetType || '', 40).toLowerCase();
    const entityCollections = {
        teacher: asList(project.teachers),
        class: asList(project.classes),
        subject: asList(project.subjects),
    };
    const patchedTargetName = asText(
        sanitizedPatch.targetName
        || sanitizedPatch.teacherName
        || sanitizedPatch.className
        || sanitizedPatch.subjectName
        || '',
        160,
    );
    const patchedTargetId = asText(
        sanitizedPatch.targetId
        || sanitizedPatch.teacherId
        || sanitizedPatch.classId
        || sanitizedPatch.subjectId
        || '',
        160,
    );
    const targetEntities = entityCollections[patchedTargetType] || [];
    if (patchedTargetName && !targetEntities.some(entity => entityNamesForMatch(entity, patchedTargetType).includes(patchedTargetName))) return null;
    if (patchedTargetId && !targetEntities.some(entity => entity.id === patchedTargetId)) return null;
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

function mergeSourceSemanticRationales(sourceRequirements = [], rationales = []) {
    const bySource = new Map();
    asList(rationales).forEach(rationale => {
        const sourceId = artifactSourceId(rationale);
        if (!sourceId) return;
        if (!bySource.has(sourceId)) bySource.set(sourceId, []);
        bySource.get(sourceId).push({
            id: rationale.id || '',
            text: rationale.text || rationale.reason || '',
            evidence: rationale.evidence || '',
            parsedBy: normalizedParsedBy(rationale.parsedBy, 'ai'),
        });
    });
    return asList(sourceRequirements).map(sourceRequirement => {
        const additions = bySource.get(sourceRequirement.sourceId) || [];
        if (!additions.length) return sourceRequirement;
        return {
            ...sourceRequirement,
            rationales: [...new Map([
                ...asList(sourceRequirement.rationales),
                ...additions,
            ].map(item => [stableJson(item), item])).values()],
        };
    });
}

function withSemanticAssistance(result = {}, {
    mode = 'off',
    sourceIds = [],
    status = 'skipped',
    reason = '',
    model = '',
} = {}) {
    const targeted = new Set(sourceIds);
    return {
        ...result,
        sourceRequirements: asList(result.sourceRequirements).map(source => targeted.has(source.sourceId)
            ? {
                ...source,
                semanticAssistance: { mode, status, reason, model },
            }
            : source),
        semanticAssistance: {
            mode,
            status,
            reason,
            model,
            targetedSourceIds: [...targeted],
            targetedSourceCount: targeted.size,
        },
    };
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

function semanticRationalesFromText(rawText = '') {
    const value = asText(rawText, 2000);
    const candidates = [];
    const patterns = [
        /避免新生下午后段学习压力过大/g,
        /不占上午主科黄金时段/g,
        /方便实践材料领取和课后整理/g,
        /避免[^，。；]{2,60}/g,
        /方便[^，。；]{2,60}/g,
        /以便[^，。；]{2,60}/g,
    ];
    for (const pattern of patterns) {
        for (const match of value.matchAll(pattern)) {
            const rationale = asText(match[0], 300).replace(/[。；]+$/, '');
            if (rationale) candidates.push({ text: rationale, kind: 'rationale' });
        }
    }
    return [...new Map(candidates.map(item => [item.text, item])).values()];
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

function constraintArtifactFromRow(row = {}, requirement = null) {
    const courseScopeClarification = requirement?.courseScopeClarification === true
        || row.courseScopeClarification === true;
    const scope = requirement?.scope || row.scope || {};
    const applyTo = requirement?.applyTo || row.applyTo || '';
    const landing = applyTo === 'model_extension' && row.weekPattern
        ? normalizedTextValues(80, 'rule', 'model_extension', row.landing, requirement?.landing)
        : courseScopeClarification
            ? requirement?.landing || row.landing || []
            : row.landing || [];
    const scopeClassIds = normalizedTextValues(120, requirement?.parameters?.classIds, row.parameters?.classIds, row.classIds, scope.classIds);
    const scopeTeacherIds = normalizedTextValues(120, requirement?.parameters?.teacherIds, row.parameters?.teacherIds, row.teacherIds, scope.teacherIds);
    const scopeGradeNames = normalizedTextValues(40, requirement?.parameters?.gradeNames, row.parameters?.gradeNames, row.gradeNames, scope.gradeNames);
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
            ...(scopeClassIds.length ? { classIds: scopeClassIds } : {}),
            ...(scopeTeacherIds.length ? { teacherIds: scopeTeacherIds } : {}),
            ...(scopeGradeNames.length ? { gradeNames: scopeGradeNames } : {}),
            legacyRow: { ...row },
        },
        strength: requirement?.strength || row.priority,
        applyTo,
        scope,
        relation: requirement?.relation || row.relation || {},
        quantifier: normalizedRequirementQuantifier(
            Object.keys(requirement?.quantifier || {}).length ? requirement.quantifier : row.quantifier,
            requirement?.parameters?.minOccurrences ?? row.minOccurrences ?? row.parameters?.minOccurrences,
        ),
        status: courseScopeClarification && requirement?.status === 'needs_review'
            ? 'needs_review'
            : row.status,
        executionStatus: courseScopeClarification
            ? requirement?.executionStatus || row.executionStatus || ''
            : row.executionStatus || '',
        reviewStatus: courseScopeClarification
            ? requirement?.reviewStatus || row.reviewStatus || ''
            : row.reviewStatus || '',
        support: courseScopeClarification
            ? requirement?.support || row.support || ''
            : row.support || '',
        needsClarification: courseScopeClarification
            ? requirement?.needsClarification === true || row.needsClarification === true
            : row.needsClarification === true,
        courseScopeClarification,
        landing,
        warnings: uniqueConstraintMessages([
            ...asList(row.warnings),
            ...(courseScopeClarification ? asList(requirement?.warnings) : []),
        ]),
        clarifications: uniqueConstraintMessages([
            ...asList(row.clarifications),
            ...(courseScopeClarification ? asList(requirement?.clarifications) : []),
        ]),
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

export {
    aggregateSourceWarnings,
    artifactProvenance,
    buildWarningItems,
    constraintArtifactFromRow,
    fallbackConstraintArtifact,
    semanticConstraintArtifact,
    INTERNAL_OBJECT_NAMES,
    INVALID_INFERRED_ENTITY_NAMES,
    OBSOLETE_EXECUTABLE_WARNING_PATTERNS,
    actionForRequirement,
    aiAssistancePayload,
    aiLocalAgreementCount,
    aiReviewStatusPayload,
    applyClarifyingAnswers,
    applyRequirementClarifyingAnswers,
    artifactSourceId,
    artifactSourceIdentityConflicts,
    blockPreferenceFromText,
    blockPreferenceRequirementsFromText,
    buildRuleReviewResult,
    cloneValue,
    compileArtifactsThroughCapabilityRegistry,
    complexModelIsEnabled,
    complexRequirementsFromText,
    dedupeRequirements,
    editedSourceRationales,
    externalRequirementItems,
    generatedTextRequirementSupersedesRow,
    gradeNamesFromText,
    hashValue,
    linkRowsToSemanticRequirements,
    localParseSourceForInput,
    localResultCanSkipAi,
    markRequirementWithAiReview,
    markRowWithAiReview,
    mergeAiFirstCandidateRows,
    mergeSourceSemanticRationales,
    missedRequirementFromReviewItem,
    nameById,
    normalizeAiReviewItems,
    optimizationRequirementsFromText,
    preciseSemanticRequirementsFromText,
    rawRowsFromConstraints,
    requirementFromRow,
    requirementItemsForClarification,
    requirementWithSourceProvenance,
    resolveSemanticRequirementRelations,
    reviewPatchAlreadyApplied,
    reviewPatchEffectKey,
    reviewTargetMatchesRequirement,
    reviewTargetMatchesRow,
    reviewTimetableParseResult,
    roomTagsFromText,
    sanitizeEditedSourceClause,
    scopeParsedCoursePreferenceRequirements,
    scopeParsedCoursePreferenceRows,
    scopedRowSupersedesGeneratedRequirement,
    semanticRequirementMatchesRow,
    sourceAwareParseResult,
    splitParseResult,
    stabilizeParsedRows,
    stableJson,
    systemRequirementsFromText,
    targetedReviewSourceIds,
    uniqueConstraintMessages,
    unresolvedConstraintRowsForAi,
    validateAiReviewFinding,
    validatedReviewPatchRow,
    withAiReviewUnavailable,
    withSemanticAssistance,
    withValidatedAiFirstResult,
};
