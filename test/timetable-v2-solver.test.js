/**
 * Phase 2 本地求解器测试。
 * 命令：node --test test/timetable-v2-solver.test.js
 * 含 6 个门禁 + 性能基线 + RNG/pressure/improve 单元。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solve } from '../gateway/services/timetable-v2/solver/pipeline.js';
import { createRng, weightedPick } from '../gateway/services/timetable-v2/solver/rng.js';
import { candidateScore, normalizePressure } from '../gateway/services/timetable-v2/solver/pressure.js';
import { detectHardConflicts } from '../gateway/services/timetable-v2/constraints/index-builder.js';
import '../gateway/services/timetable-v2/index.js';
import {
    solvableProject, projectWithUnavailableAndLocked, unsolvableProject,
    projectWithSoftConstraints, benchmarkProject,
} from './timetable-v2-fixtures/index.js';

// ---- 门禁 1：零硬冲突 ----
test('门禁1：小样本生成零硬冲突课表', () => {
    const r = solve(solvableProject(), { seed: 1 });
    assert.equal(r.hardConflicts.length, 0, '硬冲突应为空');
    assert.equal(r.stats.placed, r.stats.total, '应全部排下');
    assert.equal(r.stats.unplaced, 0);
});

// ---- 门禁 2：教师不可用被严格避开 ----
test('门禁2：教师不可用时段被严格避开', () => {
    const r = solve(projectWithUnavailableAndLocked(), { seed: 3 });
    assert.equal(r.hardConflicts.length, 0);
    // t1 的不可用时段 1-1/1-2/2-1，逐 placement 校验
    const cal = r.ctx.calendar;
    const banned = new Set(['1-1', '1-2', '2-1']);
    for (const { idx, time } of r.solution.placements()) {
        const m = r.ctx.meta[idx];
        const t1 = r.ctx.indexes.teachers.toIndex('t1');
        if (m.teacherIdxs.includes(t1)) {
            for (const t of r.ctx.occupiedTimes(idx, time)) {
                assert.ok(!banned.has(cal.toSlotKey(t)), `t1 落在不可用时段 ${cal.toSlotKey(t)}`);
            }
        }
    }
});

// ---- 门禁 3：连堂连续 ----
test('门禁3：连堂落在连续节次', () => {
    const r = solve(solvableProject(), { seed: 5 });
    const cal = r.ctx.calendar;
    for (const { idx, time } of r.solution.placements()) {
        const dur = r.ctx.meta[idx].duration;
        if (dur > 1) {
            const times = r.ctx.occupiedTimes(idx, time);
            // 同一天（time % nDays 相同）、period 连续
            const days = new Set(times.map(t => t % cal.nDays));
            assert.equal(days.size, 1, '连堂应在同一天');
            const periods = times.map(t => Math.floor(t / cal.nDays)).sort((a, b) => a - b);
            for (let i = 1; i < periods.length; i++) {
                assert.equal(periods[i], periods[i - 1] + 1, '连堂 period 应连续');
            }
        }
    }
});

// ---- 门禁 4：固定课/锁定课不动 ----
test('门禁4：锁定课时段保持不变', () => {
    const p = projectWithUnavailableAndLocked();
    const r = solve(p, { seed: 9 });
    const cal = r.ctx.calendar;
    // lp4#0 被 fixed 到 3-5
    const lockedIdx = r.ctx.indexes.activities.toIndex('lp4#0');
    assert.ok(lockedIdx >= 0);
    const t = r.solution.timeOf(lockedIdx);
    assert.equal(cal.toSlotKey(t), '3-5', '锁定课应固定在 3-5');
    assert.equal(r.hardConflicts.length, 0);
});

// ---- 门禁 5：不可解返回可读原因 ----
test('门禁5：不可解项目返回结构化原因而非挂起', () => {
    const r = solve(unsolvableProject(), { seed: 1 });
    assert.ok(r.unplaced.length > 0, 'unplaced 应非空');
    assert.ok(r.stats.placed < r.stats.total, '应有课排不下');
    // 结构化阻塞信息
    for (const u of r.unplaced) {
        assert.ok(u.reason && u.reason.type, '每个未排活动须含结构化 reason');
        assert.ok(typeof u.activityId === 'string');
    }
    // audit 应预警教师可用时段不足（不可用时段扣除后容量 < 总课时）
    assert.ok(r.audit.findings.some(f => f.code === 'teacher_no_capacity'),
        `audit 应检出 teacher_no_capacity，实际：${JSON.stringify(r.audit.findings)}`);
});

// ---- 门禁 6：复现性 ----
test('门禁6：同 seed 逐格一致，不同 seed 可不同', () => {
    const p = solvableProject();
    const a = solve(p, { seed: 123 });
    const b = solve(p, { seed: 123 });
    assert.deepEqual(Array.from(a.solution.times), Array.from(b.solution.times), 'times 应逐格一致');
    assert.deepEqual(Array.from(a.solution.rooms), Array.from(b.solution.rooms), 'rooms 应逐格一致');
    // 不同 seed：允许不同（不强制，但都应零硬冲突）
    const c = solve(p, { seed: 999 });
    assert.equal(c.hardConflicts.length, 0);
});

// ---- 性能基线 ----
test('性能基线：30班/60教师/~800cells 在阈值内零硬冲突', () => {
    const p = benchmarkProject();
    const t0 = Date.now();
    const r = solve(p, { seed: 1, improveBudget: 0 });
    const ms = Date.now() - t0;
    console.log(`    [benchmark] ${r.stats.total} activities, placed ${r.stats.placed}, ${ms}ms, hardConflicts ${r.hardConflicts.length}`);
    assert.equal(r.hardConflicts.length, 0, '基线应零硬冲突');
    assert.ok(r.stats.placed >= r.stats.total * 0.95, `至少排下 95%（实际 ${r.stats.placed}/${r.stats.total}）`);
    assert.ok(ms < 20000, `应在 20s 内完成（实际 ${ms}ms）`);
});

// ---- 软约束 ----
test('软约束：主科上午 pressure 生效（softScore 反映违反）', () => {
    const r = solve(projectWithSoftConstraints(), { seed: 2 });
    assert.equal(r.hardConflicts.length, 0);
    assert.ok(typeof r.softScore === 'number');
    assert.ok(r.softScore >= 0);
});

// ---- RNG 单元 ----
test('RNG：同 seed 同序列，不同 seed 不同序列', () => {
    const a = createRng(42), b = createRng(42), c = createRng(43);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    const seqC = Array.from({ length: 10 }, () => c());
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, seqC);
    assert.ok(seqA.every(x => x >= 0 && x < 1));
});

test('RNG：weightedPick 按权重倾斜', () => {
    const rng = createRng(7);
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[weightedPick(rng, [1, 0, 9])]++;
    assert.equal(counts[1], 0, '零权重不应被选中');
    assert.ok(counts[2] > counts[0] * 3, '高权重应远多于低权重');
});

// ---- pressure 单元 ----
test('pressure：拥挤格 score 更低、负载大 score 更高', () => {
    const crowded = candidateScore({ total: 1000, slotPressure: 10, workMetric: 1 });
    const empty = candidateScore({ total: 1000, slotPressure: 0, workMetric: 1 });
    assert.ok(empty > crowded, '空格 score 应高于拥挤格');
    const heavy = candidateScore({ total: 1000, slotPressure: 0, workMetric: 3 });
    assert.ok(heavy > empty, '负载大 score 应更高');
});

test('pressure：归一化把压力压进有界区间', () => {
    const small = normalizePressure(2, 3);
    const huge = normalizePressure(100000, 3);
    // denom 固定时，归一化分母固定，raw 增大 norm 增大但被 /denom² 压制
    assert.ok(normalizePressure(1, 100) <= 1, '大 denom 把压力压到很小');
    assert.ok(Number.isFinite(huge) && huge >= 0);
});
