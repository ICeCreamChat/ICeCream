export const CELL = Object.freeze({
    SEAT: 'seat',
    AISLE: 'aisle',
    EMPTY: 'empty',
});

const TEMPLATES = new Set([
    'standard',
    'pairs',
    'triples',
    'single',
    'center-aisle',
    'horizontal-aisle',
    'islands',
    'custom',
]);

const MAX_LAYOUT_DIMENSION = Number.MAX_SAFE_INTEGER;

function clampInt(value, fallback, min, max) {
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

function blankCells(rows, cols, value = CELL.SEAT) {
    return Array.from({ length: rows }, () => Array(cols).fill(value));
}

function emptyGroups(rows, cols) {
    return Array.from({ length: rows }, () => Array(cols).fill(null));
}

function normalizeTemplate(template = 'standard') {
    return TEMPLATES.has(template) ? template : 'standard';
}

function seatRuns(cells) {
    const runs = [];
    for (let r = 0; r < cells.length; r++) {
        let current = [];
        for (let c = 0; c < cells[r].length; c++) {
            if (cells[r][c] === CELL.SEAT) {
                current.push({ r, c });
            } else if (current.length) {
                runs.push(current);
                current = [];
            }
        }
        if (current.length) runs.push(current);
    }
    return runs;
}

function assignLinearGroups(cells, groupSize) {
    const groups = emptyGroups(cells.length, cells[0]?.length || 0);
    let groupId = 1;
    for (const run of seatRuns(cells)) {
        for (let i = 0; i < run.length; i += groupSize) {
            const chunk = run.slice(i, i + groupSize);
            for (const { r, c } of chunk) groups[r][c] = groupId;
            groupId++;
        }
    }
    return groups;
}

function assignIslandGroups(cells) {
    const rows = cells.length;
    const cols = cells[0]?.length || 0;
    const groups = emptyGroups(rows, cols);
    let groupId = 1;
    for (let r = 0; r < rows; r += 3) {
        for (let c = 0; c < cols; c += 3) {
            const seats = [];
            for (let rr = r; rr < Math.min(r + 2, rows); rr++) {
                for (let cc = c; cc < Math.min(c + 2, cols); cc++) {
                    if (cells[rr][cc] === CELL.SEAT) seats.push({ r: rr, c: cc });
                }
            }
            if (seats.length) {
                for (const seat of seats) groups[seat.r][seat.c] = groupId;
                groupId++;
            }
        }
    }
    return groups;
}

function makeGroups(cells, template, groupSize) {
    if (template === 'islands') return assignIslandGroups(cells);
    return assignLinearGroups(cells, groupSize);
}

function applyTemplateCells({ rows, cols, template }) {
    const cells = blankCells(rows, cols, CELL.SEAT);
    if (template === 'center-aisle' && cols >= 3) {
        const aisle = Math.floor(cols / 2);
        for (let r = 0; r < rows; r++) cells[r][aisle] = CELL.AISLE;
    }
    if (template === 'horizontal-aisle' && rows >= 3) {
        const aisle = Math.floor(rows / 2);
        for (let c = 0; c < cols; c++) cells[aisle][c] = CELL.AISLE;
    }
    if (template === 'islands') {
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (r % 3 === 2 || c % 3 === 2) cells[r][c] = CELL.AISLE;
            }
        }
    }
    return cells;
}

function defaultGroupSize(template, groupSize) {
    if (groupSize) return clampInt(groupSize, 1, 1, 8);
    if (template === 'pairs') return 2;
    if (template === 'triples') return 3;
    if (template === 'islands') return 4;
    return 1;
}

export function createClassroomLayout({
    rows = 6,
    cols = 8,
    template = 'standard',
    groupSize,
    guardiansEnabled = false,
    guardians = {},
} = {}) {
    const safeRows = clampInt(rows, 6, 1, MAX_LAYOUT_DIMENSION);
    const safeCols = clampInt(cols, 8, 1, MAX_LAYOUT_DIMENSION);
    const safeTemplate = normalizeTemplate(template);
    const resolvedGroupSize = defaultGroupSize(safeTemplate, groupSize);
    const cells = applyTemplateCells({ rows: safeRows, cols: safeCols, template: safeTemplate });
    return {
        rows: safeRows,
        cols: safeCols,
        cells,
        groups: makeGroups(cells, safeTemplate, resolvedGroupSize),
        guardians: {
            enabled: Boolean(guardiansEnabled),
            left: guardians.left ?? null,
            right: guardians.right ?? null,
        },
        template: safeTemplate,
        groupSize: resolvedGroupSize,
    };
}

