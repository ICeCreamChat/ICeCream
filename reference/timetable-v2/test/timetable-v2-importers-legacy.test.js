/**
 * 旧 ICeCream 项目导入器测试（Phase 3）。
 * 命令：node --test test/timetable-v2-importers-legacy.test.js
 *
 * 覆盖 spec：Legacy Project Import Without Overwrite + Legacy Schedule As Locked Reference
 * 以及 Importers Produce Valid SchoolProjectV2 / Migration Report 的相关 Scenario。
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
import { importLegacyProject } from '../gateway/services/timetable-v2/importers/legacy-project.js';
import { legacyProjectSample } from './timetable-v2-fixtures/legacy-project-sample.js';

function findPlan(project, id) {
    return project.activityPlans.find(p => p.id === id);
}

test('产物通过 SchoolProjectV2 校验，返回 { project, report, raw }', () => {
    const { project, report, raw } = importLegacyProject(legacyProjectSample());
    assert.ok(project && report && raw, '应返回三元组');
    const { ok, errors } = validateProject(project);
    assert.ok(ok, `项目应通过校验：${errors.join('; ')}`);
    assert.equal(typeof report.summary, 'function');
    assert.equal(report.sourceKind, 'legacy-project');
});

test('不 mutate 入参：导入前后旧项目深度相等', () => {
    const sample = legacyProjectSample();
    const before = JSON.parse(JSON.stringify(sample));
    const { raw } = importLegacyProject(sample);
    assert.deepEqual(sample, before, '入参不得被改写');
    assert.equal(raw, sample, 'raw 应保留原文引用');
});

test('lessonPlans → ActivityPlan：weeklyHours→weeklyUnits，多教师合并去重', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const lp1 = findPlan(project, 'lp1');
    assert.equal(lp1.weeklyUnits, 2);
    assert.deepEqual(lp1.roomRequirements, ['r1']);

    const multi = findPlan(project, 'lp_multi');
    // teacherId 't1' + teacherIds ['t1','t2'] → 去重 ['t1','t2']，全保留
    assert.deepEqual(multi.teacherIds, ['t1', 't2'], '多教师应去重且全保留');
});

test('blockPreference 映射 durationPattern：single/double/mixed + 非枚举降级 single', () => {
    const { project, report } = importLegacyProject(legacyProjectSample());
    assert.equal(findPlan(project, 'lp1').durationPattern, 'single');
    assert.equal(findPlan(project, 'lp2').durationPattern, 'double');
    assert.equal(findPlan(project, 'lp3').durationPattern, 'mixed');
    // lp4 blockPreference='quad' 非枚举 → 降级 single 且记 degraded
    assert.equal(findPlan(project, 'lp4').durationPattern, 'single');
    const deg = report.entries.find(e => e.category === 'degraded' && e.field === 'lessonPlan.blockPreference');
    assert.ok(deg, '非枚举 blockPreference 应记 degraded');
    assert.equal(deg.originalValue, 'quad');
});

test('double 计划展开出 duration>1 连堂活动，总课时 == weeklyUnits', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const lp2 = findPlan(project, 'lp2'); // weeklyUnits 2, double
    const acts = expandActivityPlans([lp2]);
    const total = acts.reduce((s, a) => s + a.duration, 0);
    assert.equal(total, lp2.weeklyUnits, '展开后总 duration 应等于 weeklyUnits');
    assert.ok(acts.some(a => a.duration > 1), '应含 duration>1 的连堂活动');
});

test('连堂块还原：同 blockId 的两 slot 合并为单个 duration=2 锁定活动（非两个单节）', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const schedPlans = project.activityPlans.filter(p => p.id.startsWith('sched_'));
    // block b1（2 格, double） + block b2（3 格, 降级 single） + 两个单格 → 4 个锁定计划
    assert.equal(schedPlans.length, 4, '应为 1 连堂块(2) + 1 降级块(3) + 2 单格 = 4 个锁定计划');
    const block = schedPlans.find(p => p.weeklyUnits === 2 && p.durationPattern === 'double');
    assert.ok(block, '应存在 weeklyUnits=2 的连堂锁定计划');
    assert.equal(block.durationPattern, 'double');
    const acts = expandActivityPlans([block]);
    assert.equal(acts.length, 1, '连堂块应展开为单个活动，而非两个单节');
    assert.equal(acts[0].duration, 2);
});

test('C-2 blockSize≥3 降级：不谎报 kept，记 degraded，且每个已排格都被锁（无自由浮动）', () => {
    const { project, report } = importLegacyProject(legacyProjectSample());

    // 报告：blockSize=3 应记 degraded（明说 durationPattern 仅支持 1/2），不得有 kept 谎报"合并为单个 duration=3"
    const deg = report.entries.find(e => e.category === 'degraded'
        && e.field === 'schedule.block' && /blockSize=3/.test(e.reason));
    assert.ok(deg, 'blockSize=3 应记 degraded 并说明 durationPattern 仅支持 1/2');
    const lie = report.entries.find(e => e.category === 'kept' && /duration=3/.test(e.reason));
    assert.ok(!lie, '不得谎报"合并为单个 duration=3"');

    // 降级计划：single + weeklyUnits=3 → 展开 3 个单节活动
    const degraded = project.activityPlans.find(p => p.id.startsWith('sched_')
        && p.weeklyUnits === 3 && p.durationPattern === 'single');
    assert.ok(degraded, '应存在 weeklyUnits=3、single 的降级锁定计划');
    const degActs = expandActivityPlans([degraded]);
    assert.equal(degActs.length, 3, 'blockSize=3 应展开为 3 个单节活动');

    // 该块展开出的全部活动都必须被锁定（fixedTime 非空），无自由浮动
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities);
    const idxs = activities
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.planId === degraded.id)
        .map(({ i }) => i);
    assert.equal(idxs.length, 3, '降级块应有 3 个展开活动');
    for (const i of idxs) {
        assert.ok(ctx.meta[i].fixedTime !== null && ctx.meta[i].fixedTime !== undefined,
            `降级块活动 ${i} 必须有 fixedTime（被锁定，无自由浮动）`);
    }
});

test('M-1 periodTimes/term 不静默丢：各记报告并留存 project.metadata', () => {
    const { project, report } = importLegacyProject(legacyProjectSample());
    // term → degraded 并入 metadata
    const termEntry = report.entries.find(e => e.field === 'project.term');
    assert.ok(termEntry, 'term 应有迁移报告条目');
    assert.equal(project.metadata?.term, '2026 秋', 'term 应留存于 metadata 旁路');
    // periodTimes → dropped（非空），原值留存 metadata
    const ptEntry = report.entries.find(e => e.field === 'project.periodTimes');
    assert.ok(ptEntry, 'periodTimes 应有迁移报告条目');
    assert.equal(ptEntry.category, 'dropped', 'periodTimes V2 不承载应记 dropped');
    assert.ok(Array.isArray(project.metadata?.periodTimes) && project.metadata.periodTimes.length === 2,
        'periodTimes 原值应留存于 metadata 旁路');
});

test('M-3 悬空 fixed_locked：lessonPlanId 指向不存在计划 → dropped，不生成悬空约束', () => {
    const { project, report } = importLegacyProject(legacyProjectSample());
    // lock_ghost 引用 lp_ghost（不存在）→ dropped
    const dropped = report.entries.find(e => e.category === 'dropped'
        && e.field === 'lockedSlot.lessonPlanId');
    assert.ok(dropped, '悬空 lockedSlot.lessonPlanId 应记 dropped');

    // 不得生成绑定 lp_ghost 的 fixed_locked 约束
    const ghost = project.constraints.find(c => c.type === 'fixed_locked'
        && c.target?.activityId === 'lp_ghost#0');
    assert.ok(!ghost, '不得生成悬空 fixed_locked 约束');

    // 有效 lockedSlot（lp1）仍保留
    assert.ok(project.constraints.some(c => c.type === 'fixed_locked' && c.target?.activityId === 'lp1#0'),
        '有效 lockedSlot 仍应生成 fixed_locked');

    // 产物仍过校验，buildContext 不抛错
    assert.ok(validateProject(project).ok, '丢弃悬空约束后产物仍应通过校验');
    const activities = expandActivityPlans(project.activityPlans);
    assert.doesNotThrow(() => {
        const ctx = buildContext(project, activities);
        detectHardConflicts(createSolution(activities.length), ctx);
    }, 'buildContext + detectHardConflicts 不应因悬空引用抛错');
});

test('locked reference：已排格按 fixedTime 锁定，求解/校验自身零硬冲突', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities);
    const sol = createSolution(activities.length);

    // 把所有带 fixedTime 的锁定活动放到其 fixedTime。
    let lockedCount = 0;
    ctx.meta.forEach((m, idx) => {
        if (m.fixedTime !== null && m.fixedTime !== undefined) {
            sol.move(idx, m.fixedTime);
            lockedCount++;
        }
    });
    assert.ok(lockedCount >= 4, `应有锁定活动（schedule 3 + lockedSlot 1），实际 ${lockedCount}`);

    const conflicts = detectHardConflicts(sol, ctx);
    assert.deepEqual(conflicts, [], `锁定参考自身应零硬冲突：${JSON.stringify(conflicts)}`);
});

test('locked reference 不可移动：把锁定活动挪到别处触发 fixed_locked 冲突', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const activities = expandActivityPlans(project.activityPlans);
    const ctx = buildContext(project, activities);
    const sol = createSolution(activities.length);

    // 找一个锁定活动，移到一个不同的有效 time。
    const lockedIdx = ctx.meta.findIndex(m => m.fixedTime !== null && m.fixedTime !== undefined);
    assert.ok(lockedIdx >= 0, '应存在锁定活动');
    const fixed = ctx.meta[lockedIdx].fixedTime;
    const elsewhere = fixed === 0 ? 1 : 0;
    sol.move(lockedIdx, elsewhere);

    const conflicts = detectHardConflicts(sol, ctx);
    assert.ok(conflicts.some(c => c.type === 'fixed_locked'), '锁定活动被移动应触发 fixed_locked 冲突');
});

test('subject.category/priority → 软约束草稿：main 上午、lab 后段', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const soft = project.constraints.filter(c => c.strength === 'soft');
    const mainDraft = soft.find(c => c.type === 'subject_preferred_periods'
        && c.target?.subjectId === 's_math' && c.source?.text?.includes('main'));
    assert.ok(mainDraft, 'main 课程应生成上午偏好软约束草稿');
    assert.ok(mainDraft.params.prefer.length > 0, 'main 应 prefer 上午节次');
    assert.equal(mainDraft.params.weight, 95, 'priority 作为权重输入');

    const labDraft = soft.find(c => c.type === 'subject_preferred_periods'
        && c.target?.subjectId === 's_sci' && c.source?.text?.includes('lab'));
    assert.ok(labDraft, 'lab 课程应生成后段偏好软约束草稿');
    assert.ok(labDraft.params.avoid.length > 0, 'lab 应 avoid 早节');
});

test('hardRules 逐项映射为硬约束 DSL', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const c = project.constraints;
    // lockedSlots → fixed_locked
    assert.ok(c.some(x => x.type === 'fixed_locked' && x.target?.activityId === 'lp1#0'), 'lockedSlots → fixed_locked');
    // teacherUnavailable + teachers[].unavailableSlots 合并去重 → teacher_unavailable
    const tu = c.find(x => x.type === 'teacher_unavailable' && x.target?.teacherId === 't1');
    assert.ok(tu && tu.params.slots.includes('5-6'), 'teacherUnavailable → teacher_unavailable');
    const tu2 = c.find(x => x.type === 'teacher_unavailable' && x.target?.teacherId === 't2');
    assert.ok(tu2 && tu2.params.slots.includes('5-4'), 'teachers[].unavailableSlots 合并入 teacher_unavailable');
    // classUnavailable → class_unavailable
    assert.ok(c.some(x => x.type === 'class_unavailable' && x.target?.classId === 'c2' && x.params.slots.includes('5-5')), 'classUnavailable → class_unavailable');
});

test('softRules 逐项映射为软约束 DSL 草稿', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const c = project.constraints.filter(x => x.strength === 'soft');
    // morningSubjects → subject_preferred_periods
    assert.ok(c.some(x => x.type === 'subject_preferred_periods' && x.source?.ref?.includes('morningSubjects')), 'morningSubjects → subject_preferred_periods');
    // subjectPreferredPeriods 直译
    assert.ok(c.some(x => x.type === 'subject_preferred_periods' && x.target?.subjectId === 's_sci' && x.source?.ref?.includes('subjectPreferredPeriods')), 'subjectPreferredPeriods 直译');
    // teacherLimits daily/consecutive → teacher_limits
    const tl = c.find(x => x.type === 'teacher_limits' && x.target?.teacherId === 't1');
    assert.ok(tl && tl.params.daily === 4 && tl.params.consecutive === 2, 'teacherLimits daily+consecutive → teacher_limits');
    // spreadSubjects → spread_subjects
    assert.ok(c.some(x => x.type === 'spread_subjects' && x.params.subjectIds.includes('s_math')), 'spreadSubjects → spread_subjects');
    // balancedTeacherLoad → balanced_teacher_load
    assert.ok(c.some(x => x.type === 'balanced_teacher_load'), 'balancedTeacherLoad → balanced_teacher_load');
});

test('发布历史只读带入：published + history 含嵌套 projectContext，损坏快照 degraded', () => {
    const { project, report } = importLegacyProject(legacyProjectSample());
    const ph = project.publishedHistory;
    assert.ok(ph, '应带入 publishedHistory');
    assert.equal(ph.status, 'published');
    assert.equal(ph.version, 2);
    assert.equal(ph.scheduleId, 'sched_demo');
    assert.equal(ph.fingerprint, 'fp_v2');
    // history：1 条有效（含 projectContext） + 1 条损坏被剔除
    assert.equal(ph.history.length, 1, '损坏历史快照应被剔除');
    assert.ok(ph.history[0].snapshot.projectContext, '有效历史保留嵌套 projectContext');
    assert.ok(report.entries.some(e => e.category === 'degraded' && e.field === 'published.history'), '损坏快照应记 degraded');
});

test('发布历史与入参解耦：改产物不影响入参', () => {
    const sample = legacyProjectSample();
    const { project } = importLegacyProject(sample);
    project.publishedHistory.note = 'MUTATED';
    assert.equal(sample.schedule.published.note, '正式发布 v2', '产物改动不得回写入参');
});

test('喂求解器门禁：expandActivityPlans 成功 + 锁定格自身无硬冲突 + 结构可消费', () => {
    const { project } = importLegacyProject(legacyProjectSample());
    const activities = expandActivityPlans(project.activityPlans);
    assert.ok(activities.length > 0, '展开应产出活动');
    const ctx = buildContext(project, activities);
    assert.ok(ctx.constraints.length > 0, '应编译出约束实例');
    // 空解（全未分配）应无硬冲突
    const empty = createSolution(activities.length);
    assert.deepEqual(detectHardConflicts(empty, ctx), [], '空解应无硬冲突');
});

test('迁移报告：summary 与条目一致，无静默丢失，含来源定位', () => {
    const { report } = importLegacyProject(legacyProjectSample());
    const check = verifyReportConsistency(report);
    assert.ok(check.ok, `报告应自洽：${check.reason ?? ''}`);
    const summary = report.summary();
    assert.equal(summary.total, report.entries.length);
    // 每条含来源定位与 field
    for (const e of report.entries) {
        assert.ok(e.field, '条目应含 field');
        assert.ok(e.source !== undefined, '条目应含 source 来源定位');
    }
    // 至少覆盖 kept / degraded 两类（含降级字段）
    assert.ok(summary.counts.kept > 0, '应有 kept 条目');
    assert.ok(summary.counts.degraded > 0, '应有 degraded 条目（非枚举 blockPreference/category、损坏历史）');
});

test('无法映射字段进入报告：悬空引用不静默丢、不抛错中断', () => {
    const sample = legacyProjectSample();
    // 注入悬空引用：lessonPlan 引用不存在的 subject
    sample.lessonPlans.push({ id: 'lp_bad', classId: 'c1', subjectId: 's_ghost', teacherId: 't1', weeklyHours: 1, blockPreference: 'single' });
    const { project, report } = importLegacyProject(sample);
    assert.ok(validateProject(project).ok, '悬空计划应被丢弃而非令校验失败');
    assert.ok(!findPlan(project, 'lp_bad'), '悬空计划不应进入 V2');
    assert.ok(report.entries.some(e => e.category === 'dropped' && e.field === 'lessonPlan.subjectId'), '悬空引用应记 dropped');
});
