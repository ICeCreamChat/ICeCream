/**
 * timetable-v2 / diagnostics / explain.js
 *
 * 归因解释器：把求解器的机器结构（unplaced 下标 / hardConflicts / 软约束 pressure）
 * 翻译成人类可读、可定位（具体班级/教师/课程/星期几第几节）的诊断。
 *
 * 只读消费 (project, solution, ctx)，绝不改解、不重跑求解。纯函数、零 IO。
 * 决策 2/3：反解 ids 下标 + 复用约束元数据；未排分 no-candidate / all-blocked 两类。
 */

import { legalStartTimes, OccupancyIndex } from '../solver/placement.js';
import { UNALLOCATED } from '../domain/calendar.js';

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function weekdayName(day) {
    return WEEKDAY_CN[day] || `第${day}天`;
}

/** time → "周一第3节" 可读串。 */
function timeLabel(ctx, time) {
    const dp = ctx.calendar.decodeTime(time);
    if (!dp) return `时段#${time}`;
    return `${weekdayName(dp.day)}第${dp.period}节`;
}

/** 构造 id→显示名查找（缺名回退 id）。 */
function nameMaps(project) {
    const mk = (arr) => {
        const m = new Map();
        for (const it of arr || []) m.set(it.id, it.name || it.id);
        return m;
    };
    return {
        teacher: mk(project.teachers),
        klass: mk(project.classes),
        subject: mk(project.subjects),
        room: mk(project.rooms),
    };
}

/** 活动 idx → { activityId, teachers[], classes[], subject } 显示名。 */
function describeActivity(ctx, names, idx) {
    const m = ctx.meta[idx];
    const teachers = m.teacherIdxs.map(i => names.teacher.get(ctx.indexes.teachers.toId(i)) ?? ctx.indexes.teachers.toId(i));
    const classes = m.classIdxs.map(i => names.klass.get(ctx.indexes.classes.toId(i)) ?? ctx.indexes.classes.toId(i));
    const subjectId = ctx.indexes.subjects.toId(m.subjectIdx);
    const subject = names.subject.get(subjectId) ?? subjectId;
    return { activityId: ctx.activities[idx].id, teachers, classes, subject };
}

/** 当前解里所有未排活动的内部 idx。 */
function unplacedIdxs(ctx, solution) {
    const out = [];
    for (let idx = 0; idx < ctx.activities.length; idx++) {
        if (solution.timeOf(idx) === UNALLOCATED) out.push(idx);
    }
    return out;
}

/**
 * 找出导致某活动"在所有时段都不合法"的根因约束（no-candidate 专用）。
 * 检查：教师不可用是否覆盖、班级不可用是否覆盖、连堂是否过长。
 */
function rootConstraintsFor(ctx, names, idx) {
    const m = ctx.meta[idx];
    const roots = [];
    // 连堂过长：duration 超过每天节数
    if (m.duration > ctx.calendar.nPeriods) {
        roots.push({
            kind: 'consecutive-too-long',
            message: `连堂时长 ${m.duration} 超过每天节数 ${ctx.calendar.nPeriods}，任何一天都放不下`,
        });
    }
    // 教师/班级不可用约束（关联到该活动的资源）
    for (const c of ctx.constraints) {
        if (c.type === 'teacher_unavailable') {
            const tIdx = ctx.indexes.teachers.toIndex(c.target?.teacherId);
            if (m.teacherIdxs.includes(tIdx)) {
                roots.push({
                    kind: 'teacher_unavailable',
                    teacher: names.teacher.get(c.target.teacherId) ?? c.target.teacherId,
                    source: c.source ?? null,
                    message: `教师 ${names.teacher.get(c.target.teacherId) ?? c.target.teacherId} 的不可用时段限制`,
                });
            }
        } else if (c.type === 'class_unavailable') {
            const cIdx = ctx.indexes.classes.toIndex(c.target?.classId);
            if (m.classIdxs.includes(cIdx)) {
                roots.push({
                    kind: 'class_unavailable',
                    klass: names.klass.get(c.target.classId) ?? c.target.classId,
                    source: c.source ?? null,
                    message: `班级 ${names.klass.get(c.target.classId) ?? c.target.classId} 的不可用时段限制`,
                });
            }
        }
    }
    return roots;
}

/**
 * 对每个未排活动给出可读归因。
 * @returns {Array<{activityId,planId,kind,teachers,classes,subject,rootConstraints?,blockers?,triedSlots?,message}>}
 */
