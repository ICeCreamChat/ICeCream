import { normalizeApiError, requestTimetable } from './api.js';

function currentRuleDraftRows(state = {}) {
    const reviewRows = state.ruleReview?.draftRows || [];
    return reviewRows.length ? reviewRows : (state.pendingRules || []);
}

function uniqueValues(items = [], limit = 3) {
    const values = [];
    const seen = new Set();
    for (const item of items) {
        const value = String(item || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
        if (values.length >= limit) break;
    }
    return values;
}

function rowTitle(row = {}) {
    return row.description
        || row.rawText
        || [row.type, row.targetName || row.className || row.teacherName || row.subjectName || row.targetId]
            .filter(Boolean)
            .join(' - ')
        || '待复核约束';
}

function addContextGroup(groups, { type, label, count, examples = [], relatedRuleIds = [] }) {
    const normalizedCount = Number(count || 0);
    if (!normalizedCount) return;
    groups.push({
        type,
        label,
        count: normalizedCount,
        examples: uniqueValues(examples, 3),
        relatedRuleIds: uniqueValues(relatedRuleIds, 20),
    });
}

function buildSuggestedPrompts(groups = [], counts = {}) {
    const types = new Set(groups.map(group => group.type));
    const prompts = [];
    if (types.has('missing_slots') || types.has('missing_info') || counts.needsInput) {
        prompts.push('先处理缺少明确节次的问题');
    }
    if (types.has('out_of_range_slots')) {
        prompts.push('过滤不在当前排课范围内的第8-10节');
    }
    if (types.has('all_classes_unmatched')) {
        prompts.push('把全部班级展开为当前所有班级');
    }
    if (counts.needReview) {
        prompts.push('解释需要你确认的约束里哪些最影响排课');
    }
    if (counts.unsupported) {
        prompts.push('说明暂不支持的建议如何人工处理');
    }
    return uniqueValues(prompts, 5);
}

export function buildConstraintReviewContext(state = {}) {
    const review = state.ruleReview || {};
    const rows = currentRuleDraftRows(state);
    const missingInfo = review.missingInfo || [];
    const clarifyingQuestions = review.clarifyingQuestions || [];
    const needReview = review.needReview || rows.filter(row => ['needs_review', 'invalid'].includes(row.status));
    const unsupportedItems = review.unsupportedItems || [];
    const warnings = review.warnings || state.ruleWarnings || [];
    const conflicts = review.conflicts || [];
    const groups = [];

    const missingSlotItems = missingInfo.filter(item => /缺少明确节次/.test(item.message || item));
    addContextGroup(groups, {
        type: 'missing_slots',
        label: '缺少明确节次',
        count: missingSlotItems.length,
        examples: missingSlotItems.map(item => item.message || item),
        relatedRuleIds: missingSlotItems.flatMap(item => item.relatedRuleIds || []),
    });

    const outOfRangeItems = [
        ...missingInfo,
        ...needReview.flatMap(row => (row.warnings || []).map(message => ({ message, relatedRuleIds: [row.id] }))),
    ].filter(item => /不在当前排课范围内/.test(item.message || item));
    addContextGroup(groups, {
        type: 'out_of_range_slots',
        label: '节次超出范围',
        count: outOfRangeItems.length,
        examples: outOfRangeItems.map(item => item.message || item),
        relatedRuleIds: outOfRangeItems.flatMap(item => item.relatedRuleIds || []),
    });

    const allClassesItems = [
        ...missingInfo,
        ...needReview.flatMap(row => (row.warnings || []).map(message => ({ message, relatedRuleIds: [row.id] }))),
    ].filter(item => /全部班级.*没有匹配对象/.test(item.message || item));
    addContextGroup(groups, {
        type: 'all_classes_unmatched',
        label: '全部班级未匹配',
        count: allClassesItems.length,
        examples: allClassesItems.map(item => item.message || item),
        relatedRuleIds: allClassesItems.flatMap(item => item.relatedRuleIds || []),
    });

    addContextGroup(groups, {
        type: 'clarifying_questions',
        label: '需要回答的问题',
        count: clarifyingQuestions.length,
        examples: clarifyingQuestions.map(item => item.question || item.reason),
        relatedRuleIds: clarifyingQuestions.flatMap(item => item.relatedRuleIds || []),
    });

    const remainingMissing = missingInfo.filter(item => !/缺少明确节次|不在当前排课范围内|全部班级.*没有匹配对象/.test(item.message || item));
    addContextGroup(groups, {
        type: 'missing_info',
        label: '需要补充信息',
        count: remainingMissing.length,
        examples: remainingMissing.map(item => item.message || item),
        relatedRuleIds: remainingMissing.flatMap(item => item.relatedRuleIds || []),
    });

    addContextGroup(groups, {
        type: 'need_review',
        label: '需要你确认',
        count: needReview.length,
        examples: needReview.map(row => rowTitle(row)),
        relatedRuleIds: needReview.map(row => row.id),
    });

    addContextGroup(groups, {
        type: 'unsupported',
        label: '暂不支持',
        count: unsupportedItems.length,
        examples: unsupportedItems.map(row => rowTitle(row)),
        relatedRuleIds: unsupportedItems.map(row => row.id),
    });

    addContextGroup(groups, {
        type: 'warnings',
        label: '解析提醒',
        count: warnings.length,
        examples: warnings,
    });

    addContextGroup(groups, {
        type: 'conflicts',
        label: '冲突风险',
        count: conflicts.length,
        examples: conflicts.map(item => item.message || item.suggestion),
        relatedRuleIds: conflicts.flatMap(item => item.relatedRuleIds || []),
    });

    const counts = {
        total: rows.length,
        autoAcceptable: (review.autoAcceptable || []).length,
        needsInput: clarifyingQuestions.length + missingInfo.length,
        needReview: needReview.length,
        unsupported: unsupportedItems.length,
        warnings: warnings.length,
        conflicts: conflicts.length,
    };

    return {
        counts,
        groups,
        nextAction: review.nextAction || '',
        suggestedPrompts: buildSuggestedPrompts(groups, counts),
    };
}

function normalizeChatState(chat = {}) {
    return {
        open: true,
        loading: false,
        conversationId: null,
        inputText: '',
        messages: [],
        reviewContext: null,
        suggestedPrompts: [],
        error: null,
        completed: false,
        ...chat,
    };
}

function appendChatMessage(chat, role, content) {
    return {
        ...chat,
        messages: [
            ...(chat.messages || []),
            {
                role,
                content,
                timestamp: Date.now(),
            },
        ],
    };
}

function applyConstraintDrafts(state, constraints) {
    if (!Array.isArray(constraints)) return;

    state.ruleReview = {
        ...(state.ruleReview || {}),
        draftRows: constraints,
    };
    state.pendingRules = constraints;
}

export const constraintChatControllerMethods = {
    async startConstraintConversation() {
        const constraints = currentRuleDraftRows(this.state);
        if (!constraints.length) {
            this.setMessage('没有可优化的约束。请先解析约束。');
            return;
        }

        const reviewContext = buildConstraintReviewContext(this.state);
        this.state.constraintChat = normalizeChatState({
            loading: true,
            messages: [],
            inputText: '',
            reviewContext,
            suggestedPrompts: reviewContext.suggestedPrompts || [],
            error: null,
            completed: false,
        });
        this.render();

        try {
            const result = await requestTimetable('/constraints/chat/init', {
                method: 'POST',
                body: JSON.stringify({
                    constraints,
                    project: this.state.project || {},
                    reviewContext,
                }),
            });

            this.state.constraintChat = normalizeChatState({
                ...this.state.constraintChat,
                loading: false,
                conversationId: result.conversationId,
                reviewContext: result.reviewContext || reviewContext,
                suggestedPrompts: result.suggestedPrompts || reviewContext.suggestedPrompts || [],
                messages: [{
                    role: 'assistant',
                    content: result.welcomeMessage || '我可以帮你解释和优化这些约束。',
                    timestamp: Date.now(),
                }],
                error: null,
            });
            applyConstraintDrafts(this.state, result.constraints);
            this.render();
        } catch (error) {
            const normalized = normalizeApiError(error);
            this.state.constraintChat = normalizeChatState({
                ...this.state.constraintChat,
                loading: false,
                error: normalized.message,
            });
            this.render();
        }
    },

    async sendConstraintChatMessage(messageOverride = null) {
        const chat = normalizeChatState(this.state.constraintChat);
        if (chat.loading) return;

        const message = String(messageOverride ?? chat.inputText ?? '').trim();
        if (!message) return;

        if (!chat.conversationId) {
            this.state.constraintChat = normalizeChatState({
                ...chat,
                error: '对话会话不存在或已过期，请重新开始。',
            });
            this.render();
            return;
        }

        this.state.constraintChat = normalizeChatState({
            ...appendChatMessage(chat, 'user', message),
            inputText: '',
            loading: true,
            error: null,
        });
        this.render();

        try {
            const result = await requestTimetable('/constraints/chat/message', {
                method: 'POST',
                body: JSON.stringify({
                    conversationId: chat.conversationId,
                    message,
                }),
            });

            applyConstraintDrafts(this.state, result.constraints);

            this.state.constraintChat = normalizeChatState({
                ...appendChatMessage(this.state.constraintChat, 'assistant', result.message || '已收到。'),
                loading: false,
                completed: Boolean(result.completed),
                reviewContext: result.reviewContext || this.state.constraintChat.reviewContext,
                suggestedPrompts: result.suggestedPrompts || this.state.constraintChat.suggestedPrompts || [],
                error: null,
            });

            if (result.completed) {
                this.state.message = '约束优化完成，可以确认生效或继续调整。';
            }

            this.render();
        } catch (error) {
            const normalized = normalizeApiError(error);
            this.state.constraintChat = normalizeChatState({
                ...this.state.constraintChat,
                loading: false,
                error: normalized.message,
            });
            this.render();
        }
    },

    closeConstraintChat() {
        const chat = this.state.constraintChat;
        if (chat?.conversationId) {
            requestTimetable(`/constraints/chat/${encodeURIComponent(chat.conversationId)}/finalize`, {
                method: 'POST',
            }).then(result => {
                applyConstraintDrafts(this.state, result.constraints);
            }).catch(() => {});
        }

        this.state.constraintChat = chat ? { ...chat, open: false, loading: false } : null;
        this.render();
    },

    updateConstraintChatInput(text) {
        this.state.constraintChat = normalizeChatState({
            ...(this.state.constraintChat || {}),
            inputText: text,
        });
    },
};