export function applyAiLayoutMatrix({
    rows,
    cols,
    matrix,
    groupSize = 1,
    guardiansEnabled = false,
    guardians = {},
}) {
    const safeRows = clampInt(rows, 6, 1, MAX_LAYOUT_DIMENSION);
    const safeCols = clampInt(cols, 8, 1, MAX_LAYOUT_DIMENSION);
    if (!Array.isArray(matrix) || matrix.length !== safeRows) {
        throw new Error('AI 布局矩阵尺寸不匹配');
    }
    const cells = matrix.map((row, r) => {
        if (!Array.isArray(row) || row.length !== safeCols) {
            throw new Error('AI 布局矩阵尺寸不匹配');
        }
        return row.map((value, c) => {
            if (value === 1 || value === true || value === '1' || value === CELL.SEAT) return CELL.SEAT;
            if (value === 0 || value === false || value === '0' || value === CELL.AISLE || value === CELL.EMPTY) return CELL.AISLE;
            throw new Error(`AI 布局矩阵只能包含 1/0，错误位置: ${r + 1}行${c + 1}列`);
        });
    });
    const resolvedGroupSize = clampInt(groupSize, 1, 1, 8);
    return {
        rows: safeRows,
        cols: safeCols,
        cells,
        groups: makeGroups(cells, 'custom', resolvedGroupSize),
        guardians: {
            enabled: Boolean(guardiansEnabled),
            left: guardians.left ?? null,
            right: guardians.right ?? null,
        },
        template: 'custom',
        groupSize: resolvedGroupSize,
    };
}

export function getLayoutCapacity(layout) {
    const seatCount = (layout?.cells || [])
        .flat()
        .filter(cell => cell === CELL.SEAT)
        .length;
    return seatCount + (layout?.guardians?.enabled ? 2 : 0);
}

export function getLayoutGroups(layout) {
    const groups = new Map();
    for (let r = 0; r < (layout?.groups?.length || 0); r++) {
        for (let c = 0; c < (layout.groups[r]?.length || 0); c++) {
            const groupId = layout.groups[r][c];
            if (!groupId || layout.cells?.[r]?.[c] !== CELL.SEAT) continue;
            if (!groups.has(groupId)) groups.set(groupId, { id: groupId, seats: [] });
            groups.get(groupId).seats.push({ r, c });
        }
    }
    return [...groups.values()].sort((a, b) => a.id - b.id);
}

export function layoutToLegacyAisles(layout) {
    const rowAisles = [];
    const colAisles = [];
    const rows = layout?.rows || 0;
    const cols = layout?.cols || 0;
    for (let r = 0; r < rows; r++) {
        if ((layout.cells?.[r] || []).every(cell => cell !== CELL.SEAT)) rowAisles.push(r);
    }
    for (let c = 0; c < cols; c++) {
        let allAisle = true;
        for (let r = 0; r < rows; r++) {
            if (layout.cells?.[r]?.[c] === CELL.SEAT) {
                allAisle = false;
                break;
            }
        }
        if (allAisle) colAisles.push(c);
    }
    return { rowAisles, colAisles };
}

export function isLayoutSeat(layout, r, c) {
    if (!layout?.cells) return true;
    return layout.cells?.[r]?.[c] === CELL.SEAT;
}

export function layoutMatrix(layout) {
    return (layout?.cells || []).map(row => row.map(cell => cell === CELL.SEAT ? 1 : 0));
}

export function parseClassroomLayoutPrompt(prompt = '') {
    const text = String(prompt || '');
    let template = 'standard';
    let groupSize;
    let guardiansEnabled = /护法|讲台旁|左右/.test(text)
        && !(/(不要|关闭|取消).*护法|护法.*(不要|关闭|取消|关)/.test(text));

    if (/三人|3人|三个/.test(text)) {
        template = 'triples';
        groupSize = 3;
    } else if (/两人|二人|2人|同桌|双人/.test(text)) {
        template = 'pairs';
        groupSize = 2;
    } else if (/单人|单座|考试/.test(text)) {
        template = 'single';
        groupSize = 1;
    } else if (/小组|岛|围坐/.test(text)) {
        template = 'islands';
        groupSize = 4;
    }

    if (/(中间|中央).*过道|(中间|中央).*(竖|纵|列)|竖过道|纵向过道/.test(text)) template = 'center-aisle';
    if (/横过道|横向过道|行过道/.test(text)) template = 'horizontal-aisle';
    if (template === 'center-aisle' && /三人|3人|三个/.test(text)) groupSize = 3;
    if (template === 'center-aisle' && /两人|二人|2人|同桌|双人/.test(text)) groupSize = 2;
    if (template === 'horizontal-aisle' && /三人|3人|三个/.test(text)) groupSize = 3;
    if (template === 'horizontal-aisle' && /两人|二人|2人|同桌|双人/.test(text)) groupSize = 2;
    if (template === 'horizontal-aisle' && /单人|单座|考试/.test(text)) groupSize = 1;

    return { template, groupSize: groupSize || defaultGroupSize(template), guardiansEnabled };
}
