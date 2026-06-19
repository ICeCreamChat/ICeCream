/**
 * timetable-v2 / solver / pressure.js
 *
 * 候选位压力评分（水晶 original-pressure，rng_retry_mapping.md）。
 * 候选位排序：拥挤格权重低、剩余负载大权重高。压力归一化防热点格无界增长。
 *
 *   score(slot) = round( total / (slotPressure + 1) * (2*workMetric + 1) )
 *   关联活动加成：score *= (10*relatedWorkMetric + 1)
 *   归一化压缩： norm(raw, denom) = round( (2*raw + 1) / (3*denom*denom + 1) )
 *
 * 魔数来源 rng_retry_mapping.md，行为由单测锁定，勿随手"优化"。
 *
 * 纯函数、零 IO。
 */

/**
 * 压力归一化：把原始命中数压进有界区间，避免少数热点格压力无界膨胀。
 * @param {number} raw 原始累加压力
 * @param {number} denom 该格的竞争规模（如候选活动数）
 */
export function normalizePressure(raw, denom) {
    return Math.round((2 * raw + 1) / (3 * denom * denom + 1));
}

/**
 * 候选位得分。越拥挤越低、剩余负载越大越高。
 * @param {object} args
 * @param {number} args.total 全局压力总量（>0）
 * @param {number} args.slotPressure 该候选格当前承受的压力
 * @param {number} args.workMetric 该活动剩余课时/负载
 * @param {number} [args.relatedWorkMetric] 关联活动（合班/连堂）剩余负载，>0 时加成
 * @returns {number}
 */
export function candidateScore({ total, slotPressure, workMetric, relatedWorkMetric = 0 }) {
    let score = Math.round((total) / (slotPressure + 1) * (2 * workMetric + 1));
    if (relatedWorkMetric > 0) score *= (10 * relatedWorkMetric + 1);
    return score;
}

/**
 * 为一个活动的候选起点列表计算权重（供 weightedPick）。
 * 结合软约束 pressure（越低越优先 → 转成正权重）与拥挤度。
 * @param {object} ctx
 * @param {number} idx 活动 idx
 * @param {number[]} candidates 合法起点列表
 * @param {OccupancyIndex} occ 占用索引（估拥挤度）
 * @param {object} solution 当前解（供软约束 pressure 读状态）
 * @returns {number[]} 与 candidates 等长的权重（>0）
 */
export function scoreCandidates(ctx, idx, candidates, occ, solution) {
    const m = ctx.meta[idx];
    const workMetric = m.duration; // 简化：连堂负载更大
    const softs = ctx.constraintsByType ? collectSoftPressures(ctx) : [];
    const weights = new Array(candidates.length);
    for (let i = 0; i < candidates.length; i++) {
        const start = candidates[i];
        const slotPressure = estimateSlotPressure(ctx, idx, start, occ)
            + sumSoftPressure(softs, idx, start, solution, ctx);
        weights[i] = candidateScore({ total: 1000, slotPressure, workMetric });
        if (weights[i] < 1) weights[i] = 1; // 保证可被抽中
    }
    return weights;
}

/** 拥挤度估计：该活动占用的资源在目标 time 上已有多少其他占用。 */
function estimateSlotPressure(ctx, idx, start, occ) {
    const m = ctx.meta[idx];
    let p = 0;
    for (const t of ctx.occupiedTimes(idx, start)) {
        for (const tt of m.teacherIdxs) p += sizeAt(occ.teacher, tt, t);
        for (const cc of m.classIdxs) p += sizeAt(occ.klass, cc, t);
    }
    return p;
}

function sizeAt(map, res, time) {
    const set = map.get(res * 100000 + time);
    return set ? set.size : 0;
}

function collectSoftPressures(ctx) {
    const out = [];
    for (const c of ctx.constraints) {
        if (!c.isHard && typeof c.pressure === 'function') out.push(c);
    }
    return out;
}

function sumSoftPressure(softs, idx, start, solution, ctx) {
    let s = 0;
    for (const c of softs) {
        s += c.pressure(idx, start, undefined, solution, ctx) || 0;
    }
    return s;
}
