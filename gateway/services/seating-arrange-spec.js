import * as shared from './seating-arrange-shared.js';
const { applyAiLayoutMatrix, CELL, solveWithTimefold, TimefoldUnavailableError, evaluateSeatingConstraints, evaluateSeatingQuality, normalizeLocalAisles, MAX_ROWS, MAX_COLS, TOP_GRADE_PERCENT, asText, parseAiJson, shouldAllowUnassigned, boolValue, numberValue, cellValue, ensureStudents, normalizeLayout, normalizeStudentRef, normalizeAssignments, normalizeUnassigned, normalizeWarnings, studentLabel, seatCapacity, gridSeatCount, availableSeats, normalizeGuardians, validateGuardians, validateBatchAssignments, chineseNumberValue, positiveInt, NATURAL_NUMBER_PATTERN, naturalNumberFromMatch, firstNaturalNumber, extractGroupSize, hasGroupColumnWording, extractColumnCount, extractGridDimensions, extractRowCount, inferColumnPattern, normalizeColumnPattern, normalizeCapacityPolicy, inferCapacityPolicy, inferArrangementSpecFromPrompt, normalizeAislePolicy, normalizeGuardianPolicy, normalizeGuardianStrategy, normalizeGuardianGender, normalizeGuardianSlots, hasExplicitGuardianRequirement, normalizeGradeStrategy, normalizeUiPlacementPolicy, definedPlacementPolicy, inferPlacementOverridesFromPrompt, hasAnyOwn, valueConflict, specConflictWarnings, desiredGroupsPerRow, resolveSeatRows, columnPatternSeatCount, buildSeatRowFromRuns, buildPhysicalGridLayout, buildColumnPatternLayout, buildExpandableClassroomLayout, studentGradeValue, rankedStudentsByGradeDesc, getTopGradeStudentIds, getLowGradeStudentIds, protectExcellentStudentsFromLastRow, layoutSeatList, calculateSeatScoreMap, seatQuality, sortSeatsByQuality, normalizeStudentRefKey, buildNormalizedStudentMap, resolveConstraintStudentId, interleaveGender, applyGradeStrategy, sortStudentsForPlacement, placeTopGradeStudentsInBestSeats, areAdjacent, areAdjacentSeats, areNearAssignments, assignmentsToLayout, constraintEvaluationForAssignments, betterConstraintEvaluation, betterScoreEvaluation, cloneAssignments, assignmentSeatKey, buildLayoutInterpretation, buildSolverFacts } = shared;

function placeholderStudents(count) {
    const total = positiveInt(count, 0, 0, 1000000);
    return Array.from({ length: total }, (_, index) => ({
        id: `__layout_student_${index + 1}`,
        name: `学生${index + 1}`,
    }));
}

function normalizeArrangeRequest(body = {}, options = {}) {
    const prompt = asText(body.prompt);
    if (!prompt) throw new Error('请输入排座需求');
    const allowStudentCountOnly = options.allowStudentCountOnly === true;
    const students = Array.isArray(body.students) && body.students.length
        ? ensureStudents(body.students)
        : allowStudentCountOnly
            ? placeholderStudents(body.studentCount)
            : ensureStudents(body.students);
    return {
        prompt,
        students,
        constraints: Array.isArray(body.constraints) ? body.constraints : [],
        strategy: body.strategy && typeof body.strategy === 'object' ? body.strategy : {},
        previousLayout: body.previousLayout || null,
        previousAssignments: Array.isArray(body.previousAssignments) ? body.previousAssignments : [],
        confirmedLayout: body.confirmedLayout || null,
        arrangementSpec: body.arrangementSpec && typeof body.arrangementSpec === 'object' ? body.arrangementSpec : null,
        diagramEdits: Array.isArray(body.diagramEdits) ? body.diagramEdits : [],
    };
}

