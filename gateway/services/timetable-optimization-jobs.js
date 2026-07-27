import { createTimetableStore } from './timetable-store.js';
import {
    buildTimetableSolveScaleHint,
    solveTimetableWithTimefold,
    TimetableTimefoldError,
} from './timetable-solver-bridge.js';
import { runTimetableScheduler } from './timetable-local-scheduler.js';
import { validateTimetablePublication } from './timetable-validation.js';

const jobs = new Map();
let sequence = 0;
const MAX_RETAINED_JOBS = 40;
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000;

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
        mode: job.mode,
        sourceScheduleId: job.sourceScheduleId,
        sourceProjectVersion: job.sourceProjectVersion,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        solverStats: job.solverStats || null,
        reused: Boolean(job.reused),
    };
}

function activeJobKey({ project = {}, schedule = null, mode = 'optimize' } = {}) {
    return [
        project?.version ?? '',
        scheduleSignature(schedule),
        mode,
    ].join('|');
}

function pruneJobs() {
    const now = Date.now();
    for (const [jobId, job] of jobs) {
        if (['queued', 'running'].includes(job.status)) continue;
        const updatedAt = Date.parse(job.updatedAt || job.createdAt || '') || 0;
        if (now - updatedAt > COMPLETED_JOB_TTL_MS) jobs.delete(jobId);
    }
    if (jobs.size <= MAX_RETAINED_JOBS) return;
    const removable = [...jobs.values()]
        .filter(job => !['queued', 'running'].includes(job.status))
        .sort((left, right) => Date.parse(left.updatedAt || '') - Date.parse(right.updatedAt || ''));
    while (jobs.size > MAX_RETAINED_JOBS && removable.length) {
        jobs.delete(removable.shift().jobId);
    }
}

function activeJobForKey(key) {
    return [...jobs.values()].find(job => (
        job.activeKey === key
        && ['queued', 'running'].includes(job.status)
    )) || null;
}

function fastAttemptStats(result = null) {
    const schedule = result?.schedule || result?.project?.schedule || null;
    if (!schedule) return null;
    return {
        score: schedule.score || null,
        placedLessons: Number(schedule.score?.placedLessons || schedule.slots?.length || 0),
        totalLessons: Number(schedule.score?.totalLessons || 0),
        unplacedLessons: Number(schedule.score?.unplacedLessons || schedule.unplaced?.length || 0),
        hardConflicts: Number(schedule.score?.hardConflicts || 0),
        solveMs: Number(schedule.solverStats?.solveMs || 0) || null,
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
    const score = schedule?.score || {};
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

function canAcceptOptimizedSchedule(currentSchedule, optimizedSchedule, { replace = false } = {}) {
    if (!optimizedSchedule) return false;
    if (optimizedSchedule.score?.hardConflicts > 0) return false;
    if (optimizedSchedule.score?.unplacedLessons > 0) return false;
    if (optimizedSchedule.score?.placedLessons < optimizedSchedule.score?.totalLessons) return false;
    if (optimizedSchedule.publication?.ok !== true) return false;
    return replace || scheduleQuality(optimizedSchedule) > scheduleQuality(currentSchedule);
}

function acceptedOptimizedSchedule(latestProject, optimizedSchedule) {
    const latestSchedule = latestProject?.schedule || {};
    const qualityScoreBefore = scheduleQuality(latestSchedule);
    const qualityScoreAfter = scheduleQuality(optimizedSchedule);
    const restoredPublishedDraft = latestSchedule.source === 'published_history_restored'
        || latestSchedule.solverStats?.phase === 'published_history_restore'
        || Boolean(latestSchedule.solverStats?.restoredPublishedDraft);
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
            ...(latestSchedule.solverStats?.phase === 'published_history_restore'
                ? {
                    restoredVersion: latestSchedule.solverStats.restoredVersion ?? null,
                    restoredScheduleId: latestSchedule.solverStats.restoredScheduleId ?? null,
                }
                : {}),
            ...(optimizedSchedule.solverStats || {}),
            phase: 'timefold_optimization',
            status: 'completed',
            accepted: true,
            reason: null,
            qualityScoreBefore,
            qualityScoreAfter,
            ...(restoredPublishedDraft ? { restoredPublishedDraft: true } : {}),
        },
    };
    return {
        ...schedule,
        publication: validateTimetablePublication({ ...latestProject, schedule }),
    };
}

