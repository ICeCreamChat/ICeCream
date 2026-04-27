const AISLE = '_aisle_';

function cloneLayout(layout, rows = layout?.length || 0, cols = 0) {
    return Array.from({ length: rows }, (_, r) => {
        const source = Array.isArray(layout?.[r]) ? layout[r] : [];
        const width = cols || source.length;
        return Array.from({ length: width }, (_, c) => source[c] ?? null);
    });
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function stripCommandNoise(value) {
    return normalizeText(value)
        .replace(/^把/, '')
        .replace(/[，。,.!?！？\s]/g, '');
}

function buildStudentLookup(students = []) {
    const byId = new Map();
    const byName = new Map();
    for (const student of students) {
        if (!student?.id) continue;
        byId.set(student.id, student);
        const name = normalizeText(student.name);
        if (name && !byName.has(name)) byName.set(name, student);
    }
    return { byId, byName };
}

export function resolveStudentId(value, students = []) {
    const raw = normalizeText(value);
    if (!raw) return null;
    const { byId, byName } = buildStudentLookup(students);
    if (byId.has(raw)) return raw;
    if (byName.has(raw)) return byName.get(raw).id;
    return null;
}

function findMentionedStudent(message, students = []) {
    const text = stripCommandNoise(message);
    const sorted = [...students]
        .filter(s => s?.id && s?.name)
        .sort((a, b) => b.name.length - a.name.length);
    return sorted.find(student => text.includes(stripCommandNoise(student.name))) || null;
}

function mentionedStudents(message, students = []) {
    const text = stripCommandNoise(message);
    return [...students]
        .filter(s => s?.id && s?.name && text.includes(stripCommandNoise(s.name)))
        .sort((a, b) => text.indexOf(stripCommandNoise(a.name)) - text.indexOf(stripCommandNoise(b.name)));
}

function cnNumber(value) {
    const text = normalizeText(value);
    if (/^\d+$/.test(text)) return Number(text);
    const map = new Map([
        ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
        ['六', 6], ['七', 7], ['八', 8], ['九', 9], ['十', 10],
    ]);
    if (map.has(text)) return map.get(text);
    if (text.startsWith('十') && text.length === 2 && map.has(text[1])) return 10 + map.get(text[1]);
    if (text.endsWith('十') && text.length === 2 && map.has(text[0])) return map.get(text[0]) * 10;
    if (text.includes('十')) {
        const [tens, ones] = text.split('十');
        if (map.has(tens) && map.has(ones)) return map.get(tens) * 10 + map.get(ones);
    }
    return Number.NaN;
}

export function detectSeatingMutationIntent(message = '') {
    return /(换|交换|调换|互换|移到|移动到|挪到|调到|安排到|坐到|往前|往后|往左|往右|向前|向后|向左|向右|前排|后排|分开|靠近|同桌)/.test(message);
}

function resolveOperationStudent(op, students, keys) {
    for (const key of keys) {
        if (op[key] != null) {
            const resolved = resolveStudentId(op[key], students);
            if (resolved) return resolved;
        }
    }
    return null;
}

function isAisle(row, col, layout, rowAisles = [], colAisles = [], blockedCells = new Set()) {
    return rowAisles.includes(row) || colAisles.includes(col) || blockedCells.has(`${row},${col}`) || layout?.[row]?.[col] === AISLE;
}

export function findStudentPosition(layout = [], studentId) {
    for (let r = 0; r < layout.length; r++) {
        for (let c = 0; c < (layout[r]?.length || 0); c++) {
            if (layout[r][c] === studentId) return { r, c };
        }
    }
    return null;
}

export function getSeatingCapacity({ rows, cols, rowAisles = [], colAisles = [] }) {
    let count = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!rowAisles.includes(r) && !colAisles.includes(c)) count++;
        }
    }
    return count;
}

export function getPlacedStudentIds(layout = [], { rows = layout.length, cols, rowAisles = [], colAisles = [] } = {}) {
    const ids = [];
    for (let r = 0; r < Math.min(rows, layout.length); r++) {
        const width = cols ?? layout[r]?.length ?? 0;
        for (let c = 0; c < Math.min(width, layout[r]?.length ?? 0); c++) {
            const value = layout[r]?.[c];
            if (value && value !== AISLE && !isAisle(r, c, layout, rowAisles, colAisles)) ids.push(value);
        }
    }
    return ids;
}

export function validateLayoutIntegrity({ layout = [], students = [] }) {
    const knownIds = new Set(students.map(s => s.id).filter(Boolean));
    const seen = new Set();
    const duplicates = new Set();
    const unknownIds = new Set();

    for (const row of layout) {
        for (const value of row || []) {
            if (!value || value === AISLE) continue;
            if (seen.has(value)) duplicates.add(value);
            seen.add(value);
            if (!knownIds.has(value)) unknownIds.add(value);
        }
    }

    const missingPlacedIds = [...knownIds].filter(id => !seen.has(id));
    return {
        ok: duplicates.size === 0 && unknownIds.size === 0 && missingPlacedIds.length === 0,
        duplicates: [...duplicates],
        unknownIds: [...unknownIds],
        missingPlacedIds,
    };
}

