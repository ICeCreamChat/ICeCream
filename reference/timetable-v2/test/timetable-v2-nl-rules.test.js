/**
 * Phase「V2 自然语言规则解析」测试。
 * 行为基线对齐旧 timetable-rule-parser 本地解析层；产物须为合法 V2 DSL。
 * 运行：node --test test/timetable-v2-nl-rules.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseNaturalLanguageConstraints,
    createProject,
    expandActivityPlans,
    buildContext,
    detectHardConflicts,
    createSolution,
    hasConstraint,
} from '../gateway/services/timetable-v2/index.js';

function sampleProject() {
    return createProject({
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1', name: '一班' }, { id: 'c2', name: '二班' }],
        teachers: [{ id: 't_zhang', name: '张老师' }, { id: 't_li', name: '李老师' }],
        subjects: [
            { id: 's_yw', name: '语文', category: 'main', priority: 90 },
            { id: 's_sx', name: '数学', category: 'main', priority: 88 },
            { id: 's_yy', name: '英语', category: 'main', priority: 85 },
            { id: 's_ms', name: '美术', category: 'quality', priority: 40 },
        ],
        rooms: [],
        activityPlans: [
            { id: 'p1', classId: 'c1', subjectId: 's_yw', teacherId: 't_zhang', weeklyHours: 3 },
            { id: 'p2', classId: 'c1', subjectId: 's_sx', teacherId: 't_li', weeklyHours: 3 },
        ],
        constraints: [],
    });
}

test('教师不可用：精确命中 → teacher_unavailable，slots 正确', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints('张老师周一全天不排课', p);
    const c = constraints.find(x => x.type === 'teacher_unavailable');
    assert.ok(c, '应产出 teacher_unavailable');
    assert.equal(c.target.teacherId, 't_zhang');
    assert.equal(c.strength, 'hard');
    assert.equal(c.params.slots.length, 6, '周一全天=6节');
    assert.ok(c.params.slots.every(s => s.startsWith('1-')));
    assert.equal(c.source.kind, 'natural_language');
});

test('教师名精确匹配不误标 unsupported', () => {
    const p = sampleProject();
    const { constraints, unsupported } = parseNaturalLanguageConstraints('张老师周二下午不排', p);
    assert.ok(constraints.some(c => c.type === 'teacher_unavailable'));
    assert.equal(unsupported.length, 0);
});

test('教师每日上限 / 连续上限 → teacher_limits{daily}/{consecutive}', () => {
    const p = sampleProject();
    const r1 = parseNaturalLanguageConstraints('李老师每天最多4节', p);
    const c1 = r1.constraints.find(c => c.type === 'teacher_limits');
    assert.equal(c1.params.daily, 4);
    assert.equal(c1.target.teacherId, 't_li');
    const r2 = parseNaturalLanguageConstraints('李老师连续最多2节', p);
    const c2 = r2.constraints.find(c => c.type === 'teacher_limits');
    assert.equal(c2.params.consecutive, 2);
});

test('主科上午：单科 → 一条 morning_subjects', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints('语文尽量安排到上午', p);
    const c = constraints.find(x => x.type === 'morning_subjects');
    assert.ok(c);
    assert.deepEqual(c.params.subjectIds, ['s_yw']);
    assert.equal(c.strength, 'soft');
});

test('"语数英尽量上午" → 一条含语数英三 subjectId', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints('语数英尽量上午', p);
    const c = constraints.find(x => x.type === 'morning_subjects');
    assert.ok(c);
    assert.deepEqual([...c.params.subjectIds].sort(), ['s_sx', 's_yw', 's_yy']);
});

test('科目偏好/回避节次 → subject_preferred_periods prefer/avoid', () => {
    const p = sampleProject();
    const r = parseNaturalLanguageConstraints('数学优先第3-4节', p);
    const c = r.constraints.find(x => x.type === 'subject_preferred_periods');
    assert.ok(c);
    assert.equal(c.target.subjectId, 's_sx');
    assert.ok(c.params.prefer.length > 0, '应有 prefer');
    const r2 = parseNaturalLanguageConstraints('美术第3节不要排', p);
    const c2 = r2.constraints.find(x => x.type === 'subject_preferred_periods');
    assert.ok(c2 && c2.params.avoid.length > 0, '应有 avoid');
});

test('班级不可用（下午段展开）→ class_unavailable', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints('一班周五下午不排课', p);
    const c = constraints.find(x => x.type === 'class_unavailable');
    assert.ok(c);
    assert.equal(c.target.classId, 'c1');
    assert.ok(c.params.slots.every(s => s.startsWith('5-')));
});

test('固定课三元组 → fixed_locked（能定位 planId）', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints('张老师必须周三第1节给一班上语文', p);
    const c = constraints.find(x => x.type === 'fixed_locked');
    assert.ok(c, '应产出 fixed_locked');
    assert.equal(c.target.planId, 'p1');
    assert.equal(c.params.slot, '3-1');
});

test('固定课无法定位 planId → unsupported 不报错', () => {
    const p = sampleProject();
    // 二班没有语文计划
    const { constraints, unsupported } = parseNaturalLanguageConstraints('张老师必须周三第1节给二班上语文', p);
    assert.equal(constraints.filter(c => c.type === 'fixed_locked').length, 0);
    assert.ok(unsupported.some(u => /教学计划/.test(u.reason)));
});

test('复合句多约束正确拆分', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints('张老师周一全天不排，数学优先第3节', p);
    assert.ok(constraints.some(c => c.type === 'teacher_unavailable'));
    assert.ok(constraints.some(c => c.type === 'subject_preferred_periods'));
});

test('无法解析的句子 → unsupported，不抛错不臆造', () => {
    const p = sampleProject();
    const { constraints, unsupported } = parseNaturalLanguageConstraints('今天天气不错', p);
    assert.equal(constraints.length, 0);
    assert.ok(unsupported.length > 0);
});

test('项目无此教师 → unsupported 而非空 target 约束', () => {
    const p = sampleProject();
    const { constraints, unsupported } = parseNaturalLanguageConstraints('王老师周三不排', p);
    assert.equal(constraints.filter(c => c.type === 'teacher_unavailable').length, 0);
    assert.ok(unsupported.some(u => /教师/.test(u.reason)));
});

test('产物经 createProject 校验并可被 buildContext/detectHardConflicts 消费', () => {
    const p = sampleProject();
    const { constraints } = parseNaturalLanguageConstraints(
        '张老师周一全天不排课；数学优先第3-4节；语数英尽量上午', p);
    const merged = createProject({
        ...p, constraints: [...p.constraints, ...constraints],
    });
    const acts = expandActivityPlans(merged.activityPlans);
    const ctx = buildContext(merged, acts, merged.constraints);
    const sol = createSolution(acts.length);
    sol.move(0, ctx.calendar.parseSlotKey('1-1')); // 张老师语文落在周一第1节(不可用)
    const conflicts = detectHardConflicts(sol, ctx);
    assert.ok(conflicts.some(c => c.type === 'teacher_unavailable'), '不可用约束应被检出');
});

test('新软约束已注册且可 compile/pressure', () => {
    assert.ok(hasConstraint('subject_preferred_periods'));
    assert.ok(hasConstraint('teacher_limits'));
    const p = createProject({
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [{ id: 't1', name: '甲' }],
        subjects: [{ id: 's1', name: '数学', category: 'main', priority: 80 }],
        rooms: [],
        activityPlans: [{ id: 'p1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 4 }],
        constraints: [
            { type: 'subject_preferred_periods', strength: 'soft', target: { subjectId: 's1' }, params: { avoid: ['1-1'] } },
            { type: 'teacher_limits', strength: 'soft', target: { teacherId: 't1' }, params: { consecutive: 2 } },
        ],
    });
    const acts = expandActivityPlans(p.activityPlans);
    const ctx = buildContext(p, acts, p.constraints);
    const spp = ctx.constraints.find(c => c.type === 'subject_preferred_periods');
    const tl = ctx.constraints.find(c => c.type === 'teacher_limits');
    const sol = createSolution(acts.length);
    sol.move(0, ctx.calendar.parseSlotKey('1-1'));
    assert.equal(typeof spp.pressure(0, ctx.calendar.parseSlotKey('1-1'), undefined, sol, ctx), 'number');
    assert.ok(spp.pressure(0, ctx.calendar.parseSlotKey('1-1'), undefined, sol, ctx) > 0, '数学落在 avoid 节次应有压力');
    assert.equal(typeof tl.pressure(0, ctx.calendar.parseSlotKey('1-1'), undefined, sol, ctx), 'number');
});
