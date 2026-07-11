import { evaluateTimetableConstraintFulfillment } from '../../timetable-constraint-fulfillment.js';
import {
    applyTimetableRequirementActions,
    continueTimetableRequirementClarification,
    continueTimetableRuleConversation,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
} from '../../timetable-rule-parser.js';
import {
    normalizeTimetableProject,
    runTimetableScheduler,
} from '../../timetable-scheduler.js';
import {
    recordConstraintMetric,
    recordConstraintMissSample,
} from '../../timetable-constraint-observability.js';

const sessions = new Map();
const STAGES = new Set(['INTAKE', 'CLARIFY', 'CONFIRM', 'APPLY', 'SOLVE', 'REPORT']);
const MAX_CLARIFY_TURNS = 3;

export class ConstraintIntakeTransitionError extends Error {
    constructor(message, reason = 'constraint_intake_transition_invalid', status = 409) {
        super(message);
        this.name = 'ConstraintIntakeTransitionError';
        this.reason = reason;
        this.status = status;
    }
}

function nowIso() {
    return new Date().toISOString();
}

function makeId(prefix = 'tt_constraint_agent') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function text(value = '', max = 2000) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value ?? null));
}

function draftRowApplyItemKey(row = {}) {
    return `rule:${row.id || row.rowId || row.draftRowId || ''}`;
}

function semanticActionApplyItemKey(action = {}) {
    return `action:${action.id || action.actionId || action.requirementId || ''}`;
}

function excludedSet(values = []) {
    return new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean));
}

function actionableDraftRows(review = {}, excluded = new Set()) {
    return (review.draftRows || []).filter(row => (
        row?.status === 'effective'
        && !excluded.has(draftRowApplyItemKey(row))
    ));
}

function actionableSemanticActions(review = {}, excluded = new Set()) {
    return (review.semanticActions || []).filter(action => {
        const kind = String(action.kind || action.type || '').trim().toLowerCase();
        const status = String(action.status || 'ready').trim().toLowerCase();
        return kind
            && kind !== 'handled_notice'
            && !['rules_patch', 'rule_patch'].includes(kind)
            && ['ready', 'actionable', 'effective'].includes(status)
            && !excluded.has(semanticActionApplyItemKey(action));
    });
}

function questionCount(review = {}) {
    return (review.clarifyingQuestions || []).length + (review.missingInfo || []).length;
}

function understoodCount(review = {}) {
    const statisticalCount = Number(review.statistics?.userInputCount);
    if (Number.isFinite(statisticalCount) && statisticalCount >= 0) {
        return statisticalCount;
    }

    if (Array.isArray(review.sourceRequirements)) {
        return review.sourceRequirements.filter(source => (
            source?.origin || source?.source?.origin || 'unknown'
        ) === 'user_input').length;
    }

    const requirementCount = (review.requirementItems || []).length;
    return requirementCount || (review.draftRows || []).length || 0;
}

function pendingConfirmCount(state = {}) {
    if (state.stage !== 'CONFIRM') return 0;
    if (state.highRiskAction) return state.highRiskConfirmed ? 0 : 1;
    if (state.confirmed) return 0;
    const excluded = excludedSet(state.excludedApplyItemKeys || []);
    return actionableDraftRows(state.review || {}, excluded).length
        + actionableSemanticActions(state.review || {}, excluded).length;
}

function hasConfirmableReview(review = {}, excluded = new Set()) {
    return actionableDraftRows(review, excluded).length > 0
        || actionableSemanticActions(review, excluded).length > 0;
}

function confirmationTokenFor(stage = 'INTAKE', review = {}) {
    return stage === 'CONFIRM' && hasConfirmableReview(review) ? makeId('confirm_apply') : null;
}

function handoffReviewToManual(review = {}, clarifyTurns = 0) {
    const warning = `已完成 ${clarifyTurns} 轮澄清，仍有信息不确定，已转入人工复核台。`;
    return {
        ...review,
        clarifyingQuestions: [],
        missingInfo: [],
        nextAction: 'review',
        manualReviewRequired: true,
        warnings: [
            ...(review.warnings || []),
            warning,
        ],
    };
}

