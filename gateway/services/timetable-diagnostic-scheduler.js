import {
    isComplexTimetableModel,
    isActiveTimetableSlot,
    normalizeTimetableProject,
    slotTeacherIds,
} from './timetable-project.js';
import {
    buildSchedulingUnits,
    getCandidateBlocks,
    isProtectedGroup,
    resourceKeysForTask,
    slotGroupKey,
    taskFromSlotGroup,
} from './timetable-local-scheduler.js';

function feasibilityIssue(code, message, unit = {}, extra = {}) {
    return {
        code,
        severity: 'hard',
        message,
        lessonPlanId: unit.lessonPlanId || null,
        taskId: unit.id || null,
        classIds: unit.classIds || [],
        teacherIds: unit.teacherIds || [],
        blockSize: unit.blockSize || 1,
        suggestion: extra.suggestion || '检查相关硬约束或增加可用时段、教师、班级或教室容量。',
        ...extra,
    };
}

function capacityIssuesForUnits(units = []) {
    const resources = new Map();
    const register = (kind, id, unit) => {
        if (!id) return;
        const key = `${kind}:${id}`;
        if (!resources.has(key)) resources.set(key, { kind, id, units: [] });
        resources.get(key).units.push(unit);
    };
    for (const unit of units) {
        unit.classIds.forEach(id => register('class', id, unit));
        unit.teacherIds.forEach(id => register('teacher', id, unit));
        if (unit.allowedRoomIds.length === 1) register('room', unit.allowedRoomIds[0], unit);
    }
    const issues = [];
    for (const resource of resources.values()) {
        const demand = resource.units.reduce((sum, unit) => sum + unit.blockSize, 0);
        const available = new Set(resource.units.flatMap(unit => unit.candidates.flatMap(candidate => candidate.occupiedKeys))).size;
        if (demand <= available) continue;
        issues.push({
            code: 'resource_capacity_exceeded',
            severity: 'hard',
            resourceKind: resource.kind,
            resourceId: resource.id,
            demand,
            available,
            message: `${resource.kind} ${resource.id} 需要 ${demand} 个课时，但显式规则下最多只有 ${available} 个可用时隙。`,
            suggestion: '放宽该资源的不可排或固定安排，或增加可用时段/可替代资源。',
        });
    }
    return issues;
}

function lockedRuleMatchesPlan(rule = {}, plan = {}) {
    if (rule.lessonPlanId) return rule.lessonPlanId === plan.id;
    return rule.classId === plan.classId
        && rule.subjectId === plan.subjectId
        && (!rule.teacherId || slotTeacherIds(plan).includes(rule.teacherId));
}

function lockedSlotIssues(project = {}, units = []) {
    const rules = project.rules?.hardRules?.lockedSlots || [];
    const issues = [];
    const occupied = new Map();
    const seenPlanSlots = new Set();
    for (const rule of rules) {
        const day = Number(rule.day);
        const period = Number(rule.period);
        const key = `${day}-${period}`;
        const plan = (project.lessonPlans || []).find(item => lockedRuleMatchesPlan(rule, item));
        if (!plan) {
            issues.push({
                code: 'fixed_slot_unmatched',
                severity: 'hard',
                slot: key,
                message: `固定课 ${key} 找不到匹配的任课计划。`,
                suggestion: '检查固定课的班级、课程、教师或任课计划 ID。',
            });
            continue;
        }
        if (!isActiveTimetableSlot(project, day, period)) {
            issues.push({
                code: 'fixed_slot_unavailable',
                lessonPlanId: plan.id,
                slot: key,
                message: `任课计划 ${plan.id} 被固定到未启用的时隙 ${key}。`,
                suggestion: '启用该星期/节次，或把固定课移到有效时隙。',
            });
        }
        const unit = units.find(item => item.lessonPlanId === plan.id);
        const sameSlotKey = `${plan.id}|${key}`;
        if (seenPlanSlots.has(sameSlotKey)) continue;
        seenPlanSlots.add(sameSlotKey);

        const existing = occupied.get(key) || [];
        for (const other of existing) {
            const sameClass = other.classId && other.classId === plan.classId;
            const sameTeacher = other.teacherId && other.teacherId === plan.teacherId;
            const sameRoom = rule.roomId && other.roomId && rule.roomId === other.roomId;
            if (sameClass || sameTeacher || sameRoom) {
                issues.push({
                    code: 'fixed_slot_conflict',
                    slot: key,
                    lessonPlanId: plan.id,
                    conflictsWith: other.lessonPlanId,
                    message: `固定课 ${key} 同时占用了冲突的班级、教师或教室资源。`,
                    suggestion: '移动其中一条固定课，或取消其中一条固定安排。',
                });
            }
        }
        if (!occupied.has(key)) occupied.set(key, []);
        occupied.get(key).push({
            lessonPlanId: plan.id,
            classId: plan.classId,
            teacherId: plan.teacherId,
            roomId: rule.roomId || null,
            unitId: unit?.id || null,
        });
    }
    return issues;
}

