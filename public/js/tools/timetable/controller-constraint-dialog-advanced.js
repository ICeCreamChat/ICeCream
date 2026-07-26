/**
 * 智能约束助手弹窗控制器 - 高级功能
 * AI 对话、冲突检测、批量操作、约束编辑
 */

import { requestTimetable } from './api.js';
import {
    compileConstraintRuleArtifacts,
    getConstraintRuleEditorDefinition,
    getConstraintRuleFormValue,
    getConstraintRuleRange,
    summarizeConstraintRuleForm,
} from './constraint-rule-form-model.js';

function checkedEditSlots() {
    return Array.from(document.querySelectorAll?.('[data-edit-slot]:checked') || [])
        .map(input => String(input.value || '').trim())
        .filter(Boolean);
}

function collectConstraintRuleEditorForm(editing = {}) {
    const root = document.querySelector?.('[data-constraint-rule-editor-form]');
    if (!root) return null;
    const values = {
        ...(editing.formValues || {}),
        formKey: root.dataset.formKey || document.getElementById('tt-edit-constraint-type')?.value || editing.formKey || '',
    };
    const fields = [...root.querySelectorAll?.('[data-rule-field]') || []];
    const multipleNames = new Set(fields.filter(node => node.hasAttribute('data-rule-field-multiple')).map(node => node.dataset.ruleField));
    multipleNames.forEach(name => {
        values[name] = fields.filter(node => node.dataset.ruleField === name && node.checked)
            .map(node => node.value)
            .filter(Boolean);
    });
    fields.filter(node => !node.hasAttribute('data-rule-field-multiple')).forEach(node => {
        const name = node.dataset.ruleField;
        if (!name) return;
        if (node.type === 'radio') {
            if (node.checked) values[name] = node.value;
        } else if (node.type === 'checkbox') {
            values[name] = Boolean(node.checked);
        } else {
            values[name] = node.value;
        }
    });
    return values;
}

function defaultEditorFormValues(definition = {}, project = {}) {
    const range = getConstraintRuleRange(project);
    const values = {
        formKey: definition.key || '',
        type: definition.type || '',
        slots: [],
        limit: '',
        scopeMode: 'school',
        scopeClassId: '',
        scopeTeacherId: '',
        restrictTeacher: false,
    };
    (definition.fields || []).forEach(field => {
        if (field.kind === 'weekdays') values[field.name] = [...range.weekdays];
        else if (field.kind === 'entity_multi' || field.kind === 'token_multi' || field.kind === 'period_pair') values[field.name] = [];
        else if (field.kind === 'boolean') values[field.name] = true;
        else if (field.name === 'weight') values[field.name] = 1;
        else if (field.name === 'blockSize') values[field.name] = 2;
        else if (field.name === 'maxConsecutiveFullAfternoons') values[field.name] = 1;
        else if (field.name === 'dayPart') values[field.name] = 'morning';
        else if (field.kind === 'enum') values[field.name] = field.options?.[0]?.value || '';
        else if (!(field.name in values) && field.kind !== 'course_scope') values[field.name] = '';
    });
    return values;
}

function focusFirstEditorError() {
    setTimeout(() => {
        const doc = typeof document === 'undefined' ? null : document;
        const error = doc?.querySelector?.('.tt-constraint-edit-modal [role="alert"]');
        const field = error?.closest?.('label, fieldset, .tt-constraint-rule-field')
            ?.querySelector?.('input:not([type="hidden"]), select, button, summary');
        (field || error)?.focus?.();
    }, 0);
}

function restoreConstraintEditTrigger(constraintId = '') {
    if (!constraintId) return;
    setTimeout(() => {
        const doc = typeof document === 'undefined' ? null : document;
        doc?.querySelector?.(`[data-action="edit-constraint"][data-constraint-id="${String(constraintId).replace(/"/g, '\\"')}"]`)?.focus?.();
    }, 0);
}

