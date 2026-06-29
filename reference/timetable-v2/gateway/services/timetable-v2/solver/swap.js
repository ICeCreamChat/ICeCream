/**
 * timetable-v2 / solver / swap.js
 *
 * 递归换位 / ejection chain（FET generate.cpp:10002 + 水晶教师弹出链）。
 * 当活动找不到零冲突位：选一个冲突最少的候选位 → 弹出 blocker → 放入当前活动 →
 * 递归为 blocker 找新位 → 全部成功则提交，否则 undo 回滚到 restore point。
 *
 * 限制（决策 2，全部可配）：maxDepth=14、maxCalls=2n、shallowLimit=5、maxBlockers、
 * tabu(triedRemovals) 防循环。回溯用 Phase 1 Solution.undo 零拷贝。
 *
 * 纯逻辑、零 IO。
 */

import { legalStartTimes } from './placement.js';
import { chooseRoom } from './construct.js';
import { shuffle } from './rng.js';

/**
 * 对一个未放置活动尝试递归换位。
 * @returns {boolean} 是否成功安置（含因换位重排成功）
 */
export function resolveByRecursiveSwap(ctx, solution, idx, state) {
    return swap(ctx, solution, idx, 0, state);
}

function swap(ctx, solution, idx, depth, state) {
    if (depth >= state.maxDepth) return false;
    if (state.calls >= state.maxCalls) return false;
    state.calls++;

    const cands = legalStartTimes(ctx, idx);
    if (cands.length === 0) return false;

    // 计算每个候选位的 blocker 集合，按 blocker 数升序（最空在前）。
    const scored = cands.map(start => ({ start, blockers: state.occ.blockersAt(idx, start) }));

    // 零冲突位：直接放（理论上 construct 已试过，但换位过程中状态变了，可能出现新空位）
    for (const s of scored) {
        if (s.blockers.length === 0) {
            const room = chooseRoom(ctx, idx, s.start, state);
            if (room === null) continue; // 无空闲教室，非真正零冲突位
            solution.move(idx, s.start, room);
            state.occ.place(idx, s.start, room);
            return true;
        }
    }

    // 浅层全回溯，深层只试最优槽（FET level≥5 单槽剪枝）
    const ordered = orderCandidates(scored, ctx, state);
    const tryList = depth < state.shallowLimit ? ordered : ordered.slice(0, 1);
    for (const cand of tryList) {
        if (cand.blockers.length > state.maxBlockers) continue;
        if (state.calls >= state.maxCalls) break;

        // restore point
        const restoreLen = solution.historyLength;
        const ejected = [];

        // 弹出全部 blocker（含同教师冲突行 + 教室占用者——blockersAt 已含教师/班级/教室维度）
        for (const b of cand.blockers) {
            const bt = solution.timeOf(b);
            const br = solution.roomOf(b);
            ejected.push({ idx: b, time: bt, room: br });
            state.occ.unplace(b, bt, br);
            solution.move(b, -1, -1); // UNALLOCATED
            bumpTabu(state, b, bt);
        }
        // 放入当前活动（弹出 blocker 后教室应已腾出；若仍无则回滚此候选）
        const room = chooseRoom(ctx, idx, cand.start, state);
        if (room === null) {
            solution.undo(solution.historyLength - restoreLen);
            state.occ.rebuildFrom(solution);
            continue;
        }
        solution.move(idx, cand.start, room);
        state.occ.place(idx, cand.start, room);

        // 递归为被弹出的活动找新位（按难度——这里按 blocker 顺序）
        let ok = true;
        for (const e of ejected) {
            if (!swap(ctx, solution, e.idx, depth + 1, state)) { ok = false; break; }
        }
        if (ok) return true;

        // 失败：undo 到 restore point（含递归中产生的所有 move），再从解全量重建 occ，
        // 保证 occ 与 solution 严格一致（递归可能移动了 ejected 之外的活动）。
        solution.undo(solution.historyLength - restoreLen);
        state.occ.rebuildFrom(solution);
    }
    return false;
}

/**
 * 被驱逐活动多键择优排序（FET generate.cpp:37183）：
 *   主键：候选位 blocker 的累计被踢次数（tabu，越少越优先，防循环）
 *   次键：blocker 数（越少越优先）
 *   平局：种子化 RNG 打散，可复现
 */
function orderCandidates(scored, ctx, state) {
    const copy = scored.slice();
    shuffle(state.rng, copy); // 平局打散，可复现
    const tabuOf = cand => cand.blockers.reduce(
        (s, b) => s + (state.triedRemovals.get(`${b}@${cand.start}`) || 0), 0,
    );
    copy.sort((a, b) => {
        const ta = tabuOf(a), tb = tabuOf(b);
        if (ta !== tb) return ta - tb;                 // tabu：被踢少的优先
        return a.blockers.length - b.blockers.length;  // 冲突少的优先
    });
    return copy;
}

function bumpTabu(state, idx, time) {
    const k = `${idx}@${time}`;
    state.triedRemovals.set(k, (state.triedRemovals.get(k) || 0) + 1);
}
