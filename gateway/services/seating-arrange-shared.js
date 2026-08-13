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

function parseAiJson(content) {
    const text = asText(content).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    if (!text) throw new Error('AI 返回为空');
    try {
        return JSON.parse(text);
    } catch (error) {
        error.code = 'AI_JSON_PARSE';
        throw error;
    }
}

function isAiJsonParseError(error) {
    return error?.code === 'AI_JSON_PARSE' || error instanceof SyntaxError;
}

function shouldAllowUnassigned(prompt = '') {
    const text = asText(prompt);
    return /(只有|仅有|最多|不超过|固定|限制|限于|座位有限).*(排|列|座|座位|人)|((排|列|座|座位).*(只有|仅有|最多|不超过|固定|限制|限于))/.test(text);
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
    const wantsMainVerticalAisle = /(?:中间|中央|正中).*(?:通道|走道|过道)|(?:通道|走道|过道).*(?:中间|中央|正中)/.test(text);
    const wantsMainHorizontalAisle = /(?:中间|中央|正中).*(?:横向|横过道|前后通道)|(?:横向|横过道|前后通道).*(?:中间|中央|正中)/.test(text);
    const disablesGroupGap = /(?:每组|组间|组与组之间).*(?:不要|不留|取消|紧挨|无间距)|(?:不要|不留|取消).*(?:组间|组与组之间).*(?:空|间距|过道)/.test(text);
    const wantsGroupGap = wantsGroup && !disablesGroupGap && (
        /组间过道|每组之间.*(?:过道|通道|走道|空|间距)|(?:每组|组间|组与组之间).*(?:隔开|分开|空|留空|间距|通道|走道)/.test(text)
        || !/(?:每组|组间|组与组之间)/.test(text)
    );
    // “可通行”描述边界类型，不代表横向方向；只有明确的行/前后排措辞才生成横向边界。
    const wantsHorizontalGroupGap = wantsBothAisles
        || /横向过道|横过道|每组之间.*横向|组与组之间.*横向/.test(text)
        || /(?:前后排|前后各排|行与行|排与排|上下排).*(?:通道|走道|过道|隔开)/.test(text);
    const betweenGroups = wantsGroupGap
        ? (/每组之间.*(?:可通行|人行|通行)|组间.*(?:可通行|人行|通行)/.test(text) ? 'walkway' : 'gap')
        : 'none';
    const betweenRows = wantsHorizontalGroupGap
        ? (/横向过道|横过道|前后排|行与行|排与排|上下排/.test(text) ? 'walkway' : 'gap')
        : 'none';
    const mainAisle = wantsBothAisles
        ? 'cross'
        : wantsMainVerticalAisle && wantsMainHorizontalAisle
            ? 'cross'
            : wantsMainVerticalAisle
                ? 'vertical'
                : wantsMainHorizontalAisle
                    ? 'horizontal'
                    : 'none';
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
            verticalBetweenGroups: wantsGroupGap || Boolean(groupColumnWording || groupsPerRow),
            horizontalBetweenGroupRows: wantsHorizontalGroupGap,
            mainVertical: wantsMainVerticalAisle || (wantsBothAisles && /中间|中央|主过道/.test(text)),
            mainHorizontal: wantsMainHorizontalAisle,
        },
        circulation: {
            betweenGroups,
            betweenRows,
            mainAisle,
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
        mainVertical: boolValue(rawPolicy.mainVertical ?? rawPolicy.main_vertical ?? rawPolicy.centralVertical, fallback.mainVertical),
        mainHorizontal: boolValue(rawPolicy.mainHorizontal ?? rawPolicy.main_horizontal ?? rawPolicy.centralHorizontal, fallback.mainHorizontal),
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
        if (hasAnyOwn(rawAisles, ['mainVertical', 'main_vertical', 'centralVertical'])) {
            add('aislePolicy.mainVertical', normalized.aislePolicy?.mainVertical, inferred.aislePolicy?.mainVertical);
        }
        if (hasAnyOwn(rawAisles, ['mainHorizontal', 'main_horizontal', 'centralHorizontal'])) {
            add('aislePolicy.mainHorizontal', normalized.aislePolicy?.mainHorizontal, inferred.aislePolicy?.mainHorizontal);
        }
    }
    return conflicts.length ? [`AI 解析与本地规则解析不一致，已优先采用 AI：${conflicts.join('；')}`] : [];
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

