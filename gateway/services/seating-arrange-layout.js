import * as shared from './seating-arrange-shared.js';
import * as spec from './seating-arrange-spec.js';
const { applyAiLayoutMatrix, CELL, solveWithTimefold, TimefoldUnavailableError, evaluateSeatingConstraints, evaluateSeatingQuality, normalizeLocalAisles, MAX_ROWS, MAX_COLS, TOP_GRADE_PERCENT, asText, parseAiJson, isAiJsonParseError, boolValue, numberValue, cellValue, ensureStudents, normalizeLayout, normalizeStudentRef, normalizeAssignments, normalizeUnassigned, normalizeWarnings, studentLabel, seatCapacity, gridSeatCount, availableSeats, normalizeGuardians, validateGuardians, validateBatchAssignments, chineseNumberValue, positiveInt, NATURAL_NUMBER_PATTERN, naturalNumberFromMatch, firstNaturalNumber, extractGroupSize, hasGroupColumnWording, extractColumnCount, extractGridDimensions, extractRowCount, inferColumnPattern, normalizeColumnPattern, normalizeCapacityPolicy, inferCapacityPolicy, inferArrangementSpecFromPrompt, normalizeAislePolicy, normalizeGuardianPolicy, normalizeGuardianStrategy, normalizeGuardianGender, normalizeGuardianSlots, hasExplicitGuardianRequirement, normalizeGradeStrategy, normalizeUiPlacementPolicy, definedPlacementPolicy, inferPlacementOverridesFromPrompt, hasAnyOwn, valueConflict, specConflictWarnings, desiredGroupsPerRow, resolveSeatRows, columnPatternSeatCount, buildSeatRowFromRuns, buildPhysicalGridLayout, buildColumnPatternLayout, buildExpandableClassroomLayout, studentGradeValue, rankedStudentsByGradeDesc, getTopGradeStudentIds, getLowGradeStudentIds, protectExcellentStudentsFromLastRow, layoutSeatList, calculateSeatScoreMap, seatQuality, sortSeatsByQuality, normalizeStudentRefKey, buildNormalizedStudentMap, resolveConstraintStudentId, interleaveGender, applyGradeStrategy, sortStudentsForPlacement, placeTopGradeStudentsInBestSeats, areAdjacent, areAdjacentSeats, areNearAssignments, assignmentsToLayout, constraintEvaluationForAssignments, betterConstraintEvaluation, betterScoreEvaluation, cloneAssignments, assignmentSeatKey, buildLayoutInterpretation, buildSolverFacts } = shared;
const {
    normalizeArrangementSpec,
    shouldAllowUnassigned,
} = spec;

function buildArrangeRepairPrompt(errors = []) {
    return [
        '上一次 JSON 排座结果未通过校验。',
        '请只修正 JSON，不要解释，不要 markdown。',
        '必须保留同一个输出结构，并修复以下问题：',
        ...errors.map(error => `- ${error}`),
    ].join('\n');
}

function buildStageMessages({ stage, request, context = {}, repairErrors = [] }) {
    const system = `你是 AI 座位表总设计师。你必须完整驱动排座，但每次只完成当前 stage。

通用规则：
- 只输出 JSON，不要 markdown。
- 不要改写 stage 之外的数据。
- row/col 使用从 0 开始的内部坐标。
- 不要重复学生，不要重复座位，不要把学生安排到过道或空地。
- 如果收到 repairErrors，只修复本阶段相关问题。`;
    const payload = {
        stage,
        prompt: request.prompt,
        constraints: request.constraints,
        strategy: request.strategy,
        students: request.students,
        ...context,
    };
    if (repairErrors.length) payload.repairErrors = repairErrors;
    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
    ];
}

