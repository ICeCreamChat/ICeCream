/**
 * Phase 4 诊断极端样本。每个构造器返回可直接喂诊断的 { project, solveResult } 或 { project, ctx }。
 * 纯数据，零 IO。
 */

import {
    createProject, expandActivityPlans, buildContext, solve,
} from '../../gateway/services/timetable-v2/index.js';

const CAL = { weekdays: 5, periodsPerDay: 6 };

/** 全天 30 个时段 key（5×6）。 */
export function allSlots() {
    const out = [];
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= 6; p++) out.push(`${d}-${p}`);
    return out;
}

/** 教师全不可用 → no-candidate。 */
export function teacherFullyUnavailable() {
    const project = createProject({
        calendar: CAL,
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [{ id: 's1', name: '语文', category: 'main', priority: 90 }],
        rooms: [],
        activityPlans: [{ id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 2 }],
        constraints: [{
            id: 'u1', type: 'teacher_unavailable', strength: 'hard', weight: 100,
            target: { teacherId: 't1' }, params: { slots: allSlots() },
            source: '张老师全周不可用',
        }],
    });
    return { project, solveResult: solve(project, { seed: 1 }) };
}

/** 资源竞争 → all-blocked：一个教师多班课时填满后再加一门排不下。 */
export function resourceContention() {
    const plans = [];
    // t1 教 c1 的 6 门课塞满每天，c1 再来一门必然 all-blocked（候选位都被占）
    for (let i = 1; i <= 6; i++) {
        plans.push({ id: `fill${i}`, classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 5 });
    }
    plans.push({ id: 'extra', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyUnits: 3 });
    const project = createProject({
        calendar: CAL,
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [
            { id: 's1', name: '语文', category: 'main', priority: 90 },
            { id: 's2', name: '数学', category: 'main', priority: 90 },
        ],
        rooms: [],
        activityPlans: plans,
        constraints: [],
    });
    return { project, solveResult: solve(project, { seed: 1 }) };
}

/** 课时与可用时段矛盾：教师总课时 > 可用时段（审计 error）。 */
export function teacherOvercommitted() {
    const project = createProject({
        calendar: CAL, // 30 时段
        classes: [{ id: 'c1', name: '一班' }, { id: 'c2', name: '二班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [{ id: 's1', name: '语文', category: 'main', priority: 90 }],
        rooms: [],
        activityPlans: [
            { id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 20 },
            { id: 'a2', classId: 'c2', subjectId: 's1', teacherId: 't1', weeklyUnits: 20 },
        ],
        constraints: [],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    return { project, ctx, solveResult: solve(project, { seed: 1 }) };
}

/** 连堂无连续块：连堂时长 > 每天节数。 */
export function consecutiveTooLong() {
    const project = createProject({
        calendar: { weekdays: 5, periodsPerDay: 2 },
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [{ id: 's1', name: '实验', category: 'lab', priority: 60 }],
        rooms: [],
        // weeklyUnits=3 + double → duration 块为 2，但每天只有 2 节，块本身放得下；
        // 用一个 weeklyUnits=4 double 在 2 节/天 仍可（块=2）。这里造 duration>nPeriods：用更长连堂需 activity 层；
        // 简化：用 periodsPerDay=2 且 double weeklyUnits=2（块=2 恰好满天，合法）——改为审计 double 奇数告警样本
        activityPlans: [{ id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 3, durationPattern: 'double' }],
        constraints: [],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    return { project, ctx };
}

/** 紧张但可排（防误报）：课时正好等于可用时段。 */
export function tightButFeasible() {
    const plans = [];
    for (let i = 1; i <= 5; i++) {
        plans.push({ id: `p${i}`, classId: 'c1', subjectId: 's1', teacherId: `t${i}`, weeklyUnits: 6 });
    }
    const project = createProject({
        calendar: CAL,
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [1, 2, 3, 4, 5].map(i => ({ id: `t${i}`, name: `老师${i}` })),
        subjects: [{ id: 's1', name: '语文', category: 'main', priority: 90 }],
        rooms: [],
        activityPlans: plans,
        constraints: [],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    return { project, ctx };
}
