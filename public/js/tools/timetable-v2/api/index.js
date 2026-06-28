/**
 * timetable-v2 / api / index.js
 *
 * 前端与后端通信的集中入口。对外暴露「读接口」与「唯一写入口」。
 *
 * ───────────────────────── 红线（设计决策 3） ─────────────────────────
 * - 本层只做「通信 + 回放桩」，绝不做任何排课 / 冲突判定 / 候选位 / 可行性计算。
 *   冲突、未排原因、软规则未满足项一律来自后端 solution / diagnostics。
 * - 写入口（commitRules / commitAdjustment / publish / solve）是前端「唯一」能把
 *   草稿变成项目状态的地方：所有写入都经此 → 后端 normalize + validate。
 *   前端没有任何本地直接落库或本地构造业务对象的旁路。
 * - USE_MOCK=true 时：读接口回放契约同形桩；写入口模拟后端 normalize（回放桩，
 *   并把草稿标记 applied:true 合并），但不在前端做业务计算 / 校验逻辑。
 * - USE_MOCK=false 时：读写均经 requestV2() 走后端 V2 路由，错误处理集中在 client.js。
 */

import { requestV2, requestV2File, USE_MOCK } from './client.js';
import { sampleProject } from './mock/project.sample.js';
import { sampleSolution } from './mock/solution.sample.js';
import { sampleDiagnostics } from './mock/diagnostics.sample.js';

// ───────────────────────── 读接口 ─────────────────────────
// 只读取后端真相，前端不缓存可重算的派生状态（冲突 / 候选位）。

const MOCK_CAPABILITIES = {
    solver: true,
    diagnostics: true,
    gridView: true,
    xlsxExport: true,
    importSources: ['legacy', 'excel', 'crystal', 'yqd'],
    timefold: false,
};

function normalizeSolution(raw = {}) {
    const source = raw.solution && typeof raw.solution === 'object' ? raw.solution : raw;
    return {
        placements: Array.isArray(source.placements) ? source.placements : [],
        unplaced: Array.isArray(source.unplaced) ? source.unplaced : [],
        hardConflicts: Array.isArray(source.hardConflicts) ? source.hardConflicts : [],
        softScore: source.softScore ?? null,
        stats: source.stats || raw.stats || {},
        diagnostics: source.diagnostics || raw.diagnostics || null,
        backgroundJobId: source.backgroundJobId ?? raw.backgroundJobId ?? null,
        timefoldPending: Boolean(source.timefoldPending ?? raw.timefoldPending),
    };
}

function mockReport(source = 'mock') {
    return {
        source,
        summary: { total: 1, kept: 1, degraded: 0, dropped: 0, review: 0 },
        entries: [
            { category: 'kept', field: 'sample', reason: '示例数据已加载', source: { kind: source } },
        ],
    };
}

/** 读取 bootstrap 全量（含 needsMigration / capabilities），供工作台初始化。 */
export async function getBootstrap() {
    if (USE_MOCK) return { project: sampleProject, needsMigration: false, capabilities: MOCK_CAPABILITIES };
    return requestV2('/bootstrap');
}

/** 读取项目（后端 /bootstrap 返回 {project, needsMigration, capabilities}）。 */
export async function getProject() {
    const boot = await getBootstrap();
    return boot?.project ?? null;
}

/** 导入预览：/import 只产出 project/report，不落库。 */
export async function importProject({ source = 'excel', data, options = {} } = {}) {
    if (USE_MOCK) return { project: sampleProject, report: mockReport(source) };
    return requestV2('/import', {
        method: 'POST',
        body: JSON.stringify({ source, data, options }),
    });
}

/** 保存经过后端校验的项目草稿。 */
export async function saveProject(project) {
    if (USE_MOCK) return { ...sampleProject, ...(project || {}) };
    const data = await requestV2('/project', {
        method: 'POST',
        body: JSON.stringify(project || {}),
    });
    return data?.project ?? data;
}

/** 当前解：V2 无独立 solution 读路由；保留 mock/兼容入口。 */
export async function getSolution() {
    return USE_MOCK ? sampleSolution : null;
}

