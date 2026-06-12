import { auditTimetableProject, validateTimetableProjectForSolve } from '../../timetable-scheduler.js';
import { diagnoseTimetableRules } from '../../timetable-rule-parser.js';
import {
    makeTimetableAgentActionId,
    makeTimetableAgentArtifactId,
} from '../timetable-agent-state.js';

export function runDiagnosisSkill({
    project,
    rules = [],
    solveResult = null,
    lastFailure = null,
    recentDraftRows = [],
} = {}) {
    const validation = validateTimetableProjectForSolve(project);
    const audit = auditTimetableProject(project);
    const ruleDiagnosis = diagnoseTimetableRules({
        project,
        draftRows: recentDraftRows,
        solverFailure: solveResult?.diagnosticsInput || lastFailure || null,
    });
    const blockingRules = [
        ...((ruleDiagnosis.conflicts || []).filter(item => item.severity === 'blocking' || item.blocking)),
        ...(validation.ok ? [] : [{ type: validation.reason, message: validation.message, details: validation.details || {} }]),
        ...(audit.blockingIssues || []),
    ];
    const suggestedRelaxations = (ruleDiagnosis.suggestedRelaxations || []).map(item => ({
        risk: item.risk || 'low',
        ...item,
    }));
    const summary = blockingRules.length
        ? `发现 ${blockingRules.length} 个阻塞项，需要先处理后再求解。`
        : '未发现阻塞项，可继续尝试求解或优化。';
    const nextTryPlan = {
        action: blockingRules.length ? 'fix_data_or_rules' : 'retry_solve',
        solverPreference: 'local_only',
        strategy: 'balanced',
        timeLimitSeconds: 30,
        fallback: 'local_scheduler',
        reason: blockingRules.length
            ? '诊断发现阻塞项，先修复数据或规则后再重试。'
            : '诊断后重试：先使用本地确定性排课兜底，再按当前配置继续优化。',
    };
    const approvalQueue = !blockingRules.length && !(ruleDiagnosis.questions || []).length
        ? [{
            id: makeTimetableAgentActionId('execute_solve'),
            type: 'execute_solve',
            title: '按诊断建议重试排课',
            description: '当前没有阻塞项，确认后会再次调用确定性排课流程。',
            risk: 'medium',
            requiresApproval: true,
            payload: { solvePlan: nextTryPlan },
        }]
        : [];
    const artifact = {
        id: makeTimetableAgentArtifactId('diagnosis'),
        type: 'diagnosis',
        title: '排课诊断',
        summary,
        blockingRules,
        suggestedRelaxations,
        questions: ruleDiagnosis.questions || [],
        nextTryPlan,
        approvalQueue,
        warnings: [
            ...(ruleDiagnosis.warnings || []),
            ...(audit.warnings || []),
        ],
        rules,
    };
    return {
        summary,
        blockingRules,
        suggestedRelaxations,
        questions: artifact.questions,
        nextTryPlan: artifact.nextTryPlan,
        approvalQueue,
        warnings: artifact.warnings,
        artifacts: [artifact],
        nextAction: artifact.questions.length ? 'ask_user' : blockingRules.length ? 'failed' : 'await_approval',
    };
}