function addMainAisles(cells, groups, { vertical = false, horizontal = false, verticalAfterCol = 0 } = {}) {
    if (vertical && cells[0]?.length >= 2) {
        const insertAt = Math.max(1, Math.min(cells[0].length - 1, verticalAfterCol || Math.ceil(cells[0].length / 2)));
        for (let row = 0; row < cells.length; row++) {
            cells[row].splice(insertAt, 0, CELL.AISLE);
            groups[row].splice(insertAt, 0, null);
        }
    }
    if (horizontal && cells.length >= 2) {
        const insertAt = Math.ceil(cells.length / 2);
        const cols = cells[0]?.length || 0;
        cells.splice(insertAt, 0, Array(cols).fill(CELL.AISLE));
        groups.splice(insertAt, 0, Array(cols).fill(null));
    }
}

function localAislesFromGroups(cells, groups, { vertical = false, horizontal = false } = {}) {
    const localAisles = { vertical: [], horizontal: [] };
    if (vertical) {
        for (let row = 0; row < cells.length; row++) {
            for (let col = 0; col < (cells[row]?.length || 0) - 1; col++) {
                const leftGroup = groups[row]?.[col];
                const rightGroup = groups[row]?.[col + 1];
                if (cells[row][col] === CELL.SEAT
                    && cells[row][col + 1] === CELL.SEAT
                    && leftGroup != null
                    && rightGroup != null
                    && leftGroup !== rightGroup) {
                    localAisles.vertical.push({ row, col });
                }
            }
        }
    }
    if (horizontal) {
        for (let row = 0; row < cells.length - 1; row++) {
            for (let col = 0; col < (cells[row]?.length || 0); col++) {
                if (cells[row][col] === CELL.SEAT && cells[row + 1]?.[col] === CELL.SEAT) {
                    localAisles.horizontal.push({ row, col });
                }
            }
        }
    }
    return localAisles;
}

function expandClassroomWalkways(cells, groups, { vertical = false, horizontal = false } = {}) {
    let nextCells = cells.map(row => [...row]);
    let nextGroups = groups.map(row => [...row]);
    if (vertical) {
        nextCells = nextCells.map((row, r) => {
            const expanded = [];
            const expandedGroups = [];
            for (let col = 0; col < row.length; col++) {
                expanded.push(row[col]);
                expandedGroups.push(nextGroups[r]?.[col] ?? null);
                const boundary = col < row.length - 1
                    && row[col] === CELL.SEAT
                    && row[col + 1] === CELL.SEAT
                    && nextGroups[r]?.[col] != null
                    && nextGroups[r]?.[col + 1] != null
                    && nextGroups[r][col] !== nextGroups[r][col + 1];
                if (boundary) {
                    expanded.push(CELL.AISLE);
                    expandedGroups.push(null);
                }
            }
            nextGroups[r] = expandedGroups;
            return expanded;
        });
    }
    if (horizontal && nextCells.length > 1) {
        const expandedCells = [];
        const expandedGroups = [];
        for (let row = 0; row < nextCells.length; row++) {
            expandedCells.push(nextCells[row]);
            expandedGroups.push(nextGroups[row]);
            if (row < nextCells.length - 1
                && nextCells[row].some(cell => cell === CELL.SEAT)
                && nextCells[row + 1].some(cell => cell === CELL.SEAT)) {
                expandedCells.push(Array(nextCells[row].length).fill(CELL.AISLE));
                expandedGroups.push(Array(nextCells[row].length).fill(null));
            }
        }
        nextCells = expandedCells;
        nextGroups = expandedGroups;
    }
    const width = Math.max(0, ...nextCells.map(row => row.length));
    if (width > 0) {
        nextCells = nextCells.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill(CELL.EMPTY)]);
        nextGroups = nextGroups.map(row => [...row, ...Array(Math.max(0, width - row.length)).fill(null)]);
    }
    return { cells: nextCells, groups: nextGroups };
}

