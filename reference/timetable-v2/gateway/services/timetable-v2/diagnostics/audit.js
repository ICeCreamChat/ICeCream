/**
 * timetable-v2 / diagnostics / audit.js
 *
 * 输入数据审计（求解前可独立调用）：检出缺对象、课时矛盾、不可能约束并定位。
 * 与 Phase 1 校验互补——Phase 1 判结构合法性（悬空引用/必备字段），
 * 本模块判排课可行性（数量/容量的硬下界矛盾）。
 *
 * 决策 4 铁律：只判可证伪的总量硬下界，不预测组合可排性，绝不误报"其实能排"。
 * 纯函数、零 IO。
 */

import { legalStartTimes } from '../solver/placement.js';

const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function nameOf(arr, id) {
    const it = (arr || []).find(x => x.id === id);
    return it?.name || id;
}

/** 统计某资源被不可用约束清掉的时段数（去重）。 */
function unavailableCount(project, type, key) {
    const map = new Map();
    for (const c of project.constraints ?? []) {
        if (c.type !== type) continue;
        const id = c.target?.[key];
        if (!id) continue;
        const slots = new Set(c.params?.slots ?? []);
        map.set(id, Math.max(map.get(id) || 0, slots.size));
    }
    return map;
}

/** 缺对象：ActivityPlan 引用的资源在项目里缺失（聚焦可行性）。 */
export function auditMissingObjects(project) {
    const findings = [];
    const classIds = new Set((project.classes || []).map(c => c.id));
    const teacherIds = new Set((project.teachers || []).map(t => t.id));
    const subjectIds = new Set((project.subjects || []).map(s => s.id));
    const roomIds = new Set((project.rooms || []).map(r => r.id));
    for (const p of project.activityPlans || []) {
        for (const cid of p.classIds || []) {
            if (!classIds.has(cid)) findings.push({ code: 'missing_class', severity: 'error', message: `计划 ${p.id} 引用了不存在的班级 ${cid}`, ref: { planId: p.id, classId: cid } });
        }
        for (const tid of p.teacherIds || []) {
            if (!teacherIds.has(tid)) findings.push({ code: 'missing_teacher', severity: 'error', message: `计划 ${p.id} 引用了不存在的教师 ${tid}`, ref: { planId: p.id, teacherId: tid } });
        }
        if (p.subjectId && !subjectIds.has(p.subjectId)) findings.push({ code: 'missing_subject', severity: 'error', message: `计划 ${p.id} 引用了不存在的课程 ${p.subjectId}`, ref: { planId: p.id, subjectId: p.subjectId } });
        for (const rid of p.roomRequirements || []) {
            if (!roomIds.has(rid)) findings.push({ code: 'missing_room', severity: 'error', message: `计划 ${p.id} 引用了不存在的教室 ${rid}`, ref: { planId: p.id, roomId: rid } });
        }
    }
    return findings;
}

/** 课时与连堂模式矛盾：weeklyUnits 与 durationPattern 不自洽。 */
export function auditUnitConsistency(project) {
    const findings = [];
    for (const p of project.activityPlans || []) {
        const units = p.weeklyUnits ?? 0;
        if (units <= 0) {
            findings.push({ code: 'nonpositive_units', severity: 'error', message: `计划 ${p.id} 周课时 ${units} 非正，无法排课`, ref: { planId: p.id } });
            continue;
        }
        if (p.durationPattern === 'double' && units % 2 !== 0) {
            findings.push({
                code: 'double_units_odd', severity: 'warning',
                message: `计划 ${p.id} 要求全连堂(double) 但周课时 ${units} 为奇数，无法全部成对，将有单节剩余`,
                ref: { planId: p.id }, detail: { units, pattern: 'double' },
            });
        }
    }
    return findings;
}

/**
 * 不可能约束（硬下界、可证伪、不误报）。需要 ctx（用于 legalStartTimes 与 occupiedTimes）。
 */
export function auditImpossibleConstraints(project, ctx) {
    const findings = [];
    const slotCount = ctx.calendar.slotCount;

    // 按教师/班级累计课时（活动 duration）
    const teacherUnits = new Map();
    const classUnits = new Map();
    for (let idx = 0; idx < ctx.activities.length; idx++) {
        const m = ctx.meta[idx];
        for (const ti of m.teacherIdxs) teacherUnits.set(ti, (teacherUnits.get(ti) || 0) + m.duration);
        for (const ci of m.classIdxs) classUnits.set(ci, (classUnits.get(ci) || 0) + m.duration);
    }

    // 教师维
    const tUnavail = unavailableCount(project, 'teacher_unavailable', 'teacherId');
    for (const [ti, units] of teacherUnits) {
        const id = ctx.indexes.teachers.toId(ti);
        const blocked = tUnavail.get(id) || 0;
        const capacity = slotCount - blocked;
        if (units > capacity) {
            findings.push({
                code: 'teacher_no_capacity', severity: 'error',
                message: `教师 ${nameOf(project.teachers, id)} 任课总课时 ${units} 超过可用时段 ${capacity}（总 ${slotCount} 扣不可用 ${blocked}），必有课排不下`,
                ref: { teacherId: id }, detail: { units, capacity, deficit: units - capacity },
            });
        }
    }

    // 班级维
    const cUnavail = unavailableCount(project, 'class_unavailable', 'classId');
    for (const [ci, units] of classUnits) {
        const id = ctx.indexes.classes.toId(ci);
        const blocked = cUnavail.get(id) || 0;
        const capacity = slotCount - blocked;
        if (units > capacity) {
            findings.push({
                code: 'class_no_capacity', severity: 'error',
                message: `班级 ${nameOf(project.classes, id)} 总课时 ${units} 超过可用时段 ${capacity}（总 ${slotCount} 扣不可用 ${blocked}）`,
                ref: { classId: id }, detail: { units, capacity, deficit: units - capacity },
            });
        }
    }

    // 教室维 + 连堂维：某活动在其所有合法起点为空 → 无落点
    for (let idx = 0; idx < ctx.activities.length; idx++) {
        const m = ctx.meta[idx];
        const legal = legalStartTimes(ctx, idx);
        if (legal.length === 0) {
            const aid = ctx.activities[idx].id;
            if (m.duration > ctx.calendar.nPeriods) {
                findings.push({
                    code: 'consecutive_no_block', severity: 'error',
                    message: `活动 ${aid} 连堂时长 ${m.duration} 超过每天节数 ${ctx.calendar.nPeriods}，无连续块可放`,
                    ref: { planId: ctx.activities[idx].planId ?? null }, detail: { duration: m.duration },
                });
            } else {
                findings.push({
                    code: 'activity_no_slot', severity: 'error',
                    message: `活动 ${aid} 在所有合法时段均不可用（教师/班级不可用或连堂无法落位），无落点`,
                    ref: { planId: ctx.activities[idx].planId ?? null },
                });
            }
        }
    }

    return findings;
}

/** 聚合审计入口。ctx 可选；无 ctx 时只跑不依赖 ctx 的检查。 */
export function auditProject(project, ctx) {
    const findings = [
        ...auditMissingObjects(project),
        ...auditUnitConsistency(project),
    ];
    if (ctx) findings.push(...auditImpossibleConstraints(project, ctx));
    return findings;
}
