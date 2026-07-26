import {
    auditTimetableProject,
    buildTimetableScore,
    buildTimetableQualityIssues,
    createDefaultTimetableProject,
    detectScheduleConflicts,
    getActivePeriods,
    getDayPartPeriods,
    getActiveWeekdays,
    isComplexTimetableModel,
    isActiveTimetableSlot,
    normalizeTimetableProject,
    runTimetableScheduler,
    slotKey,
} from './timetable-scheduler.js';
import {
    validateTimetablePublication,
} from './timetable-validation.js';
import { advancedBlockPreference, advancedRuleAppliesToLesson } from './timetable-advanced-rules.js';
import { analyzeTimetableFeasibility } from './timetable-diagnostic-scheduler.js';

const DEFAULT_TIMEOUT_MS = 210000;
const LARGE_PROJECT_TIMEOUT_MS = 210000;
const POLL_INTERVAL_MS = 500;
const NONE_ROOM_ID = '__NONE__';

export class TimetableTimefoldError extends Error {
    constructor(message, reason = 'unavailable', status = 503, solverStats = null) {
        super(message);
        this.name = 'TimetableTimefoldError';
        this.reason = reason;
        this.status = status;
        this.solverStats = solverStats;
    }
}

export function supportsTimefoldComplexTimetable(env = process.env) {
    return String(env.TIMEFOLD_TIMETABLE_COMPLEX_MODEL || '').trim() === '1';
}

export function canUseTimefoldForTimetable(project = {}, env = process.env) {
    const activeDutyCount = (project.dutyAssignments || []).filter(item => item && item.status !== 'paused').length;
    if (activeDutyCount > 0) return false;
    return !isComplexTimetableModel(project) || supportsTimefoldComplexTimetable(env);
}

export function timefoldTimetableUnsupportedReason(project = {}, env = process.env) {
    const activeDutyCount = (project.dutyAssignments || []).filter(item => item && item.status !== 'paused').length;
    if (activeDutyCount > 0) {
        return {
            reason: 'duty_assignments_not_supported',
            message: 'Timefold timetable bridge does not support duty assignment occupancy yet',
            solverStats: {
                accepted: false,
                reason: 'duty_assignments_not_supported',
                dutyAssignmentCount: activeDutyCount,
            },
        };
    }
    if (isComplexTimetableModel(project) && !supportsTimefoldComplexTimetable(env)) {
        return {
            reason: 'complex_model_not_supported',
            message: 'Timefold timetable bridge does not support complex_v1 yet',
            solverStats: {
                accepted: false,
                reason: 'complex_model_not_supported',
                complexModelEnabled: true,
            },
        };
    }
    return null;
}

function asText(value) {
    return String(value ?? '').trim();
}

function normalizeSolverUrl(env = {}) {
    const url = asText(env.TIMEFOLD_SOLVER_URL);
    return url ? url.replace(/\/+$/, '') : '';
}

