import {
    isActiveTimetableSlot,
    slotKey,
    slotTeacherIds,
} from './timetable-project.js';

export function createTimetableUsage() {
    return {
        teacher: new Set(),
        class: new Set(),
        room: new Set(),
        classSubjectDay: new Map(),
        teacherDay: new Map(),
    };
}

export function addUsage(usage, slot) {
    const key = slotKey(slot.day, slot.period);
    for (const teacherId of slotTeacherIds(slot)) usage.teacher.add(`${teacherId}:${key}`);
    usage.class.add(`${slot.classId}:${key}`);
    if (slot.roomId) usage.room.add(`${slot.roomId}:${key}`);

    const classSubjectDay = `${slot.classId}:${slot.subjectId}:${slot.day}`;
    usage.classSubjectDay.set(classSubjectDay, (usage.classSubjectDay.get(classSubjectDay) || 0) + 1);

    for (const teacherId of slotTeacherIds(slot)) {
        const teacherDay = `${teacherId}:${slot.day}`;
        usage.teacherDay.set(teacherDay, (usage.teacherDay.get(teacherDay) || 0) + 1);
    }
}

export function removeUsage(usage, slot) {
    const key = slotKey(slot.day, slot.period);
    for (const teacherId of slotTeacherIds(slot)) usage.teacher.delete(`${teacherId}:${key}`);
    usage.class.delete(`${slot.classId}:${key}`);
    if (slot.roomId) usage.room.delete(`${slot.roomId}:${key}`);

    const classSubjectDay = `${slot.classId}:${slot.subjectId}:${slot.day}`;
    usage.classSubjectDay.set(classSubjectDay, Math.max(0, (usage.classSubjectDay.get(classSubjectDay) || 0) - 1));

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

    if (slot.day < 1 || slot.day > project.weekdays || slot.period < 1 || slot.period > project.periodsPerDay) {
        return { ok: false, reason: '节次超出当前作息范围' };
    }
    if (!isActiveTimetableSlot(project, slot.day, slot.period)) {
        return { ok: false, reason: '节次超出当前作息范围' };
    }
    if (teacherIds.some(teacherId => teacherUnavailable(project, teacherId).has(key))) {
        return { ok: false, reason: '教师不可排时间' };
    }
    if (classUnavailable(project, slot.classId).has(key)) {
        return { ok: false, reason: '班级不可排时间' };
    }
    if (!options.ignoreTeacher && teacherIds.some(teacherId => usage.teacher.has(`${teacherId}:${key}`))) {
        return { ok: false, reason: '教师同节已有课程' };
    }
    if (!options.ignoreClass && usage.class.has(`${slot.classId}:${key}`)) {
        return { ok: false, reason: '班级同节已有课程' };
    }
    if (slot.roomId && !options.ignoreRoom && usage.room.has(`${slot.roomId}:${key}`)) {
        return { ok: false, reason: '教室同节已被占用' };
    }
    return { ok: true };
}

export function detectScheduleConflicts(project, slots = []) {
    const conflicts = [];
    const teacher = new Map();
    const klass = new Map();
    const room = new Map();

    for (const slot of slots) {
        const key = slotKey(slot.day, slot.period);
        const classKey = `${slot.classId}:${key}`;
        const roomKey = slot.roomId ? `${slot.roomId}:${key}` : null;

        for (const teacherId of slotTeacherIds(slot)) {
            const teacherKey = `${teacherId}:${key}`;
            if (teacher.has(teacherKey)) {
                conflicts.push({ type: 'teacher-conflict', severity: 'hard', slot, message: '教师同节冲突' });
            }
            teacher.set(teacherKey, slot);
        }
        if (klass.has(classKey)) {
            conflicts.push({ type: 'class-conflict', severity: 'hard', slot, message: '班级同节冲突' });
        }
        if (roomKey && room.has(roomKey)) {
            conflicts.push({ type: 'room-conflict', severity: 'hard', slot, message: '教室同节冲突' });
        }

        klass.set(classKey, slot);
        if (roomKey) room.set(roomKey, slot);

        const check = canUseSlot(project, createTimetableUsage(), slot, {
            ignoreTeacher: true,
            ignoreClass: true,
            ignoreRoom: true,
        });
        if (!check.ok) {
            conflicts.push({ type: 'availability-conflict', severity: 'hard', slot, message: check.reason });
        }
    }

    return conflicts;
}

export function conflictLabel(type) {
    return ({
        'teacher-conflict': '教师冲突',
        'class-conflict': '班级冲突',
        'room-conflict': '教室冲突',
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
