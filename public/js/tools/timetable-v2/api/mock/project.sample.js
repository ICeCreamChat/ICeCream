/**
 * timetable-v2 / api / mock / project.sample.js
 *
 * 契约同形桩：字段对齐 Phase 1 domain（createProject 产出形状）。
 * 仅回放静态样本，不含任何排课/校验计算。Phase 6 接真路由后由 USE_MOCK 开关切走。
 */

export const sampleProject = {
    id: 'demo',
    name: '示范学校 2026 秋',
    calendar: { weekdays: 5, periodsPerDay: 6, periodTimes: [] },
    classes: [
        { id: 'c1', name: '一班' },
        { id: 'c2', name: '二班' },
    ],
    teachers: [
        { id: 't1', name: '张老师' },
        { id: 't2', name: '李老师' },
        { id: 't3', name: '王老师' },
    ],
    subjects: [
        { id: 's1', name: '语文', category: 'main', priority: 90 },
        { id: 's2', name: '数学', category: 'main', priority: 90 },
        { id: 's3', name: '物理', category: 'lab', priority: 60 },
    ],
    rooms: [{ id: 'r1', name: '物理实验室' }],
    activityPlans: [
        { id: 'a1', classIds: ['c1'], subjectId: 's1', teacherIds: ['t1'], weeklyUnits: 5, durationPattern: 'single', roomRequirements: [] },
        { id: 'a2', classIds: ['c1'], subjectId: 's2', teacherIds: ['t2'], weeklyUnits: 4, durationPattern: 'double', roomRequirements: [] },
        { id: 'a3', classIds: ['c2'], subjectId: 's3', teacherIds: ['t3'], weeklyUnits: 2, durationPattern: 'single', roomRequirements: ['r1'] },
    ],
    constraints: [
        { id: 'm1', type: 'morning_subjects', strength: 'soft', weight: 50, target: {}, params: { subjects: ['s1', 's2'], morningPeriods: [1, 2, 3] }, source: '主科尽量排上午' },
    ],
};
