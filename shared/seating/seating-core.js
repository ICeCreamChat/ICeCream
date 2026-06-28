const AISLE = '_aisle_';

function cloneLayout(layout, rows = layout?.length || 0, cols = 0) {
    return Array.from({ length: rows }, (_, r) => {
        const source = Array.isArray(layout?.[r]) ? layout[r] : [];
        const width = cols || source.length;
        return Array.from({ length: width }, (_, c) => source[c] ?? null);
    });
}

function clonePlain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeLayoutRows(layout = [], rows = layout?.length || 0, cols = layout?.[0]?.length || 0) {
    return Array.from({ length: rows }, (_, r) => {
        const row = Array.isArray(layout[r]) ? layout[r] : [];
        return Array.from({ length: cols }, (_, c) => row[c] ?? null);
    });
}

function normalizeCells(classroomLayout = {}, rows, cols) {
    return Array.from({ length: rows }, (_, r) => {
        const row = Array.isArray(classroomLayout.cells?.[r]) ? classroomLayout.cells[r] : [];
        return Array.from({ length: cols }, (_, c) => (
            row[c] === 'aisle' || row[c] === 'empty' ? 'aisle' : 'seat'
        ));
    });
}

function localAisleBounds(orientation, rows, cols) {
    return orientation === 'vertical'
        ? { maxRow: rows - 1, maxCol: cols - 2 }
        : { maxRow: rows - 2, maxCol: cols - 1 };
}

