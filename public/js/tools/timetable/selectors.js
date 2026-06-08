export function dayName(day) {
    return '一二三四五六日'[Number(day) - 1] || String(day);
}

function numberList(values, fallbackMax, min = 1, max = 12) {
    const raw = Array.isArray(values) ? values : [];
    const normalized = raw
        .map(value => Number(value))
        .filter(value => Number.isInteger(value) && value >= min && value <= max);
    const source = normalized.length
        ? normalized
        : Array.from({ length: Math.max(0, Number(fallbackMax) || 0) }, (_, index) => index + 1);
    return [...new Set(source)].sort((left, right) => left - right);
}

export function getActiveWeekdays(project = {}) {
    return numberList(project.activeWeekdays, project.weekdays || 5, 1, 7);
}

export function getActivePeriods(project = {}) {
    return numberList(project.activePeriods, project.periodsPerDay || 7, 1, 12);
}

export function entityMaps(project = {}) {
    return {
        teachers: new Map((project.teachers || []).map(item => [item.id, item])),
        classes: new Map((project.classes || []).map(item => [item.id, item])),
        subjects: new Map((project.subjects || []).map(item => [item.id, item])),
        plans: new Map((project.lessonPlans || []).map(item => [item.id, item])),
    };
}

export function getOwners(project, viewMode) {
    if (!project) return [];
    if (viewMode === 'teacher') return project.teachers || [];
    if (viewMode === 'master') return [{ id: 'master', name: '全校总表' }];
    return project.classes || [];
}

export function ownerLabel(owner = {}) {
    return owner.grade ? `${owner.grade}${owner.name}` : owner.name || owner.id || '';
}

export function ensureOwnerSelection(state) {
    if (!state.project) return '';
    if (state.viewMode === 'master') return 'master';
    const owners = getOwners(state.project, state.viewMode);
    if (owners.some(owner => owner.id === state.selectedOwnerId)) return state.selectedOwnerId;
    return owners[0]?.id || '';
}

export function getScore(project) {
    return project?.schedule?.score || {};
}

export function totalPlannedLessons(project) {
    return (project?.lessonPlans || []).reduce((sum, plan) => sum + Number(plan.weeklyHours || 0), 0);
}

export function getRosterStats(project = {}) {
    const lessonPlans = project.lessonPlans || [];
    const fixedRooms = new Set(lessonPlans.map(plan => plan.roomId).filter(Boolean));
    const totalLessons = totalPlannedLessons(project);
    const blockLessons = lessonPlans.reduce((sum, plan) => {
        const hours = Number(plan.weeklyHours || 0);
        if (plan.blockPreference === 'double') return sum + hours;
        if (plan.blockPreference === 'mixed') return sum + Math.min(2, hours);
        return sum;
    }, 0);
    const knownClasses = new Set((project.classes || []).map(item => item.id));
    const knownSubjects = new Set((project.subjects || []).map(item => item.id));
    const knownTeachers = new Set((project.teachers || []).map(item => item.id));
    const issueCount = lessonPlans.filter(plan => (
        !knownClasses.has(plan.classId)
        || !knownSubjects.has(plan.subjectId)
        || !knownTeachers.has(plan.teacherId)
    )).length;
    return {
        classCount: (project.classes || []).length,
        teacherCount: (project.teachers || []).length,
        subjectCount: (project.subjects || []).length,
        planCount: lessonPlans.length,
        totalLessons,
        blockLessons,
        fixedRoomCount: fixedRooms.size,
        issueCount,
    };
}

export function getRuleSummary(project = {}) {
    const rules = project.rules || {};
    const hard = rules.hardRules || {};
    const soft = rules.softRules || {};
    const teacherUnavailable = Object.values(hard.teacherUnavailable || {}).reduce((sum, slots) => sum + (slots || []).length, 0);
    const classUnavailable = Object.values(hard.classUnavailable || {}).reduce((sum, slots) => sum + (slots || []).length, 0);
    const lockedSlots = (hard.lockedSlots || []).length;
    const morningSubjects = (soft.morningSubjects || []).length;
    return {
        teacherUnavailable,
        classUnavailable,
        lockedSlots,
        morningSubjects,
        total: teacherUnavailable + classUnavailable + lockedSlots + morningSubjects,
    };
}

