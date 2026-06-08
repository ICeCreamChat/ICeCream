import {
    buildTimetableScore,
    createDefaultTimetableProject,
    detectScheduleConflicts,
    getActivePeriods,
    getActiveWeekdays,
    normalizeTimetableProject,
    slotKey,
} from './timetable-scheduler.js';

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
    const morningPeriods = new Set(activePeriods.slice(0, Math.max(1, Math.ceil(activePeriods.length / 2))));
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

function lockedSlotsForPlan(project, plan) {
    return (project.rules?.hardRules?.lockedSlots || [])
        .filter(slot => {
            if (slot.lessonPlanId) return slot.lessonPlanId === plan.id;
            return slot.classId === plan.classId
                && slot.subjectId === plan.subjectId
                && teacherIdsForPlan(plan).includes(slot.teacherId);
        })
        .sort((left, right) => left.day - right.day || left.period - right.period);
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
        sizes.push(2);
        remaining -= 2;
    }
    while (remaining > 0) {
        sizes.push(1);
        remaining -= 1;
    }
    return sizes;
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
        let sequence = 0;
        let blockNumber = 0;
        for (const blockSize of blockSizesForPlan(plan)) {
            blockNumber += 1;
            for (let blockIndex = 0; blockIndex < blockSize; blockIndex++) {
                const locked = lockedSlots[sequence];
                const initialSlot = initialSlots[sequence] || null;
                assignments.push(makeAssignment({
                    plan,
                    sequence,
                    blockNumber,
                    blockSize,
                    blockIndex,
                    pinnedTimeSlotId: locked ? slotKey(locked.day, locked.period) : null,
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
        locked: Boolean(assignment.pinnedTimeSlotId),
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

    return {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'timefold_solver',
        slots: slots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: slots.filter(slot => slot.locked),
        conflicts,
        unplaced,
        score,
        solverStats: {
            solverUsed: true,
            jobId: solution.jobId || stats.jobId || null,
            score: solution.score || stats.score || null,
            hardScore: Number(solution.hardScore ?? stats.hardScore ?? 0),
            softScore: Number(solution.softScore ?? stats.softScore ?? 0),
            durationMs: stats.durationMs ?? null,
            solverStatus: solution.solverStatus || stats.solverStatus || null,
        },
    };
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
    const solverUrl = normalizeSolverUrl(env);
    if (!solverUrl) {
        throw new TimetableTimefoldError('TIMEFOLD_SOLVER_URL is not configured', 'not_configured', 503);
    }
    const fetchClient = resolveFetch(fetchImpl);
    const timeout = timeoutMs(env);
    const deadline = Date.now() + timeout;
    const startedAt = Date.now();
    const problem = buildTimetableProblem(project);
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
            });
        }

        const solution = await fetchJson(fetchClient, `${solverUrl}/timetable-solutions/${encodeURIComponent(jobId)}`, {
            method: 'GET',
        }, remaining());
        const schedule = transformTimetableSolutionToSchedule(project, solution, {
            ...status,
            jobId,
            durationMs: Date.now() - startedAt,
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
                buildTimeoutStats({ project, problem, jobId, status, startedAt, timeout }),
            );
        }
        throw error;
    } finally {
        if (jobId) {
            fetchClient(`${solverUrl}/timetable-solutions/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}
