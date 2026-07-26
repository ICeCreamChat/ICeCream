import { campusIdForSlot, slotClassIds, slotKey, slotTeacherIds } from './timetable-project.js';
import {
    timetableActivityTypeKey,
    timetableResourceTypeKey,
} from '../../shared/timetable/lesson-metadata.js';

const PROJECT_CONTEXTS = new WeakMap();

function list(value) {
    return Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
}

function norm(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function idsByName(items = [], names = []) {
    const wanted = new Set(list(names).map(norm));
    return items.filter(item => wanted.has(norm(item.name)) || wanted.has(norm(item.id))).map(item => item.id);
}

function lessonPlanLookupKey(classId, subjectId, teacherId) {
    return `${classId || ''}:${subjectId || ''}:${teacherId || ''}`;
}

function projectContext(project = {}) {
    const cached = PROJECT_CONTEXTS.get(project);
    if (cached) return cached;
    const plansById = new Map();
    const plansByAssignment = new Map();
    for (const plan of project.lessonPlans || []) {
        plansById.set(plan.id, plan);
        for (const teacherId of slotTeacherIds(plan)) {
            plansByAssignment.set(lessonPlanLookupKey(plan.classId, plan.subjectId, teacherId), plan);
        }
    }
    const context = {
        plansById,
        plansByAssignment,
        classesById: new Map((project.classes || []).map(item => [item.id, item])),
        roomsById: new Map((project.rooms || []).map(item => [item.id, item])),
        ruleContexts: new WeakMap(),
    };
    PROJECT_CONTEXTS.set(project, context);
    return context;
}

function compiledRuleContext(project = {}, rule = {}) {
    const context = projectContext(project);
    const cached = context.ruleContexts.get(rule);
    if (cached) return cached;
    const params = rule.parameters || {};
    const target = rule.target || {};
    const compiled = {
        subjectIds: new Set([
            ...list(target.kind === 'subject' ? target.matchedIds : []),
            ...list(params.subjectIds),
            ...idsByName(project.subjects || [], params.subjectNames),
        ]),
        classIds: new Set([...list(params.classIds), ...list(rule.scope?.classIds)]),
        grades: new Set(list(params.gradeNames).map(norm)),
        teacherIds: new Set([
            ...list(target.kind === 'teacher' ? target.matchedIds : []),
            ...list(params.teacherIds),
            ...idsByName(project.teachers || [], params.teacherNames),
        ]),
        activities: list(params.activityTypes).map(timetableActivityTypeKey).filter(Boolean),
        resources: list(params.requiredResourceTypes).map(timetableResourceTypeKey).filter(Boolean),
        targetSlots: new Set(list(params.slots)),
        allowedRoomIds: new Set([...list(params.roomIds), ...list(params.roomRequirement?.roomIds)]),
        requiredRoomTags: list(params.requiredTags || params.roomRequirement?.requiredTags).map(timetableResourceTypeKey),
        forbiddenRoomTypes: list(params.forbiddenRoomTypes).map(timetableResourceTypeKey),
    };
    context.ruleContexts.set(rule, compiled);
    return compiled;
}

function groupByMap(items = [], keyFor) {
    const groups = new Map();
    for (const item of items) {
        const key = keyFor(item);
        groups.set(key, [...(groups.get(key) || []), item]);
    }
    return groups;
}

function planFor(project, lesson = {}) {
    const context = projectContext(project);
    const byId = context.plansById.get(lesson.lessonPlanId || lesson.id);
    if (byId) return byId;
    for (const teacherId of slotTeacherIds(lesson)) {
        const plan = context.plansByAssignment.get(lessonPlanLookupKey(lesson.classId, lesson.subjectId, teacherId));
        if (plan) return plan;
    }
    return null;
}

function metadata(project, lesson = {}) {
    const plan = planFor(project, lesson) || lesson;
    const klass = projectContext(project).classesById.get(plan.classId || lesson.classId);
    return {
        plan,
        classId: plan.classId || lesson.classId,
        subjectId: plan.subjectId || lesson.subjectId,
        teacherIds: slotTeacherIds(plan).length ? slotTeacherIds(plan) : slotTeacherIds(lesson),
        grade: klass?.grade || '',
        activityTypes: list(plan.activityTypes).map(timetableActivityTypeKey),
        resourceTypes: list(plan.requiredResourceTypes).map(timetableResourceTypeKey),
    };
}

export function advancedRuleAppliesToLesson(project = {}, rule = {}, lesson = {}) {
    if (rule.enabled === false) return false;
    const data = metadata(project, lesson);
    const compiled = compiledRuleContext(project, rule);
    if (compiled.subjectIds.size && !compiled.subjectIds.has(data.subjectId)) return false;
    if (compiled.classIds.size && !compiled.classIds.has(data.classId)) return false;
    if (compiled.grades.size && !compiled.grades.has(norm(data.grade))) return false;
    if (compiled.teacherIds.size && !data.teacherIds.some(id => compiled.teacherIds.has(id))) return false;
    if (compiled.activities.length && !compiled.activities.some(value => data.activityTypes.includes(value))) return false;
    if (compiled.resources.length && !compiled.resources.some(value => data.resourceTypes.includes(value))) return false;
    return true;
}

function targetSlots(rule = {}) {
    return new Set(list(rule.parameters?.slots));
}

function roomTags(project, roomId) {
    return new Set(projectContext(project).roomsById.get(roomId)?.tags?.map(timetableResourceTypeKey) || []);
}

export function advancedHardBlocker(project = {}, entries = [], lesson = {}) {
    for (const rule of project.rules?.advancedRules || []) {
        if (rule.enabled === false || rule.strength !== 'hard' || !advancedRuleAppliesToLesson(project, rule, lesson)) continue;
        const params = rule.parameters || {};
        const compiled = compiledRuleContext(project, rule);
        const key = slotKey(lesson.day, lesson.period);
        if (rule.type === 'subject.avoid_periods' && compiled.targetSlots.has(key)) return '高级规则：学科禁排时段';
        if (rule.type === 'lesson.resource_attribute_avoid_periods' && compiled.targetSlots.has(key)) return '高级规则：资源课程禁排时段';
        if (rule.type === 'room.required') {
            const tags = roomTags(project, lesson.roomId);
            const roomIdMatch = compiled.allowedRoomIds.size > 0 && compiled.allowedRoomIds.has(lesson.roomId);
            const roomTagsMatch = compiled.requiredRoomTags.length > 0
                && compiled.requiredRoomTags.every(tag => tags.has(tag));
            if ((compiled.allowedRoomIds.size || compiled.requiredRoomTags.length) && !roomIdMatch && !roomTagsMatch) {
                return compiled.allowedRoomIds.size ? '高级规则：必须使用指定教室或匹配资源' : '高级规则：教室资源不匹配';
            }
        }
        if (rule.type === 'room.forbidden_type') {
            const tags = roomTags(project, lesson.roomId);
            if (compiled.forbiddenRoomTypes.some(tag => tags.has(tag))) return '高级规则：禁止该教室类型';
        }
        if (rule.type === 'schedule.cross_venue_boundary') {
            const boundary = list(params.boundaryPeriods).map(Number);
            if (!boundary.includes(Number(lesson.period))) continue;
            const otherPeriod = boundary.find(value => value !== Number(lesson.period));
            const conflicting = entries.find(entry => Number(entry.day) === Number(lesson.day)
                && Number(entry.period) === otherPeriod
                && slotClassIds(entry).some(id => slotClassIds(lesson).includes(id))
                && (entry.roomId || campusIdForSlot(project, entry))
                && (entry.roomId !== lesson.roomId || campusIdForSlot(project, entry) !== campusIdForSlot(project, lesson)));
            if (conflicting) return '高级规则：课节边界禁止跨场地';
        }
    }
    return '';
}

function sameTeacherDay(entry, lesson) {
    return Number(entry.day) === Number(lesson.day)
        && slotTeacherIds(entry).some(id => slotTeacherIds(lesson).includes(id));
}

export function advancedCandidatePenalty(project = {}, entries = [], lesson = {}) {
    let penalty = 0;
    for (const rule of project.rules?.advancedRules || []) {
        if (rule.enabled === false || rule.strength === 'hard' || !advancedRuleAppliesToLesson(project, rule, lesson)) continue;
        const params = rule.parameters || {};
        const compiled = compiledRuleContext(project, rule);
        const key = slotKey(lesson.day, lesson.period);
        if (['subject.preferred_day_part', 'subject.preferred_periods'].includes(rule.type)) {
            const preferred = compiled.targetSlots;
            if (preferred.size && !preferred.has(key)) penalty += 20;
            if (list(params.avoidDayParts).includes('afternoon') && Number(lesson.period) >= 5) penalty += 12;
        }
        if (rule.type === 'subject.avoid_periods' && compiled.targetSlots.has(key)) penalty += 30;
        if (rule.type === 'lesson.activity_scope_period_policy' && compiled.targetSlots.has(key)) penalty += 24;
        if (rule.type === 'lesson.resource_attribute_avoid_periods' && compiled.targetSlots.has(key)) penalty += 24;
        if (rule.type === 'subject.avoid_weekday_concentration' && list(params.days).map(Number).includes(Number(lesson.day))) penalty += 10;
        if (rule.type === 'subject.spread') {
            const sameDayCount = entries.filter(entry => (
                Number(entry.day) === Number(lesson.day)
                && entry.subjectId === lesson.subjectId
                && advancedRuleAppliesToLesson(project, rule, entry)
            )).length;
            penalty += sameDayCount * 20;
        }
        if (rule.type === 'teacher.compact_day') {
            const periods = entries.filter(entry => sameTeacherDay(entry, lesson)).map(entry => Number(entry.period));
            if (periods.length) penalty += Math.max(0, Math.min(...periods.map(period => Math.abs(period - Number(lesson.period)))) - 1) * 6;
        }
        if (rule.type === 'class.daily_balance') {
            const counts = (project.activeWeekdays || []).map(day => entries.filter(entry => (
                Number(entry.day) === Number(day) && slotClassIds(entry).includes(lesson.classId)
            )).length + (Number(day) === Number(lesson.day) ? 1 : 0));
            penalty += Math.max(...counts, 0) - Math.min(...counts, 0);
        }
        if (rule.type === 'teacher.prep_group_fairness' && Number(lesson.period) >= 5) {
            const subjectTeacherIds = new Set((project.lessonPlans || [])
                .filter(plan => !lesson.subjectId || plan.subjectId === lesson.subjectId)
                .flatMap(plan => slotTeacherIds(plan)));
            const afternoonLoads = [...subjectTeacherIds].map(teacherId => entries.filter(entry => (
                Number(entry.period) >= 5 && slotTeacherIds(entry).includes(teacherId)
            )).length);
            const lessonLoad = entries.filter(entry => Number(entry.period) >= 5
                && slotTeacherIds(entry).some(id => slotTeacherIds(lesson).includes(id))).length;
            const minimum = afternoonLoads.length ? Math.min(...afternoonLoads) : 0;
            penalty += Math.max(0, lessonLoad - minimum) * 5;
        }
        if (rule.type === 'subject.not_consecutive_with') {
            if (entries.some(entry => Number(entry.day) === Number(lesson.day)
                && Math.abs(Number(entry.period) - Number(lesson.period)) === 1
                && slotClassIds(entry).includes(lesson.classId)
                && compiled.subjectIds.has(entry.subjectId))) penalty += 18;
        }
        if (rule.type === 'room.preferred') {
            const preferred = new Set(list(params.preferredRoomIds));
            if (preferred.size && !preferred.has(lesson.roomId)) penalty += 16;
        }
    }
    return penalty;
}

export function advancedBlockPreference(project = {}, plan = {}) {
    const matched = (project.rules?.advancedRules || []).find(rule => (
        rule.type === 'lesson.consecutive'
        && advancedRuleAppliesToLesson(project, rule, plan)
        && Number(rule.parameters?.blockSize || 2) >= 2
    ));
    return matched ? 'double' : plan.blockPreference;
}

export function evaluateAdvancedRule(project = {}, rule = {}, slots = []) {
    const applicable = slots.filter(slot => advancedRuleAppliesToLesson(project, rule, slot));
    if (!applicable.length) return { status: 'not_evaluable', evidence: [], detail: '规则已应用，当前没有符合条件的课程。' };
    const violations = [];
    const params = rule.parameters || {};
    const targets = targetSlots(rule);
    if (['subject.avoid_periods', 'lesson.activity_scope_period_policy', 'lesson.resource_attribute_avoid_periods'].includes(rule.type)) {
        violations.push(...applicable.filter(slot => targets.has(slotKey(slot.day, slot.period))));
    } else if (['subject.preferred_day_part', 'subject.preferred_periods'].includes(rule.type)) {
        if (Number(params.minOccurrences) > 0) {
            const byClass = groupByMap(applicable, slot => slot.classId || '__global__');
            for (const classSlots of byClass.values()) {
                const hit = classSlots.filter(slot => targets.has(slotKey(slot.day, slot.period))).length;
                if (hit < Number(params.minOccurrences)) violations.push(...classSlots.filter(slot => !targets.has(slotKey(slot.day, slot.period))));
            }
        } else violations.push(...applicable.filter(slot => targets.size && !targets.has(slotKey(slot.day, slot.period))));
    } else if (rule.type === 'subject.avoid_weekday_concentration') {
        const avoidedDays = new Set(list(params.days).map(Number));
        const crowded = applicable.filter(slot => avoidedDays.has(Number(slot.day)));
        if (crowded.length > Math.floor(applicable.length / 2)) violations.push(...crowded);
    } else if (rule.type === 'subject.spread') {
        const byDay = groupByMap(applicable, slot => `${slot.classId || '__class__'}:${slot.day}`);
        byDay.forEach(daySlots => {
            if (daySlots.length > 1) violations.push(...daySlots);
        });
    } else if (rule.type === 'room.preferred') {
        const preferred = new Set(list(params.preferredRoomIds));
        violations.push(...applicable.filter(slot => preferred.size && !preferred.has(slot.roomId)));
    } else if (rule.type === 'room.required' || rule.type === 'room.forbidden_type') {
        for (const slot of applicable) if (advancedHardBlocker(project, slots.filter(item => item !== slot), slot)) violations.push(slot);
    } else if (rule.type === 'schedule.cross_venue_boundary') {
        for (const slot of applicable) if (advancedHardBlocker(project, slots.filter(item => item !== slot), slot)) violations.push(slot);
    } else if (rule.type === 'teacher.compact_day') {
        const groups = groupByMap(applicable.flatMap(slot => slotTeacherIds(slot).map(teacherId => ({ teacherId, slot }))), item => `${item.teacherId}:${item.slot.day}`);
        for (const items of groups.values()) {
            const ordered = items.map(item => item.slot).sort((left, right) => Number(left.period) - Number(right.period));
            for (let index = 1; index < ordered.length; index += 1) {
                if (Number(ordered[index].period) - Number(ordered[index - 1].period) > 1) violations.push(ordered[index - 1], ordered[index]);
            }
        }
    } else if (rule.type === 'class.daily_balance') {
        const weekdays = list(project.activeWeekdays).length ? list(project.activeWeekdays).map(Number) : [1, 2, 3, 4, 5];
        const byClass = groupByMap(applicable, slot => slot.classId || slotClassIds(slot)[0] || '');
        for (const classSlots of byClass.values()) {
            const counts = weekdays.map(day => ({ day, count: classSlots.filter(slot => Number(slot.day) === day).length }));
            const min = Math.min(...counts.map(item => item.count));
            const max = Math.max(...counts.map(item => item.count));
            if (max - min > 1) violations.push(...classSlots.filter(slot => counts.some(item => item.day === Number(slot.day) && item.count === max)));
        }
    } else if (rule.type === 'lesson.consecutive') {
        const byPlan = groupByMap(applicable, slot => slot.lessonPlanId || `${slot.classId}:${slot.subjectId}`);
        for (const planSlots of byPlan.values()) {
            const ordered = [...planSlots].sort((left, right) => Number(left.day) - Number(right.day) || Number(left.period) - Number(right.period));
            const hasBlock = ordered.some((slot, index) => index > 0
                && Number(slot.day) === Number(ordered[index - 1].day)
                && Number(slot.period) === Number(ordered[index - 1].period) + 1);
            if (ordered.length >= Number(params.blockSize || 2) && !hasBlock) violations.push(...ordered);
        }
    } else if (rule.type === 'subject.not_consecutive_with') {
        const subjectIds = new Set([...list(params.subjectIds), ...idsByName(project.subjects || [], params.subjectNames)]);
        for (const slot of applicable) {
            const neighbor = slots.find(other => other !== slot
                && Number(other.day) === Number(slot.day)
                && Math.abs(Number(other.period) - Number(slot.period)) === 1
                && slotClassIds(other).some(id => slotClassIds(slot).includes(id))
                && subjectIds.has(other.subjectId)
                && other.subjectId !== slot.subjectId);
            if (neighbor) violations.push(slot, neighbor);
        }
    } else if (rule.type === 'teacher.prep_group_fairness') {
        const load = new Map();
        for (const slot of applicable) for (const teacherId of slotTeacherIds(slot)) {
            const current = load.get(teacherId) || { teacherId, afternoon: 0, slots: [] };
            if (Number(slot.period) >= 5) current.afternoon += 1;
            current.slots.push(slot);
            load.set(teacherId, current);
        }
        if (load.size < 2) return { status: 'not_evaluable', evidence: [], detail: '备课组内可评估教师不足两人。' };
        const values = [...load.values()];
        const min = Math.min(...values.map(item => item.afternoon));
        const max = Math.max(...values.map(item => item.afternoon));
        if (max - min > 1) violations.push(...values.filter(item => item.afternoon === max).flatMap(item => item.slots.filter(slot => Number(slot.period) >= 5)));
    }
    const evidence = [...new Map(violations.map(slot => [slot.id || `${slot.day}-${slot.period}-${slot.classId}-${slot.subjectId}`, slot])).values()];
    return evidence.length
        ? { status: 'violated', evidence, detail: `${evidence.length} 个课节违反高级约束。` }
        : { status: 'satisfied', evidence: [], detail: '未发现违反。' };
}
