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
     * 软约束压力（Phase 2 实现）。本阶段占位返回 0。
     */
    pressure(activityIdx, time, room, state, ctx) {
        return 0;
    }
}