function normalizeLocalAisleList(items = [], orientation, rows, cols) {
    const { maxRow, maxCol } = localAisleBounds(orientation, rows, cols);
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(items) ? items : []) {
        const row = Number.parseInt(item?.row, 10);
        const col = Number.parseInt(item?.col, 10);
        if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
        if (row < 0 || col < 0 || row > maxRow || col > maxCol) continue;
        const key = `${row},${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ row, col });
    }
    return result.sort((a, b) => a.row - b.row || a.col - b.col);
}

export function normalizeLocalAisles(localAisles = {}, rows = 0, cols = 0) {
    const safeRows = Math.max(0, Number.parseInt(rows, 10) || 0);
    const safeCols = Math.max(0, Number.parseInt(cols, 10) || 0);
    return {
        vertical: normalizeLocalAisleList(localAisles?.vertical, 'vertical', safeRows, safeCols),
        horizontal: normalizeLocalAisleList(localAisles?.horizontal, 'horizontal', safeRows, safeCols),
    };
}

function remapLocalAisles(localAisles, rows, cols, nextRows, nextCols, mapper) {
    const normalized = normalizeLocalAisles(localAisles, rows, cols);
    const mapped = {
        vertical: normalized.vertical.map(mapper.vertical).filter(Boolean),
        horizontal: normalized.horizontal.map(mapper.horizontal).filter(Boolean),
    };
    return normalizeLocalAisles(mapped, nextRows, nextCols);
}

function localAislesAfterRowInsert(localAisles, rows, cols, index) {
    return remapLocalAisles(localAisles, rows, cols, rows + 1, cols, {
        vertical: item => ({ ...item, row: item.row >= index ? item.row + 1 : item.row }),
        horizontal: item => {
            if (item.row === index - 1) return null;
            return { ...item, row: item.row >= index ? item.row + 1 : item.row };
        },
    });
}

function localAislesAfterColumnInsert(localAisles, rows, cols, index) {
    return remapLocalAisles(localAisles, rows, cols, rows, cols + 1, {
        vertical: item => {
            if (item.col === index - 1) return null;
            return { ...item, col: item.col >= index ? item.col + 1 : item.col };
        },
        horizontal: item => ({ ...item, col: item.col >= index ? item.col + 1 : item.col }),
    });
}

function localAislesAfterRowDelete(localAisles, rows, cols, index) {
    return remapLocalAisles(localAisles, rows, cols, rows - 1, cols, {
        vertical: item => {
            if (item.row === index) return null;
            return { ...item, row: item.row > index ? item.row - 1 : item.row };
        },
        horizontal: item => {
            if (item.row === index || item.row === index - 1) return null;
            return { ...item, row: item.row > index ? item.row - 1 : item.row };
        },
    });
}

function localAislesAfterColumnDelete(localAisles, rows, cols, index) {
    return remapLocalAisles(localAisles, rows, cols, rows, cols - 1, {
        vertical: item => {
            if (item.col === index || item.col === index - 1) return null;
            return { ...item, col: item.col > index ? item.col - 1 : item.col };
        },
        horizontal: item => {
            if (item.col === index) return null;
            return { ...item, col: item.col > index ? item.col - 1 : item.col };
        },
    });
}

export function hasLocalAisle(localAisles = {}, orientation, row, col) {
    const list = orientation === 'horizontal' ? localAisles?.horizontal : localAisles?.vertical;
    return Array.isArray(list) && list.some(item => item.row === row && item.col === col);
}

function assertLocalAislePosition(orientation, row, col, rows, cols) {
    if (!['vertical', 'horizontal'].includes(orientation)) {
        throw new Error('局部过道方向不合法');
    }
    const safeRow = Number.parseInt(row, 10);
    const safeCol = Number.parseInt(col, 10);
    const { maxRow, maxCol } = localAisleBounds(orientation, rows, cols);
    if (!Number.isInteger(safeRow) || !Number.isInteger(safeCol)
        || safeRow < 0 || safeCol < 0 || safeRow > maxRow || safeCol > maxCol) {
        throw new Error('局部过道只能插入在两个相邻座位之间');
    }
    return { row: safeRow, col: safeCol };
}

function withLocalAisle(classroomLayout = {}, orientation, row, col, present) {
    const rows = Math.max(0, Number.parseInt(classroomLayout?.rows, 10) || 0);
    const cols = Math.max(0, Number.parseInt(classroomLayout?.cols, 10) || 0);
    const position = assertLocalAislePosition(orientation, row, col, rows, cols);
    const next = clonePlain(classroomLayout || {}) || {};
    const localAisles = normalizeLocalAisles(next.localAisles, rows, cols);
    const list = orientation === 'horizontal' ? localAisles.horizontal : localAisles.vertical;
    const exists = list.some(item => item.row === position.row && item.col === position.col);
    if (present && !exists) list.push(position);
    if (!present && exists) {
        const index = list.findIndex(item => item.row === position.row && item.col === position.col);
        list.splice(index, 1);
    }
    next.localAisles = normalizeLocalAisles(localAisles, rows, cols);
    return next;
}

export function insertLocalAisle({ classroomLayout = {}, orientation, row, col }) {
    return withLocalAisle(classroomLayout, orientation, row, col, true);
}

export function deleteLocalAisle({ classroomLayout = {}, orientation, row, col }) {
    return withLocalAisle(classroomLayout, orientation, row, col, false);
}

function rebuildGroups(cells = [], groupSize = 1) {
    const safeGroupSize = Math.max(1, Number.parseInt(groupSize, 10) || 1);
    const groups = cells.map(row => row.map(() => null));
    let groupId = 1;
    for (let r = 0; r < cells.length; r++) {
        let run = [];
        const flushRun = () => {
            for (let i = 0; i < run.length; i += safeGroupSize) {
                for (const c of run.slice(i, i + safeGroupSize)) groups[r][c] = groupId;
                groupId++;
            }
            run = [];
        };
        for (let c = 0; c < (cells[r]?.length || 0); c++) {
            if (cells[r][c] === 'seat') {
                run.push(c);
            } else if (run.length) {
                flushRun();
            }
        }
        if (run.length) flushRun();
    }
    return groups;
}

function legacyAislesFromCells(cells = []) {
    const rows = cells.length;
    const cols = cells[0]?.length || 0;
    const rowAisles = [];
    const colAisles = [];
    for (let r = 0; r < rows; r++) {
        if ((cells[r] || []).every(cell => cell !== 'seat')) rowAisles.push(r);
    }
    for (let c = 0; c < cols; c++) {
        let allBlocked = true;
        for (let r = 0; r < rows; r++) {
            if (cells[r]?.[c] === 'seat') {
                allBlocked = false;
                break;
            }
        }
        if (allBlocked) colAisles.push(c);
    }
    return { rowAisles, colAisles };
}

function buildAisleEditResult({ layout, classroomLayout, cells, localAisles = classroomLayout?.localAisles }) {
    const rows = cells.length;
    const cols = cells[0]?.length || 0;
    const groupSize = classroomLayout?.groupSize || 1;
    const nextClassroomLayout = {
        ...clonePlain(classroomLayout || {}),
        rows,
        cols,
        cells,
        groups: rebuildGroups(cells, groupSize),
        localAisles: normalizeLocalAisles(localAisles, rows, cols),
        template: 'custom',
        groupSize,
        guardians: {
            enabled: Boolean(classroomLayout?.guardians?.enabled),
            left: classroomLayout?.guardians?.left ?? null,
            right: classroomLayout?.guardians?.right ?? null,
        },
    };
    return {
        layout,
        classroomLayout: nextClassroomLayout,
        rows,
        cols,
        ...legacyAislesFromCells(cells),
    };
}

function dimensionsForAisleEdit(layout = [], classroomLayout = {}) {
    const rows = Math.max(Number(classroomLayout?.rows) || 0, layout.length);
    const cols = Math.max(
        Number(classroomLayout?.cols) || 0,
        ...layout.map(row => Array.isArray(row) ? row.length : 0),
        1
    );
    return { rows, cols };
}

function assertInsertIndex(index, max, label) {
    if (!Number.isInteger(index) || index < 1 || index > max) {
        throw new Error(`${label}过道只能插入在两个座位区域之间`);
    }
}

function assertDeleteIndex(index, max, label) {
    if (!Number.isInteger(index) || index < 0 || index >= max) {
        throw new Error(`${label}过道位置不合法`);
    }
}

export function insertAisleRow({ layout = [], classroomLayout = {}, index }) {
    const { rows, cols } = dimensionsForAisleEdit(layout, classroomLayout);
    assertInsertIndex(index, rows, '横');
    const nextLayout = normalizeLayoutRows(layout, rows, cols);
    nextLayout.splice(index, 0, Array(cols).fill(null));
    const cells = normalizeCells(classroomLayout, rows, cols);
    cells.splice(index, 0, Array(cols).fill('aisle'));
    return buildAisleEditResult({
        layout: nextLayout,
        classroomLayout,
        cells,
        localAisles: localAislesAfterRowInsert(classroomLayout?.localAisles, rows, cols, index),
    });
}

export function insertAisleColumn({ layout = [], classroomLayout = {}, index }) {
    const { rows, cols } = dimensionsForAisleEdit(layout, classroomLayout);
    assertInsertIndex(index, cols, '竖');
    const nextLayout = normalizeLayoutRows(layout, rows, cols).map(row => {
        const nextRow = [...row];
        nextRow.splice(index, 0, null);
        return nextRow;
    });
    const cells = normalizeCells(classroomLayout, rows, cols).map(row => {
        const nextRow = [...row];
        nextRow.splice(index, 0, 'aisle');
        return nextRow;
    });
    return buildAisleEditResult({
        layout: nextLayout,
        classroomLayout,
        cells,
        localAisles: localAislesAfterColumnInsert(classroomLayout?.localAisles, rows, cols, index),
    });
}

export function deleteAisleRow({ layout = [], classroomLayout = {}, index }) {
    const { rows, cols } = dimensionsForAisleEdit(layout, classroomLayout);
    assertDeleteIndex(index, rows, '横');
    const cells = normalizeCells(classroomLayout, rows, cols);
    if (!cells[index]?.every(cell => cell !== 'seat')) throw new Error('只能删除整行过道');
    const nextLayout = normalizeLayoutRows(layout, rows, cols);
    nextLayout.splice(index, 1);
    cells.splice(index, 1);
    return buildAisleEditResult({
        layout: nextLayout,
        classroomLayout,
        cells,
        localAisles: localAislesAfterRowDelete(classroomLayout?.localAisles, rows, cols, index),
    });
}

export function deleteAisleColumn({ layout = [], classroomLayout = {}, index }) {
    const { rows, cols } = dimensionsForAisleEdit(layout, classroomLayout);
    assertDeleteIndex(index, cols, '竖');
    const cells = normalizeCells(classroomLayout, rows, cols);
    if (!cells.every(row => row?.[index] !== 'seat')) throw new Error('只能删除整列过道');
    const nextLayout = normalizeLayoutRows(layout, rows, cols).map(row => row.filter((_, c) => c !== index));
    const nextCells = cells.map(row => row.filter((_, c) => c !== index));
    return buildAisleEditResult({
        layout: nextLayout,
        classroomLayout,
        cells: nextCells,
        localAisles: localAislesAfterColumnDelete(classroomLayout?.localAisles, rows, cols, index),
    });
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeStudentLookupKey(value) {
    return normalizeText(value)
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .toLowerCase();
}

function stripCommandNoise(value) {
    return normalizeText(value)
        .replace(/^把/, '')
        .replace(/[，。,.!?！？\s]/g, '');
}

function buildStudentLookup(students = []) {
    const byId = new Map();
    const byName = new Map();
    const byNormalized = new Map();
    for (const student of students) {
        if (!student?.id) continue;
        byId.set(student.id, student);
        const normalizedId = normalizeStudentLookupKey(student.id);
        if (normalizedId && !byNormalized.has(normalizedId)) byNormalized.set(normalizedId, student);
        const name = normalizeText(student.name);
        if (name && !byName.has(name)) byName.set(name, student);
        const normalizedName = normalizeStudentLookupKey(name);
        if (normalizedName && !byNormalized.has(normalizedName)) byNormalized.set(normalizedName, student);
    }
    return { byId, byName, byNormalized };
}

export function resolveStudentId(value, students = []) {
    const raw = normalizeText(value);
    if (!raw) return null;
    const { byId, byName, byNormalized } = buildStudentLookup(students);
    if (byId.has(raw)) return raw;
    if (byName.has(raw)) return byName.get(raw).id;
    const normalized = normalizeStudentLookupKey(raw);
    if (normalized && byNormalized.has(normalized)) return byNormalized.get(normalized).id;
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
    return /(换|交换|调换|互换|移到|移动到|挪到|调到|安排到|坐到|往前|往后|往左|往右|向前|向后|向左|向右|前排|后排|分开|分散|靠近|同桌|护法)/.test(message);
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

function clearStudentFromLayout(layout = [], studentId) {
    if (!studentId) return;
    for (let r = 0; r < layout.length; r++) {
        for (let c = 0; c < (layout[r]?.length || 0); c++) {
            if (layout[r][c] === studentId) layout[r][c] = null;
        }
    }
}

function findGuardianPosition(guardians = [], studentId) {
    const index = guardians.findIndex(id => id === studentId);
    return index >= 0 ? { r: -1, c: index } : null;
}

function normalizeGuardianSide(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === 'left' || raw === '0' || raw === '左' || raw === '左护法') return 0;
    if (raw === 'right' || raw === '1' || raw === '右' || raw === '右护法') return 1;
    return -1;
}

function guardianSideLabel(index) {
    return index === 0 ? '左护法' : '右护法';
}

function normalizeStudentGender(value) {
    const raw = normalizeText(value).toLowerCase();
    if (raw === 'm' || raw === 'male' || raw === 'boy' || raw === '男' || raw === '男生') return 'M';
    if (raw === 'f' || raw === 'female' || raw === 'girl' || raw === '女' || raw === '女生') return 'F';
    return '';
}

function detectGuardianGradeBucket(text = '') {
    const value = normalizeText(text);
    if (/(最高|最好|最优秀|最高分|顶尖|第一名)/.test(value)) return 'highest';
    if (/(最低|最差|最弱|最低分|倒数第一)/.test(value)) return 'lowest';
    if (/(一般|中等|普通|平均|中游|中间水平)/.test(value)) return 'average';
    if (/(比较差|较差|成绩差|分数差|差|弱|低)/.test(value)) return 'poor';
    if (/(比较好|较好|成绩好|分数好|优秀|好|高|强)/.test(value)) return 'good';
    return '';
}

function detectGuardianGender(text = '') {
    const value = normalizeText(text);
    if (/男生|男同学|男/.test(value)) return 'M';
    if (/女生|女同学|女/.test(value)) return 'F';
    return '';
}

function guardianCriteriaFromText(text = '') {
    return {
        bucket: detectGuardianGradeBucket(text),
        gender: detectGuardianGender(text),
    };
}

function sortedById(students = []) {
    return [...students].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function sortedByGrade(students = [], direction = 'desc') {
    return [...students].sort((a, b) => {
        const gradeDiff = Number(a.grade) - Number(b.grade);
        if (gradeDiff !== 0) return direction === 'asc' ? gradeDiff : -gradeDiff;
        return String(a.id).localeCompare(String(b.id));
    });
}

function byTargetRank(students = [], targetRatio = 0.5, direction = 'asc') {
    const ordered = sortedByGrade(students, direction);
    const target = Math.max(0, Math.min(ordered.length - 1, Math.round((ordered.length - 1) * targetRatio)));
    return ordered
        .map((student, index) => ({ student, index, distance: Math.abs(index - target) }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index || String(a.student.id).localeCompare(String(b.student.id)))
        .map(item => item.student);
}

function rankGuardianCandidates(candidates = [], bucket = '') {
    const graded = candidates.filter(student => Number.isFinite(Number(student?.grade)));
    const unknown = sortedById(candidates.filter(student => !Number.isFinite(Number(student?.grade))));
    if (!bucket) return sortedById(candidates);
    if (bucket === 'highest') return [...sortedByGrade(graded, 'desc'), ...unknown];
    if (bucket === 'lowest') return [...sortedByGrade(graded, 'asc'), ...unknown];
    if (bucket === 'good') return [...byTargetRank(graded, 0.25, 'desc'), ...unknown];
    if (bucket === 'poor') return [...byTargetRank(graded, 0.25, 'asc'), ...unknown];
    if (bucket === 'average') return [...byTargetRank(graded, 0.5, 'asc'), ...unknown];
    return sortedById(candidates);
}

function guardianSlotMatches(message = '') {
    const quality = '最高|最好|最优秀|最低|最差|最弱|比较好|较好|比较差|较差|一般|中等|普通|平均|优秀|好|高|强|差|弱|低';
    const gender = '男生|女生|男同学|女同学|男|女';
    const pattern = new RegExp(`(?:成绩|分数)?\\s*(${quality})\\s*的?\\s*(${gender})`, 'g');
    return [...normalizeText(message).matchAll(pattern)].map(match => ({
        bucket: detectGuardianGradeBucket(match[1]),
        gender: normalizeStudentGender(match[2]),
    }));
}

function sideSegments(message = '') {
    const text = normalizeText(message);
    const matches = [...text.matchAll(/左护法|左边护法|右护法|右边护法/g)];
    if (matches.length < 2) return [];
    return matches.map((match, index) => {
        const next = matches[index + 1]?.index ?? text.length;
        return {
            side: /左/.test(match[0]) ? 'left' : 'right',
            text: text.slice(match.index, next),
        };
    });
}

function buildGuardianSlotRequests(message = '') {
    const text = normalizeText(message);
    const segments = sideSegments(text);
    if (segments.length) {
        return segments.map(segment => ({
            side: segment.side,
            ...guardianCriteriaFromText(segment.text),
        }));
    }

    const mentionsBothGuardians = /左右护法/.test(text);
    const explicitSide = !mentionsBothGuardians && /(左护法|左边护法)/.test(text)
        ? 'left'
        : !mentionsBothGuardians && /(右护法|右边护法)/.test(text)
            ? 'right'
            : '';
    if (explicitSide) {
        return [{ side: explicitSide, ...guardianCriteriaFromText(text) }];
    }

    const matched = guardianSlotMatches(text);
    if (matched.length >= 2) {
        return matched.slice(0, 2).map((criteria, index) => ({
            side: index === 0 ? 'left' : 'right',
            ...criteria,
        }));
    }

    const criteria = matched[0] || guardianCriteriaFromText(text);
    if (criteria.bucket || criteria.gender || /(成绩|分数|优秀|好|高|强|差|弱|低|一般|中等|普通|平均|两个|两名)/.test(text)) {
        return [
            { side: 'left', ...criteria },
            { side: 'right', ...criteria },
        ];
    }

    return [];
}

function chooseGuardianOperationsFromCriteria({ message = '', students = [], guardians = [] }) {
    const slots = buildGuardianSlotRequests(message);
    if (!slots.length) return { operations: [], rejected: [] };

    const currentGuardians = new Set((guardians || []).filter(Boolean));
    const chosen = new Set();
    const operations = [];
    const rejected = [];

    for (const slot of slots) {
        const targetIndex = normalizeGuardianSide(slot.side);
        if (targetIndex < 0) continue;

        const excluded = new Set(currentGuardians);
        const candidates = students
            .filter(student => student?.id && !excluded.has(student.id))
            .filter(student => !slot.gender || student.gender === slot.gender);
        const ranked = rankGuardianCandidates(candidates, slot.bucket)
            .filter(student => !chosen.has(student.id));
        const picked = ranked[0];
        if (!picked) {
            rejected.push({
                reason: `${guardianSideLabel(targetIndex)}没有找到符合条件的学生`,
            });
            continue;
        }
        operations.push({
            type: 'set_guardian',
            studentId: picked.id,
            side: targetIndex === 0 ? 'left' : 'right',
        });
        chosen.add(picked.id);
    }

    return { operations, rejected };
}

function hasGuardianCriteria(message = '') {
    return /(成绩|分数|最高|最好|最优秀|最低|最差|最弱|比较好|较好|比较差|较差|一般|中等|普通|平均|优秀|好|高|强|差|弱|低|男生|女生|男同学|女同学)/.test(message);
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

export function validateLayoutIntegrity({ layout = [], students = [], guardians = [] }) {
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
    for (const value of guardians || []) {
        if (!value) continue;
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
        if (!knownIds.has(value)) unknownIds.add(value);
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
    guardians = [],
    operations = [],
    rows = layout.length,
    cols = layout[0]?.length || 0,
    rowAisles = [],
    colAisles = [],
    blockedCells = [],
}) {
    const nextLayout = cloneLayout(layout, rows, cols);
    const nextGuardians = [guardians?.[0] || null, guardians?.[1] || null];
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

        if (op.type === 'set_guardian' || op.type === 'guardian') {
            const id = resolveOperationStudent(op, students, ['studentId', 'student_id', 'id', 'student', 'name']);
            if (!id) {
                rejected.push(reject(index, op, '未找到要安排到护法位的学生'));
                return;
            }
            const targetIndex = normalizeGuardianSide(op.side ?? op.slot ?? op.position);
            if (targetIndex < 0) {
                rejected.push(reject(index, op, '护法位必须指定为 left 或 right'));
                return;
            }

            const target = { r: -1, c: targetIndex };
            const from = findStudentPosition(nextLayout, id);
            const fromGuardian = findGuardianPosition(nextGuardians, id);

            // Already at target guardian: report a clear no-op without applying.
            if (fromGuardian && fromGuardian.c === targetIndex) {
                const student = students.find(item => item?.id === id);
                const name = student?.name || id;
                rejected.push(reject(index, op, `${name}已经是${guardianSideLabel(targetIndex)}`));
                return;
            }

            const displaced = nextGuardians[targetIndex] || null;
            nextGuardians[targetIndex] = id;
            clearStudentFromLayout(nextLayout, displaced);

            if (fromGuardian) {
                // Student was a guardian on the other side — swap slots
                nextGuardians[fromGuardian.c] = displaced;
                const cells = [fromGuardian, target];
                applied.push({ index, operation: op, type: 'set_guardian', affectedCells: cells });
                affectedCells.push(...cells);
                return;
            }

            if (from) {
                // Student was in a seat — displaced guardian goes to student's old seat
                nextLayout[from.r][from.c] = displaced;
                const cells = [from, target];
                applied.push({ index, operation: op, type: 'set_guardian', affectedCells: cells });
                affectedCells.push(...cells);
                return;
            }

            // Student is unplaced — directly assign as guardian
            applied.push({ index, operation: op, type: 'set_guardian', affectedCells: [target] });
            affectedCells.push(target);
            return;
        }

        rejected.push(reject(index, op, `不支持的操作类型: ${op.type || '未知'}`));
    });

    return {
        layout: nextLayout,
        guardians: nextGuardians,
        applied,
        rejected,
        affectedCells,
        integrity: validateLayoutIntegrity({ layout: nextLayout, students, guardians: nextGuardians }),
    };
}

export function parseFallbackSeatingOperations({
    message = '',
    layout = [],
    students = [],
    guardians = [],
    rows = layout.length,
    cols = layout[0]?.length || 0,
    rowAisles = [],
    colAisles = [],
    blockedCells = [],
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

    if (/(左右护法|左护法|右护法|护法)/.test(message)) {
        const criteriaIntent = hasGuardianCriteria(message);
        if (criteriaIntent) {
            const guardianChoice = chooseGuardianOperationsFromCriteria({ message, students, guardians });
            if (guardianChoice.operations.length || guardianChoice.rejected.length) {
                return {
                    mutationIntent,
                    operations: guardianChoice.operations,
                    rejected: guardianChoice.rejected,
                };
            }
        }

        const mentionsBothGuardians = /左右护法/.test(message);
        const explicitSide = !mentionsBothGuardians && /(左护法|左边护法)/.test(message)
            ? 'left'
            : !mentionsBothGuardians && /(右护法|右边护法)/.test(message)
                ? 'right'
                : '';
        if (names.length) {
            const guardianOps = explicitSide
                ? [{ type: 'set_guardian', studentId: names[0].id, side: explicitSide }]
                : names.slice(0, 2).map((item, index) => ({
                    type: 'set_guardian',
                    studentId: item.id,
                    side: index === 0 ? 'left' : 'right',
            }));
            return { mutationIntent, operations: guardianOps, rejected };
        }

        const guardianChoice = criteriaIntent
            ? { operations: [], rejected: [] }
            : chooseGuardianOperationsFromCriteria({ message, students, guardians });
        if (guardianChoice.operations.length || guardianChoice.rejected.length) {
            return {
                mutationIntent,
                operations: guardianChoice.operations,
                rejected: guardianChoice.rejected,
            };
        }
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

    const middleRowMatch = message.match(/第?([0-9一二两三四五六七八九十]+)\s*[排行].*(中间|中部|中央)/);
    if (middleRowMatch && /(移到|移动到|挪到|调到|安排到|坐到|放到)/.test(message)) {
        const row = cnNumber(middleRowMatch[1]) - 1;
        const blockedSet = new Set(blockedCells.map(cell => Array.isArray(cell) ? `${cell[0]},${cell[1]}` : `${cell.r},${cell.c}`));
        const candidates = [];
        const center = (cols - 1) / 2;
        for (let col = 0; col < cols; col++) {
            if (!isInBounds(row, col, rows, cols)) continue;
            if (isAisle(row, col, layout, rowAisles, colAisles, blockedSet)) continue;
            candidates.push({ row, col, distance: Math.abs(col - center) });
        }
        candidates.sort((a, b) => a.distance - b.distance || a.col - b.col);
        if (candidates.length) {
            return {
                mutationIntent,
                operations: [{ type: 'move', studentId: student.id, row, col: candidates[0].col }],
                rejected,
            };
        }
        return {
            mutationIntent,
            operations,
            rejected: [{ reason: `第${row + 1}排没有可用的中间座位` }],
        };
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

function localAisleSeparates(pos1, pos2, localAisles = {}) {
    if (!pos1 || !pos2) return false;
    if (pos1.r === pos2.r && Math.abs(pos1.c - pos2.c) === 1) {
        return hasLocalAisle(localAisles, 'vertical', pos1.r, Math.min(pos1.c, pos2.c));
    }
    if (pos1.c === pos2.c && Math.abs(pos1.r - pos2.r) === 1) {
        return hasLocalAisle(localAisles, 'horizontal', Math.min(pos1.r, pos2.r), pos1.c);
    }
    return false;
}

function adjacent(pos1, pos2, localAisles = {}) {
    if (!pos1 || !pos2) return false;
    return Math.abs(pos1.r - pos2.r) + Math.abs(pos1.c - pos2.c) === 1
        && !localAisleSeparates(pos1, pos2, localAisles);
}

function nearSeat(pos1, pos2, localAisles = {}) {
    if (!pos1 || !pos2) return false;
    if (adjacent(pos1, pos2, localAisles)) return true;
    return Math.abs(pos1.r - pos2.r) + Math.abs(pos1.c - pos2.c) <= 2;
}

function usableIndexes(count = 0, blocked = []) {
    const blockedSet = new Set(blocked || []);
    return Array.from({ length: count }, (_, index) => index).filter(index => !blockedSet.has(index));
}

function middleIndexSet(indexes = []) {
    if (!indexes.length) return new Set();
    const size = Math.max(1, Math.ceil(indexes.length / 3));
    const start = Math.max(0, Math.floor((indexes.length - size) / 2));
    return new Set(indexes.slice(start, start + size));
}

function seatingZones(rows, cols, rowAisles = [], colAisles = []) {
    const rowsInUse = usableIndexes(rows, rowAisles);
    const colsInUse = usableIndexes(cols, colAisles);
    const frontCount = Math.max(1, Math.ceil(rowsInUse.length / 3));
    const frontMidCount = Math.max(1, Math.ceil(rowsInUse.length * 2 / 3));
    return {
        rowsInUse,
        colsInUse,
        firstRow: rowsInUse[0],
        lastRow: rowsInUse[rowsInUse.length - 1],
        frontRows: new Set(rowsInUse.slice(0, frontCount)),
        backRows: new Set(rowsInUse.slice(rowsInUse.length - frontCount)),
        frontMidRows: new Set(rowsInUse.slice(0, frontMidCount)),
        middleCols: middleIndexSet(colsInUse),
    };
}

function gradeSets(students = []) {
    const graded = students
        .filter(student => Number.isFinite(Number(student?.grade)))
        .sort((a, b) => Number(b.grade) - Number(a.grade));
    const count = Math.max(1, Math.ceil(graded.length * 0.25));
    return {
        high: new Set(graded.slice(0, count).map(student => student.id)),
        low: new Set(graded.slice(Math.max(0, graded.length - count)).map(student => student.id)),
    };
}

function adjacentStudentIds(layout = [], pos, localAisles = {}) {
    if (!pos) return [];
    const candidates = [
        { r: pos.r - 1, c: pos.c },
        { r: pos.r + 1, c: pos.c },
        { r: pos.r, c: pos.c - 1 },
        { r: pos.r, c: pos.c + 1 },
    ];
    return candidates
        .filter(candidate => adjacent(pos, candidate, localAisles))
        .map(candidate => layout[candidate.r]?.[candidate.c])
        .filter(Boolean);
}

function hasHighGradeNeighbor(layout, pos, highGradeIds, localAisles = {}) {
    return adjacentStudentIds(layout, pos, localAisles).some(id => highGradeIds.has(id));
}

function hasLowGradeNeighbor(layout, pos, lowGradeIds, localAisles = {}) {
    return adjacentStudentIds(layout, pos, localAisles).some(id => lowGradeIds.has(id));
}

function isAisleAdjacentPosition(pos, rows, cols, colAisles = [], localAisles = {}) {
    if (!pos) return false;
    if (pos.c > 0 && colAisles.includes(pos.c - 1)) return true;
    if (pos.c < cols - 1 && colAisles.includes(pos.c + 1)) return true;
    if (hasLocalAisle(localAisles, 'vertical', pos.r, pos.c)) return true;
    if (hasLocalAisle(localAisles, 'vertical', pos.r, pos.c - 1)) return true;
    return pos.c === 0 || pos.c === cols - 1;
}

function isEdgePosition(pos, cols, colAisles = []) {
    if (!pos) return false;
    const colsInUse = usableIndexes(cols, colAisles);
    if (!colsInUse.length) return false;
    return pos.c === colsInUse[0] || pos.c === colsInUse[colsInUse.length - 1];
}

function makeUnsatisfied(constraint, reason) {
    return {
        ...constraint,
        reason: constraint.reason || reason,
        priority: constraint.priority || 'hard',
    };
}

function dedupeEvalConstraints(constraints = []) {
    const seen = new Set();
    const result = [];
    for (const constraint of constraints) {
        const type = normalizeText(constraint?.type);
        const target = normalizeStudentLookupKey(constraint?.target);
        if (!type || !target) continue;
        const related = normalizeStudentLookupKey(constraint?.related);
        const key = `${type}|${target}|${related}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(constraint);
    }
    return result;
}

