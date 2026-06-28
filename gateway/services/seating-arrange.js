import {
    applyAiLayoutMatrix,
    CELL,
} from '../../shared/seating/classroom-layout.js';
import {
    solveWithTimefold,
    TimefoldUnavailableError,
} from './seating-solver-bridge.js';
import {
    evaluateSeatingConstraints,
    evaluateSeatingQuality,
    normalizeLocalAisles,
} from '../../shared/seating/seating-core.js';

const MAX_ROWS = 300;
const MAX_COLS = 80;
const TOP_GRADE_PERCENT = 0.2;

function asText(value) {
    return String(value ?? '').trim();
}

function boolValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (/^(true|1|yes|on|开启|启用)$/i.test(value.trim())) return true;
        if (/^(false|0|no|off|关闭|禁用)$/i.test(value.trim())) return false;
    }
    return Boolean(value);
}

function numberValue(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : NaN;
}

function cellValue(value, r, c) {
    if (value === 1 || value === true || value === '1' || value === CELL.SEAT || value === '座位') {
        return CELL.SEAT;
    }
    if (value === 0 || value === false || value === '0' || value === CELL.AISLE || value === '过道') {
        return CELL.AISLE;
    }
    if (value === CELL.EMPTY || value === '空地' || value === '空') {
        return CELL.EMPTY;
    }
    throw new Error(`布局单元格无效: 第${r + 1}行第${c + 1}列`);
}

function ensureStudents(students) {
    if (!Array.isArray(students) || students.length === 0) {
        throw new Error('请先导入学生名单');
    }
    const seen = new Set();
    return students.map((student, index) => {
        const id = asText(student?.id);
        if (!id) throw new Error(`第 ${index + 1} 名学生缺少学生 id`);
        if (seen.has(id)) throw new Error(`学生 id 重复: ${id}`);
        seen.add(id);
        return {
            ...student,
            id,
            name: asText(student?.name) || id,
        };
    });
}

export function normalizeArrangeRequest(body = {}) {
    const prompt = asText(body.prompt);
    if (!prompt) throw new Error('请输入排座需求');
    return {
        prompt,
        students: ensureStudents(body.students),
        constraints: Array.isArray(body.constraints) ? body.constraints : [],
        strategy: body.strategy && typeof body.strategy === 'object' ? body.strategy : {},
        previousLayout: body.previousLayout || null,
        previousAssignments: Array.isArray(body.previousAssignments) ? body.previousAssignments : [],
        confirmedLayout: body.confirmedLayout || null,
        arrangementSpec: body.arrangementSpec && typeof body.arrangementSpec === 'object' ? body.arrangementSpec : null,
    };
}

function normalizeLayout(raw) {
    const source = raw?.classroomLayout || raw?.layout || null;
    if (!source && Array.isArray(raw?.matrix)) {
        const rows = raw.rows || raw.matrix.length;
        const cols = raw.cols || raw.matrix[0]?.length || 0;
        return applyAiLayoutMatrix({
            rows,
            cols,
            matrix: raw.matrix,
            groupSize: raw.groupSize || 1,
            guardiansEnabled: boolValue(raw.guardians?.enabled ?? raw.guardiansEnabled, false),
            guardians: raw.guardians || {},
        });
    }
    if (!source || !Array.isArray(source.cells)) {
        throw new Error('AI 未返回 classroomLayout.cells');
    }

    const rows = numberValue(source.rows || source.cells.length);
    const cols = numberValue(source.cols || source.cells[0]?.length);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > MAX_ROWS || cols > MAX_COLS) {
        throw new Error(`布局尺寸必须在 1-${MAX_ROWS} 行、1-${MAX_COLS} 列内`);
    }
    if (source.cells.length !== rows) throw new Error('布局行数与 cells 不一致');

    const cells = source.cells.map((row, r) => {
        if (!Array.isArray(row) || row.length !== cols) throw new Error(`第 ${r + 1} 行列数与布局不一致`);
        return row.map((cell, c) => cellValue(cell, r, c));
    });

    const groups = Array.from({ length: rows }, (_, r) => {
        const groupRow = Array.isArray(source.groups?.[r]) ? source.groups[r] : [];
        return Array.from({ length: cols }, (_, c) => {
            const value = groupRow[c];
            return value === undefined || value === '' ? null : value;
        });
    });
    const guardians = source.guardians || {};
    return {
        rows,
        cols,
        cells,
        groups,
        guardians: {
            enabled: boolValue(guardians.enabled, false),
            left: normalizeStudentRef(guardians.left),
            right: normalizeStudentRef(guardians.right),
        },
        template: asText(source.template) || 'ai',
        groupSize: Math.max(1, Math.min(8, numberValue(source.groupSize) || 1)),
        localAisles: normalizeLocalAisles(source.localAisles, rows, cols),
    };
}

function normalizeStudentRef(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'object') return asText(value.studentId || value.student_id || value.id || value.name);
    return asText(value);
}

function normalizeAssignments(rawAssignments) {
    if (!Array.isArray(rawAssignments)) return [];
    return rawAssignments.map(item => ({
        studentId: normalizeStudentRef(item?.studentId || item?.student_id || item?.id || item?.student),
        row: numberValue(item?.row),
        col: numberValue(item?.col),
    }));
}

function normalizeUnassigned(rawUnassigned) {
    if (!Array.isArray(rawUnassigned)) return [];
    return rawUnassigned.map(normalizeStudentRef).filter(Boolean);
}

function normalizeWarnings(rawWarnings) {
    if (!Array.isArray(rawWarnings)) return [];
    return rawWarnings.map(asText).filter(Boolean);
}

function studentLabel(student) {
    return `${student.name || student.id}(${student.id})`;
}

export function shouldAllowUnassigned(prompt = '') {
    const text = asText(prompt);
    return /(只有|仅有|最多|不超过|固定|限制|限于|座位有限).*(排|列|座|座位|人)|((排|列|座|座位).*(只有|仅有|最多|不超过|固定|限制|限于))/.test(text);
}

function seatCapacity(layout) {
    const gridSeats = layout.cells
        .flat()
        .filter(cell => cell === CELL.SEAT)
        .length;
    return gridSeats + (layout.guardians?.enabled ? 2 : 0);
}

function gridSeatCount(layout) {
    return layout.cells
        .flat()
        .filter(cell => cell === CELL.SEAT)
        .length;
}

function availableSeats(layout, occupiedSeatKeys = new Set()) {
    const seats = [];
    for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
            if (layout.cells[r]?.[c] !== CELL.SEAT) continue;
            const key = `${r},${c}`;
            if (occupiedSeatKeys.has(key)) continue;
            seats.push({
                row: r,
                col: c,
                group: layout.groups?.[r]?.[c] ?? null,
            });
        }
    }
    return seats;
}

export function validateAiArrangement({ raw, students, allowUnassigned = false }) {
    const safeStudents = ensureStudents(students);
    const studentById = new Map(safeStudents.map(student => [student.id, student]));
    const errors = [];

    let classroomLayout;
    let assignments;
    try {
        classroomLayout = normalizeLayout(raw || {});
        assignments = normalizeAssignments(raw?.assignments);
    } catch (error) {
        return { ok: false, errors: [error.message], data: null };
    }

    const placedStudents = new Set();
    const occupiedSeats = new Set();
    for (const assignment of assignments) {
        const student = studentById.get(assignment.studentId);
        if (!student) {
            errors.push(`未知学生 id: ${assignment.studentId || '空'}`);
            continue;
        }
        if (placedStudents.has(assignment.studentId)) {
            errors.push(`${studentLabel(student)} 被重复安排`);
            continue;
        }
        if (!Number.isInteger(assignment.row) || !Number.isInteger(assignment.col)
            || assignment.row < 0 || assignment.col < 0
            || assignment.row >= classroomLayout.rows || assignment.col >= classroomLayout.cols) {
            errors.push(`${studentLabel(student)} 的座位坐标越界`);
            continue;
        }
        if (classroomLayout.cells[assignment.row][assignment.col] !== CELL.SEAT) {
            errors.push(`${studentLabel(student)} 被安排到非座位格`);
            continue;
        }
        const seatKey = `${assignment.row},${assignment.col}`;
        if (occupiedSeats.has(seatKey)) {
            errors.push(`第${assignment.row + 1}排第${assignment.col + 1}列被重复安排`);
            continue;
        }
        placedStudents.add(assignment.studentId);
        occupiedSeats.add(seatKey);
    }

    const guardiansFromRaw = raw?.guardians || {};
    const guardians = {
        left: normalizeStudentRef(guardiansFromRaw.left ?? classroomLayout.guardians.left),
        right: normalizeStudentRef(guardiansFromRaw.right ?? classroomLayout.guardians.right),
    };
    const guardianIds = new Set();
    for (const side of ['left', 'right']) {
        const id = guardians[side];
        if (!id) continue;
        const student = studentById.get(id);
        if (!student) {
            errors.push(`护法位包含未知学生 id: ${id}`);
            continue;
        }
        if (placedStudents.has(id) || guardianIds.has(id)) {
            errors.push(`${studentLabel(student)} 被重复安排`);
            continue;
        }
        guardianIds.add(id);
        placedStudents.add(id);
    }

    classroomLayout.guardians = {
        enabled: boolValue(classroomLayout.guardians.enabled, Boolean(guardians.left || guardians.right)),
        left: guardians.left,
        right: guardians.right,
    };

    const unassigned = normalizeUnassigned(raw?.unassigned);
    const unassignedSet = new Set();
    for (const id of unassigned) {
        if (!studentById.has(id)) {
            errors.push(`未安排名单包含未知学生 id: ${id}`);
            continue;
        }
        if (placedStudents.has(id)) {
            errors.push(`${studentLabel(studentById.get(id))} 同时出现在座位和未安排名单中`);
            continue;
        }
        if (unassignedSet.has(id)) {
            errors.push(`未安排名单重复: ${id}`);
            continue;
        }
        unassignedSet.add(id);
    }

    const missing = safeStudents
        .filter(student => !placedStudents.has(student.id) && !unassignedSet.has(student.id))
        .map(studentLabel);
    if (missing.length) errors.push(`缺少学生: ${missing.join('、')}`);
    if (!allowUnassigned && unassignedSet.size > 0) {
        errors.push(`默认不能留下未安排学生，请扩大教室布局到至少 ${safeStudents.length} 个可用位置；当前容量 ${seatCapacity(classroomLayout)}，未安排 ${unassignedSet.size} 名`);
    }

    if (errors.length) return { ok: false, errors, data: null };

    const warnings = normalizeWarnings(raw?.warnings);
    if (unassigned.length && warnings.length === 0) warnings.push(`${unassigned.length} 名学生未安排`);

    return {
        ok: true,
        errors: [],
        data: {
            reply: asText(raw?.reply) || '已根据需求生成座位表',
            classroomLayout,
            assignments,
            guardians,
            unassigned,
            warnings,
            reasoning: asText(raw?.reasoning),
        },
    };
}

