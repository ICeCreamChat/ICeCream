/**
 * timetable-v2 / api / routes.js
 *
 * V2 HTTP 路由适配层（决策 1 新前缀 /api/tools/timetable-v2/*、决策 2 分层）。
 *
 * 严格 route→service 分层：本文件**只做请求校验 + 调 core + 响应壳**，
 * 不含任何排课 / 诊断 / 网格 / 导出业务算法（全部委托 timetable-v2 core）。
 * 沿用旧 timetable.js 的 ok/fail 响应壳风格（不 import，照搬范式）。
 */

import express from 'express';

import {
    createProject,
    validateProject,
    solve,
    buildDiagnostics,
    buildGridView,
    buildV2ExportXlsx,
    V2_XLSX_MIME,
    importLegacyProject,
    importExcelPlans,
    importCrystalCloneSeed,
    importYqdTables,
    timetableV2Store,
    parseNaturalLanguageConstraints,
} from '../index.js';

/** 响应壳：成功。 */
function ok(res, data) {
    return res.json({ success: true, data });
}

/** 响应壳：失败（可读 error + 可选附加 data）。 */
function fail(res, error, status = 400, data = undefined) {
    return res.status(status).json({
        success: false,
        error: error?.message || String(error),
        ...(data === undefined ? {} : { data }),
    });
}

/** Timefold 是否配置（决策 5：配置时本地先返回 + 后台优化任务）。 */
function hasTimefoldSolverConfigured(env = process.env) {
    return Boolean(String(env.TIMEFOLD_SOLVER_URL || '').trim());
}

/** 各源对应的导入器（Phase 3）。 */
const IMPORTERS = {
    legacy: importLegacyProject,
    excel: importExcelPlans,
    crystal: importCrystalCloneSeed,
    yqd: importYqdTables,
};

/** 把导入器返回的 report（migration-report 实例或纯对象）序列化为纯数据。 */
function reportToJSON(report) {
    if (!report) return null;
    return typeof report.toJSON === 'function' ? report.toJSON() : report;
}

/** 从 solve 结果摘出对前端有用的字段（不含不可序列化的 ctx/solution）。 */
function solveResultView(result) {
    return {
        placements: result.placements,
        unplaced: result.unplaced,
        hardConflicts: result.hardConflicts,
        softScore: result.softScore,
        diagnostics: result.diagnostics,
        stats: result.stats,
    };
}