export function evaluateSeatingConstraints({
    layout = [],
    students = [],
    constraints = [],
    rows = layout.length,
    cols = layout[0]?.length || 0,
    rowAisles = [],
    colAisles = [],
    localAisles = {},
}) {
    const zones = seatingZones(rows, cols, rowAisles, colAisles);
    const normalizedLocalAisles = normalizeLocalAisles(localAisles, rows, cols);
    const { high: highGradeIds, low: lowGradeIds } = gradeSets(students);
    const unsatisfied = [];

    // Deduplicate constraints before evaluation to avoid double-counting
    const deduped = dedupeEvalConstraints(constraints || []);

    for (const constraint of deduped) {
        const targetId = resolveStudentId(constraint.target, students);
        const relatedId = resolveStudentId(constraint.related, students);
        const targetPos = targetId ? findStudentPosition(layout, targetId) : null;
        const relatedPos = relatedId ? findStudentPosition(layout, relatedId) : null;

        // If targetId can't be resolved at all, skip — don't penalize as hard violation
        if (!targetId) continue;
        if (!targetPos) {
            // Student exists but not placed in grid (may be guardian or unassigned)
            unsatisfied.push(makeUnsatisfied(
                { ...constraint, priority: 'soft' },
                '学生未在座位表中，无法评估约束'
            ));
            continue;
        }

        if (constraint.type === 'front_row' && !zones.frontRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '未坐在前排区域'));
        } else if (constraint.type === 'back_row' && !zones.backRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '未坐在后排区域'));
        } else if (constraint.type === 'avoid_first_row' && targetPos.r === zones.firstRow) {
            unsatisfied.push(makeUnsatisfied(constraint, '仍然坐在第一排'));
        } else if (constraint.type === 'avoid_last_row' && targetPos.r === zones.lastRow) {
            unsatisfied.push(makeUnsatisfied(constraint, '仍然坐在最后一排'));
        } else if (constraint.type === 'avoid_front_row' && zones.frontRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '仍然坐在前排区域'));
        } else if (constraint.type === 'avoid_back_row' && zones.backRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '仍然坐在后排区域'));
        } else if (constraint.type === 'prefer_front_middle'
            && (!zones.frontRows.has(targetPos.r) || !zones.middleCols.has(targetPos.c))) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '未坐在前排中间区域'));
        } else if (constraint.type === 'prefer_front_mid_rows' && !zones.frontMidRows.has(targetPos.r)) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '未坐在前中排区域'));
        } else if (constraint.type === 'prefer_aisle'
            && !isAisleAdjacentPosition(targetPos, rows, cols, colAisles, normalizedLocalAisles)) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '未坐在靠过道位置'));
        } else if (constraint.type === 'prefer_edge'
            && !isEdgePosition(targetPos, cols, colAisles)) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '未坐在靠边位置'));
        } else if (constraint.type === 'avoid_behind' && (!relatedId || !relatedPos || targetPos.r > relatedPos.r)) {
            unsatisfied.push(makeUnsatisfied(constraint, '仍然坐在相关同学后面'));
        } else if (constraint.type === 'avoid' && relatedId && adjacent(targetPos, relatedPos, normalizedLocalAisles)) {
            unsatisfied.push(makeUnsatisfied(constraint, '两人仍然相邻'));
        } else if ((constraint.type === 'not_adjacent') && relatedId && adjacent(targetPos, relatedPos, normalizedLocalAisles)) {
            unsatisfied.push(makeUnsatisfied(constraint, '两人仍然相邻'));
        } else if (constraint.type === 'avoid_near' && relatedId && nearSeat(targetPos, relatedPos, normalizedLocalAisles)) {
            unsatisfied.push(makeUnsatisfied(constraint, '两人仍然坐得过近'));
        } else if ((constraint.type === 'pair' || constraint.type === 'must_adjacent')
            && (!relatedId || !adjacent(targetPos, relatedPos, normalizedLocalAisles))) {
            unsatisfied.push(makeUnsatisfied(constraint, '两人没有相邻'));
        } else if (constraint.type === 'prefer'
            && (!relatedId || !adjacent(targetPos, relatedPos, normalizedLocalAisles))) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '偏好未满足'));
        } else if (constraint.type === 'prefer_near'
            && (!relatedId || !nearSeat(targetPos, relatedPos, normalizedLocalAisles))) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '偏好未满足'));
        } else if (constraint.type === 'prefer_high_grade_neighbor'
            && !hasHighGradeNeighbor(layout, targetPos, highGradeIds, normalizedLocalAisles)) {
            unsatisfied.push(makeUnsatisfied({ ...constraint, priority: constraint.priority || 'soft' }, '旁边没有成绩较好的同学'));
        } else if (constraint.type === 'avoid_low_grade_deskmate'
            && hasLowGradeNeighbor(layout, targetPos, lowGradeIds, normalizedLocalAisles)) {
            unsatisfied.push(makeUnsatisfied(constraint, '旁边仍有成绩偏低的同学'));
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

function qualityRowsAndCols(layout = [], classroomLayout = {}, rows, cols) {
    const safeRows = Math.max(Number(rows) || 0, Number(classroomLayout?.rows) || 0, layout.length);
    const safeCols = Math.max(
        Number(cols) || 0,
        Number(classroomLayout?.cols) || 0,
        ...layout.map(row => Array.isArray(row) ? row.length : 0),
        0
    );
    return { rows: safeRows, cols: safeCols };
}

function qualityStudentLookup(students = []) {
    const byId = new Map();
    const byName = new Map();
    for (const student of students || []) {
        if (!student?.id) continue;
        byId.set(student.id, student);
        const name = normalizeText(student.name);
        if (name && !byName.has(name)) byName.set(name, student);
    }
    return { byId, byName };
}

function finiteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function uniqueByCell(cells = []) {
    const seen = new Set();
    const result = [];
    for (const cell of cells) {
        if (!Number.isInteger(cell?.r) || !Number.isInteger(cell?.c)) continue;
        const key = `${cell.r},${cell.c}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ r: cell.r, c: cell.c });
    }
    return result;
}

function addQualityConstraint(collection, { id, name, level = 'soft', weight = 1, matches = [], message = '' }) {
    if (!matches.length) return;
    const safeWeight = Math.max(1, Math.abs(Number(weight) || 1));
    const involvedStudentIds = [...new Set(matches.flatMap(match => match.studentIds || []).filter(Boolean))];
    const involvedCells = uniqueByCell(matches.flatMap(match => match.cells || []));
    collection.push({
        id,
        name,
        level,
        weight: safeWeight,
        matches,
        score: -safeWeight * matches.length,
        message,
        involvedStudentIds,
        involvedCells,
    });
}

function isQualitySeat(classroomLayout, row, col, rowAisles = [], colAisles = []) {
    if (rowAisles.includes(row) || colAisles.includes(col)) return false;
    const cell = classroomLayout?.cells?.[row]?.[col];
    return cell === undefined || cell === 'seat';
}

function buildQualityPlacement({ layout = [], students = [], classroomLayout = {}, guardians = [], rows, cols, rowAisles = [], colAisles = [] }) {
    const { rows: safeRows, cols: safeCols } = qualityRowsAndCols(layout, classroomLayout, rows, cols);
    const { byId } = qualityStudentLookup(students);
    const byStudentId = new Map();
    const positionsById = new Map();
    const unknown = [];
    const nonSeat = [];
    const placedIds = new Set();

    const addStudentCell = (id, cell) => {
        if (!positionsById.has(id)) positionsById.set(id, []);
        positionsById.get(id).push(cell);
        placedIds.add(id);
    };

    for (let r = 0; r < safeRows; r++) {
        for (let c = 0; c < safeCols; c++) {
            const value = layout?.[r]?.[c];
            if (!value || value === AISLE) continue;
            const cell = { r, c };
            addStudentCell(value, cell);
            if (!byId.has(value)) {
                unknown.push({ studentIds: [value], cells: [cell], text: value, reason: '名单中没有这个学生' });
            }
            if (!isQualitySeat(classroomLayout, r, c, rowAisles, colAisles)) {
                nonSeat.push({ studentIds: [value], cells: [cell], reason: '坐到了过道或非座位格' });
            }
            byStudentId.set(value, { ...(byStudentId.get(value) || {}), grid: cell });
        }
    }

    const guardianIds = Array.isArray(guardians) && guardians.length
        ? guardians
        : [classroomLayout?.guardians?.left, classroomLayout?.guardians?.right];
    for (const id of guardianIds.filter(Boolean)) {
        addStudentCell(id, null);
        if (!byId.has(id)) unknown.push({ studentIds: [id], cells: [], text: id, reason: '护法位引用了名单外学生' });
        byStudentId.set(id, { ...(byStudentId.get(id) || {}), guardian: true });
    }

    const duplicates = [];
    for (const [id, cells] of positionsById.entries()) {
        if (cells.length > 1) {
            duplicates.push({
                studentIds: [id],
                cells: uniqueByCell(cells.filter(Boolean)),
                reason: '同一个学生出现了多次',
            });
        }
    }

    const missing = [];
    for (const student of students || []) {
        if (!student?.id || placedIds.has(student.id)) continue;
        missing.push({ studentIds: [student.id], cells: [], reason: '名单学生没有出现在座位表中' });
    }

    return {
        rows: safeRows,
        cols: safeCols,
        byStudentId,
        positionsById,
        unknown,
        nonSeat,
        duplicates,
        missing,
    };
}

function constraintExpectedText(constraint = {}) {
    if (constraint.type === 'front_row') return '坐在前排区域';
    if (constraint.type === 'back_row') return '坐在后排区域';
    if (constraint.type === 'avoid_first_row') return '避开第一排';
    if (constraint.type === 'avoid_last_row') return '避开最后一排';
    if (constraint.type === 'avoid_front_row') return '避开前排区域';
    if (constraint.type === 'avoid_back_row') return '避开后排区域';
    if (constraint.type === 'avoid_behind') return '不要坐在相关同学后面';
    if (constraint.type === 'avoid_near') return '两人不要坐得过近';
    if (constraint.type === 'prefer_front_middle') return '尽量坐在前排中间区域';
    if (constraint.type === 'prefer_front_mid_rows') return '尽量坐在前中排区域';
    if (constraint.type === 'prefer_aisle') return '尽量靠过道';
    if (constraint.type === 'prefer_edge') return '尽量靠边';
    if (constraint.type === 'prefer_high_grade_neighbor') return '旁边有成绩较好的同学';
    if (constraint.type === 'avoid_low_grade_deskmate') return '避免低分同桌';
    if (constraint.type === 'avoid') return '两人不要相邻';
    if (constraint.type === 'not_adjacent') return '两人不要相邻';
    if (constraint.type === 'pair') return '两人相邻';
    if (constraint.type === 'must_adjacent') return '两人相邻';
    if (constraint.type === 'prefer' || constraint.type === 'prefer_near') return '尽量相近';
    return '满足学生需求';
}

function constraintMatchForUnsatisfied(unsatisfied, students, layout) {
    const targetId = resolveStudentId(unsatisfied.target, students) || unsatisfied.target;
    const relatedId = resolveStudentId(unsatisfied.related, students) || unsatisfied.related;
    const cells = [findStudentPosition(layout, targetId), findStudentPosition(layout, relatedId)].filter(Boolean);
    const studentIds = [targetId, relatedId].filter(Boolean);
    return {
        studentIds,
        cells,
        reason: unsatisfied.reason,
        type: unsatisfied.type,
        expected: constraintExpectedText(unsatisfied),
        actual: unsatisfied.reason,
    };
}

function calculateQualitySeatEntries({ layout = [], classroomLayout = {}, rows, cols, rowAisles = [], colAisles = [] }) {
    const { rows: safeRows, cols: safeCols } = qualityRowsAndCols(layout, classroomLayout, rows, cols);
    const usableRows = [];
    for (let r = 0; r < safeRows; r++) {
        const hasSeat = Array.from({ length: safeCols }, (_, c) => c)
            .some(c => isQualitySeat(classroomLayout, r, c, rowAisles, colAisles));
        if (hasSeat) usableRows.push(r);
    }

    const colBlocks = [];
    let currentBlock = [];
    for (let c = 0; c < safeCols; c++) {
        const columnHasSeat = Array.from({ length: safeRows }, (_, r) => r)
            .some(r => isQualitySeat(classroomLayout, r, c, rowAisles, colAisles));
        if (!columnHasSeat || colAisles.includes(c)) {
            if (currentBlock.length) colBlocks.push(currentBlock);
            currentBlock = [];
        } else {
            currentBlock.push(c);
        }
    }
    if (currentBlock.length) colBlocks.push(currentBlock);

    const rowScoreMap = new Map();
    const peakRowPos = Math.max(0, usableRows.length * 0.33);
    const rowSigma = usableRows.length * 0.45 || 1;
    usableRows.forEach((r, index) => {
        const dist = index - peakRowPos;
        rowScoreMap.set(r, Math.exp(-(dist * dist) / (2 * rowSigma * rowSigma)));
    });

    const usableColumns = [];
    for (let c = 0; c < safeCols; c++) {
        if (Array.from({ length: safeRows }, (_, r) => r)
            .some(r => isQualitySeat(classroomLayout, r, c, rowAisles, colAisles))) {
            usableColumns.push(c);
        }
    }
    const usableColumnIndex = new Map(usableColumns.map((c, index) => [c, index]));
    const globalColumnCenter = Math.max(0, (usableColumns.length - 1) / 2);
    const globalColumnSigma = usableColumns.length * 0.35 || 1;
    const colScoreMap = new Map();
    for (const block of colBlocks) {
        const blockCenter = (block.length - 1) / 2;
        const colSigma = block.length * 0.45 || 1;
        block.forEach((c, index) => {
            const globalDist = (usableColumnIndex.get(c) ?? 0) - globalColumnCenter;
            const globalScore = Math.exp(-(globalDist * globalDist) / (2 * globalColumnSigma * globalColumnSigma));
            const blockDist = index - blockCenter;
            const blockScore = Math.exp(-(blockDist * blockDist) / (2 * colSigma * colSigma));
            let score = globalScore * (0.75 + 0.25 * blockScore);
            if (colAisles.includes(c - 1) || colAisles.includes(c + 1)) score *= 0.95;
            colScoreMap.set(c, score);
        });
    }

    const rowAisleAdjacentSet = new Set();
    for (const row of rowAisles) {
        if (row - 1 >= 0) rowAisleAdjacentSet.add(row - 1);
        if (row + 1 < safeRows) rowAisleAdjacentSet.add(row + 1);
    }

    const entries = [];
    const scoreByCell = new Map();
    for (let r = 0; r < safeRows; r++) {
        for (let c = 0; c < safeCols; c++) {
            if (!isQualitySeat(classroomLayout, r, c, rowAisles, colAisles)) continue;
            let raw = (rowScoreMap.get(r) || 0) * (colScoreMap.get(c) || 0);
            if (rowAisleAdjacentSet.has(r)) raw *= 0.93;
            const score = Math.round(raw * 100);
            entries.push({ r, c, score });
            scoreByCell.set(`${r},${c}`, score);
        }
    }
    entries.sort((a, b) => b.score - a.score || a.r - b.r || a.c - b.c);
    return { entries, scoreByCell };
}

function addGenderBalanceIssues(collection, { layout, studentsById, rows, cols, classroomLayout, rowAisles, colAisles, localAisles }) {
    const matches = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols - 1; c++) {
            if (!isQualitySeat(classroomLayout, r, c, rowAisles, colAisles)
                || !isQualitySeat(classroomLayout, r, c + 1, rowAisles, colAisles)) {
                continue;
            }
            if (hasLocalAisle(localAisles, 'vertical', r, c)) continue;
            const id1 = layout?.[r]?.[c];
            const id2 = layout?.[r]?.[c + 1];
            const first = studentsById.get(id1);
            const second = studentsById.get(id2);
            if (!first || !second || !['M', 'F'].includes(first.gender) || first.gender !== second.gender) continue;
            matches.push({ studentIds: [id1, id2], cells: [{ r, c }, { r, c: c + 1 }], reason: '相邻座位性别相同' });
        }
    }
    addQualityConstraint(collection, {
        id: 'strategy.gender.adjacent',
        name: '男女搭配相邻均衡',
        level: 'soft',
        weight: 2,
        matches,
        message: `${matches.length} 处相邻座位性别搭配不够均衡`,
    });
}

function addHeightOrderIssues(collection, { placement, studentsById }) {
    const rowHeights = new Map();
    for (const [id, placementInfo] of placement.byStudentId.entries()) {
        const cell = placementInfo.grid;
        const height = finiteNumber(studentsById.get(id)?.height);
        if (!cell || height == null) continue;
        if (!rowHeights.has(cell.r)) rowHeights.set(cell.r, []);
        rowHeights.get(cell.r).push({ id, cell, height });
    }
    const rows = [...rowHeights.keys()].sort((a, b) => a - b);
    const matches = [];
    for (let i = 0; i < rows.length - 1; i++) {
        const front = rowHeights.get(rows[i]);
        const back = rowHeights.get(rows[i + 1]);
        const frontAvg = front.reduce((sum, item) => sum + item.height, 0) / front.length;
        const backAvg = back.reduce((sum, item) => sum + item.height, 0) / back.length;
        if (frontAvg > backAvg + 3) {
            matches.push({
                studentIds: [...front, ...back].map(item => item.id),
                cells: [...front, ...back].map(item => item.cell),
                frontRow: rows[i],
                backRow: rows[i + 1],
            });
        }
    }
    addQualityConstraint(collection, {
        id: 'strategy.height.order',
        name: '身高前后顺序',
        level: 'soft',
        weight: 3,
        matches,
        message: `${matches.length} 组相邻行身高顺序需要调整`,
    });
}

function topGradeStudentIds(students = []) {
    const ranked = students
        .filter(student => student?.id && finiteNumber(student.grade) != null)
        .sort((a, b) => finiteNumber(b.grade) - finiteNumber(a.grade) || String(a.id).localeCompare(String(b.id)));
    if (!ranked.length) return new Set();
    const count = Math.max(1, Math.ceil(ranked.length * 0.2));
    return new Set(ranked.slice(0, count).map(student => student.id));
}

function addGradePriorityIssues(collection, snapshot, placement) {
    const topIds = topGradeStudentIds(snapshot.students);
    if (!topIds.size) return;
    const { entries, scoreByCell } = calculateQualitySeatEntries(snapshot);
    const threshold = entries[Math.min(topIds.size - 1, entries.length - 1)]?.score ?? 0;
    const matches = [];
    for (const id of topIds) {
        const cell = placement.byStudentId.get(id)?.grid;
        if (!cell) continue;
        const score = scoreByCell.get(`${cell.r},${cell.c}`) ?? 0;
        if (score < threshold) {
            matches.push({ studentIds: [id], cells: [cell], seatScore: score, expectedAtLeast: threshold });
        }
    }
    addQualityConstraint(collection, {
        id: 'strategy.grade.priority',
        name: '优秀优先座位质量',
        level: 'soft',
        weight: 4,
        matches,
        message: `${matches.length} 名前 20% 学生未坐到优先座位区`,
    });
}

function addGradeBalanceIssues(collection, { placement, studentsById }) {
    const rowGrades = new Map();
    for (const [id, placementInfo] of placement.byStudentId.entries()) {
        const cell = placementInfo.grid;
        const grade = finiteNumber(studentsById.get(id)?.grade);
        if (!cell || grade == null) continue;
        if (!rowGrades.has(cell.r)) rowGrades.set(cell.r, []);
        rowGrades.get(cell.r).push({ id, cell, grade });
    }
    const rows = [...rowGrades.keys()];
    if (rows.length < 2) return;
    const averages = rows.map(row => {
        const grades = rowGrades.get(row);
        return { row, average: grades.reduce((sum, item) => sum + item.grade, 0) / grades.length, grades };
    });
    const min = averages.reduce((best, item) => item.average < best.average ? item : best, averages[0]);
    const max = averages.reduce((best, item) => item.average > best.average ? item : best, averages[0]);
    const matches = max.average - min.average > 15
        ? [{
            studentIds: [...max.grades, ...min.grades].map(item => item.id),
            cells: [...max.grades, ...min.grades].map(item => item.cell),
            rows: [min.row, max.row],
        }]
        : [];
    addQualityConstraint(collection, {
        id: 'strategy.grade.balance',
        name: '成绩行间均衡',
        level: 'soft',
        weight: 5,
        matches,
        message: '行间成绩分布差异较大',
    });
}

function qualityPercent({ hardScore, softScore, hardViolationCount }) {
    const softPenalty = Math.abs(softScore);
    if (hardScore < 0) {
        return Math.max(10, Math.min(59, Math.round(59 - Math.max(0, hardViolationCount - 1) * 5 - softPenalty / 8)));
    }
    return Math.max(60, Math.min(100, Math.round(100 - softPenalty / 2)));
}

export function evaluateSeatingQuality({
    layout = [],
    students = [],
    constraints = [],
    classroomLayout = {},
    guardians = [],
    unassigned = [],
    strategy = {},
    rows,
    cols,
    rowAisles = [],
    colAisles = [],
    localAisles = classroomLayout?.localAisles,
} = {}) {
    const { rows: safeRows, cols: safeCols } = qualityRowsAndCols(layout, classroomLayout, rows, cols);
    const cells = normalizeCells(classroomLayout, safeRows, safeCols);
    const normalizedLocalAisles = normalizeLocalAisles(localAisles || classroomLayout?.localAisles, safeRows, safeCols);
    const aisleInfo = legacyAislesFromCells(cells);
    const mergedRowAisles = [...new Set([...(rowAisles || []), ...aisleInfo.rowAisles])];
    const mergedColAisles = [...new Set([...(colAisles || []), ...aisleInfo.colAisles])];
    const snapshot = {
        layout,
        students,
        classroomLayout: { ...classroomLayout, rows: safeRows, cols: safeCols, cells, localAisles: normalizedLocalAisles },
        guardians,
        rows: safeRows,
        cols: safeCols,
        rowAisles: mergedRowAisles,
        colAisles: mergedColAisles,
        localAisles: normalizedLocalAisles,
    };
    const placement = buildQualityPlacement(snapshot);
    const { byId: studentsById } = qualityStudentLookup(students);
    const scoreConstraints = [];

    addQualityConstraint(scoreConstraints, {
        id: 'layout.duplicates',
        name: '学生重复安排',
        level: 'hard',
        weight: 20,
        matches: placement.duplicates,
        message: `${placement.duplicates.length} 名学生重复出现在座位表中`,
    });
    addQualityConstraint(scoreConstraints, {
        id: 'layout.unknownStudents',
        name: '未知学生',
        level: 'hard',
        weight: 20,
        matches: placement.unknown,
        message: `${placement.unknown.length} 个座位引用了名单外学生`,
    });
    addQualityConstraint(scoreConstraints, {
        id: 'layout.nonSeatAssignments',
        name: '学生坐到非座位区域',
        level: 'hard',
        weight: 20,
        matches: placement.nonSeat,
        message: `${placement.nonSeat.length} 名学生被放在过道或非座位格`,
    });
    addQualityConstraint(scoreConstraints, {
        id: 'layout.missingStudents',
        name: '学生未安排',
        level: 'hard',
        weight: 20,
        matches: placement.missing.map(match => ({
            ...match,
            unassigned: (unassigned || []).includes(match.studentIds[0]),
        })),
        message: `${placement.missing.length} 名学生未出现在座位表中`,
    });

    const studentNeedEvaluation = evaluateSeatingConstraints({
        layout,
        students,
        constraints,
        rows: safeRows,
        cols: safeCols,
        rowAisles: mergedRowAisles,
        colAisles: mergedColAisles,
        localAisles: normalizedLocalAisles,
    });
    addQualityConstraint(scoreConstraints, {
        id: 'needs.hard',
        name: '硬性学生需求',
        level: 'hard',
        weight: 5,
        matches: studentNeedEvaluation.hardUnsatisfied.map(item => constraintMatchForUnsatisfied(item, students, layout)),
        message: `${studentNeedEvaluation.hardUnsatisfied.length} 条硬性学生需求未满足`,
    });
    addQualityConstraint(scoreConstraints, {
        id: 'needs.soft',
        name: '软性学生需求',
        level: 'soft',
        weight: 2,
        matches: studentNeedEvaluation.softUnsatisfied.map(item => constraintMatchForUnsatisfied(item, students, layout)),
        message: `${studentNeedEvaluation.softUnsatisfied.length} 条软性学生需求未满足`,
    });

    if (strategy?.genderBalance) {
        addGenderBalanceIssues(scoreConstraints, {
            layout,
            studentsById,
            rows: safeRows,
            cols: safeCols,
            classroomLayout: snapshot.classroomLayout,
            rowAisles: mergedRowAisles,
            colAisles: mergedColAisles,
            localAisles: normalizedLocalAisles,
        });
    }
    if (strategy?.heightOrder) {
        addHeightOrderIssues(scoreConstraints, { placement, studentsById });
    }
    if (strategy?.gradeStrategy === 'priority') {
        addGradePriorityIssues(scoreConstraints, snapshot, placement);
    } else if (strategy?.gradeStrategy === 'balance') {
        addGradeBalanceIssues(scoreConstraints, { placement, studentsById });
    }

    const hardScore = scoreConstraints
        .filter(item => item.level === 'hard')
        .reduce((sum, item) => sum + item.score, 0);
    const softScore = scoreConstraints
        .filter(item => item.level !== 'hard')
        .reduce((sum, item) => sum + item.score, 0);
    const hardViolationCount = scoreConstraints
        .filter(item => item.level === 'hard')
        .reduce((sum, item) => sum + item.matches.length, 0);
    const softViolationCount = scoreConstraints
        .filter(item => item.level !== 'hard')
        .reduce((sum, item) => sum + item.matches.length, 0);
    const feasible = hardScore === 0;
    const percent = qualityPercent({ hardScore, softScore, hardViolationCount });
    const label = feasible
        ? percent >= 90 ? '优秀' : percent >= 75 ? '良好' : '可优化'
        : '需调整';
    const topIssues = [...scoreConstraints]
        .sort((a, b) => {
            if (a.level !== b.level) return a.level === 'hard' ? -1 : 1;
            return Math.abs(b.score) - Math.abs(a.score);
        })
        .slice(0, 3);

    return {
        feasible,
        hardScore,
        softScore,
        percent,
        label,
        constraints: scoreConstraints,
        topIssues,
        hardViolationCount,
        softViolationCount,
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