function replaceLinkedArtifacts(review = {}, editing = {}, result = {}) {
    const matchesClause = item => item && (
        item.id === editing.requirementId
        || item.requirementId === editing.requirementId
        || item.rowId === editing.originalId
        || (editing.clauseId && item.clauseId === editing.clauseId)
    );
    const replaceArtifact = (items, replacement) => {
        let replaced = false;
        const next = (Array.isArray(items) ? items : []).map(item => {
            if (!matchesClause(item)) return item;
            replaced = true;
            return { ...item, ...replacement };
        });
        if (!replaced) next.push(replacement);
        return next;
    };
    const replaceSource = (items, replacement) => {
        let replaced = false;
        const next = (Array.isArray(items) ? items : []).map(source => {
            if (source?.sourceId !== editing.sourceId) return source;
            replaced = true;
            const clauses = replaceArtifact(source.clauses, result.requirementItem);
            const machineRuleIds = [...new Set([
                ...(source.machineRuleIds || []).filter(id => id !== editing.machineRuleId),
                result.draftRow.machineRuleId,
            ])];
            const promoteManualSource = source.origin === 'manual' && clauses.length === 1;
            return {
                ...source,
                ...(promoteManualSource ? replacement : {}),
                clauses,
                machineRuleIds,
                rawText: source.rawText || replacement.rawText,
                source: source.source || replacement.source,
            };
        });
        if (!replaced && result.draftRow.origin === 'manual') next.push(replacement);
        return next;
    };

    review.requirementItems = replaceArtifact(review.requirementItems, result.requirementItem);
    review.constraintIRs = replaceArtifact(review.constraintIRs, result.constraintIR);
    review.sourceRequirements = replaceSource(review.sourceRequirements, result.sourceRequirement);
    review.manualRequirements = replaceSource(review.manualRequirements, result.sourceRequirement);
}

/**
 * 约束冲突检测
 */
export async function detectConstraintConflicts() {
    const constraints = this.state.ruleReview?.draftRows || [];
    if (constraints.length === 0) return;

    try {
        // 调用后端冲突检测接口
        const result = await requestTimetable('/constraints/scan', {
            method: 'POST',
            body: JSON.stringify({
                constraints: constraints,
                project: this.state.project || {},
            }),
        });

        // 标记有冲突的约束
        if (result.problems && result.problems.length > 0) {
            const conflictMap = new Map();
            result.problems.forEach(problem => {
                if (problem.relatedConstraints) {
                    problem.relatedConstraints.forEach(id => {
                        if (!conflictMap.has(id)) {
                            conflictMap.set(id, []);
                        }
                        conflictMap.get(id).push(problem);
                    });
                }
            });

            // 更新约束的冲突信息
            this.state.ruleReview.draftRows = constraints.map(c => ({
                ...c,
                conflicts: conflictMap.get(c.id) || [],
                hasConflict: conflictMap.has(c.id),
            }));
        }

        this.state.ruleReview.conflictCheckDone = true;
    } catch (error) {
        console.error('Detect conflicts error:', error);
    }
}

/**
 * 编辑约束
 */
export function editConstraint(constraintId) {
    const constraint = this.state.ruleReview?.draftRows?.find(c => c.id === constraintId);
    if (!constraint) return;

    // 保存正在编辑的约束
    this.state.constraintDialog.editingConstraint = {
        ...constraint,
        originalId: constraint.id,
        formKey: getConstraintRuleFormValue(constraint).formKey,
        formValues: getConstraintRuleFormValue(constraint),
        formErrors: {},
    };
    this.state.constraintDialog.editReturnFocusConstraintId = constraint.id;

    this.render();

    // 聚焦到编辑表单
    setTimeout(() => {
        const doc = typeof document === 'undefined' ? null : document;
        const modal = doc?.querySelector?.('.tt-constraint-edit-modal');
        const firstInput = modal?.querySelector('input:not([type="hidden"]), select, textarea, button');
        (firstInput || modal)?.focus?.();
    }, 0);
}

/**
 * 保存编辑的约束
 */