function isInBounds(row, col, rows, cols) {
    return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < rows && col < cols;
}

function reject(index, op, reason) {
    return { index, operation: op, reason };
}

export function applySeatingOperations({
    layout = [],
    students = [],
    operations = [],
    rows = layout.length,
    cols = layout[0]?.length || 0,
    rowAisles = [],
    colAisles = [],
    blockedCells = [],
}) {
    const nextLayout = cloneLayout(layout, rows, cols);
    const blockedSet = new Set(blockedCells.map(cell => Array.isArray(cell) ? `${cell[0]},${cell[1]}` : `${cell.r},${cell.c}`));
    const applied = [];
    const rejected = [];
    const affectedCells = [];

    operations.forEach((op, index) => {
        if (!op || typeof op !== 'object') {
            rejected.push(reject(index, op, '操作格式无效'));
            return;
        }

        if (op.type === 'swap') {
            const id1 = resolveOperationStudent(op, students, ['student1Id', 'student1_id', 'id1', 'student1', 'from']);
            const id2 = resolveOperationStudent(op, students, ['student2Id', 'student2_id', 'id2', 'student2', 'to']);
            if (!id1 || !id2) {
                rejected.push(reject(index, op, '未找到要交换的学生'));
                return;
            }
            const pos1 = findStudentPosition(nextLayout, id1);
            const pos2 = findStudentPosition(nextLayout, id2);
            if (!pos1 || !pos2) {
                rejected.push(reject(index, op, '学生当前不在座位表中'));
                return;
            }
            nextLayout[pos1.r][pos1.c] = id2;
            nextLayout[pos2.r][pos2.c] = id1;
            applied.push({ index, operation: op, type: 'swap', affectedCells: [pos1, pos2] });
            affectedCells.push(pos1, pos2);
            return;
        }

        if (op.type === 'move') {
            const id = resolveOperationStudent(op, students, ['studentId', 'student_id', 'id', 'student', 'name']);
            if (!id) {
                rejected.push(reject(index, op, '未找到要移动的学生'));
                return;
            }
            const from = findStudentPosition(nextLayout, id);
            if (!from) {
                rejected.push(reject(index, op, '学生当前不在座位表中'));
                return;
            }
            const targetR = Number(op.row);
            const targetC = Number(op.col);
            if (!isInBounds(targetR, targetC, rows, cols)) {
                rejected.push(reject(index, op, '目标座位超出座位表范围'));
                return;
            }
            if (isAisle(targetR, targetC, nextLayout, rowAisles, colAisles, blockedSet)) {
                rejected.push(reject(index, op, '目标位置是过道，不能安排学生'));
                return;
            }
            if (from.r === targetR && from.c === targetC) {
                applied.push({ index, operation: op, type: 'noop', affectedCells: [from] });
                affectedCells.push(from);
                return;
            }

            const displaced = nextLayout[targetR][targetC] || null;
            nextLayout[targetR][targetC] = id;
            nextLayout[from.r][from.c] = displaced;
            const cells = [from, { r: targetR, c: targetC }];
            applied.push({ index, operation: op, type: 'move', affectedCells: cells });
            affectedCells.push(...cells);
            return;
        }

        rejected.push(reject(index, op, `不支持的操作类型: ${op.type || '未知'}`));
    });

    return {
        layout: nextLayout,
        applied,
        rejected,
        affectedCells,
        integrity: validateLayoutIntegrity({ layout: nextLayout, students }),
    };
}