/** 诊断报告：真实模式由 runSchedule/diagnoseProject 返回；保留 mock/兼容入口。 */
export async function getDiagnostics() {
    return USE_MOCK ? sampleDiagnostics : null;
}

/** 读取后台优化任务状态（Timefold）。需 jobId。 */
export async function getSolverJob(jobId) {
    if (USE_MOCK) return { status: 'done', progress: 100, softScore: sampleSolution.softScore, stats: sampleSolution.stats };
    if (!jobId) return null;
    return requestV2(`/schedule/jobs/${encodeURIComponent(jobId)}`);
}

// ───────────────────────── 写入口（唯一） ─────────────────────────
// 关键红线：以下是前端唯一能把草稿变成项目状态的入口。
// 所有写入都经此 → 后端 normalize + validate。前端不在此做任何业务计算 / 校验，
// 仅通信；mock 时回放契约同形结果并模拟「草稿被后端接受」的合并标记。

/**
 * 确认写入规则草稿。前端只采集原始输入（自然语言文本 / 字段值），
 * 由后端 normalize 拼装为业务对象。
 * @param {object} rawDraft 原始草稿（applied:false）
 * @returns {Promise<object>} 更新后的 project 引用
 */
export async function commitRules(rawDraft) {
    if (USE_MOCK) {
        return { project: sampleProject, parsed: [], unsupported: [] };
    }
    // 后端 /rules：把规则原始输入并入 project.constraints 经 createProject 校验后返回新 project。
    return requestV2('/rules', {
        method: 'POST',
        body: JSON.stringify(rawDraft && rawDraft.project ? rawDraft : { rules: rawDraft }),
    });
}

/**
 * 提交手动调整（移动 / 锁定课节等原始操作意图）。
 * 注：V2 后端手动调整路由尚未提供（不在 Phase 6 e2e 核心门禁内），
 * 真实模式下经 /schedule/run 带调整意图重排，由后端校验后返回新解。
 * @param {object} payload { project, adjustment }
 * @returns {Promise<object>} 更新后的求解结果
 */
export async function commitAdjustment(payload) {
    if (USE_MOCK) return { solution: sampleSolution, diagnostics: sampleDiagnostics, stats: sampleSolution.stats };
    return runSchedule(payload || {});
}

/**
 * 触发求解（后端运行本地启发式求解器，立即返回解 + 诊断）。
 * @param {object} payload { project, opts }
 * @returns {Promise<{ solution: object, diagnostics: object|null, stats: object, raw: object }>}
 */
export async function runSchedule(payload = {}) {
    if (USE_MOCK) {
        return { solution: sampleSolution, diagnostics: sampleDiagnostics, stats: sampleSolution.stats, raw: sampleSolution };
    }
    const raw = await requestV2('/schedule/run', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    const solution = normalizeSolution(raw);
    return {
        solution,
        diagnostics: raw.diagnostics || solution.diagnostics || null,
        stats: raw.stats || solution.stats || {},
        raw,
    };
}

/** 对当前项目生成诊断报告。 */
export async function diagnoseProject(payload = {}) {
    if (USE_MOCK) return { diagnostics: sampleDiagnostics, hardConflicts: [], unplaced: [] };
    return requestV2('/diagnose', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

/**
 * 发布课表（经后端发布前校验：零硬冲突 + 无未排才可发布）。
 * @param {object} payload { project, solution }
 * @returns {Promise<object>} 发布结果
 */
export async function publishSchedule(payload) {
    if (USE_MOCK) return { published: true, solution: sampleSolution };
    return requestV2('/schedule/publish', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
    });
}

/** 导出课表文件，真实文件由后端生成。 */
export async function exportSchedule(payload = {}) {
    if (USE_MOCK) {
        const blob = new Blob(['mock timetable export'], { type: 'text/plain;charset=utf-8' });
        return { blob, filename: '课表_示例.txt' };
    }
    return requestV2File('/export', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
    });
}

export function downloadFile({ blob, filename }) {
    if (!blob || typeof document === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '课表.xlsx';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Backward-compatible aliases while views are being migrated.
export const solve = runSchedule;
export const publish = publishSchedule;
