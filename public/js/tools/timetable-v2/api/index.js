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

/** 读取项目（domain normalize 结果）。 */
export async function getProject() {
    if (USE_MOCK) return sampleProject;
    return requestV2('/project');
}

/** 读取当前解（placements / unplaced / hardConflicts / softScore / stats）。 */
export async function getSolution() {
    if (USE_MOCK) return sampleSolution;
    return requestV2('/solution');
}

/** 读取诊断报告（items / byObject / suggestions / summary）。 */
export async function getDiagnostics() {
    if (USE_MOCK) return sampleDiagnostics;
    return requestV2('/diagnostics');
}

/** 读取求解任务状态（进度轮询）。 */
export async function getSolverJob() {
    if (USE_MOCK) return { status: 'done', progress: 100, softScore: sampleSolution.softScore, stats: sampleSolution.stats };
    return requestV2('/solver/job');
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
        // 模拟后端接受草稿：回放 project 桩（真实后端会返回 normalize 后的新 project）。
        // 这里不做任何校验 / 构造，只是把桩当作「后端 normalize 结果」回放。
        return sampleProject;
    }
    return requestV2('/rules/commit', {
        method: 'POST',
        body: JSON.stringify({ draft: rawDraft }),
    });
}

/**
 * 提交手动调整（移动 / 锁定课节等原始操作意图）。
 * @param {object} payload 原始调整意图
 * @returns {Promise<object>} 更新后的 solution 引用
 */
export async function commitAdjustment(payload) {
    if (USE_MOCK) return sampleSolution;
    return requestV2('/adjustment/commit', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

/**
 * 发布 / 导出课表（经后端发布前校验）。
 * @param {object} payload 发布参数
 * @returns {Promise<object>} 发布结果
 */
export async function publish(payload) {
    if (USE_MOCK) return { published: true, solution: sampleSolution };
    return requestV2('/publish', {
        method: 'POST',
        body: JSON.stringify(payload || {}),
    });
}

/**
 * 触发求解（提交求解请求，由后端运行求解器）。
 * @param {object} opts 求解参数（seed / 迭代上限等原始入参）
 * @returns {Promise<object>} 求解任务句柄或结果
 */
export async function solve(opts) {
    if (USE_MOCK) {
        return { status: 'done', progress: 100, solution: sampleSolution, stats: sampleSolution.stats };
    }
    return requestV2('/solve', {
        method: 'POST',
        body: JSON.stringify(opts || {}),
    });
}
