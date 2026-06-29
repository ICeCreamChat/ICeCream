/**
 * timetable-v2 / domain / activity.js
 *
 * ActivityPlan（教学计划）与 Activity（可排活动），及展开器 expandActivityPlans。
 *
 * 字段对齐旧 timetable-project.js：
 *   weeklyUnits     ← 旧 weeklyHours（每周课时）
 *   durationPattern ← 旧 blockPreference（'single'|'double'|'mixed' 连堂偏好）
 *   teacherIds[]    ← 旧 teacherIds（多教师，含从 teacherId 合并）
 *   classIds[]      ← 合班（旧单 classId 升为数组）
 *   roomRequirements← 旧 allowedRoomIds[] / roomId
 *
 * 展开规则（决策 1：以 Activity 为中心）：
 *   - 'single'：weeklyUnits 个 duration=1 的活动
 *   - 'double'：尽量拆成 duration=2 的连堂块，奇数余 1 个 duration=1
 *   - 'mixed' ：与 'double' 同（连堂优先，余数单节），后续 Phase 可细化
 *   - weekPattern 'all' 不拆；'oddeven'（单双周各一套）按需拆成 odd/even 两组
 *   展开后所有活动的 duration 之和恒等于 weeklyUnits。
 *
 * 纯函数、零 IO。
 */

import { normalizeWeekPattern } from './calendar.js';

export const DURATION_PATTERNS = Object.freeze(['single', 'double', 'mixed']);

/**
 * 构造并校验一个 ActivityPlan。
 */
export function createActivityPlan(raw = {}) {
    const id = String(raw.id ?? '').trim();
    if (!id) throw new Error('activityPlan: 缺少 id');

    const subjectId = String(raw.subjectId ?? '').trim();
    if (!subjectId) throw new Error(`activityPlan ${id}: 缺少 subjectId`);

    // 合班：classIds[] 优先，兼容单 classId
    const classIds = normalizeIdList(raw.classIds, raw.classId);
    if (classIds.length === 0) throw new Error(`activityPlan ${id}: 至少需要一个 classId`);

    // 多教师：teacherIds[] 优先，兼容单 teacherId（合并且 teacherId 置首）
    const teacherIds = normalizeIdList(raw.teacherIds, raw.teacherId);
    if (teacherIds.length === 0) throw new Error(`activityPlan ${id}: 至少需要一个 teacherId`);

    const weeklyUnits = Number.parseInt(raw.weeklyUnits ?? raw.weeklyHours, 10);
    if (!Number.isInteger(weeklyUnits) || weeklyUnits <= 0) {
        throw new Error(`activityPlan ${id}: weeklyUnits 必须是正整数，收到 ${raw.weeklyUnits ?? raw.weeklyHours}`);
    }

    const durationPattern = DURATION_PATTERNS.includes(raw.durationPattern)
        ? raw.durationPattern
        : (DURATION_PATTERNS.includes(raw.blockPreference) ? raw.blockPreference : 'single');

    // 教室需求：roomRequirements[] 优先，兼容旧 allowedRoomIds[] / roomId
    const roomRequirements = normalizeIdList(
        raw.roomRequirements ?? raw.allowedRoomIds,
        raw.roomId,
    );

    // weekPattern：'all'（每周）或 'oddeven'（单双周各排一套）
    const weekPattern = raw.weekPattern === 'oddeven' ? 'oddeven' : 'all';

    const priority = clampInt(raw.priority, 50, 1, 100);

    return {
        id,
        classIds,
        subjectId,
        teacherIds,
        weeklyUnits,
        durationPattern,
        roomRequirements,
        weekPattern,
        priority,
        tags: Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim()).filter(Boolean) : [],
    };
}

/**
 * 把一组 ActivityPlan 展开成可排 Activity。
 * @param {object[]} plans 已 createActivityPlan 的计划（或裸对象，会被规范化）
 * @returns {object[]} Activity 列表
 */
export function expandActivityPlans(plans = []) {
    const activities = [];
    for (const raw of plans) {
        const plan = raw && raw.weeklyUnits !== undefined && Array.isArray(raw.classIds)
            ? raw
            : createActivityPlan(raw);
        activities.push(...expandOne(plan));
    }
    return activities;
}

function expandOne(plan) {
    // 单双周：把 weeklyUnits 分别在 odd / even 各排一套。
    if (plan.weekPattern === 'oddeven') {
        return [
            ...buildBlocks(plan, plan.weeklyUnits, 'odd'),
            ...buildBlocks(plan, plan.weeklyUnits, 'even'),
        ];
    }
    return buildBlocks(plan, plan.weeklyUnits, 'all');
}

/**
 * 按 durationPattern 把 units 节课拆成若干活动块。
 * duration 之和恒等于 units。
 */
function buildBlocks(plan, units, weekPattern) {
    const blocks = [];
    let remaining = units;
    let seq = 0;

    const useDouble = plan.durationPattern === 'double' || plan.durationPattern === 'mixed';
    if (useDouble) {
        while (remaining >= 2) {
            blocks.push(makeActivity(plan, 2, weekPattern, seq++));
            remaining -= 2;
        }
    }
    while (remaining >= 1) {
        blocks.push(makeActivity(plan, 1, weekPattern, seq++));
        remaining -= 1;
    }
    return blocks;
}

function makeActivity(plan, duration, weekPattern, seq) {
    const wp = normalizeWeekPattern(weekPattern);
    const suffix = plan.weekPattern === 'oddeven' ? `${wp}_${seq}` : String(seq);
    return {
        id: `${plan.id}#${suffix}`,
        planId: plan.id,
        classIds: [...plan.classIds],
        teacherIds: [...plan.teacherIds],
        subjectId: plan.subjectId,
        duration,
        allowedRooms: [...plan.roomRequirements],
        weekPattern: wp,
        priority: plan.priority,
        fixedTime: null, // 由约束/导入器后续填充
        locked: false,
    };
}

// ---- helpers ----

/** 合并 list 与可选 single，single 置首，去重，转字符串。 */
function normalizeIdList(list, single) {
    const out = [];
    const push = v => {
        const id = String(v ?? '').trim();
        if (id && !out.includes(id)) out.push(id);
    };
    const singleId = String(single ?? '').trim();
    if (singleId) push(singleId);
    if (Array.isArray(list)) list.forEach(push);
    else if (list !== undefined && list !== null) push(list);
    return out;
}

function clampInt(value, fallback, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