function resolveClarificationReview(review = {}, clarifyTurns = 0) {
    if (questionCount(review) > 0 && clarifyTurns >= MAX_CLARIFY_TURNS) {
        const manualReview = handoffReviewToManual(review, clarifyTurns);
        return { review: manualReview, stage: 'CONFIRM', manualHandoff: true };
    }
    return { review, stage: stageForReview(review), manualHandoff: false };
}

function projectMetricShape(project = {}) {
    return {
        classCount: (project.classes || []).length,
        teacherCount: (project.teachers || []).length,
        subjectCount: (project.subjects || []).length,
        lessonPlanCount: (project.lessonPlans || []).length,
    };
}

function fulfillmentViolationCounts(fulfillment = {}) {
    const items = fulfillment.items || [];
    return {
        hardViolationCount: items.filter(item => item.strength === 'hard' && ['violated', 'partial'].includes(item.status)).length,
        softViolationCount: items.filter(item => item.strength !== 'hard' && ['violated', 'partial'].includes(item.status)).length,
    };
}

export function constraintIntakeStatusLine(state = {}) {
    return `[已理解 ${understoodCount(state.review || {})} · 待澄清 ${questionCount(state.review || {})} · 待确认 ${pendingConfirmCount(state)}]`;
}

function replyWithStatusLine(reply = '', state = {}) {
    const line = constraintIntakeStatusLine(state);
    const body = text(reply, 4000) || '我已更新对话排课状态。';
    return body.includes(line) ? body : `${body}\n${line}`;
}

function publicState(state = {}) {
    return {
        sessionId: state.sessionId,
        stage: state.stage,
        projectSnapshot: state.projectSnapshot || null,
        review: state.review || null,
        questions: state.questions || [],
        confirmationToken: state.stage === 'CONFIRM' && !state.highRiskAction ? state.confirmationToken || null : null,
        highRiskToken: state.stage === 'CONFIRM' && state.highRiskAction ? state.highRiskToken || null : null,
        highRiskAction: state.highRiskAction || null,
        confirmed: Boolean(state.confirmed),
        highRiskConfirmed: Boolean(state.highRiskConfirmed),
        excludedApplyItemKeys: state.excludedApplyItemKeys || [],
        appliedSummary: state.appliedSummary || null,
        solveResult: state.solveResult || null,
        fulfillment: state.fulfillment || null,
        diagnosis: state.diagnosis || null,
        messages: state.messages || [],
        statusLine: constraintIntakeStatusLine(state),
        clarifyTurns: Number(state.clarifyTurns || 0),
        manualReviewRequired: Boolean(state.manualReviewRequired || state.review?.manualReviewRequired),
        warnings: state.warnings || [],
        errors: state.errors || [],
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
    };
}

function saveState(state = {}) {
    const next = {
        ...state,
        stage: STAGES.has(state.stage) ? state.stage : 'INTAKE',
        updatedAt: nowIso(),
    };
    sessions.set(next.sessionId, next);
    return next;
}

function responseFromState(state = {}, {
    reply = '',
    nextAction = '',
    project = null,
    warnings = null,
    errors = null,
} = {}) {
    const saved = saveState({
        ...state,
        warnings: warnings || state.warnings || [],
        errors: errors || [],
    });
    const resolvedReply = replyWithStatusLine(reply, saved);
    const messages = reply
        ? [...(saved.messages || []), { role: 'assistant', content: resolvedReply, createdAt: nowIso() }]
        : saved.messages || [];
    const next = saveState({ ...saved, messages });
    return {
        ...publicState(next),
        reply: resolvedReply,
        nextAction,
        ...(project ? { project } : {}),
    };
}

function requireState(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
        throw new ConstraintIntakeTransitionError('对话排课会话不存在或已过期。', 'constraint_intake_session_not_found', 404);
    }
    return session;
}

function appendUserMessage(state = {}, content = '') {
    return saveState({
        ...state,
        messages: [
            ...(state.messages || []),
            { role: 'user', content: text(content, 4000), createdAt: nowIso() },
        ],
    });
}

