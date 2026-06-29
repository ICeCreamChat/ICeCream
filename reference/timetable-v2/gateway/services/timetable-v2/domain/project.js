/**
 * timetable-v2 / domain / project.js
 *
 * SchoolProjectV2 工厂 + schema 校验（引用完整性）。
 * 拒绝悬空引用（ActivityPlan 引用不存在的 teacher/subject/room/class），给出可读错误。
 *
 * 纯函数、零 IO。
 */

import { createCalendar } from './calendar.js';
import { createSubject } from './subject.js';
import { createActivityPlan } from './activity.js';

/**
 * 构造并校验一个 SchoolProjectV2。
 * @param {object} raw
 * @throws 当结构非法或存在悬空引用，错误信息指明缺失引用
 */
export function createProject(raw = {}) {
    const errors = [];

    const id = String(raw.id ?? 'default').trim() || 'default';
    const name = String(raw.name ?? raw.schoolName ?? '').trim();

    const calendar = createCalendar(raw.calendar ?? raw);

    const classes = asArray(raw.classes).map((c, i) => normalizeClass(c, i, errors));
    const teachers = asArray(raw.teachers).map((t, i) => normalizeTeacher(t, i, errors));
    const rooms = asArray(raw.rooms).map((r, i) => normalizeRoom(r, i, errors));

    const subjects = [];
    asArray(raw.subjects).forEach((s, i) => {
        try {
            subjects.push(createSubject(s));
        } catch (e) {
            errors.push(`subjects[${i}]: ${e.message}`);
        }
    });

    // 重复 id 检测（去重前），避免索引层静默合并导致活动错位。
    checkDuplicateIds(classes, 'classes', errors);
    checkDuplicateIds(teachers, 'teachers', errors);
    checkDuplicateIds(subjects, 'subjects', errors);
    checkDuplicateIds(rooms, 'rooms', errors);

    const classIdSet = new Set(classes.map(c => c.id));
    const teacherIdSet = new Set(teachers.map(t => t.id));
    const subjectIdSet = new Set(subjects.map(s => s.id));
    const roomIdSet = new Set(rooms.map(r => r.id));

    const activityPlans = [];
    asArray(raw.activityPlans).forEach((p, i) => {
        let plan;
        try {
            plan = createActivityPlan(p);
        } catch (e) {
            errors.push(`activityPlans[${i}]: ${e.message}`);
            return;
        }
        // 引用完整性
        if (!subjectIdSet.has(plan.subjectId)) {
            errors.push(`activityPlans[${i}] (${plan.id}): 引用了不存在的 subjectId "${plan.subjectId}"`);
        }
        for (const cid of plan.classIds) {
            if (!classIdSet.has(cid)) errors.push(`activityPlans[${i}] (${plan.id}): 引用了不存在的 classId "${cid}"`);
        }
        for (const tid of plan.teacherIds) {
            if (!teacherIdSet.has(tid)) errors.push(`activityPlans[${i}] (${plan.id}): 引用了不存在的 teacherId "${tid}"`);
        }
        for (const rid of plan.roomRequirements) {
            if (!roomIdSet.has(rid)) errors.push(`activityPlans[${i}] (${plan.id}): 引用了不存在的 roomId "${rid}"`);
        }
        activityPlans.push(plan);
    });

    const constraints = asArray(raw.constraints);

    checkDuplicateIds(activityPlans, 'activityPlans', errors);

    if (errors.length) {
        const err = new Error(`SchoolProjectV2 校验失败：\n- ${errors.join('\n- ')}`);
        err.validationErrors = errors;
        throw err;
    }

    return { id, name, calendar, classes, teachers, subjects, rooms, activityPlans, constraints };
}

/**
 * 只校验不抛错，返回 { ok, errors }。
 */
export function validateProject(raw = {}) {
    try {
        createProject(raw);
        return { ok: true, errors: [] };
    } catch (e) {
        return { ok: false, errors: e.validationErrors ?? [e.message] };
    }
}

// ---- helpers ----

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

/** 检测同一实体列表内的重复 id，登记可读错误。 */
function checkDuplicateIds(items, label, errors) {
    const seen = new Set();
    for (const it of items) {
        if (!it.id) continue; // 缺 id 已在各自 normalize 报错
        if (seen.has(it.id)) errors.push(`${label}: 重复的 id "${it.id}"`);
        seen.add(it.id);
    }
}

function normalizeClass(raw, i, errors) {
    const id = String(raw?.id ?? '').trim();
    if (!id) errors.push(`classes[${i}]: 缺少 id`);
    return {
        id,
        name: String(raw?.name ?? '').trim(),
        grade: String(raw?.grade ?? '').trim(),
    };
}

function normalizeTeacher(raw, i, errors) {
    const id = String(raw?.id ?? '').trim();
    if (!id) errors.push(`teachers[${i}]: 缺少 id`);
    return {
        id,
        name: String(raw?.name ?? '').trim(),
        subjects: Array.isArray(raw?.subjects) ? raw.subjects.map(s => String(s).trim()).filter(Boolean) : [],
    };
}

function normalizeRoom(raw, i, errors) {
    const id = String(raw?.id ?? '').trim();
    if (!id) errors.push(`rooms[${i}]: 缺少 id`);
    return {
        id,
        name: String(raw?.name ?? '').trim(),
        capacity: Number.isInteger(Number(raw?.capacity)) ? Number(raw.capacity) : null,
        type: String(raw?.type ?? '').trim() || null,
    };
}