function normalizeLayoutPlan(raw) {
    const classroomLayout = normalizeLayout(raw || {});
    return {
        reply: asText(raw?.reply) || '已生成座位布局预览',
        classroomLayout,
        warnings: normalizeWarnings(raw?.warnings),
        reasoning: asText(raw?.reasoning),
        layoutIntent: raw?.layoutIntent && typeof raw.layoutIntent === 'object' ? raw.layoutIntent : null,
        arrangementSpec: raw?.arrangementSpec && typeof raw.arrangementSpec === 'object'
            ? raw.arrangementSpec
            : (raw?.spec && typeof raw.spec === 'object' ? raw.spec : null),
    };
}

function validateLayoutPlan(plan, studentCount, allowUnassigned) {
    const errors = [];
    if (plan.classroomLayout.rows > MAX_ROWS || plan.classroomLayout.cols > MAX_COLS) {
        errors.push(`布局尺寸必须在 1-${MAX_ROWS} 行、1-${MAX_COLS} 列内`);
    }
    if (!allowUnassigned && seatCapacity(plan.classroomLayout) < studentCount) {
        errors.push(`布局容量不足：当前 ${seatCapacity(plan.classroomLayout)} 个可用位置，需要 ${studentCount} 个`);
    }
    if (gridSeatCount(plan.classroomLayout) === 0) {
        errors.push('布局没有普通座位');
    }
    return { ok: errors.length === 0, errors };
}

function normalizeGroupGap(value, fallback = 'none') {
    const text = asText(value).toLowerCase();
    if (['none', 'off', 'closed', '无', '不留'].includes(text)) return 'none';
    if (['normal', 'gap', 'spacing', '普通', '留距', '间距'].includes(text)) return 'normal';
    return fallback === 'normal' ? 'normal' : 'none';
}

function normalizeOddStudentPolicy(value) {
    const text = asText(value).toLowerCase();
    if (['partial_group', 'allow_partial_group', 'single_in_group', '保留空位', '末组不满'].includes(text)) {
        return 'partial_group';
    }
    return 'partial_group';
}

function normalizeCirculationValue(value, fallback = 'none') {
    const text = asText(value).toLowerCase();
    if (['none', 'off', 'closed', '无', '不留', '紧挨'].includes(text)) return 'none';
    if (['gap', 'normal', 'spacing', 'space', '普通', '留距', '间距'].includes(text)) return 'gap';
    if (['walkway', 'aisle', 'corridor', '通行', '过道', '通道', '走道', '可通行'].includes(text)) return 'walkway';
    return ['none', 'gap', 'walkway'].includes(fallback) ? fallback : 'none';
}

function normalizeMainAisle(value, fallback = 'none') {
    const text = asText(value).toLowerCase();
    if (['none', '无', 'off'].includes(text)) return 'none';
    if (['vertical', '竖', '纵', '竖向', '纵向'].includes(text)) return 'vertical';
    if (['horizontal', '横', '横向'].includes(text)) return 'horizontal';
    if (['cross', 'both', '十字', '横竖', '交叉'].includes(text)) return 'cross';
    return ['none', 'vertical', 'horizontal', 'cross'].includes(fallback) ? fallback : 'none';
}