function layoutSummary(layout) {
    if (!layout || !Array.isArray(layout.cells)) return null;
    const rows = Number(layout.rows) || layout.cells.length;
    const cols = Number(layout.cols) || layout.cells[0]?.length || 0;
    const seats = layout.cells.flat().filter(cell => cell === CELL.SEAT || cell === 'seat' || cell === 1).length;
    return {
        rows,
        cols,
        capacity: seats + (layout.guardians?.enabled ? 2 : 0),
        template: asText(layout.template),
        guardiansEnabled: Boolean(layout.guardians?.enabled),
    };
}

function compactConstraintForPreview(constraint = {}) {
    return {
        type: asText(constraint.type),
        target: asText(constraint.target),
        related: asText(constraint.related),
        reason: asText(constraint.reason),
        priority: asText(constraint.priority) || 'soft',
    };
}

function buildLayoutPreviewMessages({ request, context = {}, repairErrors = [] }) {
    const hints = inferArrangementSpecFromPrompt(request.prompt);
    const guardianReserve = hints.guardianPolicy?.enabled ? Math.min(2, request.students.length) : 0;
    const minimumRegularSeats = Math.max(1, request.students.length - guardianReserve);
    const system = `你是教室排座要求解析器。你只负责把老师的自然语言补充解析成结构化规则，不生成座位矩阵，也不安排学生坐标。

硬性规则：
- 只输出 JSON，不要 markdown。
- 不要输出 classroomLayout、matrix、assignments、unassigned 或学生坐标。
- 本地算法负责容量、矩阵和最终几何，你只需返回 arrangementSpec。
- arrangementSpec.physicalRows 表示物理座位行数，physicalCols 表示物理座位列数，例如“每列6人”应理解为 physicalRows=6。
- arrangementSpec.capacityPolicy 只能是 "auto_expand" 或 "fixed"，老师没说固定容量时默认 auto_expand。
- layoutSpecVersion 固定为 2。
- circulation.betweenGroups / betweenRows 只能是 "none"、"gap"、"walkway"；gap 是普通桌间距，walkway 是真实不可坐人的可通行过道。
- circulation.mainAisle 只能是 "none"、"vertical"、"horizontal"、"cross"。
- “可通行”描述过道性质，不代表横向；只有“横向过道、行与行、前后排之间”等明确措辞才设置 betweenRows="walkway"。
- “每组之间设置可通行过道”必须输出 betweenGroups="walkway"、betweenRows="none"。
- diagramEdits 是用户在 SVG 识别图上的语义修改，必须应用到返回的 arrangementSpec 中。
- oddStudentPolicy 使用 "partial_group"，奇数学生允许最后一组保留一个空位。
- arrangementSpec.columnPattern 用于混合列布局，例如“两边一人一组，中间两人一组”可用 [1,"aisle",2,"aisle",2,"aisle",1]。
- “两人一桌/双人桌/同桌两个”表示 groupSize=2；“边上/两边一人一组，中间两人一组”表示混合列布局。
- previousLayoutSummary 仅在 previousLayoutPolicy="preserve" 时可以限制容量，否则旧布局只作参考且必须按当前名单扩容。
- 如果老师要求护法位，只在 guardianPolicy 中描述规则，不要填写具体学生。`;
    const payload = {
        stage: 'layout_preview',
        prompt: request.prompt,
        studentCount: request.students.length,
        constraints: (request.constraints || []).slice(0, 80).map(compactConstraintForPreview),
        diagramEdits: request.diagramEdits || [],
        strategy: request.strategy || {},
        previousLayoutPolicy: hints.keepPreviousLayout ? 'preserve' : 'reference_only_expand_if_needed',
        previousLayoutSummary: hints.keepPreviousLayout ? layoutSummary(request.previousLayout) : null,
        capacityRequirement: {
            studentCount: request.students.length,
            guardianReserve,
            minimumRegularSeats,
            minimumTotalCapacity: request.students.length,
            capacityPolicy: hints.capacityPolicy,
        },
        hints,
        outputSchema: {
            reply: '给老师的简短布局预览说明',
            layoutIntent: {
                type: 'standard|grouped|exam|u_shape|island|custom_matrix',
                description: '一句话说明布局意图',
                confidence: 'high|medium|low',
            },
            arrangementSpec: {
                layoutSpecVersion: 2,
                groupSize: 2,
                groupsPerRow: 5,
                physicalRows: 0,
                physicalCols: 0,
                capacityPolicy: 'auto_expand',
                groupGap: 'normal',
                circulation: {
                    betweenGroups: 'gap',
                    betweenRows: 'none',
                    mainAisle: 'none',
                },
                oddStudentPolicy: 'partial_group',
                columnPattern: [1, 'aisle', 2, 'aisle', 2, 'aisle', 1],
                aislePolicy: {
                    verticalBetweenGroups: true,
                    horizontalBetweenGroupRows: false,
                    mainVertical: false,
                    mainHorizontal: false,
                },
                guardianPolicy: { enabled: false, strategy: 'none', slots: [] },
                layoutMode: 'grouped',
                placementPolicy: { genderBalance: true, gradeStrategy: 'none', heightOrder: false },
                notes: '短说明',
            },
            warnings: [],
            reasoning: '为什么这样设计布局',
        },
        ...context,
    };
    if (repairErrors.length) {
        payload.repairErrors = repairErrors;
        payload.repairInstruction = '上一版规则 JSON 无效。请只修正 arrangementSpec，不要生成 classroomLayout 或矩阵。';
    }
    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
    ];
}