function highRiskActionFromText(message = '') {
    const input = text(message, 1000);
    if (!input) return null;
    const deleteIntent = /(删除|移除|取消|清掉|删掉).{0,12}(硬约束|规则|约束)/.test(input);
    const relaxIntent = /(放宽|降低|改成软|转成软).{0,12}(硬约束|必守|必须)|硬约束.{0,12}(放宽|降低|改成软|转成软)/.test(input);
    if (!deleteIntent && !relaxIntent) return null;
    return {
        id: makeId('tt_high_risk'),
        type: deleteIntent ? 'delete_hard_rule' : 'relax_hard_rule',
        risk: 'high',
        title: deleteIntent ? '删除硬约束' : '放宽硬约束',
        description: input,
        requiresSecondConfirmation: true,
    };
}

function stageForReview(review = {}) {
    return questionCount(review) ? 'CLARIFY' : 'CONFIRM';
}

async function parseMessage({ state, message, project, env, fetchImpl }) {
    const parsed = await parseTimetableRules({
        project,
        text: message,
        env,
        fetchImpl,
    });
    void recordConstraintMetric({
        phase: 'parse',
        success: true,
        parseSource: parsed.parseSource || '',
        requirementCount: understoodCount(parsed),
        clarificationCount: questionCount(parsed),
        ai: {
            model: parsed.contextStats?.aiExtractModel || '',
            promptVersion: parsed.contextStats?.aiExtractPromptVersion || '',
        },
        project: projectMetricShape(project),
    });
    if (!(parsed.draftRows || []).length && !(parsed.semanticActions || []).length && questionCount(parsed) === 0) {
        void recordConstraintMissSample({
            phase: 'parse',
            reason: 'no_requirements_extracted',
            input: message,
            parseSource: parsed.parseSource || '',
            warnings: parsed.warnings || [],
        });
    }
    const stage = stageForReview(parsed);
    const next = saveState({
        ...state,
        stage,
        projectSnapshot: normalizeTimetableProject(project),
        originalText: message,
        review: parsed,
        questions: parsed.clarifyingQuestions || [],
        confirmationToken: confirmationTokenFor(stage, parsed),
        confirmed: false,
        highRiskAction: null,
        highRiskToken: null,
        highRiskConfirmed: false,
        clarifyTurns: 0,
        manualReviewRequired: false,
        appliedSummary: null,
        solveResult: null,
        fulfillment: null,
        diagnosis: null,
        excludedApplyItemKeys: [],
    });
    return responseFromState(next, {
        reply: stage === 'CLARIFY'
            ? '我已理解了一部分排课要求，还需要你补充几个关键参数。'
            : '我已生成可复核的需求卡，确认后才会应用到项目并进入求解。',
        nextAction: stage === 'CLARIFY' ? 'ask_user' : 'confirm',
    });
}

export function createConstraintIntakeSession({ project = {}, mode = 'constraint_intake' } = {}) {
    const timestamp = nowIso();
    return saveState({
        sessionId: makeId(),
        domain: 'timetable',
        mode,
        stage: 'INTAKE',
        projectSnapshot: normalizeTimetableProject(project),
        originalText: '',
        review: null,
        questions: [],
        confirmationToken: null,
        confirmed: false,
        highRiskAction: null,
        highRiskToken: null,
        highRiskConfirmed: false,
        clarifyTurns: 0,
        manualReviewRequired: false,
        excludedApplyItemKeys: [],
        appliedSummary: null,
        solveResult: null,
        fulfillment: null,
        diagnosis: null,
        messages: [],
        warnings: [],
        errors: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    });
}

export function getConstraintIntakeSession(sessionId) {
    const state = sessions.get(sessionId);
    return state ? publicState(state) : null;
}

export function resetConstraintIntakeSessions() {
    sessions.clear();
}