export function buildArrangeRepairPrompt(errors = []) {
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
    const system = `你是教室布局设计师。你只负责根据老师自然语言生成空教室布局预览，不安排学生坐标。

硬性规则：
- 只输出 JSON，不要 markdown。
- 不要输出 assignments、unassigned 或学生坐标。
- classroomLayout.cells 只能使用 "seat"、"aisle"、"empty"。
- 缺少行列尺寸时，必须根据 studentCount 自动扩容。
- arrangementSpec.physicalRows 表示物理座位行数，physicalCols 表示物理座位列数，例如“每列6人”应理解为 physicalRows=6。
- arrangementSpec.capacityPolicy 只能是 "auto_expand" 或 "fixed"，老师没说固定容量时默认 auto_expand。
- arrangementSpec.columnPattern 用于混合列布局，例如“两边一人一组，中间两人一组”可用 [1,"aisle",2,"aisle",2,"aisle",1]。
- “两人一桌/双人桌/同桌两个”表示 groupSize=2；“边上/两边一人一组，中间两人一组”表示混合列布局。
- 没有明确固定容量时，座位容量必须覆盖 studentCount。
- 过道应连续、清楚；整体布局要整齐、可真实使用。
- 如果老师要求护法位，只在 classroomLayout.guardians.enabled 标记，不要填写具体学生。`;
    const payload = {
        stage: 'layout_preview',
        prompt: request.prompt,
        studentCount: request.students.length,
        constraints: (request.constraints || []).slice(0, 80).map(compactConstraintForPreview),
        strategy: request.strategy || {},
        previousLayoutSummary: layoutSummary(request.previousLayout),
        hints,
        outputSchema: {
            reply: '给老师的简短布局预览说明',
            physicalRows: 6,
            capacityPolicy: 'auto_expand',
            columnPattern: [1, 'aisle', 2, 'aisle', 2, 'aisle', 1],
            layoutIntent: {
                type: 'standard|grouped|exam|u_shape|island|custom_matrix',
                description: '一句话说明布局意图',
                confidence: 'high|medium|low',
            },
            classroomLayout: {
                rows: 6,
                cols: 8,
                cells: [['seat', 'seat', 'aisle', 'seat']],
                groups: [[1, 1, null, 2]],
                guardians: { enabled: false, left: null, right: null },
                template: 'ai-preview',
                groupSize: 2,
            },
            arrangementSpec: {
                groupSize: 2,
                capacityPolicy: 'auto_expand',
                aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: false },
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
    if (repairErrors.length) payload.repairErrors = repairErrors;
    return [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
    ];
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

function normalizeGuardians(raw) {
    const source = raw?.guardians || raw || {};
    return {
        left: normalizeStudentRef(source.left),
        right: normalizeStudentRef(source.right),
    };
}

function validateGuardians(guardians, students) {
    const studentById = new Map(students.map(student => [student.id, student]));
    const ids = [guardians.left, guardians.right].filter(Boolean);
    const errors = [];
    for (const id of ids) {
        if (!studentById.has(id)) errors.push(`护法位包含未知学生 id: ${id}`);
    }
    if (ids.length !== new Set(ids).size) errors.push('左右护法不能是同一个学生');
    return { ok: errors.length === 0, errors };
}

function validateBatchAssignments({
    raw,
    studentsToPlace,
    layout,
    occupiedSeatKeys,
    placedStudentIds,
}) {
    const expectedIds = new Set(studentsToPlace.map(student => student.id));
    const assignments = normalizeAssignments(raw?.assignments);
    const errors = [];
    const batchStudentIds = new Set();
    const batchSeatKeys = new Set();

    for (const assignment of assignments) {
        if (!expectedIds.has(assignment.studentId)) {
            errors.push(`批次返回了不属于本批的学生: ${assignment.studentId || '空'}`);
            continue;
        }
        if (placedStudentIds.has(assignment.studentId) || batchStudentIds.has(assignment.studentId)) {
            errors.push(`${assignment.studentId} 被重复安排`);
            continue;
        }
        if (!Number.isInteger(assignment.row) || !Number.isInteger(assignment.col)
            || assignment.row < 0 || assignment.col < 0
            || assignment.row >= layout.rows || assignment.col >= layout.cols) {
            errors.push(`${assignment.studentId} 的座位坐标越界`);
            continue;
        }
        if (layout.cells[assignment.row]?.[assignment.col] !== CELL.SEAT) {
            errors.push(`${assignment.studentId} 被安排到非座位格`);
            continue;
        }
        const key = `${assignment.row},${assignment.col}`;
        if (occupiedSeatKeys.has(key) || batchSeatKeys.has(key)) {
            errors.push(`第${assignment.row + 1}排第${assignment.col + 1}列被重复安排`);
            continue;
        }
        batchStudentIds.add(assignment.studentId);
        batchSeatKeys.add(key);
    }

    const missing = [...expectedIds].filter(id => !batchStudentIds.has(id));
    if (missing.length) errors.push(`批次缺少学生: ${missing.join('、')}`);
    return {
        ok: errors.length === 0,
        errors,
        assignments,
    };
}

export function buildArrangeMessages(request, repairErrors = []) {
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

export function parseAiJson(content) {
    const text = asText(content).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    if (!text) throw new Error('AI 返回为空');
    try {
        return JSON.parse(text);
    } catch (error) {
        error.code = 'AI_JSON_PARSE';
        throw error;
    }
}

export function isAiJsonParseError(error) {
    return error?.code === 'AI_JSON_PARSE' || error instanceof SyntaxError;
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

function chineseNumberValue(text) {
    const value = asText(text);
    const digit = Number.parseInt(value, 10);
    if (Number.isInteger(digit)) return digit;
    const map = new Map([
        ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
        ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
    ]);
    return map.get(value) || NaN;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

const NATURAL_NUMBER_PATTERN = '[1-9]\\d*|[一二两三四五六七八九十]';

function naturalNumberFromMatch(match) {
    return match ? chineseNumberValue(match[1]) : NaN;
}

function firstNaturalNumber(text, patterns = []) {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        const value = naturalNumberFromMatch(match);
        if (Number.isInteger(value) && value > 0) return value;
    }
    return NaN;
}

function extractGroupSize(text) {
    if (/双人|两两(?:并排|搭配)|二人桌|双人桌/.test(text)) return 2;
    if (/三三制|三人桌/.test(text)) return 3;
    return firstNaturalNumber(text, [
        new RegExp(`(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人一组`),
        new RegExp(`(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人一桌`),
        new RegExp(`(?:每|一)(?:桌|组)\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人`),
        new RegExp(`同(?:桌|排|行)\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人?`),
        new RegExp(`(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人\\s*(?:坐在?一起|并排|同桌)`),
        new RegExp(`(${NATURAL_NUMBER_PATTERN})\\s*三制`),
    ]);
}

function hasGroupColumnWording(text) {
    return /一组是?一列|每组一列|每列一组|一列一组|一组一列|组块列/.test(text);
}

function extractColumnCount(text, { physicalOnly = false } = {}) {
    const perRow = firstNaturalNumber(text, [
        new RegExp(`每\\s*(?:排|行)\\s*(?:坐|有|安排|放)?\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人`),
        new RegExp(`(?:一|每)(?:排|行)\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?(?:座|座位|人)`),
    ]);
    if (physicalOnly && Number.isInteger(perRow) && perRow > 0) return perRow;

    const pattern = new RegExp(`(一共|共|总共|合计|分成|分为|排成)?\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?(?:${physicalOnly ? '(?:物理列|座位列|列座位|列桌|列座|纵列)' : '列|纵列'})`, 'g');
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const count = chineseNumberValue(match[2]);
        if (!Number.isInteger(count) || count <= 0) continue;
        if (!match[1] && count === 1) continue;
        const tail = text.slice(match.index, match.index + match[0].length + 4);
        const physical = /物理列|座位列|列座位|列桌|列座|纵列/.test(tail);
        if (physicalOnly && physical) return count;
        if (!physicalOnly && !physical) return count;
    }
    return 0;
}

function extractGridDimensions(text) {
    const rowCol = text.match(new RegExp(`(${NATURAL_NUMBER_PATTERN})\\s*(?:行|排)\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:列|纵列)`));
    if (rowCol) {
        return {
            physicalRows: chineseNumberValue(rowCol[1]),
            physicalCols: chineseNumberValue(rowCol[2]),
        };
    }
    const colRow = text.match(new RegExp(`(${NATURAL_NUMBER_PATTERN})\\s*(?:列|纵列)\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:行|排)`));
    if (colRow) {
        return {
            physicalRows: chineseNumberValue(colRow[2]),
            physicalCols: chineseNumberValue(colRow[1]),
        };
    }
    return { physicalRows: 0, physicalCols: 0 };
}

function extractRowCount(text) {
    return firstNaturalNumber(text, [
        new RegExp(`每\\s*(?:列|纵列)\\s*(?:坐|有|安排|放)?\\s*(${NATURAL_NUMBER_PATTERN})\\s*(?:个)?人`),
        new RegExp(`(?:^|[^每])(${NATURAL_NUMBER_PATTERN})\\s*(?:行|排)(?:座位)?`),
    ]);
}

function inferColumnPattern(text) {
    const edgeSingle = /(?:边上|两边|最边|靠边|外侧).{0,10}(?:一|1)\s*(?:个)?人?(?:一组)?/.test(text)
        || /(?:一|1)\s*(?:个)?人?(?:一组)?.{0,10}(?:边上|两边|最边|靠边|外侧)/.test(text);
    const innerPair = /(?:中间|里面|内侧).{0,10}(?:两|二|2)\s*(?:个)?人?(?:一组)?/.test(text)
        || /(?:两|二|2)\s*(?:个)?人?(?:一组)?.{0,10}(?:中间|里面|内侧)/.test(text);
    return edgeSingle && innerPair ? [1, 'aisle', 2, 'aisle', 2, 'aisle', 1] : [];
}

function normalizeColumnPattern(rawPattern) {
    if (!Array.isArray(rawPattern)) return [];
    const normalized = [];
    for (const item of rawPattern) {
        if (typeof item === 'string' && /^(aisle|过道|通道|空|empty)$/i.test(item.trim())) {
            if (normalized.at(-1) !== 'aisle') normalized.push('aisle');
            continue;
        }
        const value = Number.parseInt(item, 10);
        if (Number.isInteger(value) && value > 0 && value <= 12) {
            normalized.push(value);
        }
    }
    while (normalized[0] === 'aisle') normalized.shift();
    while (normalized.at(-1) === 'aisle') normalized.pop();
    return normalized.some(item => Number.isInteger(item)) ? normalized : [];
}

function normalizeCapacityPolicy(value, fallback = 'auto_expand') {
    const policy = asText(value).toLowerCase();
    if (['fixed', 'limited', 'limit', '固定', '限制'].includes(policy)) return 'fixed';
    if (['auto_expand', 'auto', 'expand', '自动扩容', '自动'].includes(policy)) return 'auto_expand';
    return fallback === 'fixed' ? 'fixed' : 'auto_expand';
}

function inferCapacityPolicy(text) {
    return shouldAllowUnassigned(text) ? 'fixed' : 'auto_expand';
}

function inferArrangementSpecFromPrompt(prompt = '') {
    const text = asText(prompt);
    const gridDimensions = extractGridDimensions(text);
    const groupSize = extractGroupSize(text) || 1;
    const wantsGroup = Number.isInteger(groupSize) && groupSize > 1;
    const wantsBothAisles = /横.*竖|竖.*横|横过道.*竖过道|竖过道.*横过道/.test(text);
    const wantsVerticalAisle = wantsBothAisles
        || /竖过道|纵过道|列过道|组间过道|每组之间.*过道/.test(text)
        || /中间.*(?:通道|走道|过道|空|隔开)|(?:每组|组间|组与组之间).*(?:隔开|分开|空|留空|通道|走道)|左右.*(?:隔开|分开|通道|走道)/.test(text);
    const wantsHorizontalAisle = wantsBothAisles
        || /横过道|行过道|每组之间.*横|组与组之间.*横/.test(text)
        || /(?:前后|上下).*(?:通道|走道|过道|隔开)/.test(text);
    const groupColumnWording = hasGroupColumnWording(text);
    const physicalCols = gridDimensions.physicalCols || extractColumnCount(text, { physicalOnly: true });
    const physicalRows = gridDimensions.physicalRows || extractRowCount(text) || 0;
    const groupsPerRow = wantsGroup && !physicalCols
        ? extractColumnCount(text, { physicalOnly: false })
        : 0;
    const columnPattern = inferColumnPattern(text);
    const guardianEnabled = /护法|讲台旁|左右/.test(text);
    const lowestGradeGuardianIndex = text.search(/成绩.{0,8}(最差|最低|差|低)|最差.{0,8}成绩|最低.{0,8}成绩/);
    const topGradeGuardianIndex = text.search(/(成绩.{0,8}(比较好|较好|好|优秀|高|最高)|高分|优秀|前\s*20\s*%|前百分之二十).{0,12}(护法|讲台旁|左右|坐)|(?:护法|讲台旁|左右).{0,12}(成绩.{0,8}(比较好|较好|好|优秀|高|最高)|高分|优秀|前\s*20\s*%|前百分之二十)/);
    const guardianStrategy = topGradeGuardianIndex >= 0 && topGradeGuardianIndex > lowestGradeGuardianIndex
        ? 'top_grade_percent'
        : lowestGradeGuardianIndex >= 0
            ? 'lowest_grade'
            : 'none';
    const singleMode = /考试|单人|单座/.test(text);
    return {
        groupSize: Number.isInteger(groupSize) && groupSize > 0 ? groupSize : 1,
        groupsPerRow: Number.isInteger(groupsPerRow) && groupsPerRow > 0 ? groupsPerRow : 0,
        physicalCols: Number.isInteger(physicalCols) && physicalCols > 0 ? physicalCols : 0,
        physicalRows: Number.isInteger(physicalRows) && physicalRows > 0 ? physicalRows : 0,
        columnPattern,
        capacityPolicy: inferCapacityPolicy(text),
        aislePolicy: {
            verticalBetweenGroups: wantsVerticalAisle || Boolean(groupColumnWording || groupsPerRow),
            horizontalBetweenGroupRows: wantsHorizontalAisle,
        },
        guardianPolicy: {
            enabled: guardianEnabled,
            strategy: guardianStrategy,
        },
        layoutMode: singleMode ? 'single' : (wantsGroup ? 'grouped' : 'standard'),
        placementPolicy: {},
        keepPreviousLayout: /保持|沿用|不改变|当前布局|原布局/.test(text),
        assumptions: [
            ...(groupColumnWording && groupsPerRow ? [`已理解为每行 ${groupsPerRow} 个组块列`] : []),
            ...(physicalCols ? [`已理解为 ${physicalCols} 个物理座位列`] : []),
            ...(physicalRows ? [`已理解为 ${physicalRows} 个物理座位行`] : []),
            ...(groupColumnWording || groupsPerRow ? ['组块之间默认留竖过道'] : []),
            ...(columnPattern.length ? ['已理解为两边单人组、中间双人组的混合列布局'] : []),
        ],
    };
}

function normalizeAislePolicy(rawPolicy = {}, fallback = {}) {
    return {
        verticalBetweenGroups: boolValue(rawPolicy.verticalBetweenGroups ?? rawPolicy.vertical ?? rawPolicy.colAisles, fallback.verticalBetweenGroups),
        horizontalBetweenGroupRows: boolValue(rawPolicy.horizontalBetweenGroupRows ?? rawPolicy.horizontal ?? rawPolicy.rowAisles, fallback.horizontalBetweenGroupRows),
    };
}

function normalizeGuardianPolicy(rawPolicy = {}, fallback = {}) {
    const raw = rawPolicy || {};
    const strategy = normalizeGuardianStrategy(raw.strategy || raw.rule || fallback.strategy || 'none');
    return {
        enabled: boolValue(raw.enabled, fallback.enabled),
        strategy,
        left: normalizeStudentRef(raw.left),
        right: normalizeStudentRef(raw.right),
        slots: normalizeGuardianSlots(raw.slots || raw.guardianSlots || raw.positions),
    };
}

function normalizeGuardianStrategy(value) {
    const strategy = asText(value);
    if (/^(lowest_grade|low_grade|lowest|low|worst|poor_grade)$/.test(strategy)) return 'lowest_grade';
    if (/^(top_grade_percent|highest_grade|high_grade|highest|high|best|excellent_grade)$/.test(strategy)) return 'top_grade_percent';
    return 'none';
}

function normalizeGuardianGender(value) {
    const gender = asText(value).toLowerCase();
    if (['m', 'male', 'boy', '男', '男生'].includes(gender)) return 'M';
    if (['f', 'female', 'girl', '女', '女生'].includes(gender)) return 'F';
    return '';
}

function normalizeGuardianSlots(rawSlots) {
    if (!Array.isArray(rawSlots)) return [];
    return rawSlots
        .map(slot => {
            if (typeof slot === 'string') {
                const normalized = {
                    gender: normalizeGuardianGender(slot),
                    strategy: normalizeGuardianStrategy(slot),
                };
                if (!normalized.gender) delete normalized.gender;
                if (normalized.strategy === 'none') delete normalized.strategy;
                return normalized;
            }
            const raw = slot && typeof slot === 'object' ? slot : {};
            const normalized = {
                gender: normalizeGuardianGender(raw.gender || raw.sex),
                strategy: normalizeGuardianStrategy(raw.strategy || raw.rule || raw.gradeStrategy || raw.grade),
                studentId: normalizeStudentRef(raw.studentId || raw.student_id || raw.id || raw.student),
            };
            if (!normalized.gender) delete normalized.gender;
            if (normalized.strategy === 'none') delete normalized.strategy;
            if (!normalized.studentId) delete normalized.studentId;
            return normalized;
        })
        .filter(slot => slot.gender || slot.strategy || slot.studentId);
}

function hasExplicitGuardianRequirement(rawPolicy) {
    if (!rawPolicy || typeof rawPolicy !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(rawPolicy, 'enabled')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'strategy')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'rule')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'left')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'right')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'slots')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'guardianSlots')
        || Object.prototype.hasOwnProperty.call(rawPolicy, 'positions');
}

