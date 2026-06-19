/**
 * timetable-v2 / solver / difficulty.js
 *
 * 活动难度排序（FET generate_pre.cpp:1533）。最难先排，提速并改善收敛。
 *   主键：nIncompatible —— 与该活动不能同时段的其他活动数（共享教师/班级 ⇒ 不相容）
 *   次键：duration（连堂更难放）、候选槽更少（约束更紧）更难
 *   再平局：种子化 RNG，保证同输入稳定
 *
 * 纯函数、零 IO。
 */

import { shuffle } from './rng.js';

/**
 * 计算每个活动的 nIncompatible：与之共享教师或班级的其他活动数。
 * （共享资源 ⇒ 不能同时段 ⇒ 排布时互相挤占，越多越难。）
 * @param {object} ctx buildContext 产物
 * @returns {Int32Array} 下标=活动 idx
 */
export function computeIncompatibility(ctx) {
    const n = ctx.activities.length;
    const inc = new Int32Array(n);
    // 用资源→活动倒排，再两两计数（避免 O(n²) 全比）
    const byTeacher = new Map();
    const byClass = new Map();
    ctx.meta.forEach((m, idx) => {
        for (const t of m.teacherIdxs) push(byTeacher, t, idx);
        for (const c of m.classIdxs) push(byClass, c, idx);
    });
    const neighbors = Array.from({ length: n }, () => new Set());
    for (const group of [byTeacher, byClass]) {
        for (const list of group.values()) {
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    neighbors[list[i]].add(list[j]);
                    neighbors[list[j]].add(list[i]);
                }
            }
        }
    }
    for (let i = 0; i < n; i++) inc[i] = neighbors[i].size;
    return inc;
}

/**
 * 返回按难度降序排列的活动 idx 数组（permutation）。
 * @param {object} ctx
 * @param {() => number} rng 种子化 RNG（平局打散）
 * @returns {number[]}
 */
export function calculateActivityDifficulty(ctx, rng) {
    const n = ctx.activities.length;
    const inc = computeIncompatibility(ctx);
    const order = Array.from({ length: n }, (_, i) => i);

    // 先用 RNG 洗牌，再稳定排序 → 平局项顺序由 seed 决定，可复现。
    shuffle(rng, order);
    order.sort((a, b) => {
        if (inc[a] !== inc[b]) return inc[b] - inc[a];           // 主键：不相容数降序
        const da = ctx.meta[a].duration, db = ctx.meta[b].duration;
        if (da !== db) return db - da;                            // 次键：连堂更难
        const ra = ctx.meta[a].roomIdxs.length, rb = ctx.meta[b].roomIdxs.length;
        // 教室需求越少（越受限）越难；0 视为不限教室，排后
        const fa = ra === 0 ? Infinity : ra, fb = rb === 0 ? Infinity : rb;
        if (fa !== fb) return fa - fb;
        return 0;                                                 // 再平局：保持洗牌后的相对序
    });
    return order;
}

function push(map, key, val) {
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    arr.push(val);
}
