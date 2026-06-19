/**
 * timetable-v2 / solver / pipeline.js
 *
 * 主流程编排（build-guide §4.1 的 10 步）。输入 SchoolProjectV2，输出零硬冲突解，
 * 排不满时返回增量最优部分解 + 结构化 unplaced/hardConflicts（决策 5）。
 *
 * 纯逻辑、零 IO。
 */

import { createProject } from '../domain/project.js';
import { expandActivityPlans } from '../domain/activity.js';
import { createSolution } from '../domain/solution.js';
import { buildContext, detectHardConflicts } from '../constraints/index-builder.js';
import { createRng } from './rng.js';
import { calculateActivityDifficulty } from './difficulty.js';
import { constructInitialSolution } from './construct.js';
import { localImproveSoftScore } from './improve.js';
import { softScoreOf } from './score.js';
import { auditInputData } from './audit.js';

/**
 * 求解入口。
 * @param {object} rawProject SchoolProjectV2（裸对象或已 createProject）
 * @param {object} [opts]
 * @param {number} [opts.seed=1] 种子（同 seed 同结果）
 * @param {object} [opts.limits] 递归换位限制覆盖
 * @param {number} [opts.improveBudget=200] 局部优化预算
 * @returns {{ solution, placements, unplaced, hardConflicts, softScore, audit, stats }}
 */
export function solve(rawProject, opts = {}) {
    const seed = opts.seed ?? 1;
    const rng = createRng(seed);

    // 1. normalize（createProject 已做校验+规范化）
    const project = rawProject.calendar && rawProject.activityPlans && rawProject.__normalized
        ? rawProject
        : createProject(rawProject);

    // 3. expand
    const activities = expandActivityPlans(project.activityPlans);

    // 2. audit（在 expand 后可识别课时矛盾）
    const audit = auditInputData(project, activities);

    // 4. buildIndexes + 约束编译
    const ctx = buildContext(project, activities, project.constraints);

    const solution = createSolution(activities.length);

    // 锁定活动先就位（固定课/锁定课不参与构造随机）
    seedLockedActivities(ctx, solution);

    // 5. difficulty
    const order = calculateActivityDifficulty(ctx, rng)
        .filter(idx => !isPreseeded(ctx, idx, solution));

    // 6+7. construct（含递归换位）
    const { occ, unplaced } = constructInitialSolution(ctx, solution, order, rng, opts.limits);

    // 8. localImprove
    const state = { rng, occ };
    const improve = localImproveSoftScore(ctx, solution, state, opts.improveBudget ?? 200);

    // 9. diagnostics（本阶段只产结构化原始数据）
    const hardConflicts = detectHardConflicts(solution, ctx);
    const unplacedInfo = unplaced.map(idx => ({
        activityIdx: idx,
        activityId: ctx.activities[idx].id,
        planId: ctx.activities[idx].planId,
        reason: explainUnplaced(ctx, solution, idx),
    }));

    // 10. return
    return {
        solution,
        ctx,
        placements: solution.placements().map(p => ({
            activityId: ctx.activities[p.idx].id,
            ...decode(ctx, p),
        })),
        unplaced: unplacedInfo,
        hardConflicts,
        softScore: softScoreOf(ctx, solution),
        audit,
        stats: {
            seed,
            total: activities.length,
            placed: solution.placedCount,
            unplaced: unplacedInfo.length,
            improveAccepted: improve.accepted,
        },
    };
}

function decode(ctx, p) {
    const dp = ctx.calendar.decodeTime(p.time);
    return {
        day: dp?.day ?? null,
        period: dp?.period ?? null,
        roomId: p.room >= 0 ? ctx.indexes.rooms.toId(p.room) : null,
        duration: ctx.meta[p.idx].duration,
        weekPattern: ctx.meta[p.idx].weekPattern,
    };
}

/** 锁定活动（locked + fixedTime）直接就位。 */
function seedLockedActivities(ctx, solution) {
    ctx.meta.forEach((m, idx) => {
        if (m.locked && m.fixedTime !== null && m.fixedTime !== undefined) {
            solution.move(idx, m.fixedTime, -1);
        }
    });
}

function isPreseeded(ctx, idx, solution) {
    return solution.timeOf(idx) !== -1;
}

/** 未排活动的结构化阻塞原因（本阶段仅原始数据，人类语言归因留 Phase 4）。 */
function explainUnplaced(ctx, solution, idx) {
    const m = ctx.meta[idx];
    return {
        type: 'no_feasible_slot',
        duration: m.duration,
        teacherIdxs: m.teacherIdxs,
        classIdxs: m.classIdxs,
        note: '在所有合法候选时段均与已排活动硬冲突，且递归换位未能腾出位置',
    };
}
