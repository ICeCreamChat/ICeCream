import { normalizeTimetableProject } from '../timetable-scheduler.js';
import {
    createTimetableAgentSessionState,
    getTimetableAgentState,
    requireTimetableAgentState,
    resetTimetableAgentState,
    saveTimetableAgentState,
    updateTimetableAgentPlan,
} from './timetable-agent-state.js';
import { runConstraintSkill, normalizeConstraintApproval } from './skills/constraint-skill.js';
import { runDataPrepSkill } from './skills/data-prep-skill.js';
import { runDiagnosisSkill } from './skills/diagnosis-skill.js';
import { runPublicationSkill } from './skills/publication-skill.js';
import { runSolvePlanSkill } from './skills/solve-plan-skill.js';
import { runSolveSkill } from './skills/solve-skill.js';

function stageReply(stage, nextAction, extra = {}) {
    if (stage === 'data_prep') {
        return nextAction === 'ask_user'
            ? '我先检查了当前排课数据，还需要补齐关键信息后才能继续。'
            : '当前排课数据已通过基础检查，可以继续复核约束或生成求解计划。';
    }
    if (stage === 'constraint_review') {
        return nextAction === 'ask_user'
            ? '我已解析排课要求，但有些对象需要你补充确认。'
            : '我已生成约束复核结果，高风险写入动作会等待你确认。';
    }
    if (stage === 'solve_planning') return '我已生成求解计划，确认后才会调用求解器。';
    if (stage === 'solving') return '我正在调用确定性求解器生成候选课表。';
    if (stage === 'solution_review') {
        return extra.status === 'failed'
            ? '求解没有得到可保存课表，我已生成诊断信息。'
            : '已生成候选课表，请复核评分、冲突和保存确认。';
    }
    if (stage === 'diagnosis') return '我已根据本地校验和求解结果生成诊断建议。';
    if (stage === 'finalize') return '保存动作已处理完成。';
    return '我可以帮你检查数据、复核约束、生成求解计划并调用本地排课能力。';
}

function classifyIntent(message = '') {
    const text = String(message || '').trim();
    if (/保存|发布|导出/.test(text)) return 'save';
    if (/诊断|失败|原因|为什么|排不出/.test(text)) return 'diagnose';
    if (/开始排课|生成课表|求解|排课/.test(text) && !/约束|要求|规则/.test(text)) return 'solve';
    if (/约束|规则|要求|没空|不可排|不排|尽量|优先|上午|下午|第\d+节|老师|教师/.test(text)) return 'constraint';
    if (/检查|数据|导入|任课|缺少|完整/.test(text)) return 'data_prep';
    return 'data_prep';
}

function responseFromSession(session, {
    reply = '',
    stage = session.stage,
    questions = [],
    approvalQueue = [],
    artifacts = [],
    warnings = [],
    errors = [],
    nextAction = 'continue',
    lastToolResults = [],
    project = null,
} = {}) {
    const next = saveTimetableAgentState({
        ...session,
        stage,
        questions,
        approvalQueue,
        artifacts: [...(session.artifacts || []), ...artifacts],
        warnings,
        errors,
        lastToolResults,
        plan: updateTimetableAgentPlan(session.plan || [], stage),
    });
    return {
        sessionId: next.sessionId,
        reply: reply || stageReply(stage, nextAction),
        stage,
        plan: next.plan,
        questions: next.questions,
        approvalQueue: next.approvalQueue,
        artifacts: next.artifacts,
        lastToolResults: next.lastToolResults,
        warnings: next.warnings,
        errors: next.errors,
        ...(project ? { project } : {}),
        nextAction,
    };
}

function appendMessage(session, role, content) {
    return {
        ...session,
        messages: [
            ...(session.messages || []),
            { role, content: String(content || ''), createdAt: new Date().toISOString() },
        ],
    };
}

function currentProject(session, project) {
    return normalizeTimetableProject(project || session.projectSnapshot || {});
}

async function runDataPrep(session, project) {
    const result = runDataPrepSkill({ project });
    return responseFromSession(session, {
        stage: 'data_prep',
        questions: result.questions,
        approvalQueue: [],
        artifacts: result.artifacts,
        warnings: result.warnings,
        nextAction: result.nextAction,
        lastToolResults: [{ tool: 'project.validate', status: result.nextAction === 'failed' ? 'error' : 'success' }],
    });
}

async function runConstraint(session, project, { message = '', previousResult = null, answers = [], env, fetchImpl } = {}) {
    const result = await runConstraintSkill({
        project,
        text: message,
        previousResult,
        answers,
        env,
        fetchImpl,
    });
    return responseFromSession(session, {
        stage: 'constraint_review',
        questions: result.questions,
        approvalQueue: result.approvalQueue,
        artifacts: result.artifacts,
        warnings: result.warnings,
        nextAction: result.nextAction,
        lastToolResults: [{ tool: 'rules.parse', status: 'success' }],
    });
}