export async function handleConstraintIntakeMessage({
    sessionId,
    message = '',
    project: inputProject = {},
    env = process.env,
    fetchImpl,
} = {}) {
    const content = text(message, 4000);
    if (!content) {
        throw new ConstraintIntakeTransitionError('请先输入排课要求。', 'empty_prompt', 400);
    }
    const project = normalizeTimetableProject(inputProject);
    let state = sessionId ? requireState(sessionId) : createConstraintIntakeSession({ project });
    state = appendUserMessage(state, content);

    const highRiskAction = highRiskActionFromText(content);
    if (highRiskAction) {
        const next = saveState({
            ...state,
            stage: 'CONFIRM',
            projectSnapshot: project,
            highRiskAction,
            highRiskToken: makeId('confirm_high_risk'),
            highRiskConfirmed: false,
            confirmationToken: null,
            confirmed: false,
            clarifyTurns: 0,
            manualReviewRequired: false,
            questions: [],
        });
        return responseFromState(next, {
            reply: '这属于硬约束删除或放宽，需要单独二次确认。我不会在未确认前执行。',
            nextAction: 'confirm_high_risk',
        });
    }

    return parseMessage({ state, message: content, project, env, fetchImpl });
}

export function answerConstraintIntakeClarification({
    sessionId,
    answers = [],
    project: inputProject = {},
} = {}) {
    const state = requireState(sessionId);
    if (state.stage !== 'CLARIFY') {
        throw new ConstraintIntakeTransitionError('当前会话不在澄清阶段。', 'constraint_intake_not_clarifying', 409);
    }
    const project = normalizeTimetableProject(inputProject || state.projectSnapshot || {});
    const hasRequirementItems = (Array.isArray(state.review?.requirementItems)
        && state.review.requirementItems.length > 0)
        || (Array.isArray(state.review?.sourceRequirements)
            && state.review.sourceRequirements.some(source => (source?.clauses || []).some(clause => (
                clause?.id || clause?.requirementId || clause?.clauseId
            ))));
    const rawReview = hasRequirementItems
        ? continueTimetableRequirementClarification({
            project,
            previousResult: state.review || {},
            answers,
            contextStats: state.review?.contextStats || null,
            inputType: state.review?.inputType || 'constraint_intake_clarification',
        })
        : continueTimetableRuleConversation({
            project,
            draftRows: state.review?.draftRows || [],
            answers,
            previousResult: state.review || {},
            originalText: state.originalText || '',
            contextStats: state.review?.contextStats || null,
            inputType: state.review?.inputType || 'constraint_intake_clarification',
        });
    const clarifyTurns = Number(state.clarifyTurns || 0) + 1;
    const { review, stage, manualHandoff } = resolveClarificationReview(rawReview, clarifyTurns);
    void recordConstraintMetric({
        phase: 'clarify',
        success: true,
        requirementCount: understoodCount(review),
        clarificationCount: questionCount(review),
        project: projectMetricShape(project),
    });
    const next = saveState({
        ...state,
        stage,
        projectSnapshot: project,
        review,
        questions: review.clarifyingQuestions || [],
        confirmationToken: confirmationTokenFor(stage, review),
        confirmed: false,
        clarifyTurns,
        manualReviewRequired: manualHandoff,
    });
    return responseFromState(next, {
        reply: manualHandoff
            ? '连续澄清后仍有信息不确定，我已转入人工复核台，请在表格里人工确认后再应用。'
            : stage === 'CLARIFY'
            ? '已收到补充信息，还有需求需要继续确认。'
            : '补充信息已合并进同一批需求卡，现在可以确认应用。',
        nextAction: manualHandoff ? 'review' : stage === 'CLARIFY' ? 'ask_user' : 'confirm',
        warnings: review.warnings || [],
    });
}