function buildPhysicalGridLayout({
    target,
    seatRows,
    seatCols,
    groupSize,
    verticalAisles,
    horizontalAisles,
    mainVerticalAisle = false,
    mainHorizontalAisle = false,
    spec,
}) {
    const cells = [];
    const groups = [];
    let groupId = 1;
    const groupsPerRow = Math.max(1, Math.ceil(seatCols / Math.max(1, groupSize)));
    const preserveFixedGrid = spec.capacityPolicy === 'fixed' && spec.physicalRows > 0;
    for (let row = 0; row < seatRows; row++) {
        const remainingSeats = Math.max(0, target - row * seatCols);
        const activeSeats = preserveFixedGrid ? seatCols : Math.min(seatCols, remainingSeats);
        const seatRow = [];
        const groupRow = [];
        for (let col = 0; col < seatCols; col++) {
            const groupOffset = Math.floor(col / Math.max(1, groupSize));
            if (col < activeSeats) {
                seatRow.push(CELL.SEAT);
                groupRow.push(groupId + groupOffset);
            } else {
                seatRow.push(CELL.EMPTY);
                groupRow.push(null);
            }
        }
        cells.push(seatRow);
        groups.push(groupRow);
        groupId += Math.ceil(activeSeats / Math.max(1, groupSize));
    }
    const verticalAfterCol = Math.min(
        Math.max(1, seatCols - 1),
        Math.ceil(groupsPerRow / 2) * Math.max(1, groupSize)
    );
    addMainAisles(cells, groups, {
        vertical: mainVerticalAisle,
        horizontal: mainHorizontalAisle,
        verticalAfterCol,
    });
    const circulation = spec.circulation || {};
    const expanded = expandClassroomWalkways(cells, groups, {
        vertical: circulation.betweenGroups === 'walkway',
        horizontal: circulation.betweenRows === 'walkway',
    });
    cells.splice(0, cells.length, ...expanded.cells);
    groups.splice(0, groups.length, ...expanded.groups);
    return {
        rows: cells.length,
        cols: cells[0]?.length || 0,
        cells,
        groups,
        guardians: { enabled: Boolean(spec.guardianPolicy.enabled), left: null, right: null },
        template: 'ai-local',
        groupSize,
        localAisles: localAislesFromGroups(cells, groups, {
            vertical: circulation.betweenGroups === 'gap',
            horizontal: circulation.betweenRows === 'gap',
        }),
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
    const circulation = spec.circulation || {};
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
    }
    addMainAisles(cells, groups, {
        horizontal: Boolean(spec.aislePolicy?.mainHorizontal),
    });
    const expanded = expandClassroomWalkways(cells, groups, {
        vertical: circulation.betweenGroups === 'walkway',
        horizontal: circulation.betweenRows === 'walkway',
    });
    cells.splice(0, cells.length, ...expanded.cells);
    groups.splice(0, groups.length, ...expanded.groups);
    return {
        rows: cells.length,
        cols: cells[0]?.length || 0,
        cells,
        groups,
        guardians: { enabled: Boolean(spec.guardianPolicy.enabled), left: null, right: null },
        template: 'ai-local-mixed',
        groupSize: Math.max(1, spec.groupSize || 1),
        localAisles: localAislesFromGroups(cells, groups, {
            vertical: circulation.betweenGroups === 'gap',
            horizontal: circulation.betweenRows === 'gap',
        }),
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
    const mainVerticalAisle = Boolean(spec.aislePolicy.mainVertical);
    const mainHorizontalAisle = Boolean(spec.aislePolicy.mainHorizontal);
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
            mainVerticalAisle,
            mainHorizontalAisle,
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
            mainVerticalAisle,
            mainHorizontalAisle,
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
    const cells = [];
    const groups = [];
    const preserveFixedGrid = capacityPolicy === 'fixed' && requestedPhysicalRows > 0;

    for (let logicalRow = 0; logicalRow < logicalRows; logicalRow++) {
        const seatRow = [];
        const groupRow = [];
        const remainingGroups = Math.max(0, groupCount - logicalRow * groupsPerRow);
        const activeGroups = preserveFixedGrid ? groupsPerRow : Math.min(groupsPerRow, remainingGroups);
        for (let groupCol = 0; groupCol < groupsPerRow; groupCol++) {
            const groupId = logicalRow * groupsPerRow + groupCol + 1;
            for (let offset = 0; offset < groupSize; offset++) {
                seatRow.push(groupCol < activeGroups ? CELL.SEAT : CELL.EMPTY);
                groupRow.push(groupCol < activeGroups ? groupId : null);
            }
        }
        cells.push(seatRow);
        groups.push(groupRow);
    }
    addMainAisles(cells, groups, {
        vertical: mainVerticalAisle,
        horizontal: mainHorizontalAisle,
        verticalAfterCol: Math.ceil(groupsPerRow / 2) * groupSize,
    });
    const circulation = spec.circulation || {};
    const expanded = expandClassroomWalkways(cells, groups, {
        vertical: circulation.betweenGroups === 'walkway',
        horizontal: circulation.betweenRows === 'walkway',
    });
    cells.splice(0, cells.length, ...expanded.cells);
    groups.splice(0, groups.length, ...expanded.groups);

    return {
        rows: cells.length,
        cols: cells[0]?.length || 0,
        cells,
        groups,
        guardians: { enabled: Boolean(spec.guardianPolicy.enabled), left: null, right: null },
        template: 'ai-local',
        groupSize,
        localAisles: localAislesFromGroups(cells, groups, {
            vertical: circulation.betweenGroups === 'gap',
            horizontal: circulation.betweenRows === 'gap',
        }),
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

function buildLayoutInterpretation({ request, spec, layout }) {
    const usableRows = layout.cells.filter(row => row.some(cell => cell === CELL.SEAT)).length;
    const groupIds = new Set(layout.groups.flat().filter(groupId => groupId != null));
    const groupsPerRenderedRow = layout.groups.reduce((max, row) => {
        const count = new Set(row.filter(groupId => groupId != null)).size;
        return Math.max(max, count);
    }, 0);
    const logicalGroupRows = usableRows;
    const regularStudentTarget = Math.max(
        0,
        request.students.length - (spec.guardianPolicy?.enabled ? Math.min(2, request.students.length) : 0)
    );
    const regularSeatCount = gridSeatCount(layout);
    const emptySeatCount = Math.max(0, regularSeatCount - regularStudentTarget);
    const parts = [];
    const mixedColumnPattern = Array.isArray(spec.columnPattern) && spec.columnPattern.length > 0;
    const betweenGroupsLabel = spec.circulation?.betweenGroups === 'walkway'
        ? '设置可通行过道'
        : spec.circulation?.betweenGroups === 'gap'
            ? '留普通间距'
            : '不留间距';
    if (mixedColumnPattern) {
        parts.push(`已理解为：${spec.notes || '两边1人组，中间2人组，组间过道'}`);
    } else if ((spec.groupSize || 1) > 1 && spec.groupsPerRow > 0) {
        parts.push(`已理解为：${spec.groupSize === 2 ? '两人' : `${spec.groupSize}人`}一组，每行 ${spec.groupsPerRow} 组，组间${betweenGroupsLabel}`);
    } else if (spec.physicalCols > 0) {
        parts.push(`已理解为：${spec.physicalRows > 0 ? `${spec.physicalRows} 行 × ` : ''}${spec.physicalCols} 个物理座位列`);
    } else if ((spec.groupSize || 1) > 1) {
        parts.push(`已理解为：${spec.groupSize}人一组，组间${betweenGroupsLabel}`);
    } else {
        parts.push('已理解为：普通座位布局');
    }
    if (mixedColumnPattern) {
        parts.push(`布局：${usableRows} 排 × 混合列模式，可用 ${regularSeatCount} 个座位`);
    } else if ((spec.groupSize || 1) > 1) {
        parts.push(`布局：${logicalGroupRows} 排 × ${groupsPerRenderedRow} 组，合计 ${groupIds.size} 组、${regularSeatCount} 个座位${emptySeatCount ? `、${emptySeatCount} 个空位` : ''}`);
    } else {
        parts.push(`布局：${logicalGroupRows} 排 × ${spec.physicalCols || layout.cols} 列，可用 ${regularSeatCount} 个座位`);
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
            usableRows,
            groupCount: groupIds.size,
            groupsPerRenderedRow,
            regularSeatCount,
            emptySeatCount,
            groupGap: spec.groupGap || 'none',
            circulation: spec.circulation || { betweenGroups: 'none', betweenRows: 'none', mainAisle: 'none' },
            oddStudentPolicy: spec.oddStudentPolicy || 'partial_group',
            verticalBetweenGroups: Boolean(spec.aislePolicy?.verticalBetweenGroups),
            horizontalBetweenGroupRows: Boolean(spec.aislePolicy?.horizontalBetweenGroupRows),
            mainVerticalAisle: Boolean(spec.aislePolicy?.mainVertical),
            mainHorizontalAisle: Boolean(spec.aislePolicy?.mainHorizontal),
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

export {
    applyAiLayoutMatrix,
    CELL,
    solveWithTimefold,
    TimefoldUnavailableError,
    evaluateSeatingConstraints,
    evaluateSeatingQuality,
    normalizeLocalAisles,
    MAX_ROWS,
    MAX_COLS,
    TOP_GRADE_PERCENT,
    asText,
    parseAiJson,
    isAiJsonParseError,
    shouldAllowUnassigned,
    boolValue,
    numberValue,
    cellValue,
    ensureStudents,
    normalizeLayout,
    normalizeStudentRef,
    normalizeAssignments,
    normalizeUnassigned,
    normalizeWarnings,
    studentLabel,
    seatCapacity,
    gridSeatCount,
    availableSeats,
    normalizeGuardians,
    validateGuardians,
    validateBatchAssignments,
    chineseNumberValue,
    positiveInt,
    NATURAL_NUMBER_PATTERN,
    naturalNumberFromMatch,
    firstNaturalNumber,
    extractGroupSize,
    hasGroupColumnWording,
    extractColumnCount,
    extractGridDimensions,
    extractRowCount,
    inferColumnPattern,
    normalizeColumnPattern,
    normalizeCapacityPolicy,
    inferCapacityPolicy,
    inferArrangementSpecFromPrompt,
    normalizeAislePolicy,
    normalizeGuardianPolicy,
    normalizeGuardianStrategy,
    normalizeGuardianGender,
    normalizeGuardianSlots,
    hasExplicitGuardianRequirement,
    normalizeGradeStrategy,
    normalizeUiPlacementPolicy,
    definedPlacementPolicy,
    inferPlacementOverridesFromPrompt,
    hasAnyOwn,
    valueConflict,
    specConflictWarnings,
    desiredGroupsPerRow,
    resolveSeatRows,
    columnPatternSeatCount,
    buildSeatRowFromRuns,
    buildPhysicalGridLayout,
    buildColumnPatternLayout,
    buildExpandableClassroomLayout,
    studentGradeValue,
    rankedStudentsByGradeDesc,
    getTopGradeStudentIds,
    getLowGradeStudentIds,
    protectExcellentStudentsFromLastRow,
    layoutSeatList,
    calculateSeatScoreMap,
    seatQuality,
    sortSeatsByQuality,
    normalizeStudentRefKey,
    buildNormalizedStudentMap,
    resolveConstraintStudentId,
    interleaveGender,
    applyGradeStrategy,
    sortStudentsForPlacement,
    placeTopGradeStudentsInBestSeats,
    areAdjacent,
    areAdjacentSeats,
    areNearAssignments,
    assignmentsToLayout,
    constraintEvaluationForAssignments,
    betterConstraintEvaluation,
    betterScoreEvaluation,
    cloneAssignments,
    assignmentSeatKey,
    buildLayoutInterpretation,
    buildSolverFacts,
};
