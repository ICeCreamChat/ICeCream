/**
 * 统一的排课数据验证服务
 * 解决验证逻辑分散在前后端多处的问题
 */

import {
    getActivePeriods,
    getActiveWeekdays,
    normalizeTimetableProject,
} from './timetable-project.js';

/**
 * 验证错误类
 */
export class TimetableValidationError extends Error {
    constructor(code, message, severity = 'error', details = {}) {
        super(message);
        this.name = 'TimetableValidationError';
        this.code = code;
        this.severity = severity; // 'error', 'warning', 'info'
        this.details = details;
    }
}

/**
 * 错误代码常量
 */
export const ValidationErrorCodes = {
    // 数据缺失
    MISSING_CLASSES: 'MISSING_CLASSES',
    MISSING_TEACHERS: 'MISSING_TEACHERS',
    MISSING_SUBJECTS: 'MISSING_SUBJECTS',
    MISSING_LESSON_PLANS: 'MISSING_LESSON_PLANS',
    MISSING_ACTIVE_RANGE: 'MISSING_ACTIVE_RANGE',

    // 数据不一致
    INVALID_REFERENCE: 'INVALID_REFERENCE',
    DUPLICATE_ID: 'DUPLICATE_ID',
    CAPACITY_OVERFLOW: 'CAPACITY_OVERFLOW',

    // 业务规则
    TEACHER_OVERLOAD: 'TEACHER_OVERLOAD',
    INVALID_BLOCK_SIZE: 'INVALID_BLOCK_SIZE',

    // 并发控制
    VERSION_CONFLICT: 'VERSION_CONFLICT',

    // 发布相关
    HARD_CONFLICTS_EXIST: 'HARD_CONFLICTS_EXIST',
    UNPLACED_LESSONS: 'UNPLACED_LESSONS',
};

/**
 * 统一验证服务类
 */
