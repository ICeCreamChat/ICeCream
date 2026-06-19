/**
 * timetable-v2 / constraints / base.js
 *
 * 约束统一接口（决策 4：可插拔模块，禁止单巨函数）。
 * 每类约束一个文件，经 registry 注册，index-builder 在 precompute 阶段编译成查找矩阵。
 *
 * 硬/软强度统一用 weight 表达（决策 6）：hard 视为 weight=100/必守；soft weight<100。
 * 本阶段只跑硬约束；软约束 pressure() 占位，评分实现在 Phase 2。
 */

export const STRENGTH = Object.freeze({ HARD: 'hard', SOFT: 'soft' });

/**
 * 约束基类。子类至少实现 isFeasible（硬约束）或 pressure（软约束）。
 */
export class Constraint {
    /**
     * @param {object} dsl 规范化后的约束 DSL 对象
     */
    constructor(dsl) {
        this.id = dsl.id;
        this.type = dsl.type;
        this.strength = dsl.strength;
        this.weight = dsl.weight;
        this.scope = dsl.scope;
        this.target = dsl.target;
        this.params = dsl.params ?? {};
        this.source = dsl.source ?? null;
    }

    get isHard() {
        return this.strength === STRENGTH.HARD || this.weight >= 100;
    }

    /**
     * precompute：把自身编译进上下文的查找矩阵。默认无操作。
     * @param {object} ctx index-builder 构建的上下文（含 indexes、calendar、矩阵）
     */
    compile(ctx) { /* override in subclass */ }

    /**
     * 硬约束可行性检查：给定活动在某 time/room 放置是否可行。
     * 返回 true 表示可行；返回冲突活动下标数组表示与这些活动冲突。
     * 默认可行（软约束不参与硬可行性）。
     * @returns {true | number[]}
     */
    isFeasible(activityIdx, time, room, state, ctx) {
        return true;
    }

    /**
     * 软约束压力（Phase 2 实现）：返回该活动在某起点 time 放置时的压力增量（越大越不该放）。
     * 硬约束不参与；软约束子类覆盖。默认 0。
     */
    pressure(activityIdx, time, room, state, ctx) {
        return 0;
    }
}

/**
 * 软约束概率执行（FET skipRandom，generate.cpp:4287）：
 *   weight>=100 必守；weight<0 忽略；否则按 weight% 概率本次"当作硬约束"。
 * rng 必须是种子化 RNG，否则破坏复现性。
 * @param {number} weight
 * @param {() => number} rng [0,1)
 * @returns {boolean} 本次是否强制执行
 */
export function shouldEnforce(weight, rng) {
    if (weight >= 100) return true;
    if (weight < 0) return false;
    return rng() * 100 < weight;
}