async function runSolvePlan(session, project, { message = '', env } = {}) {
    const data = runDataPrepSkill({ project });
    if (data.nextAction !== 'continue') {
        return responseFromSession(session, {
            stage: 'data_prep',
            questions: data.questions,
            approvalQueue: [],
            artifacts: data.artifacts,
            warnings: data.warnings,
            nextAction: data.nextAction,
            lastToolResults: [{ tool: 'project.validate', status: 'warning' }],
        });
    }
    const result = runSolvePlanSkill({
        project,
        userPreference: message,
        dataQuality: data.dataQuality,
        env,
    });
    if (result.nextAction === 'diagnose') {
        const diagnosis = runDiagnosisSkill({ project, lastFailure: result.solvePlan });
        return responseFromSession(session, {
            stage: 'diagnosis',
            questions: diagnosis.questions,
            approvalQueue: diagnosis.approvalQueue || [],
            artifacts: [...result.artifacts, ...diagnosis.artifacts],
            warnings: [...result.warnings, ...diagnosis.warnings],
            nextAction: diagnosis.nextAction,
            lastToolResults: [{ tool: 'solve.precheck', status: 'error' }, { tool: 'diagnose.failure', status: 'success' }],
        });
    }
    return responseFromSession(session, {
        stage: 'solve_planning',
        questions: result.questions,
        approvalQueue: result.approvalQueue,
        artifacts: result.artifacts,
        warnings: result.warnings,
        nextAction: result.nextAction,
        lastToolResults: [{ tool: 'solve.precheck', status: 'success' }],
    });
}

async function runDiagnosis(session, project) {
    const result = runDiagnosisSkill({ project, recentDraftRows: session.artifacts?.flatMap(item => item.draftRows || []) || [] });
    return responseFromSession(session, {
        stage: 'diagnosis',
        questions: result.questions,
        approvalQueue: result.approvalQueue || [],
        artifacts: result.artifacts,
        warnings: result.warnings,
        nextAction: result.nextAction,
        lastToolResults: [{ tool: 'diagnose.failure', status: 'success' }],
    });
}

export function createTimetableAgentSession(input = {}) {
    return createTimetableAgentSessionState(input);
}

export function getTimetableAgentSession(sessionId) {
    return getTimetableAgentState(sessionId);
}

export function resetTimetableAgentSession(input = {}) {
    return resetTimetableAgentState(input.sessionId, input);
}

export async function handleTimetableAgentMessage({
    sessionId,
    message = '',
    project,
    env = process.env,
    fetchImpl,
} = {}) {
    let session = sessionId ? requireTimetableAgentState(sessionId) : createTimetableAgentSession({ project });
    session = saveTimetableAgentState(appendMessage(session, 'user', message));
    const normalizedProject = currentProject(session, project);
    const intent = classifyIntent(message);

    if (intent === 'constraint') return runConstraint(session, normalizedProject, { message, env, fetchImpl });
    if (intent === 'solve') return runSolvePlan(session, normalizedProject, { message, env });
    if (intent === 'diagnose') return runDiagnosis(session, normalizedProject);
    if (intent === 'save') {
        return responseFromSession(session, {
            stage: 'finalize',
            nextAction: 'await_approval',
            reply: '保存正式课表前需要先选择一个候选方案并确认保存动作。',
            approvalQueue: [],
            artifacts: [],
            warnings: [{ type: 'missing_solution', message: '当前会话没有待保存候选方案。' }],
        });
    }
    return runDataPrep(session, normalizedProject);
}

export async function runTimetableAgent({
    sessionId,
    project,
    env = process.env,
    fetchImpl,
} = {}) {
    const session = requireTimetableAgentState(sessionId);
    const normalizedProject = currentProject(session, project);
    if (session.stage === 'idle' || session.stage === 'data_prep') return runDataPrep(session, normalizedProject);
    if (session.stage === 'constraint_review') return runSolvePlan(session, normalizedProject, { env });
    if (session.stage === 'solve_planning') {
        return responseFromSession(session, {
            stage: 'solve_planning',
            nextAction: 'await_approval',
            reply: '求解计划需要你确认后才会执行。',
            approvalQueue: session.approvalQueue || [],
        });
    }
    if (session.stage === 'solution_review') return runDiagnosis(session, normalizedProject);
    return handleTimetableAgentMessage({ sessionId, message: '检查当前排课数据', project: normalizedProject, env, fetchImpl });
}

