/**
 * timetable-v2 / api / mock / diagnostics.sample.js
 *
 * 契约同形桩：字段对齐 Phase 4 buildDiagnostics().toJSON()
 * （items / byObject 倒排索引 / suggestions / summary）。纯静态，不含诊断计算。
 */

export const sampleDiagnostics = {
    items: [
        {
            category: 'soft-violation', severity: 'warning', softType: 'morning_subjects',
            objects: { activityId: 'a2#0', classes: ['一班'], teachers: ['李老师'], subject: '数学' },
            weight: 50,
            message: '软规则未满足[morning_subjects]：数学（一班）于 周一第2节（权重 50）',
        },
        {
            category: 'audit', severity: 'info', code: 'double_units_odd',
            ref: { planId: 'a2' },
            message: '计划 a2 连堂模式与课时基本自洽（示例信息项）',
        },
    ],
    byObject: {
        teachers: { 李老师: [0] },
        classes: { 一班: [0] },
        subjects: { 数学: [0] },
        rooms: {},
    },
    suggestions: [
        {
            id: 'sug_demo1', kind: 'relax-soft', targetDiagnostics: ['a2#0'],
            action: { type: 'relax-soft', target: { softType: 'morning_subjects' } },
            expectedRelief: '放宽主科上午软约束，或把数学移到上午',
            impactScope: 'class', confidence: 'medium', applied: false,
            message: '数学未排在上午，可调整时段或放宽该软约束',
        },
    ],
    summary: { error: 0, warning: 1, info: 1, total: 2, suggestions: 1 },
};