function preservedCurrentSchedule(latestProject, solverStatsPatch = {}) {
    const latestSchedule = latestProject?.schedule || null;
    if (!latestSchedule) return null;
    const schedule = {
        ...latestSchedule,
        solverStats: {
            ...(latestSchedule.solverStats || {}),
            ...solverStatsPatch,
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
    mode,
    sourceScheduleId,
    sourceScheduleSignature,
    sourceProjectVersion,
    fastAttempt,
    store,
    env,
    fetchImpl,
    scheduler,
}) {
    const startedAt = Date.now();
    let effectiveFastAttempt = fastAttempt || null;
    updateJob(jobId, {
        status: 'running',
        solverStats: {
            phase: 'timefold_optimization',
            stage: mode === 'solve' && !fastAttempt ? 'fast_construct' : 'timefold_submit',
            status: 'running',
            jobId,
            mode,
            lessonCount: project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0),
            initialSolutionUsed: Boolean(project.schedule?.slots?.length),
            elapsedMs: 0,
            ...buildTimetableSolveScaleHint(project, env),
        },
    });

    try {
        if (mode === 'solve' && !effectiveFastAttempt) {
            effectiveFastAttempt = scheduler(project);
        }
        const fastStats = fastAttemptStats(effectiveFastAttempt);
        if (fastStats) {
            const current = jobs.get(jobId);
            updateJob(jobId, {
                solverStats: {
                    ...(current?.solverStats || {}),
                    stage: 'timefold_submit',
                    elapsedMs: Date.now() - startedAt,
                    fastAttempt: fastStats,
                },
            });
        }
        const solved = await solveTimetableWithTimefold({
            project,
            env,
            fetchImpl,
            fastAttempt: effectiveFastAttempt,
            runFastAttempt: false,
            onProgress: progress => {
                const current = jobs.get(jobId);
                if (!current || !['queued', 'running'].includes(current.status)) return;
                updateJob(jobId, {
                    solverStats: {
                        ...(current.solverStats || {}),
                        ...progress,
                        ...(fastStats ? { fastAttempt: fastStats } : {}),
                    },
                });
            },
        });
        const latest = await store.loadProject();
        if (latest.schedule?.published?.status === 'published' && mode !== 'solve') {
            const rejectedStats = {
                ...(latest.schedule?.solverStats || {}),
                ...solved.schedule.solverStats,
                phase: 'timefold_optimization',
                status: 'skipped',
                accepted: false,
                reason: 'published_schedule',
                staleRejected: true,
                qualityScoreBefore: scheduleQuality(project.schedule),
                qualityScoreAfter: scheduleQuality(solved.schedule),
            };
            await store.saveProject({
                ...latest,
                schedule: preservedCurrentSchedule(latest, rejectedStats),
            });
            updateJob(jobId, {
                status: 'skipped',
                accepted: false,
                reason: 'published_schedule',
                solverStats: rejectedStats,
            });
            return;
        }
        if (
            (sourceProjectVersion !== null && sourceProjectVersion !== undefined && latest.version !== sourceProjectVersion)
            || (latest.schedule?.id || null) !== sourceScheduleId
            || scheduleSignature(latest.schedule) !== sourceScheduleSignature
        ) {
            const rejectedStats = {
                ...(latest.schedule?.solverStats || {}),
                ...solved.schedule.solverStats,
                phase: 'timefold_optimization',
                status: 'skipped',
                accepted: false,
                reason: 'stale_schedule',
                staleRejected: true,
                qualityScoreBefore: scheduleQuality(project.schedule),
                qualityScoreAfter: scheduleQuality(solved.schedule),
            };
            await store.saveProject({
                ...latest,
                schedule: preservedCurrentSchedule(latest, rejectedStats),
            });
            updateJob(jobId, {
                status: 'skipped',
                accepted: false,
                reason: 'stale_schedule',
                solverStats: rejectedStats,
            });
            return;
        }

        if (!canAcceptOptimizedSchedule(latest.schedule, solved.schedule, { replace: mode === 'solve' })) {
            const rejectedStats = {
                ...(latest.schedule?.solverStats || {}),
                ...solved.schedule.solverStats,
                phase: 'timefold_optimization',
                status: 'completed',
                accepted: false,
                reason: 'not_better',
                qualityScoreBefore: scheduleQuality(latest.schedule),
                qualityScoreAfter: scheduleQuality(solved.schedule),
            };
            const savedCurrent = await store.saveProject({
                ...latest,
                schedule: preservedCurrentSchedule(latest, rejectedStats),
            });
            updateJob(jobId, {
                status: 'completed',
                accepted: false,
                reason: 'not_better',
                solverStats: savedCurrent.schedule.solverStats,
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
        const latest = await store.loadProject();
        const latestSignature = scheduleSignature(latest.schedule);
        const publishedChanged = latest.schedule?.published?.status === 'published';
        const staleChanged = (sourceProjectVersion !== null && sourceProjectVersion !== undefined && latest.version !== sourceProjectVersion)
            || (latest.schedule?.id || null) !== sourceScheduleId
            || latestSignature !== sourceScheduleSignature;
        if ((publishedChanged && mode !== 'solve') || staleChanged) {
            const rejectedReason = publishedChanged ? 'published_schedule' : 'stale_schedule';
            const rejectedStats = {
                ...(latest.schedule?.solverStats || {}),
                ...(error.solverStats || {}),
                phase: 'timefold_optimization',
                status: 'skipped',
                accepted: false,
                reason: rejectedReason,
                staleRejected: true,
            };
            updateJob(jobId, {
                status: 'skipped',
                accepted: false,
                reason: rejectedReason,
                solverStats: rejectedStats,
            });
            return;
        }
        const failedStats = {
            ...(latest.schedule?.solverStats || {}),
            ...(error.solverStats || {}),
            phase: 'timefold_optimization',
            status: 'failed',
            accepted: false,
            reason,
            elapsedMs: Date.now() - startedAt,
            ...(fastAttemptStats(effectiveFastAttempt) ? { fastAttempt: fastAttemptStats(effectiveFastAttempt) } : {}),
        };
        if (latest.schedule) {
            await store.saveProject({
                ...latest,
                schedule: preservedCurrentSchedule(latest, failedStats),
            });
        }
        updateJob(jobId, {
            status: 'failed',
            accepted: false,
            reason,
            solverStats: failedStats,
        });
    }
}

export function createTimetableOptimizationJob({
    project,
    schedule = project?.schedule || null,
    mode = 'optimize',
    fastAttempt = null,
    store = createTimetableStore(),
    env = process.env,
    fetchImpl,
    scheduler = runTimetableScheduler,
} = {}) {
    pruneJobs();
    const key = activeJobKey({ project, schedule, mode });
    const existing = activeJobForKey(key);
    if (existing) {
        return { ...publicJob(existing), reused: true };
    }
    sequence += 1;
    const jobId = `tt-opt-${Date.now()}-${sequence}`;
    const job = {
        jobId,
        phase: 'timefold_optimization',
        status: 'queued',
        accepted: false,
        reason: null,
        reused: false,
        mode,
        activeKey: key,
        fastAttempt,
        sourceScheduleId: schedule?.id || null,
        sourceProjectVersion: project?.version ?? null,
        sourceScheduleSignature: scheduleSignature(schedule),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        solverStats: {
            phase: 'timefold_optimization',
            status: 'queued',
            jobId,
            mode,
            lessonCount: project?.lessonPlans?.reduce((sum, plan) => sum + plan.weeklyHours, 0) || 0,
            initialSolutionUsed: Boolean(project?.schedule?.slots?.length),
            pinnedCount: (schedule?.slots || []).filter(slot => slot.locked || slot.manuallyAdjusted).length,
            ...buildTimetableSolveScaleHint(project || {}, env),
            ...(fastAttemptStats(fastAttempt) ? { fastAttempt: fastAttemptStats(fastAttempt) } : {}),
        },
    };
    jobs.set(jobId, job);
    setTimeout(() => {
        runOptimizationJob({
            jobId,
            project,
            mode: job.mode,
            sourceScheduleId: job.sourceScheduleId,
            sourceScheduleSignature: job.sourceScheduleSignature,
            sourceProjectVersion: job.sourceProjectVersion,
            fastAttempt: job.fastAttempt,
            store,
            env: { ...env },
            fetchImpl,
            scheduler,
        });
    }, 0);
    return publicJob(job);
}

export function getTimetableOptimizationJob(jobId) {
    pruneJobs();
    return publicJob(jobs.get(jobId));
}

export function resetTimetableOptimizationJobs() {
    jobs.clear();
    sequence = 0;
}