function normalizeGradeStrategy(value) {
    const strategy = asText(value);
    return ['priority', 'balance'].includes(strategy) ? strategy : 'none';
}

function normalizeUiPlacementPolicy(policy = {}) {
    return {
        genderBalance: boolValue(policy.genderBalance, false),
        heightOrder: boolValue(policy.heightOrder, false),
        gradeStrategy: normalizeGradeStrategy(policy.gradeStrategy),
    };
}

function definedPlacementPolicy(policy = {}) {
    const result = {};
    if (Object.prototype.hasOwnProperty.call(policy, 'genderBalance')) {
        result.genderBalance = boolValue(policy.genderBalance, false);
    }
    if (Object.prototype.hasOwnProperty.call(policy, 'heightOrder')) {
        result.heightOrder = boolValue(policy.heightOrder, false);
    }
    if (Object.prototype.hasOwnProperty.call(policy, 'gradeStrategy')) {
        result.gradeStrategy = normalizeGradeStrategy(policy.gradeStrategy);
    }
    return result;
}

function inferPlacementOverridesFromPrompt(prompt = '') {
    const text = asText(prompt);
    const overrides = {};
    const noHeight = /(不要|不用|不按|取消|关闭).{0,8}身高|身高.{0,8}(不要|不用|不排|不排序|不考虑)/.test(text);
    const yesHeight = /(按|根据).{0,4}身高|身高(排序|照顾|优先)/.test(text);
    if (noHeight) overrides.heightOrder = false;
    else if (yesHeight) overrides.heightOrder = true;

    const noGender = /(不要|不用|取消|关闭).{0,8}(男女|性别)|男女.{0,8}(不要|不用|不搭配|不考虑)/.test(text);
    const yesGender = /男女搭配|男女均衡|性别均衡/.test(text);
    if (noGender) overrides.genderBalance = false;
    else if (yesGender) overrides.genderBalance = true;

    if (/(不要|不用|不按|取消).{0,8}成绩|成绩.{0,8}(不要|不用|不考虑)/.test(text)) {
        overrides.gradeStrategy = 'none';
    } else if (/强弱互补|高低分|成绩.{0,6}(均衡|互补)/.test(text)) {
        overrides.gradeStrategy = 'balance';
    } else if (/成绩优先|优秀优先|高分.{0,4}优先|成绩好.{0,4}优先/.test(text)) {
        overrides.gradeStrategy = 'priority';
    }
    return overrides;
}

function hasAnyOwn(raw = {}, keys = []) {
    return keys.some(key => Object.prototype.hasOwnProperty.call(raw, key));
}

function valueConflict(aiValue, localValue) {
    if (aiValue === undefined || aiValue === null || aiValue === '' || aiValue === 0) return false;
    if (localValue === undefined || localValue === null || localValue === '' || localValue === 0) return false;
    return JSON.stringify(aiValue) !== JSON.stringify(localValue);
}

function specConflictWarnings(raw = {}, inferred = {}, normalized = {}) {
    const conflicts = [];
    const add = (field, aiValue, localValue) => {
        if (valueConflict(aiValue, localValue)) conflicts.push(`${field}: AI=${JSON.stringify(aiValue)} 本地=${JSON.stringify(localValue)}`);
    };
    if (hasAnyOwn(raw, ['groupSize', 'group_size'])) add('groupSize', normalized.groupSize, inferred.groupSize);
    if (hasAnyOwn(raw, ['groupsPerRow', 'groups_per_row'])) add('groupsPerRow', normalized.groupsPerRow, inferred.groupsPerRow);
    if (hasAnyOwn(raw, ['physicalCols', 'physical_cols', 'cols'])) add('physicalCols', normalized.physicalCols, inferred.physicalCols);
    if (hasAnyOwn(raw, ['physicalRows', 'physical_rows', 'rows'])) add('physicalRows', normalized.physicalRows, inferred.physicalRows);
    if (hasAnyOwn(raw, ['capacityPolicy', 'capacity_policy'])) add('capacityPolicy', normalized.capacityPolicy, inferred.capacityPolicy);
    if (hasAnyOwn(raw, ['columnPattern', 'column_pattern'])) add('columnPattern', normalized.columnPattern, inferred.columnPattern);
    const rawAisles = raw.aislePolicy || raw.aisles || {};
    if (rawAisles && typeof rawAisles === 'object') {
        if (hasAnyOwn(rawAisles, ['verticalBetweenGroups', 'vertical', 'colAisles'])) {
            add('aislePolicy.verticalBetweenGroups', normalized.aislePolicy?.verticalBetweenGroups, inferred.aislePolicy?.verticalBetweenGroups);
        }
        if (hasAnyOwn(rawAisles, ['horizontalBetweenGroupRows', 'horizontal', 'rowAisles'])) {
            add('aislePolicy.horizontalBetweenGroupRows', normalized.aislePolicy?.horizontalBetweenGroupRows, inferred.aislePolicy?.horizontalBetweenGroupRows);
        }
    }
    return conflicts.length ? [`AI 解析与本地规则解析不一致，已优先采用 AI：${conflicts.join('；')}`] : [];
}

function normalizeArrangementSpec(raw = {}, request = {}) {
    const inferred = inferArrangementSpecFromPrompt(request.prompt);
    const placementPolicy = raw.placementPolicy && typeof raw.placementPolicy === 'object' ? raw.placementPolicy : {};
    const rawGroupSize = positiveInt(raw.groupSize ?? raw.group_size, 0, 0, 12);
    const groupSize = rawGroupSize > 0 ? rawGroupSize : inferred.groupSize;
    const layoutMode = asText(raw.layoutMode || raw.layout_mode) || inferred.layoutMode || 'standard';
    const rawGroupsPerRow = positiveInt(raw.groupsPerRow ?? raw.groups_per_row, 0, 0, 1000000);
    const rawPhysicalCols = positiveInt(raw.physicalCols ?? raw.physical_cols ?? raw.cols, 0, 0, 1000000);
    const rawPhysicalRows = positiveInt(raw.physicalRows ?? raw.physical_rows ?? raw.rows, 0, 0, 1000000);
    const groupsPerRow = rawGroupsPerRow > 0 ? rawGroupsPerRow : inferred.groupsPerRow;
    const physicalCols = rawPhysicalCols > 0 ? rawPhysicalCols : inferred.physicalCols;
    const physicalRows = rawPhysicalRows > 0 ? rawPhysicalRows : inferred.physicalRows;
    const rawColumnPattern = normalizeColumnPattern(raw.columnPattern ?? raw.column_pattern);
    const columnPattern = rawColumnPattern.length ? rawColumnPattern : normalizeColumnPattern(inferred.columnPattern);
    if (!rawColumnPattern.length && /edge-single-inner-pair/.test(asText(raw.customPattern || raw.custom_pattern))) {
        columnPattern.splice(0, columnPattern.length, 1, 'aisle', 2, 'aisle', 2, 'aisle', 1);
    }
    const capacityPolicy = normalizeCapacityPolicy(raw.capacityPolicy ?? raw.capacity_policy, inferred.capacityPolicy);
    const aislePolicy = normalizeAislePolicy(raw.aislePolicy || raw.aisles || {}, inferred.aislePolicy);
    const promptPlacementOverrides = inferPlacementOverridesFromPrompt(request.prompt);
    const rawGuardianPolicy = raw.guardianPolicy || raw.guardians || null;
    const guardianPolicy = normalizeGuardianPolicy(rawGuardianPolicy || {}, inferred.guardianPolicy);
    if (!hasExplicitGuardianRequirement(rawGuardianPolicy) && inferred.guardianPolicy.strategy !== 'none') {
        guardianPolicy.enabled = true;
        guardianPolicy.strategy = inferred.guardianPolicy.strategy;
    }
    const normalized = {
        groupSize,
        groupsPerRow: physicalCols > 0 ? 0 : groupsPerRow,
        physicalCols,
        physicalRows,
        capacityPolicy,
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
        keepPreviousLayout: boolValue(raw.keepPreviousLayout ?? raw.keep_previous_layout, inferred.keepPreviousLayout),
        assumptions: inferred.assumptions || [],
        notes: asText(raw.notes || raw.reasoning),
    };
    normalized.parseWarnings = specConflictWarnings(raw, inferred, normalized);
    return normalized;
}

