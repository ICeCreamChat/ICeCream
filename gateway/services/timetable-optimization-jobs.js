import { createTimetableStore } from './timetable-store.js';
import {
    solveTimetableWithTimefold,
    TimetableTimefoldError,
} from './timetable-solver-bridge.js';
import { validateTimetablePublication } from './timetable-validation.js';

const jobs = new Map();
let sequence = 0;

function nowIso() {
    return new Date().toISOString();
}

function publicJob(job) {
    if (!job) return null;
    return {
        jobId: job.jobId,
        phase: job.phase,
        status: job.status,
        accepted: job.accepted,
        reason: job.reason,
        sourceScheduleId: job.sourceScheduleId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        solverStats: job.solverStats || null,
    };
}

function updateJob(jobId, patch) {
    const current = jobs.get(jobId);
    if (!current) return null;
    const next = {
        ...current,
        ...patch,
        updatedAt: nowIso(),
    };
    jobs.set(jobId, next);
    return next;
}

function scheduleQuality(schedule = {}) {
    const score = schedule.score || {};
    return Number(score.softScore || 0)
        + Number(score.completeness || 0)
        - Number(score.hardConflicts || 0) * 1000
        - Number(score.unplacedLessons || 0) * 1000;
}

function slotSignature(slot = {}) {
    return [
        slot.id,
        slot.lessonPlanId,
        slot.classId,
        slot.subjectId,
        slot.teacherId,
        (slot.teacherIds || []).join(','),
        slot.day,
        slot.period,
        slot.roomId || '',
        slot.blockId || '',
        slot.blockIndex ?? 0,
        slot.blockSize ?? 1,
        slot.locked ? 1 : 0,
        slot.manuallyAdjusted ? 1 : 0,
    ].map(value => String(value ?? '')).join('|');
}

function scheduleSignature(schedule = null) {
    if (!schedule) return '';
    const slots = (schedule.slots || [])
        .map(slotSignature)
        .sort();
    const unplaced = (schedule.unplaced || [])
        .map(item => [
            item.lessonPlanId,
            item.classId,
            item.subjectId,
            item.teacherId,
            item.reason,
        ].map(value => String(value ?? '')).join('|'))
        .sort();
    return JSON.stringify({
        id: schedule.id || '',
        source: schedule.source || '',
        slots,
        unplaced,
    });
}

function canAcceptOptimizedSchedule(currentSchedule, optimizedSchedule) {
    if (!optimizedSchedule) return false;
    if (optimizedSchedule.score?.hardConflicts > 0) return false;
    if (optimizedSchedule.score?.unplacedLessons > 0) return false;
    if (optimizedSchedule.score?.placedLessons < optimizedSchedule.score?.totalLessons) return false;
    return scheduleQuality(optimizedSchedule) > scheduleQuality(currentSchedule);
}

function acceptedOptimizedSchedule(latestProject, optimizedSchedule) {
    const latestSchedule = latestProject?.schedule || {};
    const qualityScoreBefore = scheduleQuality(latestSchedule);
    const qualityScoreAfter = scheduleQuality(optimizedSchedule);
    const published = latestSchedule.published
        ? {
            ...latestSchedule.published,
            status: latestSchedule.published.status === 'published' ? 'draft_changed' : latestSchedule.published.status,
        }
        : optimizedSchedule.published || null;
    const schedule = {
        ...optimizedSchedule,
        ...(published ? { published } : { published: null }),
        solverStats: {
            ...(optimizedSchedule.solverStats || {}),
            phase: 'timefold_optimization',
            status: 'completed',
            accepted: true,
            reason: null,
            qualityScoreBefore,
            qualityScoreAfter,
        },
    };
    return {
        ...schedule,
        publication: validateTimetablePublication({ ...latestProject, schedule }),
    };
}

