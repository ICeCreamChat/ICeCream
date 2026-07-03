/**
 * 智能约束助手弹窗控制器 - 高级功能
 * AI 对话、冲突检测、批量操作、约束编辑
 */

import { requestTimetable } from './api.js';

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
    };

    this.render();

    // 聚焦到编辑表单
    setTimeout(() => {
        const firstInput = document.querySelector('.tt-constraint-edit-form input, .tt-constraint-edit-form select, .tt-constraint-edit-form textarea');
        firstInput?.focus();
    }, 0);
}

/**
 * 保存编辑的约束
 */
export function saveEditedConstraint() {
    const editing = this.state.constraintDialog?.editingConstraint;
    if (!editing) return;

    // 读取表单数据
    const type = document.getElementById('tt-edit-constraint-type')?.value;
    const target = document.getElementById('tt-edit-constraint-target')?.value?.trim();
    const time = document.getElementById('tt-edit-constraint-time')?.value?.trim();
    const understanding = document.getElementById('tt-edit-constraint-understanding')?.value?.trim();

    if (!target || !time) {
        alert('请填写完整信息');
        return;
    }

    // 更新约束
    const updatedConstraint = {
        ...editing,
        type,
        typeLabel: { forbid: '禁止', prefer: '优先', avoid: '尽量避开' }[type] || type,
        targetName: target,
        timeLabel: time,
        target: { name: target },
        time: { label: time },
        understanding: understanding || `${target} ${time} ${{ forbid: '不排课', prefer: '优先排课', avoid: '尽量避开' }[type]}`,
    };

    // 替换原约束
    const index = this.state.ruleReview.draftRows.findIndex(c => c.id === editing.originalId);
    if (index >= 0) {
        this.state.ruleReview.draftRows[index] = updatedConstraint;
    }

    // 清除编辑状态
    this.state.constraintDialog.editingConstraint = null;

    // 重新检测冲突
    this.detectConstraintConflicts();

    this.render();
}

/**
 * 取消编辑约束
 */
export function cancelEditConstraint() {
    this.state.constraintDialog.editingConstraint = null;
    this.render();
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
