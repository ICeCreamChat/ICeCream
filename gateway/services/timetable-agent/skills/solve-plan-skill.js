import {
    auditTimetableProject,
    validateTimetableProjectForSolve,
} from '../../timetable-scheduler.js';
import {
    makeTimetableAgentActionId,
    makeTimetableAgentArtifactId,
} from '../timetable-agent-state.js';

function solverPreference(env = {}) {
    return String(env.TIMEFOLD_SOLVER_URL || '').trim()
        ? 'timefold_then_local'
        : 'local_only';
}

export function runSolvePlanSkill({ project, userPreference = '', dataQuality = null, ruleReview = null, env = process.env } = {}) {
    const validation = validateTimetableProjectForSolve(project);
    const audit = auditTimetableProject(project);
    const blocking = [
        ...(validation.ok ? [] : [{
            type: validation.reason,
            message: validation.message,
            details: validation.details || {},
        }]),
        ...(audit.blockingIssues || []),
    ];

    const solvePlan = {
        solverPreference: solverPreference(env),
        strategy: /质量|均衡|更好|优化/.test(userPreference) ? 'quality' : 'balanced',
        timeLimitSeconds: 30,
        hardRules: Object.keys(project.rules?.hardRules || {}),
        softRules: Object.keys(project.rules?.softRules || {}),
        prechecks: blocking,
        fallback: 'local_scheduler',
        reason: blocking.length
            ? '当前存在阻塞问题，需要先诊断或补齐数据。'
            : '先使用确定性本地校验确认可排，再按配置尝试 Timefold 或本地求解。',
    };

    const artifact = {
        id: makeTimetableAgentArtifactId('solve_plan'),
        type: 'solve_plan',
        title: '求解计划',
        ...solvePlan,
        dataQuality,
        ruleReview,
    };

    if (blocking.length) {
        return {
            solvePlan,
            questions: [],
            approvalRequired: false,
            artifacts: [artifact],
            approvalQueue: [],
            warnings: blocking,
            nextAction: 'diagnose',
        };
    }

    return {
        solvePlan,
        questions: [],
        approvalRequired: true,
        artifacts: [artifact],
        approvalQueue: [{
            id: makeTimetableAgentActionId('execute_solve'),
            type: 'execute_solve',
            title: '执行求解计划',
            description: '确认后才会调用本地排课算法/Timefold 生成候选方案。',
            risk: 'medium',
            requiresApproval: true,
            payload: { solvePlan },
        }],
        warnings: [],
        nextAction: 'await_approval',
    };
}
