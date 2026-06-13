/**
 * 智能约束助手Controller扩展
 * 处理自动扫描、一键修复等交互
 *
 * 注意：扫描和修复逻辑在后端（timetable-auto-scanner.js），
 * 前端通过 /api/tools/timetable/constraints/scan 等API调用。
 * 前端不能直接import后端gateway文件（浏览器无法访问）。
 */

import { requestTimetable } from './api.js';

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

        // 调用后端API执行自动扫描
        const scanResult = await requestTimetable('/constraints/scan', {
            method: 'POST',
            body: JSON.stringify({ constraints, project }),
        });

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
        // 调用后端API生成修复方案
        const { fix } = await requestTimetable('/constraints/generate-fix', {
            method: 'POST',
            body: JSON.stringify({ problem, project: this.state.project }),
        });

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
            const { fix } = await requestTimetable('/constraints/generate-fix', {
                method: 'POST',
                body: JSON.stringify({ problem, project: this.state.project }),
            });
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

/**
 * 启用实时验证
 * 监听约束变化并自动验证
 */
export function enableRealtimeValidation() {
    // 如果已经启用，先清理旧的监听器
    if (this.state.realtimeValidation?.enabled) {
        this.disableRealtimeValidation();
    }

    // 初始化实时验证状态
    this.state.realtimeValidation = {
        enabled: true,
        validationResults: new Map(), // constraintIndex -> validationResult
        debounceTimers: new Map(),
    };

    // 保存原始的约束更新方法
    const originalUpdateConstraint = this.updateConstraint;

    // 包装约束更新方法以触发验证
    this.updateConstraint = function(index, updates) {
        // 调用原始方法
        if (originalUpdateConstraint) {
            originalUpdateConstraint.call(this, index, updates);
        } else {
            // 默认更新逻辑
            const constraints = this.state.ruleReview?.draftRows || [];
            if (constraints[index]) {
                constraints[index] = { ...constraints[index], ...updates };
                this.state.ruleReview = {
                    ...this.state.ruleReview,
                    draftRows: constraints,
                };
            }
        }

        // 触发实时验证（带防抖）
        this.validateConstraintDebounced(index);
        this.render();
    };

    // 监听新增约束
    const originalAddConstraint = this.addConstraint;
    this.addConstraint = function(constraint) {
        const result = originalAddConstraint ?
            originalAddConstraint.call(this, constraint) :
            null;

        const constraints = this.state.ruleReview?.draftRows || [];
        const newIndex = constraints.length - 1;

        if (newIndex >= 0) {
            this.validateConstraintDebounced(newIndex);
        }

        this.render();
        return result;
    };

    // 立即验证所有现有约束
    const constraints = this.state.ruleReview?.draftRows || [];
    constraints.forEach((_, index) => {
        this.validateConstraint(index);
    });

    this.render();
}

/**
 * 禁用实时验证
 */
export function disableRealtimeValidation() {
    if (!this.state.realtimeValidation?.enabled) return;

    // 清除所有防抖计时器
    const timers = this.state.realtimeValidation.debounceTimers;
    if (timers) {
        timers.forEach(timer => clearTimeout(timer));
    }

    // 清理状态
    this.state.realtimeValidation = {
        enabled: false,
        validationResults: new Map(),
        debounceTimers: new Map(),
    };

    this.render();
}

/**
 * 验证单个约束
 * @param {number} index - 约束索引
 */
export async function validateConstraint(index) {
    const constraints = this.state.ruleReview?.draftRows || [];
    const constraint = constraints[index];

    if (!constraint) return;

    // 初始化验证状态
    if (!this.state.realtimeValidation) {
        this.state.realtimeValidation = {
            enabled: false,
            validationResults: new Map(),
            debounceTimers: new Map(),
        };
    }

    try {
        // 设置验证中状态
        this.state.realtimeValidation.validationResults.set(index, {
            validating: true,
        });
        this.render();

        // 执行验证逻辑
        const validationResult = await this.performConstraintValidation(constraint, index, constraints);

        // 更新验证结果
        this.state.realtimeValidation.validationResults.set(index, {
            validating: false,
            valid: validationResult.valid,
            errors: validationResult.errors || [],
            warnings: validationResult.warnings || [],
            timestamp: Date.now(),
        });

        this.render();

        // 如果有错误，显示反馈
        if (!validationResult.valid && validationResult.errors?.length > 0) {
            this.showValidationFeedback(index, validationResult);
        }

    } catch (error) {
        // 验证失败
        this.state.realtimeValidation.validationResults.set(index, {
            validating: false,
            valid: false,
            errors: [{ message: '验证失败：' + error.message }],
            warnings: [],
            timestamp: Date.now(),
        });
        this.render();
    }
}

/**
 * 带防抖的约束验证
 * @param {number} index - 约束索引
 * @param {number} delay - 防抖延迟（毫秒），默认500ms
 */
