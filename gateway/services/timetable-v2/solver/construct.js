/**
 * timetable-v2 / solver / construct.js
 *
 * 构造初始解：按难度序逐个放置活动。
 * 候选位用三遍渐宽过滤（严格→放宽软约束→仅守硬约束）+ 加权随机抽样（水晶 rng_retry_mapping.md §4）。
 * 无零冲突候选时调用递归换位（swap.js）。
 *
 * 纯逻辑、零 IO。
 */

import { weightedPick } from './rng.js';
import { OccupancyIndex, legalStartTimes } from './placement.js';
import { scoreCandidates } from './pressure.js';
import { resolveByRecursiveSwap } from './swap.js';
import { shouldEnforce } from '../constraints/base.js';
import { NO_ROOM } from '../domain/calendar.js';

/**
 * 构造初始解。
 * @param {object} ctx
 * @param {import('../domain/solution.js').Solution} solution 空解（会被原地填充）
 * @param {number[]} order 难度降序的活动 idx
 * @param {() => number} rng
 * @param {object} [limits]
 * @returns {{ occ:OccupancyIndex, unplaced:number[], best:number }}
 */
export function constructInitialSolution(ctx, solution, order, rng, limits = {}) {
    const occ = new OccupancyIndex(ctx);
    // 预置活动（锁定课/固定课已 move 进 solution）须先登记进占用索引，
    // 否则构造期会把别的活动排到它们的时段上造成冲突。
    occ.rebuildFrom(solution);
    const state = {
        occ,
        triedRemovals: new Map(), // `idx@time` → 次数
        calls: 0,
        maxCalls: limits.maxCalls ?? 2 * ctx.activities.length,
        maxDepth: limits.maxDepth ?? 14,
        shallowLimit: limits.shallowLimit ?? 5,
        maxBlockers: limits.maxBlockers ?? 6,
        rng,
    };

    const unplaced = [];
    let best = 0;

    for (const idx of order) {
        const placed = placeActivity(ctx, solution, idx, state);
        if (placed) {
            best = solution.placedCount;
        } else {
            // 零冲突放不下 → 递归换位尝试
            const ok = resolveByRecursiveSwap(ctx, solution, idx, state);
            if (ok) best = solution.placedCount;
            else unplaced.push(idx);
        }
    }

    return { occ, unplaced, best };
}

/**
 * 尝试把活动放到一个"零硬冲突"的候选位。
 * 三遍渐宽过滤（水晶 rng_retry_mapping.md §4）：
 *   pass 0 严格：零硬冲突 且 通过软约束概率过滤（shouldEnforce 当作硬约束的软约束须满足）
 *   pass 1 放宽：零硬冲突，忽略软约束
 *   pass 2 仅硬：与 pass 1 同（硬冲突永不放宽）——保留分层以备 Phase 后续细化
 * 候选位按压力权重加权随机抽样。成功则 move + 更新 occ，返回 true。
 */
export function placeActivity(ctx, solution, idx, state) {
    const cands = legalStartTimes(ctx, idx);
    if (cands.length === 0) return false;

    // 零硬冲突候选（教师/班级层面）
    const free = cands.filter(start => state.occ.blockersAt(idx, start).length === 0);
    if (free.length === 0) return false;

    // 软约束概率过滤：本次"被强制执行"的软约束，其 pressure>0 的候选位被排除。
    const enforced = enforcedSofts(ctx, state.rng);
    let pool = free;
    if (enforced.length > 0) {
        const strict = free.filter(start => !violatesEnforced(enforced, idx, start, solution, ctx));
        if (strict.length > 0) pool = strict; // pass 0 成功；否则退回 pass 1（全部 free）
    }

    const weights = scoreCandidates(ctx, idx, pool, state.occ, solution);
    const pick = weightedPick(state.rng, weights);
    const start = pool[pick >= 0 ? pick : 0];
    const finalRoom = chooseRoom(ctx, idx, start, state);

    solution.move(idx, start, finalRoom);
    state.occ.place(idx, start, finalRoom);
    return true;
}

/** 本次构造决策中"被概率选中当作硬约束"的软约束集合（FET skipRandom）。 */
function enforcedSofts(ctx, rng) {
    const out = [];
    for (const c of ctx.constraints) {
        if (c.isHard || typeof c.pressure !== 'function') continue;
        if (shouldEnforce(c.weight, rng)) out.push(c);
    }
    return out;
}

/** 该候选位是否违反任一被强制执行的软约束（pressure>0 视为违反）。 */
function violatesEnforced(enforced, idx, start, solution, ctx) {
    for (const c of enforced) {
        if ((c.pressure(idx, start, undefined, solution, ctx) || 0) > 0) return true;
    }
    return false;
}

/**
 * 教室选择（简化版）：从 allowedRooms 里选一个在该 time 空闲的；无需求则 NO_ROOM。
 */
export function chooseRoom(ctx, idx, start, state) {
    const rooms = ctx.meta[idx].roomIdxs;
    if (!rooms || rooms.length === 0) return NO_ROOM;
    for (const r of rooms) {
        let free = true;
        for (const t of ctx.occupiedTimes(idx, start)) {
            const set = state.occ.room.get(r * 100000 + t);
            if (set && set.size > 0) { free = false; break; }
        }
        if (free) return r;
    }
    return rooms[0]; // 都不空也先占第一个（room_clash 会在检测时暴露，留给 swap/improve）
}