function buildArrangeMessages(request, repairErrors = []) {
    const studentLines = request.students
        .map(student => `${student.name}(id:${student.id}, 性别:${student.gender || '未知'}, 成绩:${student.grade ?? '无'}, 身高:${student.height ?? '无'})`)
        .join('\n');
    const constraintLines = request.constraints.length
        ? request.constraints.map((constraint, index) => `${index + 1}. ${JSON.stringify(constraint)}`).join('\n')
        : '无';
    const strategy = JSON.stringify(request.strategy || {});
    const repair = repairErrors.length ? `\n【需要修复】\n${buildArrangeRepairPrompt(repairErrors)}\n` : '';

    const allowUnassigned = shouldAllowUnassigned(request.prompt);
    const unassignedRule = allowUnassigned
        ? '老师描述了明确的座位/教室容量限制；如果容量确实不够，可以把无法安排的学生放入 unassigned。'
        : `老师没有限制教室容量；你必须自动扩大 rows/cols 和座位数量，安排全部 ${request.students.length} 名学生，unassigned 必须为空。`;

    const system = `你是 AI 座位表总设计师。你要根据老师的自然语言要求，直接设计真实教室布局并完成学生排座。

【硬性要求】
- 不要要求老师补充尺寸；缺少行列时根据学生数量和需求自动扩容 rows/cols。
- ${unassignedRule}
- 可用位置数量必须覆盖需要安排的学生；护法位可以算作额外位置，但不能占用网格座位。
- classroomLayout.cells 只能使用 "seat"、"aisle"、"empty"。
- assignments 必须使用学生 id，row/col 使用从 0 开始的内部坐标。
- 过道和空地不能安排学生，不能重复学生，不能重复座位。
- 只有在老师明确限制容量且确实无法安排时，才允许把学生放入 unassigned；否则不允许未安排。
- 护法位不在网格里；若使用护法位，放在 guardians.left / guardians.right。
- 只输出 JSON，不要 markdown；输出紧凑 JSON，不要换行和缩进，避免长名单时被截断。`;

    const user = `【老师排座需求】
${request.prompt}

【学生名单】
${studentLines}

【约束】
${constraintLines}

【策略】
${strategy}

【输出 JSON 结构】
{
  "reply": "给老师的简短说明",
  "classroomLayout": {
    "rows": 6,
    "cols": 8,
    "cells": [["seat", "aisle", "empty"]],
    "groups": [[1, null, 2]],
    "guardians": { "enabled": false, "left": null, "right": null },
    "template": "ai",
    "groupSize": 1
  },
  "assignments": [{ "studentId": "s01", "row": 0, "col": 0 }],
  "guardians": { "left": null, "right": null },
  "unassigned": [],
  "warnings": [],
  "reasoning": "简短说明为什么这样布局"
}
${repair}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function arrangeMaxTokens(env = process.env) {
    const configured = Number.parseInt(env.SEATING_ARRANGE_MAX_TOKENS, 10);
    if (Number.isInteger(configured) && configured >= 3000) return configured;
    return 8192;
}

async function requestAiStage({
    stage,
    request,
    fetchImpl,
    env = process.env,
    context = {},
    repairErrors = [],
    maxTokens,
}) {
    if (typeof fetchImpl !== 'function') throw new Error('缺少 AI 请求客户端');
    if (!env.DEEPSEEK_API_BASE || !env.DEEPSEEK_API_KEY) {
        throw new Error('AI 排座服务未配置');
    }

    const messages = stage === 'layout_preview'
        ? buildLayoutPreviewMessages({ request, context, repairErrors })
        : buildStageMessages({ stage, request, context, repairErrors });
    const response = await fetchImpl(`${env.DEEPSEEK_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
            messages,
            temperature: 0.2,
            max_tokens: maxTokens || arrangeMaxTokens(env),
            response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60000),
    });

    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.error?.message || `AI 排座服务请求失败: ${response.status}`);
    }
    return parseAiJson(payload.choices?.[0]?.message?.content);
}

