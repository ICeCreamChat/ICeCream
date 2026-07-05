import {
    campusIdForSlot,
    isActiveTimetableSlot,
    slotKey,
    slotClassIds,
    slotTeacherIds,
    weekPatternForSlot,
    weekPatternsOverlap,
} from './timetable-project.js';

export function createTimetableUsage() {
    return {
        teacher: new Set(),
        class: new Set(),
        room: new Set(),
        entries: [],
        classSubjectDay: new Map(),
        teacherDay: new Map(),
    };
}

function normalizedSlot(project, slot = {}) {
    return {
        ...slot,
        weekPattern: weekPatternForSlot(project, slot),
        campusId: campusIdForSlot(project, slot),
        classIds: slotClassIds(slot),
        teacherIds: slotTeacherIds(slot),
    };
}

function sameCell(left = {}, right = {}) {
    return Number(left.day) === Number(right.day) && Number(left.period) === Number(right.period);
}

function entryOverlaps(project, left = {}, right = {}) {
    return sameCell(left, right)
        && weekPatternsOverlap(weekPatternForSlot(project, left), weekPatternForSlot(project, right));
}

function usageConflicts(project, usage, slot, kind, resourceId) {
    const entries = Array.isArray(usage.entries) ? usage.entries : [];
    return entries.find(entry => {
        if (!entryOverlaps(project, entry, slot)) return false;
        if (kind === 'teacher') return slotTeacherIds(entry).includes(resourceId);
        if (kind === 'class') return slotClassIds(entry).includes(resourceId);
        if (kind === 'room') return entry.roomId && entry.roomId === resourceId;
        return false;
    }) || null;
}

function commuteGapForTeacher(project = {}, teacherId = '') {
    const rules = project.commuteRules || {};
    const teacherGap = Number.parseInt(rules.teacherGapPeriods?.[teacherId], 10);
    if (Number.isInteger(teacherGap) && teacherGap >= 0) return teacherGap;
    const defaultGap = Number.parseInt(rules.defaultGapPeriods, 10);
    return Number.isInteger(defaultGap) && defaultGap >= 0 ? defaultGap : 0;
}

function usageCommuteConflict(project, usage, slot, teacherId) {
    const campusId = campusIdForSlot(project, slot);
    const gap = commuteGapForTeacher(project, teacherId);
    if (!campusId || gap <= 0) return null;
    const entries = Array.isArray(usage.entries) ? usage.entries : [];
    return entries.find(entry => {
        if (Number(entry.day) !== Number(slot.day)) return false;
        if (!weekPatternsOverlap(weekPatternForSlot(project, entry), weekPatternForSlot(project, slot))) return false;
        if (!slotTeacherIds(entry).includes(teacherId)) return false;
        const entryCampus = campusIdForSlot(project, entry);
        if (!entryCampus || entryCampus === campusId) return false;
        const distance = Math.abs(Number(entry.period) - Number(slot.period));
        return distance > 0 && distance <= gap;
    }) || null;
}

export function addUsage(usage, slot) {
    const key = slotKey(slot.day, slot.period);
    for (const teacherId of slotTeacherIds(slot)) usage.teacher.add(`${teacherId}:${key}`);
    for (const classId of slotClassIds(slot)) usage.class.add(`${classId}:${key}`);
    if (slot.roomId) usage.room.add(`${slot.roomId}:${key}`);
    if (!Array.isArray(usage.entries)) usage.entries = [];
    usage.entries.push(slot);

    for (const classId of slotClassIds(slot)) {
        const classSubjectDay = `${classId}:${slot.subjectId}:${slot.day}`;
        usage.classSubjectDay.set(classSubjectDay, (usage.classSubjectDay.get(classSubjectDay) || 0) + 1);
    }

    for (const teacherId of slotTeacherIds(slot)) {
        const teacherDay = `${teacherId}:${slot.day}`;
        usage.teacherDay.set(teacherDay, (usage.teacherDay.get(teacherDay) || 0) + 1);
    }
}

export function removeUsage(usage, slot) {
    const key = slotKey(slot.day, slot.period);
    for (const teacherId of slotTeacherIds(slot)) usage.teacher.delete(`${teacherId}:${key}`);
    for (const classId of slotClassIds(slot)) usage.class.delete(`${classId}:${key}`);
    if (slot.roomId) usage.room.delete(`${slot.roomId}:${key}`);
    if (Array.isArray(usage.entries)) {
        const index = usage.entries.findIndex(entry => entry.id === slot.id);
        if (index >= 0) usage.entries.splice(index, 1);
    }

    for (const classId of slotClassIds(slot)) {
        const classSubjectDay = `${classId}:${slot.subjectId}:${slot.day}`;
        usage.classSubjectDay.set(classSubjectDay, Math.max(0, (usage.classSubjectDay.get(classSubjectDay) || 0) - 1));
    }

    for (const teacherId of slotTeacherIds(slot)) {
        const teacherDay = `${teacherId}:${slot.day}`;
        usage.teacherDay.set(teacherDay, Math.max(0, (usage.teacherDay.get(teacherDay) || 0) - 1));
    }
}

export function teacherUnavailable(project, teacherId) {
    const teacher = project.teachers.find(item => item.id === teacherId);
    return new Set([
        ...(teacher?.unavailableSlots || []),
        ...(project.rules?.hardRules?.teacherUnavailable?.[teacherId] || []),
    ]);
}

export function classUnavailable(project, classId) {
    return new Set(project.rules?.hardRules?.classUnavailable?.[classId] || []);
}

