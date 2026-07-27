import path from 'node:path';
import {
    getActivePeriods,
    normalizeTimetableProject,
    slotKey,
} from './timetable-project.js';
import {
    compileRequirementToRows,
} from './timetable-intent-compiler.js';
import {
    normalizeTimetableMarketTextWithTrace,
} from './timetable-language-normalizer.js';
import {
    linkArtifactToSource,
} from './timetable-constraints/source-requirement.js';
import {
    alignAiArtifactsToSources,
} from './timetable-constraints/ai-source-alignment.js';
import {
    validateSemanticRelationGraph,
} from './timetable-constraints/semantic-planning.js';

import {
    TimetableRuleParseError,
    asList,
    asText,
    classifyWorkbook,
    cleanRulePromptText,
    entityLabel,
    findEntity,
    findTarget,
    isAllTeachersTarget,
    isSystemHandledDraftRow,
    normalizedParsedBy,
    normalizedTextValues,
    parserActors,
    prepareSourceInputs,
    targetTypeFor,
    workbookSheets,
} from './timetable-rule-parser-sources.js';
import {
    actionForRequirement,
    aiAssistancePayload,
    aiReviewStatusPayload,
    applyClarifyingAnswers,
    applyRequirementClarifyingAnswers,
    artifactSourceId,
    buildRuleReviewResult,
    cloneValue,
    compileArtifactsThroughCapabilityRegistry,
    editedSourceRationales,
    linkRowsToSemanticRequirements,
    markRequirementWithAiReview,
    markRowWithAiReview,
    missedRequirementFromReviewItem,
    nameById,
    normalizeAiReviewItems,
    requirementItemsForClarification,
    reviewPatchAlreadyApplied,
    reviewPatchEffectKey,
    reviewTargetMatchesRequirement,
    reviewTargetMatchesRow,
    roomTagsFromText,
    sanitizeEditedSourceClause,
    scopeParsedCoursePreferenceRows,
    sourceAwareParseResult,
    splitParseResult,
    stabilizeParsedRows,
    stableJson,
    uniqueConstraintMessages,
    validateAiReviewFinding,
    validatedReviewPatchRow,
} from './timetable-rule-parser-artifacts.js';
import {
    PARSER_VERSION,
    SUGGESTION_ONLY_TYPES,
    SUPPORTED_EFFECTIVE_TYPES,
    addAfternoonSubject,
    addCourseInterval,
    addGlobalUnavailable,
    addLockedSlot,
    addMorningSubject,
    addRoomRequirement,
    addSlots,
    addSpreadSubject,
    addSubjectDailyLimit,
    addSubjectNotSameDay,
    addSubjectPeriodPreference,
    addSubjectSequence,
    addTeacherLimit,
    addTeacherMaxDaysPerWeek,
    addTeacherMutualExclusion,
    addTeacherWeeklyLimit,
    applyComplexModelPatch,
    buildRequirementSemantics,
    classifyDraftRow,
    emptyRulesFrom,
    expandGroupedEntityTarget,
    findLockedLessonPlan,
    normalizeDraftRow,
    parseAiOrLocal,
    parseConstraintWorkbookRules,
    parseFirstSlot,
    parseRosterWorkbookRules,
    previewFromRow,
    previewRows,
    resolveEntityList,
    setClassDailyBalance,
    setTeacherGapWeight,
    setTeacherLoadBalance,
    uploadText,
} from './timetable-rule-parser-ir.js';
import {
    getParseCache,
    parseCacheKey,
    parseWithPersistentCache,
    persistentParseCacheEnabled,
    setParseCache,
    withParseMetadata,
} from './timetable-rule-parser-cache.js';

