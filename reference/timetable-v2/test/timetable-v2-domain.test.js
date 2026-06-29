/**
 * Phase 1 领域模型单元测试。
 * 命令：node --test test/timetable-v2-domain.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createCalendar, parseSlotKey, toSlotKey, UNALLOCATED, weekPatternsOverlap,
} from '../gateway/services/timetable-v2/domain/calendar.js';
import { createSubject, SUBJECT_CATEGORIES } from '../gateway/services/timetable-v2/domain/subject.js';
import { createActivityPlan, expandActivityPlans } from '../gateway/services/timetable-v2/domain/activity.js';
import { Solution } from '../gateway/services/timetable-v2/domain/solution.js';
import { createProject, validateProject } from '../gateway/services/timetable-v2/domain/project.js';
import { baseProject, doubleBlockPlan, comboPlan, oddEvenPlan } from './timetable-v2-fixtures/index.js';

test('时间编码：encode/decode 对全 day×period 往返一致', () => {
    const cal = createCalendar({ weekdays: 5, periodsPerDay: 6 });
    for (const day of cal.activeWeekdays) {
        for (const period of cal.activePeriods) {
            const t = cal.encodeTime(day, period);
            assert.notEqual(t, UNALLOCATED);
            assert.deepEqual(cal.decodeTime(t), { day, period });
        }
    }
    assert.equal(cal.slotCount, 30);
});

test('时间编码：越界返回哨兵', () => {
    const cal = createCalendar({ weekdays: 5, periodsPerDay: 6 });
    assert.equal(cal.encodeTime(6, 1), UNALLOCATED); // day 6 不在 1..5
    assert.equal(cal.encodeTime(1, 7), UNALLOCATED); // period 7 不在 1..6
    assert.equal(cal.decodeTime(UNALLOCATED), null);
    assert.equal(cal.decodeTime(999), null);
});

test('与旧 day-period 字符串互转：1-3 无损往返', () => {
    const cal = createCalendar({ weekdays: 5, periodsPerDay: 6 });
    const t = cal.parseSlotKey('1-3');
    assert.equal(cal.toSlotKey(t), '1-3');
    // 独立解析函数
    assert.deepEqual(parseSlotKey('1-3'), { day: 1, period: 3 });
    assert.equal(toSlotKey(1, 3), '1-3');
});

test('与旧 day-period 字符串互转：非法格式被拒', () => {
    assert.throws(() => parseSlotKey('abc'));
    assert.throws(() => parseSlotKey('1-99'), /period/);
    assert.throws(() => parseSlotKey('9-1'), /day/);
    const cal = createCalendar({ weekdays: 5, periodsPerDay: 6 });
    assert.throws(() => cal.parseSlotKey('6-1'), /有效/); // 合法格式但不在日历有效集
});

test('单双周：weekPatternsOverlap 区分单/双/每周', () => {
    assert.equal(weekPatternsOverlap('odd', 'even'), false);
    assert.equal(weekPatternsOverlap('odd', 'odd'), true);
    assert.equal(weekPatternsOverlap('all', 'odd'), true);
    assert.equal(weekPatternsOverlap('all', 'all'), true);
});

test('Subject 字段：category/priority/tags/color 保留', () => {
    const s = createSubject({ id: 's1', name: '数学', category: 'main', priority: 95, tags: ['考试科目', '考试科目'], color: '#abcdef' });
    assert.equal(s.category, 'main');
    assert.equal(s.priority, 95);
    assert.deepEqual(s.tags, ['考试科目']); // 去重
    assert.equal(s.color, '#abcdef');
    assert.ok(SUBJECT_CATEGORIES.includes(s.category));
});

test('Subject 校验：category 非法或 priority 越界被拒', () => {
    assert.throws(() => createSubject({ id: 's1', name: 'x', category: 'unknown', priority: 50 }), /category/);
    assert.throws(() => createSubject({ id: 's1', name: 'x', category: 'main', priority: 0 }), /priority/);
    assert.throws(() => createSubject({ id: 's1', name: 'x', category: 'main', priority: 101 }), /priority/);
});

test('Activity 展开：single 展开为 weeklyUnits 个 duration=1', () => {
    const acts = expandActivityPlans([{ id: 'lp', classId: 'c1', subjectId: 's', teacherId: 't', weeklyHours: 3, blockPreference: 'single' }]);
    assert.equal(acts.length, 3);
    assert.ok(acts.every(a => a.duration === 1));
    assert.equal(acts.reduce((s, a) => s + a.duration, 0), 3);
});

test('Activity 展开：double(blockPreference) 展开为 duration=2，奇数余单节', () => {
    const acts = expandActivityPlans([doubleBlockPlan()]); // weeklyHours 3
    const durations = acts.map(a => a.duration).sort();
    assert.deepEqual(durations, [1, 2]);
    assert.equal(acts.reduce((s, a) => s + a.duration, 0), 3); // 总课时守恒
});

test('Activity 展开：mixed 连堂优先余单节，总课时守恒', () => {
    // 本阶段 mixed 与 double 同义（连堂优先、余数单节），后续 Phase 可细化
    const acts = expandActivityPlans([{ id: 'lpm', classId: 'c1', subjectId: 's', teacherId: 't', weeklyHours: 5, blockPreference: 'mixed' }]);
    assert.equal(acts.reduce((s, a) => s + a.duration, 0), 5); // 守恒
    assert.deepEqual(acts.map(a => a.duration).sort(), [1, 2, 2]); // 2+2+1
    assert.ok(acts.some(a => a.duration === 2), 'mixed 应产生连堂块');
});

test('Activity 展开：合班含多 classIds、多教师含多 teacherIds、roomRequirements 保留', () => {
    const acts = expandActivityPlans([comboPlan()]);
    assert.equal(acts.length, 1);
    assert.deepEqual(acts[0].classIds, ['c1', 'c2']);
    assert.deepEqual(acts[0].teacherIds, ['t3', 't1']);
    assert.deepEqual(acts[0].allowedRooms, ['r2']);
});

test('Activity 展开：单双周拆成 odd/even 两套', () => {
    const acts = expandActivityPlans([oddEvenPlan()]); // weeklyHours 1, oddeven
    assert.equal(acts.length, 2);
    const patterns = acts.map(a => a.weekPattern).sort();
    assert.deepEqual(patterns, ['even', 'odd']);
});

test('ActivityPlan 字段：weeklyUnits 对齐旧 weeklyHours，durationPattern 对齐 blockPreference', () => {
    const plan = createActivityPlan({ id: 'lp', classId: 'c1', subjectId: 's', teacherId: 't', weeklyHours: 4, blockPreference: 'double' });
    assert.equal(plan.weeklyUnits, 4);
    assert.equal(plan.durationPattern, 'double');
});

test('Solution：move 后 placements 正确', () => {
    const sol = new Solution(3);
    sol.move(0, 10, 1);
    sol.move(2, 5);
    const p = sol.placements();
    assert.equal(p.length, 2);
    assert.deepEqual(p.find(x => x.idx === 0), { idx: 0, time: 10, room: 1 });
    assert.deepEqual(p.find(x => x.idx === 2), { idx: 2, time: 5, room: -1 });
});

test('Solution：undo(n) 精确回滚 times/rooms', () => {
    const sol = new Solution(2);
    sol.move(0, 3, 1);
    const snapTimes = Int32Array.from(sol.times);
    const snapRooms = Int32Array.from(sol.rooms);
    sol.move(0, 7, 0);
    sol.move(1, 9, 1);
    sol.undo(2);
    assert.deepEqual(Array.from(sol.times), Array.from(snapTimes));
    assert.deepEqual(Array.from(sol.rooms), Array.from(snapRooms));
    assert.equal(sol.historyLength, 1);
});

test('Solution：越界下标抛错', () => {
    const sol = new Solution(2);
    assert.throws(() => sol.move(5, 1));
});

test('project 校验：合法 baseProject 通过', () => {
    const p = createProject(baseProject());
    assert.equal(p.classes.length, 2);
    assert.equal(p.teachers.length, 3);
    assert.equal(p.subjects.length, 3);
    assert.equal(p.activityPlans.length, 3);
    assert.equal(p.calendar.slotCount, 30);
});

test('project 校验：悬空引用被拒并给出可读错误', () => {
    const raw = baseProject();
    raw.activityPlans.push({ id: 'bad', classId: 'cX', subjectId: 'sX', teacherId: 'tX', weeklyHours: 1, allowedRoomIds: ['rX'] });
    const res = validateProject(raw);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /subjectId "sX"/.test(e)));
    assert.ok(res.errors.some(e => /classId "cX"/.test(e)));
    assert.ok(res.errors.some(e => /teacherId "tX"/.test(e)));
    assert.ok(res.errors.some(e => /roomId "rX"/.test(e)), '悬空 roomId 未被检测');
    assert.throws(() => createProject(raw), /校验失败/);
});
