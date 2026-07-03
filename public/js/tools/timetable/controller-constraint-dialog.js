/**
 * 智能约束助手弹窗控制器扩展
 * 处理弹窗打开/关闭、输入模式切换、约束解析和应用
 */

import { requestTimetable } from './api.js';

/**
 * 打开智能约束助手弹窗
 */
export function openConstraintDialog() {
    this.state.constraintDialog = {
        open: true,
    };

    // 确保 ruleReview 状态存在
    if (!this.state.ruleReview) {
        this.state.ruleReview = {
            inputMode: 'text',
            text: '',
            draftRows: [],
            parsing: false,
        };
    }

    this.render();
}

/**
 * 关闭智能约束助手弹窗
 */
export function closeConstraintDialog() {
    this.state.constraintDialog = {
        open: false,
    };
    this.render();
}

/**
 * 切换输入模式
 */
export function switchConstraintMode(mode) {
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    this.state.ruleReview.inputMode = mode;
    this.render();
}

/**
 * 使用示例文本
 */
export function useConstraintExample(text) {
    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    const currentText = this.state.ruleReview.text || '';
    this.state.ruleReview.text = currentText ? `${currentText}\n${text}` : text;
    this.render();

    // 聚焦到文本框末尾
    setTimeout(() => {
        const textarea = document.getElementById('tt-constraint-text-input');
        if (textarea) {
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        }
    }, 0);
}

/**
 * 解析约束（优化版：支持进度反馈）
 */
export async function parseConstraintsFromDialog() {
    const review = this.state.ruleReview || {};
    const mode = review.inputMode || 'text';

    // 获取输入内容
    let inputData = {};
    if (mode === 'text') {
        const textarea = document.getElementById('tt-constraint-text-input');
        const text = textarea?.value?.trim();
        if (!text) {
            alert('请输入排课要求');
            return;
        }
        inputData = { text, source: 'text' };
        this.state.ruleReview.text = text;
    } else if (mode === 'file') {
        const fileInput = document.getElementById('tt-constraint-file-input');
        const file = fileInput?.files?.[0];
        if (!file) {
            alert('请选择文件');
            return;
        }
        inputData = { file, source: 'file' };
    } else {
        alert('手动模式请直接添加约束');
        return;
    }

    // 设置解析状态
    this.state.ruleReview.parsing = true;
    this.state.ruleReview.parseProgress = 0;
    this.state.ruleReview.phaseText = '正在分析您的要求...';
    this.render();

    // 模拟进度更新
    const progressInterval = setInterval(() => {
        if (this.state.ruleReview.parseProgress < 90) {
            this.state.ruleReview.parseProgress += 10;
            const phases = [
                '正在分析您的要求...',
                '正在识别教师和课程...',
                '正在理解时间约束...',
                '正在生成结构化规则...',
            ];
            const phaseIndex = Math.floor(this.state.ruleReview.parseProgress / 25);
            this.state.ruleReview.phaseText = phases[phaseIndex] || phases[phases.length - 1];
            this.render();
        }
    }, 300);

    try {
        // 调用后端解析接口
        const formData = new FormData();
        if (mode === 'text') {
            formData.append('text', inputData.text);
            formData.append('source', 'text');
        } else if (mode === 'file') {
            formData.append('file', inputData.file);
            formData.append('source', 'file');
        }
        formData.append('project', JSON.stringify(this.state.project || {}));

        const result = await requestTimetable('/rule-review/parse', {
            method: 'POST',
            body: formData,
        });

        clearInterval(progressInterval);

        // 更新状态
        this.state.ruleReview.parsing = false;
        this.state.ruleReview.parseProgress = 100;
        this.state.ruleReview.phaseText = '';

        // 合并新解析的约束
        const existingRows = this.state.ruleReview.draftRows || [];
        const newRows = result.rows || [];
        this.state.ruleReview.draftRows = [...existingRows, ...newRows];

        // 自动检测冲突
        await this.detectConstraintConflicts();

        this.render();
    } catch (error) {
        clearInterval(progressInterval);
        console.error('Parse constraints error:', error);
        this.state.ruleReview.parsing = false;
        this.state.ruleReview.parseProgress = 0;
        this.state.ruleReview.phaseText = '';
        this.render();
        alert(`解析失败：${error.message || '未知错误'}`);
    }
}

/**
 * 添加手动约束
 */
export function addManualConstraint() {
    const type = document.getElementById('tt-manual-type')?.value;
    const target = document.getElementById('tt-manual-target')?.value?.trim();
    const time = document.getElementById('tt-manual-time')?.value?.trim();

    if (!target || !time) {
        alert('请填写对象和时间');
        return;
    }

    const constraint = {
        id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type,
        typeLabel: { forbid: '禁止', prefer: '优先', avoid: '尽量避开' }[type] || type,
        targetName: target,
        timeLabel: time,
        target: { name: target },
        time: { label: time },
        understanding: `${target} ${time} ${{ forbid: '不排课', prefer: '优先排课', avoid: '尽量避开' }[type]}`,
        sourceText: '手动添加',
        confidenceTone: 'high',
        confidenceLabel: '高',
        status: 'ready',
    };

    if (!this.state.ruleReview) {
        this.state.ruleReview = { draftRows: [] };
    }
    if (!this.state.ruleReview.draftRows) {
        this.state.ruleReview.draftRows = [];
    }

    this.state.ruleReview.draftRows.push(constraint);
    this.render();

    // 清空表单
    setTimeout(() => {
        const targetInput = document.getElementById('tt-manual-target');
        const timeInput = document.getElementById('tt-manual-time');
        if (targetInput) targetInput.value = '';
        if (timeInput) timeInput.value = '';
    }, 0);
}

/**
 * 删除约束
 */
export function deleteConstraint(constraintId) {
    if (!this.state.ruleReview?.draftRows) return;

    this.state.ruleReview.draftRows = this.state.ruleReview.draftRows.filter(
        c => c.id !== constraintId
    );
    this.render();
}

/**
 * 清空所有约束
 */
export function clearAllConstraints() {
    if (!confirm('确定要清空所有已识别的约束吗？')) return;

    if (this.state.ruleReview) {
        this.state.ruleReview.draftRows = [];
    }
    this.render();
}

/**
 * 应用约束
 */
export async function applyConstraintsFromDialog() {
    const constraints = this.state.ruleReview?.draftRows || [];
    if (constraints.length === 0) {
        alert('没有可应用的约束');
        return;
    }

    if (!confirm(`确定要应用 ${constraints.length} 条约束吗？`)) {
        return;
    }

    try {
        // 将约束标记为已应用
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

        // 清空草稿
        this.state.ruleReview.draftRows = [];

        // 关闭弹窗
        this.closeConstraintDialog();

        // 重新渲染主界面
        this.render();

        alert(`成功应用 ${constraints.length} 条约束`);
    } catch (error) {
        console.error('Apply constraints error:', error);
        alert(`应用失败：${error.message || '未知错误'}`);
    }
}

/**
 * 处理文件选择
 */
export function handleConstraintFileSelect(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    if (!this.state.ruleReview) {
        this.state.ruleReview = {};
    }
    this.state.ruleReview.fileName = file.name;
    this.render();
}