async function requestStageWithRetry({
    stage,
    request,
    fetchImpl,
    env,
    context,
    validate,
    maxAttempts = 3,
    maxTokens,
}) {
    let repairErrors = [];
    let lastErrors = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const currentStage = attempt === 1 ? stage : (stage === 'assignment_batch' ? 'repair_batch' : stage);
        try {
            const raw = await requestAiStage({
                stage: currentStage,
                request,
                fetchImpl,
                env,
                context,
                repairErrors,
                maxTokens,
            });
            const validation = validate(raw);
            if (validation.ok) return { raw, data: validation.data ?? raw, stage: currentStage };
            lastErrors = validation.errors;
            repairErrors = validation.errors;
        } catch (error) {
            if (!isAiJsonParseError(error)) throw error;
            lastErrors = [`AI 返回的 JSON 不完整或格式错误：${error.message}`];
            repairErrors = lastErrors;
        }
    }
    throw new Error(`${stage} 阶段失败：${lastErrors.join('；') || 'AI 返回无效结果'}`);
}

function hasLayoutPreviewPayload(raw = {}) {
    return Boolean(raw?.classroomLayout || raw?.layout || Array.isArray(raw?.matrix));
}

function hasArrangementSpecPayload(raw = {}) {
    if (!raw || typeof raw !== 'object') return false;
    if (raw.arrangementSpec && typeof raw.arrangementSpec === 'object') {
        return hasArrangementSpecPayload(raw.arrangementSpec);
    }
    if (raw.spec && typeof raw.spec === 'object') {
        return hasArrangementSpecPayload(raw.spec);
    }
    return [
        'groupSize', 'group_size', 'groupsPerRow', 'groups_per_row',
        'physicalCols', 'physical_cols', 'physicalRows', 'physical_rows',
        'columnPattern', 'column_pattern', 'aislePolicy', 'aisles',
        'guardianPolicy', 'guardians', 'layoutMode', 'layout_mode',
        'placementPolicy', 'capacityPolicy', 'circulation', 'layoutSpecVersion',
    ].some(key => Object.prototype.hasOwnProperty.call(raw, key));
}

function layoutIntentFromSpec(spec = {}) {
    return {
        type: asText(spec.layoutMode) || 'standard',
        description: asText(spec.notes) || ((spec.groupSize || 1) > 1 ? `${spec.groupSize}人一组布局` : '标准教室布局'),
        confidence: spec.notes ? 'medium' : 'low',
    };
}

function previewStats({ request, classroomLayout, source }) {
    return {
        studentCount: request.students.length,
        regularSeatCount: gridSeatCount(classroomLayout),
        rows: classroomLayout.rows,
        cols: classroomLayout.cols,
        source,
    };
}