export function confirmConstraintIntake({
    sessionId,
    confirmationToken = '',
    highRiskToken = '',
    excludedApplyItemKeys = [],
} = {}) {
    const state = requireState(sessionId);
    if (state.stage !== 'CONFIRM') {
        throw new ConstraintIntakeTransitionError('只有确认阶段可以提交确认。', 'constraint_intake_not_confirmable', 409);
    }
    if (state.highRiskAction) {
        if (!highRiskToken || highRiskToken !== state.highRiskToken) {
            throw new ConstraintIntakeTransitionError('硬约束删除/放宽需要单独二次确认。', 'high_risk_confirmation_required', 409);
        }
        const next = saveState({
            ...state,
            highRiskConfirmed: true,
            excludedApplyItemKeys,
        });
        return responseFromState(next, {
            reply: '高风险动作已二次确认。继续 APPLY 时仍会带着这次确认令牌校验。',
            nextAction: 'apply',
        });
    }
    if (!confirmationToken || confirmationToken !== state.confirmationToken) {
        throw new ConstraintIntakeTransitionError('确认令牌不匹配，不能应用当前需求。', 'confirmation_token_mismatch', 409);
    }
    const next = saveState({
        ...state,
        confirmed: true,
        excludedApplyItemKeys,
    });
    return responseFromState(next, {
        reply: '当前需求卡已确认，可以应用到项目。',
        nextAction: 'apply',
    });
}

export async function applyConstraintIntake({
    sessionId,
    confirmationToken = '',
    highRiskToken = '',
    excludedApplyItemKeys = null,
    project: inputProject = {},
    saveProject = null,
} = {}) {
    const state = requireState(sessionId);
    if (state.stage !== 'CONFIRM') {
        throw new ConstraintIntakeTransitionError('APPLY 只能在确认阶段之后执行。', 'apply_before_confirm', 409);
    }
    const excluded = excludedSet(excludedApplyItemKeys || state.excludedApplyItemKeys || []);
    const project = normalizeTimetableProject(inputProject || state.projectSnapshot || {});

    if (state.highRiskAction) {
        if (!state.highRiskConfirmed || highRiskToken !== state.highRiskToken) {
            throw new ConstraintIntakeTransitionError('硬约束删除/放宽需要单独二次确认。', 'high_risk_confirmation_required', 409);
        }
        const next = saveState({
            ...state,
            stage: 'APPLY',
            projectSnapshot: project,
            appliedSummary: {
                appliedRuleCount: 0,
                appliedSemanticActionCount: 0,
                highRiskAction: state.highRiskAction,
                message: '高风险动作已确认，但当前版本不自动删除未精确指定的规则。',
            },
            warnings: ['高风险动作需要在规则列表中精确选择目标后执行。'],
        });
        void recordConstraintMetric({
            phase: 'apply',
            success: true,
            appliedRuleCount: 0,
            appliedSemanticActionCount: 0,
            reason: state.highRiskAction?.type || 'high_risk_action',
            project: projectMetricShape(project),
        });
        return responseFromState(next, {
            reply: '已记录高风险确认；未精确指定规则目标时不会自动删除或放宽硬约束。',
            nextAction: 'solve',
            project,
            warnings: next.warnings,
        });
    }

    if (!state.confirmed || confirmationToken !== state.confirmationToken) {
        throw new ConstraintIntakeTransitionError('APPLY 前必须确认当前需求卡。', 'apply_before_confirm', 409);
    }

    const rows = actionableDraftRows(state.review || {}, excluded);
    const actions = actionableSemanticActions(state.review || {}, excluded);
    if (!rows.length && !actions.length) {
        throw new ConstraintIntakeTransitionError('当前没有可应用的需求。', 'no_applicable_requirements', 400);
    }

    const normalized = rows.length
        ? normalizeTimetableRuleDraftRows({
            project,
            draftRows: rows,
            source: 'constraint_intake',
            inputType: state.review?.inputType || 'constraint_intake',
            contextStats: state.review?.contextStats || null,
            originalText: state.originalText || '',
        })
        : { draftRules: project.rules, draftRows: [], warnings: [] };
    const effectiveRows = (normalized.draftRows || []).filter(row => row.status === 'effective');
    if (rows.length && effectiveRows.length !== rows.length) {
        const next = saveState({
            ...state,
            review: normalized,
            confirmed: false,
            confirmationToken: makeId('confirm_apply'),
        });
        return responseFromState(next, {
            reply: '有需求在应用前校验中退回复核，暂未写入项目。',
            nextAction: 'confirm',
            warnings: normalized.warnings || [],
        });
    }

    let nextProject = normalizeTimetableProject({ ...project, rules: normalized.draftRules });
    let appliedActions = [];
    if (actions.length) {
        const applied = applyTimetableRequirementActions({ project: nextProject, actions });
        nextProject = normalizeTimetableProject(applied.project);
        appliedActions = applied.applied || [];
    }
    const savedProject = typeof saveProject === 'function' ? await saveProject(nextProject) : nextProject;
    void recordConstraintMetric({
        phase: 'apply',
        success: true,
        appliedRuleCount: effectiveRows.length,
        appliedSemanticActionCount: appliedActions.length,
        project: projectMetricShape(savedProject),
    });
    const diagnosis = diagnoseTimetableRules({
        project: savedProject,
        recentDraftRows: effectiveRows,
        draftRows: effectiveRows,
    });
    const next = saveState({
        ...state,
        stage: 'APPLY',
        projectSnapshot: savedProject,
        review: {
            ...(state.review || {}),
            draftRows: (state.review?.draftRows || []).filter(row => !rows.some(applied => applied.id === row.id)),
            semanticActions: (state.review?.semanticActions || []).filter(action => !actions.some(applied => applied.id === action.id)),
            appliedRows: effectiveRows,
            appliedActions,
        },
        appliedSummary: {
            appliedRuleCount: effectiveRows.length,
            appliedSemanticActionCount: appliedActions.length,
            skippedCount: excluded.size,
        },
        diagnosis,
        confirmed: false,
    });
    return responseFromState(next, {
        reply: `已应用 ${effectiveRows.length} 条规则和 ${appliedActions.length} 个模型动作，可以进入求解。`,
        nextAction: 'solve',
        project: savedProject,
        warnings: normalized.warnings || [],
    });
}