async function runOptimizationJob({
    jobId,
    project,
    sourceScheduleId,
    sourceScheduleSignature,
    store,
    env,
    fetchImpl,
}) {
    updateJob(jobId, {
        status: 'running',
        solverStats: {
            phase: 'timefold_optimization',
            status: 'running',
            jobId,
            lessonCount: project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0),
        },
    });

    try {
        const solved = await solveTimetableWithTimefold({ project, env, fetchImpl });
        const latest = await store.loadProject();
        if (latest.schedule?.published?.status === 'published') {
            updateJob(jobId, {
                status: 'skipped',
                accepted: false,
                reason: 'published_schedule',
                solverStats: {
                    ...solved.schedule.solverStats,
                    phase: 'timefold_optimization',
                    status: 'skipped',
                    accepted: false,
                    reason: 'published_schedule',
                    staleRejected: true,
                    qualityScoreBefore: scheduleQuality(project.schedule),
                    qualityScoreAfter: scheduleQuality(solved.schedule),
                },
            });
            return;
        }
        if (latest.schedule?.id !== sourceScheduleId || scheduleSignature(latest.schedule) !== sourceScheduleSignature) {
            updateJob(jobId, {
                status: 'skipped',
                accepted: false,
                reason: 'stale_schedule',
                solverStats: {
                    ...solved.schedule.solverStats,
                    phase: 'timefold_optimization',
                    status: 'skipped',
                    accepted: false,
                    reason: 'stale_schedule',
                    staleRejected: true,
                    qualityScoreBefore: scheduleQuality(project.schedule),
                    qualityScoreAfter: scheduleQuality(solved.schedule),
                },
            });
            return;
        }

        if (!canAcceptOptimizedSchedule(latest.schedule, solved.schedule)) {
            updateJob(jobId, {
                status: 'completed',
                accepted: false,
                reason: 'not_better',
                solverStats: {
                    ...solved.schedule.solverStats,
                    phase: 'timefold_optimization',
                    status: 'completed',
                    accepted: false,
                    reason: 'not_better',
                    qualityScoreBefore: scheduleQuality(latest.schedule),
                    qualityScoreAfter: scheduleQuality(solved.schedule),
                },
            });
            return;
        }

        const acceptedSchedule = acceptedOptimizedSchedule(latest, solved.schedule);
        const saved = await store.saveProject({ ...latest, schedule: acceptedSchedule });
        updateJob(jobId, {
            status: 'completed',
            accepted: true,
            reason: null,
            solverStats: {
                ...saved.schedule.solverStats,
                phase: 'timefold_optimization',
                status: 'completed',
                accepted: true,
                reason: null,
                qualityScoreBefore: scheduleQuality(latest.schedule),
                qualityScoreAfter: scheduleQuality(saved.schedule),
            },
        });
    } catch (error) {
        const reason = error instanceof TimetableTimefoldError ? error.reason : 'failed';
        updateJob(jobId, {
            status: 'failed',
            accepted: false,
            reason,
            solverStats: {
                ...(error.solverStats || {}),
                phase: 'timefold_optimization',
                status: 'failed',
                accepted: false,
                reason,
            },
        });
    }
}

export function createTimetableOptimizationJob({
    project,
    schedule = project?.schedule || null,
    store = createTimetableStore(),
    env = process.env,
    fetchImpl,
} = {}) {
    sequence += 1;
    const jobId = `tt-opt-${Date.now()}-${sequence}`;
    const job = {
        jobId,
        phase: 'timefold_optimization',
        status: 'queued',
        accepted: false,
        reason: null,
        sourceScheduleId: schedule?.id || null,
        sourceScheduleSignature: scheduleSignature(schedule),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        solverStats: {
            phase: 'timefold_optimization',
            status: 'queued',
            jobId,
            lessonCount: project?.lessonPlans?.reduce((sum, plan) => sum + plan.weeklyHours, 0) || 0,
            initialSolutionUsed: Boolean(schedule?.slots?.length),
            pinnedCount: (schedule?.slots || []).filter(slot => slot.locked || slot.manuallyAdjusted).length,
        },
    };
    jobs.set(jobId, job);
    setTimeout(() => {
        runOptimizationJob({
            jobId,
            project,
            sourceScheduleId: job.sourceScheduleId,
            sourceScheduleSignature: job.sourceScheduleSignature,
            store,
            env: { ...env },
            fetchImpl,
        });
    }, 0);
    return publicJob(job);
}

export function getTimetableOptimizationJob(jobId) {
    return publicJob(jobs.get(jobId));
}

export function resetTimetableOptimizationJobs() {
    jobs.clear();
    sequence = 0;
}
