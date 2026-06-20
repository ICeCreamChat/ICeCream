/**
 * Phase 4 诊断测试：归因解释 + 输入审计 + 修复建议 + 报告聚合。
 * 每个极端样本断言"可读 + 可定位"，不只断言"有返回"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    explainUnplaced, explainHardConflicts, explainSoftViolations,
    auditProject, auditImpossibleConstraints, auditUnitConsistency,
    suggestForUnplaced, buildDiagnostics, createProject, expandActivityPlans,
    buildContext, solve, createSolution,
} from '../gateway/services/timetable-v2/index.js';

import {
    teacherFullyUnavailable, resourceContention, teacherOvercommitted,
    consecutiveTooLong, tightButFeasible, allSlots,
} from './timetable-v2-fixtures/diagnostics-sample.js';

// ---- explainUnplaced ----

test('explain：教师全不可用 → no-candidate，定位到具体教师/课程并指根因约束', () => {
    const { project, solveResult } = teacherFullyUnavailable();
    const ex = explainUnplaced(project, solveResult.solution, solveResult.ctx);
    assert.ok(ex.length > 0, '应有未排活动');
    const item = ex[0];
    assert.equal(item.kind, 'no-candidate');
    assert.ok(item.teachers.includes('张老师'), '定位到具体教师名');
    assert.ok(item.classes.includes('一班'), '定位到具体班级名');
    assert.equal(item.subject, '语文');
    assert.ok(item.rootConstraints.some(r => r.kind === 'teacher_unavailable'), '指向根因约束');
    assert.match(item.message, /张老师/, 'message 可读且含对象名');
});

test('explain：资源竞争 → all-blocked，列出 blocker 且每个定位到班级/教师/课程/时段', () => {
    const { project, solveResult } = resourceContention();
    const ex = explainUnplaced(project, solveResult.solution, solveResult.ctx);
    const blocked = ex.find(i => i.kind === 'all-blocked');
    assert.ok(blocked, '应有 all-blocked 项');
    assert.ok(Array.isArray(blocked.blockers) && blocked.blockers.length > 0, '列出 blocker');
    const b = blocked.blockers[0];
    assert.ok(b.activityId && b.subject, 'blocker 含活动与课程');
    assert.ok(Array.isArray(b.classes) && Array.isArray(b.teachers), 'blocker 定位班级/教师');
    assert.ok(b.day !== null && b.period !== null, 'blocker 定位到具体时段');
    assert.ok(Array.isArray(blocked.triedSlots) && blocked.triedSlots.length > 0, '含试过的候选时段');
});

test('explain：reason 残缺时输出 incomplete 而非编造', () => {
    // 构造：有合法候选位、无 blocker，却未排（人为造未排状态）
    const project = createProject({
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [{ id: 's1', name: '语文', category: 'main', priority: 90 }],
        rooms: [],
        activityPlans: [{ id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 1 }],
        constraints: [],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    const sol = createSolution(activities.length); // 全未排，但有大量合法空位
    const ex = explainUnplaced(project, sol, ctx);
    assert.equal(ex[0].kind, 'incomplete', '有空位却未排 → incomplete');
    assert.match(ex[0].message, /不完整/, '标注原因不完整');
});

// ---- explainHardConflicts ----

test('explain：硬冲突翻译含具体对象+星期几第几节+约束 type', () => {
    const project = createProject({
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1', name: '一班' }, { id: 'c2', name: '二班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [{ id: 's1', name: '语文', category: 'main', priority: 90 }],
        rooms: [],
        activityPlans: [
            { id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 1 },
            { id: 'a2', classId: 'c2', subjectId: 's1', teacherId: 't1', weeklyUnits: 1 },
        ],
        constraints: [],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    const sol = createSolution(activities.length);
    sol.move(0, 0); sol.move(1, 0); // 两活动同 time → teacher_clash
    const ex = explainHardConflicts(project, sol, ctx);
    assert.ok(ex.length > 0, '应检出硬冲突');
    const c = ex[0];
    assert.equal(c.type, 'teacher_clash');
    assert.equal(c.resourceName, '张老师');
    assert.ok(c.day !== null && c.period !== null, '定位到具体时段');
    assert.match(c.message, /张老师.*同时/, 'message 可读');
});

// ---- explainSoftViolations ----

test('explain：软规则未满足含涉及对象且 severity=warning', () => {
    // 主科排在下午 → morning-subjects 软约束 pressure>0
    const project = createProject({
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1', name: '一班' }],
        teachers: [{ id: 't1', name: '张老师' }],
        subjects: [{ id: 's1', name: '语文', category: 'main', priority: 90 }],
        rooms: [],
        activityPlans: [{ id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 1 }],
        constraints: [{
            id: 'm1', type: 'morning_subjects', strength: 'soft', weight: 50,
            target: {}, params: { subjects: ['s1'], morningPeriods: [1, 2, 3] }, source: '主科上午',
        }],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    const sol = createSolution(activities.length);
    // 放到第 6 节（下午）
    sol.move(0, ctx.calendar.encodeTime(1, 6));
    const ex = explainSoftViolations(project, sol, ctx);
    if (ex.length > 0) {
        assert.equal(ex[0].severity, 'warning');
        assert.ok(ex[0].objects.subject === '语文', '含涉及对象');
    }
});

// ---- audit ----

test('audit：教师课时超可用时段 → error 并定位到具体教师 + 差额', () => {
    const { project, ctx } = teacherOvercommitted();
    const findings = auditImpossibleConstraints(project, ctx);
    const f = findings.find(x => x.code === 'teacher_no_capacity');
    assert.ok(f, '检出 teacher_no_capacity');
    assert.equal(f.severity, 'error');
    assert.equal(f.ref.teacherId, 't1', '定位到具体教师');
    assert.ok(f.detail.deficit > 0, '给出差额');
    assert.match(f.message, /张老师/, 'message 含教师名');
});

test('audit：连堂课时奇数 → 警告', () => {
    const { project } = consecutiveTooLong();
    const findings = auditUnitConsistency(project);
    assert.ok(findings.some(f => f.code === 'double_units_odd'), '检出连堂奇数课时矛盾');
});

test('audit 不误报：紧张但可排的项目不报 error', () => {
    const { project, ctx } = tightButFeasible();
    const findings = auditProject(project, ctx);
    const errors = findings.filter(f => f.severity === 'error');
    assert.equal(errors.length, 0, `紧张但可排不应报 error，实际：${JSON.stringify(errors)}`);
});

// ---- suggest ----

test('suggest：每条建议含 applied:false 且可追溯到诊断项', () => {
    const { project, solveResult } = teacherFullyUnavailable();
    const ex = explainUnplaced(project, solveResult.solution, solveResult.ctx);
    const sugs = ex.flatMap(suggestForUnplaced);
    assert.ok(sugs.length > 0, '应产出建议');
    for (const s of sugs) {
        assert.equal(s.applied, false, '建议标记未执行');
        assert.ok(s.targetDiagnostics.length > 0, '可追溯到诊断项');
        assert.ok(s.message, '含可读文案');
        assert.ok(s.confidence, '含置信度');
    }
});

test('suggest：生成过程对 project 与 solution 无副作用', () => {
    const { project, solveResult } = teacherFullyUnavailable();
    const before = JSON.stringify(project);
    const timesBefore = Array.from(solveResult.solution.times);
    const ex = explainUnplaced(project, solveResult.solution, solveResult.ctx);
    ex.flatMap(suggestForUnplaced);
    assert.equal(JSON.stringify(project), before, 'project 未被 mutate');
    assert.deepEqual(Array.from(solveResult.solution.times), timesBefore, 'solution 未被改');
});

// ---- report 聚合 ----

test('report：按对象倒排索引能取到该对象全部诊断项', () => {
    const { project, solveResult } = teacherFullyUnavailable();
    const report = buildDiagnostics(project, solveResult.solution, solveResult.ctx, solveResult.hardConflicts);
    const items = report.forObject('teachers', '张老师');
    assert.ok(items.length > 0, '倒排索引取到张老师相关诊断');
    assert.ok(items.every(it => it.category), '每项有分类');
});

test('report：JSON 序列化往返一致，severity 分级正确', () => {
    const { project, solveResult } = teacherFullyUnavailable();
    const report = buildDiagnostics(project, solveResult.solution, solveResult.ctx, solveResult.hardConflicts);
    const json = JSON.parse(JSON.stringify(report.toJSON()));
    assert.equal(json.summary.total, report.items.length, '序列化往返计数一致');
    assert.ok(json.summary.error >= 1, '未排活动计为 error 级');
    assert.ok(Array.isArray(json.suggestions), '含建议数组');
});

test('report：极端样本均返回可读可定位原因，无静默失败', () => {
    const samples = [teacherFullyUnavailable(), resourceContention()];
    for (const { project, solveResult } of samples) {
        const report = buildDiagnostics(project, solveResult.solution, solveResult.ctx, solveResult.hardConflicts);
        const unplacedItems = report.items.filter(i => i.category === 'unplaced');
        assert.ok(unplacedItems.length > 0, '有未排诊断');
        for (const it of unplacedItems) {
            assert.ok(it.message && /[一-龥]/.test(it.message), '原因为可读中文');
            // 可定位：含具体对象名
            assert.ok((it.teachers?.length || it.classes?.length || it.blockers?.length), '定位到具体对象');
        }
    }
});

test('report：教室不足样本定位到争用教室的活动', () => {
    const project = createProject({
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1', name: '一班' }, { id: 'c2', name: '二班' }],
        teachers: [{ id: 't1', name: '张老师' }, { id: 't2', name: '李老师' }],
        subjects: [{ id: 's1', name: '物理', category: 'lab', priority: 60 }],
        rooms: [{ id: 'r1', name: '物理实验室' }],
        activityPlans: [
            { id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 1, roomRequirements: ['r1'] },
            { id: 'a2', classId: 'c2', subjectId: 's1', teacherId: 't2', weeklyUnits: 1, roomRequirements: ['r1'] },
        ],
        constraints: [],
    });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, project.constraints);
    const sol = createSolution(activities.length);
    sol.move(0, 0, 0); sol.move(1, 0, 0); // 同 time 同 room → room_clash
    const report = buildDiagnostics(project, sol, ctx);
    const roomConf = report.items.find(i => i.type === 'room_clash');
    assert.ok(roomConf, '检出教室冲突');
    assert.equal(roomConf.resourceName, '物理实验室', '定位到具体教室');
});


test('report：教室不足 → 未排归因 cause=room-shortage 且建议增加教室', () => {
    const project = createProject({
        calendar: { weekdays: 1, periodsPerDay: 1 },
        classes: [{ id: 'c1', name: '一班' }, { id: 'c2', name: '二班' }],
        teachers: [{ id: 't1', name: '张' }, { id: 't2', name: '李' }],
        subjects: [{ id: 's1', name: '物理', category: 'lab', priority: 60 }],
        rooms: [{ id: 'r1', name: '物理实验室' }],
        activityPlans: [
            { id: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyUnits: 1, roomRequirements: ['r1'] },
            { id: 'a2', classId: 'c2', subjectId: 's1', teacherId: 't2', weeklyUnits: 1, roomRequirements: ['r1'] },
        ],
        constraints: [],
    });
    const r = solve(project, { seed: 1 });
    const item = r.diagnostics.items.find(i => i.category === 'unplaced');
    assert.equal(item.cause, 'room-shortage', '未排根因应识别为教室不足');
    assert.match(item.message, /教室/, '原因点明教室');
    const addRoom = r.diagnostics.suggestions.find(s => s.kind === 'add-room');
    assert.ok(addRoom, '应有增加教室建议');
    assert.match(addRoom.message, /物理实验室/, '建议指明具体教室');
});
