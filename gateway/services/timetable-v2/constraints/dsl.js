/**
 * timetable-v2 / constraints / dsl.js
 *
 * 约束 DSL 解析与序列化（决策 5：可序列化，JSON 往返）。
 * source 保留自然语言原文，为 Phase 4 诊断与 Phase 3 导入留锚点。
 *
 * type 清单本阶段一次列全（避免 Phase 2 返工）。软约束本阶段只定义形态，不实现评分。
 *
 * 纯函数、零 IO。
 */

import { STRENGTH } from './base.js';

/** 硬约束 type 清单。 */
export const HARD_TYPES = Object.freeze([
    'teacher_clash',      // 教师同时段唯一
    'class_clash',        // 班级同时段唯一
    'room_clash',         // 教室同时段唯一
    'teacher_unavailable',// 教师不可用时段
    'class_unavailable',  // 班级不可用时段
    'fixed_locked',       // 固定课/锁定课不可移动
    'consecutive',        // 连堂必须连续
    'valid_timeslot',     // 活动落在有效日期/节次内
]);

/** 软约束 type 清单（对齐旧 timetable-project.js softRules；本阶段只登记形态，不评分）。 */
export const SOFT_TYPES = Object.freeze([
    'morning_subjects',         // 主科上午（旧 morningSubjects）
    'subject_preferred_periods',// 科目偏好/回避节次（旧 subjectPreferredPeriods）
    'teacher_limits',           // 教师每日/连续上限（旧 teacherLimits）
    'spread_subjects',          // 同科分散（旧 spreadSubjects）
    'balanced_teacher_load',    // 教师日负载均衡（旧 balancedTeacherLoad）
]);

export const ALL_TYPES = Object.freeze([...HARD_TYPES, ...SOFT_TYPES]);

const TYPE_SET = new Set(ALL_TYPES);
const HARD_SET = new Set(HARD_TYPES);


/**
 * 规范化一个约束 DSL 对象。校验 type、补全 strength/weight。
 * @param {object} raw
 * @param {number} [seq] 稳定序号（同批解析内用于派生缺省 id，避免全局计数器导致 id 不稳定）
 * @returns {{id,type,strength,scope,target,weight,params,source}}
 * @throws 当 type 不在清单内
 */
export function parseConstraint(raw = {}, seq = 0) {
    const type = String(raw.type ?? '').trim();
    if (!TYPE_SET.has(type)) {
        throw new Error(`constraint DSL: 未知 type "${type}"，应在 ${ALL_TYPES.join('|')} 内`);
    }

    // 硬 type 锁死 strength=hard，不允许被 strength:'soft' 降级而绕过冲突检测。
    const isHardType_ = HARD_SET.has(type);
    const strength = isHardType_
        ? STRENGTH.HARD
        : (raw.strength === STRENGTH.HARD || raw.strength === STRENGTH.SOFT ? raw.strength : STRENGTH.SOFT);

    // weight：hard 恒为 100（必守）；soft 取 raw.weight 或 50，范围 0–100。
    let weight = Number(raw.weight);
    if (!Number.isFinite(weight)) weight = strength === STRENGTH.HARD ? 100 : 50;
    weight = Math.max(0, Math.min(100, weight));
    if (strength === STRENGTH.HARD) weight = 100;

    const id = String(raw.id ?? '').trim() || `${type}_${seq}`;

    return {
        id,
        type,
        strength,
        scope: raw.scope ?? null,
        target: raw.target ?? {},
        weight,
        params: raw.params ?? {},
        source: normalizeSource(raw.source),
    };
}

/** 解析一组约束（缺省 id 用批内稳定序号派生）。 */
export function parseConstraints(list = []) {
    return (Array.isArray(list) ? list : []).map((raw, i) => parseConstraint(raw, i));
}

/** 序列化为可 JSON 化的纯对象（保留 source 原文）。 */
export function serializeConstraint(c) {
    return {
        id: c.id,
        type: c.type,
        strength: c.strength,
        scope: c.scope ?? null,
        target: c.target ?? {},
        weight: c.weight,
        params: c.params ?? {},
        source: c.source ?? null,
    };
}

export function serializeConstraints(list = []) {
    return list.map(serializeConstraint);
}

export function isHardType(type) {
    return HARD_SET.has(type);
}

function normalizeSource(source) {
    if (!source) return null;
    if (typeof source === 'string') return { kind: 'natural_language', text: source };
    if (typeof source === 'object') {
        return {
            kind: String(source.kind ?? 'natural_language'),
            text: String(source.text ?? ''),
            ...(source.ref ? { ref: source.ref } : {}),
        };
    }
    return null;
}
