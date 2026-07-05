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
    slotKey,
} from './timetable-scheduler.js';
import {
    validateTimetablePublication,
} from './timetable-validation.js';

const DEFAULT_TIMEOUT_MS = 210000;
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
    return !isComplexTimetableModel(project) || supportsTimefoldComplexTimetable(env);
}

function asText(value) {
    return String(value ?? '').trim();
}

function normalizeSolverUrl(env = {}) {
    const url = asText(env.TIMEFOLD_SOLVER_URL);
    return url ? url.replace(/\/+$/, '') : '';
}

function timeoutMs(env = {}) {
    const seconds = Number(env.TIMETABLE_SOLVER_TIMEOUT ?? env.TIMEFOLD_SOLVER_TIMEOUT);
    return Number.isFinite(seconds) && seconds > 0
        ? Math.round(seconds * 1000)
        : DEFAULT_TIMEOUT_MS;
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

function buildTimeoutStats({ project, problem, jobId, status, startedAt, timeout }) {
    return {
        jobId: jobId || null,
        solverStatus: status?.solverStatus || null,
        lessonCount: totalLessonHours(project),
        assignmentCount: problem?.lessonAssignments?.length || 0,
        initialSolutionUsed: hasInitialSolution(problem),
        pinnedCount: countPinnedAssignments(problem),
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
    for (const plan of project.lessonPlans) {
        for (const roomId of unique([...(plan.allowedRoomIds || []), plan.roomId])) {
            rooms.set(roomId, { id: roomId, name: roomId, none: false });
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
    for (const teacherId of teacherIdsForPlan(plan)) {
        const teacher = project.teachers.find(item => item.id === teacherId);
        for (const key of teacher?.unavailableSlots || []) blocked.add(key);
        for (const key of project.rules?.hardRules?.teacherUnavailable?.[teacherId] || []) blocked.add(key);
    }
    return [...blocked].sort();
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
        const blockSize = nextLockedBlockSizeForPlan(plan, placedHours);
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

function blockSizesForPlan(plan) {
    let remaining = Math.max(0, Number.parseInt(plan.weeklyHours, 10) || 0);
    const sizes = [];
    if (plan.blockPreference === 'double') {
        while (remaining >= 2) {
            sizes.push(2);
            remaining -= 2;
        }
    } else if (plan.blockPreference === 'mixed' && remaining >= 4) {
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

function nextLockedBlockSizeForPlan(plan, placedHours = 0) {
    let consumed = 0;
    for (const size of blockSizesForPlan(plan)) {
        if (placedHours < consumed + size) return size;
        consumed += size;
    }
    return 1;
}

function makeAssignment({ plan, sequence, blockNumber, blockSize, blockIndex, pinnedTimeSlotId, initialSlot, project }) {
    const subject = project.subjects.find(item => item.id === plan.subjectId);
    const teacherIds = teacherIdsForPlan(plan);
    const allowedRoomIds = unique([...(plan.allowedRoomIds || []), plan.roomId]);
    return {
        id: `${plan.id}_${sequence + 1}`,
        lessonPlanId: plan.id,
        sequence,
        classId: plan.classId,
        subjectId: plan.subjectId,
        teacherId: teacherIds[0] || plan.teacherId,
        teacherIds,
        timeSlot: initialSlot ? slotKey(initialSlot.day, initialSlot.period) : null,
        room: initialSlot?.roomId || NONE_ROOM_ID,
        pinnedTimeSlotId: pinnedTimeSlotId || null,
        locked: Boolean(pinnedTimeSlotId && (initialSlot?.locked || !initialSlot?.manuallyAdjusted)),
        manuallyAdjusted: Boolean(initialSlot?.manuallyAdjusted),
        blockedTimeSlotIds: blockedSlotsForPlan(project, plan),
        allowedRoomIds,
        requiresRoom: allowedRoomIds.length > 0,
        blockId: blockSize > 1 ? `${plan.id}_block_${blockNumber}` : null,
        blockIndex,
        blockSize,
        subjectPriority: subject?.priority || 50,
        preferMorning: Boolean(project.rules?.softRules?.morningSubjects?.includes(plan.subjectId) || subject?.priority >= 90),
        preferLater: /pe|music|art|lab|sport|physical/i.test(`${plan.subjectId} ${subject?.name || ''}`),
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
            left.day - right.day
            || left.period - right.period
            || (left.blockIndex || 0) - (right.blockIndex || 0)
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
        for (const blockSize of blockSizesForPlan(plan)) {
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
    };
}

function countPinnedAssignments(problem = {}) {
    return (problem.lessonAssignments || []).filter(assignment => assignment.pinnedTimeSlotId).length;
}

function hasInitialSolution(problem = {}) {
    return (problem.lessonAssignments || []).some(assignment => idOfPlanningValue(assignment.timeSlot));
}

function solverStatsForProblem(problem = {}) {
    return {
        initialSolutionUsed: hasInitialSolution(problem),
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
}

export async function solveTimetableWithTimefold({
    project = createDefaultTimetableProject(),
    env = process.env,
    fetchImpl,
} = {}) {
    const normalizedProject = normalizeTimetableProject(project);
    const solverUrl = normalizeSolverUrl(env);
    if (!solverUrl) {
        throw new TimetableTimefoldError('TIMEFOLD_SOLVER_URL is not configured', 'not_configured', 503);
    }
    if (!canUseTimefoldForTimetable(normalizedProject, env)) {
        throw new TimetableTimefoldError(
            'Timefold timetable bridge does not support complex_v1 yet',
            'complex_model_not_supported',
            409,
            {
                accepted: false,
                reason: 'complex_model_not_supported',
                complexModelEnabled: true,
            },
        );
    }
    const fetchClient = resolveFetch(fetchImpl);
    const timeout = timeoutMs(env);
    const deadline = Date.now() + timeout;
    const startedAt = Date.now();
    const problem = buildTimetableProblem(normalizedProject);
    const problemStats = solverStatsForProblem(problem);
    let jobId = null;
    let status = null;

    const remaining = () => Math.max(1, deadline - Date.now());

    try {
        const created = await fetchJson(fetchClient, `${solverUrl}/timetable-solutions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(problem),
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
            if (status.solverStatus === 'NOT_SOLVING') break;
            await sleep(Math.min(POLL_INTERVAL_MS, remaining()));
        }

        if (status.solverStatus !== 'NOT_SOLVING') {
            throw new TimetableTimefoldError('Timefold timetable solve timed out', 'timeout', 504, {
                ...buildTimeoutStats({ project, problem, jobId, status, startedAt, timeout }),
            });
        }
        if (Number(status.hardScore ?? 0) < 0) {
            throw new TimetableTimefoldError('Timefold returned a hard constraint violation', 'hard_score_violation', 422, {
                jobId,
                score: status.score || null,
                hardScore: Number(status.hardScore),
                softScore: Number(status.softScore ?? 0),
                durationMs: Date.now() - startedAt,
                solverStatus: status.solverStatus || null,
                ...problemStats,
                accepted: false,
                reason: 'hard_score_violation',
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
        const schedule = transformTimetableSolutionToSchedule(project, solution, {
            ...solutionStats,
        });
        assertSolvedSchedule(schedule);
        const normalizedProject = normalizeTimetableProject(project);
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
                buildTimeoutStats({ project: normalizedProject, problem, jobId, status, startedAt, timeout }),
            );
        }
        throw error;
    } finally {
        if (jobId) {
            fetchClient(`${solverUrl}/timetable-solutions/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}