function buildSpecMessages(request) {
    const hints = inferArrangementSpecFromPrompt(request.prompt);
    const system = `你是座位需求解析器。只把老师的自然语言需求解析成规则 JSON，不要安排任何学生坐标。
规则:
- 只输出 JSON，不要 markdown。
- 不要返回 assignments、classroomLayout、学生坐标或完整名单。
- 如果老师没有限制容量，布局应允许本地算法自动扩容。
- groupSize 表示几个人一组；aislePolicy 表示组间是否留横/竖过道。
- groupsPerRow 表示每行有几个组块；physicalCols 表示物理座位列数；physicalRows 表示物理座位行数，三者不要混用。
- capacityPolicy 只能是 "auto_expand" 或 "fixed"；老师没说固定容量时默认 auto_expand，明确说固定/只有/最多/不超过/座位有限时用 fixed。
- columnPattern 用于非均匀混合列布局：正整数表示连续座位组，"aisle" 表示一列过道，例如 [1,"aisle",2,"aisle",2,"aisle",1]。
- 如果老师说“一组是一列/每组一列/每列一组”，再说“一共 N 列”，应输出 groupsPerRow=N，并默认 verticalBetweenGroups=true。
- 如果老师说“N列座位/物理列”，应输出 physicalCols=N，不要输出 groupsPerRow=N。
- 如果老师说“每排/每行 N 人”，应输出 physicalCols=N；如果说“每列 N 人”，应输出 physicalRows=N；如果说“N行M列”，应同时输出 physicalRows=N、physicalCols=M。
- “两人一桌/双人桌/同桌两个/两两并排”都表示 groupSize=2；“三三制/三人一桌”表示 groupSize=3。
- “中间留通道/组间空一列/左右隔开”通常表示 aislePolicy.verticalBetweenGroups=true。
- “边上/两边/最边一人一组，中间/里面两人一组”应输出 columnPattern=[1,"aisle",2,"aisle",2,"aisle",1]，notes 写“两边1人组，中间2人组，组间过道”。
- guardianPolicy 用于左右护法规则，例如 lowest_grade 表示成绩最低的同学，top_grade_percent 表示成绩前20%的同学。
- 如果老师要求左右护法有组合条件，请输出 guardianPolicy.slots，必须是两个对象，例如 [{"gender":"M","strategy":"lowest_grade"},{"gender":"F","strategy":"top_grade_percent"}]。
- 护法位必须按老师最新自然语言需求输出；遇到“后来/改成/后面说”时以后面的要求为准。
示例:
输入: "两人一桌，中间留通道" -> {"groupSize":2,"aislePolicy":{"verticalBetweenGroups":true},"layoutMode":"grouped"}
输入: "同桌两个，分成4列组" -> {"groupSize":2,"groupsPerRow":4,"aislePolicy":{"verticalBetweenGroups":true},"layoutMode":"grouped"}
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
            groupSize: 3,
            groupsPerRow: 5,
            physicalCols: 0,
            physicalRows: 6,
            capacityPolicy: 'auto_expand',
            columnPattern: [1, 'aisle', 2, 'aisle', 2, 'aisle', 1],
            aislePolicy: { verticalBetweenGroups: true, horizontalBetweenGroupRows: true },
            guardianPolicy: { enabled: true, strategy: 'lowest_grade', slots: [] },
            layoutMode: 'grouped',
            placementPolicy: { genderBalance: true, gradeStrategy: 'none', heightOrder: false },
            keepPreviousLayout: false,
            notes: 'short explanation',
        },
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
        };
    }
    try {
        const spec = normalizeArrangementSpec(parseAiJson(payload.choices?.[0]?.message?.content), request);
        return {
            spec,
            warnings: spec.parseWarnings || [],
        };
    } catch (error) {
        const spec = normalizeArrangementSpec({}, request);
        return {
            spec,
            warnings: [`AI 规则 JSON 无效，已使用本地规则解析：${error.message}`],
        };
    }
}

function desiredGroupsPerRow(groupCount, spec) {
    if (spec.groupsPerRow > 0) return spec.groupsPerRow;
    if (groupCount <= 0) return 1;
    if (groupCount < 4) return groupCount;
    return Math.min(6, Math.max(4, Math.ceil(Math.sqrt(groupCount))));
}

function resolveSeatRows({ target, seatsPerRow, requestedRows = 0, capacityPolicy = 'auto_expand' }) {
    const requiredRows = Math.max(1, Math.ceil(Math.max(1, target) / Math.max(1, seatsPerRow)));
    const safeRequested = positiveInt(requestedRows, 0, 0, 1000000);
    if (safeRequested > 0) {
        return capacityPolicy === 'fixed' ? safeRequested : Math.max(safeRequested, requiredRows);
    }
    return requiredRows;
}

function columnPatternSeatCount(pattern = []) {
    return pattern.reduce((total, item) => total + (Number.isInteger(item) ? item : 0), 0);
}

function buildSeatRowFromRuns(runs, { groupSize = 1, startGroupId = 1, verticalAisleAfterRun = -1 } = {}) {
    const cells = [];
    const groups = [];
    let groupId = startGroupId;
    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
        const runLength = Math.max(0, Number.parseInt(runs[runIndex], 10) || 0);
        for (let offset = 0; offset < runLength; offset++) {
            if (offset % Math.max(1, groupSize) === 0) groupId++;
            cells.push(CELL.SEAT);
            groups.push(groupId - 1);
        }
        if (runIndex === verticalAisleAfterRun) {
            cells.push(CELL.AISLE);
            groups.push(null);
        }
    }
    return { cells, groups, nextGroupId: groupId };
}

function buildPhysicalGridLayout({ target, seatRows, seatCols, groupSize, verticalAisles, horizontalAisles, spec }) {
    const leftCols = verticalAisles && seatCols >= 2 ? Math.ceil(seatCols / 2) : seatCols;
    const rightCols = verticalAisles && seatCols >= 2 ? seatCols - leftCols : 0;
    const runs = rightCols > 0 ? [leftCols, rightCols] : [seatCols];
    const cells = [];
    const groups = [];
    let groupId = 1;
    for (let row = 0; row < seatRows; row++) {
        const seatRow = buildSeatRowFromRuns(runs, {
            groupSize,
            startGroupId: groupId,
            verticalAisleAfterRun: rightCols > 0 ? 0 : -1,
        });
        cells.push(seatRow.cells);
        groups.push(seatRow.groups);
        groupId = seatRow.nextGroupId;
        if (horizontalAisles && row < seatRows - 1) {
            cells.push(Array(seatRow.cells.length).fill(CELL.AISLE));
            groups.push(Array(seatRow.cells.length).fill(null));
        }
    }
    return {
        rows: cells.length,
        cols: cells[0]?.length || 0,
        cells,
        groups,
        guardians: { enabled: Boolean(spec.guardianPolicy.enabled), left: null, right: null },
        template: 'ai-local',
        groupSize,
        localAisles: { vertical: [], horizontal: [] },
    };
}

function buildColumnPatternLayout({ regularSeatTarget, spec }) {
    const pattern = normalizeColumnPattern(spec.columnPattern);
    if (!pattern.length) return null;
    const seatsPerRow = columnPatternSeatCount(pattern);
    if (seatsPerRow <= 0) return null;
    const seatRows = resolveSeatRows({
        target: regularSeatTarget,
        seatsPerRow,
        requestedRows: spec.physicalRows,
        capacityPolicy: spec.capacityPolicy,
    });
    const horizontalAisles = Boolean(spec.aislePolicy?.horizontalBetweenGroupRows);
    const cells = [];
    const groups = [];
    let groupId = 1;
    for (let row = 0; row < seatRows; row++) {
        const seatRow = [];
        const groupRow = [];
        for (const item of pattern) {
            if (item === 'aisle') {
                seatRow.push(CELL.AISLE);
                groupRow.push(null);
                continue;
            }
            const currentGroup = groupId++;
            for (let offset = 0; offset < item; offset++) {
                seatRow.push(CELL.SEAT);
                groupRow.push(currentGroup);
            }
        }
        cells.push(seatRow);
        groups.push(groupRow);
        if (horizontalAisles && row < seatRows - 1) {
            cells.push(Array(seatRow.length).fill(CELL.AISLE));
            groups.push(Array(seatRow.length).fill(null));
        }
    }
    return {
        rows: cells.length,
        cols: cells[0]?.length || 0,
        cells,
        groups,
        guardians: { enabled: Boolean(spec.guardianPolicy.enabled), left: null, right: null },
        template: 'ai-local-mixed',
        groupSize: Math.max(1, spec.groupSize || 1),
        localAisles: { vertical: [], horizontal: [] },
    };
}

function buildExpandableClassroomLayout({ regularSeatTarget, spec, previousLayout }) {
    if (spec.keepPreviousLayout && previousLayout) {
        return normalizeLayout({ classroomLayout: previousLayout });
    }

    const target = Math.max(regularSeatTarget, 1);
    const groupSize = Math.max(1, spec.layoutMode === 'single' ? 1 : spec.groupSize);
    const grouped = groupSize > 1 || spec.layoutMode === 'grouped';
    const verticalAisles = Boolean(spec.aislePolicy.verticalBetweenGroups && grouped);
    const horizontalAisles = Boolean(spec.aislePolicy.horizontalBetweenGroupRows && grouped);
    const requestedPhysicalCols = positiveInt(spec.physicalCols, 0, 0, 1000000);
    const requestedPhysicalRows = positiveInt(spec.physicalRows, 0, 0, 1000000);
    const capacityPolicy = normalizeCapacityPolicy(spec.capacityPolicy);

    const mixedLayout = buildColumnPatternLayout({ regularSeatTarget: target, spec });
    if (mixedLayout) return mixedLayout;

    if (!grouped) {
        const cols = requestedPhysicalCols > 0
            ? requestedPhysicalCols
            : Math.min(12, Math.max(4, Math.ceil(Math.sqrt(target))));
        const rows = resolveSeatRows({ target, seatsPerRow: cols, requestedRows: requestedPhysicalRows, capacityPolicy });
        return buildPhysicalGridLayout({
            target,
            seatRows: rows,
            seatCols: cols,
            groupSize: 1,
            verticalAisles: false,
            horizontalAisles: false,
            spec,
        });
    }

    if (requestedPhysicalCols > 0 && !spec.groupsPerRow) {
        const cols = requestedPhysicalCols;
        const rows = resolveSeatRows({ target, seatsPerRow: cols, requestedRows: requestedPhysicalRows, capacityPolicy });
        return buildPhysicalGridLayout({
            target,
            seatRows: rows,
            seatCols: cols,
            groupSize,
            verticalAisles,
            horizontalAisles,
            spec,
        });
    }

    const groupCount = Math.ceil(target / groupSize);
    const groupsPerRow = desiredGroupsPerRow(groupCount, spec);
    const logicalRows = resolveSeatRows({
        target,
        seatsPerRow: groupsPerRow * groupSize,
        requestedRows: requestedPhysicalRows,
        capacityPolicy,
    });
    const cols = groupsPerRow * groupSize + (verticalAisles ? groupsPerRow - 1 : 0);
    const rows = logicalRows + (horizontalAisles ? logicalRows - 1 : 0);
    const cells = [];
    const groups = [];

    for (let logicalRow = 0; logicalRow < logicalRows; logicalRow++) {
        const seatRow = [];
        const groupRow = [];
        for (let groupCol = 0; groupCol < groupsPerRow; groupCol++) {
            const groupId = logicalRow * groupsPerRow + groupCol + 1;
            for (let offset = 0; offset < groupSize; offset++) {
                seatRow.push(CELL.SEAT);
                groupRow.push(groupId);
            }
            if (verticalAisles && groupCol < groupsPerRow - 1) {
                seatRow.push(CELL.AISLE);
                groupRow.push(null);
            }
        }
        cells.push(seatRow);
        groups.push(groupRow);
        if (horizontalAisles && logicalRow < logicalRows - 1) {
            cells.push(Array(cols).fill(CELL.AISLE));
            groups.push(Array(cols).fill(null));
        }
    }

    return {
        rows,
        cols,
        cells,
        groups,
        guardians: { enabled: Boolean(spec.guardianPolicy.enabled), left: null, right: null },
        template: 'ai-local',
        groupSize,
    };
}

function studentGradeValue(student, missing = Number.POSITIVE_INFINITY) {
    const value = Number(student?.grade);
    return Number.isFinite(value) ? value : missing;
}

function rankedStudentsByGradeDesc(students) {
    return [...students]
        .filter(student => Number.isFinite(Number(student?.grade)))
        .sort((a, b) => {
            const gradeDiff = studentGradeValue(b, Number.NEGATIVE_INFINITY) - studentGradeValue(a, Number.NEGATIVE_INFINITY);
            if (gradeDiff !== 0) return gradeDiff;
            return a.id.localeCompare(b.id);
        });
}

function getTopGradeStudentIds(students, minimumCount = 1) {
    const ranked = rankedStudentsByGradeDesc(students);
    if (!ranked.length) return new Set();
    const count = Math.max(minimumCount, Math.ceil(ranked.length * TOP_GRADE_PERCENT));
    return new Set(ranked.slice(0, count).map(student => student.id));
}

function getLowGradeStudentIds(students, minimumCount = 1) {
    const ranked = rankedStudentsByGradeDesc(students);
    if (!ranked.length) return new Set();
    const count = Math.max(minimumCount, Math.ceil(ranked.length * TOP_GRADE_PERCENT));
    return new Set(ranked.slice(Math.max(0, ranked.length - count)).map(student => student.id));
}

function protectExcellentStudentsFromLastRow({ assignments, studentsById, seats, gradeStrategy, scoreMap = new Map() }) {
    if (gradeStrategy !== 'priority' || !assignments.length || !seats.length) {
        return { moved: 0, remaining: 0 };
    }
    const lastRow = Math.max(...seats.map(seat => seat.r));
    if (!Number.isFinite(lastRow)) return { moved: 0, remaining: 0 };
    const topGradeIds = getTopGradeStudentIds([...studentsById.values()]);

    const isLastRowExcellent = assignment =>
        assignment.row === lastRow && topGradeIds.has(assignment.studentId);
    const occupiedSeatKeys = () => new Set(assignments.map(assignment => `${assignment.row},${assignment.col}`));
    const emptySeatBeforeLastRow = () => {
        const occupied = occupiedSeatKeys();
        return sortSeatsByQuality(
            seats.filter(seat => seat.r !== lastRow && !occupied.has(`${seat.r},${seat.c}`)),
            scoreMap
        )[0];
    };
    const lowestNonExcellentBeforeLastRow = () => assignments
        .filter(assignment => assignment.row !== lastRow && !topGradeIds.has(assignment.studentId))
        .sort((a, b) => {
            const seatDiff = seatQuality(scoreMap, { r: b.row, c: b.col }) - seatQuality(scoreMap, { r: a.row, c: a.col });
            if (seatDiff !== 0) return seatDiff;
            const gradeDiff = studentGradeValue(studentsById.get(a.studentId)) - studentGradeValue(studentsById.get(b.studentId));
            if (gradeDiff !== 0) return gradeDiff;
            if (a.row !== b.row) return b.row - a.row;
            return b.col - a.col;
        })[0];

    let moved = 0;
    const excellentLastRowAssignments = assignments
        .filter(isLastRowExcellent)
        .sort((a, b) => studentGradeValue(studentsById.get(b.studentId), Number.NEGATIVE_INFINITY)
            - studentGradeValue(studentsById.get(a.studentId), Number.NEGATIVE_INFINITY));
    for (const excellentAssignment of excellentLastRowAssignments) {
        if (!isLastRowExcellent(excellentAssignment)) continue;
        const emptySeat = emptySeatBeforeLastRow();
        if (emptySeat) {
            excellentAssignment.row = emptySeat.r;
            excellentAssignment.col = emptySeat.c;
            moved++;
            continue;
        }

        const swapCandidate = lowestNonExcellentBeforeLastRow();
        if (!swapCandidate) continue;
        const original = { row: excellentAssignment.row, col: excellentAssignment.col };
        excellentAssignment.row = swapCandidate.row;
        excellentAssignment.col = swapCandidate.col;
        swapCandidate.row = original.row;
        swapCandidate.col = original.col;
        moved++;
    }

    return {
        moved,
        remaining: assignments.filter(isLastRowExcellent).length,
    };
}

function chooseGuardians(students, spec) {
    const policy = spec.guardianPolicy || {};
    if (!policy.enabled || students.length === 0) return { left: null, right: null };
    const byId = new Map(students.map(student => [student.id, student]));
    const chosen = [];
    for (const explicit of [policy.left, policy.right]) {
        if (explicit && byId.has(explicit) && !chosen.includes(explicit)) chosen.push(explicit);
    }

    function rankedForSlot(slot = {}) {
        let candidates = students.filter(student => !chosen.includes(student.id));
        if (slot.gender) candidates = candidates.filter(student => student.gender === slot.gender);
        const strategy = normalizeGuardianStrategy(slot.strategy || policy.strategy);
        if (strategy === 'lowest_grade') {
            return candidates.sort((a, b) => {
                const gradeDiff = studentGradeValue(a) - studentGradeValue(b);
                if (gradeDiff !== 0) return gradeDiff;
                return a.id.localeCompare(b.id);
            });
        }
        if (strategy === 'top_grade_percent') {
            return [
                ...rankedStudentsByGradeDesc(candidates),
                ...candidates
                    .filter(student => !Number.isFinite(Number(student?.grade)))
                    .sort((a, b) => a.id.localeCompare(b.id)),
            ];
        }
        return candidates.sort((a, b) => a.id.localeCompare(b.id));
    }

    for (const slot of policy.slots || []) {
        if (chosen.length >= 2) break;
        if (slot.studentId && byId.has(slot.studentId) && !chosen.includes(slot.studentId)) {
            chosen.push(slot.studentId);
            continue;
        }
        const candidate = rankedForSlot(slot)[0];
        if (candidate) chosen.push(candidate.id);
    }

    let ranked = [];
    if (policy.strategy === 'lowest_grade') {
        ranked = [...students].sort((a, b) => {
            const gradeDiff = studentGradeValue(a) - studentGradeValue(b);
            if (gradeDiff !== 0) return gradeDiff;
            return a.id.localeCompare(b.id);
        });
    } else if (policy.strategy === 'top_grade_percent') {
        const byGrade = rankedStudentsByGradeDesc(students);
        const topCount = Math.max(2, Math.ceil(byGrade.length * TOP_GRADE_PERCENT));
        const topCandidates = byGrade.slice(0, topCount);
        ranked = [
            ...topCandidates,
            ...byGrade.slice(topCount),
            ...students
                .filter(student => !Number.isFinite(Number(student?.grade)))
                .sort((a, b) => a.id.localeCompare(b.id)),
        ];
    }
    for (const student of ranked) {
        if (chosen.length >= 2) break;
        if (!chosen.includes(student.id)) chosen.push(student.id);
    }
    return {
        left: chosen[0] || null,
        right: chosen[1] || null,
    };
}

function layoutSeatList(layout) {
    const seats = [];
    for (let r = 0; r < layout.rows; r++) {
        for (let c = 0; c < layout.cols; c++) {
            if (layout.cells[r]?.[c] !== CELL.SEAT) continue;
            seats.push({ r, c, group: layout.groups?.[r]?.[c] ?? null });
        }
    }
    return seats;
}

function calculateSeatScoreMap(layout) {
    const usableRows = [];
    for (let r = 0; r < layout.rows; r++) {
        const hasSeat = Array.from({ length: layout.cols }, (_, c) => c)
            .some(c => layout.cells[r]?.[c] === CELL.SEAT);
        if (hasSeat) usableRows.push(r);
    }

    const colBlocks = [];
    let currentBlock = [];
    for (let c = 0; c < layout.cols; c++) {
        const columnHasSeat = Array.from({ length: layout.rows }, (_, r) => r)
            .some(r => layout.cells[r]?.[c] === CELL.SEAT);
        if (!columnHasSeat) {
            if (currentBlock.length) colBlocks.push(currentBlock);
            currentBlock = [];
        } else {
            currentBlock.push(c);
        }
    }
    if (currentBlock.length) colBlocks.push(currentBlock);

    const totalUsableRows = usableRows.length;
    const peakRowPos = Math.max(0, totalUsableRows * 0.33);
    const rowSigma = totalUsableRows * 0.45 || 1;
    const rowScoreMap = new Map();
    usableRows.forEach((r, idx) => {
        const dist = idx - peakRowPos;
        rowScoreMap.set(r, Math.exp(-(dist * dist) / (2 * rowSigma * rowSigma)));
    });

    const usableColumns = [];
    for (let c = 0; c < layout.cols; c++) {
        const columnHasSeat = Array.from({ length: layout.rows }, (_, r) => r)
            .some(r => layout.cells[r]?.[c] === CELL.SEAT);
        if (columnHasSeat) usableColumns.push(c);
    }
    const usableColumnIndex = new Map(usableColumns.map((c, index) => [c, index]));
    const globalColumnCenter = Math.max(0, (usableColumns.length - 1) / 2);
    const globalColumnSigma = usableColumns.length * 0.35 || 1;
    const colScoreMap = new Map();
    const aisleColumns = new Set();
    for (let c = 0; c < layout.cols; c++) {
        const columnHasSeat = Array.from({ length: layout.rows }, (_, r) => r)
            .some(r => layout.cells[r]?.[c] === CELL.SEAT);
        if (!columnHasSeat) aisleColumns.add(c);
    }
    for (const block of colBlocks) {
        const blockCenter = (block.length - 1) / 2;
        const colSigma = block.length * 0.45 || 1;
        block.forEach((c, idx) => {
            const globalDist = (usableColumnIndex.get(c) ?? 0) - globalColumnCenter;
            const globalScore = Math.exp(-(globalDist * globalDist) / (2 * globalColumnSigma * globalColumnSigma));
            const blockDist = idx - blockCenter;
            const blockScore = Math.exp(-(blockDist * blockDist) / (2 * colSigma * colSigma));
            let score = globalScore * (0.75 + 0.25 * blockScore);
            if (aisleColumns.has(c - 1) || aisleColumns.has(c + 1)) score *= 0.95;
            colScoreMap.set(c, score);
        });
    }

    const aisleRows = new Set();
    for (let r = 0; r < layout.rows; r++) {
        const rowHasSeat = Array.from({ length: layout.cols }, (_, c) => c)
            .some(c => layout.cells[r]?.[c] === CELL.SEAT);
        if (!rowHasSeat) aisleRows.add(r);
    }
    const rowAisleAdjacentSet = new Set();
    for (const r of aisleRows) {
        if (r - 1 >= 0) rowAisleAdjacentSet.add(r - 1);
        if (r + 1 < layout.rows) rowAisleAdjacentSet.add(r + 1);
    }

    const scores = new Map();
    for (const seat of layoutSeatList(layout)) {
        const rs = rowScoreMap.get(seat.r) || 0;
        const cs = colScoreMap.get(seat.c) || 0;
        let raw = rs * cs;
        if (rowAisleAdjacentSet.has(seat.r)) raw *= 0.93;
        scores.set(`${seat.r},${seat.c}`, Math.round(raw * 100));
    }
    return scores;
}

function seatQuality(scoreMap, seat) {
    return scoreMap.get(`${seat.r},${seat.c}`) ?? 0;
}

function sortSeatsByQuality(seats, scoreMap) {
    return [...seats].sort((a, b) => {
        const scoreDiff = seatQuality(scoreMap, b) - seatQuality(scoreMap, a);
        if (scoreDiff !== 0) return scoreDiff;
        if (a.r !== b.r) return a.r - b.r;
        return a.c - b.c;
    });
}

function normalizeStudentRefKey(value) {
    return asText(value)
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .toLowerCase();
}

function buildNormalizedStudentMap(students = []) {
    const byNormalized = new Map();
    for (const student of students) {
        for (const value of [student?.id, student?.name]) {
            const key = normalizeStudentRefKey(value);
            if (key && !byNormalized.has(key)) byNormalized.set(key, student);
        }
    }
    return byNormalized;
}

function resolveConstraintStudentId(value, studentsById, studentsByName, studentsByNormalized) {
    const ref = asText(value);
    if (!ref) return null;
    if (studentsById.has(ref)) return ref;
    return studentsByName.get(ref)?.id || studentsByNormalized.get(normalizeStudentRefKey(ref))?.id || null;
}

function interleaveGender(students) {
    const males = students.filter(student => student.gender === 'M');
    const females = students.filter(student => student.gender === 'F');
    const others = students.filter(student => student.gender !== 'M' && student.gender !== 'F');
    const result = [];
    let mi = 0;
    let fi = 0;
    let oi = 0;
    for (let i = 0; i < students.length; i++) {
        if (i % 2 === 0) {
            if (mi < males.length) result.push(males[mi++]);
            else if (fi < females.length) result.push(females[fi++]);
            else if (oi < others.length) result.push(others[oi++]);
        } else {
            if (fi < females.length) result.push(females[fi++]);
            else if (mi < males.length) result.push(males[mi++]);
            else if (oi < others.length) result.push(others[oi++]);
        }
    }
    return result;
}

function applyGradeStrategy(students, gradeStrategy) {
    const sorted = [...students];
    if (gradeStrategy === 'balance') {
        sorted.sort((a, b) => studentGradeValue(b, Number.NEGATIVE_INFINITY) - studentGradeValue(a, Number.NEGATIVE_INFINITY));
        const balanced = [];
        let lo = 0;
        let hi = sorted.length - 1;
        while (lo <= hi) {
            balanced.push(sorted[lo++]);
            if (lo <= hi) balanced.push(sorted[hi--]);
        }
        return balanced;
    }
    return sorted;
}

function sortStudentsForPlacement(students, spec, seats = []) {
    const policy = spec.placementPolicy || {};
    const orderWithinSeatRegion = regionStudents => {
        let ordered = applyGradeStrategy(regionStudents, policy.gradeStrategy);
        if (policy.genderBalance) ordered = interleaveGender(ordered);
        return ordered;
    };

    if (policy.heightOrder) {
        const byHeight = [...students].sort((a, b) => {
            const diff = (Number(a.height) || 0) - (Number(b.height) || 0);
            return diff || a.id.localeCompare(b.id);
        });
        const rowSeatCounts = [];
        for (const seat of seats) {
            const last = rowSeatCounts[rowSeatCounts.length - 1];
            if (!last || last.row !== seat.r) rowSeatCounts.push({ row: seat.r, count: 1 });
            else last.count++;
        }
        if (!rowSeatCounts.length) return orderWithinSeatRegion(byHeight);
        const ordered = [];
        let cursor = 0;
        for (const row of rowSeatCounts) {
            const chunk = byHeight.slice(cursor, cursor + row.count);
            cursor += row.count;
            ordered.push(...orderWithinSeatRegion(chunk));
        }
        if (cursor < byHeight.length) ordered.push(...orderWithinSeatRegion(byHeight.slice(cursor)));
        return ordered;
    }
    return orderWithinSeatRegion(students);
}

function placeTopGradeStudentsInBestSeats({ students, seats, topGradeIds, scoreMap, place }) {
    const chosen = new Set();
    const excellentStudents = rankedStudentsByGradeDesc(students)
        .filter(student => topGradeIds.has(student.id));
    const bestSeats = sortSeatsByQuality(seats, scoreMap);
    let seatIndex = 0;
    for (const student of excellentStudents) {
        while (seatIndex < bestSeats.length) {
            const seat = bestSeats[seatIndex++];
            if (place(student.id, seat)) {
                chosen.add(student.id);
                break;
            }
        }
    }
    return chosen;
}

function areAdjacent(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) <= 1;
}

function areAdjacentSeats(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
}

function areNearAssignments(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) <= 2;
}

function assignLocalSeats({ request, layout, spec, guardians }) {
    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const regularStudents = request.students.filter(student => !guardianIds.has(student.id));
    const studentsById = new Map(request.students.map(student => [student.id, student]));
    const studentsByName = new Map(request.students.map(student => [student.name, student]));
    const studentsByNormalized = buildNormalizedStudentMap(request.students);
    const allSeats = layoutSeatList(layout);
    const seatScoreMap = calculateSeatScoreMap(layout);
    const seatRows = [...new Set(allSeats.map(seat => seat.r))].sort((a, b) => a - b);
    const seatCols = [...new Set(allSeats.map(seat => seat.c))].sort((a, b) => a - b);
    const rowBandSize = Math.max(1, Math.ceil(seatRows.length / 3));
    const firstRow = seatRows[0];
    const lastRow = seatRows[seatRows.length - 1];
    const frontRows = new Set(seatRows.slice(0, rowBandSize));
    const backRows = new Set(seatRows.slice(Math.max(0, seatRows.length - rowBandSize)));
    const frontMidRows = new Set(seatRows.slice(0, Math.max(1, Math.ceil(seatRows.length * 2 / 3))));
    const middleColSize = Math.max(1, Math.ceil(seatCols.length / 3));
    const middleColStart = Math.max(0, Math.floor((seatCols.length - middleColSize) / 2));
    const middleCols = new Set(seatCols.slice(middleColStart, middleColStart + middleColSize));
    const edgeCols = new Set([seatCols[0], seatCols[seatCols.length - 1]].filter(Number.isInteger));
    const hardSeatRules = new Map();
    const occupied = new Set();
    const placed = new Set();
    const assignments = [];
    const warnings = [];
    const unsatisfied = [];

    function seatKey(seat) {
        return `${seat.r},${seat.c}`;
    }

    function isFree(seat) {
        return seat && !occupied.has(seatKey(seat));
    }

    function rulesFor(studentId) {
        if (!hardSeatRules.has(studentId)) {
            hardSeatRules.set(studentId, {
                avoidFirstRow: false,
                avoidLastRow: false,
                avoidFrontRow: false,
                avoidBackRow: false,
            });
        }
        return hardSeatRules.get(studentId);
    }

    function allowedSeatForStudent(studentId, seat) {
        if (!studentId || !seat) return false;
        const rules = hardSeatRules.get(studentId);
        if (!rules) return true;
        if (rules.avoidFirstRow && seat.r === firstRow) return false;
        if (rules.avoidLastRow && seat.r === lastRow) return false;
        if (rules.avoidFrontRow && frontRows.has(seat.r)) return false;
        if (rules.avoidBackRow && backRows.has(seat.r)) return false;
        return true;
    }

    function place(studentId, seat, { allowHardViolation = false } = {}) {
        if (!studentId || !seat || occupied.has(seatKey(seat)) || placed.has(studentId)) return false;
        if (!allowHardViolation && !allowedSeatForStudent(studentId, seat)) return false;
        assignments.push({ studentId, row: seat.r, col: seat.c });
        occupied.add(seatKey(seat));
        placed.add(studentId);
        return true;
    }

    function nextSeat(predicate = () => true, { reverse = false, byQuality = false } = {}) {
        const seats = byQuality ? sortSeatsByQuality(allSeats, seatScoreMap) : (reverse ? [...allSeats].reverse() : allSeats);
        return seats.find(seat => isFree(seat) && predicate(seat));
    }

    function nextSeatForStudent(studentId, predicate = () => true, options = {}) {
        return nextSeat(seat => predicate(seat) && allowedSeatForStudent(studentId, seat), options);
    }

    function isAisleSeat(seat) {
        if (!seat) return false;
        const left = seat.c > 0 ? layout.cells?.[seat.r]?.[seat.c - 1] : null;
        const right = seat.c < layout.cols - 1 ? layout.cells?.[seat.r]?.[seat.c + 1] : null;
        return left === CELL.AISLE || right === CELL.AISLE || seat.c === 0 || seat.c === layout.cols - 1;
    }

    function isEdgeSeat(seat) {
        return Boolean(seat && edgeCols.has(seat.c));
    }

    function placeRemainingStudents(regionStudents, regionSeats) {
        let ordered = [...regionStudents];
        if (spec.placementPolicy?.genderBalance) ordered = interleaveGender(ordered);
        for (const student of ordered) {
            const seat = regionSeats.find(candidate => isFree(candidate) && allowedSeatForStudent(student.id, candidate))
                || regionSeats.find(candidate => isFree(candidate));
            if (seat) {
                place(student.id, seat, { allowHardViolation: !allowedSeatForStudent(student.id, seat) });
            }
        }
    }

    function placePriorityRegion(regionStudents, regionSeats, topGradeIds) {
        const placedExcellent = placeTopGradeStudentsInBestSeats({
            students: regionStudents,
            seats: regionSeats.filter(isFree),
            topGradeIds,
            scoreMap: seatScoreMap,
            place,
        });
        placeRemainingStudents(
            regionStudents.filter(student => !placedExcellent.has(student.id)),
            regionSeats
        );
    }

    function placePriorityStudents(students, seats) {
        const topGradeIds = getTopGradeStudentIds([...studentsById.values()]);
        if (spec.placementPolicy?.heightOrder) {
            const byHeight = [...students].sort((a, b) => {
                const diff = (Number(a.height) || 0) - (Number(b.height) || 0);
                return diff || a.id.localeCompare(b.id);
            });
            const rowSeatGroups = [];
            for (const seat of seats) {
                const last = rowSeatGroups[rowSeatGroups.length - 1];
                if (!last || last.row !== seat.r) rowSeatGroups.push({ row: seat.r, seats: [seat] });
                else last.seats.push(seat);
            }
            let cursor = 0;
            for (const group of rowSeatGroups) {
                const chunk = byHeight.slice(cursor, cursor + group.seats.length);
                cursor += group.seats.length;
                placePriorityRegion(chunk, group.seats, topGradeIds);
            }
            if (cursor < byHeight.length) {
                placePriorityRegion(byHeight.slice(cursor), seats.filter(isFree), topGradeIds);
            }
            return;
        }
        placePriorityRegion(students, seats, topGradeIds);
    }

    const avoidPairs = [];
    const avoidNearPairs = [];
    const avoidBehindPairs = [];
    const pairConstraints = [];
    const frontIds = [];
    const backIds = [];
    const frontMiddleIds = [];
    const frontMidIds = [];
    const aisleIds = [];
    const edgeIds = [];
    const highGradeNeighborIds = [];
    const avoidLowGradeNeighborIds = [];

    for (const constraint of request.constraints || []) {
        const id = resolveConstraintStudentId(constraint.target, studentsById, studentsByName, studentsByNormalized);
        const related = resolveConstraintStudentId(constraint.related, studentsById, studentsByName, studentsByNormalized);
        if (constraint.type === 'front_row' && id) frontIds.push(id);
        if (constraint.type === 'back_row' && id) backIds.push(id);
        if (constraint.type === 'prefer_front_middle' && id) frontMiddleIds.push(id);
        if (constraint.type === 'prefer_front_mid_rows' && id) frontMidIds.push(id);
        if (constraint.type === 'prefer_aisle' && id) aisleIds.push(id);
        if (constraint.type === 'prefer_edge' && id) edgeIds.push(id);
        if (constraint.type === 'prefer_high_grade_neighbor' && id) highGradeNeighborIds.push(id);
        if (constraint.type === 'avoid_low_grade_deskmate' && id) avoidLowGradeNeighborIds.push(id);
        if (constraint.type === 'avoid_first_row' && id) rulesFor(id).avoidFirstRow = true;
        if (constraint.type === 'avoid_last_row' && id) rulesFor(id).avoidLastRow = true;
        if (constraint.type === 'avoid_front_row' && id) rulesFor(id).avoidFrontRow = true;
        if (constraint.type === 'avoid_back_row' && id) rulesFor(id).avoidBackRow = true;
        if ((constraint.type === 'pair' || constraint.type === 'must_adjacent') && id && related) pairConstraints.push([id, related]);
        if ((constraint.type === 'avoid' || constraint.type === 'not_adjacent') && id && related) avoidPairs.push([id, related]);
        if (constraint.type === 'avoid_near' && id && related) avoidNearPairs.push([id, related]);
        if (constraint.type === 'avoid_behind' && id && related) avoidBehindPairs.push([id, related]);
    }

    for (const [id1, id2] of pairConstraints) {
        if (guardianIds.has(id1) || guardianIds.has(id2) || placed.has(id1) || placed.has(id2)) continue;
        let placedPair = false;
        for (const seat of allSeats) {
            if (!isFree(seat) || !allowedSeatForStudent(id1, seat)) continue;
            const mate = allSeats.find(candidate => isFree(candidate)
                && allowedSeatForStudent(id2, candidate)
                && candidate.group === seat.group
                && areAdjacentSeats(candidate, seat));
            if (mate && place(id1, seat) && place(id2, mate)) {
                placedPair = true;
                break;
            }
        }
        if (!placedPair) {
            warnings.push(`未能让 ${id1} 和 ${id2} 相邻`);
            unsatisfied.push({ target: id1, related: id2, type: 'pair', reason: '没有可用相邻座位' });
        }
    }

    const targetSeatPredicate = id => {
        const predicates = [];
        if (frontMiddleIds.includes(id)) predicates.push(seat => frontRows.has(seat.r) && middleCols.has(seat.c));
        else if (frontMidIds.includes(id)) predicates.push(seat => frontMidRows.has(seat.r));
        else {
            if (frontIds.includes(id)) predicates.push(seat => frontRows.has(seat.r));
            if (backIds.includes(id)) predicates.push(seat => backRows.has(seat.r));
        }
        if (edgeIds.includes(id)) predicates.push(isEdgeSeat);
        if (aisleIds.includes(id)) predicates.push(isAisleSeat);
        return predicates.length ? seat => predicates.every(predicate => predicate(seat)) : () => true;
    };

    const topGradeIds = getTopGradeStudentIds([...studentsById.values()]);
    for (const id of highGradeNeighborIds) {
        if (guardianIds.has(id) || placed.has(id)) continue;
        const partner = rankedStudentsByGradeDesc(regularStudents)
            .find(student => student.id !== id && topGradeIds.has(student.id) && !placed.has(student.id) && !guardianIds.has(student.id));
        if (!partner) continue;
        const preferredTargetSeat = targetSeatPredicate(id);
        let placedNeighbor = false;
        for (const seat of sortSeatsByQuality(allSeats, seatScoreMap)) {
            if (!isFree(seat) || !preferredTargetSeat(seat) || !allowedSeatForStudent(id, seat)) continue;
            const mate = allSeats.find(candidate => isFree(candidate)
                && allowedSeatForStudent(partner.id, candidate)
                && candidate.group === seat.group
                && areAdjacentSeats(candidate, seat));
            if (mate && place(id, seat) && place(partner.id, mate)) {
                placedNeighbor = true;
                break;
            }
        }
        if (!placedNeighbor) {
            warnings.push(`未能优先为 ${id} 安排成绩较好的邻座`);
        }
    }

    for (const id of frontMiddleIds) {
        if (!guardianIds.has(id) && !placed.has(id)) {
            place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
        }
    }
    for (const id of frontMidIds) {
        if (!guardianIds.has(id) && !placed.has(id)) {
            place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
        }
    }
    for (const id of frontIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }
    for (const id of backIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }
    for (const id of edgeIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }
    for (const id of aisleIds) {
        if (!guardianIds.has(id) && !placed.has(id)) place(id, nextSeatForStudent(id, targetSeatPredicate(id), { byQuality: true }));
    }

    const freeSeatsForRemaining = allSeats.filter(isFree);
    const studentsToPlace = regularStudents.filter(student => !placed.has(student.id));
    if (spec.placementPolicy?.gradeStrategy === 'priority') {
        placePriorityStudents(studentsToPlace, freeSeatsForRemaining);
    } else {
        const remaining = sortStudentsForPlacement(
            studentsToPlace,
            spec,
            freeSeatsForRemaining
        );
        for (const student of remaining) {
            const seat = freeSeatsForRemaining.find(candidate => isFree(candidate) && allowedSeatForStudent(student.id, candidate))
                || freeSeatsForRemaining.find(candidate => isFree(candidate));
            if (seat) place(student.id, seat, { allowHardViolation: !allowedSeatForStudent(student.id, seat) });
        }
    }

    const positionById = () => new Map(assignments.map(assignment => [assignment.studentId, assignment]));
    for (const [id1, id2] of avoidPairs) {
        let positions = positionById();
        const pos1 = positions.get(id1);
        const pos2 = positions.get(id2);
        if (!areAdjacent(pos1, pos2)) continue;
        const index2 = assignments.findIndex(assignment => assignment.studentId === id2);
        let fixed = false;
        for (let i = 0; i < assignments.length; i++) {
            const candidate = assignments[i];
            if (candidate.studentId === id1 || candidate.studentId === id2) continue;
            if (areAdjacent(pos1, candidate)) continue;
            if (!allowedSeatForStudent(id2, { r: candidate.row, c: candidate.col })) continue;
            if (!allowedSeatForStudent(candidate.studentId, { r: pos2.row, c: pos2.col })) continue;
            const original = { row: candidate.row, col: candidate.col };
            candidate.row = pos2.row;
            candidate.col = pos2.col;
            assignments[index2].row = original.row;
            assignments[index2].col = original.col;
            positions = positionById();
            if (!areAdjacent(positions.get(id1), positions.get(id2))) {
                fixed = true;
                break;
            }
        }
        if (!fixed) {
            warnings.push(`未能完全满足 ${id1} 和 ${id2} 不相邻`);
            unsatisfied.push({ target: id1, related: id2, type: 'avoid', reason: '没有找到可交换的远离座位' });
        }
    }

    for (const [id1, id2] of avoidNearPairs) {
        let positions = positionById();
        const pos1 = positions.get(id1);
        const pos2 = positions.get(id2);
        if (!areNearAssignments(pos1, pos2)) continue;
        const index2 = assignments.findIndex(assignment => assignment.studentId === id2);
        let fixed = false;
        for (const candidate of assignments) {
            if (candidate.studentId === id1 || candidate.studentId === id2) continue;
            if (areNearAssignments(pos1, candidate)) continue;
            if (!allowedSeatForStudent(id2, { r: candidate.row, c: candidate.col })) continue;
            if (!allowedSeatForStudent(candidate.studentId, { r: pos2.row, c: pos2.col })) continue;
            const original = { row: candidate.row, col: candidate.col };
            candidate.row = pos2.row;
            candidate.col = pos2.col;
            assignments[index2].row = original.row;
            assignments[index2].col = original.col;
            positions = positionById();
            if (!areNearAssignments(positions.get(id1), positions.get(id2))) {
                fixed = true;
                break;
            }
        }
        if (!fixed) {
            warnings.push(`未能完全满足 ${id1} 和 ${id2} 不要太近`);
            unsatisfied.push({ target: id1, related: id2, type: 'avoid_near', reason: '没有找到更远座位' });
        }
    }

    for (const [targetId, relatedId] of avoidBehindPairs) {
        let positions = positionById();
        const target = positions.get(targetId);
        const related = positions.get(relatedId);
        if (!target || !related || target.row <= related.row) continue;
        const targetIndex = assignments.findIndex(assignment => assignment.studentId === targetId);
        let fixed = false;
        for (const candidate of assignments) {
            if (candidate.studentId === targetId || candidate.studentId === relatedId) continue;
            if (candidate.row > related.row) continue;
            if (!allowedSeatForStudent(targetId, { r: candidate.row, c: candidate.col })) continue;
            if (!allowedSeatForStudent(candidate.studentId, { r: target.row, c: target.col })) continue;
            const original = { row: candidate.row, col: candidate.col };
            candidate.row = target.row;
            candidate.col = target.col;
            assignments[targetIndex].row = original.row;
            assignments[targetIndex].col = original.col;
            positions = positionById();
            if (positions.get(targetId)?.row <= positions.get(relatedId)?.row) {
                fixed = true;
                break;
            }
        }
        if (!fixed) {
            warnings.push(`未能完全满足 ${targetId} 不坐在 ${relatedId} 后面`);
            unsatisfied.push({ target: targetId, related: relatedId, type: 'avoid_behind', reason: '没有找到前方可交换座位' });
        }
    }

    const lowGradeIds = getLowGradeStudentIds([...studentsById.values()]);
    for (const id of avoidLowGradeNeighborIds) {
        const positions = positionById();
        const pos = positions.get(id);
        if (!pos) continue;
        const hasLowNeighbor = assignments.some(candidate => candidate.studentId !== id
            && lowGradeIds.has(candidate.studentId)
            && areAdjacent(pos, candidate));
        if (hasLowNeighbor) {
            unsatisfied.push({ target: id, type: 'avoid_low_grade_deskmate', reason: '旁边仍有成绩偏低的同学' });
        }
    }

    const excellentProtection = protectExcellentStudentsFromLastRow({
        assignments,
        studentsById,
        seats: allSeats,
        gradeStrategy: spec.placementPolicy?.gradeStrategy,
        scoreMap: seatScoreMap,
    });
    if (excellentProtection.remaining > 0) {
        warnings.push(`优秀优先下最后一排外座位不足，仍有 ${excellentProtection.remaining} 名优秀学生在最后一排`);
    }

    const unassigned = regularStudents.filter(student => !placed.has(student.id)).map(student => student.id);
    if (unassigned.length) warnings.push(`${unassigned.length} 名学生未安排`);
    return { assignments, unassigned, warnings, unsatisfied };
}

function assignmentsToLayout(assignments = [], classroomLayout = {}) {
    const rows = Math.max(0, Number(classroomLayout.rows) || 0);
    const cols = Math.max(0, Number(classroomLayout.cols) || 0);
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (const assignment of assignments) {
        if (!Number.isInteger(assignment?.row) || !Number.isInteger(assignment?.col)) continue;
        if (assignment.row < 0 || assignment.col < 0 || assignment.row >= rows || assignment.col >= cols) continue;
        matrix[assignment.row][assignment.col] = assignment.studentId;
    }
    return matrix;
}

function constraintEvaluationForAssignments({
    assignments,
    request,
    classroomLayout,
    guardians,
    unassigned,
    spec,
}) {
    const layout = assignmentsToLayout(assignments, classroomLayout);
    const guardianIds = [guardians.left, guardians.right].filter(Boolean);
    const needEvaluation = evaluateSeatingConstraints({
        layout,
        students: request.students,
        constraints: request.constraints,
        rows: classroomLayout.rows,
        cols: classroomLayout.cols,
        localAisles: classroomLayout.localAisles,
    });
    const quality = evaluateSeatingQuality({
        layout,
        students: request.students,
        constraints: request.constraints,
        classroomLayout,
        guardians: guardianIds,
        unassigned,
        strategy: spec.placementPolicy || {},
    });
    return {
        needEvaluation,
        quality,
        hard: needEvaluation.hardUnsatisfied.length,
        soft: needEvaluation.softUnsatisfied.length,
        percent: quality.percent,
    };
}

function betterConstraintEvaluation(candidate, current) {
    if (candidate.hard > current.hard) return false;
    if (candidate.hard < current.hard) return true;
    if (candidate.soft < current.soft) return true;
    return candidate.soft <= current.soft && candidate.percent > current.percent;
}

function betterScoreEvaluation(candidate, current) {
    const candidateQuality = candidate.quality || {};
    const currentQuality = current.quality || {};
    const candidateHardViolations = candidateQuality.hardViolationCount || 0;
    const currentHardViolations = currentQuality.hardViolationCount || 0;
    if (candidateHardViolations > currentHardViolations) return false;
    if (candidateHardViolations < currentHardViolations) return true;

    const candidateHardScore = candidateQuality.hardScore || 0;
    const currentHardScore = currentQuality.hardScore || 0;
    if (candidateHardScore < currentHardScore) return false;
    if (candidateHardScore > currentHardScore) return true;

    const candidateSoftViolations = candidateQuality.softViolationCount || 0;
    const currentSoftViolations = currentQuality.softViolationCount || 0;
    if (candidateSoftViolations < currentSoftViolations) return true;
    if (candidateSoftViolations > currentSoftViolations) return false;

    const candidateSoftScore = candidateQuality.softScore || 0;
    const currentSoftScore = currentQuality.softScore || 0;
    if (candidateSoftScore > currentSoftScore) return true;
    if (candidateSoftScore < currentSoftScore) return false;

    return (candidateQuality.percent || 0) > (currentQuality.percent || 0);
}

function cloneAssignments(assignments = []) {
    return assignments.map(assignment => ({ ...assignment }));
}

function assignmentSeatKey(assignment) {
    return `${assignment.row},${assignment.col}`;
}

function refineSeatingAssignments({
    seating,
    request,
    classroomLayout,
    guardians,
    spec,
    maxRounds = 100,
}) {
    if (!request.constraints?.length || !seating?.assignments?.length) {
        return {
            ...seating,
            refinementApplied: false,
            refinementRounds: 0,
        };
    }

    let assignments = cloneAssignments(seating.assignments);
    let current = constraintEvaluationForAssignments({
        assignments,
        request,
        classroomLayout,
        guardians,
        unassigned: seating.unassigned || [],
        spec,
    });
    if (!current.needEvaluation.unsatisfied.length) {
        return {
            ...seating,
            assignments,
            unsatisfied: [],
            refinementApplied: false,
            refinementRounds: 0,
        };
    }

    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const seatOptions = layoutSeatList(classroomLayout);
    let rounds = 0;
    let applied = false;

    while (rounds < maxRounds) {
        let improved = false;
        const occupied = new Map(assignments.map((assignment, index) => [assignmentSeatKey(assignment), index]));

        for (let i = 0; i < assignments.length && !improved; i++) {
            if (guardianIds.has(assignments[i].studentId)) continue;

            for (const seat of seatOptions) {
                const key = `${seat.r},${seat.c}`;
                const occupantIndex = occupied.get(key);
                if (occupantIndex === i) continue;
                if (occupantIndex != null && guardianIds.has(assignments[occupantIndex].studentId)) continue;

                const candidateAssignments = cloneAssignments(assignments);
                if (occupantIndex == null) {
                    candidateAssignments[i].row = seat.r;
                    candidateAssignments[i].col = seat.c;
                } else {
                    const original = {
                        row: candidateAssignments[i].row,
                        col: candidateAssignments[i].col,
                    };
                    candidateAssignments[i].row = candidateAssignments[occupantIndex].row;
                    candidateAssignments[i].col = candidateAssignments[occupantIndex].col;
                    candidateAssignments[occupantIndex].row = original.row;
                    candidateAssignments[occupantIndex].col = original.col;
                }

                const candidate = constraintEvaluationForAssignments({
                    assignments: candidateAssignments,
                    request,
                    classroomLayout,
                    guardians,
                    unassigned: seating.unassigned || [],
                    spec,
                });
                if (!betterConstraintEvaluation(candidate, current)) continue;

                assignments = candidateAssignments;
                current = candidate;
                improved = true;
                applied = true;
                rounds++;
                break;
            }
        }

        if (!improved) break;
    }

    return {
        ...seating,
        assignments,
        unsatisfied: current.needEvaluation.unsatisfied,
        refinementApplied: applied,
        refinementRounds: rounds,
    };
}

export function optimizeSeatingScore({
    seating,
    request,
    classroomLayout,
    guardians = {},
    spec = {},
    maxRounds = 250,
    maxDurationMs = 4000,
    now = () => Date.now(),
} = {}) {
    if (!seating?.assignments?.length) {
        return {
            ...seating,
            scoreOptimizationApplied: false,
            scoreOptimizationRounds: 0,
            scoreBeforePercent: null,
            scoreAfterPercent: null,
            scoreOptimizerTimedOut: false,
        };
    }

    let assignments = cloneAssignments(seating.assignments);
    let current = constraintEvaluationForAssignments({
        assignments,
        request,
        classroomLayout,
        guardians,
        unassigned: seating.unassigned || [],
        spec,
    });
    const scoreBeforePercent = current.quality.percent;
    const guardianIds = new Set([guardians.left, guardians.right].filter(Boolean));
    const scoreMap = calculateSeatScoreMap(classroomLayout);
    const seatOptions = sortSeatsByQuality(layoutSeatList(classroomLayout), scoreMap);
    const policy = spec.placementPolicy || request.strategy || {};
    const usableRows = [...new Set(seatOptions.map(seat => seat.r))].sort((a, b) => a - b);
    const lastUsableRow = usableRows.at(-1);
    const topGradeIds = getTopGradeStudentIds(request.students || []);
    const canMoveStudentToSeat = (studentId, fromRow, seat) => {
        if (!studentId || !seat) return false;
        if (policy.heightOrder && seat.r !== fromRow) return false;
        if (policy.gradeStrategy === 'priority' && topGradeIds.has(studentId) && seat.r === lastUsableRow) return false;
        return true;
    };
    const deadline = now() + Math.max(1, Number(maxDurationMs) || 1);
    let rounds = 0;
    let applied = false;
    let timedOut = false;

    while (rounds < maxRounds) {
        if (now() >= deadline) {
            timedOut = true;
            break;
        }
        let improved = false;
        const occupied = new Map(assignments.map((assignment, index) => [assignmentSeatKey(assignment), index]));

        for (let i = 0; i < assignments.length && !improved; i++) {
            if (guardianIds.has(assignments[i].studentId)) continue;

            for (const seat of seatOptions) {
                if (now() >= deadline) {
                    timedOut = true;
                    break;
                }
                const key = `${seat.r},${seat.c}`;
                const occupantIndex = occupied.get(key);
                if (occupantIndex === i) continue;
                if (occupantIndex != null && guardianIds.has(assignments[occupantIndex].studentId)) continue;
                if (!canMoveStudentToSeat(assignments[i].studentId, assignments[i].row, seat)) continue;
                if (occupantIndex != null) {
                    const occupant = assignments[occupantIndex];
                    if (!canMoveStudentToSeat(occupant.studentId, occupant.row, assignments[i])) continue;
                }

                const candidateAssignments = cloneAssignments(assignments);
                if (occupantIndex == null) {
                    candidateAssignments[i].row = seat.r;
                    candidateAssignments[i].col = seat.c;
                } else {
                    const original = {
                        row: candidateAssignments[i].row,
                        col: candidateAssignments[i].col,
                    };
                    candidateAssignments[i].row = candidateAssignments[occupantIndex].row;
                    candidateAssignments[i].col = candidateAssignments[occupantIndex].col;
                    candidateAssignments[occupantIndex].row = original.row;
                    candidateAssignments[occupantIndex].col = original.col;
                }

                const candidate = constraintEvaluationForAssignments({
                    assignments: candidateAssignments,
                    request,
                    classroomLayout,
                    guardians,
                    unassigned: seating.unassigned || [],
                    spec,
                });
                if (!betterScoreEvaluation(candidate, current)) continue;

                assignments = candidateAssignments;
                current = candidate;
                rounds++;
                applied = true;
                improved = true;
                break;
            }
        }

        if (timedOut || !improved) break;
    }

    const protection = protectExcellentStudentsFromLastRow({
        assignments,
        studentsById: new Map((request.students || []).map(student => [student.id, student])),
        seats: seatOptions,
        gradeStrategy: policy.gradeStrategy,
        scoreMap,
    });
    if (protection.moved > 0) {
        current = constraintEvaluationForAssignments({
            assignments,
            request,
            classroomLayout,
            guardians,
            unassigned: seating.unassigned || [],
            spec,
        });
        applied = true;
        rounds += protection.moved;
    }

    return {
        ...seating,
        assignments,
        unsatisfied: current.needEvaluation.unsatisfied,
        scoreOptimizationApplied: applied,
        scoreOptimizationRounds: rounds,
        scoreBeforePercent,
        scoreAfterPercent: current.quality.percent,
        scoreOptimizerTimedOut: timedOut,
    };
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

function buildLayoutInterpretation({ request, spec, layout }) {
    const logicalGroupRows = spec.groupsPerRow > 0
        ? Math.ceil(Math.ceil(request.students.length / Math.max(1, spec.groupSize || 1)) / spec.groupsPerRow)
        : layout.rows;
    const parts = [];
    const mixedColumnPattern = Array.isArray(spec.columnPattern) && spec.columnPattern.length > 0;
    if (mixedColumnPattern) {
        parts.push(`已理解为：${spec.notes || '两边1人组，中间2人组，组间过道'}`);
    } else if ((spec.groupSize || 1) > 1 && spec.groupsPerRow > 0) {
        parts.push(`已理解为：${spec.groupSize === 2 ? '两人' : `${spec.groupSize}人`}一组，每行 ${spec.groupsPerRow} 组，组间${spec.aislePolicy?.verticalBetweenGroups ? '竖过道' : '不留竖过道'}`);
    } else if (spec.physicalCols > 0) {
        parts.push(`已理解为：${spec.physicalRows > 0 ? `${spec.physicalRows} 行 × ` : ''}${spec.physicalCols} 个物理座位列`);
    } else if ((spec.groupSize || 1) > 1) {
        parts.push(`已理解为：${spec.groupSize}人一组`);
    } else {
        parts.push('已理解为：普通座位布局');
    }
    if (mixedColumnPattern) {
        parts.push(`布局：${spec.physicalRows || layout.rows} 排 × 混合列模式，可用 ${gridSeatCount(layout)} 个座位`);
    } else {
        parts.push(`布局：${logicalGroupRows} 排 × ${spec.groupsPerRow || layout.cols} ${spec.groupsPerRow ? '组' : '列'} × ${spec.groupsPerRow ? `${spec.groupSize} 座` : '座位'}，可用 ${gridSeatCount(layout)} 个座位`);
    }
    return {
        summary: parts.join('；'),
        assumptions: spec.assumptions || [],
        confidence: (mixedColumnPattern || spec.groupsPerRow > 0 || spec.physicalCols > 0 || spec.physicalRows > 0) ? 'high' : 'medium',
        layoutFacts: {
            groupSize: spec.groupSize || 1,
            groupsPerRow: spec.groupsPerRow || 0,
            physicalCols: spec.physicalCols || 0,
            physicalRows: spec.physicalRows || 0,
            capacityPolicy: spec.capacityPolicy || 'auto_expand',
            columnPattern: spec.columnPattern || [],
            mixedColumnPattern,
            rows: layout.rows,
            cols: layout.cols,
            regularSeatCount: gridSeatCount(layout),
            verticalBetweenGroups: Boolean(spec.aislePolicy?.verticalBetweenGroups),
            horizontalBetweenGroupRows: Boolean(spec.aislePolicy?.horizontalBetweenGroupRows),
        },
    };
}

function buildSolverFacts({ source, solverStats }) {
    if (source === 'timefold_solver') {
        return {
            used: true,
            name: 'Timefold Solver',
            hardScore: solverStats.hardScore,
            softScore: solverStats.softScore,
            score: solverStats.score,
            durationMs: solverStats.durationMs,
            summary: `Timefold Solver 已优化学生分配，硬约束 ${solverStats.hardScore ?? 0}，软分数 ${solverStats.softScore ?? 0}`,
        };
    }
    return {
        used: false,
        name: '本地排座',
        fallbackReason: solverStats.fallbackReason || null,
        summary: solverStats.fallbackReason
            ? `Timefold 不可用，已回退本地排座（${solverStats.fallbackReason}）`
            : '本地排座生成结果',
    };
}

function buildArrangementInterpretation({ request, spec, layout, source, solverStats }) {
    const layoutInterpretation = buildLayoutInterpretation({ request, spec, layout });
    const solverFacts = buildSolverFacts({ source, solverStats });
    return {
        ...layoutInterpretation,
        solverFacts,
    };
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

function hasLayoutPreviewPayload(raw = {}) {
    return Boolean(raw?.classroomLayout || raw?.layout || Array.isArray(raw?.matrix));
}

function hasArrangementSpecPayload(raw = {}) {
    if (!raw || typeof raw !== 'object') return false;
    return [
        'groupSize', 'group_size', 'groupsPerRow', 'groups_per_row',
        'physicalCols', 'physical_cols', 'physicalRows', 'physical_rows',
        'columnPattern', 'column_pattern', 'aislePolicy', 'aisles',
        'guardianPolicy', 'guardians', 'layoutMode', 'layout_mode',
        'placementPolicy', 'capacityPolicy',
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

function buildPreviewLayoutFromSpec({ request, spec, source = 'local_layout_fallback', warnings = [], reply, reasoning }) {
    const guardianReserve = spec.guardianPolicy?.enabled ? Math.min(2, request.students.length) : 0;
    const classroomLayout = buildExpandableClassroomLayout({
        regularSeatTarget: Math.max(1, request.students.length - guardianReserve),
        spec,
        previousLayout: request.previousLayout,
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
        warnings: normalizeWarnings(warnings),
        reasoning: reasoning || (source === 'local_layout_fallback' ? '本地算法根据已解析规则生成备用布局。' : (spec.notes || 'AI 返回规则参数，本地算法生成布局矩阵。')),
        source,
        arrangementSpec: spec,
        stats: previewStats({ request, classroomLayout, source }),
    };
}

function normalizeLayoutPreviewRaw({ raw, request, allowUnassigned }) {
    if (hasLayoutPreviewPayload(raw)) {
        let plan;
        try {
            plan = normalizeLayoutPlan(raw);
        } catch (error) {
            return { ok: false, errors: [error.message] };
        }
        const validation = validateLayoutPlan(plan, request.students.length, allowUnassigned);
        if (!validation.ok) return validation;
        const spec = normalizeArrangementSpec(plan.arrangementSpec || {}, request);
        const source = 'ai_layout_preview';
        return {
            ok: true,
            errors: [],
            data: {
                reply: plan.reply,
                classroomLayout: plan.classroomLayout,
                layoutIntent: plan.layoutIntent || layoutIntentFromSpec(spec),
                warnings: [
                    ...normalizeWarnings(plan.warnings),
                    ...(spec.parseWarnings || []),
                ],
                reasoning: plan.reasoning,
                source,
                arrangementSpec: spec,
                stats: previewStats({ request, classroomLayout: plan.classroomLayout, source }),
            },
        };
    }

    if (hasArrangementSpecPayload(raw)) {
        const spec = normalizeArrangementSpec(raw, request);
        return {
            ok: true,
            errors: [],
            data: buildPreviewLayoutFromSpec({
                request,
                spec,
                source: 'ai_spec_local_algorithm',
                warnings: spec.parseWarnings || [],
                reply: 'AI 返回了规则参数，已用本地算法生成布局预览。',
            }),
        };
    }

    return { ok: false, errors: ['AI 未返回 classroomLayout.cells'] };
}

export async function runAiLayoutPreview({
    request,
    fetchImpl,
    env = process.env,
} = {}) {
    if (!request) throw new Error('缺少排座请求');
    const fallbackSpec = normalizeArrangementSpec(request.arrangementSpec || {}, request);
    const allowUnassigned = shouldAllowUnassigned(request.prompt) || fallbackSpec.capacityPolicy === 'fixed';

    if (typeof fetchImpl !== 'function' || !env.DEEPSEEK_API_BASE || !env.DEEPSEEK_API_KEY) {
        return buildPreviewLayoutFromSpec({
            request,
            spec: fallbackSpec,
            source: 'local_layout_fallback',
            warnings: ['AI 布局服务未配置，已使用本地备用布局。'],
        });
    }

    try {
        const result = await requestStageWithRetry({
            stage: 'layout_preview',
            request,
            fetchImpl,
            env,
            context: {},
            validate: raw => normalizeLayoutPreviewRaw({ raw, request, allowUnassigned }),
            maxAttempts: 3,
            maxTokens: arrangeMaxTokens(env),
        });
        return result.data;
    } catch (error) {
        return buildPreviewLayoutFromSpec({
            request,
            spec: fallbackSpec,
            source: 'local_layout_fallback',
            warnings: [`AI 布局预览不可用，已使用本地备用布局：${error.message}`],
        });
    }
}

async function assignStudentsToLayout({
    request,
    spec,
    specWarnings = [],
    classroomLayout,
    layoutSource = 'local_layout_fallback',
    env = process.env,
    fetchImpl,
}) {
    const guardians = chooseGuardians(request.students, spec);
    classroomLayout.guardians = {
        enabled: Boolean(spec.guardianPolicy.enabled || guardians.left || guardians.right),
        left: guardians.left,
        right: guardians.right,
    };
    let seating;
    let source = layoutSource === 'ai_layout_preview'
        ? 'ai_layout_local_assignment'
        : layoutSource === 'confirmed_layout'
            ? 'confirmed_layout_local_assignment'
            : layoutSource;
    const solverWarnings = [];
    const solverStats = {
        solverUsed: false,
        solverName: '本地排座',
        hardScore: null,
        softScore: null,
        score: null,
        durationMs: null,
        fallbackReason: null,
        refinementApplied: false,
        refinementRounds: 0,
        scoreOptimizationApplied: false,
        scoreOptimizationRounds: 0,
        scoreBeforePercent: null,
        scoreAfterPercent: null,
        scoreOptimizerTimedOut: false,
    };
    try {
        seating = await solveWithTimefold({
            request,
            layout: classroomLayout,
            spec,
            guardians,
            env,
            fetchImpl,
        });
        source = 'timefold_solver';
        solverStats.solverUsed = true;
        solverStats.solverName = 'Timefold Solver';
        solverStats.hardScore = seating.hardScore ?? null;
        solverStats.softScore = seating.softScore ?? null;
        solverStats.score = seating.score ?? null;
        solverStats.durationMs = seating.durationMs ?? null;
    } catch (error) {
        solverStats.fallbackReason = error instanceof TimefoldUnavailableError
            ? error.reason
            : (error?.message || 'unknown_error');
        if (!(error instanceof TimefoldUnavailableError && ['not_configured', 'rich_constraints'].includes(error.reason))
            && asText(env?.TIMEFOLD_SOLVER_URL)) {
            solverWarnings.push(`Timefold solver unavailable (${error.reason || error.message}); used local seating algorithm.`);
        }
        seating = assignLocalSeats({ request, layout: classroomLayout, spec, guardians });
    }
    seating = refineSeatingAssignments({
        seating,
        request,
        classroomLayout,
        guardians,
        spec,
    });
    solverStats.refinementApplied = Boolean(seating.refinementApplied);
    solverStats.refinementRounds = seating.refinementRounds || 0;
    seating = optimizeSeatingScore({
        seating,
        request,
        classroomLayout,
        guardians,
        spec,
    });
    solverStats.scoreOptimizationApplied = Boolean(seating.scoreOptimizationApplied);
    solverStats.scoreOptimizationRounds = seating.scoreOptimizationRounds || 0;
    solverStats.scoreBeforePercent = seating.scoreBeforePercent ?? null;
    solverStats.scoreAfterPercent = seating.scoreAfterPercent ?? null;
    solverStats.scoreOptimizerTimedOut = Boolean(seating.scoreOptimizerTimedOut);
    const regularSeatCount = gridSeatCount(classroomLayout);
    const guardianSeatCount = [guardians.left, guardians.right].filter(Boolean).length;
    const warnings = [
        ...specWarnings,
        ...strategyOverrideWarnings(spec, request.strategy),
        ...solverWarnings,
        ...normalizeWarnings(seating.warnings),
    ];
    const interpretation = buildArrangementInterpretation({
        request,
        spec,
        layout: classroomLayout,
        source,
        solverStats,
    });
    return {
        reply: `已根据需求自动扩容并安排 ${request.students.length - seating.unassigned.length} 名学生。`,
        classroomLayout,
        assignments: seating.assignments,
        guardians,
        unassigned: seating.unassigned,
        warnings,
        unsatisfied: seating.unsatisfied,
        reasoning: source === 'timefold_solver'
            ? 'Timefold solver generated the seating plan from the parsed constraints.'
            : (spec.notes || 'AI 解析需求，本地算法稳定生成完整座位表。'),
        source,
        interpretation,
        arrangementSpec: spec,
        stats: {
            studentCount: request.students.length,
            regularSeatCount,
            guardianSeatCount,
            rows: classroomLayout.rows,
            cols: classroomLayout.cols,
            layoutSource,
            appliedStrategies: appliedStrategiesFor(spec),
            ...solverStats,
        },
    };
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

export async function runAiDrivenArrangement({
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

export async function requestAiArrangement({
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
