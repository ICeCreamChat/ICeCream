import { getRosterStats } from '../selectors.js';

export const SMART_WORKBENCH_STAGES = Object.freeze([
    'idle',
    'checking_data',
    'data_need_fix',
    'ready_for_constraints',
    'parsing_constraints',
    'reviewing_constraints',
    'waiting_user_confirmation',
    'building_solve_plan',
    'waiting_solve_approval',
    'solving',
    'solution_review',
    'diagnosing',
    'finished',
    'failed',
]);

const TRANSITIONS = Object.freeze({
    idle: ['checking_data', 'ready_for_constraints'],
    checking_data: ['data_need_fix', 'ready_for_constraints', 'failed'],
    data_need_fix: ['checking_data', 'ready_for_constraints'],
    ready_for_constraints: ['checking_data', 'parsing_constraints', 'reviewing_constraints', 'building_solve_plan'],
    parsing_constraints: ['ready_for_constraints', 'reviewing_constraints', 'waiting_user_confirmation', 'failed'],
    reviewing_constraints: ['ready_for_constraints', 'waiting_user_confirmation', 'building_solve_plan', 'finished', 'failed'],
    waiting_user_confirmation: ['reviewing_constraints', 'ready_for_constraints', 'building_solve_plan', 'failed'],
    building_solve_plan: ['waiting_solve_approval', 'diagnosing', 'failed'],
    waiting_solve_approval: ['reviewing_constraints', 'solving', 'failed'],
    solving: ['solution_review', 'diagnosing', 'failed'],
    solution_review: ['reviewing_constraints', 'finished', 'diagnosing'],
    diagnosing: ['reviewing_constraints', 'building_solve_plan', 'failed'],
    finished: ['ready_for_constraints', 'reviewing_constraints', 'checking_data'],
    failed: ['ready_for_constraints', 'reviewing_constraints', 'checking_data'],
});

const RECOVERY_STAGE = Object.freeze({
    checking_data: 'idle',
    parsing_constraints: 'ready_for_constraints',
    building_solve_plan: 'reviewing_constraints',
    solving: 'waiting_solve_approval',
    diagnosing: 'reviewing_constraints',
});

export function createSmartWorkbenchState(overrides = {}) {
    return {
        open: false,
        stage: 'idle',
        previousStage: '',
        recoveryStage: 'ready_for_constraints',
        sourceMode: 'text',
        selectedSection: 'ready',
        selectedRuleId: '',
        dataAudit: null,
        ruleChangePreview: null,
        solvePlan: null,
        candidates: [],
        activeCandidateId: '',
        diagnosis: null,
        busy: false,
        error: '',
        renderVersion: 0,
        ...overrides,
    };
}

export function buildSmartDataAudit(project = {}) {
    const stats = getRosterStats(project);
    const lessonPlans = project.lessonPlans || [];
    const classIds = new Set((project.classes || []).map(item => item.id));
    const teacherIds = new Set((project.teachers || []).map(item => item.id));
    const subjectIds = new Set((project.subjects || []).map(item => item.id));
    const issues = [];
    const invalidReferences = [];
    const missingTeacherPlans = [];
    const invalidHourPlans = [];

    if (!stats.classCount) issues.push('还没有班级数据');
    if (!stats.teacherCount) issues.push('还没有教师数据');
    if (!stats.subjectCount) issues.push('还没有课程数据');
    if (!stats.planCount) issues.push('还没有任课关系');
    if (!stats.totalLessons) issues.push('周课时还没有填写完整');

    for (const plan of lessonPlans) {
        const teacherList = Array.isArray(plan.teacherIds) && plan.teacherIds.length
            ? plan.teacherIds
            : [plan.teacherId].filter(Boolean);
        if (!classIds.has(plan.classId) || !subjectIds.has(plan.subjectId)
            || teacherList.some(teacherId => !teacherIds.has(teacherId))) {
            invalidReferences.push(plan.id || `${plan.classId || ''}-${plan.subjectId || ''}`);
        }
        if (!teacherList.length) missingTeacherPlans.push(plan.id || `${plan.classId || ''}-${plan.subjectId || ''}`);
        if (Number(plan.weeklyHours || 0) <= 0) invalidHourPlans.push(plan.id || `${plan.classId || ''}-${plan.subjectId || ''}`);
    }

    if (invalidReferences.length) issues.push(`${invalidReferences.length} 条任课关系引用了不存在的班级、课程或教师`);
    if (missingTeacherPlans.length) issues.push(`${missingTeacherPlans.length} 条任课关系还没有选择教师`);
    if (invalidHourPlans.length) issues.push(`${invalidHourPlans.length} 条任课关系的周课时不是有效数字`);

    return {
        stats: {
            ...stats,
            invalidReferenceCount: invalidReferences.length,
            missingTeacherCount: missingTeacherPlans.length,
            invalidHourCount: invalidHourPlans.length,
        },
        issues,
        canContinue: issues.length === 0,
        checkedAt: new Date().toISOString(),
    };
}

function hasBlockingDataIssue(project = {}) {
    return !buildSmartDataAudit(project).canContinue;
}

export function deriveSmartWorkbenchStage(state = {}) {
    const review = state.ruleReview || {};
    const current = state.smartWorkbench || {};
    if (current.busy && current.stage === 'solving') return 'solving';
    if (review.loading) return 'parsing_constraints';
    if (current.ruleChangePreview) return 'waiting_user_confirmation';
    if (current.solvePlan && !current.busy) return 'waiting_solve_approval';
    if (current.diagnosis) return 'diagnosing';
    if ((current.candidates || []).length) return 'solution_review';
    const rows = review.draftRows || [];
    if (rows.some(row => ['needs_review', 'invalid'].includes(row.status))
        || (review.clarifyingQuestions || []).length
        || (review.conflicts || []).some(item => item.level === 'blocking')) {
        return 'waiting_user_confirmation';
    }
    if (rows.length) return 'reviewing_constraints';
    if (hasBlockingDataIssue(state.project)) return 'data_need_fix';
    return 'ready_for_constraints';
}

export function transitionSmartWorkbench(current = {}, nextStage = '', patch = {}) {
    const state = createSmartWorkbenchState(current);
    if (!SMART_WORKBENCH_STAGES.includes(nextStage)) {
        return {
            ...state,
            error: `未知的工作台阶段：${nextStage || '空'}`,
        };
    }
    if (nextStage === state.stage) return { ...state, ...patch };
    if (!(TRANSITIONS[state.stage] || []).includes(nextStage)) {
        return {
            ...state,
            error: `当前步骤不能直接进入“${nextStage}”，请按提示完成上一项。`,
        };
    }
    return {
        ...state,
        ...patch,
        previousStage: state.stage,
        stage: nextStage,
        recoveryStage: nextStage === 'failed'
            ? patch.recoveryStage || RECOVERY_STAGE[state.stage] || 'ready_for_constraints'
            : state.recoveryStage,
        busy: ['checking_data', 'parsing_constraints', 'building_solve_plan', 'solving'].includes(nextStage),
        error: patch.error || '',
    };
}

export function recoverSmartWorkbench(current = {}) {
    const state = createSmartWorkbenchState(current);
    return {
        ...state,
        previousStage: state.stage,
        stage: state.recoveryStage || 'ready_for_constraints',
        busy: false,
        error: '',
    };
}
