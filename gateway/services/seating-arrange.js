import * as shared from './seating-arrange-shared.js';
import * as spec from './seating-arrange-spec.js';
import * as layout from './seating-arrange-layout.js';
import * as assignment from './seating-arrange-assignment.js';
const { applyAiLayoutMatrix, CELL, solveWithTimefold, TimefoldUnavailableError, evaluateSeatingConstraints, evaluateSeatingQuality, normalizeLocalAisles, MAX_ROWS, MAX_COLS, TOP_GRADE_PERCENT, asText, boolValue, numberValue, cellValue, ensureStudents, normalizeLayout, normalizeStudentRef, normalizeAssignments, normalizeUnassigned, normalizeWarnings, studentLabel, seatCapacity, gridSeatCount, availableSeats, normalizeGuardians, validateGuardians, validateBatchAssignments, chineseNumberValue, positiveInt, NATURAL_NUMBER_PATTERN, naturalNumberFromMatch, firstNaturalNumber, extractGroupSize, hasGroupColumnWording, extractColumnCount, extractGridDimensions, extractRowCount, inferColumnPattern, normalizeColumnPattern, normalizeCapacityPolicy, inferCapacityPolicy, inferArrangementSpecFromPrompt, normalizeAislePolicy, normalizeGuardianPolicy, normalizeGuardianStrategy, normalizeGuardianGender, normalizeGuardianSlots, hasExplicitGuardianRequirement, normalizeGradeStrategy, normalizeUiPlacementPolicy, definedPlacementPolicy, inferPlacementOverridesFromPrompt, hasAnyOwn, valueConflict, specConflictWarnings, desiredGroupsPerRow, resolveSeatRows, columnPatternSeatCount, buildSeatRowFromRuns, buildPhysicalGridLayout, buildColumnPatternLayout, buildExpandableClassroomLayout, studentGradeValue, rankedStudentsByGradeDesc, getTopGradeStudentIds, getLowGradeStudentIds, protectExcellentStudentsFromLastRow, layoutSeatList, calculateSeatScoreMap, seatQuality, sortSeatsByQuality, normalizeStudentRefKey, buildNormalizedStudentMap, resolveConstraintStudentId, interleaveGender, applyGradeStrategy, sortStudentsForPlacement, placeTopGradeStudentsInBestSeats, areAdjacent, areAdjacentSeats, areNearAssignments, assignmentsToLayout, constraintEvaluationForAssignments, betterConstraintEvaluation, betterScoreEvaluation, cloneAssignments, assignmentSeatKey, buildLayoutInterpretation, buildSolverFacts } = shared;
const {
    normalizeArrangeRequest,
    normalizeArrangementSpec,
    shouldAllowUnassigned,
    normalizeLayoutPlan,
    validateLayoutPlan,
} = spec;
const {
    runAiLayoutPreview,
    buildLocalArrangement,
    buildArrangeMessages,
    buildArrangeRepairPrompt,
    isAiJsonParseError,
    parseAiJson,
    arrangeMaxTokens,
} = layout;
const { assignStudentsToLayout, optimizeSeatingScore, validateAiArrangement } = assignment;

async function runAiDrivenArrangement({
    request,
    fetchImpl,
    env = process.env,
} = {}) {
    if (!request) throw new Error('缺少排座请求');
    if (request.confirmedLayout) {
        const spec = normalizeArrangementSpec(request.arrangementSpec || {}, request);
        const plan = normalizeLayoutPlan({
            classroomLayout: request.confirmedLayout,
            arrangementSpec: request.arrangementSpec || {},
        });
        const allowUnassigned = shouldAllowUnassigned(request.prompt) || spec.capacityPolicy === 'fixed';
        const layoutValidation = validateLayoutPlan(plan, request.students.length, allowUnassigned);
        if (!layoutValidation.ok) throw new Error(`确认布局校验失败：${layoutValidation.errors.join('；')}`);
        const arrangement = await assignStudentsToLayout({
            request,
            spec,
            specWarnings: spec.parseWarnings || [],
            classroomLayout: plan.classroomLayout,
            layoutSource: 'confirmed_layout',
            env,
            fetchImpl,
        });
        const validation = validateAiArrangement({
            raw: arrangement,
            students: request.students,
            allowUnassigned,
        });
        if (!validation.ok) throw new Error(`确认布局排座校验失败：${validation.errors.join('；')}`);
        return {
            ...validation.data,
            source: arrangement.source,
            arrangementSpec: arrangement.arrangementSpec,
            stats: arrangement.stats,
            unsatisfied: arrangement.unsatisfied,
            interpretation: arrangement.interpretation,
        };
    }

    const preview = await runAiLayoutPreview({ request, fetchImpl, env });
    const spec = preview.arrangementSpec || normalizeArrangementSpec(request.arrangementSpec || {}, request);
    const specWarnings = normalizeWarnings(preview.warnings);
    const allowUnassigned = shouldAllowUnassigned(request.prompt) || spec.capacityPolicy === 'fixed';
    const arrangement = await assignStudentsToLayout({
        request,
        spec,
        specWarnings,
        classroomLayout: preview.classroomLayout,
        layoutSource: preview.source,
        env,
        fetchImpl,
    });
    const validation = validateAiArrangement({
        raw: arrangement,
        students: request.students,
        allowUnassigned,
    });
    if (!validation.ok) throw new Error(`本地排座校验失败：${validation.errors.join('；')}`);
    return {
        ...validation.data,
        source: arrangement.source,
        arrangementSpec: arrangement.arrangementSpec,
        stats: arrangement.stats,
        unsatisfied: arrangement.unsatisfied,
        interpretation: arrangement.interpretation,
    };
}

async function requestAiArrangement({
    request,
    fetchImpl,
    env = process.env,
    repairErrors = [],
}) {
    if (typeof fetchImpl !== 'function') throw new Error('缺少 AI 请求客户端');
    if (!env.DEEPSEEK_API_BASE || !env.DEEPSEEK_API_KEY) {
        throw new Error('AI 排座服务未配置');
    }

    const response = await fetchImpl(`${env.DEEPSEEK_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
            messages: buildArrangeMessages(request, repairErrors),
            temperature: 0.2,
            max_tokens: arrangeMaxTokens(env),
            response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60000),
    });

    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.error?.message || `AI 排座服务请求失败: ${response.status}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    return parseAiJson(content);
}

export {
    normalizeArrangeRequest,
    shouldAllowUnassigned,
    validateAiArrangement,
    buildArrangeRepairPrompt,
    buildArrangeMessages,
    parseAiJson,
    isAiJsonParseError,
    optimizeSeatingScore,
    runAiLayoutPreview,
    runAiDrivenArrangement,
    requestAiArrangement,
};