export function saveEditedConstraint() {
    const editing = this.state.constraintDialog?.editingConstraint;
    if (!editing) return;

    const editorForm = collectConstraintRuleEditorForm(editing);
    const type = document.getElementById('tt-edit-constraint-type')?.value || '';
    const targetValue = document.getElementById('tt-edit-constraint-target')?.value || '';
    const limit = document.getElementById('tt-edit-constraint-limit')?.value || '';
    const scopeClassId = document.getElementById('tt-edit-constraint-scope-class')?.value || '';
    const restrictTeacher = Boolean(document.getElementById('tt-edit-constraint-scope-limit-teacher')?.checked);
    const scopeTeacherId = restrictTeacher ? (document.getElementById('tt-edit-constraint-scope-teacher')?.value || '') : '';
    const legacyForm = { type, targetValue, slots: checkedEditSlots(), limit, scopeClassId, restrictTeacher, scopeTeacherId };
    const form = editorForm || legacyForm;
    const result = compileConstraintRuleArtifacts(
        form,
        this.state.project || {},
        { existing: editing },
    );

    if (!result.ok) {
        this.state.constraintDialog.editingConstraint = {
            ...editing,
            formKey: form.formKey || editing.formKey || '',
            formType: editorForm ? undefined : type,
            formValues: editorForm || editing.formValues,
            formScope: editorForm ? undefined : { targetValue, scopeClassId, restrictTeacher, scopeTeacherId },
            formErrors: result.errors,
        };
        this.render();
        focusFirstEditorError();
        return;
    }

    const index = this.state.ruleReview.draftRows.findIndex(c => c.id === editing.originalId);
    if (index >= 0) {
        this.state.ruleReview.draftRows[index] = result.draftRow;
    }
    replaceLinkedArtifacts(this.state.ruleReview, editing, result);
    this.refreshReviewStatistics?.(this.state.ruleReview);

    const returnFocusId = this.state.constraintDialog.editReturnFocusConstraintId || editing.originalId;
    this.state.constraintDialog.editingConstraint = null;
    this.detectConstraintConflicts();
    this.render();
    restoreConstraintEditTrigger(returnFocusId);
}

export function updateEditingConstraintType(type = '') {
    const editing = this.state.constraintDialog?.editingConstraint;
    if (!editing) return;
    const current = collectConstraintRuleEditorForm(editing) || editing.formValues || {};
    const definition = getConstraintRuleEditorDefinition(type);
    if (!definition) return;
    const next = defaultEditorFormValues(definition, this.state.project || {});
    const supportedFields = new Set((definition.fields || []).map(field => field.name));
    supportedFields.add('scopeMode');
    supportedFields.add('scopeClassId');
    supportedFields.add('scopeTeacherId');
    supportedFields.add('restrictTeacher');
    supportedFields.forEach(name => {
        if (current[name] !== undefined && current[name] !== '') next[name] = current[name];
    });
    const currentTargetDefinition = getConstraintRuleEditorDefinition(current.formKey || editing.formKey || '');
    const currentTarget = currentTargetDefinition?.fields?.find(field => field.name === 'targetValue');
    const nextTarget = definition.fields?.find(field => field.name === 'targetValue');
    if (!currentTarget || !nextTarget || currentTarget.entityKind !== nextTarget.entityKind) next.targetValue = '';
    this.state.constraintDialog.editingConstraint = {
        ...editing,
        formKey: definition.key,
        formValues: next,
        formErrors: {},
    };
    this.render();
}

export function updateEditingConstraintDraftFromDom({ rerender = false } = {}) {
    const editing = this.state.constraintDialog?.editingConstraint;
    if (!editing) return;
    const formValues = collectConstraintRuleEditorForm(editing);
    if (!formValues) return;
    this.state.constraintDialog.editingConstraint = {
        ...editing,
        formKey: formValues.formKey || editing.formKey,
        formValues,
        formErrors: {},
    };
    if (rerender) {
        this.render();
        return;
    }
    const summary = summarizeConstraintRuleForm(formValues, this.state.project || {});
    document.querySelectorAll?.('.tt-constraint-edit-modal .tt-dialog-header p')
        .forEach(node => { node.textContent = summary; });
}

export function updateEditingConstraintScope(scope = {}) {
    const editing = this.state.constraintDialog?.editingConstraint;
    if (!editing) return;
    this.state.constraintDialog.editingConstraint = {
        ...editing,
        formScope: {
            ...(editing.formScope || {}),
            ...scope,
        },
        formErrors: {},
    };
    this.render();
}

/**
 * 取消编辑约束
 */
export function cancelEditConstraint() {
    const returnFocusId = this.state.constraintDialog?.editReturnFocusConstraintId
        || this.state.constraintDialog?.editingConstraint?.originalId;
    this.state.constraintDialog.editingConstraint = null;
    this.render();
    restoreConstraintEditTrigger(returnFocusId);
}

/**
 * 批量删除约束
 */
export function batchDeleteConstraints(constraintIds) {
    if (!Array.isArray(constraintIds) || constraintIds.length === 0) return;

    if (!confirm(`确定要删除 ${constraintIds.length} 条约束吗？`)) return;

    this.state.ruleReview.draftRows = (this.state.ruleReview.draftRows || []).filter(
        c => !constraintIds.includes(c.id)
    );

    this.render();
}