export function createTimetableV2Router(options = {}) {
    const store = options.store || timetableV2Store;
    const router = express.Router();

    // GET /bootstrap：返回 V2 项目（无则提示可迁移）+ 能力标志。
    router.get('/bootstrap', async (req, res) => {
        try {
            const project = await store.loadProject();
            const capabilities = {
                solver: true,
                diagnostics: true,
                gridView: true,
                xlsxExport: true,
                importSources: Object.keys(IMPORTERS),
                timefold: hasTimefoldSolverConfigured(),
            };
            if (!project) {
                ok(res, { project: null, needsMigration: true, capabilities });
                return;
            }
            ok(res, { project, needsMigration: false, capabilities });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    // POST /project：createProject 校验 → 落库 → 返回项目。
    router.post('/project', async (req, res) => {
        try {
            const check = validateProject(req.body || {});
            if (!check.ok) {
                fail(res, new Error('项目数据校验失败'), 400, { errors: check.errors });
                return;
            }
            const saved = await store.saveProject(req.body);
            ok(res, { project: saved });
        } catch (error) {
            fail(res, error, 400, { errors: error.validationErrors });
        }
    });

    // POST /import：source + data → 对应导入器 → {project, report}（不落库）。
    router.post('/import', (req, res) => {
        try {
            const source = String(req.body?.source || '').trim();
            const importer = IMPORTERS[source];
            if (!importer) {
                fail(res, new Error(`未知导入来源 "${source}"，须为 ${Object.keys(IMPORTERS).join(' / ')}`));
                return;
            }
            if (req.body?.data === undefined) {
                fail(res, new Error('缺少待导入数据 data'));
                return;
            }
            const result = importer(req.body.data, req.body.options || {});
            ok(res, { project: result.project, report: reportToJSON(result.report) });
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /rules：把规则原始输入并入 project.constraints，经 createProject 校验。
    // 接受两种输入：已结构化的 DSL（rules:[...] / rules.constraints）与自然语言原文
    // （rules.nl / naturalLanguage），后者先经 nl-parser 解析为 DSL，unsupported 项随响应返回。
    router.post('/rules', (req, res) => {
        try {
            const project = req.body?.project;
            if (!project || typeof project !== 'object') {
                fail(res, new Error('缺少 project'));
                return;
            }
            const incoming = req.body?.rules;
            const structured = Array.isArray(incoming)
                ? incoming
                : Array.isArray(incoming?.constraints)
                    ? incoming.constraints
                    : [];
            // 自然语言原文：body.naturalLanguage 或 rules.nl
            const nlText = typeof req.body?.naturalLanguage === 'string'
                ? req.body.naturalLanguage
                : (typeof incoming?.nl === 'string' ? incoming.nl : '');
            let parsed = [];
            let unsupported = [];
            if (nlText.trim()) {
                const result = parseNaturalLanguageConstraints(nlText, project);
                parsed = result.constraints;
                unsupported = result.unsupported;
            }
            const merged = {
                ...project,
                constraints: [
                    ...(Array.isArray(project.constraints) ? project.constraints : []),
                    ...structured,
                    ...parsed,
                ],
            };
            const validated = createProject(merged); // 校验失败抛错 → catch
            ok(res, { project: validated, parsed, unsupported });
        } catch (error) {
            fail(res, error, 400, { errors: error.validationErrors });
        }
    });

    // POST /schedule/run：本地 pipeline 求解，立即返回；配置 Timefold 时附后台任务 id（决策 5）。
    router.post('/schedule/run', (req, res) => {
        try {
            const project = req.body?.project;
            if (!project || typeof project !== 'object') {
                fail(res, new Error('缺少 project'));
                return;
            }
            const result = solve(project, req.body?.opts || {});
            const view = solveResultView(result);
            // 本地启发式解已即时返回（决策 5：本地先返回）。
            // Timefold 后台优化接入需要 V2→Timefold 的问题适配（旧 timetable-optimization-jobs
            // 仅消费旧 lessonPlans/weeklyHours 形状，直接传 V2 项目会崩）。该 V2 桥作为后续项，
            // 本阶段不把 V2 项目喂给旧运行器，避免形状不兼容导致后台任务崩溃。
            view.backgroundJobId = null;
            view.timefoldPending = hasTimefoldSolverConfigured();
            ok(res, view);
        } catch (error) {
            fail(res, error, 422);
        }
    });

    // POST /diagnose：对项目求解后产出诊断报告；带 solution/ctx 时复用 buildDiagnostics。
    router.post('/diagnose', (req, res) => {
        try {
            const project = req.body?.project;
            if (!project || typeof project !== 'object') {
                fail(res, new Error('缺少 project'));
                return;
            }
            const result = solve(project, { ...(req.body?.opts || {}), diagnostics: true });
            ok(res, { diagnostics: result.diagnostics, hardConflicts: result.hardConflicts, unplaced: result.unplaced });
        } catch (error) {
            fail(res, error, 422);
        }
    });

    // POST /schedule/publish：发布门禁（零硬冲突 + 无未排才可发布），否则 fail 带 reason。
    router.post('/schedule/publish', (req, res) => {
        try {
            const project = req.body?.project;
            const solution = req.body?.solution;
            if (!project || typeof project !== 'object') {
                fail(res, new Error('缺少 project'));
                return;
            }
            if (!solution || typeof solution !== 'object') {
                fail(res, new Error('缺少 solution'));
                return;
            }
            const hardConflicts = Array.isArray(solution.hardConflicts) ? solution.hardConflicts : [];
            const unplaced = Array.isArray(solution.unplaced) ? solution.unplaced : [];
            if (hardConflicts.length > 0) {
                fail(res, new Error('存在硬冲突，无法发布'), 422, { reason: 'hard_conflicts_exist', hardConflicts });
                return;
            }
            if (unplaced.length > 0) {
                fail(res, new Error('存在未排课程，无法发布'), 422, { reason: 'unplaced_lessons', unplaced });
                return;
            }
            ok(res, {
                published: true,
                publishedAt: new Date().toISOString(),
                placements: Array.isArray(solution.placements) ? solution.placements : [],
                softScore: solution.softScore ?? null,
            });
        } catch (error) {
            fail(res, error, 500);
        }
    });

    // POST /export：solve（或已有 solution）→ buildV2ExportXlsx → 下载头返回 Buffer。
    router.post('/export', (req, res) => {
        try {
            const project = req.body?.project;
            if (!project || typeof project !== 'object') {
                fail(res, new Error('缺少 project'));
                return;
            }
            // export 需要 ctx（含展开后的 activities）来构网格，故就地求解一次拿到完整 solveResult。
            const solveResult = solve(project, { diagnostics: false });
            const buffer = buildV2ExportXlsx(project, solveResult, { type: req.body?.type });
            const filename = encodeURIComponent(`课表_${new Date().toISOString().slice(0, 10)}.xlsx`);
            res.setHeader('Content-Type', V2_XLSX_MIME);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
            res.send(buffer);
        } catch (error) {
            fail(res, error);
        }
    });

    // POST /migrate/legacy：旧项目 → V2 草稿写独立键（绝不写旧数据）。幂等：已存在且无 force 不覆盖。
    router.post('/migrate/legacy', async (req, res) => {
        try {
            const legacyProject = req.body?.legacyProject;
            if (!legacyProject || typeof legacyProject !== 'object') {
                fail(res, new Error('缺少 legacyProject'));
                return;
            }
            const force = req.body?.force === true || req.body?.force === 'true';
            if (!force && await store.exists()) {
                const existing = await store.loadProject();
                ok(res, { project: existing, report: null, migrated: false, reason: 'draft_exists' });
                return;
            }
            const result = importLegacyProject(legacyProject);
            const saved = await store.saveProject(result.project);
            ok(res, { project: saved, report: reportToJSON(result.report), migrated: true });
        } catch (error) {
            fail(res, error);
        }
    });

    // GET /schedule/jobs/:jobId：查 Timefold 后台优化任务。
    // V2→Timefold 桥尚未接入（决策 5：本地求解器先满足，Timefold 为后续可选优化器），
    // 当前不创建后台任务，故恒返回 job_not_found，待 V2 Timefold 适配后再接真实任务存储。
    router.get('/schedule/jobs/:jobId', (req, res) => {
        fail(res, new Error('排课优化任务不存在（V2 Timefold 后台优化尚未接入）'), 404, { job: null, reason: 'job_not_found' });
    });

    return router;
}

const router = createTimetableV2Router();
export default router;
