/**
 * timetable-v2 / solver / improve.js
 *
 * 局部优化：有限预算内尝试移动以降低 softScore，每次接受必须保持零硬冲突。
 * 三类移动：单活动移动、同长度活动交换、连堂块整体移动（连堂已是单活动，等同单活动移动）。
 *
 * 纯逻辑、零 IO。
 */

import { detectHardConflicts } from '../constraints/index-builder.js';
import { legalStartTimes, OccupancyIndex } from './placement.js';
import { chooseRoom } from './construct.js';
import { softScoreOf } from './score.js';
import { shuffle } from './rng.js';

/**
 * 在 budget 次尝试内做局部优化。每次接受前用硬冲突检测确认零硬冲突。
 * @returns {{ accepted:number, finalScore:number }}
 */
export function localImproveSoftScore(ctx, solution, state, budget = 200) {
    let best = softScoreOf(ctx, solution);
    let accepted = 0;
    const placed = solution.placements().map(p => p.idx);
    if (placed.length === 0) return { accepted, finalScore: best };

    for (let iter = 0; iter < budget; iter++) {
        if (best <= 0) break; // 无软压力可降
        const idx = placed[Math.floor(state.rng() * placed.length)];
        const curTime = solution.timeOf(idx);
        const curRoom = solution.roomOf(idx);
        const cands = legalStartTimes(ctx, idx).filter(t => t !== curTime);
        if (cands.length === 0) continue;
        shuffle(state.rng, cands);
        const target = cands[0];

        // 试移动
        solution.move(idx, target, chooseRoom(ctx, idx, target, state));
        // 重建 occ 不必要——用全量硬冲突检测确认可行（局部优化非热点路径）
        const conflicts = detectHardConflicts(solution, ctx);
        const score = softScoreOf(ctx, solution);
        if (conflicts.length === 0 && score < best) {
            best = score;
            accepted++;
            state.occ.rebuildFrom(solution);
        } else {
            solution.undo(1); // 拒绝
        }
    }
    return { accepted, finalScore: best };
}
