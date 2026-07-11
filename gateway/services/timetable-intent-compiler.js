import {
    getActivePeriods,
    getActiveWeekdays,
    getDayPartBoundaries,
    slotKey,
} from './timetable-project.js';

function text(value = '', max = 240) {
    return String(value ?? '').trim().slice(0, max);
}

function key(value = '') {
    return text(value, 120)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function list(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
}

function unique(values = []) {
    return [...new Set(list(values).map(item => text(item, 120)).filter(Boolean))];
}

function sourceText(requirement = {}) {
    return text(requirement.source?.rawText || requirement.rawText || requirement.description || '', 1000);
}

function subjectIdsOf(requirement = {}) {
    return unique([
        ...list(requirement.parameters?.subjectIds),
        requirement.parameters?.subjectId,
        ...(requirement.object?.kind === 'subject' ? list(requirement.object?.matchedIds) : []),
        requirement.targetId,
    ]);
}

function classIdsOf(requirement = {}) {
    return unique([
        ...list(requirement.parameters?.classIds),
        requirement.parameters?.classId,
        ...(requirement.object?.kind === 'class' ? list(requirement.object?.matchedIds) : []),
    ]);
}

function firstPeriodSlots(project = {}) {
    const [firstPeriod] = getActivePeriods(project);
    if (!firstPeriod) return [];
    return getActiveWeekdays(project).map(day => slotKey(day, firstPeriod));
}

function lastPeriodSlots(project = {}) {
    const periods = getActivePeriods(project);
    const lastPeriod = periods[periods.length - 1];
    if (!lastPeriod) return [];
    return getActiveWeekdays(project).map(day => slotKey(day, lastPeriod));
}

function lunchBoundarySlots(project = {}) {
    const boundary = getDayPartBoundaries(project);
    const afternoonStart = Number.parseInt(boundary.afternoonStartPeriod, 10);
    if (!Number.isInteger(afternoonStart) || afternoonStart <= 1) return [];
    return getActiveWeekdays(project).flatMap(day => [
        slotKey(day, afternoonStart - 1),
        slotKey(day, afternoonStart),
    ]);
}

function teachersOfSubject(project = {}, subjectId = '') {
    const ids = [];
    for (const plan of list(project.lessonPlans)) {
        if (plan.subjectId !== subjectId) continue;
        ids.push(...list(plan.teacherIds), plan.teacherId);
    }
    for (const teacher of list(project.teachers)) {
        if (list(teacher.subjects).includes(subjectId)) ids.push(teacher.id);
    }
    return unique(ids);
}

function baseRow(requirement = {}, index = 0) {
    return {
        id: `${requirement.id || 'intent'}_${index + 1}`,
        requirementId: requirement.id || '',
        rawText: sourceText(requirement),
        source: 'intent_compiler',
        parseSource: 'intent_compiler',
        confidence: requirement.confidence ?? 0.86,
    };
}

const INTENT_COMPILERS = {
    avoid_first_period(requirement, project) {
        const slots = firstPeriodSlots(project);
        return subjectIdsOf(requirement).map((subjectId, index) => ({
            ...baseRow(requirement, index),
            type: 'subject_avoid_periods',
            targetType: 'subject',
            targetId: subjectId,
            slots,
            priority: 'soft',
            status: slots.length ? 'effective' : 'needs_review',
        }));
    },

    avoid_last_period(requirement, project) {
        const slots = lastPeriodSlots(project);
        return subjectIdsOf(requirement).map((subjectId, index) => ({
            ...baseRow(requirement, index),
            type: 'subject_avoid_periods',
            targetType: 'subject',
            targetId: subjectId,
            slots,
            priority: 'soft',
            status: slots.length ? 'effective' : 'needs_review',
        }));
    },

    lunch_protection(requirement, project) {
        const slots = lunchBoundarySlots(project);
        return [{
            ...baseRow(requirement),
            type: 'global_unavailable',
            targetType: 'global',
            targetName: '午休边界',
            slots,
            priority: 'hard',
            status: slots.length ? 'effective' : 'needs_review',
        }];
    },

    teaching_group_meeting(requirement, project) {
        const subjectId = subjectIdsOf(requirement)[0] || text(requirement.parameters?.subjectId, 120);
        const slots = unique(requirement.parameters?.slots || requirement.slots || []);
        const teacherIds = teachersOfSubject(project, subjectId);
        return teacherIds.map((teacherId, index) => ({
            ...baseRow(requirement, index),
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: teacherId,
            slots,
            priority: 'hard',
            status: slots.length ? 'effective' : 'needs_review',
            groupTag: `teaching_group:${subjectId}`,
        }));
    },

    first_period_assign(requirement, project) {
        const [slot] = firstPeriodSlots(project);
        const subjectId = subjectIdsOf(requirement)[0] || '';
        const classId = classIdsOf(requirement)[0] || text(requirement.parameters?.classId, 120);
        const teacherId = text(requirement.parameters?.teacherId, 120);
        return [{
            ...baseRow(requirement),
            type: 'locked_slot',
            targetType: 'locked_slot',
            classId,
            subjectId,
            teacherId,
            slots: slot ? [slot] : [],
            priority: 'hard',
            status: classId && subjectId && teacherId && slot ? 'effective' : 'needs_review',
        }];
    },

    golden_hour_preference(requirement) {
        return subjectIdsOf(requirement).map((subjectId, index) => ({
            ...baseRow(requirement, index),
            type: 'subject_morning',
            targetType: 'subject',
            targetId: subjectId,
            priority: 'soft',
            status: 'effective',
        }));
    },
};

export function compileRequirementToRows(requirement = {}, project = {}) {
    const intent = key(requirement.intent || requirement.type || '');
    const compiler = INTENT_COMPILERS[intent];
    if (!compiler) return null;
    return compiler(requirement, project).filter(Boolean);
}