function normalizeCirculation(raw = {}, inferred = {}) {
    const legacy = raw && typeof raw === 'object' ? raw : {};
    const fallback = inferred && typeof inferred === 'object' ? inferred : {};
    const legacyAisles = legacy.aislePolicy || legacy.aisles || {};
    const hasOwn = (object, ...keys) => keys.some(key => Object.prototype.hasOwnProperty.call(object || {}, key)
        && object[key] !== undefined
        && object[key] !== null);
    const legacyGroupGap = normalizeGroupGap(legacy.groupGap ?? legacy.group_gap, 'none');
    const hasLegacyBetweenGroups = hasOwn(legacy, 'betweenGroups', 'groupGap', 'group_gap')
        || hasOwn(legacyAisles, 'verticalBetweenGroups', 'vertical', 'colAisles');
    const hasLegacyBetweenRows = hasOwn(legacy, 'betweenRows')
        || hasOwn(legacyAisles, 'horizontalBetweenGroupRows', 'horizontal', 'rowAisles');
    const betweenGroupsFallback = hasLegacyBetweenGroups
        ? (legacyGroupGap === 'normal' || legacyAisles.verticalBetweenGroups ? 'gap' : 'none')
        : (fallback.betweenGroups || 'none');
    const betweenRowsFallback = hasLegacyBetweenRows
        ? (legacyAisles.horizontalBetweenGroupRows ? 'gap' : 'none')
        : (fallback.betweenRows || 'none');
    const hasLegacyMainAisle = hasOwn(legacy, 'mainAisle')
        || hasOwn(legacyAisles, 'mainVertical', 'mainHorizontal', 'main_vertical', 'main_horizontal', 'centralVertical', 'centralHorizontal');
    const legacyMain = legacyAisles.mainVertical && legacyAisles.mainHorizontal
        ? 'cross'
        : legacyAisles.mainVertical
            ? 'vertical'
            : legacyAisles.mainHorizontal
                ? 'horizontal'
                : 'none';
    const mainAisleFallback = hasLegacyMainAisle ? legacyMain : (fallback.mainAisle || 'none');
    return {
        betweenGroups: normalizeCirculationValue(legacy.betweenGroups, betweenGroupsFallback),
        betweenRows: normalizeCirculationValue(legacy.betweenRows, betweenRowsFallback),
        mainAisle: normalizeMainAisle(legacy.mainAisle, mainAisleFallback),
    };
}

function applyDiagramEditsToSpec(spec, edits = []) {
    const next = {
        ...spec,
        circulation: { ...(spec.circulation || {}) },
        aislePolicy: { ...(spec.aislePolicy || {}) },
    };
    for (const edit of Array.isArray(edits) ? edits : []) {
        if (!edit || typeof edit !== 'object') continue;
        const value = edit.value || edit.mode;
        if (edit.type === 'set_group_size') {
            const groupSize = positiveInt(value, next.groupSize || 1, 1, 4);
            next.groupSize = groupSize;
            next.layoutMode = groupSize > 1 ? 'grouped' : 'standard';
            next.columnPattern = [];
            delete next.customPattern;
        }
        if (edit.type === 'set_boundary' || edit.type === 'set_circulation') {
            const target = edit.target || (edit.orientation === 'horizontal' ? 'betweenRows' : 'betweenGroups');
            if (target === 'betweenGroups') next.circulation.betweenGroups = normalizeCirculationValue(value, next.circulation.betweenGroups);
            if (target === 'betweenRows') next.circulation.betweenRows = normalizeCirculationValue(value, next.circulation.betweenRows);
        }
        if (edit.type === 'set_main_aisle') {
            next.circulation.mainAisle = normalizeMainAisle(value, next.circulation.mainAisle);
        }
    }
    next.aislePolicy.verticalBetweenGroups = next.circulation.betweenGroups !== 'none';
    next.aislePolicy.horizontalBetweenGroupRows = next.circulation.betweenRows !== 'none';
    next.aislePolicy.mainVertical = ['vertical', 'cross'].includes(next.circulation.mainAisle);
    next.aislePolicy.mainHorizontal = ['horizontal', 'cross'].includes(next.circulation.mainAisle);
    next.groupGap = next.circulation.betweenGroups === 'gap' ? 'normal' : 'none';
    return next;
}

function mergeArrangementSpecSources(raw = {}, requested = {}) {
    const aiSpec = raw && typeof raw === 'object' ? raw : {};
    const requestedSpec = requested && typeof requested === 'object' ? requested : {};
    return {
        ...aiSpec,
        ...requestedSpec,
        aislePolicy: {
            ...(aiSpec.aislePolicy || aiSpec.aisles || {}),
            ...(requestedSpec.aislePolicy || requestedSpec.aisles || {}),
        },
        guardianPolicy: {
            ...(aiSpec.guardianPolicy || aiSpec.guardians || {}),
            ...(requestedSpec.guardianPolicy || requestedSpec.guardians || {}),
        },
        placementPolicy: {
            ...(aiSpec.placementPolicy || {}),
            ...(requestedSpec.placementPolicy || {}),
        },
        circulation: {
            ...(aiSpec.circulation || {}),
            ...(requestedSpec.circulation || {}),
        },
    };
}