function uniformGroupingInvariant({ classroomLayout, regularSeatTarget, spec }) {
    const mixedPattern = Array.isArray(spec.columnPattern) && spec.columnPattern.length > 0;
    const explicitlyShaped = spec.keepPreviousLayout || Number(spec.physicalCols) > 0;
    if (mixedPattern || explicitlyShaped || spec.capacityPolicy === 'fixed') return { ok: true };

    const groupSize = Math.max(1, Number(spec.groupSize) || 1);
    const expectedGroups = Math.ceil(regularSeatTarget / groupSize);
    const expectedSeats = expectedGroups * groupSize;
    const actualGroups = new Set(
        classroomLayout.groups.flat().filter(groupId => groupId !== null && groupId !== undefined)
    ).size;
    const actualSeats = gridSeatCount(classroomLayout);
    return {
        ok: actualGroups === expectedGroups && actualSeats === expectedSeats,
        expectedGroups,
        expectedSeats,
        actualGroups,
        actualSeats,
    };
}

function buildValidatedPreviewLayout({ request, spec, regularSeatTarget, warnings }) {
    let classroomLayout = buildExpandableClassroomLayout({
        regularSeatTarget,
        spec,
        previousLayout: request.previousLayout,
    });
    const invariant = uniformGroupingInvariant({ classroomLayout, regularSeatTarget, spec });
    if (invariant.ok) return classroomLayout;

    warnings.push(
        `布局分组校验未通过：应为 ${invariant.expectedGroups} 组、${invariant.expectedSeats} 座，`
        + `实际为 ${invariant.actualGroups} 组、${invariant.actualSeats} 座，已按统一分组重建。`
    );
    const repairedSpec = {
        ...spec,
        physicalCols: 0,
        columnPattern: [],
    };
    classroomLayout = buildExpandableClassroomLayout({
        regularSeatTarget,
        spec: repairedSpec,
        previousLayout: null,
    });
    const repairedInvariant = uniformGroupingInvariant({
        classroomLayout,
        regularSeatTarget,
        spec: repairedSpec,
    });
    if (!repairedInvariant.ok) {
        throw new Error(
            `统一分组布局重建失败：应为 ${repairedInvariant.expectedGroups} 组、${repairedInvariant.expectedSeats} 座，`
            + `实际为 ${repairedInvariant.actualGroups} 组、${repairedInvariant.actualSeats} 座`
        );
    }
    return classroomLayout;
}

function buildPreviewLayoutFromSpec({ request, spec, source = 'local_layout_fallback', warnings = [], reply, reasoning }) {
    const guardianReserve = spec.guardianPolicy?.enabled ? Math.min(2, request.students.length) : 0;
    const normalizedWarnings = normalizeWarnings(warnings);
    const regularSeatTarget = Math.max(1, request.students.length - guardianReserve);
    const classroomLayout = buildValidatedPreviewLayout({
        request,
        spec,
        regularSeatTarget,
        warnings: normalizedWarnings,
    });
    classroomLayout.guardians = {
        enabled: Boolean(spec.guardianPolicy?.enabled),
        left: null,
        right: null,
    };
    return {
        reply: reply || (source === 'local_layout_fallback' ? 'AI 布局不可用，已生成本地备用布局预览。' : '已根据 AI 规则生成布局预览。'),
        classroomLayout,
        layoutIntent: layoutIntentFromSpec(spec),
        warnings: normalizedWarnings,
        reasoning: reasoning || (source === 'local_layout_fallback' ? '本地算法根据已解析规则生成备用布局。' : (spec.notes || 'AI 返回规则参数，本地算法生成布局矩阵。')),
        source,
        arrangementSpec: spec,
        stats: previewStats({ request, classroomLayout, source }),
    };
}

