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

import { requestV2, USE_MOCK } from './client.js';
import { sampleProject } from './mock/project.sample.js';
import { sampleSolution } from './mock/solution.sample.js';
import { sampleDiagnostics } from './mock/diagnostics.sample.js';

// ───────────────────────── 读接口 ─────────────────────────
// 只读取后端真相，前端不缓存可重算的派生状态（冲突 / 候选位）。

/** 读取项目（后端 /bootstrap 返回 {project, needsMigration, capabilities}）。 */
export async function getProject() {
    if (USE_MOCK) return sampleProject;
    const boot = await requestV2('/bootstrap');
    return boot?.project ?? null;
}

/** 读取 bootstrap 全量（含 needsMigration / capabilities），供工作台初始化。 */
export async function getBootstrap() {
    if (USE_MOCK) return { project: sampleProject, needsMigration: false, capabilities: {} };
    return requestV2('/bootstrap');
}

/** 当前解：后端无持久化 solution 读路由，解经 solve() 获得；未求解时返回 null。 */
export async function getSolution() {
    if (USE_MOCK) return sampleSolution;
    return null;
}

/** 诊断报告：经 solve() 结果的 diagnostics 字段或 diagnose() 获得；无解时返回 null。 */
export async function getDiagnostics() {
    if (USE_MOCK) return sampleDiagnostics;
    return null;
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
        return sampleProject;
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
    if (USE_MOCK) return sampleSolution;
    return requestV2('/schedule/run', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
    });
}

/**
 * 发布课表（经后端发布前校验：零硬冲突 + 无未排才可发布）。
 * @param {object} payload { project, solution }
 * @returns {Promise<object>} 发布结果
 */
export async function publish(payload) {
    if (USE_MOCK) return { published: true, solution: sampleSolution };
    return requestV2('/schedule/publish', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
    });
}

/**
 * 触发求解（后端运行本地启发式求解器，立即返回解 + 诊断）。
 * @param {object} opts { project, opts }
 * @returns {Promise<object>} 求解结果（placements/unplaced/hardConflicts/softScore/diagnostics/stats）
 */
export async function solve(opts) {
    if (USE_MOCK) {
        return { status: 'done', progress: 100, solution: sampleSolution, stats: sampleSolution.stats };
    }
    return requestV2('/schedule/run', {
        method: 'POST',
        body: JSON.stringify(opts || {}),
    });
}
