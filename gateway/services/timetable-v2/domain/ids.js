/**
 * timetable-v2 / domain / ids.js
 *
 * 名字/业务 ID ↔ 连续整型下标的双向编译表（FET computeInternalStructure 思路）。
 * 求解期只跑整数与 TypedArray；domain 对外用业务 ID，内部矩阵用整型下标。
 *
 * 纯函数、零 IO。
 */

/**
 * 从一组业务 ID 建立双向索引表。
 * @param {string[]} ids 业务 ID 列表（按出现顺序分配下标 0..n-1）
 * @returns {{ size:number, toIndex(id):number, toId(idx):string, ids:string[], has(id):boolean }}
 */
export function createIndex(ids = []) {
    const list = [];
    const idToIndex = new Map();
    for (const raw of ids) {
        const id = String(raw);
        if (idToIndex.has(id)) continue; // 去重，保持首次顺序
        idToIndex.set(id, list.length);
        list.push(id);
    }
    return {
        size: list.length,
        ids: list,
        has(id) {
            return idToIndex.has(String(id));
        },
        /** 业务 ID → 下标；未知返回 -1。 */
        toIndex(id) {
            const idx = idToIndex.get(String(id));
            return idx === undefined ? -1 : idx;
        },
        /** 下标 → 业务 ID；越界返回 undefined。 */
        toId(idx) {
            return list[idx];
        },
    };
}

/**
 * 为一个项目构建全部实体的索引集合（class/teacher/subject/room/activity）。
 * @param {object} project 规范化后的 SchoolProjectV2
 * @param {object[]} [activities] 已展开的 Activity 列表（可选；展开后再调用）
 */
export function buildIndexes(project, activities = null) {
    const indexes = {
        classes: createIndex((project.classes || []).map(c => c.id)),
        teachers: createIndex((project.teachers || []).map(t => t.id)),
        subjects: createIndex((project.subjects || []).map(s => s.id)),
        rooms: createIndex((project.rooms || []).map(r => r.id)),
        plans: createIndex((project.activityPlans || []).map(p => p.id)),
    };
    if (activities) {
        indexes.activities = createIndex(activities.map(a => a.id));
    }
    return indexes;
}
