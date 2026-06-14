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
    const startedAt = Date.now();
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
            autoFixableCount: conflicts.length,
            fixSuggestion: '自动调整冲突的时间',
        });
    }

    // 2. 检测缺少节次的约束（硬约束）
    if (missingSlots.length > 0) {
        const fixableMissingSlots = missingSlots.filter(constraint => inferConstraintSlots(constraint, project).length > 0);
        problems.push({
            id: 'missing_slots',
            type: 'HARD',
            severity: 'urgent',
            title: `有 ${missingSlots.length} 条约束还没安排具体时间`,
            description: fixableMissingSlots.length
                ? '已从原文中识别出部分周几、上午/下午或第几节，可先生成复核草稿。'
                : '这些约束缺少明确周几或节次，需要补充后才能生效。',
            icon: 'calendar-clock',
            color: '#ef4444',
            count: missingSlots.length,
            constraints: missingSlots,
            autoFixable: fixableMissingSlots.length > 0,
            autoFixableCount: fixableMissingSlots.length,
            fixSuggestion: fixableMissingSlots.length
                ? `可自动补齐 ${fixableMissingSlots.length} 条已能识别的时段`
                : '请在复核表或智能对话里补充具体时段',
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
            autoFixableCount: teacherOverload.length,
            fixSuggestion: '生成教师每日上限软规则草稿',
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
            fixSuggestion: '建议和智能助手讨论',
        });
    }

    // 按严重程度排序：硬约束 > 软约束 > 信息提示
    const severityOrder = { urgent: 0, optimize: 1, info: 2 };
    problems.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // 计算完成度
    const totalIssues = problems.reduce((sum, p) => sum + p.count, 0);
    const autoFixableIssues = problems
        .filter(p => p.autoFixable)
        .reduce((sum, p) => sum + (p.autoFixableCount ?? p.count), 0);
    const hardConstraintIssues = problems
        .filter(p => p.type === 'HARD')
        .reduce((sum, p) => sum + p.count, 0);

    const scanDuration = Date.now() - startedAt;
    const checksPerformed = 5;
    const completeness = totalIssues === 0 ? 100 : Math.max(0, 100 - totalIssues * 5);

    return {
        problems,
        stats: {
            total: totalIssues,
            hard: hardConstraintIssues,
            urgent: problems.filter(p => p.severity === 'urgent').reduce((s, p) => s + p.count, 0),
            optimize: problems.filter(p => p.severity === 'optimize').reduce((s, p) => s + p.count, 0),
            info: problems.filter(p => p.severity === 'info').reduce((s, p) => s + p.count, 0),
            autoFixable: autoFixableIssues,
            completeness,
            scanDuration,
            checksPerformed,
            complianceScore: completeness,
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

function activeWeekdays(project = {}) {
    const values = Array.isArray(project.activeWeekdays) && project.activeWeekdays.length
        ? project.activeWeekdays
        : [1, 2, 3, 4, 5];
    return values.map(Number).filter(Number.isFinite);
}

function activePeriods(project = {}) {
    const values = Array.isArray(project.activePeriods) && project.activePeriods.length
        ? project.activePeriods
        : Array.from({ length: Number(project.periodsPerDay || 7) || 7 }, (_, index) => index + 1);
    return values.map(Number).filter(Number.isFinite);
}

function periodsByHalf(project = {}, half = 'morning') {
    const periods = activePeriods(project);
    if (!periods.length) return [];
    const splitIndex = Math.ceil(periods.length / 2);
    return half === 'afternoon' ? periods.slice(splitIndex) : periods.slice(0, splitIndex);
}

function inferDays(text = '', project = {}) {
    const source = String(text || '');
    const dayMap = [
        [/周一|星期一|礼拜一|周1|星期1/, 1],
        [/周二|星期二|礼拜二|周2|星期2/, 2],
        [/周三|星期三|礼拜三|周3|星期3/, 3],
        [/周四|星期四|礼拜四|周4|星期4/, 4],
        [/周五|星期五|礼拜五|周5|星期5/, 5],
        [/周六|星期六|礼拜六|周6|星期6/, 6],
        [/周日|周天|星期日|星期天|礼拜日|礼拜天|周7|星期7/, 7],
    ];
    const days = dayMap.filter(([pattern]) => pattern.test(source)).map(([, day]) => day);
    return days.length ? days : activeWeekdays(project);
}

function inferPeriods(text = '', project = {}) {
    const source = String(text || '');
    const explicit = [...source.matchAll(/第\s*(\d{1,2})\s*节/g)]
        .map(match => Number(match[1]))
        .filter(Number.isFinite);
    if (explicit.length) return explicit.filter(period => activePeriods(project).includes(period));
    if (/上午|早上|前半天/.test(source)) return periodsByHalf(project, 'morning');
    if (/下午|后半天/.test(source)) return periodsByHalf(project, 'afternoon');
    return [];
}

function inferConstraintSlots(constraint = {}, project = {}) {
    const text = [
        constraint.rawText,
        constraint.description,
        constraint.notes,
        constraint.message,
    ].filter(Boolean).join(' ');
    const periods = inferPeriods(text, project);
    if (!periods.length) return [];
    const periodSet = new Set(activePeriods(project));
    return inferDays(text, project)
        .flatMap(day => periods.map(period => `${day}-${period}`))
        .filter(slot => {
            const [day, period] = slot.split('-').map(Number);
            return activeWeekdays(project).includes(day) && periodSet.has(period);
        });
}

function sameTarget(left = {}, right = {}) {
    return String(left.targetType || '') === String(right.targetType || '')
        && String(left.targetId || left.targetName || '') === String(right.targetId || right.targetName || '');
}

function usedSlotsForTarget(constraints = [], target = {}) {
    const used = new Set();
    constraints.forEach(constraint => {
        if (!sameTarget(constraint, target)) return;
        (constraint.slots || []).forEach(slot => used.add(slot));
    });
    return used;
}

function availableSlotForConstraint(constraint = {}, project = {}, constraints = []) {
    const used = usedSlotsForTarget(constraints, constraint);
    for (const day of activeWeekdays(project)) {
        for (const period of activePeriods(project)) {
            const slot = `${day}-${period}`;
            if (!used.has(slot)) return slot;
        }
    }
    return '';
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
    const fixes = problem.constraints
        .map(constraint => {
            const recommendedSlots = inferConstraintSlots(constraint, project);
            if (!recommendedSlots.length) return null;
            return {
            constraintId: constraint.id,
            action: 'set_slots',
            slots: recommendedSlots,
            reason: '根据原文里的周几、上午/下午或第几节补齐',
        };
        })
        .filter(Boolean);

    return {
        problemId: problem.id,
        fixes,
        preview: {
            before: `${problem.count}条约束缺少时间`,
            after: fixes.length ? `将补齐 ${fixes.length} 条可识别时段` : '没有足够信息可自动补齐',
        },
    };
}

/**
 * 生成教师超载的修复方案
 */
function generateTeacherOverloadFix(problem, project) {
    const fixes = problem.teachers.map(teacher => ({
        action: 'add_constraint',
        constraint: {
            id: `auto_teacher_daily_limit_${teacher.id}`,
            rawText: `${teacher.name}每天授课不超过${teacher.recommended}节`,
            type: 'teacher_daily_limit',
            targetType: 'teacher',
            targetId: teacher.id,
            targetName: teacher.name,
            value: teacher.recommended,
            limit: teacher.recommended,
            priority: 'soft',
            status: 'effective',
            confidence: 0.82,
            description: `建议限制${teacher.name}每日课时，缓解教师负载。`,
            warnings: [],
        },
        reason: `新增${teacher.name}每日不超过${teacher.recommended}节的软规则草稿`,
    }));

    return {
        problemId: problem.id,
        fixes,
        preview: {
            before: `${problem.teachers.map(t => t.name).join('、')}课时过多`,
            after: `生成教师每日上限软规则草稿`,
        },
    };
}

/**
 * 生成分布不均的修复方案
 */
function generateDistributionFix(problem, project) {
    // 实现课程分散逻辑
    return {
        problemId: problem.id,
        fixes: [],
        preview: {
            before: '课程分布集中',
            after: '该问题需要结合完整课表重新求解，暂不自动修改草稿',
        },
    };
}

/**
 * 生成冲突的修复方案
 */
function generateConflictFix(problem, project) {
    const allConstraints = problem.conflicts.flatMap(conflict => conflict.constraints || []);
    const fixes = problem.conflicts.map(conflict => {
        const [, duplicate] = conflict.constraints || [];
        if (!duplicate?.id) return null;
        const replacement = availableSlotForConstraint(duplicate, project, allConstraints);
        if (!replacement) {
            return {
                action: 'mark_needs_review',
                constraintId: duplicate.id,
                warning: `与其他规则在 ${conflict.slot} 冲突，请人工确认。`,
                reason: '没有找到可自动替换的空闲节次',
            };
        }
        return {
            action: 'replace_slot',
            constraintId: duplicate.id,
            from: conflict.slot,
            to: replacement,
            reason: `将重复节次 ${conflict.slot} 改为 ${replacement}`,
        };
    }).filter(Boolean);

    return {
        problemId: problem.id,
        fixes,
        preview: {
            before: `${problem.count}处时间冲突`,
            after: `自动调整到其他时段`,
        },
    };
}