function normalizeArrangementSpec(raw = {}, request = {}) {
    const inferred = inferArrangementSpecFromPrompt(request.prompt);
    const source = mergeArrangementSpecSources(raw, request.arrangementSpec);
    const placementPolicy = source.placementPolicy && typeof source.placementPolicy === 'object' ? source.placementPolicy : {};
    const rawGroupSize = positiveInt(source.groupSize ?? source.group_size, 0, 0, 12);
    const groupSize = rawGroupSize > 0 ? rawGroupSize : inferred.groupSize;
    const layoutMode = asText(source.layoutMode || source.layout_mode) || inferred.layoutMode || 'standard';
    const rawGroupsPerRow = positiveInt(source.groupsPerRow ?? source.groups_per_row, 0, 0, 1000000);
    const rawPhysicalCols = positiveInt(source.physicalCols ?? source.physical_cols ?? source.cols, 0, 0, 1000000);
    const rawPhysicalRows = positiveInt(source.physicalRows ?? source.physical_rows ?? source.rows, 0, 0, 1000000);
    const groupsPerRow = rawGroupsPerRow > 0 ? rawGroupsPerRow : inferred.groupsPerRow;
    const physicalCols = rawPhysicalCols > 0 ? rawPhysicalCols : inferred.physicalCols;
    const physicalRows = rawPhysicalRows > 0 ? rawPhysicalRows : inferred.physicalRows;
    const explicitColumnPattern = normalizeColumnPattern(inferred.columnPattern);
    const rawColumnPattern = normalizeColumnPattern(source.columnPattern ?? source.column_pattern);
    const customPattern = asText(source.customPattern || source.custom_pattern);
    const promptAllowsMixedPattern = explicitColumnPattern.length > 0;
    const columnPattern = promptAllowsMixedPattern
        ? (rawColumnPattern.length ? rawColumnPattern : explicitColumnPattern)
        : [];
    if (promptAllowsMixedPattern && !rawColumnPattern.length && /edge-single-inner-pair/.test(customPattern)) {
        columnPattern.splice(0, columnPattern.length, 1, 'aisle', 2, 'aisle', 2, 'aisle', 1);
    }
    const capacityPolicy = normalizeCapacityPolicy(source.capacityPolicy ?? source.capacity_policy, inferred.capacityPolicy);
    const aislePolicy = normalizeAislePolicy(source.aislePolicy || source.aisles || {}, inferred.aislePolicy);
    const groupGap = normalizeGroupGap(
        source.groupGap ?? source.group_gap,
        aislePolicy.verticalBetweenGroups ? 'normal' : 'none'
    );
    aislePolicy.verticalBetweenGroups = groupGap !== 'none';
    const promptPlacementOverrides = inferPlacementOverridesFromPrompt(request.prompt);
    const rawGuardianPolicy = source.guardianPolicy || source.guardians || null;
    const guardianPolicy = normalizeGuardianPolicy(rawGuardianPolicy || {}, inferred.guardianPolicy);
    if (!hasExplicitGuardianRequirement(rawGuardianPolicy) && inferred.guardianPolicy.strategy !== 'none') {
        guardianPolicy.enabled = true;
        guardianPolicy.strategy = inferred.guardianPolicy.strategy;
    }
    const normalized = {
        layoutSpecVersion: 2,
        groupSize,
        groupsPerRow: physicalCols > 0 ? 0 : groupsPerRow,
        physicalCols,
        physicalRows,
        capacityPolicy,
        groupGap,
        circulation: normalizeCirculation({
            ...(source.circulation || {}),
            aislePolicy: source.aislePolicy || source.aisles || {},
            groupGap: source.groupGap ?? source.group_gap,
        }, inferred.circulation),
        oddStudentPolicy: normalizeOddStudentPolicy(source.oddStudentPolicy ?? source.odd_student_policy),
        columnPattern,
        aislePolicy,
        guardianPolicy,
        layoutMode,
        placementPolicy: normalizeUiPlacementPolicy({
            ...normalizeUiPlacementPolicy(request.strategy),
            ...promptPlacementOverrides,
            ...definedPlacementPolicy(placementPolicy),
        }),
        strategyOverrides: promptPlacementOverrides,
        keepPreviousLayout: boolValue(source.keepPreviousLayout ?? source.keep_previous_layout, inferred.keepPreviousLayout),
        assumptions: inferred.assumptions || [],
        notes: asText(source.notes || source.reasoning),
    };
    const edited = applyDiagramEditsToSpec(normalized, request.diagramEdits);
    normalized.groupSize = edited.groupSize;
    normalized.layoutMode = edited.layoutMode;
    normalized.columnPattern = edited.columnPattern;
    normalized.circulation = edited.circulation;
    normalized.groupGap = edited.groupGap;
    normalized.aislePolicy = normalized.circulation.mainAisle === 'cross'
        ? { ...normalized.aislePolicy, mainVertical: true, mainHorizontal: true }
        : {
            ...normalized.aislePolicy,
            verticalBetweenGroups: normalized.circulation.betweenGroups !== 'none',
            horizontalBetweenGroupRows: normalized.circulation.betweenRows !== 'none',
            mainVertical: normalized.circulation.mainAisle === 'vertical',
            mainHorizontal: normalized.circulation.mainAisle === 'horizontal',
        };
    normalized.parseWarnings = specConflictWarnings(source, inferred, normalized);
    if (rawColumnPattern.length && !promptAllowsMixedPattern) {
        normalized.parseWarnings.push('AI 返回了自然语言未明确要求的混合分组，已按统一分组处理。');
    }
    return normalized;
}

