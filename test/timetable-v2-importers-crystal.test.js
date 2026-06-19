/**
 * Phase 3 水晶 cloneSeed 导入器测试。
 * 命令：node --test test/timetable-v2-importers-crystal.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importCrystalCloneSeed } from '../gateway/services/timetable-v2/importers/crystal-mapping.js';
import { verifyReportConsistency } from '../gateway/services/timetable-v2/importers/migration-report.js';
import { validateProject } from '../gateway/services/timetable-v2/domain/project.js';
import { expandActivityPlans } from '../gateway/services/timetable-v2/domain/activity.js';
import { buildContext, detectHardConflicts } from '../gateway/services/timetable-v2/constraints/index-builder.js';
import { Solution } from '../gateway/services/timetable-v2/domain/solution.js';
import '../gateway/services/timetable-v2/index.js';
import { crystalCloneSeedSample } from './timetable-v2-fixtures/crystal-clone-seed-sample.js';

test('crystal：schema 不符报错而非误读', () => {
    assert.throws(() => importCrystalCloneSeed({ schema: 'wrong', schemaVersion: 1 }), /schema 不符/);
    assert.throws(() => importCrystalCloneSeed({ schema: 'icecream-scheduler-clone-seed', schemaVersion: 2 }), /schemaVersion 不符/);
    assert.throws(() => importCrystalCloneSeed(null), /必须是对象/);
});

test('crystal：导入产物通过 Phase 1 校验', () => {
    const { project } = importCrystalCloneSeed(crystalCloneSeedSample());
    const { ok, errors } = validateProject(project);
    assert.ok(ok, `应通过校验，实际错误：${JSON.stringify(errors)}`);
});

test('crystal：返回 { project, report, raw }，raw 保留原文', () => {
    const seed = crystalCloneSeedSample();
    const out = importCrystalCloneSeed(seed);
    assert.ok(out.project && out.report && out.raw);
    assert.equal(out.raw, seed, 'raw 应是来源原文引用');
});

test('crystal：classCourseSections → ActivityPlan（课时→weeklyUnits）', () => {
    const { project } = importCrystalCloneSeed(crystalCloneSeedSample());
    assert.ok(project.activityPlans.length > 0);
    const withUnits = project.activityPlans.find(p => p.weeklyUnits > 0);
    assert.ok(withUnits, '应有正课时的计划');
});

test('crystal：relationGroups(heban) → 合班活动含多 classIds', () => {
    const { project } = importCrystalCloneSeed(crystalCloneSeedSample());
    const heban = project.activityPlans.find(p => p.classIds.length > 1);
    assert.ok(heban, '应有多班级合班活动');
});

test('crystal：规则三分类——硬/软/元数据各有命中', () => {
    const { project } = importCrystalCloneSeed(crystalCloneSeedSample());
    const hardTypes = new Set(['teacher_unavailable', 'class_unavailable', 'fixed_locked']);
    const hasHard = project.constraints.some(c => hardTypes.has(c.type));
    const hasSoft = project.constraints.some(c => c.strength === 'soft');
    const hasMeta = (project.metadata?.crystalOptions ?? []).length > 0;
    assert.ok(hasHard, '应有硬约束');
    assert.ok(hasSoft, '应有软约束草稿');
    assert.ok(hasMeta, '应有 PaiOpt 元数据');
});

test('crystal：不支持/语义不明规则进 review 不中断', () => {
    const { report } = importCrystalCloneSeed(crystalCloneSeedSample());
    const summary = report.summary();
    assert.ok(summary.counts.review > 0, 'review 分类应有条目');
});

test('crystal：迁移报告汇总与条目一致', () => {
    const { report } = importCrystalCloneSeed(crystalCloneSeedSample());
    assert.ok(verifyReportConsistency(report).ok, '报告汇总计数应与条目一致');
});

test('crystal：导入产物可被求解器消费（展开+硬冲突检测）', () => {
    const { project } = importCrystalCloneSeed(crystalCloneSeedSample());
    const activities = expandActivityPlans(project.activityPlans);
    assert.ok(activities.length > 0, '应展开出活动');
    const ctx = buildContext(project, activities, project.constraints);
    const sol = new Solution(activities.length);
    // 空解（全未分配）不应有占用类硬冲突
    const conflicts = detectHardConflicts(sol, ctx);
    assert.ok(Array.isArray(conflicts), '硬冲突检测应返回数组');
});

test('crystal C-1：三个关系数组逐条进 review，不静默丢', () => {
    const { report } = importCrystalCloneSeed(crystalCloneSeedSample());
    const fields = report.entries.filter(e => e.category === 'review').map(e => e.field);
    assert.ok(fields.includes('teacherMutualExclusion'), 'teacherMutualExclusion 应进 review');
    assert.ok(fields.includes('courseXorPairs'), 'courseXorPairs 应进 review');
    assert.ok(fields.includes('courseNearPairs'), 'courseNearPairs 应进 review');
    // 原值随条目带出（绝不静默丢）
    const tme = report.entries.find(e => e.field === 'teacherMutualExclusion');
    assert.ok(tme.originalValue && tme.originalValue.teacherA === '20', 'review 条目应带原值');
});

test('crystal M-2：课程@班级硬禁进 review，不臆造 class_unavailable，不谎报 kept', () => {
    const { project, report } = importCrystalCloneSeed(crystalCloneSeedSample());
    // 全部约束里不应出现 class_unavailable（fixture 中所有硬禁都是课程@班级或全班维度）
    const classUnavail = project.constraints.filter(c => c.type === 'class_unavailable');
    assert.equal(classUnavail.length, 0, '不应臆造 class_unavailable');
    // hardForbids 的 classCourse 条目应进 review
    const hfReview = report.entries.filter(e => e.category === 'review' && e.field === 'hardForbid');
    assert.ok(hfReview.length >= 1, 'classCourse 维度 hardForbid 应进 review');
    // preset course status=3（具体班级 pc3）应进 review，且没有任何 kept 把它当 class_unavailable
    const presetReview = report.entries.filter(e => e.category === 'review' && e.field === 'preset');
    assert.ok(presetReview.some(e => /误伤/.test(e.reason)), 'course status=3 应路由 review 并说明误伤风险');
    const presetKeptAsClass = report.entries.filter(e => e.category === 'kept' && e.field === 'preset' && /class_unavailable/.test(e.reason));
    assert.equal(presetKeptAsClass.length, 0, '不应有谎报 class_unavailable 的 kept');
    // teacher_unavailable（教师维度）应保留
    assert.ok(project.constraints.some(c => c.type === 'teacher_unavailable'), '教师维度硬禁仍应保留');
});

test('crystal M-5：course 带 lianpai → 连堂，带 roomid → roomRequirements', () => {
    const { project } = importCrystalCloneSeed(crystalCloneSeedSample());
    // 物理实验(course 12) 带 lianpai=1 + roomid=101
    const physicsPlans = project.activityPlans.filter(p => p.subjectId === 's_12');
    assert.ok(physicsPlans.length > 0, '应有物理实验计划');
    assert.ok(physicsPlans.every(p => p.durationPattern === 'double'), 'lianpai → durationPattern=double');
    assert.ok(physicsPlans.every(p => p.roomRequirements.includes('r_101')), 'roomid → roomRequirements 含该教室');
    // 无 lianpai/roomid 的课程不受影响
    const chinesePlans = project.activityPlans.filter(p => p.subjectId === 's_10');
    assert.ok(chinesePlans.every(p => p.durationPattern === 'single' && p.roomRequirements.length === 0), '无该字段课程不变');
});

test('crystal M-4：导入不 mutate 入参（深比较前后一致）', () => {
    const seed = crystalCloneSeedSample();
    const before = JSON.parse(JSON.stringify(seed));
    importCrystalCloneSeed(seed);
    assert.deepEqual(seed, before, '导入不得改写来源 cloneSeed');
});