export class TimetableValidationService {
    /**
     * 求解前验证（最严格）
     */
    validateForSolve(project) {
        const normalized = normalizeTimetableProject(project);
        const errors = [];

        // 1. 基础数据完整性
        if (!normalized.classes.length) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.MISSING_CLASSES,
                '缺少班级数据，无法排课',
                'error'
            ));
        }

        if (!normalized.teachers.length) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.MISSING_TEACHERS,
                '缺少教师数据，无法排课',
                'error'
            ));
        }

        if (!normalized.subjects.length) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.MISSING_SUBJECTS,
                '缺少课程数据，无法排课',
                'error'
            ));
        }

        if (!normalized.lessonPlans.length) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.MISSING_LESSON_PLANS,
                '缺少任课关系，无法排课',
                'error'
            ));
        }

        // 2. 排课范围检查
        const activeWeekdays = getActiveWeekdays(normalized);
        const activePeriods = getActivePeriods(normalized);

        if (!activeWeekdays.length || !activePeriods.length) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.MISSING_ACTIVE_RANGE,
                '未设置可用的周几和节次范围',
                'error'
            ));
        }

        // 3. 引用完整性检查
        const classIds = new Set(normalized.classes.map(c => c.id));
        const teacherIds = new Set(normalized.teachers.map(t => t.id));
        const subjectIds = new Set(normalized.subjects.map(s => s.id));

        for (const plan of normalized.lessonPlans) {
            if (!classIds.has(plan.classId)) {
                errors.push(new TimetableValidationError(
                    ValidationErrorCodes.INVALID_REFERENCE,
                    `任课关系引用了不存在的班级：${plan.classId}`,
                    'error',
                    { lessonPlanId: plan.id, field: 'classId' }
                ));
            }

            if (!subjectIds.has(plan.subjectId)) {
                errors.push(new TimetableValidationError(
                    ValidationErrorCodes.INVALID_REFERENCE,
                    `任课关系引用了不存在的课程：${plan.subjectId}`,
                    'error',
                    { lessonPlanId: plan.id, field: 'subjectId' }
                ));
            }

            const planTeacherIds = Array.isArray(plan.teacherIds) && plan.teacherIds.length
                ? plan.teacherIds
                : [plan.teacherId].filter(Boolean);

            for (const tid of planTeacherIds) {
                if (!teacherIds.has(tid)) {
                    errors.push(new TimetableValidationError(
                        ValidationErrorCodes.INVALID_REFERENCE,
                        `任课关系引用了不存在的教师：${tid}`,
                        'error',
                        { lessonPlanId: plan.id, field: 'teacherId' }
                    ));
                }
            }
        }

        // 4. 容量检查
        const totalLessons = normalized.lessonPlans.reduce((sum, plan) =>
            sum + (Number(plan.weeklyHours) || 0), 0
        );
        const availableSlots = activeWeekdays.length * activePeriods.length * normalized.classes.length;

        if (totalLessons > availableSlots * 0.95) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.CAPACITY_OVERFLOW,
                `课时数(${totalLessons})超过可用时段(${availableSlots})的95%，排课困难`,
                'warning',
                { totalLessons, availableSlots, utilization: totalLessons / availableSlots }
            ));
        }

        const blockingErrors = errors.filter(e => e.severity === 'error');

        return {
            ok: blockingErrors.length === 0,
            errors,
            warnings: errors.filter(e => e.severity === 'warning'),
            reason: blockingErrors[0]?.code || null,
            message: blockingErrors[0]?.message || '数据验证通过',
            details: {
                totalErrors: blockingErrors.length,
                totalWarnings: errors.filter(e => e.severity === 'warning').length,
                stats: {
                    classes: normalized.classes.length,
                    teachers: normalized.teachers.length,
                    subjects: normalized.subjects.length,
                    lessonPlans: normalized.lessonPlans.length,
                    totalLessons,
                    availableSlots,
                }
            }
        };
    }

    /**
     * 发布前验证
     */
    validateForPublish(project) {
        const errors = [];
        const schedule = project?.schedule || {};

        // 1. 检查是否有课表
        if (!schedule.slots || !schedule.slots.length) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.MISSING_LESSON_PLANS,
                '没有可发布的课表',
                'error'
            ));
            return {
                ok: false,
                errors,
                reason: ValidationErrorCodes.MISSING_LESSON_PLANS,
                message: '没有可发布的课表'
            };
        }

        // 2. 检查硬冲突
        const hardConflicts = (schedule.conflicts || []).filter(c => c.severity === 'hard');
        if (hardConflicts.length > 0) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.HARD_CONFLICTS_EXIST,
                `存在${hardConflicts.length}个硬冲突，无法发布`,
                'error',
                { conflicts: hardConflicts }
            ));
        }

        // 3. 检查未放置的课节
        const unplaced = schedule.unplaced || [];
        if (unplaced.length > 0) {
            errors.push(new TimetableValidationError(
                ValidationErrorCodes.UNPLACED_LESSONS,
                `有${unplaced.length}节课未排入课表，无法发布`,
                'error',
                { unplaced }
            ));
        }

        // 4. 检查引用完整性（教师、班级是否还存在）
        const teacherIds = new Set((project.teachers || []).map(t => t.id));
        const classIds = new Set((project.classes || []).map(c => c.id));

        for (const slot of schedule.slots) {
            if (slot.teacherId && !teacherIds.has(slot.teacherId)) {
                errors.push(new TimetableValidationError(
                    ValidationErrorCodes.INVALID_REFERENCE,
                    `课表中引用了已删除的教师：${slot.teacherId}`,
                    'error',
                    { slotId: slot.id }
                ));
            }

            if (slot.classId && !classIds.has(slot.classId)) {
                errors.push(new TimetableValidationError(
                    ValidationErrorCodes.INVALID_REFERENCE,
                    `课表中引用了已删除的班级：${slot.classId}`,
                    'error',
                    { slotId: slot.id }
                ));
            }
        }

        const blockingErrors = errors.filter(e => e.severity === 'error');

        return {
            ok: blockingErrors.length === 0,
            errors,
            reason: blockingErrors[0]?.code || null,
            message: blockingErrors[0]?.message || '课表可以发布',
            details: {
                totalSlots: schedule.slots.length,
                hardConflicts: hardConflicts.length,
                unplaced: unplaced.length,
            }
        };
    }

    /**
     * 版本冲突检查
     */
    checkVersionConflict(incomingProject, currentProject) {
        if (!incomingProject.version || !currentProject.version) {
            return { hasConflict: false };
        }

        if (incomingProject.version !== currentProject.version) {
            return {
                hasConflict: true,
                error: new TimetableValidationError(
                    ValidationErrorCodes.VERSION_CONFLICT,
                    '项目已被其他用户或会话修改，请刷新后重试',
                    'error',
                    {
                        incomingVersion: incomingProject.version,
                        currentVersion: currentProject.version,
                        updatedAt: currentProject.updatedAt,
                    }
                )
            };
        }

        return { hasConflict: false };
    }
}

// 导出单例
export const validationService = new TimetableValidationService();
