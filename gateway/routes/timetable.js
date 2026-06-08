import express from 'express';
import multer from 'multer';

import { buildTimetableExportXlsx, TIMETABLE_XLSX_MIME } from '../services/timetable-export.js';
import { parseTimetableRosterFile, parseTimetableRosterText } from '../services/timetable-import.js';
import { createTimetableStore } from '../services/timetable-store.js';
import {
    applyScheduleAdjustment,
    normalizeTimetableProject,
    runTimetableScheduler,
    validateTimetableProjectForSolve,
} from '../services/timetable-scheduler.js';
import {
    createTimetableOptimizationJob,
    getTimetableOptimizationJob,
} from '../services/timetable-optimization-jobs.js';

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
        const project = normalizeTimetableProject({
            ...current,
            ...req.body,
            rules: req.body.rules || current.rules,
            schedule: req.body.schedule === undefined ? current.schedule : req.body.schedule,
        });
        const saved = await store().saveProject(project);
        ok(res, { project: saved });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/roster/import', upload.single('file'), async (req, res) => {
    try {
        const parsed = req.file
            ? parseTimetableRosterFile({ buffer: req.file.buffer, filename: req.file.originalname })
            : parseTimetableRosterText(req.body?.text || '');
        const current = await store().loadProject();
        const project = normalizeTimetableProject({
            ...current,
            teachers: parsed.teachers,
            classes: parsed.classes,
            subjects: parsed.subjects,
            lessonPlans: parsed.lessonPlans,
            schedule: null,
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
            schedule: null,
        });
        const saved = await store().saveProject(project);
        ok(res, { project: saved });
    } catch (error) {
        fail(res, error);
    }
});

router.post('/schedule/run', async (req, res) => {
    try {
        const timetableStore = store();
        const current = await timetableStore.loadProject();
        const validation = validateTimetableProjectForSolve(current);
        if (!validation.ok) {
            fail(res, new Error(validation.message), 422, {
                project: current,
                schedule: current.schedule,
                reason: validation.reason,
                solverStats: current.schedule?.solverStats || null,
            });
            return;
        }
        const fastResult = runTimetableScheduler(current);
        if (!fastResult.success) {
            fail(res, new Error('快速排课未能生成完整课表，旧课表已保留。'), 422, {
                project: current,
                schedule: current.schedule,
                reason: 'fast_construct_failed',
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

router.post('/export', async (req, res) => {
    try {
        const current = await store().loadProject();
        const type = req.body?.type || req.query?.type || 'class';
        const buffer = buildTimetableExportXlsx(current, { type });
        const name = type === 'teacher' ? '教师课表' : type === 'plans' ? '任课信息' : type === 'master' ? '总课表' : '班级课表';
        const filename = encodeURIComponent(`${name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
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
