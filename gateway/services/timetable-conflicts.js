import {
    campusIdForSlot,
    getTimeBlockKind,
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

function timeToMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

function periodInterval(project = {}, period) {
    const entry = (project.periodTimes || []).find(item => Number(item.period) === Number(period));
    const start = timeToMinutes(entry?.start);
    const end = timeToMinutes(entry?.end);
    if (start === null || end === null || end <= start) return null;
    return { start, end };
}

function segmentInterval(project = {}, segment = {}) {
    const start = timeToMinutes(segment.startTime);
    if (start === null) return null;
    const defaults = project.periodTimeSegments?.globalDefaults || {};
    const periodCount = Math.max(1, Number.parseInt(segment.periodCount, 10) || 1);
    const classMinutes = Math.max(1, Math.min(180, Number.parseInt(segment.classMinutes ?? defaults.classMinutes, 10) || 45));
    const breakMinutes = Math.max(0, Math.min(120, Number.parseInt(segment.breakMinutes ?? defaults.breakMinutes, 10) || 0));
    const end = start + (periodCount * classMinutes) + Math.max(0, periodCount - 1) * breakMinutes;
    return { start, end };
}

function intervalsOverlap(left = null, right = null) {
    if (!left || !right) return false;
    return left.start < right.end && right.start < left.end;
}

function dutyOccupancies(project = {}) {
    const segmentById = new Map((project.periodTimeSegments?.segments || [])
        .filter(segment => getTimeBlockKind(segment) === 'duty')
        .map(segment => [segment.id, segment]));
    return (project.dutyAssignments || [])
        .filter(item => item && item.status !== 'paused')
        .map(item => {
            const segment = segmentById.get(item.timeBlockId);
            const interval = segmentInterval(project, segment);
            if (!segment || !interval) return null;
            return {
                id: item.id,
                day: Number(item.day),
                classId: item.classId,
                teacherId: item.teacherId,
                timeBlockId: item.timeBlockId,
                interval,
                assignment: item,
                segment,
            };
        })
        .filter(Boolean);
}

function dutyConflictsForSlot(project = {}, slot = {}, teacherId = '') {
    const interval = periodInterval(project, slot.period);
    if (!interval) return null;
    return dutyOccupancies(project).find(duty => (
        duty.teacherId === teacherId
        && Number(duty.day) === Number(slot.day)
        && intervalsOverlap(duty.interval, interval)
    )) || null;
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
            if (dutyConflictsForSlot(project, slot, teacherId)) return { ok: false, reason: '教师附加时段值班冲突' };
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
    const normalizedSlots = [];

    for (const rawSlot of slots) {
        const slot = normalizedSlot(project, rawSlot);
        normalizedSlots.push(slot);
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

    const duties = dutyOccupancies(project);
    for (const duty of duties) {
        const lessonMatch = normalizedSlots.find(slot => (
            Number(slot.day) === Number(duty.day)
            && slotTeacherIds(slot).includes(duty.teacherId)
            && intervalsOverlap(periodInterval(project, slot.period), duty.interval)
        ));
        if (lessonMatch) {
            conflicts.push({
                type: 'duty_lesson_teacher_conflict',
                severity: 'hard',
                slot: lessonMatch,
                dutyAssignment: duty.assignment,
                teacherId: duty.teacherId,
                message: '值班老师与正式课时间冲突',
            });
        }
    }
    for (let leftIndex = 0; leftIndex < duties.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < duties.length; rightIndex += 1) {
            const left = duties[leftIndex];
            const right = duties[rightIndex];
            if (
                left.teacherId === right.teacherId
                && Number(left.day) === Number(right.day)
                && intervalsOverlap(left.interval, right.interval)
            ) {
                conflicts.push({
                    type: 'duty_teacher_conflict',
                    severity: 'hard',
                    dutyAssignment: right.assignment,
                    conflictWith: left.assignment,
                    teacherId: right.teacherId,
                    message: '值班老师同时间已有其它值班',
                });
            }
        }
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
        duty_lesson_teacher_conflict: '值班与课程冲突',
        duty_teacher_conflict: '值班冲突',
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
