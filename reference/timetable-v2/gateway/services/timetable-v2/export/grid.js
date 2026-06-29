/**
 * timetable-v2 / export / grid.js
 *
 * 把 solve() 的扁平 placements 展开为三种网格视图（班级 / 教师 / 教室），
 * 作为前端渲染与 xlsx 导出的单一真相源（design 决策 3）。
 *
 * 网格维度来自 project.calendar.weekdays × periodsPerDay，索引为 grid[period-1][weekday-1]。
 * 连堂（duration>1）：块首格 isBlockStart=true 携带完整信息，其余格 isBlockStart=false 指向块首，
 * 避免重复渲染。
 *
 * 纯函数：不修改入参，相同输入相同输出，零 IO。
 */

/**
 * 构建三种网格视图。
 * @param {object} project SchoolProjectV2（createProject 产物或裸对象，需含 calendar/classes/...）
 * @param {object} solveResult solve() 返回值（含 placements 与 ctx）
 * @returns {{ byClass:object, byTeacher:object, byRoom:object }}
 */
export function buildGridView(project, solveResult) {
    const calendar = project.calendar || {};
    const weekdays = clampDim(calendar.weekdays, 5);
    const periodsPerDay = clampDim(calendar.periodsPerDay, 7);

    const placements = Array.isArray(solveResult?.placements) ? solveResult.placements : [];
    const activities = Array.isArray(solveResult?.ctx?.activities) ? solveResult.ctx.activities : [];

    // 名称查找表
    const classMap = toMap(project.classes);
    const teacherMap = toMap(project.teachers);
    const subjectMap = toMap(project.subjects);
    const roomMap = toMap(project.rooms);

    // activityId -> 展开后的 Activity（含 classIds/teacherIds/subjectId）
    const activityById = new Map();
    for (const a of activities) {
        if (a && a.id !== undefined) activityById.set(a.id, a);
    }

    // 初始化三类视图（class / teacher 覆盖全量；room 也预置全量，便于一致遍历）
    const byClass = {};
    for (const c of asArray(project.classes)) {
        byClass[c.id] = { className: displayName(c), grid: emptyGrid(periodsPerDay, weekdays) };
    }
    const byTeacher = {};
    for (const t of asArray(project.teachers)) {
        byTeacher[t.id] = { teacherName: displayName(t), grid: emptyGrid(periodsPerDay, weekdays) };
    }
    const byRoom = {};
    for (const r of asArray(project.rooms)) {
        byRoom[r.id] = { roomName: displayName(r), grid: emptyGrid(periodsPerDay, weekdays) };
    }

    for (const p of placements) {
        const day = Number(p.day);
        const period = Number(p.period);
        if (!Number.isInteger(day) || !Number.isInteger(period)) continue; // 未排入有效时段
        if (day < 1 || day > weekdays || period < 1 || period > periodsPerDay) continue;

        const act = activityById.get(p.activityId) || {};
        const classIds = act.classIds || [];
        const teacherIds = act.teacherIds || [];
        const subjectName = subjectMap.get(act.subjectId)?.name || act.subjectId || '';
        const teacherNames = teacherIds.map(id => teacherMap.get(id)?.name || id);
        const classNames = classIds.map(id => displayName(classMap.get(id)) || id);
        const roomName = p.roomId != null ? (roomMap.get(p.roomId)?.name || p.roomId) : null;
        const duration = Number.isInteger(p.duration) && p.duration > 0 ? p.duration : 1;

        const baseCell = {
            activityId: p.activityId,
            subject: subjectName,
            teachers: teacherNames,
            classes: classNames,
            roomId: p.roomId ?? null,
            roomName,
            duration,
            weekPattern: p.weekPattern ?? 'all',
        };

        // 写入某个视图的 grid，处理连堂占格
        const paint = (entry) => {
            if (!entry) return;
            const dIdx = day - 1;
            for (let k = 0; k < duration; k++) {
                const pIdx = period - 1 + k;
                if (pIdx >= periodsPerDay) break; // 越界保护
                if (k === 0) {
                    entry.grid[pIdx][dIdx] = { ...baseCell, isBlockStart: true };
                } else {
                    entry.grid[pIdx][dIdx] = {
                        activityId: p.activityId,
                        isBlockStart: false,
                        blockStart: { day, period },
                    };
                }
            }
        };

        for (const cid of classIds) paint(byClass[cid]);
        for (const tid of teacherIds) paint(byTeacher[tid]);
        if (p.roomId != null && byRoom[p.roomId]) paint(byRoom[p.roomId]);
    }

    return { byClass, byTeacher, byRoom };
}

// ---- helpers ----

function emptyGrid(periods, days) {
    return Array.from({ length: periods }, () => Array.from({ length: days }, () => null));
}

function toMap(list) {
    const m = new Map();
    for (const item of asArray(list)) {
        if (item && item.id !== undefined) m.set(item.id, item);
    }
    return m;
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

/** 班级显示名：grade + name（与旧导出风格一致），否则 name。 */
function displayName(item) {
    if (!item) return '';
    const grade = item.grade ? String(item.grade) : '';
    const name = item.name ? String(item.name) : '';
    return (grade + name) || item.id || '';
}

function clampDim(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}
