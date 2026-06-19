/**
 * Phase 1 约束体系 + 硬冲突检测单元测试。
 * 命令：node --test test/timetable-v2-constraints.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
    parseConstraint, parseConstraints, serializeConstraint,
    HARD_TYPES, SOFT_TYPES, ALL_TYPES,
} from '../gateway/services/timetable-v2/constraints/dsl.js';
import { registeredTypes } from '../gateway/services/timetable-v2/constraints/registry.js';
import { buildContext, detectHardConflicts } from '../gateway/services/timetable-v2/constraints/index-builder.js';
import { createProject, validateProject } from '../gateway/services/timetable-v2/domain/project.js';
import { expandActivityPlans } from '../gateway/services/timetable-v2/domain/activity.js';
import { Solution } from '../gateway/services/timetable-v2/domain/solution.js';
// 触发硬约束注册
import '../gateway/services/timetable-v2/index.js';
import { baseProject } from './timetable-v2-fixtures/index.js';

// ---- DSL ----

test('DSL：约束 JSON 序列化→解析往返一致，source 原文保留', () => {
    const raw = {
        id: 'r1', type: 'teacher_unavailable', target: { teacherId: 't1' },
        params: { slots: ['1-1', '1-2'] },
        source: { kind: 'natural_language', text: '张老师周一上午不排课' },
    };
    const parsed = parseConstraint(raw);
    const json = JSON.parse(JSON.stringify(serializeConstraint(parsed)));
    const reparsed = parseConstraint(json);
    assert.equal(reparsed.type, 'teacher_unavailable');
    assert.deepEqual(reparsed.params.slots, ['1-1', '1-2']);
    assert.equal(reparsed.source.text, '张老师周一上午不排课');
    assert.equal(reparsed.strength, 'hard');
    assert.equal(reparsed.weight, 100);
});

test('DSL：未知 type 被拒', () => {
    assert.throws(() => parseConstraint({ type: 'nonsense' }), /未知 type/);
});

test('DSL：软约束 type 清单完整登记且可往返（本阶段不评分）', () => {
    const expected = ['morning_subjects', 'subject_preferred_periods', 'teacher_limits', 'spread_subjects', 'balanced_teacher_load'];
    for (const t of expected) assert.ok(SOFT_TYPES.includes(t), `缺软约束 type ${t}`);
    const parsed = parseConstraints(expected.map((type, i) => ({ id: `s${i}`, type, weight: 40 })));
    for (const p of parsed) {
        assert.equal(p.strength, 'soft');
        const round = parseConstraint(JSON.parse(JSON.stringify(serializeConstraint(p))));
        assert.equal(round.type, p.type);
    }
    assert.equal(ALL_TYPES.length, HARD_TYPES.length + SOFT_TYPES.length);
});

test('注册表：8 个硬约束已注册', () => {
    const types = registeredTypes();
    for (const t of HARD_TYPES) assert.ok(types.includes(t), `硬约束 ${t} 未注册`);
});

// ---- 硬冲突检测 helpers ----

function ctxFor(rawProject, extraConstraints = []) {
    const project = createProject({ ...rawProject, constraints: extraConstraints });
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities, extraConstraints);
    return { project, activities, ctx };
}

function idxByPlan(activities, planId) {
    return activities.findIndex(a => a.planId === planId);
}

// ---- 资源冲突 ----

test('硬冲突：教师同时段冲突被识别', () => {
    const { activities, ctx } = ctxFor(baseProject(), [{ type: 'teacher_clash' }]);
    const sol = new Solution(activities.length);
    // lp1(c1,t1) 与 lp3(c2,t1) 同为 t1，放同一 time → 冲突
    const a = idxByPlan(activities, 'lp1');
    const b = idxByPlan(activities, 'lp3');
    sol.move(a, 0);
    sol.move(b, 0);
    const conflicts = detectHardConflicts(sol, ctx);
    const tc = conflicts.filter(c => c.type === 'teacher_clash');
    assert.ok(tc.length >= 1);
    assert.deepEqual(tc[0].activities.sort(), [a, b].sort());
});

test('硬冲突：班级同时段冲突被识别', () => {
    const { activities, ctx } = ctxFor(baseProject(), [{ type: 'class_clash' }]);
    const sol = new Solution(activities.length);
    // lp1(c1) 与 lp2(c1) 同班，放同一 time → 冲突
    const a = idxByPlan(activities, 'lp1');
    const b = idxByPlan(activities, 'lp2');
    sol.move(a, 5);
    sol.move(b, 5);
    const conflicts = detectHardConflicts(sol, ctx);
    assert.ok(conflicts.some(c => c.type === 'class_clash'));
});

test('硬冲突：教室同时段冲突被识别', () => {
    const { activities, ctx } = ctxFor(baseProject(), [{ type: 'room_clash' }]);
    const sol = new Solution(activities.length);
    const a = idxByPlan(activities, 'lp1');
    const b = idxByPlan(activities, 'lp2');
    sol.move(a, 3, 0); // 同教室 r0
    sol.move(b, 3, 0);
    const conflicts = detectHardConflicts(sol, ctx);
    assert.ok(conflicts.some(c => c.type === 'room_clash'));
});

test('硬冲突：无冲突时空列表', () => {
    const { activities, ctx } = ctxFor(baseProject(), [{ type: 'teacher_clash' }, { type: 'class_clash' }]);
    const sol = new Solution(activities.length);
    const a = idxByPlan(activities, 'lp1');
    const b = idxByPlan(activities, 'lp3'); // 都是 t1
    sol.move(a, 0);
    sol.move(b, 1); // 不同 time
    assert.equal(detectHardConflicts(sol, ctx).length, 0);
});

// ---- 不可用 ----

test('硬冲突：教师不可用时段被识别', () => {
    const { activities, ctx } = ctxFor(baseProject(), [
        { type: 'teacher_unavailable', target: { teacherId: 't1' }, params: { slots: ['1-1'] } },
    ]);
    const sol = new Solution(activities.length);
    const a = idxByPlan(activities, 'lp1'); // t1
    sol.move(a, ctx.calendar.parseSlotKey('1-1'));
    const conflicts = detectHardConflicts(sol, ctx);
    assert.ok(conflicts.some(c => c.type === 'teacher_unavailable'));
    // 反向：放到非不可用时段则无该冲突
    sol.undo(1);
    sol.move(a, ctx.calendar.parseSlotKey('3-2'));
    assert.equal(detectHardConflicts(sol, ctx).filter(c => c.type === 'teacher_unavailable').length, 0);
});

test('硬冲突：班级不可用时段被识别', () => {
    const { activities, ctx } = ctxFor(baseProject(), [
        { type: 'class_unavailable', target: { classId: 'c1' }, params: { slots: ['2-1'] } },
    ]);
    const sol = new Solution(activities.length);
    const a = idxByPlan(activities, 'lp1'); // c1
    sol.move(a, ctx.calendar.parseSlotKey('2-1'));
    assert.ok(detectHardConflicts(sol, ctx).some(c => c.type === 'class_unavailable'));
    // 反向：放到非不可用时段则无该冲突
    sol.undo(1);
    sol.move(a, ctx.calendar.parseSlotKey('4-3'));
    assert.equal(detectHardConflicts(sol, ctx).filter(c => c.type === 'class_unavailable').length, 0);
});

// ---- 连堂 / 有效时段 ----

test('硬冲突：连堂被拆到不连续节次判冲突', () => {
    const raw = baseProject();
    raw.activityPlans = [{ id: 'lpd', classId: 'c1', subjectId: 's_math', teacherId: 't1', weeklyHours: 2, blockPreference: 'double' }];
    const { activities, ctx } = ctxFor(raw, [{ type: 'consecutive' }]);
    const a = activities.findIndex(x => x.duration === 2);
    assert.ok(a >= 0);
    const sol = new Solution(activities.length);
    // 放在最后一个 period（period 6 → startPi=5），duration2 会溢出当天 → 冲突
    const lastPeriod = ctx.calendar.activePeriods[ctx.calendar.nPeriods - 1];
    sol.move(a, ctx.calendar.encodeTime(1, lastPeriod));
    assert.ok(detectHardConflicts(sol, ctx).some(c => c.type === 'consecutive'));
});

test('硬冲突：连堂落在连续节次不判冲突', () => {
    const raw = baseProject();
    raw.activityPlans = [{ id: 'lpd', classId: 'c1', subjectId: 's_math', teacherId: 't1', weeklyHours: 2, blockPreference: 'double' }];
    const { activities, ctx } = ctxFor(raw, [{ type: 'consecutive' }]);
    const a = activities.findIndex(x => x.duration === 2);
    const sol = new Solution(activities.length);
    sol.move(a, ctx.calendar.encodeTime(1, 1)); // period1 起，duration2 → period1,2 连续
    assert.equal(detectHardConflicts(sol, ctx).filter(c => c.type === 'consecutive').length, 0);
});

test('硬冲突：超出有效范围的 placement 判冲突', () => {
    const { activities, ctx } = ctxFor(baseProject(), [{ type: 'valid_timeslot' }]);
    const sol = new Solution(activities.length);
    sol.move(0, 999); // 远超 slotCount
    assert.ok(detectHardConflicts(sol, ctx).some(c => c.type === 'valid_timeslot'));
});

// ---- 固定/锁定 ----

test('硬冲突：锁定活动被移动到非 fixedTime 判冲突', () => {
    const { activities, ctx } = ctxFor(baseProject(), [{ type: 'fixed_locked' }]);
    const a = idxByPlan(activities, 'lp1');
    // 手动锁定该活动到 time 0
    ctx.meta[a].locked = true;
    ctx.meta[a].fixedTime = 0;
    ctx.shared.lockedActivities ??= new Map();
    ctx.shared.lockedActivities.set(a, 0);
    const sol = new Solution(activities.length);
    sol.move(a, 5); // 非 fixedTime
    assert.ok(detectHardConflicts(sol, ctx).some(c => c.type === 'fixed_locked'));
    sol.undo(1);
    sol.move(a, 0); // fixedTime
    assert.equal(detectHardConflicts(sol, ctx).filter(c => c.type === 'fixed_locked').length, 0);
});

test('单双周：同 time 但单/双周不冲突', () => {
    const raw = baseProject();
    raw.activityPlans = [{ id: 'oe', classId: 'c1', subjectId: 's_pe', teacherId: 't3', weeklyHours: 1, weekPattern: 'oddeven' }];
    const { activities, ctx } = ctxFor(raw, [{ type: 'class_clash' }]);
    assert.equal(activities.length, 2); // odd + even
    const sol = new Solution(activities.length);
    sol.move(0, 0);
    sol.move(1, 0); // 同 time，但一 odd 一 even
    assert.equal(detectHardConflicts(sol, ctx).filter(c => c.type === 'class_clash').length, 0);
});

// ---- 审查修复：自动播种 / 强度锁定 / 重复 id ----

test('自动播种：空约束项目仍检测教师同时段冲突', () => {
    // 不注入任何 constraints，全局硬约束应自动生效
    const { activities, ctx } = ctxFor(baseProject(), []);
    const sol = new Solution(activities.length);
    const a = idxByPlan(activities, 'lp1');
    const b = idxByPlan(activities, 'lp3'); // 均 t1
    sol.move(a, 0);
    sol.move(b, 0);
    assert.ok(detectHardConflicts(sol, ctx).some(c => c.type === 'teacher_clash'),
        '空约束时教师撞课未被检测（自动播种失效）');
});

test('自动播种：Activity 自带 locked/fixedTime 无需 DSL 即被检测', () => {
    const { activities, ctx } = ctxFor(baseProject(), []);
    const a = idxByPlan(activities, 'lp1');
    ctx.meta[a].locked = true;
    ctx.meta[a].fixedTime = 0;
    ctx.shared.lockedActivities ??= new Map();
    ctx.shared.lockedActivities.set(a, 0);
    const sol = new Solution(activities.length);
    sol.move(a, 7); // 非 fixedTime
    assert.ok(detectHardConflicts(sol, ctx).some(c => c.type === 'fixed_locked'));
});

test('DSL：硬 type 不可被 strength:soft 降级', () => {
    const c = parseConstraint({ type: 'teacher_clash', strength: 'soft', weight: 10 });
    assert.equal(c.strength, 'hard');
    assert.equal(c.weight, 100);
});

test('DSL：缺省 id 在批内稳定（非全局自增）', () => {
    const a = parseConstraints([{ type: 'teacher_clash' }, { type: 'class_clash' }]);
    const b = parseConstraints([{ type: 'teacher_clash' }, { type: 'class_clash' }]);
    assert.deepEqual(a.map(x => x.id), b.map(x => x.id)); // 两次解析 id 一致
});

test('project 校验：重复 id 被拒', () => {
    const raw = baseProject();
    raw.classes.push({ id: 'c1', name: '重复班' }); // 重复 classId
    const res = validateProject(raw);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /重复的 id "c1"/.test(e)));
});

test('自动播种：6 个无参全局硬约束被注册并实例化', () => {
    const { ctx } = ctxFor(baseProject(), []);
    const seededTypes = new Set(ctx.constraints.map(c => c.type));
    for (const t of ['teacher_clash', 'class_clash', 'room_clash', 'valid_timeslot', 'consecutive', 'fixed_locked']) {
        assert.ok(seededTypes.has(t), `全局硬约束 ${t} 未被播种`);
    }
});

test('index-builder：硬约束未注册时抛错而非静默放行', () => {
    // 隔离子进程：只导入 registry/dsl/index-builder，不导入 index.js（后者会自注册全部硬约束）。
    // 故意只注册一个非冲突的硬 type，再让 buildContext 播种 teacher_clash 等 → 取不到实现应抛错。
    const script = `
import { buildContext } from './gateway/services/timetable-v2/constraints/index-builder.js';
import { createProject } from './gateway/services/timetable-v2/domain/project.js';
import { expandActivityPlans } from './gateway/services/timetable-v2/domain/activity.js';
// 注意：不 import index.js，故 registry 为空
const proj = createProject({ calendar:{weekdays:5,periodsPerDay:6},
  classes:[{id:'c1'}], teachers:[{id:'t1'}],
  subjects:[{id:'s',name:'x',category:'main',priority:50}], rooms:[],
  activityPlans:[{id:'a',classId:'c1',subjectId:'s',teacherId:'t1',weeklyHours:1}], constraints:[] });
const acts = expandActivityPlans(proj.activityPlans);
try {
  buildContext(proj, acts, []);
  console.log('NO_THROW');
} catch (e) {
  console.log(/未注册/.test(e.message) ? 'THREW_EXPECTED' : 'THREW_OTHER:' + e.message);
}
`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(), encoding: 'utf8',
    }).trim();
    assert.equal(out, 'THREW_EXPECTED', `期望未注册硬约束抛错，实际：${out}`);
});