export function canUseSlot(project, usage, slot, options = {}) {
    const key = slotKey(slot.day, slot.period);
    const teacherIds = slotTeacherIds(slot);
    const classIds = slotClassIds(slot);

    if (slot.day < 1 || slot.day > project.weekdays || slot.period < 1 || slot.period > project.periodsPerDay) {
        return { ok: false, reason: '节次超出当前作息范围' };
    }
    if (!isActiveTimetableSlot(project, slot.day, slot.period)) {
        return { ok: false, reason: '节次超出当前作息范围' };
    }
    if (teacherIds.some(teacherId => teacherUnavailable(project, teacherId).has(key))) {
        return { ok: false, reason: '教师不可排时间' };
    }
    if (classIds.some(classId => classUnavailable(project, classId).has(key))) {
        return { ok: false, reason: '班级不可排时间' };
    }
    if (!options.ignoreTeacher) {
        for (const teacherId of teacherIds) {
            if (usageConflicts(project, usage, slot, 'teacher', teacherId)) return { ok: false, reason: '教师同节已有课程' };
            if (usageCommuteConflict(project, usage, slot, teacherId)) return { ok: false, reason: '教师跨校区通勤间隔不足' };
        }
    }
    if (!options.ignoreClass) {
        for (const classId of classIds) {
            if (usageConflicts(project, usage, slot, 'class', classId)) return { ok: false, reason: '班级同节已有课程' };
        }
    }
    if (slot.roomId && !options.ignoreRoom && usageConflicts(project, usage, slot, 'room', slot.roomId)) {
        return { ok: false, reason: '教室同节已被占用' };
    }
    return { ok: true };
}

export function detectScheduleConflicts(project, slots = []) {
    const conflicts = [];
    const seen = [];

    for (const rawSlot of slots) {
        const slot = normalizedSlot(project, rawSlot);
        const classIds = slotClassIds(slot);
        const weekPattern = weekPatternForSlot(project, slot);

        for (const teacherId of slotTeacherIds(slot)) {
            const match = seen.find(entry => (
                slotTeacherIds(entry).includes(teacherId)
                && entryOverlaps(project, entry, slot)
            ));
            if (match) {
                conflicts.push({
                    type: match.weekPattern !== weekPattern ? 'week_pattern_conflict' : 'teacher-conflict',
                    severity: 'hard',
                    slot,
                    teacherId,
                    message: match.weekPattern !== weekPattern ? '周次重叠导致教师同节冲突' : '教师同节冲突',
                });
            }
        }
        for (const classId of classIds) {
            const match = seen.find(entry => (
                slotClassIds(entry).includes(classId)
                && entryOverlaps(project, entry, slot)
            ));
            if (match) {
                const groupConflict = Boolean(slot.teachingGroupId || match.teachingGroupId || classIds.length > 1 || slotClassIds(match).length > 1);
                conflicts.push({
                    type: groupConflict ? 'teaching_group_conflict' : match.weekPattern !== weekPattern ? 'week_pattern_conflict' : 'class-conflict',
                    severity: 'hard',
                    slot,
                    classId,
                    message: groupConflict ? '教学组成员班级同节冲突' : match.weekPattern !== weekPattern ? '周次重叠导致班级同节冲突' : '班级同节冲突',
                });
            }
        }
        if (slot.roomId) {
            const match = seen.find(entry => entry.roomId === slot.roomId && entryOverlaps(project, entry, slot));
            if (match) {
                conflicts.push({ type: 'room-conflict', severity: 'hard', slot, roomId: slot.roomId, message: '教室同节冲突' });
            }
        }

        const check = canUseSlot(project, createTimetableUsage(), slot, {
            ignoreTeacher: true,
            ignoreClass: true,
            ignoreRoom: true,
        });
        if (!check.ok) {
            conflicts.push({ type: 'availability-conflict', severity: 'hard', slot, message: check.reason });
        }
        for (const teacherId of slotTeacherIds(slot)) {
            const campusId = campusIdForSlot(project, slot);
            const gap = commuteGapForTeacher(project, teacherId);
            if (!campusId || gap <= 0) continue;
            const commute = seen.find(entry => (
                slotTeacherIds(entry).includes(teacherId)
                && Number(entry.day) === Number(slot.day)
                && weekPatternsOverlap(weekPatternForSlot(project, entry), weekPattern)
                && campusIdForSlot(project, entry)
                && campusIdForSlot(project, entry) !== campusId
                && Math.abs(Number(entry.period) - Number(slot.period)) > 0
                && Math.abs(Number(entry.period) - Number(slot.period)) <= gap
            ));
            if (commute) {
                conflicts.push({
                    type: 'campus_commute_conflict',
                    severity: 'hard',
                    slot,
                    teacherId,
                    message: '教师跨校区课程间隔不足',
                });
            }
        }
        seen.push(slot);
    }

    return conflicts;
}

export function conflictLabel(type) {
    return ({
        'teacher-conflict': '教师冲突',
        'class-conflict': '班级冲突',
        'room-conflict': '教室冲突',
        week_pattern_conflict: '周次冲突',
        teaching_group_conflict: '教学组冲突',
        campus_commute_conflict: '跨校区通勤',
        'availability-conflict': '不可排时间',
        'locked-conflict': '锁定冲突',
        unplaced: '未排课时',
    })[type] || '其他冲突';
}

export function summarizeScheduleConflicts(schedule = {}) {
    const conflicts = Array.isArray(schedule.conflicts) ? schedule.conflicts : [];
    const counts = {};
    let hardCount = 0;

    for (const conflict of conflicts) {
        const type = conflict.type || 'other';
        counts[type] = (counts[type] || 0) + 1;
        if (conflict.severity === 'hard' || !conflict.severity) hardCount += 1;
    }

    const items = Object.entries(counts)
        .map(([type, count]) => ({
            type,
            count,
            label: conflictLabel(type),
        }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-Hans-CN'));

    return {
        total: conflicts.length,
        hardCount,
        counts,
        items,
    };
}