export function resolveTimetableSolverTimeoutMs(project = {}, env = {}) {
    const timetableSeconds = Number(env.TIMETABLE_SOLVER_TIMEOUT);
    if (Number.isFinite(timetableSeconds) && timetableSeconds > 0) return Math.round(timetableSeconds * 1000);
    const timefoldSeconds = Number(env.TIMEFOLD_SOLVER_TIMEOUT);
    if (Number.isFinite(timefoldSeconds) && timefoldSeconds > 0) return Math.round(timefoldSeconds * 1000);
    return (project.classes || []).length >= 30 ? LARGE_PROJECT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function buildTimetableSolveScaleHint(project = {}, env = {}) {
    const classCount = (project.classes || []).length;
    const lessonCount = totalLessonHours(project);
    const timeoutMs = resolveTimetableSolverTimeoutMs(project, env);
    const largeProject = classCount >= 30 || lessonCount >= 600;
    const solverAvailable = Boolean(normalizeSolverUrl(env));
    return {
        largeProject,
        solverAvailable,
        classCount,
        lessonCount,
        timeoutMs,
        timeoutSeconds: Math.round(timeoutMs / 1000),
        estimatedSeconds: largeProject ? Math.round(timeoutMs / 1000) : null,
        message: largeProject
            ? solverAvailable
                ? `${classCount} 个班、${lessonCount} 课时；Timefold 求解超时上限 ${Math.round(timeoutMs / 1000)} 秒。`
                : `${classCount} 个班、${lessonCount} 课时；未配置外部求解器，将使用本地求解，可能需要较长时间。`
            : '',
    };
}

function timeoutMs(env = {}, project = {}) {
    return resolveTimetableSolverTimeoutMs(project, env);
}

function resolveFetch(fetchImpl) {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    throw new TimetableTimefoldError('No fetch implementation is available for Timefold', 'missing_fetch', 503);
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function totalLessonHours(project = {}) {
    return (project.lessonPlans || []).reduce((sum, plan) => sum + (Number.parseInt(plan.weeklyHours, 10) || 0), 0);
}

function isTimeoutLikeError(error) {
    const name = String(error?.name || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    return name === 'timeouterror'
        || name === 'aborterror'
        || message.includes('timed out')
        || message.includes('timeout')
        || message.includes('aborted');
}

function buildTimeoutStats({ project, problem, jobId, status, startedAt, timeout, problemStats = {} }) {
    return {
        ...problemStats,
        jobId: jobId || null,
        solverStatus: status?.solverStatus || null,
        lessonCount: totalLessonHours(project),
        assignmentCount: problem?.lessonAssignments?.length || 0,
        timeoutMs: timeout,
        timeoutSeconds: Math.round(timeout / 1000),
        durationMs: Date.now() - startedAt,
    };
}

async function parseJsonResponse(response, fallback = {}) {
    const text = await response.text();
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

async function fetchJson(fetchImpl, url, options, timeout) {
    const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(timeout),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        if (response.status === 404 && String(url).includes('/timetable-solutions')) {
            throw new TimetableTimefoldError(
                'Timefold timetable endpoint is missing. Rebuild or restart the solver service.',
                'endpoint_missing',
                404,
            );
        }
        throw new TimetableTimefoldError(
            payload?.error || `Timefold request failed with HTTP ${response.status}`,
            'http_error',
            response.status || 503,
        );
    }
    return payload;
}

function unique(values = []) {
    const result = [];
    for (const value of values) {
        const text = asText(value);
        if (text && !result.includes(text)) result.push(text);
    }
    return result;
}

function teacherIdsForPlan(plan) {
    const ids = unique([...(plan.teacherIds || []), plan.teacherId]);
    return ids.length ? ids : [plan.teacherId].filter(Boolean);
}

function collectRooms(project) {
    const rooms = new Map([[NONE_ROOM_ID, { id: NONE_ROOM_ID, name: 'None', none: true }]]);
    for (const room of project.rooms || []) {
        const id = asText(room.id || room.name);
        if (id) rooms.set(id, { id, name: room.name || id, none: false, tags: room.tags || [] });
    }
    for (const plan of project.lessonPlans) {
        for (const roomId of unique([...(plan.allowedRoomIds || []), plan.roomId])) {
            if (!rooms.has(roomId)) {
                rooms.set(roomId, { id: roomId, name: roomId, none: false, tags: [] });
            }
        }
    }
    for (const requirement of Object.values(project.rules?.hardRules?.roomRequirements || {})) {
        for (const roomId of requirement?.roomIds || []) {
            if (!rooms.has(roomId)) {
                rooms.set(roomId, { id: roomId, name: roomId, none: false, tags: [] });
            }
        }
    }
    return [...rooms.values()];
}

function buildTimeSlots(project) {
    const result = [];
    const activePeriods = getActivePeriods(project);
    const morningPeriods = new Set(getDayPartPeriods(project, 'morning'));
    for (const day of getActiveWeekdays(project)) {
        for (const period of activePeriods) {
            result.push({
                id: slotKey(day, period),
                weekday: day,
                lessonIndex: period,
                morning: morningPeriods.has(period),
            });
        }
    }
    return result;
}

function blockedSlotsForPlan(project, plan) {
    const blocked = new Set(project.rules?.hardRules?.classUnavailable?.[plan.classId] || []);
    for (const key of project.rules?.hardRules?.globalUnavailable || []) blocked.add(key);
    for (const teacherId of teacherIdsForPlan(plan)) {
        const teacher = project.teachers.find(item => item.id === teacherId);
        for (const key of teacher?.unavailableSlots || []) blocked.add(key);
        for (const key of project.rules?.hardRules?.teacherUnavailable?.[teacherId] || []) blocked.add(key);
    }
    return [...blocked].sort();
}

function roomRequirementIdsForPlan(project, plan) {
    const requirement = project.rules?.hardRules?.roomRequirements?.[plan.subjectId] || {};
    const roomIds = unique(requirement.roomIds || []);
    const requiredTags = unique(requirement.requiredTags || []);
    if (requiredTags.length) {
        for (const room of project.rooms || []) {
            const tags = new Set(room.tags || []);
            if (requiredTags.every(tag => tags.has(tag))) roomIds.push(room.id);
        }
    }
    return unique(roomIds);
}

function teacherMutualExclusionGroupsForPlan(project, plan) {
    const teacherIds = new Set(teacherIdsForPlan(plan));
    return (project.rules?.hardRules?.teacherMutualExclusion || [])
        .map((group, index) => ({
            id: `mutual_${index + 1}`,
            teacherIds: group.teacherIds || [],
        }))
        .filter(group => group.teacherIds.some(teacherId => teacherIds.has(teacherId)))
        .map(group => group.id);
}

function notSameDaySubjectIdsForPlan(project, plan) {
    const result = [];
    for (const pair of project.rules?.hardRules?.subjectNotSameDay || []) {
        const subjectIds = pair.subjectIds || [];
        const classIds = pair.classIds || [];
        if (!subjectIds.includes(plan.subjectId)) continue;
        if (classIds.length && !classIds.includes(plan.classId)) continue;
        subjectIds.filter(subjectId => subjectId !== plan.subjectId).forEach(subjectId => result.push(subjectId));
    }
    return unique(result);
}

function intRuleValue(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function teacherRuleLimit(project, ruleName, teacherId) {
    return intRuleValue(project.rules?.hardRules?.[ruleName]?.[teacherId]);
}

function teacherLoadBalanceWeightForProject(project) {
    const soft = project.rules?.softRules || {};
    if (soft.teacherLoadBalance?.enabled !== true && soft.balancedTeacherLoad !== true) return 0;
    const explicit = Number.parseInt(soft.teacherLoadBalance?.weight, 10);
    if (Number.isInteger(explicit) && explicit >= 0) return explicit;
    return 1;
}

function teacherConstraintRefsForPlan(project, teacherIds = []) {
    const loadBalanceWeight = teacherLoadBalanceWeightForProject(project);
    return unique(teacherIds).map(teacherId => ({
        teacherId,
        weeklyMax: teacherRuleLimit(project, 'teacherWeeklyLimit', teacherId),
        maxDays: teacherRuleLimit(project, 'teacherMaxDaysPerWeek', teacherId),
        loadBalanceWeight,
    }));
}

function advancedRuleRefsForPlan(project, plan) {
    return (project.rules?.advancedRules || [])
        .filter(rule => advancedRuleAppliesToLesson(project, rule, plan))
        .map(rule => ({
            id: rule.id,
            type: rule.type,
            hard: rule.strength === 'hard',
            slots: rule.parameters?.slots || [],
            days: rule.parameters?.days || [],
            periods: rule.parameters?.periods || [],
            subjectIds: rule.parameters?.subjectIds || rule.target?.matchedIds || [],
            roomIds: rule.parameters?.roomIds || rule.parameters?.roomRequirement?.roomIds || [],
            requiredRoomTypes: rule.parameters?.requiredTags || rule.parameters?.roomRequirement?.requiredTags || [],
            preferredRoomIds: rule.parameters?.preferredRoomIds || [],
            forbiddenRoomTypes: rule.parameters?.forbiddenRoomTypes || [],
            boundaryPeriods: rule.parameters?.boundaryPeriods || [],
            minOccurrences: Number(rule.parameters?.minOccurrences) || 0,
            blockSize: Number(rule.parameters?.blockSize) || 0,
        }));
}

function sequenceRulesForPlan(project, plan) {
    return (project.rules?.softRules?.subjectSequence || [])
        .filter(item => (
            item.beforeSubjectId === plan.subjectId
            || item.afterSubjectId === plan.subjectId
        ) && (!(item.classIds || []).length || item.classIds.includes(plan.classId)))
        .map(item => ({
            beforeSubjectId: item.beforeSubjectId,
            afterSubjectId: item.afterSubjectId,
            weight: Number.parseInt(item.weight, 10) || 1,
        }));
}

function lockedBlockStartPeriod(project, slot, blockSize) {
    const day = Number(slot.day);
    const period = Number(slot.period);
    for (let start = period; start >= period - blockSize + 1; start -= 1) {
        let fits = true;
        for (let offset = 0; offset < blockSize; offset += 1) {
            if (!isActiveTimetableSlot(project, day, start + offset)) {
                fits = false;
                break;
            }
        }
        if (fits) return start;
    }
    return period;
}

function expandLockedSlotsForPlan(project, plan) {
    const activePeriods = new Set(getActivePeriods(project));
    const matchPlan = slot => {
        if (slot.lessonPlanId) return slot.lessonPlanId === plan.id;
        return slot.classId === plan.classId
            && slot.subjectId === plan.subjectId
            && teacherIdsForPlan(plan).includes(slot.teacherId);
    };
    const result = [];
    const seen = new Set();
    const consumedRules = new Set();
    let placedHours = 0;
    const matchingSlots = (project.rules?.hardRules?.lockedSlots || [])
        .filter(matchPlan)
        .sort((left, right) => Number(left.day) - Number(right.day) || Number(left.period) - Number(right.period));

    for (const slot of matchingSlots) {
        const ruleKey = `${Number(slot.day)}|${Number(slot.period)}`;
        if (consumedRules.has(ruleKey)) continue;
        const blockSize = nextLockedBlockSizeForPlan(plan, placedHours, project);
        let accepted = 0;
        const startPeriod = lockedBlockStartPeriod(project, slot, blockSize);
        for (let offset = 0; offset < blockSize; offset += 1) {
            const day = Number(slot.day);
            const period = startPeriod + offset;
            if (!isActiveTimetableSlot(project, day, period) || !activePeriods.has(period)) continue;
            const key = `${day}|${period}`;
            if (seen.has(key)) continue;
            seen.add(key);
            consumedRules.add(key);
            accepted += 1;
            result.push({
                ...slot,
                day,
                period,
            });
        }
        placedHours += accepted;
    }

    return result.sort((left, right) => left.day - right.day || left.period - right.period);
}

function lockedSlotsForPlan(project, plan) {
    return expandLockedSlotsForPlan(project, plan);
}

function protectedInitialSlotIds(initialSlots = []) {
    const protectedBlockIds = new Set();
    initialSlots.forEach(slot => {
        if ((slot.locked || slot.manuallyAdjusted) && slot.blockId) {
            protectedBlockIds.add(slot.blockId);
        }
    });
    const ids = new Set();
    initialSlots.forEach(slot => {
        if (slot.locked || slot.manuallyAdjusted || (slot.blockId && protectedBlockIds.has(slot.blockId))) {
            ids.add(slot.id);
        }
    });
    return ids;
}

function slotFromLockedRule(ruleSlot, fallbackSlot = null) {
    if (!ruleSlot) return fallbackSlot;
    return {
        ...(fallbackSlot || {}),
        day: ruleSlot.day,
        period: ruleSlot.period,
        roomId: ruleSlot.roomId || fallbackSlot?.roomId || null,
        locked: true,
    };
}

function takeInitialSlotForLocked(initialSlots, locked, usedIndexes) {
    if (!locked) return null;
    const index = initialSlots.findIndex((slot, slotIndex) => (
        !usedIndexes.has(slotIndex)
        && slot.day === locked.day
        && slot.period === locked.period
    ));
    if (index < 0) return null;
    usedIndexes.add(index);
    return initialSlots[index];
}

function takeNextInitialSlot(initialSlots, usedIndexes) {
    const index = initialSlots.findIndex((slot, slotIndex) => !usedIndexes.has(slotIndex));
    if (index < 0) return null;
    usedIndexes.add(index);
    return initialSlots[index];
}

function blockSizesForPlan(plan, project = null) {
    let remaining = Math.max(0, Number.parseInt(plan.weeklyHours, 10) || 0);
    const sizes = [];
    const blockPreference = project ? advancedBlockPreference(project, plan) : plan.blockPreference;
    if (blockPreference === 'double') {
        while (remaining >= 2) {
            sizes.push(2);
            remaining -= 2;
        }
    } else if (blockPreference === 'mixed' && remaining >= 4) {
        // Match the fast scheduler: keep a couple of single periods alongside
        // doubles, e.g. 6h -> 2+2+1+1 and 5h -> 2+2+1.
        const singles = remaining % 2 === 0 ? 2 : 1;
        let doubleBudget = remaining - singles;
        while (doubleBudget >= 2) {
            sizes.push(2);
            doubleBudget -= 2;
            remaining -= 2;
        }
    }
    while (remaining > 0) {
        sizes.push(1);
        remaining -= 1;
    }
    return sizes;
}

function nextLockedBlockSizeForPlan(plan, placedHours = 0, project = null) {
    let consumed = 0;
    for (const size of blockSizesForPlan(plan, project)) {
        if (placedHours < consumed + size) return size;
        consumed += size;
    }
    return 1;
}

function makeAssignment({ plan, sequence, blockNumber, blockSize, blockIndex, pinnedTimeSlotId, initialSlot, project }) {
    const teacherIds = teacherIdsForPlan(plan);
    const primaryTeacherId = teacherIds[0] || plan.teacherId;
    const teacherConstraintRefs = teacherConstraintRefsForPlan(project, teacherIds);
    const teacherLoadBalanceWeight = teacherLoadBalanceWeightForProject(project);
    const ruleRoomIds = roomRequirementIdsForPlan(project, plan);
    const allowedRoomIds = unique([...(plan.allowedRoomIds || []), plan.roomId, ...ruleRoomIds]);
    const afternoonSubjects = project.rules?.softRules?.afternoonSubjects || [];
    const klass = project.classes.find(item => item.id === plan.classId);
    return {
        id: `${plan.id}_${sequence + 1}`,
        lessonPlanId: plan.id,
        sequence,
        classId: plan.classId,
        subjectId: plan.subjectId,
        teacherId: primaryTeacherId,
        teacherIds,
        teacherConstraintRefs,
        timeSlot: initialSlot ? slotKey(initialSlot.day, initialSlot.period) : null,
        room: initialSlot?.roomId || (allowedRoomIds.length ? null : NONE_ROOM_ID),
        pinnedTimeSlotId: pinnedTimeSlotId || null,
        locked: Boolean(pinnedTimeSlotId && (initialSlot?.locked || !initialSlot?.manuallyAdjusted)),
        manuallyAdjusted: Boolean(initialSlot?.manuallyAdjusted),
        blockedTimeSlotIds: blockedSlotsForPlan(project, plan),
        allowedRoomIds,
        requiresRoom: allowedRoomIds.length > 0,
        roomRange: allowedRoomIds.length ? allowedRoomIds : [NONE_ROOM_ID],
        blockId: blockSize > 1 ? `${plan.id}_block_${blockNumber}` : null,
        blockIndex,
        blockSize,
        subjectPriority: 50,
        preferMorning: Boolean(project.rules?.softRules?.morningSubjects?.includes(plan.subjectId)),
        preferLater: Boolean(afternoonSubjects.includes(plan.subjectId)),
        subjectDailyMax: project.rules?.hardRules?.subjectDailyLimit?.[plan.subjectId] || 0,
        teacherWeeklyMax: teacherRuleLimit(project, 'teacherWeeklyLimit', primaryTeacherId),
        teacherMaxDays: teacherRuleLimit(project, 'teacherMaxDaysPerWeek', primaryTeacherId),
        mutualExclusionGroups: teacherMutualExclusionGroupsForPlan(project, plan),
        notSameDaySubjectIds: notSameDaySubjectIdsForPlan(project, plan),
        sequenceRules: sequenceRulesForPlan(project, plan),
        spreadMinGapDays: Number.parseInt(project.rules?.softRules?.spreadSubjectGaps?.[plan.subjectId], 10) || 1,
        classMainDailyMax: project.rules?.softRules?.classDailyBalance?.mainSubjectDailyMax || 0,
        teacherGapWeight: project.rules?.softRules?.teacherGapWeight || 0,
        teacherLoadBalanceWeight,
        gradeName: klass?.grade || '',
        activityTypes: plan.activityTypes || [],
        requiredResourceTypes: plan.requiredResourceTypes || [],
        advancedRules: advancedRuleRefsForPlan(project, plan),
    };
}

function buildInitialSlotQueues(project) {
    const queues = new Map();
    for (const slot of project.schedule?.slots || []) {
        if (!slot.lessonPlanId) continue;
        if (!queues.has(slot.lessonPlanId)) queues.set(slot.lessonPlanId, []);
        queues.get(slot.lessonPlanId).push(slot);
    }
    for (const queue of queues.values()) {
        queue.sort((left, right) => (
            (left.blockId ? 0 : 1) - (right.blockId ? 0 : 1)
            || String(left.blockId || '').localeCompare(String(right.blockId || ''))
            || (left.blockIndex || 0) - (right.blockIndex || 0)
            || left.day - right.day
            || left.period - right.period
            || left.id.localeCompare(right.id)
        ));
    }
    return queues;
}

function buildLessonAssignments(project) {
    const assignments = [];
    const initialSlotQueues = buildInitialSlotQueues(project);
    for (const plan of project.lessonPlans) {
        const lockedSlots = lockedSlotsForPlan(project, plan);
        const initialSlots = initialSlotQueues.get(plan.id) || [];
        const protectedIds = protectedInitialSlotIds(initialSlots);
        const usedInitialIndexes = new Set();
        let sequence = 0;
        let blockNumber = 0;
        for (const blockSize of blockSizesForPlan(plan, project)) {
            blockNumber += 1;
            for (let blockIndex = 0; blockIndex < blockSize; blockIndex++) {
                const locked = lockedSlots[sequence];
                const lockedInitialSlot = takeInitialSlotForLocked(initialSlots, locked, usedInitialIndexes);
                const currentInitialSlot = lockedInitialSlot || takeNextInitialSlot(initialSlots, usedInitialIndexes);
                const rulePinnedTimeSlotId = locked ? slotKey(locked.day, locked.period) : null;
                const protectedPinnedTimeSlotId = currentInitialSlot && protectedIds.has(currentInitialSlot.id)
                    ? slotKey(currentInitialSlot.day, currentInitialSlot.period)
                    : null;
                const pinnedTimeSlotId = rulePinnedTimeSlotId || protectedPinnedTimeSlotId;
                const initialSlot = rulePinnedTimeSlotId
                    ? slotFromLockedRule(locked, currentInitialSlot)
                    : currentInitialSlot;
                assignments.push(makeAssignment({
                    plan,
                    sequence,
                    blockNumber,
                    blockSize,
                    blockIndex,
                    pinnedTimeSlotId,
                    initialSlot,
                    project,
                }));
                sequence += 1;
            }
        }
    }
    return assignments;
}

export function buildTimetableProblem(input = {}) {
    const project = normalizeTimetableProject(input);
    return {
        name: `${project.schoolName || 'ICeCream'} ${project.term || ''}`.trim(),
        timeSlots: buildTimeSlots(project),
        rooms: collectRooms(project),
        lessonAssignments: buildLessonAssignments(project),
        solverWeights: {
            teacherGap: project.rules?.softRules?.teacherGapWeight || 0,
            teacherLoadBalance: teacherLoadBalanceWeightForProject(project),
        },
    };
}

function assignmentSnapshot(assignment = {}, { pinned = false } = {}) {
    return {
        id: assignment.id,
        timeSlot: pinned
            ? assignment.pinnedTimeSlotId
            : idOfPlanningValue(assignment.timeSlot),
        room: idOfPlanningValue(assignment.room),
    };
}

function buildSolverPayload(problem = {}, warmStart = true) {
    const assignments = problem.lessonAssignments || [];
    return {
        ...problem,
        initialAssignment: assignments
            .filter(assignment => idOfPlanningValue(assignment.timeSlot))
            .map(assignment => assignmentSnapshot(assignment)),
        pinnedAssignments: assignments
            .filter(assignment => assignment.pinnedTimeSlotId)
            .map(assignment => assignmentSnapshot(assignment, { pinned: true })),
        solverConfig: { warmStart },
    };
}

function stripOptionalInitialAssignments(problem = {}) {
    return {
        ...problem,
        lessonAssignments: (problem.lessonAssignments || []).map(assignment => {
            const pinnedTimeSlotId = asText(assignment.pinnedTimeSlotId);
            return {
                ...assignment,
                timeSlot: pinnedTimeSlotId || null,
                room: pinnedTimeSlotId
                    ? assignment.room
                    : (assignment.requiresRoom ? null : NONE_ROOM_ID),
            };
        }),
    };
}

function problemWithSchedule(project = {}, schedule = null) {
    return normalizeTimetableProject({
        ...project,
        schedule,
    });
}

function warmStartCandidate(project = {}, schedulerResult = null) {
    const candidateProject = schedulerResult?.project
        || (schedulerResult?.schedule ? problemWithSchedule(project, schedulerResult.schedule) : project);
    const problem = buildTimetableProblem(candidateProject);
    const schedule = candidateProject.schedule || null;
    const publication = schedule ? validateTimetablePublication(candidateProject) : null;
    const stats = solverStatsForProblem(problem);
    const placedLessons = Number(schedule?.score?.placedLessons || schedule?.slots?.length || 0);
    const totalLessons = Number(schedule?.score?.totalLessons || totalLessonHours(candidateProject));
    const complete = Boolean(
        schedule
        && placedLessons === totalLessons
        && stats.initialUnassignedCount === 0
        && Number(schedule.score?.unplacedLessons || 0) === 0
        && Number(schedule.score?.hardConflicts || 0) === 0
        && publication?.ok
    );
    return { candidateProject, problem, publication, stats, complete };
}

function summarizeFastAttempt(schedulerResult = null) {
    const schedule = schedulerResult?.schedule || schedulerResult?.project?.schedule || null;
    if (!schedule) return null;
    return {
        placedLessons: Number(schedule.score?.placedLessons || schedule.slots?.length || 0),
        totalLessons: Number(schedule.score?.totalLessons || 0),
        unplacedLessons: Number(schedule.score?.unplacedLessons || schedule.unplaced?.length || 0),
        hardConflicts: Number(schedule.score?.hardConflicts || 0),
        solveMs: Number(schedule.solverStats?.solveMs || 0) || null,
    };
}

function failureSummaryForSchedule(schedule = null) {
    if (!schedule) return null;
    const grouped = new Map();
    for (const conflict of schedule.conflicts || []) {
        const type = asText(conflict?.type) || 'hard_conflict';
        grouped.set(type, (grouped.get(type) || 0) + 1);
    }
    const hardScore = Number(schedule.solverStats?.hardScore || 0);
    const localHardConflicts = Number(schedule.score?.hardConflicts || schedule.conflicts?.length || 0);
    return {
        unplacedLessons: Number(schedule.score?.unplacedLessons || schedule.unplaced?.length || 0),
        hardConflicts: Math.max(localHardConflicts, Math.abs(Math.min(0, hardScore))),
        conflictTypes: Object.fromEntries([...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
        examples: (schedule.conflicts || []).slice(0, 5).map(item => ({
            type: item.type || 'hard_conflict',
            message: item.message || 'Hard timetable conflict',
            lessonPlanId: item.lessonPlanId || item.slot?.lessonPlanId || '',
            classId: item.classId || item.slot?.classId || '',
            teacherId: item.teacherId || item.slot?.teacherId || '',
        })),
    };
}

function mergeFailureSummaries(remoteSummary = null, localSummary = null) {
    const remote = remoteSummary && typeof remoteSummary === 'object' ? remoteSummary : null;
    const local = localSummary && typeof localSummary === 'object' ? localSummary : null;
    if (!remote) return local;
    if (!local) return remote;
    return {
        ...local,
        ...remote,
        conflictTypes: Object.keys(remote.conflictTypes || {}).length > 0
            ? remote.conflictTypes
            : local.conflictTypes,
        examples: Array.isArray(remote.examples) && remote.examples.length > 0
            ? remote.examples
            : local.examples,
        topConstraints: Array.isArray(remote.topConstraints) && remote.topConstraints.length > 0
            ? remote.topConstraints
            : local.topConstraints,
    };
}

async function emitSolverProgress(onProgress, patch = {}) {
    if (typeof onProgress !== 'function') return;
    try {
        await onProgress(patch);
    } catch {
        // Progress reporting must never abort the solve itself.
    }
}

function countPinnedAssignments(problem = {}) {
    return (problem.lessonAssignments || []).filter(assignment => assignment.pinnedTimeSlotId).length;
}

function hasInitialSolution(problem = {}) {
    return (problem.lessonAssignments || []).some(assignment => idOfPlanningValue(assignment.timeSlot));
}

function solverStatsForProblem(problem = {}, metadata = {}) {
    const assignmentCount = (problem.lessonAssignments || []).length;
    const initialAssignedCount = (problem.lessonAssignments || [])
        .filter(assignment => idOfPlanningValue(assignment.timeSlot)).length;
    return {
        ...metadata,
        initialSolutionUsed: hasInitialSolution(problem),
        initialAssignmentCount: assignmentCount,
        initialAssignedCount,
        initialUnassignedCount: Math.max(0, assignmentCount - initialAssignedCount),
        pinnedCount: countPinnedAssignments(problem),
    };
}

function idOfPlanningValue(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return asText(value.id);
    return '';
}

function assignmentToSlot(assignment) {
    const timeSlotId = idOfPlanningValue(assignment.timeSlot);
    const [dayText, periodText] = timeSlotId.split('-');
    const day = Number.parseInt(dayText, 10);
    const period = Number.parseInt(periodText, 10);
    if (!Number.isInteger(day) || !Number.isInteger(period)) return null;
    const teacherIds = teacherIdsForPlan(assignment);
    const roomId = idOfPlanningValue(assignment.room);
    const locked = assignment.locked !== undefined
        ? Boolean(assignment.locked)
        : Boolean(assignment.pinnedTimeSlotId && !assignment.manuallyAdjusted);
    return {
        id: `slot_${assignment.id}_${day}_${period}`,
        day,
        period,
        classId: assignment.classId,
        subjectId: assignment.subjectId,
        teacherId: teacherIds[0] || assignment.teacherId,
        teacherIds,
        lessonPlanId: assignment.lessonPlanId,
        roomId: roomId && roomId !== NONE_ROOM_ID ? roomId : null,
        blockId: assignment.blockId || null,
        blockIndex: Number.isInteger(Number(assignment.blockIndex)) ? Number(assignment.blockIndex) : 0,
        blockSize: Math.max(1, Number.parseInt(assignment.blockSize, 10) || 1),
        locked,
        manuallyAdjusted: Boolean(assignment.manuallyAdjusted),
    };
}

export function transformTimetableSolutionToSchedule(inputProject = {}, solution = {}, stats = {}) {
    const project = normalizeTimetableProject(inputProject);
    const slots = [];
    const unplaced = [];
    for (const assignment of solution.lessonAssignments || []) {
        const slot = assignmentToSlot(assignment);
        if (slot) {
            slots.push(slot);
        } else {
            unplaced.push({
                lessonPlanId: assignment.lessonPlanId,
                classId: assignment.classId,
                subjectId: assignment.subjectId,
                teacherId: assignment.teacherId,
                reason: 'Timefold did not assign a valid time slot',
            });
        }
    }
    const missingAssignmentCount = Math.max(0, totalLessonHours(project) - slots.length - unplaced.length);
    for (let index = 0; index < missingAssignmentCount; index += 1) {
        unplaced.push({
            lessonPlanId: '',
            classId: '',
            subjectId: '',
            teacherId: '',
            reason: 'Timefold solution omitted a lesson assignment',
        });
    }

    const conflicts = [
        ...unplaced.map(item => ({
            type: 'unplaced',
            severity: 'hard',
            message: item.reason,
            lessonPlanId: item.lessonPlanId,
            classId: item.classId,
            subjectId: item.subjectId,
            teacherId: item.teacherId,
        })),
        ...detectScheduleConflicts(project, slots),
    ];
    const score = buildTimetableScore(project, slots, unplaced, conflicts);
    const audit = auditTimetableProject(project);
    const qualityIssues = buildTimetableQualityIssues(project, slots);

    const schedule = {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'timefold_solver',
        slots: slots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: slots.filter(slot => slot.locked),
        conflicts,
        unplaced,
        audit,
        qualityIssues,
        score,
        solverStats: {
            ...stats,
            solverUsed: true,
            jobId: solution.jobId || stats.jobId || null,
            score: solution.score || stats.score || null,
            hardScore: Number(solution.hardScore ?? stats.hardScore ?? 0),
            softScore: Number(solution.softScore ?? stats.softScore ?? 0),
            durationMs: stats.durationMs ?? null,
            solverStatus: solution.solverStatus || stats.solverStatus || null,
            initialSolutionUsed: Boolean(stats.initialSolutionUsed),
            pinnedCount: Number(stats.pinnedCount || 0),
            accepted: stats.accepted ?? null,
            reason: stats.reason || null,
        },
    };
    schedule.publication = validateTimetablePublication({ ...project, schedule });
    return schedule;
}

function assertPinnedAssignmentsPreserved(problem, solution, stats = {}) {
    const pinnedById = new Map();
    for (const assignment of problem.lessonAssignments || []) {
        if (assignment.pinnedTimeSlotId) pinnedById.set(assignment.id, assignment.pinnedTimeSlotId);
    }
    if (!pinnedById.size) return;

    const moved = [];
    for (const assignment of solution.lessonAssignments || []) {
        const pinnedTimeSlotId = pinnedById.get(assignment.id);
        if (!pinnedTimeSlotId) continue;
        if (idOfPlanningValue(assignment.timeSlot) !== pinnedTimeSlotId) {
            moved.push({
                assignmentId: assignment.id,
                expected: pinnedTimeSlotId,
                actual: idOfPlanningValue(assignment.timeSlot) || null,
            });
        }
    }
    if (!moved.length) return;

    throw new TimetableTimefoldError(
        'Timefold moved pinned timetable assignments',
        'pinned_slot_moved',
        422,
        {
            ...stats,
            ...solverStatsForProblem(problem),
            accepted: false,
            reason: 'pinned_slot_moved',
            movedPinnedCount: moved.length,
            movedPinnedAssignments: moved,
        },
    );
}

function assertSolvedSchedule(schedule) {
    if (schedule.solverStats.hardScore < 0) {
        throw new TimetableTimefoldError(
            'Timefold returned a hard constraint violation',
            'hard_score_violation',
            422,
            schedule.solverStats,
        );
    }
    if (schedule.score.unplacedLessons > 0 || schedule.score.placedLessons < schedule.score.totalLessons) {
        throw new TimetableTimefoldError(
            'Timefold did not assign all lesson hours',
            'incomplete_solution',
            422,
            schedule.solverStats,
        );
    }
    if (schedule.score.hardConflicts > 0) {
        throw new TimetableTimefoldError(
            'Timefold solution failed timetable validation',
            'validation_failed',
            422,
            schedule.solverStats,
        );
    }
    if (schedule.publication?.ok !== true) {
        throw new TimetableTimefoldError(
            'Timefold solution failed publication validation',
            'validation_failed',
            422,
            schedule.solverStats,
        );
    }
}

export async function solveTimetableWithTimefold({
    project = createDefaultTimetableProject(),
    env = process.env,
    fetchImpl,
    seed,
    fastAttempt = null,
    runFastAttempt = true,
    onProgress,
} = {}) {
    const normalizedProject = normalizeTimetableProject(project);
    const unsupported = timefoldTimetableUnsupportedReason(normalizedProject, env);
    if (unsupported) {
        throw new TimetableTimefoldError(
            unsupported.message,
            unsupported.reason,
            409,
            unsupported.solverStats,
        );
    }
    const feasibility = analyzeTimetableFeasibility(normalizedProject);
    if (feasibility.status === 'input_infeasible') {
        throw new TimetableTimefoldError(
            'Timetable input contains hard constraints with no feasible scheduling domain',
            'input_infeasible',
            422,
            {
                accepted: false,
                reason: 'input_infeasible',
                feasibility: {
                    status: feasibility.status,
                    issues: feasibility.issues,
                    candidateDomainStats: feasibility.candidateDomainStats,
                },
                candidateDomainStats: feasibility.candidateDomainStats,
            },
        );
    }
    const solverUrl = normalizeSolverUrl(env);
    if (!solverUrl) {
        throw new TimetableTimefoldError('TIMEFOLD_SOLVER_URL is not configured', 'not_configured', 503);
    }
    const fetchClient = resolveFetch(fetchImpl);
    const timeout = timeoutMs(env, normalizedProject);
    const warmStart = asText(env.TIMEFOLD_TIMETABLE_WARM_START).toLowerCase() !== 'false';
    const computedFastAttempt = fastAttempt || (warmStart && runFastAttempt
        ? runTimetableScheduler(normalizedProject, { seed })
        : null);
    // The Gateway timeout is the Timefold wait budget. Local candidate
    // construction is a separate deterministic phase and must not consume the
    // Java solver's configured budget, especially for large projects.
    const startedAt = Date.now();
    const deadline = startedAt + timeout;
    const baseCandidate = warmStartCandidate(normalizedProject);
    const fastCandidate = computedFastAttempt
        ? warmStartCandidate(normalizedProject, computedFastAttempt)
        : null;
    let problem = baseCandidate.problem;
    let initialAssignmentSource = baseCandidate.complete ? 'existing_schedule' : 'empty';
    let fastRepairStats = fastCandidate?.stats || null;

    if (!warmStart) {
        problem = stripOptionalInitialAssignments(problem);
        initialAssignmentSource = 'cold_start';
    } else if (fastCandidate?.complete) {
        problem = fastCandidate.problem;
        initialAssignmentSource = 'fast_repair';
    } else if (computedFastAttempt) {
        // The fast constructor may leave a sparse but conflict-free set of
        // placements. Preserve that valid information so Timefold constructs
        // only the remaining units instead of throwing the whole seed away.
        problem = fastCandidate?.problem || stripOptionalInitialAssignments(baseCandidate.problem);
        initialAssignmentSource = fastCandidate?.stats?.initialAssignedCount
            ? 'validated_partial_fast_attempt'
            : 'cold_after_partial_fast_attempt';
    } else if (!baseCandidate.complete) {
        problem = stripOptionalInitialAssignments(baseCandidate.problem);
        initialAssignmentSource = hasInitialSolution(problem) ? 'pinned_only' : 'empty';
    }
    const fastAttemptStats = summarizeFastAttempt(computedFastAttempt);
    const problemStats = solverStatsForProblem(problem, {
        warmStart,
        warmStartAttempted: warmStart,
        initialAssignmentSource,
        ...(fastAttemptStats ? { fastAttempt: fastAttemptStats } : {}),
        ...(fastRepairStats ? {
            fastRepairAssignedCount: fastRepairStats.initialAssignedCount,
            fastRepairUnassignedCount: fastRepairStats.initialUnassignedCount,
        } : {}),
    });
    const solverPayload = buildSolverPayload(problem, warmStart);
    let jobId = null;
    let status = null;

    const remaining = () => Math.max(1, deadline - Date.now());

    try {
        await emitSolverProgress(onProgress, {
            stage: 'timefold_submit',
            elapsedMs: Date.now() - startedAt,
            ...problemStats,
        });
        const created = await fetchJson(fetchClient, `${solverUrl}/timetable-solutions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(solverPayload),
        }, remaining());
        jobId = created.jobId;
        if (!jobId) {
            throw new TimetableTimefoldError('Timefold did not return a timetable jobId', 'invalid_response', 503);
        }

        status = created;
        while (Date.now() < deadline) {
            status = await fetchJson(fetchClient, `${solverUrl}/timetable-solutions/${encodeURIComponent(jobId)}/status`, {
                method: 'GET',
            }, remaining());
            await emitSolverProgress(onProgress, {
                stage: status.stage || (status.solverStatus === 'NOT_SOLVING' ? 'timefold_finished' : 'timefold_solving'),
                elapsedMs: Number.isFinite(Number(status.elapsedMs)) ? Number(status.elapsedMs) : Date.now() - startedAt,
                jobId,
                solverStatus: status.solverStatus || null,
                hardScore: Number.isFinite(Number(status.hardScore)) ? Number(status.hardScore) : null,
                softScore: Number.isFinite(Number(status.softScore)) ? Number(status.softScore) : null,
                initialized: Boolean(status.initialized),
                constraintAnalysis: Array.isArray(status.constraintAnalysis) ? status.constraintAnalysis : [],
                failureSummary: status.failureSummary || null,
                ...problemStats,
            });
            if (status.solverStatus === 'NOT_SOLVING') break;
            await sleep(Math.min(POLL_INTERVAL_MS, remaining()));
        }

        if (status.solverStatus !== 'NOT_SOLVING') {
            throw new TimetableTimefoldError('Timefold timetable solve timed out', 'timeout', 504, {
                ...buildTimeoutStats({
                    project: normalizedProject,
                    problem,
                    jobId,
                    status,
                    startedAt,
                    timeout,
                    problemStats,
                }),
            });
        }
        const solution = await fetchJson(fetchClient, `${solverUrl}/timetable-solutions/${encodeURIComponent(jobId)}`, {
            method: 'GET',
        }, remaining());
        const solutionStats = {
            ...status,
            ...problemStats,
            jobId,
            durationMs: Date.now() - startedAt,
        };
        assertPinnedAssignmentsPreserved(problem, solution, solutionStats);
        const schedule = transformTimetableSolutionToSchedule(normalizedProject, solution, {
            ...solutionStats,
        });
        if (Number(status.hardScore ?? schedule.solverStats.hardScore ?? 0) < 0) {
            schedule.solverStats.hardScore = Number(status.hardScore ?? schedule.solverStats.hardScore ?? 0);
            schedule.solverStats.softScore = Number(status.softScore ?? schedule.solverStats.softScore ?? 0);
            throw new TimetableTimefoldError('Timefold exhausted its search budget before finding a feasible timetable', 'search_exhausted', 422, {
                ...solutionStats,
                score: status.score || null,
                hardScore: Number(status.hardScore ?? schedule.solverStats.hardScore ?? 0),
                softScore: Number(status.softScore ?? schedule.solverStats.softScore ?? 0),
                solverStatus: status.solverStatus || null,
                failureSummary: mergeFailureSummaries(
                    status.failureSummary,
                    failureSummaryForSchedule(schedule),
                ),
                feasibility: { status: 'search_exhausted' },
                accepted: false,
                reason: 'search_exhausted',
            });
        }
        assertSolvedSchedule(schedule);
        return {
            success: true,
            project: { ...normalizedProject, schedule },
            schedule,
            problem,
        };
    } catch (error) {
        if (error instanceof TimetableTimefoldError) {
            throw error;
        }
        if (isTimeoutLikeError(error)) {
            throw new TimetableTimefoldError(
                'Timefold timetable solve timed out',
                'timeout',
                504,
                buildTimeoutStats({
                    project: normalizedProject,
                    problem,
                    jobId,
                    status,
                    startedAt,
                    timeout,
                    problemStats,
                }),
            );
        }
        throw new TimetableTimefoldError(
            error?.message || 'Timefold timetable request failed',
            'http_error',
            503,
            {
                ...problemStats,
                jobId,
                elapsedMs: Date.now() - startedAt,
                accepted: false,
                reason: 'http_error',
            },
        );
    } finally {
        if (jobId) {
            fetchClient(`${solverUrl}/timetable-solutions/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}
