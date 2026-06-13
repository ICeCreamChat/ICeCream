/**
 * 智能约束自动扫描器
 * 打开弹窗时自动检测问题并生成修复建议
 */

/**
 * 约束类型分类
 * HARD: 必须修复的硬约束，违反会导致排课失败
 * SOFT: 建议优化的软约束，违反会影响排课质量但不阻塞
 */
const CONSTRAINT_TYPES = {
    HARD: ['time_conflicts', 'missing_slots'],
    SOFT: ['teacher_overload', 'uneven_distribution'],
};

/**
 * 自动扫描约束问题
 * @param {Object} constraints - 约束列表
 * @param {Object} project - 项目数据
 * @returns {Object} 扫描结果
 */
export async function autoScanConstraints(constraints, project) {
    const problems = [];

    // 并行执行所有约束检测
    const [
        conflicts,
        missingSlots,
        teacherOverload,
        unevenDistribution,
        unreasonable
    ] = await Promise.all([
        detectTimeConflicts(constraints),
        detectMissingSlots(constraints),
        detectTeacherOverload(constraints, project),
        detectUnevenDistribution(constraints, project),
        detectUnreasonableConstraints(constraints, project)
    ]);

    // 1. 检测时间冲突（硬约束）
    if (conflicts.length > 0) {
        problems.push({
            id: 'time_conflicts',
            type: 'HARD',
            severity: 'urgent',
            title: `发现 ${conflicts.length} 处时间冲突`,
            description: conflicts.map(c => c.description).join('、'),
            icon: 'triangle-alert',
            color: '#ef4444',
            count: conflicts.length,
            conflicts: conflicts,
            autoFixable: true,
            fixSuggestion: '自动调整冲突的时间',
        });
    }

    // 2. 检测缺少节次的约束（硬约束）
    if (missingSlots.length > 0) {
        problems.push({
            id: 'missing_slots',
            type: 'HARD',
            severity: 'urgent',
            title: `有 ${missingSlots.length} 条约束还没安排具体时间`,
            description: '比如"王老师周三下午不排课"，但没说是第几节',
            icon: 'calendar-clock',
            color: '#ef4444',
            count: missingSlots.length,
            constraints: missingSlots,
            autoFixable: true,
            fixSuggestion: '让AI自动推荐合适的时段',
        });
    }

    // 3. 检测教师工作量超标（软约束）
    if (teacherOverload.length > 0) {
        problems.push({
            id: 'teacher_overload',
            type: 'SOFT',
            severity: 'optimize',
            title: `${teacherOverload.length} 位教师每天课太多了`,
            description: teacherOverload.map(t => `${t.name}每天${t.current}节课`).join('、'),
            icon: 'user-x',
            color: '#f59e0b',
            count: teacherOverload.length,
            teachers: teacherOverload,
            autoFixable: true,
            fixSuggestion: '建议减少到每天4-5节',
        });
    }

    // 4. 检测课程分布不均（软约束）
    if (unevenDistribution.length > 0) {
        problems.push({
            id: 'uneven_distribution',
            type: 'SOFT',
            severity: 'optimize',
            title: '有些课程都集中在同一天了',
            description: unevenDistribution.map(s => `${s.subject}${s.days}`).join('、'),
            icon: 'calendar-range',
            color: '#f59e0b',
            count: unevenDistribution.length,
            subjects: unevenDistribution,
            autoFixable: true,
            fixSuggestion: '自动分散到不同天',
        });
    }

    // 5. 检测不合理的约束（信息提示）
    if (unreasonable.length > 0) {
        problems.push({
            id: 'unreasonable',
            type: 'INFO',
            severity: 'info',
            title: '有些约束可能不太合理',
            description: unreasonable.map(u => u.reason).join('、'),
            icon: 'info',
            color: '#3b82f6',
            count: unreasonable.length,
            constraints: unreasonable,
            autoFixable: false,
            fixSuggestion: '建议和AI助手讨论',
        });
    }

    // 按严重程度排序：硬约束 > 软约束 > 信息提示
    const severityOrder = { urgent: 0, optimize: 1, info: 2 };
    problems.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // 计算完成度
    const totalIssues = problems.reduce((sum, p) => sum + p.count, 0);
    const autoFixableIssues = problems
        .filter(p => p.autoFixable)
        .reduce((sum, p) => sum + p.count, 0);
    const hardConstraintIssues = problems
        .filter(p => p.type === 'HARD')
        .reduce((sum, p) => sum + p.count, 0);

    return {
        problems,
        stats: {
            total: totalIssues,
            hard: hardConstraintIssues,
            urgent: problems.filter(p => p.severity === 'urgent').reduce((s, p) => s + p.count, 0),
            optimize: problems.filter(p => p.severity === 'optimize').reduce((s, p) => s + p.count, 0),
            info: problems.filter(p => p.severity === 'info').reduce((s, p) => s + p.count, 0),
            autoFixable: autoFixableIssues,
            completeness: totalIssues === 0 ? 100 : Math.max(0, 100 - totalIssues * 5),
        },
        timestamp: Date.now(),
    };
}

/**
 * 检测缺少节次的约束
 */
async function detectMissingSlots(constraints) {
    return constraints.filter(c =>
        needsSlots(c.type) && (!c.slots || c.slots.length === 0)
    );
}

/**
 * 检测教师工作量超标
 */