function normalizeLayoutPreviewRaw({ raw, request }) {
    if (hasArrangementSpecPayload(raw) || hasLayoutPreviewPayload(raw)) {
        const rawSpec = raw?.arrangementSpec && typeof raw.arrangementSpec === 'object'
            ? raw.arrangementSpec
            : (raw?.spec && typeof raw.spec === 'object' ? raw.spec : raw);
        const normalizedSpec = normalizeArrangementSpec(rawSpec, request);
        const legacyMatrixWarning = hasLayoutPreviewPayload(raw)
            ? ['AI 返回了旧式布局矩阵，已忽略矩阵并按规则重新生成。']
            : [];
        return {
            ok: true,
            errors: [],
            data: buildPreviewLayoutFromSpec({
                request,
                spec: normalizedSpec,
                source: 'ai_spec_local_algorithm',
                warnings: [
                    ...normalizeWarnings(raw?.warnings),
                    ...legacyMatrixWarning,
                    ...(normalizedSpec.parseWarnings || []),
                ],
                reply: asText(raw?.reply) || '已识别排座规则并生成布局预览。',
                reasoning: asText(raw?.reasoning) || normalizedSpec.notes,
            }),
        };
    }

    return { ok: false, errors: ['AI 未返回有效的 arrangementSpec'] };
}

async function runAiLayoutPreview({
    request,
    fetchImpl,
    env = process.env,
} = {}) {
    if (!request) throw new Error('缺少排座请求');
    const fallbackSpec = normalizeArrangementSpec(request.arrangementSpec || {}, request);

    if (request.arrangementSpec) {
        return buildPreviewLayoutFromSpec({
            request,
            spec: fallbackSpec,
            source: 'confirmed_spec_local_algorithm',
            warnings: fallbackSpec.parseWarnings || [],
            reply: '已按确认规则生成布局预览。',
            reasoning: '本地算法根据已确认的排座规则生成布局矩阵。',
        });
    }

    if (typeof fetchImpl !== 'function' || !env.DEEPSEEK_API_BASE || !env.DEEPSEEK_API_KEY) {
        return buildPreviewLayoutFromSpec({
            request,
            spec: fallbackSpec,
            source: 'local_layout_fallback',
            warnings: [],
            reply: '已按本地规则生成布局预览。',
        });
    }

    try {
        const result = await requestStageWithRetry({
            stage: 'layout_preview',
            request,
            fetchImpl,
            env,
            context: {},
            validate: raw => normalizeLayoutPreviewRaw({ raw, request }),
            maxAttempts: 2,
            maxTokens: 1600,
        });
        return result.data;
    } catch (error) {
        const fallback = buildPreviewLayoutFromSpec({
            request,
            spec: fallbackSpec,
            source: 'local_layout_fallback',
            warnings: [],
            reply: '已按本地规则生成布局预览。',
            reasoning: `本地算法根据已解析规则生成布局。规则解析服务未采用原因：${error.message}`,
        });
        fallback.stats.fallbackReason = error.message;
        return fallback;
    }
}

async function buildLocalArrangement({ request, spec, specWarnings = [], env = process.env, fetchImpl }) {
    const preview = buildPreviewLayoutFromSpec({
        request,
        spec,
        source: 'ai_spec_local_algorithm',
        warnings: [],
    });
    return assignStudentsToLayout({
        request,
        spec,
        specWarnings,
        classroomLayout: preview.classroomLayout,
        layoutSource: preview.source,
        env,
        fetchImpl,
    });
}

export {
    buildArrangeRepairPrompt,
    buildArrangeMessages,
    parseAiJson,
    isAiJsonParseError,
    arrangeMaxTokens,
    buildStageMessages,
    layoutSummary,
    compactConstraintForPreview,
    buildLayoutPreviewMessages,
    requestAiStage,
    requestStageWithRetry,
    hasLayoutPreviewPayload,
    hasArrangementSpecPayload,
    layoutIntentFromSpec,
    previewStats,
    buildPreviewLayoutFromSpec,
    normalizeLayoutPreviewRaw,
    runAiLayoutPreview,
    buildLocalArrangement,
};