function applyTimetableRequirementActions({
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

function continueTimetableRuleConversation({
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

function continueTimetableRequirementClarification({
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

function diagnoseTimetableRules({
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

function normalizeTimetableRuleDraftRows({
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
            stableJson(row.scope || {}),
            stableJson(row.relation || {}),
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
        .map((row, index) => classifyDraftRow(normalizeDraftRow(row, index, project), project));
    rows = scopeParsedCoursePreferenceRows(project, rows)
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
                    rawText: row.rawText || row.sourceText || row.source?.rawText || row.originalText || '',
                    sourceText: row.sourceText || row.rawText || row.source?.rawText || row.originalText || '',
                    source: row.source && typeof row.source === 'object'
                        ? { ...row.source, rawText: row.source.rawText || row.rawText || '' }
                        : {
                            sourceId: row.sourceId || '',
                            clauseId: row.clauseId || '',
                            rawText: row.rawText || row.sourceText || row.originalText || '',
                        },
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
                return {
                    ...row,
                    capabilityId: 'teacher.compact_day',
                    targetType: 'teacher',
                    targetId: teacher.id,
                    targetName: teacher.name || row.targetName,
                    priority: 'soft',
                    status: 'effective',
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

    rows = semanticLayer.rows;
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

function rebindTimetableRuleResult({
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

function recompileTimetableSourceRequirement({
    project: inputProject = {},
    previousResult = {},
    sourceId = '',
    textHash = '',
    clauses = [],
    rationales = [],
} = {}) {
    const project = normalizeTimetableProject(inputProject);
    const sourceRequirements = cloneValue(asList(previousResult.sourceRequirements)
        .filter(item => item && typeof item === 'object'));
    const target = sourceRequirements.find(item => item.sourceId === sourceId);
    if (!target) {
        throw new TimetableRuleParseError('没有找到要重编译的来源需求。', 'source_requirement_not_found', 404);
    }
    const expectedHash = asText(target.source?.textHash || target.textHash || '', 128);
    if (!textHash || textHash !== expectedHash) {
        throw new TimetableRuleParseError('来源文本已变化，请重新解析后再编辑。', 'source_text_hash_mismatch', 409);
    }
    const rawText = target.source?.rawText || target.rawText || '';
    const originalClausesById = new Map(asList(target.clauses).map(clause => [
        asText(clause.clauseId || clause.constraintId || clause.id || '', 300),
        clause,
    ]));
    const submittedClauseIds = new Set();
    const editedClauses = asList(clauses)
        .filter(item => item && typeof item === 'object')
        .map((clause, index) => {
            const clauseId = asText(clause.clauseId || clause.constraintId || clause.id || '', 300);
            const originalClause = originalClausesById.get(clauseId);
            if (!clauseId || !originalClause || submittedClauseIds.has(clauseId)) {
                throw new TimetableRuleParseError(
                    `第 ${index + 1} 个子约束不是当前来源中的可编辑子约束。`,
                    'source_clause_identity_mismatch',
                    400,
                );
            }
            submittedClauseIds.add(clauseId);
            return sanitizeEditedSourceClause(project, clause, target, index, originalClause);
        });
    const relationValidation = validateSemanticRelationGraph(rawText, editedClauses.map((clause, index) => ({
        id: clause.clauseId || clause.id || `edited_clause_${index + 1}`,
        evidence: clause.evidence?.quote || clause.reviewEvidence?.quote || '',
        relation: {
            ...(clause.relation || {}),
            parentId: clause.relation?.parentClauseId || clause.relation?.parentId || '',
        },
    })));
    if (!relationValidation.valid) {
        const error = relationValidation.errors[0];
        throw new TimetableRuleParseError(error?.message || '来源语义关系无效。', error?.code || 'invalid_semantic_relation', 400);
    }
    const nextRationales = editedSourceRationales(rationales, rawText);
    const nextSources = sourceRequirements.map(item => item.sourceId === sourceId
        ? {
            ...item,
            semanticAuthoritative: true,
            clauses: [],
            machineRuleIds: [],
            rationales: nextRationales,
            parsedBy: normalizedParsedBy(item.parsedBy, 'manual_semantic_edit'),
        }
        : { ...item, semanticAuthoritative: true });
    const semanticRequirements = [
        ...asList(previousResult.requirementItems).filter(item => artifactSourceId(item) !== sourceId),
        ...editedClauses,
    ];
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: asList(previousResult.draftRows).filter(item => artifactSourceId(item) !== sourceId),
        semanticRequirements,
        sourceRequirements: nextSources,
        source: 'source_recompile',
        inputType: previousResult.inputType || 'source_recompile',
        contextStats: previousResult.contextStats || null,
        initialWarnings: asList(previousResult.warningItems || previousResult.warnings)
            .filter(item => artifactSourceId(item) !== sourceId),
        rejected: asList(previousResult.rejected).filter(item => artifactSourceId(item) !== sourceId),
        originalText: previousResult.originalText || rawText,
    });
}

function parserShadowTextWithTrace(text = '') {
    return normalizeTimetableMarketTextWithTrace(text);
}

function applyAiReviewToParseResult({
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

async function parseTimetableRules({
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

export {
    TimetableRuleParseError,
    applyTimetableRequirementActions,
    continueTimetableRuleConversation,
    continueTimetableRequirementClarification,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    rebindTimetableRuleResult,
    recompileTimetableSourceRequirement,
    parserShadowTextWithTrace,
    applyAiReviewToParseResult,
    parseTimetableRules,
};
