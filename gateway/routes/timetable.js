import express from 'express';
import multer from 'multer';

import { buildTimetableExportXlsx, TIMETABLE_XLSX_MIME } from '../services/timetable-export.js';
import {
    buildTimetableRosterFromRows,
    parseRosterAiOrLocal,
    parseTimetableRosterFile,
    parseTimetableRosterText,
    previewTimetableRosterFile,
    previewTimetableRosterText,
} from '../services/timetable-import.js';
import { createTimetableStore } from '../services/timetable-store.js';
import {
    applyScheduleAdjustment,
    auditTimetableProject,
    createDefaultTimetableProject,
    normalizeTimetableProject,
    runTimetableScheduler,
    validateTimetableProjectForSolve,
    validateTimetablePublication,
} from '../services/timetable-scheduler.js';
import {
    continueTimetableRuleConversation,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
    TimetableRuleParseError,
} from '../services/timetable-rule-parser.js';
import {
    createTimetableOptimizationJob,
    getTimetableOptimizationJob,
} from '../services/timetable-optimization-jobs.js';
import {
    buildPublishedSnapshot,
    findPublishedHistoryEntry,
    nextPublishedHistory,
    nextPublishVersion,
    publicationEntryWithVerifiedFingerprint,
    PUBLICATION_FINGERPRINT_MISMATCH,
    PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE,
    resolvePublishedRestoreEntry,
    verifyPublishedSnapshotFingerprint,
} from '../services/timetable-publication.js';
import { validationService, ValidationErrorCodes } from '../services/timetable-validation-service.js';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

function store() {
    return createTimetableStore();
}

function ok(res, data) {
    return res.json({ success: true, data });
}

function fail(res, error, status = 400, data = undefined) {
    return res.status(status).json({
        success: false,
        error: error.message || String(error),
        ...(data === undefined ? {} : { data }),
    });
}

function hasTimefoldSolverConfigured(env = process.env) {
    return Boolean(String(env.TIMEFOLD_SOLVER_URL || '').trim());
}

function sameNumberList(left = [], right = []) {
    return Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((value, index) => Number(value) === Number(right[index]));
}

function canonicalPeriodTimes(times = []) {
    return (Array.isArray(times) ? times : [])
        .map(item => ({
            period: Number(item.period || 0),
            start: String(item.start || ''),
            end: String(item.end || ''),
        }))
        .sort((left, right) => left.period - right.period);
}

function samePeriodTimes(left = [], right = []) {
    const leftTimes = canonicalPeriodTimes(left);
    const rightTimes = canonicalPeriodTimes(right);
    return leftTimes.length === rightTimes.length
        && leftTimes.every((item, index) => {
            const other = rightTimes[index];
            return item.period === other.period && item.start === other.start && item.end === other.end;
        });
}

function canonicalDayPartBoundaries(value = {}) {
    const afternoonRaw = value?.afternoonStartPeriod;
    const eveningRaw = value?.eveningStartPeriod;
    const afternoonStartPeriod = afternoonRaw === undefined || afternoonRaw === null || String(afternoonRaw).trim() === ''
        ? null
        : Number.isInteger(Number(afternoonRaw))
            ? Number(afternoonRaw)
            : null;
    const eveningStartPeriod = eveningRaw === undefined || eveningRaw === null || String(eveningRaw).trim() === ''
        ? null
        : Number.isInteger(Number(eveningRaw))
            ? Number(eveningRaw)
            : null;
    return {
        afternoonStartPeriod,
        eveningStartPeriod,
    };
}

function sameDayPartBoundaries(left = {}, right = {}) {
    const leftBoundaries = canonicalDayPartBoundaries(left);
    const rightBoundaries = canonicalDayPartBoundaries(right);
    return leftBoundaries.afternoonStartPeriod === rightBoundaries.afternoonStartPeriod
        && leftBoundaries.eveningStartPeriod === rightBoundaries.eveningStartPeriod;
}

function preservePublishedArchive(nextSchedule, currentSchedule) {
    const published = currentSchedule?.published || null;
    if (!published) return nextSchedule;
    return {
        id: nextSchedule?.id || currentSchedule?.id || `schedule_cleared_${Date.now()}`,
        generatedAt: nextSchedule?.generatedAt || new Date().toISOString(),
        source: nextSchedule?.source || currentSchedule?.source || null,
        slots: Array.isArray(nextSchedule?.slots) ? nextSchedule.slots : [],
        lockedSlots: Array.isArray(nextSchedule?.lockedSlots) ? nextSchedule.lockedSlots : [],
        conflicts: Array.isArray(nextSchedule?.conflicts) ? nextSchedule.conflicts : [],
        unplaced: Array.isArray(nextSchedule?.unplaced) ? nextSchedule.unplaced : [],
        audit: nextSchedule?.audit || null,
        qualityIssues: Array.isArray(nextSchedule?.qualityIssues) ? nextSchedule.qualityIssues : [],
        publication: nextSchedule?.publication || null,
        score: nextSchedule?.score || {},
        solverStats: nextSchedule?.solverStats || null,
        published: {
            ...published,
            status: 'draft_changed',
        },
    };
}