export function getPreparedness(project) {
    if (!project) return { ready: false, message: '正在读取排课项目。' };
    if (!(project.lessonPlans || []).length) return { ready: false, message: '请先导入任课数据。' };
    if (!(project.teachers || []).length) return { ready: false, message: '任课数据里没有教师。' };
    if (!(project.classes || []).length) return { ready: false, message: '任课数据里没有班级。' };
    if (!(project.subjects || []).length) return { ready: false, message: '任课数据里没有课程。' };
    return { ready: true, message: '数据已就绪。' };
}

function slotTeachers(slot = {}) {
    const ids = Array.isArray(slot.teacherIds) ? [...slot.teacherIds] : [];
    if (slot.teacherId && !ids.includes(slot.teacherId)) ids.unshift(slot.teacherId);
    return ids;
}

export function getVisibleSlots(project, viewMode, ownerId) {
    const slots = project?.schedule?.slots || [];
    if (viewMode === 'teacher') {
        return slots.filter(slot => slotTeachers(slot).includes(ownerId));
    }
    if (viewMode === 'master') return slots;
    return slots.filter(slot => slot.classId === ownerId);
}

export function getSlotsAt(project, viewMode, ownerId, day, period) {
    return getVisibleSlots(project, viewMode, ownerId)
        .filter(slot => slot.day === day && slot.period === period);
}

export function getSlotById(project, slotId) {
    return (project?.schedule?.slots || []).find(slot => slot.id === slotId) || null;
}

export function getSlotBlock(project, slotId) {
    const slot = getSlotById(project, slotId);
    if (!slot) return [];
    if (!slot.blockId || slot.blockSize <= 1) return [slot];
    return (project.schedule?.slots || [])
        .filter(item => item.blockId === slot.blockId)
        .sort((left, right) => (left.blockIndex || 0) - (right.blockIndex || 0));
}

export function getConflictSummary(schedule = {}) {
    const conflicts = Array.isArray(schedule.conflicts) ? schedule.conflicts : [];
    const counts = {};
    for (const conflict of conflicts) {
        const type = conflict.type || 'other';
        counts[type] = (counts[type] || 0) + 1;
    }
    return {
        total: conflicts.length,
        hardCount: conflicts.filter(conflict => conflict.severity === 'hard' || !conflict.severity).length,
        counts,
        items: Object.entries(counts).map(([type, count]) => ({ type, count, label: conflictLabel(type) })),
    };
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

export function slotHasConflict(project, slot) {
    return (project?.schedule?.conflicts || []).some(conflict => (
        conflict.slot?.id === slot.id
        || (conflict.classId === slot.classId && conflict.teacherId === slot.teacherId && conflict.day === slot.day && conflict.period === slot.period)
    ));
}

export function getSlotDetails(project, slotId) {
    const slot = getSlotById(project, slotId);
    if (!slot) return null;
    const maps = entityMaps(project);
    const klass = maps.classes.get(slot.classId);
    const subject = maps.subjects.get(slot.subjectId);
    const teacherNames = slotTeachers(slot)
        .map(teacherId => maps.teachers.get(teacherId)?.name || teacherId)
        .join('、');
    const blockSlots = getSlotBlock(project, slot.id);
    return {
        slot,
        subject,
        klass,
        teacherNames,
        plan: maps.plans.get(slot.lessonPlanId),
        blockSlots,
        timeLabel: `周${dayName(slot.day)} 第${slot.period}节`,
        classLabel: klass ? `${klass.grade}${klass.name}` : slot.classId,
        blockLabel: slot.blockId ? `连堂 ${Number(slot.blockIndex || 0) + 1}/${slot.blockSize}` : '单节',
        hasConflict: slotHasConflict(project, slot),
    };
}

export function getSolveStatus(project, lastFailure = null) {
    const score = getScore(project);
    const summary = getConflictSummary(project?.schedule || {});
    const source = project?.schedule?.source;
    return {
        source,
        sourceLabel: source === 'timefold_solver'
            ? 'Timefold'
            : source === 'fast_constructed'
                ? '快速课表'
                : source === 'diagnostic_local'
                    ? '本地诊断'
                    : '未生成',
        placed: score.placedLessons ?? 0,
        total: score.totalLessons ?? totalPlannedLessons(project),
        completeness: score.completeness == null ? '-' : `${score.completeness}%`,
        unplaced: score.unplacedLessons ?? 0,
        conflicts: summary.total,
        hardConflicts: score.hardConflicts ?? summary.hardCount,
        oldScheduleKept: Boolean(lastFailure),
    };
}