function buildSpecMessages(request) {
    const hints = inferArrangementSpecFromPrompt(request.prompt);
    const system = `你是座位需求解析器。只把老师的自然语言需求解析成规则 JSON，不要安排任何学生坐标。
规则:
- 只输出 JSON，不要 markdown。
- 不要返回 assignments、classroomLayout、学生坐标或完整名单。
- 如果老师没有限制容量，布局应允许本地算法自动扩容。
- layoutSpecVersion 固定为 2。
- groupSize 表示几个人一组。
- circulation.betweenGroups / betweenRows 只能是 "none"、"gap"、"walkway"：gap 是普通桌间距，walkway 是真实不可坐人的可通行过道。
- circulation.mainAisle 只能是 "none"、"vertical"、"horizontal"、"cross"。
- “可通行”描述过道性质，不表示横向；只有“横向过道、行与行、前后排之间”等明确措辞才设置 betweenRows="walkway"。
- 旧字段 groupGap 和 aislePolicy 可省略；不要用它们代替 circulation。
- groupsPerRow 表示每行有几个组块；physicalCols 表示物理座位列数；physicalRows 表示物理座位行数，三者不要混用。
- capacityPolicy 只能是 "auto_expand" 或 "fixed"；老师没说固定容量时默认 auto_expand，明确说固定/只有/最多/不超过/座位有限时用 fixed。
- columnPattern 用于非均匀混合列布局：正整数表示连续座位组，"aisle" 表示一列过道，例如 [1,"aisle",2,"aisle",2,"aisle",1]。
- 如果老师说“一组是一列/每组一列/每列一组”，再说“一共 N 列”，应输出 groupsPerRow=N，并默认 verticalBetweenGroups=true。
- 如果老师说“N列座位/物理列”，应输出 physicalCols=N，不要输出 groupsPerRow=N。
- 如果老师说“每排/每行 N 人”，应输出 physicalCols=N；如果说“每列 N 人”，应输出 physicalRows=N；如果说“N行M列”，应同时输出 physicalRows=N、physicalCols=M。
- “两人一桌/双人桌/同桌两个/两两并排”都表示 groupSize=2；“三三制/三人一桌”表示 groupSize=3。
- “每组之间留一点距离/留空/隔开”通常表示 circulation.betweenGroups="gap"。
- “每组之间设置可通行过道”表示 circulation.betweenGroups="walkway"，betweenRows 默认 "none"。
- “中央/中间留主通道”才设置 circulation.mainAisle="vertical"，明确横向时为 "horizontal"。
- “边上/两边/最边一人一组，中间/里面两人一组”应输出 columnPattern=[1,"aisle",2,"aisle",2,"aisle",1]，notes 写“两边1人组，中间2人组，组间过道”。
- guardianPolicy 用于左右护法规则，例如 lowest_grade 表示成绩最低的同学，top_grade_percent 表示成绩前20%的同学。
- 如果老师要求左右护法有组合条件，请输出 guardianPolicy.slots，必须是两个对象，例如 [{"gender":"M","strategy":"lowest_grade"},{"gender":"F","strategy":"top_grade_percent"}]。
- 护法位必须按老师最新自然语言需求输出；遇到“后来/改成/后面说”时以后面的要求为准。
示例:
输入: "两人一桌，中间留通道" -> {"layoutSpecVersion":2,"groupSize":2,"circulation":{"betweenGroups":"gap","betweenRows":"none","mainAisle":"vertical"},"layoutMode":"grouped"}
输入: "两人一组，每组之间设置可通行过道" -> {"layoutSpecVersion":2,"groupSize":2,"circulation":{"betweenGroups":"walkway","betweenRows":"none","mainAisle":"none"},"layoutMode":"grouped"}
输入: "同桌两个，分成4列组" -> {"layoutSpecVersion":2,"groupSize":2,"groupsPerRow":4,"circulation":{"betweenGroups":"gap","betweenRows":"none","mainAisle":"none"},"layoutMode":"grouped"}
输入: "每排8人，每列6人" -> {"physicalCols":8,"physicalRows":6,"layoutMode":"standard"}
输入: "6行8列，双人桌" -> {"physicalRows":6,"physicalCols":8,"groupSize":2,"layoutMode":"grouped"}
输入: "固定6行8列，最多这些座位" -> {"physicalRows":6,"physicalCols":8,"capacityPolicy":"fixed","layoutMode":"standard"}
输入: "边上一人一组，里面两人一组，组间有过道" -> {"groupSize":2,"columnPattern":[1,"aisle",2,"aisle",2,"aisle",1],"capacityPolicy":"auto_expand","layoutMode":"grouped","notes":"两边1人组，中间2人组，组间过道"}`;
    const payload = {
        stage: 'arrangement_spec',
        prompt: request.prompt,
        studentCount: request.students.length,
        hints,
        constraints: request.constraints,
        strategy: request.strategy,
        previousLayoutSummary: request.previousLayout ? {
            rows: request.previousLayout.rows,
            cols: request.previousLayout.cols,
            capacity: Array.isArray(request.previousLayout.cells)
                ? request.previousLayout.cells.flat().filter(cell => cell === CELL.SEAT || cell === 'seat' || cell === 1).length
                : undefined,
        } : null,
        outputSchema: {
            layoutSpecVersion: 2,
            groupSize: 3,
            groupsPerRow: 5,
            physicalCols: 0,
            physicalRows: 6,
            capacityPolicy: 'auto_expand',
            groupGap: 'normal',
            circulation: { betweenGroups: 'gap', betweenRows: 'none', mainAisle: 'none' },
            oddStudentPolicy: 'partial_group',
            columnPattern: [1, 'aisle', 2, 'aisle', 2, 'aisle', 1],
            aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: true, mainVertical: false, mainHorizontal: false },
            guardianPolicy: { enabled: true, strategy: 'lowest_grade', slots: [] },
            layoutMode: 'grouped',
            placementPolicy: { genderBalance: true, gradeStrategy: 'none', heightOrder: false },
            keepPreviousLayout: false,
            notes: 'short explanation',
        },
        diagramEdits: request.diagramEdits || [],
    };
    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
    ];
}