function scheduleFromPublishedSnapshot(current = {}, entry = {}) {
    const snapshot = entry.snapshot || {};
    const context = snapshot.projectContext || {};
    const now = new Date().toISOString();
    const slots = (snapshot.slots || []).map((slot, index) => ({
        id: slot.id || `restored_${entry.version || 'history'}_${index + 1}`,
        day: slot.day,
        period: slot.period,
        classId: slot.classId,
        subjectId: slot.subjectId,
        teacherId: slot.teacherId,
        teacherIds: slot.teacherIds || [],
        lessonPlanId: slot.lessonPlanId,
        roomId: slot.roomId || null,
        blockId: slot.blockId || null,
        blockIndex: slot.blockIndex || 0,
        blockSize: slot.blockSize || 1,
        locked: Boolean(slot.locked),
        manuallyAdjusted: Boolean(slot.manuallyAdjusted),
    }));
    return {
        ...current.schedule,
        id: `schedule_restored_${entry.version || 'history'}_${Date.now()}`,
        generatedAt: now,
        source: 'published_history_restored',
        slots,
        lockedSlots: slots.filter(slot => slot.locked),
        conflicts: [],
        unplaced: [],
        audit: null,
        qualityIssues: [],
        score: snapshot.score || {},
        solverStats: {
            phase: 'published_history_restore',
            status: 'restored',
            strategy: 'published_history_restore',
            accepted: true,
            reason: null,
            restoredVersion: Number.parseInt(entry.version, 10) || null,
            restoredScheduleId: entry.scheduleId || snapshot.scheduleId || null,
        },
        published: mergeBackfilledPublishedEntry(current.schedule?.published, entry),
    };
}

function mergeBackfilledPublishedEntry(published = null, entry = {}) {
    if (!published) return null;
    const entryVersion = Number.parseInt(entry.version, 10);
    const currentVersion = Number.parseInt(published.version, 10);
    const history = Array.isArray(published.history)
        ? published.history.map(item => (
            Number.parseInt(item.version, 10) === entryVersion
                ? { ...item, ...entry }
                : item
        ))
        : [];
    const currentPatch = Number.isInteger(entryVersion) && entryVersion === currentVersion
        ? {
            fingerprint: entry.fingerprint || entry.snapshot?.fingerprint || published.fingerprint || '',
            snapshot: entry.snapshot || published.snapshot,
        }
        : {};
    return {
        ...published,
        ...currentPatch,
        ...(history.length ? { history } : {}),
        status: 'draft_changed',
    };
}

function publishedEntryBackfilledForExport(published = null, entry = {}) {
    if (!published) return null;
    const entryVersion = Number.parseInt(entry.version, 10);
    const currentVersion = Number.parseInt(published.version, 10);
    const history = Array.isArray(published.history)
        ? published.history.map(item => (
            Number.parseInt(item.version, 10) === entryVersion
                ? { ...item, ...entry }
                : item
        ))
        : [];
    const currentPatch = Number.isInteger(entryVersion) && entryVersion === currentVersion
        ? {
            fingerprint: entry.fingerprint || entry.snapshot?.fingerprint || published.fingerprint || '',
            snapshot: entry.snapshot || published.snapshot,
        }
        : {};
    return {
        ...published,
        ...currentPatch,
        ...(history.length ? { history } : {}),
    };
}

function canonicalPublishedSlot(slot = {}) {
    return JSON.stringify({
        id: slot.id || '',
        day: Number(slot.day || 0),
        period: Number(slot.period || 0),
        classId: slot.classId || '',
        subjectId: slot.subjectId || '',
        teacherId: slot.teacherId || '',
        teacherIds: [...new Set([...(slot.teacherIds || []), slot.teacherId].filter(Boolean))].sort(),
        lessonPlanId: slot.lessonPlanId || '',
        roomId: slot.roomId || '',
        blockId: slot.blockId || '',
        blockIndex: Number(slot.blockIndex || 0),
        blockSize: Number(slot.blockSize || 1),
        locked: Boolean(slot.locked),
        manuallyAdjusted: Boolean(slot.manuallyAdjusted),
    });
}