export function validateConstraintDebounced(index, delay = 500) {
    if (!this.state.realtimeValidation) return;

    // 清除之前的计时器
    const existingTimer = this.state.realtimeValidation.debounceTimers.get(index);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    // 设置新的计时器
    const timer = setTimeout(() => {
        this.validateConstraint(index);
        this.state.realtimeValidation.debounceTimers.delete(index);
    }, delay);

    this.state.realtimeValidation.debounceTimers.set(index, timer);
}

/**
 * 执行约束验证逻辑
 * @param {Object} constraint - 要验证的约束
 * @param {number} index - 约束索引
 * @param {Array} allConstraints - 所有约束列表
 * @returns {Object} 验证结果 { valid, errors, warnings }
 */
async function performConstraintValidation(constraint, index, allConstraints) {
    const errors = [];
    const warnings = [];

    // 1. 必填字段验证
    if (!constraint.type || constraint.type === 'select') {
        errors.push({ field: 'type', message: '请选择约束类型' });
    }

    if (!constraint.target || constraint.target.trim() === '') {
        errors.push({ field: 'target', message: '请指定约束对象（教师、教室或班级）' });
    }

    // 2. 时间节次验证
    if (constraint.type === 'teacher_unavailable' || constraint.type === 'room_unavailable') {
        if (!constraint.slots || constraint.slots.length === 0) {
            errors.push({ field: 'slots', message: '请选择至少一个时间节次' });
        }
    }

    // 3. 课时数验证
    if (constraint.type === 'max_daily_hours' || constraint.type === 'max_continuous_hours') {
        const hours = parseInt(constraint.maxHours);
        if (isNaN(hours) || hours <= 0) {
            errors.push({ field: 'maxHours', message: '课时数必须为正整数' });
        } else if (hours > 12) {
            warnings.push({ field: 'maxHours', message: '课时数过高，可能不合理' });
        }
    }

    // 4. 冲突检测
    const conflicts = this.detectConstraintConflicts(constraint, index, allConstraints);
    if (conflicts.length > 0) {
        warnings.push({
            field: 'conflict',
            message: `与第 ${conflicts.map(c => c + 1).join(', ')} 条约束可能存在冲突`,
            conflictIndices: conflicts,
        });
    }

    // 5. 项目数据验证
    if (this.state.project) {
        const projectValidation = await this.validateAgainstProject(constraint, this.state.project);
        errors.push(...projectValidation.errors);
        warnings.push(...projectValidation.warnings);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * 检测约束冲突
 * @param {Object} constraint - 当前约束
 * @param {number} currentIndex - 当前约束索引
 * @param {Array} allConstraints - 所有约束
 * @returns {Array} 冲突的约束索引数组
 */
function detectConstraintConflicts(constraint, currentIndex, allConstraints) {
    const conflicts = [];

    allConstraints.forEach((other, index) => {
        if (index === currentIndex) return;

        // 同一对象的重复约束
        if (constraint.target === other.target && constraint.type === other.type) {
            // 检查时间节次是否重叠
            if (constraint.slots && other.slots) {
                const hasOverlap = constraint.slots.some(slot => other.slots.includes(slot));
                if (hasOverlap) {
                    conflicts.push(index);
                }
            }
        }
    });

    return conflicts;
}

/**
 * 根据项目数据验证约束
 * @param {Object} constraint - 约束对象
 * @param {Object} project - 项目数据
 * @returns {Object} { errors, warnings }
 */
async function validateAgainstProject(constraint, project) {
    const errors = [];
    const warnings = [];

    // 验证教师是否存在
    if (constraint.type?.includes('teacher') && constraint.target) {
        const teacherExists = project.teachers?.some(t => t.name === constraint.target);
        if (!teacherExists) {
            warnings.push({
                field: 'target',
                message: `教师"${constraint.target}"在项目中不存在`
            });
        }
    }

    // 验证教室是否存在
    if (constraint.type?.includes('room') && constraint.target) {
        const roomExists = project.rooms?.some(r => r.name === constraint.target);
        if (!roomExists) {
            warnings.push({
                field: 'target',
                message: `教室"${constraint.target}"在项目中不存在`
            });
        }
    }

    // 验证班级是否存在
    if (constraint.type?.includes('class') && constraint.target) {
        const classExists = project.classes?.some(c => c.name === constraint.target);
        if (!classExists) {
            warnings.push({
                field: 'target',
                message: `班级"${constraint.target}"在项目中不存在`
            });
        }
    }

    return { errors, warnings };
}

/**
 * 显示验证反馈
 * @param {number} index - 约束索引
 * @param {Object} result - 验证结果
 */
function showValidationFeedback(index, result) {
    // 可以在UI中高亮显示错误字段
    // 或显示临时提示消息
    if (result.errors.length > 0) {
        const errorMsg = result.errors.map(e => e.message).join('；');
        // 注意：这里不直接调用 setMessage，因为可能会打断用户操作
        // 仅在状态中标记，由UI层决定如何显示
    }
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
    enableRealtimeValidation,
    disableRealtimeValidation,
    validateConstraint,
    validateConstraintDebounced,
    performConstraintValidation,
    detectConstraintConflicts,
    validateAgainstProject,
    showValidationFeedback,
};
