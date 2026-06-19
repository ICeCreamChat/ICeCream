/**
 * Phase 3 Excel/CSV 导入器单元测试。
 * 命令：node --test test/timetable-v2-importers-excel.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importExcelPlans } from '../gateway/services/timetable-v2/importers/excel.js';
import { verifyReportConsistency } from '../gateway/services/timetable-v2/importers/migration-report.js';
import { validateProject } from '../gateway/services/timetable-v2/domain/project.js';
import { expandActivityPlans } from '../gateway/services/timetable-v2/domain/activity.js';
import { detectHardConflicts, buildContext } from '../gateway/services/timetable-v2/constraints/index-builder.js';
import { Solution } from '../gateway/services/timetable-v2/domain/solution.js';
// 触发硬约束注册
import '../gateway/services/timetable-v2/index.js';
import { excelSampleText, excelSampleRows, excelSampleNoHeaderRows } from './timetable-v2-fixtures/excel-sample.js';

function findPlan(project, { subjectName, className }) {
    const subject = project.subjects.find(s => s.name === subjectName);
    const klass = project.classes.find(c => c.name === className);
    return project.activityPlans.find(p => p.subjectId === subject.id && p.classIds.includes(klass.id));
}

test('行按 (班级,课程,教师) 聚合为 ActivityPlan，同组课时累加', () => {
    const { project } = importExcelPlans(excelSampleText());
    // 语文同组两行 2+2 → 4
    const chinese = findPlan(project, { subjectName: '语文', className: '1班' });
    assert.ok(chinese, '应聚合出语文 ActivityPlan');
    assert.equal(chinese.weeklyUnits, 4, '同组两行 2+2 应累加为 4');
    assert.equal(chinese.classIds.length, 1);
    assert.equal(chinese.teacherIds.length, 1);
});

test('连堂偏好 → durationPattern，展开出 duration>1 活动', () => {
    const { project } = importExcelPlans(excelSampleText());
    const math = findPlan(project, { subjectName: '数学', className: '1班' });
    assert.equal(math.durationPattern, 'double', '连堂列应映射为 double');
    const activities = expandActivityPlans([math]);
    assert.ok(activities.some(a => a.duration > 1), '应展开出连堂活动');
    const total = activities.reduce((s, a) => s + a.duration, 0);
    assert.equal(total, math.weeklyUnits, '展开后总时长等于 weeklyUnits');
});

test('多教师行（、/ 分隔）→ 多 teacherIds', () => {
    const { project } = importExcelPlans(excelSampleRows());
    const pe = findPlan(project, { subjectName: '体育', className: '2班' });
    assert.equal(pe.teacherIds.length, 2, '王老师、赵老师应拆为两个 teacherId');
});

test('坏行（空行 / 缺课程）进迁移报告且不中断导入', () => {
    const { project, report } = importExcelPlans(excelSampleText());
    const dropped = report.entries.filter(e => e.category === 'dropped');
    assert.ok(dropped.length >= 2, '至少有空行与缺课程两条 dropped');
    assert.ok(dropped.some(e => /空行/.test(e.reason)), '应记录空行');
    assert.ok(dropped.some(e => /subjectName/.test(e.field)), '应记录缺课程列');
    // 不中断：其余行仍正常导入
    assert.ok(project.activityPlans.length >= 3, '坏行不应阻断其他行导入');
});

test('产物通过 validateProject 且引用完整', () => {
    const { project } = importExcelPlans(excelSampleText());
    const result = validateProject(project);
    assert.ok(result.ok, `应通过校验：${result.errors.join('; ')}`);
    // 引用完整性：每个 plan 的引用都存在
    const classIds = new Set(project.classes.map(c => c.id));
    const teacherIds = new Set(project.teachers.map(t => t.id));
    const subjectIds = new Set(project.subjects.map(s => s.id));
    const roomIds = new Set(project.rooms.map(r => r.id));
    for (const p of project.activityPlans) {
        assert.ok(subjectIds.has(p.subjectId));
        p.classIds.forEach(c => assert.ok(classIds.has(c)));
        p.teacherIds.forEach(t => assert.ok(teacherIds.has(t)));
        p.roomRequirements.forEach(r => assert.ok(roomIds.has(r)));
    }
});

test('产物为 V2 ActivityPlan 模型，而非旧 lessonPlan', () => {
    const { project } = importExcelPlans(excelSampleText());
    assert.ok(!('lessonPlans' in project), '不应有旧 lessonPlans 字段');
    assert.ok(Array.isArray(project.activityPlans));
    for (const p of project.activityPlans) {
        assert.ok('weeklyUnits' in p, '应为 weeklyUnits 而非 weeklyHours');
        assert.ok('durationPattern' in p, '应为 durationPattern 而非 blockPreference');
        assert.ok(Array.isArray(p.classIds), 'classIds 应为数组');
        assert.ok(Array.isArray(p.teacherIds), 'teacherIds 应为数组');
        assert.ok(!('blockPreference' in p));
        assert.ok(!('weeklyHours' in p));
    }
});

test('实体去重正确（同名班级/课程/教师只生成一份）', () => {
    const { project } = importExcelPlans(excelSampleText());
    // 张老师只出现一次（语文两行共享）
    const zhang = project.teachers.filter(t => t.name === '张老师');
    assert.equal(zhang.length, 1, '同名教师去重');
    // 语文课程只一份
    const chinese = project.subjects.filter(s => s.name === '语文');
    assert.equal(chinese.length, 1, '同名课程去重');
    // 1班只一份
    const c1 = project.classes.filter(c => c.name === '1班');
    assert.equal(c1.length, 1, '同名班级去重');
    // id 集合无重复
    const ids = project.subjects.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('报告 summary 与条目一致（verifyReportConsistency）', () => {
    const { report } = importExcelPlans(excelSampleText());
    const check = verifyReportConsistency(report);
    assert.ok(check.ok, check.reason);
    const summary = report.summary();
    assert.equal(summary.total, report.entries.length);
    assert.equal(summary.sourceKind, 'excel');
});

test('行数组入参与文本入参结果等价', () => {
    const fromText = importExcelPlans(excelSampleText()).project;
    const fromRows = importExcelPlans(excelSampleRows()).project;
    assert.equal(fromRows.activityPlans.length, fromText.activityPlans.length);
    assert.equal(fromRows.classes.length, fromText.classes.length);
    assert.equal(fromRows.subjects.length, fromText.subjects.length);
});

test('无表头行走默认表头兜底', () => {
    const { project } = importExcelPlans(excelSampleNoHeaderRows());
    assert.equal(project.activityPlans.length, 2);
    assert.ok(project.subjects.find(s => s.name === '语文'));
    assert.ok(project.subjects.find(s => s.name === '数学'));
});

test('产物可被求解器消费：展开成功且无内生硬冲突', () => {
    const { project } = importExcelPlans(excelSampleText());
    const activities = expandActivityPlans(project.activityPlans);
    assert.ok(activities.length > 0, '应展开出活动');
    const ctx = buildContext(project, activities);
    const sol = new Solution(activities.length);
    const conflicts = detectHardConflicts(sol, ctx);
    // 未排课的活动不应产生 fixed/locked 冲突（无固定格）
    assert.equal(conflicts.length, 0, `未排状态应无硬冲突：${JSON.stringify(conflicts)}`);
});

test('raw 保留来源原文引用', () => {
    const text = excelSampleText();
    const { raw } = importExcelPlans(text);
    assert.equal(raw, text);
});