/**
 * 批量应用约束
 */
export function batchApplyConstraints(constraintIds) {
    if (!Array.isArray(constraintIds) || constraintIds.length === 0) return;

    const constraints = (this.state.ruleReview?.draftRows || []).filter(
        c => constraintIds.includes(c.id)
    );

    if (constraints.length === 0) return;

    // 标记为已应用
    constraints.forEach(c => {
        c.status = 'effective';
    });

    // 合并到已保存的约束
    if (!this.state.ruleReview.savedItems) {
        this.state.ruleReview.savedItems = [];
    }
    this.state.ruleReview.savedItems = [
        ...this.state.ruleReview.savedItems,
        ...constraints,
    ];

    // 从草稿中移除
    this.state.ruleReview.draftRows = (this.state.ruleReview.draftRows || []).filter(
        c => !constraintIds.includes(c.id)
    );

    this.render();
}

/**
 * 启动 AI 对话优化约束
 */
export async function startConstraintAIChat() {
    const constraints = this.state.ruleReview?.draftRows || [];

    if (constraints.length === 0) {
        alert('请先添加一些约束');
        return;
    }

    try {
        // 初始化 AI 对话
        this.state.constraintDialog.aiChat = {
            active: true,
            loading: true,
            conversationId: null,
            messages: [],
            suggestedPrompts: [],
        };
        this.render();

        // 调用后端初始化对话
        const result = await requestTimetable('/constraints/chat/init', {
            method: 'POST',
            body: JSON.stringify({
                constraints: constraints,
                project: this.state.project || {},
                reviewContext: {
                    conflictCheckDone: this.state.ruleReview.conflictCheckDone,
                },
            }),
        });

        this.state.constraintDialog.aiChat = {
            active: true,
            loading: false,
            conversationId: result.conversationId,
            messages: [
                { role: 'assistant', content: result.welcomeMessage || '您好！我可以帮您优化这些约束规则。' }
            ],
            suggestedPrompts: result.suggestedPrompts || [
                '检查这些约束是否有冲突',
                '有没有遗漏的常见约束',
                '帮我优化约束的描述',
            ],
        };

        this.render();
    } catch (error) {
        console.error('Start AI chat error:', error);
        this.state.constraintDialog.aiChat = {
            active: false,
        };
        this.render();
        alert(`启动 AI 对话失败：${error.message || '未知错误'}`);
    }
}

/**
 * 发送 AI 对话消息
 */
export async function sendConstraintAIMessage(message) {
    if (!message?.trim()) return;

    const aiChat = this.state.constraintDialog?.aiChat;
    if (!aiChat?.conversationId) return;

    // 添加用户消息
    aiChat.messages.push({ role: 'user', content: message });
    aiChat.loading = true;
    this.render();

    // 清空输入框
    const input = document.getElementById('tt-ai-chat-input');
    if (input) input.value = '';

    try {
        const result = await requestTimetable('/constraints/chat/message', {
            method: 'POST',
            body: JSON.stringify({
                conversationId: aiChat.conversationId,
                message: message,
                intent: 'general',
            }),
        });

        // 添加 AI 回复
        aiChat.messages.push({
            role: 'assistant',
            content: result.response || '抱歉，我没有理解您的问题。',
        });
        aiChat.loading = false;
        aiChat.suggestedPrompts = result.suggestedPrompts || [];

        // 如果 AI 返回了优化后的约束，更新草稿
        if (result.updatedConstraints && result.updatedConstraints.length > 0) {
            this.state.ruleReview.draftRows = result.updatedConstraints;
            await this.detectConstraintConflicts();
        }

        this.render();

        // 滚动到最新消息
        setTimeout(() => {
            const chatContainer = document.querySelector('.tt-ai-chat-messages');
            if (chatContainer) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }
        }, 0);
    } catch (error) {
        console.error('Send AI message error:', error);
        aiChat.loading = false;
        aiChat.messages.push({
            role: 'assistant',
            content: `抱歉，发送消息失败：${error.message || '未知错误'}`,
        });
        this.render();
    }
}

/**
 * 关闭 AI 对话
 */
export function closeConstraintAIChat() {
    if (this.state.constraintDialog?.aiChat) {
        this.state.constraintDialog.aiChat.active = false;
    }
    this.render();
}

/**
 * 使用 AI 建议的提示语
 */
export function useAISuggestedPrompt(prompt) {
    this.sendConstraintAIMessage(prompt);
}