async function detectTeacherOverload(constraints, project) {
    const teacherHours = new Map();

    // 统计每个教师的课时
    (project.lessonPlans || []).forEach(plan => {
        const current = teacherHours.get(plan.teacherId) || 0;
        teacherHours.set(plan.teacherId, current + (plan.weeklyHours || 0));
    });

    const overloaded = [];
    const teacherMap = new Map((project.teachers || []).map(t => [t.id, t]));

    teacherHours.forEach((hours, teacherId) => {
        const teacher = teacherMap.get(teacherId);
        if (!teacher) return;

        // 每天超过6节算超标
        const dailyAverage = hours / 5;
        if (dailyAverage > 6) {
            overloaded.push({
                id: teacherId,
                name: teacher.name,
                current: Math.ceil(dailyAverage),
                recommended: 5,
                weeklyTotal: hours,
            });
        }
    });

    return overloaded;
}

/**
 * 检测课程分布不均
 */
async function detectUnevenDistribution(constraints, project) {
    // 简化实现：检测同一课程的课节是否过于集中
    const subjectDays = new Map();

    // 这里需要基于实际排课结果分析
    // 暂时返回空数组
    return [];
}

/**
 * 检测时间冲突
 */
async function detectTimeConflicts(constraints) {
    const conflicts = [];
    const slotMap = new Map();

    constraints.forEach(constraint => {
        if (!constraint.slots) return;

        constraint.slots.forEach(slot => {
            const key = `${constraint.targetType}_${constraint.targetId}_${slot}`;

            if (slotMap.has(key)) {
                const existing = slotMap.get(key);
                conflicts.push({
                    description: `${constraint.targetName}在${slot}有冲突`,
                    constraints: [existing, constraint],
                    slot: slot,
                });
            }

            slotMap.set(key, constraint);
        });
    });

    return conflicts;
}

/**
 * 检测不合理的约束
 */
async function detectUnreasonableConstraints(constraints, project) {
    const unreasonable = [];

    constraints.forEach(constraint => {
        // 检测不合理的daily_limit
        if (constraint.type === 'teacher_daily_limit' && constraint.value > 7) {
            unreasonable.push({
                constraint,
                reason: `${constraint.targetName}每天${constraint.value}节课太多了`,
                suggestion: '建议不超过6节',
            });
        }

        // 检测不合理的consecutive_limit
        if (constraint.type === 'teacher_consecutive_limit' && constraint.value > 4) {
            unreasonable.push({
                constraint,
                reason: `${constraint.targetName}连续${constraint.value}节课太累了`,
                suggestion: '建议不超过3节',
            });
        }
    });

    return unreasonable;
}

/**
 * 检查约束类型是否需要节次
 */
function needsSlots(type) {
    return [
        'teacher_unavailable',
        'class_unavailable',
        'locked_slot',
        'subject_preferred_periods',
        'subject_avoid_periods',
    ].includes(type);
}

/**
 * 生成自动修复方案
 */
export async function generateAutoFix(problem, project) {
    switch (problem.id) {
        case 'missing_slots':
            return generateMissingSlotsFix(problem, project);

        case 'teacher_overload':
            return generateTeacherOverloadFix(problem, project);

        case 'uneven_distribution':
            return generateDistributionFix(problem, project);

        case 'time_conflicts':
            return generateConflictFix(problem, project);

        default:
            return null;
    }
}

/**
 * 生成缺少节次的修复方案
 */
function generateMissingSlotsFix(problem, project) {
    const fixes = problem.constraints.map(constraint => {
        // 根据约束类型推荐合适的时段
        let recommendedSlots = [];

        if (constraint.type === 'teacher_unavailable') {
            // 推荐该教师的空闲时段
            recommendedSlots = ['1-1', '1-2', '1-3']; // 简化示例
        }

        return {
            constraintId: constraint.id,
            action: 'add_slots',
            slots: recommendedSlots,
            reason: '基于教师空闲时段推荐',
        };
    });

    return {
        problemId: problem.id,
        fixes,
        preview: {
            before: `${problem.count}条约束缺少时间`,
            after: `将自动填充推荐时段`,
        },
    };
}

/**
 * 生成教师超载的修复方案
 */
function generateTeacherOverloadFix(problem, project) {
    const fixes = problem.teachers.map(teacher => ({
        teacherId: teacher.id,
        action: 'reduce_hours',
        from: teacher.current,
        to: teacher.recommended,
        reason: `将${teacher.name}的课从每天${teacher.current}节减到${teacher.recommended}节`,
    }));

    return {
        problemId: problem.id,
        fixes,
        preview: {
            before: `${problem.teachers.map(t => t.name).join('、')}课时过多`,
            after: `调整到合理范围`,
        },
    };
}

/**
 * 生成分布不均的修复方案
 */
function generateDistributionFix(problem, project) {
    // 实现课程分散逻辑
    return null;
}

/**
 * 生成冲突的修复方案
 */
function generateConflictFix(problem, project) {
    const fixes = problem.conflicts.map(conflict => ({
        action: 'resolve_conflict',
        slot: conflict.slot,
        constraints: conflict.constraints.map(c => c.id),
        reason: `自动调整冲突的时间`,
    }));

    return {
        problemId: problem.id,
        fixes,
        preview: {
            before: `${problem.count}处时间冲突`,
            after: `自动调整到其他时段`,
        },
    };
}
