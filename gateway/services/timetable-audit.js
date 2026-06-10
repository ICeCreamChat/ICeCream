import {
    getActivePeriods,
    getActiveWeekdays,
    getTimetableEntityMaps,
    normalizeTimetableProject,
    slotKey,
    slotTeacherIds,
} from './timetable-project.js';
import {
    classUnavailable,
    teacherUnavailable,
} from './timetable-conflicts.js';

function isMainSubject(subject = {}, subjectId = '') {
    const tags = [subject.category, ...(subject.tags || []), subject.type, subjectId, subject.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return /\b(main|core|chinese|math|english|language)\b|语文|数学|英语|外语|主科/.test(tags);
}

function issue(type, message, extra = {}) {
    return { type, message, ...extra };
}

function activeSlotCount(project, unavailable = new Set()) {
    let count = 0;
    for (const day of getActiveWeekdays(project)) {
        for (const period of getActivePeriods(project)) {
            if (!unavailable.has(slotKey(day, period))) count += 1;
        }
    }
    return count;
}

function countPlanHoursBy(project, getKeys) {
    const counts = new Map();
    for (const plan of project.lessonPlans || []) {
        for (const key of getKeys(plan).filter(Boolean)) {
            counts.set(key, (counts.get(key) || 0) + Number(plan.weeklyHours || 0));
        }
    }
    return counts;
}

function planRoomPool(plan = {}) {
    const rooms = Array.isArray(plan.allowedRoomIds) && plan.allowedRoomIds.length
        ? plan.allowedRoomIds
        : [plan.roomId].filter(Boolean);
    return [...new Set(rooms)].sort();
}

function countRoomDemandPools(project) {
    const counts = new Map();
    for (const plan of project.lessonPlans || []) {
        const pool = planRoomPool(plan);
        if (!pool.length) continue;
        const key = pool.join('|');
        const current = counts.get(key) || {
            id: key,
            rooms: pool,
            load: 0,
        };
        current.load += Number(plan.weeklyHours || 0);
        counts.set(key, current);
    }
    return [...counts.values()];
}

function requiredDoubleBlocks(plan = {}) {
    const hours = Math.max(0, Number(plan.weeklyHours || 0));
    if (plan.blockPreference === 'double') return Math.floor(hours / 2);
    if (plan.blockPreference === 'mixed' && hours >= 4) return Math.floor((hours - (hours % 2 === 0 ? 2 : 1)) / 2);
    return 0;
}

function availableBlockWindows(project, plan, blockSize) {
    const days = getActiveWeekdays(project);
    const periods = getActivePeriods(project);
    const periodSet = new Set(periods);
    const blocked = new Set(classUnavailable(project, plan.classId));
    for (const teacherId of slotTeacherIds(plan)) {
        for (const key of teacherUnavailable(project, teacherId)) blocked.add(key);
    }

    let windows = 0;
    for (const day of days) {
        for (const period of periods) {
            let ok = true;
            for (let offset = 0; offset < blockSize; offset += 1) {
                const p = period + offset;
                if (!periodSet.has(p) || blocked.has(slotKey(day, p))) {
                    ok = false;
                    break;
                }
            }
            if (ok) windows += 1;
        }
    }
    return windows;
}

export function auditTimetableProject(input = {}) {
    const project = normalizeTimetableProject(input);
    const maps = getTimetableEntityMaps(project);
    const activeWeekdays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    const activeSlotsPerOwner = activeWeekdays.length * activePeriods.length;
    const totalLessons = project.lessonPlans.reduce((sum, plan) => sum + Number(plan.weeklyHours || 0), 0);
    const blockingIssues = [];
    const warnings = [];

    const invalidPlans = project.lessonPlans.filter(plan => (
        !maps.classes.has(plan.classId)
        || !maps.subjects.has(plan.subjectId)
        || !slotTeacherIds(plan).every(teacherId => maps.teachers.has(teacherId))
    ));
    for (const plan of invalidPlans) {
        blockingIssues.push(issue('invalid_lesson_plan_refs', '任课记录引用了不存在的班级、课程或教师。', {
            lessonPlanId: plan.id,
            classId: plan.classId,
            subjectId: plan.subjectId,
            teacherId: plan.teacherId,
        }));
    }

    const classHours = countPlanHoursBy(project, plan => [plan.classId]);
    const teacherHours = countPlanHoursBy(project, plan => slotTeacherIds(plan));
    const classBottlenecks = [];
    const teacherBottlenecks = [];
    const roomBottlenecks = [];

    for (const klass of project.classes || []) {
        const capacity = activeSlotCount(project, classUnavailable(project, klass.id));
        const load = classHours.get(klass.id) || 0;
        const utilization = capacity ? Math.round((load / capacity) * 100) : 0;
        classBottlenecks.push({ id: klass.id, name: `${klass.grade || ''}${klass.name || klass.id}`, load, capacity, utilization });
        if (load > capacity) {
            blockingIssues.push(issue('class_capacity', '班级课时超过可用节次。', {
                classId: klass.id,
                name: `${klass.grade || ''}${klass.name || klass.id}`,
                load,
                capacity,
            }));
        } else if (utilization >= 85) {
            warnings.push(issue('class_load', '班级课表接近满载。', { classId: klass.id, name: `${klass.grade || ''}${klass.name || klass.id}`, utilization }));
        }
    }

    for (const teacher of project.teachers || []) {
        const capacity = activeSlotCount(project, teacherUnavailable(project, teacher.id));
        const load = teacherHours.get(teacher.id) || 0;
        const utilization = capacity ? Math.round((load / capacity) * 100) : 0;
        teacherBottlenecks.push({ id: teacher.id, name: teacher.name || teacher.id, load, capacity, utilization });
        if (load > capacity) {
            blockingIssues.push(issue('teacher_capacity', '教师课时超过可用节次。', {
                teacherId: teacher.id,
                name: teacher.name || teacher.id,
                load,
                capacity,
            }));
        } else if (utilization >= 85) {
            warnings.push(issue('teacher_load', '教师课时负载较高。', { teacherId: teacher.id, name: teacher.name || teacher.id, utilization }));
        }
    }

    for (const pool of countRoomDemandPools(project)) {
        const roomId = pool.rooms.join(' / ');
        const load = pool.load;
        const capacity = activeSlotsPerOwner * Math.max(1, pool.rooms.length);
        const utilization = capacity ? Math.round((load / capacity) * 100) : 0;
        roomBottlenecks.push({ id: pool.id, name: roomId, rooms: pool.rooms, load, capacity, utilization });
        if (load > capacity) {
            blockingIssues.push(issue('room_capacity', '固定教室课时超过可用节次。', { roomId, rooms: pool.rooms, load, capacity }));
        } else if (utilization >= 90) {
            warnings.push(issue('room_load', '固定教室使用接近满载。', { roomId, rooms: pool.rooms, utilization }));
        }
    }

    for (const plan of project.lessonPlans || []) {
        const doubleBlocks = requiredDoubleBlocks(plan);
        if (!doubleBlocks) continue;
        const windows = availableBlockWindows(project, plan, 2);
        if (windows < doubleBlocks) {
            blockingIssues.push(issue('block_window', '连堂课程缺少连续可用节次。', {
                lessonPlanId: plan.id,
                classId: plan.classId,
                subjectId: plan.subjectId,
                requiredBlocks: doubleBlocks,
                availableWindows: windows,
            }));
        }
    }

    return {
        blockingIssues,
        warnings,
        bottlenecks: {
            classes: classBottlenecks.sort((left, right) => right.utilization - left.utilization).slice(0, 5),
            teachers: teacherBottlenecks.sort((left, right) => right.utilization - left.utilization).slice(0, 5),
            rooms: roomBottlenecks.sort((left, right) => right.utilization - left.utilization).slice(0, 5),
        },
        capacity: {
            activeDayCount: activeWeekdays.length,
            activePeriodCount: activePeriods.length,
            availableSlots: activeSlotsPerOwner,
            classCapacity: activeSlotsPerOwner * (project.classes || []).length,
            totalLessons,
            utilization: activeSlotsPerOwner && project.classes?.length
                ? Math.round((totalLessons / (activeSlotsPerOwner * project.classes.length)) * 100)
                : 0,
        },
    };
}

function periodsByTeacherDay(slots = []) {
    const result = new Map();
    for (const slot of slots) {
        for (const teacherId of slotTeacherIds(slot)) {
            const key = `${teacherId}:${slot.day}`;
            if (!result.has(key)) result.set(key, []);
            result.get(key).push(slot);
        }
    }
    return result;
}

export function buildTimetableQualityIssues(input = {}, slots = []) {
    const project = normalizeTimetableProject(input);
    const maps = getTimetableEntityMaps(project);
    const issues = [];
    const soft = project.rules?.softRules || {};
    const preferred = soft.subjectPreferredPeriods || {};
    const spreadSubjects = new Set(soft.spreadSubjects || []);
    const morningSubjects = new Set(soft.morningSubjects || []);
    const activePeriods = getActivePeriods(project);
    const morningSet = new Set(activePeriods.slice(0, Math.max(1, Math.ceil(activePeriods.length / 2))));

    for (const slot of slots) {
        const subject = maps.subjects.get(slot.subjectId) || {};
        const subjectName = subject.name || slot.subjectId;
        const key = slotKey(slot.day, slot.period);
        const preference = preferred[slot.subjectId];
        if ((preference?.avoid || []).includes(key)) {
            issues.push(issue('subject_avoid_period', `${subjectName} 排在了避开节次。`, {
                severity: 'warning',
                classId: slot.classId,
                subjectId: slot.subjectId,
                slot,
            }));
        }
        if ((morningSubjects.has(slot.subjectId) || isMainSubject(subject, slot.subjectId)) && !morningSet.has(slot.period)) {
            issues.push(issue('morning_subject_late', `${subjectName} 未排在上午优先时段。`, {
                severity: 'info',
                classId: slot.classId,
                subjectId: slot.subjectId,
                slot,
            }));
        }
    }

    const classSubjectDay = new Map();
    for (const slot of slots) {
        const key = `${slot.classId}:${slot.subjectId}:${slot.day}`;
        if (!classSubjectDay.has(key)) classSubjectDay.set(key, []);
        classSubjectDay.get(key).push(slot);
    }
    for (const [key, daySlots] of classSubjectDay) {
        const [, subjectId] = key.split(':');
        const limit = spreadSubjects.has(subjectId) ? 1 : 2;
        if (daySlots.length > limit) {
            const first = daySlots[0];
            const subject = maps.subjects.get(subjectId);
            issues.push(issue('subject_spread', `${subject?.name || subjectId} 同一天过于集中。`, {
                severity: 'warning',
                classId: first.classId,
                subjectId,
                slot: first,
            }));
        }
    }

    for (const [key, daySlots] of periodsByTeacherDay(slots)) {
        const [teacherId] = key.split(':');
        const limits = soft.teacherLimits?.[teacherId] || {};
        const sorted = [...daySlots].sort((left, right) => left.period - right.period);
        if (Number.isInteger(Number(limits.daily)) && sorted.length > Number(limits.daily)) {
            issues.push(issue('teacher_daily_limit', `${maps.teachers.get(teacherId)?.name || teacherId} 当天课时超过上限。`, {
                severity: 'warning',
                teacherId,
                slot: sorted[0],
            }));
        }
        let run = 0;
        let maxRun = 0;
        let prev = null;
        for (const slot of sorted) {
            run = prev !== null && slot.period === prev + 1 ? run + 1 : 1;
            maxRun = Math.max(maxRun, run);
            prev = slot.period;
        }
        const consecutiveLimit = Number.isInteger(Number(limits.consecutive)) ? Number(limits.consecutive) : 3;
        if (maxRun > consecutiveLimit) {
            issues.push(issue('teacher_consecutive', `${maps.teachers.get(teacherId)?.name || teacherId} 连续授课偏多。`, {
                severity: 'warning',
                teacherId,
                slot: sorted[0],
            }));
        }
    }

    return issues;
}
