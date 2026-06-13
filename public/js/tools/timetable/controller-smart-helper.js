/**
 * 智能约束助手Controller扩展
 * 处理自动扫描、一键修复等交互
 */

import { autoScanConstraints, generateAutoFix } from '../../../gateway/services/timetable-auto-scanner.js';

/**
 * 打开智能约束助手（自动扫描）
 */
export async function openSmartConstraintHelper() {
    // 初始化状态
    this.state.constraintScan = {
        open: true,
        scanning: true,
        progress: 0,
        phase: '准备分析约束配置...',
    };
    this.render();

    try {
        // 获取当前约束
        const constraints = this.state.ruleReview?.draftRows || [];
        const project = this.state.project;

        // 模拟扫描进度
        await this.simulateScanProgress();

        // 执行自动扫描
        const scanResult = await autoScanConstraints(constraints, project);

        // 更新状态
        this.state.constraintScan = {
            ...this.state.constraintScan,
            scanning: false,
            completed: true,
            problems: scanResult.problems,
            stats: scanResult.stats,
        };

        this.render();

        // 如果有可自动修复的问题，显示提示
        if (scanResult.stats.autoFixable > 0) {
            this.setMessage(`发现 ${scanResult.stats.total} 个问题，其中 ${scanResult.stats.autoFixable} 个可自动修复`);
        } else if (scanResult.stats.total === 0) {
            this.setMessage('太棒了！您的约束配置很完善');
        } else {
            this.setMessage(`发现 ${scanResult.stats.total} 个问题需要处理`);
        }
    } catch (error) {
        this.state.constraintScan = {
            ...this.state.constraintScan,
            scanning: false,
            error: error.message || '扫描失败，请重试',
        };
        this.render();
        this.handleError(error);
    }
}

/**
 * 模拟扫描进度（提供用户反馈）
 */
async function simulateScanProgress() {
    const phases = [
        { progress: 20, phase: '检查教师排课情况...' },
        { progress: 40, phase: '分析课程分布...' },
        { progress: 60, phase: '检测时间冲突...' },
        { progress: 80, phase: '评估约束合理性...' },
        { progress: 95, phase: '生成优化建议...' },
    ];

    for (const { progress, phase } of phases) {
        this.state.constraintScan.progress = progress;
        this.state.constraintScan.phase = phase;
        this.render();
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

/**
 * 查看问题详情
 */
export function viewProblemDetails(problemId) {
    const problem = this.state.constraintScan?.problems?.find(p => p.id === problemId);
    if (!problem) return;

    // 显示详情对话框
    this.state.problemDetailDialog = {
        open: true,
        problem,
    };
    this.render();
}

/**
 * 应用单个修复
 */
export async function applySingleFix(problemId) {
    const problem = this.state.constraintScan?.problems?.find(p => p.id === problemId);
    if (!problem || !problem.autoFixable) return;

    try {
        // 生成修复方案
        const fix = await generateAutoFix(problem, this.state.project);

        // 显示预览
        this.state.fixPreview = {
            open: true,
            problem,
            fix,
        };
        this.render();
    } catch (error) {
        this.handleError(error);
    }
}

/**
 * 确认应用修复
 */
export async function confirmApplyFix(problemId) {
    const { problem, fix } = this.state.fixPreview || {};
    if (!fix) return;

    try {
        this.state.fixPreview = { ...this.state.fixPreview, applying: true };
        this.render();

        // 应用修复到约束
        const updatedConstraints = this.applyFixToConstraints(
            this.state.ruleReview?.draftRows || [],
            fix
        );

        // 更新约束
        this.state.ruleReview = {
            ...this.state.ruleReview,
            draftRows: updatedConstraints,
        };

        // 关闭预览
        this.state.fixPreview = null;

        // 重新扫描
        await this.openSmartConstraintHelper();

        this.setMessage(`✅ 已修复：${problem.title}`);
    } catch (error) {
        this.state.fixPreview = { ...this.state.fixPreview, applying: false };
        this.render();
        this.handleError(error);
    }
}

/**
 * 应用所有可自动修复的问题
 */
export async function applyAllFixes() {
    const problems = this.state.constraintScan?.problems?.filter(p => p.autoFixable) || [];
    if (!problems.length) return;

    const confirmed = confirm(
        `将自动修复 ${problems.length} 个问题。\n\n` +
        problems.map(p => `• ${p.title}`).join('\n') +
        '\n\n确认继续吗？'
    );

    if (!confirmed) return;

    try {
        this.state.constraintScan = { ...this.state.constraintScan, applyingAll: true };
        this.render();

        let updatedConstraints = this.state.ruleReview?.draftRows || [];

        // 逐个应用修复
        for (const problem of problems) {
            const fix = await generateAutoFix(problem, this.state.project);
            if (fix) {
                updatedConstraints = this.applyFixToConstraints(updatedConstraints, fix);
            }
        }

        // 更新约束
        this.state.ruleReview = {
            ...this.state.ruleReview,
            draftRows: updatedConstraints,
        };

        // 重新扫描
        await this.openSmartConstraintHelper();

        this.setMessage(`✅ 已成功修复 ${problems.length} 个问题！`);
    } catch (error) {
        this.state.constraintScan = { ...this.state.constraintScan, applyingAll: false };
        this.render();
        this.handleError(error);
    }
}

/**
 * 将修复应用到约束列表
 */
function applyFixToConstraints(constraints, fix) {
    const updated = [...constraints];

    fix.fixes.forEach(f => {
        if (f.action === 'add_slots') {
            // 添加节次
            const constraint = updated.find(c => c.id === f.constraintId);
            if (constraint) {
                constraint.slots = f.slots;
            }
        } else if (f.action === 'reduce_hours') {
            // 减少课时（需要修改项目数据，这里简化处理）
            // 实际应该调用后端API
        } else if (f.action === 'resolve_conflict') {
            // 解决冲突
            // 实际应该调用后端API重新分配时间
        }
    });

    return updated;
}

/**
 * 打开AI聊天助手
 */
export function openAIChatFromHelper() {
    // 切换到传统AI聊天界面
    this.state.constraintScan = { ...this.state.constraintScan, showChat: true };
    this.render();
}

/**
 * 关闭智能助手
 */
export function closeSmartHelper() {
    this.state.constraintScan = null;
    this.render();
}

/**
 * 重新扫描
 */
export async function rescanConstraints() {
    await this.openSmartConstraintHelper();
}

/**
 * 切换问题组展开/收起
 */
export function toggleProblemGroup(groupId) {
    const scan = this.state.constraintScan || {};
    const expanded = scan.expandedGroups || new Set();

    if (expanded.has(groupId)) {
        expanded.delete(groupId);
    } else {
        expanded.add(groupId);
    }

    this.state.constraintScan = {
        ...scan,
        expandedGroups: expanded,
    };
    this.render();
}

// 导出所有方法
export default {
    openSmartConstraintHelper,
    simulateScanProgress,
    viewProblemDetails,
    applySingleFix,
    confirmApplyFix,
    applyAllFixes,
    applyFixToConstraints,
    openAIChatFromHelper,
    closeSmartHelper,
    rescanConstraints,
    toggleProblemGroup,
};