export function explainUnplaced(project, solution, ctx) {
    const names = nameMaps(project);
    const occ = new OccupancyIndex(ctx);
    occ.rebuildFrom(solution);

    return unplacedIdxs(ctx, solution).map(idx => {
        const desc = describeActivity(ctx, names, idx);
        const planId = ctx.activities[idx].planId ?? null;
        const legal = legalStartTimes(ctx, idx);

        if (legal.length === 0) {
            const roots = rootConstraintsFor(ctx, names, idx);
            const rootMsg = roots.length
                ? roots.map(r => r.message).join('；')
                : '在任何合法时段都无候选位（结构性不可排）';
            return {
                ...desc, planId, kind: 'no-candidate',
                rootConstraints: roots,
                message: `${desc.subject}（${desc.classes.join('、')} / ${desc.teachers.join('、')}）无法安置：${rootMsg}`,
            };
        }

        // all-blocked：有合法候选位但都被占。收集 blocker。
        const blockerSet = new Set();
        const triedSlots = [];
        for (const start of legal) {
            const bs = occ.blockersAt(idx, start);
            triedSlots.push(timeLabel(ctx, start));
            for (const b of bs) blockerSet.add(b);
        }
        if (blockerSet.size === 0) {
            // 有空位却未排：信息不足，不编造
            return {
                ...desc, planId, kind: 'incomplete',
                triedSlots,
                message: `${desc.subject} 存在 ${legal.length} 个合法候选位但未被排入，原因不完整（可能为换位预算耗尽）；已知候选时段：${triedSlots.slice(0, 6).join('、')}`,
            };
        }
        const blockers = [...blockerSet].map(b => {
            const bd = describeActivity(ctx, names, b);
            const t = solution.timeOf(b);
            const dp = t !== UNALLOCATED ? ctx.calendar.decodeTime(t) : null;
            return {
                activityId: bd.activityId,
                classes: bd.classes, teachers: bd.teachers, subject: bd.subject,
                day: dp?.day ?? null, period: dp?.period ?? null,
                timeLabel: t !== UNALLOCATED ? timeLabel(ctx, t) : null,
            };
        });
        return {
            ...desc, planId, kind: 'all-blocked',
            blockers, triedSlots,
            message: `${desc.subject}（${desc.classes.join('、')} / ${desc.teachers.join('、')}）的候选时段均被占用：${blockers.map(b => `${b.subject}@${b.timeLabel ?? '?'}`).slice(0, 4).join('、')}${blockers.length > 4 ? ' 等' : ''}`,
        };
    });
}

/**
 * 把硬冲突翻译成自然语言定位。
 * @returns {Array<{type,resourceKind,resourceName,day,period,activities,constraintSource,message}>}
 */
export function explainHardConflicts(project, solution, ctx, hardConflicts) {
    const names = nameMaps(project);
    const conflicts = hardConflicts ?? detectViaCtx(solution, ctx);
    return conflicts.map(cf => {
        const acts = (cf.activities ?? []).map(idx => describeActivity(ctx, names, idx));
        const dp = cf.time != null ? ctx.calendar.decodeTime(cf.time) : null;
        const resInfo = resolveResource(ctx, names, cf);
        const src = sourceForType(ctx, cf.type);
        const when = dp ? `${weekdayName(dp.day)}第${dp.period}节` : '某时段';
        const what = acts.map(a => `${a.classes.join('、')}${a.subject}`).join(' 和 ');
        return {
            type: cf.type,
            resourceKind: resInfo.kind,
            resourceName: resInfo.name,
            day: dp?.day ?? null, period: dp?.period ?? null,
            activities: acts,
            constraintSource: src,
            message: `${resInfo.label} ${when} 同时要上 ${what}`,
        };
    });
}

function resolveResource(ctx, names, cf) {
    if (cf.type === 'teacher_clash') {
        const id = ctx.indexes.teachers.toId(cf.resource);
        const name = names.teacher.get(id) ?? id;
        return { kind: 'teacher', name, label: `${name} 老师` };
    }
    if (cf.type === 'class_clash') {
        const id = ctx.indexes.classes.toId(cf.resource);
        const name = names.klass.get(id) ?? id;
        return { kind: 'class', name, label: `${name} 班` };
    }
    if (cf.type === 'room_clash') {
        const id = ctx.indexes.rooms.toId(cf.resource);
        const name = names.room.get(id) ?? id;
        return { kind: 'room', name, label: `${name} 教室` };
    }
    return { kind: cf.type, name: String(cf.resource ?? ''), label: cf.type };
}

function sourceForType(ctx, type) {
    const c = ctx.constraints.find(x => x.type === type);
    return c?.source ?? null;
}

function detectViaCtx(solution, ctx) {
    // 兜底：调用方未传 hardConflicts 时本地探测（保持与 index-builder 一致语义）
    const out = [];
    for (const c of ctx.constraints) {
        if (c.isHard && typeof c.detect === 'function') {
            const found = c.detect(solution, ctx);
            if (found && found.length) out.push(...found);
        }
    }
    return out;
}

/**
 * 软规则未满足解释（自评估：solver 只产 softScore，无 qualityIssues）。
 * @returns {Array<{softType,objects,weight,severity,message}>}
 */
export function explainSoftViolations(project, solution, ctx) {
    const names = nameMaps(project);
    const softs = ctx.constraints.filter(c => !c.isHard && typeof c.pressure === 'function');
    const out = [];
    const seen = new Set();
    for (const { idx, time } of solution.placements()) {
        for (const c of softs) {
            const p = c.pressure(idx, time, undefined, solution, ctx) || 0;
            if (p <= 0) continue;
            const key = `${c.type}:${idx}:${time}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const desc = describeActivity(ctx, names, idx);
            out.push({
                softType: c.type,
                objects: { activityId: desc.activityId, classes: desc.classes, teachers: desc.teachers, subject: desc.subject },
                weight: c.weight,
                severity: 'warning',
                message: `软规则未满足[${c.type}]：${desc.subject}（${desc.classes.join('、')}）于 ${timeLabel(ctx, time)}（权重 ${c.weight}）`,
            });
        }
    }
    return out;
}