async function requestArrangementSpec({
    request,
    fetchImpl,
    env = process.env,
}) {
    if (typeof fetchImpl !== 'function' || !env.DEEPSEEK_API_BASE || !env.DEEPSEEK_API_KEY) {
        const spec = normalizeArrangementSpec({}, request);
        return {
            spec,
            warnings: ['AI 规则解析不可用，已使用本地规则解析。'],
            source: 'local_rule_parser',
        };
    }

    const response = await fetchImpl(`${env.DEEPSEEK_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
            messages: buildSpecMessages(request),
            temperature: 0.1,
            max_tokens: 1200,
            response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(30000),
    });

    const payload = await response.json();
    if (!response.ok) {
        const spec = normalizeArrangementSpec({}, request);
        return {
            spec,
            warnings: [payload?.error?.message || `AI 规则解析失败: ${response.status}，已使用本地规则解析。`],
            source: 'local_rule_parser',
        };
    }
    try {
        const spec = normalizeArrangementSpec(parseAiJson(payload.choices?.[0]?.message?.content), request);
        return {
            spec,
            warnings: spec.parseWarnings || [],
            source: 'ai_rule_parser',
        };
    } catch (error) {
        const spec = normalizeArrangementSpec({}, request);
        return {
            spec,
            warnings: [`AI 规则 JSON 无效，已使用本地规则解析：${error.message}`],
            source: 'local_rule_parser',
        };
    }
}

function appliedStrategiesFor(spec) {
    const applied = [];
    const policy = spec.placementPolicy || {};
    if (policy.genderBalance) applied.push('男女搭配');
    if (policy.heightOrder) applied.push('身高照顾');
    if (policy.gradeStrategy === 'priority') applied.push('优秀优先');
    if (policy.gradeStrategy === 'balance') applied.push('强弱互补');
    if (spec.guardianPolicy?.enabled) {
        applied.push(spec.guardianPolicy.strategy === 'lowest_grade'
            ? '成绩最低护法'
            : spec.guardianPolicy.strategy === 'top_grade_percent'
                ? '成绩前20%护法'
                : '左右护法');
    }
    if ((spec.groupSize || 1) > 1) applied.push(`${spec.groupSize}人一组`);
    return applied;
}

function strategyOverrideWarnings(spec, uiStrategy = {}) {
    const warnings = [];
    const overrides = spec.strategyOverrides || {};
    if (Object.prototype.hasOwnProperty.call(overrides, 'heightOrder')
        && boolValue(uiStrategy.heightOrder, false) !== spec.placementPolicy.heightOrder) {
        warnings.push(spec.placementPolicy.heightOrder ? '已按 AI 要求启用身高照顾' : '已按 AI 要求关闭身高照顾');
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'genderBalance')
        && boolValue(uiStrategy.genderBalance, false) !== spec.placementPolicy.genderBalance) {
        warnings.push(spec.placementPolicy.genderBalance ? '已按 AI 要求启用男女搭配' : '已按 AI 要求关闭男女搭配');
    }
    if (Object.prototype.hasOwnProperty.call(overrides, 'gradeStrategy')
        && normalizeGradeStrategy(uiStrategy.gradeStrategy) !== spec.placementPolicy.gradeStrategy) {
        const label = spec.placementPolicy.gradeStrategy === 'priority'
            ? '优秀优先'
            : spec.placementPolicy.gradeStrategy === 'balance'
                ? '强弱互补'
                : '不按成绩排序';
        warnings.push(`已按 AI 要求使用成绩策略：${label}`);
    }
    if (spec.guardianPolicy?.enabled && spec.guardianPolicy.strategy === 'lowest_grade'
        && spec.placementPolicy?.gradeStrategy && spec.placementPolicy.gradeStrategy !== 'none') {
        warnings.push('已按 AI 要求优先安排成绩最低护法，成绩策略仅用于普通座位');
    }
    return warnings;
}

export {
    normalizeArrangeRequest,
    shouldAllowUnassigned,
    normalizeLayoutPlan,
    applyDiagramEditsToSpec,
    validateLayoutPlan,
    normalizeArrangementSpec,
    buildSpecMessages,
    requestArrangementSpec,
    strategyOverrideWarnings,
    appliedStrategiesFor,
};
