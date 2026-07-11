import {
    continueTimetableRuleConversation,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    parseTimetableRules,
} from '../../timetable-rule-parser.js';
import {
    makeTimetableAgentActionId,
    makeTimetableAgentArtifactId,
} from '../timetable-agent-state.js';

export function buildRuleReviewArtifact(parsed = {}, { originalText = '', inputType = '' } = {}) {
    return {
        id: makeTimetableAgentArtifactId('rule_review'),
        type: 'rule_review',
        title: '智能约束复核',
        schemaVersion: parsed.schemaVersion,
        parserVersion: parsed.parserVersion || '',
        parseSource: parsed.parseSource || parsed.source || '',
        originalText: parsed.originalText || originalText || '',
        inputType: parsed.inputType || inputType || 'text',
        ...(Object.prototype.hasOwnProperty.call(parsed, 'sourceRequirements')
            ? { sourceRequirements: Array.isArray(parsed.sourceRequirements) ? parsed.sourceRequirements : [] }
            : {}),
        systemSupplements: parsed.systemSupplements || [],
        manualRequirements: parsed.manualRequirements || [],
        constraintIRs: parsed.constraintIRs || [],
        warningItems: parsed.warningItems || [],
        statistics: parsed.statistics || null,
        requirementItems: parsed.requirementItems || [],
        semanticActions: parsed.semanticActions || [],
        draftRows: parsed.draftRows || [],
        autoAcceptable: parsed.autoAcceptable || [],
        needReview: parsed.needReview || [],
        clarifyingQuestions: parsed.clarifyingQuestions || [],
        missingInfo: parsed.missingInfo || [],
        conflicts: parsed.conflicts || [],
        warnings: parsed.warnings || [],
        unsupportedItems: parsed.unsupportedItems || [],
        confidenceSummary: parsed.confidenceSummary || {},
        nextAction: parsed.nextAction || 'review',
        source: parsed.source || parsed.inputType || 'text',
        contextStats: parsed.contextStats || null,
    };
}

function approvalForRules(parsed = {}) {
    const rows = parsed.autoAcceptable || [];
    if (!rows.length) return [];
    return [{
        id: makeTimetableAgentActionId('apply_rules'),
        type: 'apply_rules',
        title: `应用 ${rows.length} 条高置信度约束`,
        description: 'Agent 不能直接写入正式规则，确认后才会进入保存流程。',
        risk: 'high',
        requiresApproval: true,
        payload: {
            draftRows: rows,
            inputType: parsed.inputType || 'agent',
            contextStats: parsed.contextStats || null,
        },
    }];
}

export async function runConstraintSkill({
    project,
    text = '',
    previousResult = null,
    answers = [],
    env,
    fetchImpl,
} = {}) {
    let parsed = null;
    if (previousResult) {
        parsed = continueTimetableRuleConversation({
            project,
            draftRows: previousResult.draftRows || [],
            answers,
            previousResult,
            originalText: text || previousResult.originalText || '',
            contextStats: previousResult.contextStats || null,
            inputType: previousResult.inputType || 'agent_clarification',
        });
    } else {
        try {
            parsed = await parseTimetableRules({
                project,
                text,
                env,
                fetchImpl,
            });
        } catch (error) {
            parsed = await parseTimetableRules({
                project,
                text,
                env: {},
                fetchImpl,
            });
            parsed.warnings = [
                ...(parsed.warnings || []),
                `智能规划不可用，已切换为本地明确规则解析：${error.reason || error.message}`,
            ];
            parsed.source = parsed.source || 'local_text';
        }
    }
    const artifact = buildRuleReviewArtifact(parsed, {
        originalText: text || previousResult?.originalText || '',
        inputType: parsed.inputType || previousResult?.inputType || '',
    });
    return {
        parsed,
        artifacts: [artifact],
        questions: parsed.clarifyingQuestions || [],
        approvalQueue: approvalForRules(parsed),
        warnings: parsed.warnings || [],
        nextAction: (parsed.clarifyingQuestions || []).length
            ? 'ask_user'
            : (parsed.conflicts || []).some(item => item.severity === 'blocking' || item.blocking)
                ? 'diagnose'
                : approvalForRules(parsed).length
                    ? 'await_approval'
                    : 'continue',
    };
}

export function normalizeConstraintApproval({ project, draftRows = [], source = 'agent_approval' } = {}) {
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows,
        source,
        inputType: 'agent_approval',
    });
}

export function diagnoseConstraintSkill({ project, recentDraftRows = [], solverFailure = null } = {}) {
    return diagnoseTimetableRules({
        project,
        recentDraftRows,
        draftRows: recentDraftRows,
        solverFailure,
    });
}
