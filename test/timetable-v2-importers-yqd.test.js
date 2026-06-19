/**
 * .yqd 业务表导入器测试（Phase 3）。
 * 命令：node --test test/timetable-v2-importers-yqd.test.js
 *
 * 覆盖 spec：YQD Import Pipeline Read Only + Importers Produce Valid SchoolProjectV2
 * + Migration Report Records Lost And Degraded Fields。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 触发硬/软约束自注册（buildContext 依赖）。
import '../gateway/services/timetable-v2/index.js';
import { validateProject } from '../gateway/services/timetable-v2/domain/project.js';
import { expandActivityPlans } from '../gateway/services/timetable-v2/domain/activity.js';
import { buildContext, detectHardConflicts } from '../gateway/services/timetable-v2/constraints/index-builder.js';
import { createSolution } from '../gateway/services/timetable-v2/domain/solution.js';
import { verifyReportConsistency } from '../gateway/services/timetable-v2/importers/migration-report.js';
import { importYqdTables } from '../gateway/services/timetable-v2/importers/yqd.js';
import { yqdTablesSample, yqdTablesMissing } from './timetable-v2-fixtures/yqd-tables-sample.js';

function findPlan(project, id) {
    return project.activityPlans.find(p => p.id === id);
}

test('返回 { project, report, raw }，project 通过 SchoolProjectV2 校验', () => {
    const { project, report, raw } = importYqdTables(yqdTablesSample());
    assert.ok(project && report && raw, '应返回三元组');
    const { ok, errors } = validateProject(project);
    assert.ok(ok, `项目应通过校验：${errors.join('; ')}`);
    assert.equal(report.sourceKind, 'yqd');
    assert.ok(raw.tables, 'raw 应保留来源业务表引用');
});

test('业务表 → V2 实体：banbd→classes / kemubd→subjects / teabd→teachers / roombd→rooms', () => {
    const { project } = importYqdTables(yqdTablesSample());
    assert.equal(project.classes.length, 3);
    assert.equal(project.subjects.length, 4);
    assert.equal(project.teachers.length, 3);
    assert.equal(project.rooms.length, 1);
    // 班级带 grade（jiid→jiname）
    const c1 = project.classes.find(c => c.id === '1');
    assert.equal(c1.name, '一年1班');
    assert.equal(c1.grade, '一年');
    // 课程类别按名称推断
    assert.equal(project.subjects.find(s => s.id === '1').category, 'main'); // 语文
    assert.equal(project.subjects.find(s => s.id === '3').category, 'quality'); // 体育
});

test('renkebd → ActivityPlan：teacher↔class↔subject 绑定，jieshu→weeklyUnits', () => {
    const { project } = importYqdTables(yqdTablesSample());
    // 普通任课：班1 数学（difid=2）
    const math = findPlan(project, 'rk_2');
    assert.deepEqual(math.classIds, ['1']);
    assert.deepEqual(math.teacherIds, ['2']);
    assert.equal(math.subjectId, '2');
    assert.equal(math.weeklyUnits, 5);
    // kemubd.lianpai=1 → durationPattern double（科学 difid=4）
    const sci = findPlan(project, 'rk_4');
    assert.equal(sci.durationPattern, 'double');
});

test('heban 合班 → 单个多 classIds ActivityPlan（同师同课同时段）', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const heban = findPlan(project, 'rk_heban_1');
    assert.ok(heban, '应生成合班 ActivityPlan');
    assert.deepEqual(heban.classIds.sort(), ['1', '2'], '合班合并多个 classIds');
    assert.deepEqual(heban.teacherIds, ['1']);
    assert.equal(heban.subjectId, '1');
    assert.equal(heban.weeklyUnits, 4, '取合班组首行 jieshu，不重复累加');
});

test('教师任教课程由 renkebd 回填', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const t3 = project.teachers.find(t => t.id === '3');
    assert.deepEqual(t3.subjects.sort(), ['3', '5'], '教师3 任教体育(3)+科学(5)');
});

test('固定课 gudinbd → class_unavailable 硬约束', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const cu = project.constraints.find(c => c.type === 'class_unavailable' && c.target?.classId === '1');
    assert.ok(cu, '固定课应映射为 class_unavailable');
    assert.ok(cu.params.slots.includes('3-6'), '应占用 周三第6节');
});

test('教师预排 status=3 → teacher_unavailable 硬约束', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const tu = project.constraints.find(c => c.type === 'teacher_unavailable' && c.target?.teacherId === '1');
    assert.ok(tu, 'teshutea status=3 应映射为 teacher_unavailable');
    assert.ok(tu.params.slots.includes('5-5'));
});

test('课程预排 status=2 → subject_preferred_periods 软约束草稿', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const soft = project.constraints.find(c => c.strength === 'soft'
        && c.type === 'subject_preferred_periods' && c.target?.subjectId === '1');
    assert.ok(soft, 'teshuke status=2 应映射为 subject_preferred_periods 软草稿');
    assert.ok(soft.params.prefer.includes('1-1'));
});

test('细粒度规则三分类：硬(教师禁排) / 软(计数) / 元数据(PaiOpt) / review(课程禁排)', () => {
    const { project, raw } = importYqdTables(yqdTablesSample());
    const drafts = raw.ruleDrafts;
    assert.ok(drafts.some(d => d.classification === 'hard'), '应有硬分类草稿');
    assert.ok(drafts.some(d => d.classification === 'soft'), '应有软分类草稿');
    assert.ok(drafts.some(d => d.classification === 'meta'), '应有元数据分类草稿');
    assert.ok(drafts.some(d => d.classification === 'review'), '应有 review 分类草稿');

    // PaiOptJie 教师3 第1节 theNum=1000 → teacher_unavailable
    const tu3 = project.constraints.find(c => c.type === 'teacher_unavailable' && c.target?.teacherId === '3');
    assert.ok(tu3 && tu3.params.slots.includes('1-1'), 'PaiOptJie 教师硬禁 → teacher_unavailable');
    // PaiOpt 开关进元数据
    assert.ok(raw.metadata.options && raw.metadata.options.length === 2, 'PaiOpt → metadata.options');
});

test('细粒度课程/班级硬禁与软计数进 review，不中断导入', () => {
    const { report } = importYqdTables(yqdTablesSample());
    const reviews = report.entries.filter(e => e.category === 'review');
    // teshuke status3 + teshutea status1 + PaiOptDay 课程硬禁 + PaiOptJie 计数软
    assert.ok(reviews.length >= 3, `应有多条 review，实际 ${reviews.length}`);
    assert.ok(reviews.some(e => e.field.includes('teshuke')), 'teshuke 课程硬禁进 review');
    assert.ok(reviews.some(e => e.field.includes('PaiOptDay') || e.field.includes('PaiOptJie')), '细粒度规则进 review');
});

test('导入产物为合法 V2 且可被求解器消费：展开成功 + 锁定格自身零硬冲突', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const activities = expandActivityPlans(project.activityPlans);
    assert.ok(activities.length > 0, '展开应产出活动');
    const ctx = buildContext(project, activities);
    assert.ok(ctx.constraints.length > 0, '应编译出约束实例（含硬约束）');
    // 空解（全未分配）应无硬冲突
    const empty = createSolution(activities.length);
    assert.deepEqual(detectHardConflicts(empty, ctx), [], '空解应无硬冲突');
});

test('合班活动展开后所有成员班级一致出现在同一活动', () => {
    const { project } = importYqdTables(yqdTablesSample());
    const heban = findPlan(project, 'rk_heban_1');
    const acts = expandActivityPlans([heban]);
    assert.ok(acts.every(a => a.classIds.includes('1') && a.classIds.includes('2')), '每个展开活动应含全部合班成员');
});

test('不写回来源：入参 tables 未被 mutate', () => {
    const sample = yqdTablesSample();
    const before = JSON.parse(JSON.stringify(sample));
    const { raw } = importYqdTables(sample);
    assert.deepEqual(sample, before, '入参业务表不得被改写');
    assert.equal(raw.tables, sample, 'raw.tables 应保留原文引用');
});

test('缺表 / 缺字段记入迁移报告而非中断', () => {
    const { project, report } = importYqdTables(yqdTablesMissing());
    // 不崩溃 + 产出合法（可能 0 计划）V2
    assert.ok(validateProject(project).ok, '残缺样本仍应产出合法 V2');
    // teabd 缺失 → 所有 renkebd 因 teaid 悬空/缺失被 dropped
    assert.equal(project.activityPlans.length, 0, '无有效任课 → 0 ActivityPlan');
    const dropped = report.entries.filter(e => e.category === 'dropped');
    assert.ok(dropped.some(e => e.field === 'renkebd.teaid'), '悬空/缺 teaid 应记 dropped');
    assert.ok(dropped.some(e => e.field === 'renkebd.keid'), '悬空 keid 应记 dropped');
});

test('迁移报告 summary 与条目一致（verifyReportConsistency）', () => {
    const { report } = importYqdTables(yqdTablesSample());
    const check = verifyReportConsistency(report);
    assert.ok(check.ok, `报告应自洽：${check.reason ?? ''}`);
    const summary = report.summary();
    assert.equal(summary.total, report.entries.length);
    for (const e of report.entries) {
        assert.ok(e.field, '条目应含 field');
        assert.ok(e.source !== undefined, '条目应含 source 来源定位');
    }
    assert.ok(summary.counts.kept > 0, '应有 kept 条目');
    assert.ok(summary.counts.review > 0, '应有 review 条目');
});

test('残缺样本报告也自洽，不抛错', () => {
    const { report } = importYqdTables(yqdTablesMissing());
    assert.ok(verifyReportConsistency(report).ok, '残缺样本报告应自洽');
});
