/**
 * timetable-v2 / constraints / index-builder.js
 *
 * precompute：把项目 + 展开活动 + 约束编译成查找上下文 ctx，供约束的 compile/detect 使用。
 *
 * ctx 契约（硬约束实现依赖以下字段）：
 *   ctx.calendar                 日历（encodeTime/decodeTime/isValidTime/sameDay/nDays...）
 *   ctx.indexes                  { classes, teachers, subjects, rooms, plans, activities }（见 ids.js）
 *   ctx.activities               展开后的 Activity 数组（下标 = 活动内部 idx）
 *   ctx.meta[idx]                { teacherIdxs[], classIdxs[], subjectIdx, roomIdxs[],
 *                                  duration, weekPattern, locked, fixedTime }
 *   ctx.occupiedTimes(idx, t)    活动从 time t 起占用的全部 time（连堂：t, t+nDays, ...）
 *   ctx.constraints              Constraint 实例数组
 *   ctx.constraintsByType        Map<type, Constraint[]>
 *   ctx.shared                   约束 compile 阶段写入的共享矩阵（如不可用时段集合）
 *
 * 纯逻辑、零 IO。
 */

import { buildIndexes } from '../domain/ids.js';
import { parseConstraints, HARD_TYPES } from './dsl.js';
import { getConstraintClass } from './registry.js';

/**
 * 无参全局硬约束：与具体 target/params 无关，任何项目都必检。
 * 即使用户未在 DSL 显式声明，buildContext 也会自动播种，避免空约束项目
 * 得到危险的假"无冲突"结论。fixed_locked 也自动播种以处理 Activity 自带的
 * locked/fixedTime（具体锁定 target 仍可由额外 DSL 追加）。
 */
const ALWAYS_ON_HARD = Object.freeze([
    'teacher_clash', 'class_clash', 'room_clash', 'valid_timeslot', 'consecutive', 'fixed_locked',
]);

/**
 * 构建约束上下文。
 * @param {object} project 已 createProject 的项目
 * @param {object[]} activities 已 expandActivityPlans 的活动
 * @param {object[]} [rawConstraints] 约束 DSL（默认取 project.constraints）
 * @returns {object} ctx
 */
export function buildContext(project, activities, rawConstraints = null) {
    const calendar = project.calendar;
    const indexes = buildIndexes(project, activities);

    const meta = activities.map(a => ({
        teacherIdxs: a.teacherIds.map(id => indexes.teachers.toIndex(id)).filter(i => i >= 0),
        classIdxs: a.classIds.map(id => indexes.classes.toIndex(id)).filter(i => i >= 0),
        subjectIdx: indexes.subjects.toIndex(a.subjectId),
        roomIdxs: (a.allowedRooms || []).map(id => indexes.rooms.toIndex(id)).filter(i => i >= 0),
        duration: a.duration,
        weekPattern: a.weekPattern,
        locked: !!a.locked,
        fixedTime: a.fixedTime ?? null,
    }));

    const nDays = calendar.nDays;

    const ctx = {
        project,
        calendar,
        indexes,
        activities,
        meta,
        shared: {},

        /** 连堂占用的全部 time：从 startTime 起，每节 +nDays（同 day、连续 period）。 */
        occupiedTimes(idx, startTime) {
            const d = meta[idx].duration;
            const out = new Array(d);
            for (let k = 0; k < d; k++) out[k] = startTime + k * nDays;
            return out;
        },
    };

    const dslList = parseConstraints(rawConstraints ?? project.constraints ?? []);

    // 自动播种无参全局硬约束（若用户未显式声明）。
    const declaredTypes = new Set(dslList.map(d => d.type));
    const seeded = [];
    for (const type of ALWAYS_ON_HARD) {
        if (!declaredTypes.has(type)) seeded.push({ type });
    }
    const allDsl = [...parseConstraints(seeded), ...dslList];

    const constraints = [];
    const byType = new Map();
    for (const dsl of allDsl) {
        const Ctor = getConstraintClass(dsl.type);
        if (!Ctor) {
            // 硬约束取不到实现 = 未 import 触发自注册，属配置错误，不可静默放行。
            if (HARD_TYPES.includes(dsl.type)) {
                throw new Error(`index-builder: 硬约束 "${dsl.type}" 未注册（确认已 import timetable-v2/index.js 触发自注册）`);
            }
            continue; // 软约束本阶段未实现，仅保留 DSL 形态，跳过实例化
        }
        const inst = new Ctor(dsl);
        constraints.push(inst);
        if (!byType.has(dsl.type)) byType.set(dsl.type, []);
        byType.get(dsl.type).push(inst);
    }
    ctx.constraints = constraints;
    ctx.constraintsByType = byType;
    ctx.dsl = allDsl;

    // 让每个约束把自身编译进共享矩阵。
    for (const c of constraints) c.compile(ctx);

    return ctx;
}

/**
 * 硬冲突检测入口：对给定解运行所有硬约束的 detect，汇总结构化冲突列表。
 * @param {import('../domain/solution.js').Solution} solution
 * @param {object} ctx buildContext 产物
 * @returns {Array<{type:string, activities:number[], time:number|null, detail?:string}>}
 */
export function detectHardConflicts(solution, ctx) {
    const conflicts = [];
    for (const c of ctx.constraints) {
        if (!c.isHard || typeof c.detect !== 'function') continue;
        const found = c.detect(solution, ctx);
        if (found && found.length) conflicts.push(...found);
    }
    return conflicts;
}