function analyzeTimetableFeasibility(input = {}) {
    const project = normalizeTimetableProject(input);
    const units = buildSchedulingUnits(project);
    const issues = [];
    for (const unit of units) {
        if (unit.candidates.length) continue;
        issues.push(feasibilityIssue(
            'candidate_domain_empty',
            `任课计划 ${unit.lessonPlanId} 的 ${unit.blockSize} 节排课单元没有满足硬约束的候选时段。`,
            unit,
            { suggestion: '检查不可排、固定课、连续课长度及教室范围；至少保留一个完整可用时段。' },
        ));
    }
    issues.push(...lockedSlotIssues(project, units));

    const teacherDemand = new Map();
    for (const unit of units) {
        for (const teacherId of unit.teacherIds) {
            teacherDemand.set(teacherId, (teacherDemand.get(teacherId) || 0) + unit.blockSize);
        }
    }
    for (const [teacherId, demand] of teacherDemand) {
        const limit = Number.parseInt(project.rules?.hardRules?.teacherWeeklyLimit?.[teacherId], 10);
        if (!Number.isInteger(limit) || limit <= 0 || demand <= limit) continue;
        issues.push({
            code: 'teacher_weekly_limit_exceeded',
            severity: 'hard',
            teacherId,
            demand,
            limit,
            message: `教师 ${teacherId} 有 ${demand} 节任课需求，超过显式每周上限 ${limit}。`,
            suggestion: '提高该教师周课时上限、调整任课分配，或减少对应课时。',
        });
    }
    // Capacity is a proof only for the simple, empty-schedule model. Existing
    // protected placements and alternate-week teaching groups require the full
    // constraint model; treating this coarse count as a proof there would reject
    // otherwise feasible projects before repair or Timefold can run.
    if (!isComplexTimetableModel(project) && !(project.schedule?.slots || []).length) {
        issues.push(...capacityIssuesForUnits(units));
    }

    const candidateCounts = units.map(unit => unit.candidates.length);
    return {
        status: issues.length ? 'input_infeasible' : 'feasible',
        issues,
        units,
        candidateDomainStats: {
            unitCount: units.length,
            emptyUnitCount: candidateCounts.filter(count => count === 0).length,
            minCandidateCount: candidateCounts.length ? Math.min(...candidateCounts) : 0,
            maxCandidateCount: candidateCounts.length ? Math.max(...candidateCounts) : 0,
        },
    };
}

function buildConflictComponent(project, slots, targetTask, maxGroups) {
    const groups = new Map();
    const targetKeys = resourceKeysForTask(project, targetTask);
    const preferredKeys = [...targetKeys].filter(key => key.startsWith('room:'));
    const componentKeys = preferredKeys.length
        ? new Set(preferredKeys)
        : new Set([...targetKeys].filter(key => key.startsWith('teacher:')));
    if (!componentKeys.size) {
        for (const key of targetKeys) componentKeys.add(key);
    }
    const grouped = new Map();
    for (const slot of slots) {
        const groupKey = slotGroupKey(slot);
        if (!grouped.has(groupKey)) grouped.set(groupKey, []);
        grouped.get(groupKey).push(slot);
    }
    for (const [groupKey, group] of grouped) {
        if (isProtectedGroup(group)) continue;
        const groupTask = taskFromSlotGroup(group, project);
        const groupKeys = resourceKeysForTask(project, groupTask);
        if (![...groupKeys].some(key => componentKeys.has(key))) continue;
        groups.set(groupKey, group);
        if (groups.size > maxGroups) return null;
    }
    return [...groups.values()];
}

export {
    analyzeTimetableFeasibility,
    buildConflictComponent,
    buildSchedulingUnits,
};
export { runTimetableScheduler } from './timetable-local-scheduler.js';