export function parseFallbackSeatingOperations({
    message = '',
    layout = [],
    students = [],
    rows = layout.length,
    cols = layout[0]?.length || 0,
}) {
    const mutationIntent = detectSeatingMutationIntent(message);
    const operations = [];
    const rejected = [];
    if (!mutationIntent) return { mutationIntent, operations, rejected };

    const names = mentionedStudents(message, students);
    if (/(换|交换|调换|互换)/.test(message) && names.length >= 2) {
        return {
            mutationIntent,
            operations: [{ type: 'swap', student1Id: names[0].id, student2Id: names[1].id }],
            rejected,
        };
    }

    const student = findMentionedStudent(message, students);
    if (!student) {
        return {
            mutationIntent,
            operations,
            rejected: [{ reason: '无法确定学生，请说出学生姓名' }],
        };
    }

    const coordinateMatch = message.match(/第?([0-9一二两三四五六七八九十]+)\s*[排行]\s*第?([0-9一二两三四五六七八九十]+)\s*[列]/);
    if (coordinateMatch && /(移到|移动到|挪到|调到|安排到|坐到|放到)/.test(message)) {
        const row = cnNumber(coordinateMatch[1]) - 1;
        const col = cnNumber(coordinateMatch[2]) - 1;
        if (Number.isInteger(row) && Number.isInteger(col)) {
            return {
                mutationIntent,
                operations: [{ type: 'move', studentId: student.id, row, col }],
                rejected,
            };
        }
    }

    const pos = findStudentPosition(layout, student.id);
    if (!pos) {
        return {
            mutationIntent,
            operations,
            rejected: [{ reason: `${student.name} 当前不在座位表中` }],
        };
    }

    let target = null;
    if (/(往前|向前|前面|前排)/.test(message)) target = { r: pos.r - 1, c: pos.c };
    if (/(往后|向后|后面|后排)/.test(message)) target = { r: pos.r + 1, c: pos.c };
    if (/(往左|向左|左边)/.test(message)) target = { r: pos.r, c: pos.c - 1 };
    if (/(往右|向右|右边)/.test(message)) target = { r: pos.r, c: pos.c + 1 };

    if (target) {
        return {
            mutationIntent,
            operations: [{ type: 'move', studentId: student.id, row: target.r, col: target.c }],
            rejected,
        };
    }

    return {
        mutationIntent,
        operations,
        rejected: [{ reason: '识别到座位调整意图，但没有确定目标座位' }],
    };
}

function usableRows(rows, rowAisles = []) {
    const result = [];
    for (let r = 0; r < rows; r++) {
        if (!rowAisles.includes(r)) result.push(r);
    }
    return result;
}

function adjacent(pos1, pos2) {
    if (!pos1 || !pos2) return false;
    return Math.abs(pos1.r - pos2.r) + Math.abs(pos1.c - pos2.c) === 1;
}

function makeUnsatisfied(constraint, reason) {
    return {
        ...constraint,
        reason: constraint.reason || reason,
        priority: constraint.priority || 'hard',
    };
}

export function evaluateSeatingConstraints({
    layout = [],
    students = [],
    constraints = [],
    rows = layout.length,
    cols = layout[0]?.length || 0,
    rowAisles = [],
}) {
    const rowsInUse = usableRows(rows, rowAisles);
    const frontCount = Math.max(1, Math.ceil(rowsInUse.length / 3));
    const frontRows = new Set(rowsInUse.slice(0, frontCount));
    const backRows = new Set(rowsInUse.slice(rowsInUse.length - frontCount));
    const unsatisfied = [];

    for (const constraint of constraints || []) {
        const targetId = resolveStudentId(constraint.target, students);
        const relatedId = resolveStudentId(constraint.related, students);
        const targetPos = targetId ? findStudentPosition(layout, targetId) : null;
        const relatedPos = relatedId ? findStudentPosition(layout, relatedId) : null;

        if (!targetId || !targetPos) {
            unsatisfied.push(makeUnsatisfied(constraint, '未找到学生座位'));
            continue;
        }

        if (constraint.type === 'front_row' && !frontRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '未坐在前排区域'));
        } else if (constraint.type === 'back_row' && !backRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '未坐在后排区域'));
        } else if (constraint.type === 'avoid' && relatedId && adjacent(targetPos, relatedPos)) {
            unsatisfied.push(makeUnsatisfied(constraint, '两人仍然相邻'));
        } else if (constraint.type === 'pair' && (!relatedId || !adjacent(targetPos, relatedPos))) {
            unsatisfied.push(makeUnsatisfied(constraint, '两人没有相邻'));
        } else if (constraint.type === 'prefer' && (!relatedId || !adjacent(targetPos, relatedPos))) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '偏好未满足'));
        }
    }

    const hardUnsatisfied = unsatisfied.filter(c => c.priority !== 'soft');
    const softUnsatisfied = unsatisfied.filter(c => c.priority === 'soft');
    return {
        total: constraints?.length || 0,
        satisfied: (constraints?.length || 0) - unsatisfied.length,
        unsatisfied,
        hardUnsatisfied,
        softUnsatisfied,
    };
}

export function rowHasStudents(layout = [], row) {
    return (layout[row] || []).some(value => value && value !== AISLE);
}

export function colHasStudents(layout = [], col) {
    return layout.some(row => {
        const value = row?.[col];
        return value && value !== AISLE;
    });
}

export function resizeWouldHideStudents(layout = [], rows, cols) {
    const hidden = [];
    for (let r = 0; r < layout.length; r++) {
        for (let c = 0; c < (layout[r]?.length || 0); c++) {
            const value = layout[r][c];
            if (value && value !== AISLE && (r >= rows || c >= cols)) {
                hidden.push({ id: value, r, c });
            }
        }
    }
    return hidden;
}

export { AISLE };