function scheduleDiffersFromPublishedSnapshot(schedule = {}, project = {}) {
    const published = schedule?.published || null;
    const snapshotSlots = published?.snapshot?.slots || [];
    const currentSlots = schedule?.slots || [];
    if (published?.status !== 'published' || !snapshotSlots.length) return false;
    if (published.snapshot?.projectContext?.periodTimes && !samePeriodTimes(published.snapshot.projectContext.periodTimes, project.periodTimes || [])) {
        return true;
    }
    if (!sameDayPartBoundaries(published.snapshot?.projectContext?.dayPartBoundaries, project.dayPartBoundaries)) {
        return true;
    }
    if (snapshotSlots.length !== currentSlots.length) return true;
    const snapshotKeys = snapshotSlots.map(canonicalPublishedSlot).sort();
    const currentKeys = currentSlots.map(canonicalPublishedSlot).sort();
    return snapshotKeys.some((key, index) => key !== currentKeys[index]);
}

function projectMarkedDraftChanged(project = {}) {
    return normalizeTimetableProject({
        ...project,
        schedule: project.schedule
            ? {
                ...project.schedule,
                published: {
                    ...project.schedule.published,
                    status: 'draft_changed',
                },
            }
            : project.schedule,
    });
}

function splitExportType(type = 'class') {
    const value = String(type || 'class');
    if (value.startsWith('published_')) {
        return {
            type: value.slice('published_'.length) || 'class',
            published: true,
        };
    }
    return { type: value, published: false };
}

function projectWithPublishedSnapshot(project = {}, version = null) {
    const selectedEntry = publicationEntryWithVerifiedFingerprint(resolvePublishedRestoreEntry(project.schedule?.published, version));
    const historyEntry = version ? selectedEntry : null;
    const snapshot = selectedEntry?.snapshot || project.schedule?.published?.snapshot;
    if (!snapshot?.slots?.length) return null;
    const context = snapshot.projectContext || {};
    const projectedPublished = selectedEntry
        ? {
            ...(project.schedule?.published || {}),
            status: 'published',
            version: Number.parseInt(selectedEntry.version, 10) || selectedEntry.version || project.schedule?.published?.version,
            publishedAt: selectedEntry.publishedAt || project.schedule?.published?.publishedAt || null,
            scheduleId: selectedEntry.scheduleId || snapshot.scheduleId || project.schedule?.published?.scheduleId || null,
            note: selectedEntry.note || '',
            fingerprint: selectedEntry.fingerprint || snapshot.fingerprint || '',
            snapshot,
        }
        : project.schedule?.published
            ? { ...project.schedule.published, status: 'published', fingerprint: project.schedule.published.fingerprint || snapshot.fingerprint || '' }
            : null;
    return normalizeTimetableProject({
        ...project,
        ...(context.schoolName ? { schoolName: context.schoolName } : {}),
        ...(context.term ? { term: context.term } : {}),
        ...(context.activeWeekdays?.length ? { activeWeekdays: context.activeWeekdays } : {}),
        ...(context.activePeriods?.length ? { activePeriods: context.activePeriods } : {}),
        ...(Object.prototype.hasOwnProperty.call(context, 'dayPartBoundaries') ? { dayPartBoundaries: context.dayPartBoundaries } : {}),
        ...(Array.isArray(context.periodTimes) ? { periodTimes: context.periodTimes } : {}),
        ...(Array.isArray(context.teachers) ? { teachers: context.teachers } : {}),
        ...(Array.isArray(context.classes) ? { classes: context.classes } : {}),
        ...(Array.isArray(context.subjects) ? { subjects: context.subjects } : {}),
        ...(Array.isArray(context.lessonPlans) ? { lessonPlans: context.lessonPlans } : {}),
        ...(context.rules ? { rules: context.rules } : {}),
        schedule: {
            ...project.schedule,
            id: snapshot.scheduleId || project.schedule.id,
            generatedAt: snapshot.generatedAt || project.schedule.generatedAt,
            source: historyEntry ? 'published_history_snapshot' : 'published_snapshot',
            slots: snapshot.slots,
            lockedSlots: snapshot.slots.filter(slot => slot.locked),
            conflicts: [],
            unplaced: [],
            score: snapshot.score || {},
            publication: {
                ok: true,
                reason: historyEntry ? 'published_history_snapshot' : 'published_snapshot',
                summary: snapshot.publicationSummary || {},
                blockingIssues: [],
                warnings: [],
                issueEntries: [],
                reviewItems: [],
            },
            published: projectedPublished,
        },
    });
}

function failPublicationFingerprintMismatch(res, current, verification) {
    return fail(res, new Error(PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE), 409, {
        project: current,
        schedule: current?.schedule || null,
        reason: PUBLICATION_FINGERPRINT_MISMATCH,
        fingerprint: {
            expected: verification.expected || '',
            actual: verification.actual || '',
        },
    });
}

router.get('/bootstrap', async (req, res) => {
    try {
        const project = await store().loadProject();
        ok(res, { project });
    } catch (error) {
        fail(res, error, 500);
    }
});