export async function answerTimetableAgentQuestions({
    sessionId,
    answers = [],
    project,
    env = process.env,
    fetchImpl,
} = {}) {
    const session = requireTimetableAgentState(sessionId);
    const normalizedProject = currentProject(session, project);
    const ruleArtifact = [...(session.artifacts || [])].reverse().find(item => item.type === 'rule_review');
    if (ruleArtifact) {
        return runConstraint(session, normalizedProject, {
            message: ruleArtifact.originalText || '',
            previousResult: ruleArtifact,
            answers,
            env,
            fetchImpl,
        });
    }
    return responseFromSession(session, {
        stage: session.stage,
        questions: [],
        approvalQueue: session.approvalQueue || [],
        artifacts: [],
        nextAction: 'continue',
        reply: '已收到补充信息，你可以继续让我检查数据或生成求解计划。',
    });
}

function findApproval(session, actionId) {
    return (session.approvalQueue || []).find(action => action.id === actionId);
}

export async function approveTimetableAgentAction({
    sessionId,
    actionId,
    approved = false,
    project,
    env = process.env,
    fetchImpl,
    saveProject = null,
} = {}) {
    const session = requireTimetableAgentState(sessionId);
    const action = findApproval(session, actionId);
    if (!action) {
        return responseFromSession(session, {
            stage: session.stage,
            nextAction: 'failed',
            errors: [{ type: 'approval_not_found', message: '没有找到需要确认的动作。' }],
            reply: '没有找到需要确认的动作，可能已经处理或过期。',
        });
    }
    if (!approved) {
        return responseFromSession(session, {
            stage: session.stage,
            approvalQueue: (session.approvalQueue || []).filter(item => item.id !== actionId),
            nextAction: 'continue',
            reply: '已取消该动作，当前项目不会被修改。',
        });
    }

    const normalizedProject = currentProject(session, project);
    if (action.type === 'execute_solve') {
        const result = await runSolveSkill({
            project: normalizedProject,
            solvePlan: action.payload?.solvePlan || {},
            env,
            fetchImpl,
        });
        if (result.status === 'failed') {
            const diagnosis = runDiagnosisSkill({
                project: normalizedProject,
                solveResult: result,
                lastFailure: result.diagnosticsInput,
            });
            return responseFromSession(session, {
                stage: 'diagnosis',
                artifacts: [...result.artifacts, ...diagnosis.artifacts],
                questions: diagnosis.questions,
                approvalQueue: diagnosis.approvalQueue || [],
                warnings: [...result.warnings, ...diagnosis.warnings],
                nextAction: diagnosis.nextAction,
                lastToolResults: [{ tool: 'solve.local', status: 'error' }, { tool: 'diagnose.failure', status: 'success' }],
            });
        }
        return responseFromSession(session, {
            stage: 'solution_review',
            artifacts: result.artifacts,
            questions: [],
            approvalQueue: result.approvalQueue,
            warnings: result.warnings,
            nextAction: result.nextAction,
            lastToolResults: [{ tool: result.solverUsed === 'timefold' ? 'solve.timefold' : 'solve.local', status: 'success' }],
            reply: stageReply('solution_review', result.nextAction, { status: result.status }),
        });
    }

    if (action.type === 'apply_rules') {
        const normalized = normalizeConstraintApproval({
            project: normalizedProject,
            draftRows: action.payload?.draftRows || [],
        });
        return responseFromSession(session, {
            stage: 'constraint_review',
            artifacts: [{
                type: 'rule_review',
                title: '待保存规则',
                ...normalized,
            }],
            approvalQueue: [],
            warnings: normalized.warnings || [],
            nextAction: 'continue',
            reply: '高置信度约束已转换为可保存规则，仍需要通过正式规则保存入口落地。',
            lastToolResults: [{ tool: 'rules.normalize', status: 'success' }],
        });
    }

    if (action.type === 'save_solution') {
        const publication = await runPublicationSkill({
            project: normalizedProject,
            solution: action.payload || {},
            approval: { approved: true },
            saveProject,
        });
        return responseFromSession(session, {
            stage: 'finalize',
            artifacts: publication.artifacts,
            approvalQueue: [],
            warnings: publication.warnings || [],
            nextAction: publication.nextAction,
            reply: publication.saved ? '正式课表已保存。' : '保存前校验未通过，课表没有被覆盖。',
            lastToolResults: [{ tool: 'publish.save', status: publication.saved ? 'success' : 'error' }],
            project: publication.saved ? publication.project : null,
        });
    }

    return responseFromSession(session, {
        stage: session.stage,
        nextAction: 'failed',
        errors: [{ type: 'unsupported_approval', message: `暂不支持的确认动作：${action.type}` }],
    });
}
