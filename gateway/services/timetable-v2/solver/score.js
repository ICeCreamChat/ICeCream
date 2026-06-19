/**
 * timetable-v2 / solver / score.js
 *
 * 软约束评分汇总。softScore 仅用于报告与多解择优（决策 3），不驱动全局目标函数。
 * 越低越好（0 = 无软违反/压力）。
 *
 * 纯函数、零 IO。
 */

/**
 * 当前解的 softScore：所有软约束 pressure 之和（按 weight 加权）。
 * @param {object} ctx
 * @param {import('../domain/solution.js').Solution} solution
 */
export function softScoreOf(ctx, solution) {
    const softs = ctx.constraints.filter(c => !c.isHard && typeof c.pressure === 'function');
    if (softs.length === 0) return 0;
    let total = 0;
    for (const { idx, time } of solution.placements()) {
        for (const c of softs) {
            const p = c.pressure(idx, time, undefined, solution, ctx) || 0;
            total += p * (c.weight / 100);
        }
    }
    return total;
}