export async function solveConstraintIntake({
    sessionId,
    project: inputProject = {},
    seed = 'constraint-intake-agent',
    saveProject = null,
} = {}) {
    const state = requireState(sessionId);
    if (state.stage !== 'APPLY' && state.stage !== 'SOLVE') {
        throw new ConstraintIntakeTransitionError('SOLVE 必须在 APPLY 成功后执行。', 'solve_before_apply', 409);
    }
    const project = normalizeTimetableProject(inputProject || state.projectSnapshot || {});
    const solved = runTimetableScheduler(project, { seed });
    const solvedProject = normalizeTimetableProject(solved.project || { ...project, schedule: solved.schedule });
    const savedProject = typeof saveProject === 'function' ? await saveProject(solvedProject) : solvedProject;
    const fulfillment = evaluateTimetableConstraintFulfillment(savedProject);
    const violationCounts = fulfillmentViolationCounts(fulfillment);
    void recordConstraintMetric({
        phase: 'solve',
        success: Boolean(solved.success),
        solveSuccess: Boolean(solved.success),
        requirementCount: fulfillment.summary?.total || 0,
        ...violationCounts,
        project: projectMetricShape(savedProject),
    });
    const next = saveState({
        ...state,
        stage: 'REPORT',
        projectSnapshot: savedProject,
        solveResult: {
            success: Boolean(solved.success),
            schedule: solved.schedule || savedProject.schedule || null,
            metrics: solved.metrics || solved.schedule?.solverStats || null,
        },
        fulfillment,
    });
    return responseFromState(next, {
        reply: solved.success
            ? '已完成求解并生成约束满足度报告。'
            : '求解完成但仍有未排或冲突，我已生成约束满足度报告。',
        nextAction: 'report',
        project: savedProject,
    });
}

export function reportConstraintIntake({ sessionId, project: inputProject = {} } = {}) {
    const state = requireState(sessionId);
    const project = normalizeTimetableProject(inputProject || state.projectSnapshot || {});
    const fulfillment = state.fulfillment || evaluateTimetableConstraintFulfillment(project);
    const next = saveState({
        ...state,
        stage: 'REPORT',
        fulfillment,
    });
    return responseFromState(next, {
        reply: '这是当前课表的约束满足度报告。',
        nextAction: 'done',
    });
}

export function constraintIntakeSessionForTests(sessionId) {
    return sessions.get(sessionId) ? cloneValue(sessions.get(sessionId)) : null;
}