router.post('/project', async (req, res) => {
    try {
        const current = await store().loadProject();

        // 版本冲突检查 - 防止并发修改
        const versionCheck = validationService.checkVersionConflict(req.body, current);
        if (versionCheck.hasConflict) {
            return fail(res, versionCheck.error, 409, {
                reason: ValidationErrorCodes.VERSION_CONFLICT,
                currentProject: current,
                incomingVersion: req.body.version,
                currentVersion: current.version,
            });
        }

        let project = normalizeTimetableProject({
            ...current,
            ...req.body,
            rules: req.body.rules || current.rules,
            schedule: req.body.schedule === undefined ? current.schedule : req.body.schedule,
            version: Date.now(), // 生成新版本号
        });
        if (
            !sameNumberList(current.activeWeekdays, project.activeWeekdays)
            || !sameNumberList(current.activePeriods, project.activePeriods)
        ) {
            project = normalizeTimetableProject({
                ...project,
                schedule: preservePublishedArchive(null, current.schedule),
            });
        } else if (
            (
                (Object.prototype.hasOwnProperty.call(req.body || {}, 'periodTimes')
                    && !samePeriodTimes(current.periodTimes, project.periodTimes))
                || (Object.prototype.hasOwnProperty.call(req.body || {}, 'dayPartBoundaries')
                    && !sameDayPartBoundaries(current.dayPartBoundaries, project.dayPartBoundaries))
            )
            && project.schedule?.published?.status === 'published'
        ) {
            project = normalizeTimetableProject({
                ...project,
                schedule: preservePublishedArchive(project.schedule, current.schedule),
            });
        }
        const saved = await store().saveProject(project);
        ok(res, { project: saved });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/roster/clear', async (req, res) => {
    try {
        const current = await store().loadProject();
        const defaults = createDefaultTimetableProject({
            activeWeekdays: current.activeWeekdays,
            activePeriods: current.activePeriods,
        });
        const project = normalizeTimetableProject({
            ...current,
            teachers: [],
            classes: [],
            subjects: [],
            lessonPlans: [],
            rules: defaults.rules,
            schedule: preservePublishedArchive(null, current.schedule),
        });
        const saved = await store().saveProject(project);
        ok(res, { project: saved });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/roster/preview', upload.single('file'), async (req, res) => {
    try {
        const current = await store().loadProject();
        const useAi = req.body?.ai !== 'false' && req.body?.ai !== false;
        if (useAi) {
            const preview = await parseRosterAiOrLocal({
                text: req.body?.text || '',
                file: req.file ? { buffer: req.file.buffer, filename: req.file.originalname } : null,
                project: current,
                env: process.env,
            });
            ok(res, preview);
        } else {
            const preview = req.file
                ? previewTimetableRosterFile({ buffer: req.file.buffer, filename: req.file.originalname }, { project: current })
                : previewTimetableRosterText(req.body?.text || '', { project: current });
            ok(res, preview);
        }
    } catch (error) {
        fail(res, error);
    }
});

router.post('/roster/import', upload.single('file'), async (req, res) => {
    try {
        const current = await store().loadProject();
        const parsed = Array.isArray(req.body?.rows)
            ? buildTimetableRosterFromRows(req.body.rows, { project: current })
            : req.file
                ? parseTimetableRosterFile({ buffer: req.file.buffer, filename: req.file.originalname }, { project: current })
                : parseTimetableRosterText(req.body?.text || '', { project: current });
        const project = normalizeTimetableProject({
            ...current,
            teachers: parsed.teachers,
            classes: parsed.classes,
            subjects: parsed.subjects,
            lessonPlans: parsed.lessonPlans,
            schedule: preservePublishedArchive(null, current.schedule),
        });
        const saved = await store().saveProject(project);
        ok(res, { project: saved, import: parsed });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/rules', async (req, res) => {
    try {
        const current = await store().loadProject();
        const project = normalizeTimetableProject({
            ...current,
            rules: req.body?.rules || req.body || current.rules,
            schedule: preservePublishedArchive(null, current.schedule),
        });
        const saved = await store().saveProject(project);
        ok(res, { project: saved });
    } catch (error) {
        fail(res, error);
    }
});

async function handleRulesParse(req, res) {
    let current = null;
    try {
        current = await store().loadProject();
        const parsed = await parseTimetableRules({
            text: req.body?.text || '',
            file: req.file ? { buffer: req.file.buffer, filename: req.file.originalname } : null,
            project: current,
        });
        ok(res, parsed);
    } catch (error) {
        const status = error instanceof TimetableRuleParseError ? error.status : 500;
        fail(res, error, status, {
            project: current,
            reason: error.reason || 'rules_parse_failed',
        });
    }
}

router.post('/rules/parse', upload.single('file'), handleRulesParse);
router.post('/rule-review/parse', upload.single('file'), handleRulesParse);

router.post('/rules/normalize', async (req, res) => {
    let current = null;
    try {
        current = await store().loadProject();
        const normalized = normalizeTimetableRuleDraftRows({
            project: current,
            draftRows: req.body?.draftRows || req.body?.rows || [],
            source: req.body?.source || 'review',
            inputType: req.body?.inputType || 'review',
            contextStats: req.body?.contextStats || null,
        });
        ok(res, normalized);
    } catch (error) {
        fail(res, error, 400, {
            project: current,
            reason: 'rules_normalize_failed',
        });
    }
});

router.post('/rules/clarify', async (req, res) => {
    let current = null;
    try {
        current = await store().loadProject();
        const previousResult = req.body?.previousResult || {};
        const draftRows = previousResult.draftRows || req.body?.draftRows || [];
        const result = continueTimetableRuleConversation({
            project: req.body?.project || current,
            draftRows,
            answers: req.body?.answers || [],
            inputType: req.body?.inputType || 'clarification',
            contextStats: req.body?.contextStats || previousResult.contextStats || null,
            originalText: req.body?.originalText || previousResult.originalText || '',
            previousResult,
        });
        ok(res, result);
    } catch (error) {
        fail(res, error, 400, {
            project: current,
            reason: 'rules_clarify_failed',
        });
    }
});

router.post('/rules/diagnose', async (req, res) => {
    let current = null;
    try {
        current = await store().loadProject();
        const diagnosis = diagnoseTimetableRules({
            project: req.body?.project || current,
            activeRules: req.body?.activeRules || null,
            draftRows: req.body?.recentDraftRows || req.body?.draftRows || [],
            solverFailure: req.body?.solverFailure || current.schedule?.solverStats || null,
        });
        ok(res, { diagnosis });
    } catch (error) {
        fail(res, error, 400, {
            project: current,
            reason: 'rules_diagnose_failed',
        });
    }
});

router.post('/schedule/run', async (req, res) => {
    try {
        const timetableStore = store();
        const current = await timetableStore.loadProject();
        const audit = auditTimetableProject(current);

        // 使用统一验证服务 - 替代旧的validateTimetableProjectForSolve
        const validation = validationService.validateForSolve(current);
        if (!validation.ok) {
            fail(res, validation.errors[0], 422, {
                project: current,
                schedule: current.schedule,
                reason: validation.reason,
                errors: validation.errors,
                warnings: validation.warnings,
                audit,
                solverStats: current.schedule?.solverStats || null,
            });
            return;
        }
        const fastResult = runTimetableScheduler(current, { seed: req.body?.seed });
        if (!fastResult.success) {
            fail(res, new Error('快速排课未能生成完整课表，旧课表已保留。'), 422, {
                project: current,
                schedule: current.schedule,
                reason: 'fast_construct_failed',
                audit: fastResult.schedule?.audit || audit,
                solverStats: fastResult.schedule?.solverStats || null,
            });
            return;
        }

        const saved = await timetableStore.saveProject(fastResult.project);
        const solverJob = hasTimefoldSolverConfigured()
            ? createTimetableOptimizationJob({
                project: saved,
                schedule: saved.schedule,
                store: timetableStore,
            })
            : null;
        ok(res, { project: saved, schedule: saved.schedule, solverJob });
    } catch (error) {
        fail(res, error, 500);
    }
});

router.get('/schedule/jobs/:jobId', (req, res) => {
    const job = getTimetableOptimizationJob(req.params.jobId);
    if (!job) {
        fail(res, new Error('排课优化任务不存在。'), 404, { job: null, reason: 'job_not_found' });
        return;
    }
    ok(res, { job });
});

router.post('/schedule/adjust', async (req, res) => {
    let current = null;
    try {
        current = await store().loadProject();
        const result = applyScheduleAdjustment(current, req.body || {});
        await store().saveProject(result.project);
        ok(res, { project: result.project, schedule: result.schedule });
    } catch (error) {
        fail(res, error, 400, {
            project: current,
            schedule: current?.schedule || null,
            reason: 'adjustment_failed',
            solverStats: current?.schedule?.solverStats || null,
        });
    }
});

router.post('/schedule/publish', async (req, res) => {
    try {
        const timetableStore = store();
        const current = await timetableStore.loadProject();

        // 使用统一验证服务进行发布前验证
        const validation = validationService.validateForPublish(current);
        if (!validation.ok) {
            const project = normalizeTimetableProject({
                ...current,
                schedule: current.schedule ? {
                    ...current.schedule,
                    publication: {
                        ok: false,
                        reason: validation.reason,
                        message: validation.message,
                        errors: validation.errors,
                        blockingIssues: validation.blockingIssues || [],
                        warnings: validation.warnings || [],
                        issueEntries: validation.issueEntries || [],
                        reviewItems: validation.reviewItems || validation.issueEntries || [],
                        summary: validation.summary || current.schedule?.publication?.summary || current.schedule?.score || {},
                    }
                } : current.schedule,
            });
            await timetableStore.saveProject(project);
            fail(res, validation.errors[0], 422, {
                project,
                schedule: project.schedule,
                reason: validation.reason,
                errors: validation.errors,
                publication: project.schedule?.publication,
            });
            return;
        }

        // 原有的publication逻辑保持不变
        const publication = validateTimetablePublication(current);
        if (!publication.ok) {
            const project = normalizeTimetableProject({
                ...current,
                schedule: current.schedule ? { ...current.schedule, publication } : current.schedule,
            });
            await timetableStore.saveProject(project);
            fail(res, new Error(publication.message), 422, {
                project,
                schedule: project.schedule,
                reason: publication.reason,
                publication,
            });
            return;
        }
        const note = String(req.body?.note || '').trim().slice(0, 200);
        const currentPublished = current.schedule?.published || null;
        const archivedPublished = (
            currentPublished?.status === 'published'
            && !currentPublished?.snapshot?.slots?.length
        )
            ? {
                ...currentPublished,
                fingerprint: currentPublished.fingerprint || '',
                snapshot: buildPublishedSnapshot(current.schedule, publication, current),
            }
            : currentPublished;
        const history = nextPublishedHistory(archivedPublished);
        const snapshot = buildPublishedSnapshot(current.schedule, publication, current);
        const nextSolverStats = current.schedule?.solverStats
            ? { ...current.schedule.solverStats }
            : null;
        if (nextSolverStats) {
            delete nextSolverStats.restoredPublishedDraft;
            delete nextSolverStats.restoredVersion;
            delete nextSolverStats.restoredScheduleId;
        }
        const publishedSchedule = {
            ...current.schedule,
            source: 'published',
            solverStats: nextSolverStats,
            published: {
                status: 'published',
                version: nextPublishVersion(current.schedule),
                publishedAt: new Date().toISOString(),
                scheduleId: current.schedule.id,
                note,
                fingerprint: snapshot.fingerprint,
                snapshot,
                history,
            },
        };
        const finalPublication = validateTimetablePublication({
            ...current,
            schedule: publishedSchedule,
        });
        const project = normalizeTimetableProject({
            ...current,
            schedule: {
                ...publishedSchedule,
                publication: finalPublication,
            },
        });
        const saved = await timetableStore.saveProject(project);
        ok(res, { project: saved, schedule: saved.schedule, publication: saved.schedule.publication });
    } catch (error) {
        fail(res, error, 500);
    }
});

router.post('/schedule/published/restore', async (req, res) => {
    try {
        const timetableStore = store();
        const current = await timetableStore.loadProject();
        const requestedVersion = req.body?.version;
        let restoreSourceProject = current;
        let rawEntry = resolvePublishedRestoreEntry(restoreSourceProject.schedule?.published, requestedVersion);
        if (
            (requestedVersion === undefined || requestedVersion === null || String(requestedVersion).trim() === '')
            && restoreSourceProject.schedule?.published?.status === 'published'
            && !rawEntry?.snapshot
        ) {
            const publication = validateTimetablePublication(restoreSourceProject);
            if (!publication.ok) {
                const project = normalizeTimetableProject({
                    ...restoreSourceProject,
                    schedule: restoreSourceProject.schedule
                        ? { ...restoreSourceProject.schedule, publication }
                        : restoreSourceProject.schedule,
                });
                await timetableStore.saveProject(project);
                fail(res, new Error(publication.message), 422, {
                    project,
                    schedule: project.schedule,
                    reason: publication.reason,
                    publication,
                });
                return;
            }
            const snapshot = buildPublishedSnapshot(restoreSourceProject.schedule, publication, restoreSourceProject);
            restoreSourceProject = normalizeTimetableProject({
                ...restoreSourceProject,
                schedule: {
                    ...restoreSourceProject.schedule,
                    publication,
                    published: {
                        ...restoreSourceProject.schedule.published,
                        fingerprint: snapshot.fingerprint,
                        snapshot,
                    },
                },
            });
            restoreSourceProject = await timetableStore.saveProject(restoreSourceProject);
            rawEntry = resolvePublishedRestoreEntry(restoreSourceProject.schedule?.published, requestedVersion);
        }
        if (
            !rawEntry?.snapshot?.slots?.length
            && (requestedVersion === undefined || requestedVersion === null || String(requestedVersion).trim() === '')
            && current.schedule?.published?.status === 'draft_changed'
            && Number.parseInt(current.schedule?.published?.version, 10) > 0
            && !current.schedule?.published?.snapshot?.slots?.length
        ) {
            fail(res, new Error('上一版发布快照缺失，当前只能重新发布，暂时无法恢复发布版。'), 422, {
                project: current,
                schedule: current.schedule,
                reason: 'published_snapshot_missing',
            });
            return;
        }
        if (!rawEntry?.snapshot?.slots?.length) {
            fail(res, new Error('没有找到可恢复的发布历史版本。'), 404, {
                project: current,
                schedule: current.schedule,
                reason: 'published_history_not_found',
            });
            return;
        }
        const fingerprint = verifyPublishedSnapshotFingerprint(rawEntry);
        if (!fingerprint.ok) {
            failPublicationFingerprintMismatch(res, restoreSourceProject, fingerprint);
            return;
        }
        const entry = publicationEntryWithVerifiedFingerprint(rawEntry);
        const restoredSchedule = scheduleFromPublishedSnapshot(restoreSourceProject, entry);
        const context = entry?.snapshot?.projectContext || {};
        let project = normalizeTimetableProject({
            ...restoreSourceProject,
            ...(context.schoolName ? { schoolName: context.schoolName } : {}),
            ...(context.term ? { term: context.term } : {}),
            ...(context.activeWeekdays?.length ? { activeWeekdays: context.activeWeekdays } : {}),
            ...(context.activePeriods?.length ? { activePeriods: context.activePeriods } : {}),
            ...(Object.prototype.hasOwnProperty.call(context, 'dayPartBoundaries') ? { dayPartBoundaries: context.dayPartBoundaries } : {}),
            ...(Array.isArray(context.periodTimes) ? { periodTimes: context.periodTimes } : {}),
            ...(Array.isArray(context.teachers) ? { teachers: context.teachers } : {}),
            ...(Array.isArray(context.classes) ? { classes: context.classes } : {}),
            ...(Array.isArray(context.subjects) ? { subjects: context.subjects } : {}),
            ...(Array.isArray(context.lessonPlans) ? { lessonPlans: context.lessonPlans } : {}),
            ...(context.rules ? { rules: context.rules } : {}),
            schedule: restoredSchedule,
        });
        const publication = validateTimetablePublication(project);
        project = normalizeTimetableProject({
            ...project,
            schedule: {
                ...project.schedule,
                publication,
            },
        });
        const saved = await timetableStore.saveProject(project);
        ok(res, {
            project: saved,
            schedule: saved.schedule,
            publication: saved.schedule.publication,
            restoredVersion: Number.parseInt(entry.version, 10) || null,
        });
    } catch (error) {
        fail(res, error, 500);
    }
});

router.post('/export', async (req, res) => {
    try {
        const timetableStore = store();
        let current = await timetableStore.loadProject();
        const requested = splitExportType(req.body?.type || req.query?.type || 'class');
        const publishedVersion = req.body?.publishedVersion || req.query?.publishedVersion || null;
        const type = requested.type;
        let exportProject = current;
        if (requested.published) {
            if (publishedVersion && !findPublishedHistoryEntry(current.schedule?.published, publishedVersion)) {
                fail(res, new Error('没有找到可导出的发布历史版本。'), 404, {
                    project: current,
                    schedule: current.schedule,
                    reason: 'published_history_not_found',
                });
                return;
            }
            let publishedSourceProject = current;
            let publishedEntry = resolvePublishedRestoreEntry(publishedSourceProject.schedule?.published, publishedVersion);
            if (
                !publishedVersion
                && publishedSourceProject.schedule?.published?.status === 'published'
                && !publishedEntry?.snapshot
            ) {
                const publication = validateTimetablePublication(publishedSourceProject);
                if (!publication.ok) {
                    const project = normalizeTimetableProject({
                        ...publishedSourceProject,
                        schedule: publishedSourceProject.schedule
                            ? { ...publishedSourceProject.schedule, publication }
                            : publishedSourceProject.schedule,
                    });
                    await timetableStore.saveProject(project);
                    fail(res, new Error(publication.message), 422, {
                        project,
                        schedule: project.schedule,
                        reason: publication.reason,
                        publication,
                    });
                    return;
                }
                const snapshot = buildPublishedSnapshot(publishedSourceProject.schedule, publication, publishedSourceProject);
                publishedSourceProject = normalizeTimetableProject({
                    ...publishedSourceProject,
                    schedule: {
                        ...publishedSourceProject.schedule,
                        publication,
                        published: {
                            ...publishedSourceProject.schedule.published,
                            fingerprint: snapshot.fingerprint,
                            snapshot,
                        },
                    },
                });
                publishedSourceProject = await timetableStore.saveProject(publishedSourceProject);
                publishedEntry = resolvePublishedRestoreEntry(publishedSourceProject.schedule?.published, publishedVersion);
            }
            if (publishedEntry) {
                const fingerprint = verifyPublishedSnapshotFingerprint(publishedEntry);
                if (!fingerprint.ok) {
                    failPublicationFingerprintMismatch(res, publishedSourceProject, fingerprint);
                    return;
                }
            }
            exportProject = projectWithPublishedSnapshot(publishedSourceProject, publishedVersion);
            if (!exportProject) {
                fail(res, new Error('没有可导出的已发布课表快照。'), 422, {
                    project: current,
                    schedule: current.schedule,
                    reason: 'published_snapshot_missing',
                });
                return;
            }
        } else if (type !== 'plans') {
            if (current.schedule?.published?.status === 'draft_changed') {
                fail(res, new Error('当前课表已改动，请重新发布后再导出正式课表。'), 422, {
                    project: current,
                    schedule: current.schedule,
                    reason: 'publication_draft_changed',
                    publication: current.schedule.publication || null,
                });
                return;
            }
            const currentPublishedEntry = current.schedule?.published?.status === 'published'
                ? resolvePublishedRestoreEntry(current.schedule.published)
                : null;
            if (currentPublishedEntry?.snapshot) {
                const fingerprint = verifyPublishedSnapshotFingerprint(currentPublishedEntry);
                if (!fingerprint.ok) {
                    failPublicationFingerprintMismatch(res, current, fingerprint);
                    return;
                }
                const verifiedEntry = publicationEntryWithVerifiedFingerprint(currentPublishedEntry);
                if (
                    verifiedEntry?.fingerprint
                    && (
                        current.schedule.published.fingerprint !== verifiedEntry.fingerprint
                        || current.schedule.published.snapshot?.fingerprint !== verifiedEntry.fingerprint
                    )
                ) {
                    exportProject = normalizeTimetableProject({
                        ...current,
                        schedule: {
                            ...current.schedule,
                            published: publishedEntryBackfilledForExport(current.schedule.published, verifiedEntry),
                        },
                    });
                    exportProject = await timetableStore.saveProject(exportProject);
                    current = exportProject;
                }
            }
            if (
                current.schedule?.published?.status === 'published'
                && scheduleDiffersFromPublishedSnapshot(current.schedule, current)
            ) {
                const project = await timetableStore.saveProject(projectMarkedDraftChanged(current));
                fail(res, new Error('当前课表已改动，请重新发布后再导出正式课表。'), 422, {
                    project,
                    schedule: project.schedule,
                    reason: 'publication_draft_changed',
                    publication: project.schedule.publication || null,
                });
                return;
            }
            const publication = validateTimetablePublication(exportProject);
            if (!publication.ok) {
                const project = normalizeTimetableProject({
                    ...exportProject,
                    schedule: exportProject.schedule ? { ...exportProject.schedule, publication } : exportProject.schedule,
                });
                await timetableStore.saveProject(project);
                fail(res, new Error(publication.message), 422, {
                    project,
                    schedule: project.schedule,
                    reason: publication.reason,
                    publication,
                });
                return;
            }
            if (current.schedule?.published?.status !== 'published') {
                fail(res, new Error('请先发布课表后导出正式课表。'), 422, {
                    project: current,
                    schedule: current.schedule,
                    reason: 'publication_required',
                    publication,
                });
                return;
            }
            if (!currentPublishedEntry?.snapshot) {
                const snapshot = buildPublishedSnapshot(current.schedule, publication, current);
                exportProject = normalizeTimetableProject({
                    ...current,
                    schedule: {
                        ...current.schedule,
                        publication,
                        published: {
                            ...current.schedule.published,
                            fingerprint: snapshot.fingerprint,
                            snapshot,
                        },
                    },
                });
                exportProject = await timetableStore.saveProject(exportProject);
                current = exportProject;
            }
        }
        const buffer = buildTimetableExportXlsx(exportProject, { type });
        const versionSuffix = requested.published && publishedVersion ? `_V${Number.parseInt(publishedVersion, 10) || publishedVersion}` : '';
        const namePrefix = requested.published ? '已发布' : '';
        const name = type === 'teacher' ? `${namePrefix}教师课表` : type === 'plans' ? '任课信息' : type === 'master' ? `${namePrefix}总课表` : `${namePrefix}班级课表`;
        const filename = encodeURIComponent(`${name}${versionSuffix}_${new Date().toISOString().slice(0, 10)}.xlsx`);
        res.setHeader('Content-Type', TIMETABLE_XLSX_MIME);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
        res.send(buffer);
    } catch (error) {
        fail(res, error);
    }
});

router.get('/template/lesson-plans', (req, res) => {
    const csv = '\ufeff年级,班级,课程,教师,周课时,连堂\n七年级,1班,数学,陈老师,4,单节\n七年级,1班,语文,林老师,5,混合\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''%E4%BB%BB%E8%AF%BE%E4%BF%A1%E6%81%AF%E6%A8%A1%E6%9D%BF.csv");
    res.send(csv);
});

export default router;
