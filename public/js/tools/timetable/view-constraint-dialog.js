/**
 * 智能约束助手弹窗视图组件
 * 简化版：合并原工作台的输入、解析、预览功能为单一弹窗
 */

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

function escapeAttr(value) {
    return escapeHtml(value);
}

// 导入组件渲染函数
import {
    renderConstraintCard as renderCard,
    renderConstraintEditForm,
    renderAIChatPanel,
} from './view-constraint-dialog-components.js';

function renderConstraintCard(constraint, state) {
    return renderCard(constraint, state);
}

/**
 * 渲染智能约束助手弹窗
 */
export function renderConstraintDialog(state) {
    const dialog = state.constraintDialog || {};
    if (!dialog.open) return '';

    const review = state.ruleReview || {};
    const mode = review.inputMode || 'text';
    const constraints = review.draftRows || [];
    const parsing = review.parsing || false;
    const editingConstraint = dialog.editingConstraint;
    const aiChat = dialog.aiChat;

    return `
        <div class="tt-dialog-overlay" data-constraint-dialog-overlay>
            <section class="tt-constraint-dialog ${aiChat?.active ? 'tt-constraint-dialog--with-ai' : ''}" role="dialog" aria-modal="true" aria-labelledby="constraint-dialog-title">
                <!-- 标题栏 -->
                <div class="tt-dialog-header">
                    <div class="tt-dialog-title" id="constraint-dialog-title">
                        <i data-lucide="brain-circuit"></i>
                        <h3>智能约束助手</h3>
                        <p>告诉我排课要求，我会帮你整理成规则</p>
                    </div>
                    <div class="tt-dialog-header-actions">
                        ${constraints.length > 0 && !aiChat?.active ? `
                            <button class="tt-btn tt-btn--sm tt-btn--ghost" data-action="start-ai-chat" type="button" title="AI 优化约束">
                                <i data-lucide="sparkles"></i>
                                <span>AI 优化</span>
                            </button>
                        ` : ''}
                        <button class="tt-icon-btn" data-action="close-constraint-dialog" aria-label="关闭" type="button">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                </div>

                ${aiChat?.active ? renderAIChatPanel(state, aiChat) : `
                    <!-- 输入方式切换 -->
                    <div class="tt-constraint-input-tabs" role="tablist">
                        ${renderInputTabs(mode, parsing)}
                    </div>

                    <!-- 输入区域 -->
                    <div class="tt-constraint-input-area">
                        ${renderInputArea(state, mode, parsing, review)}
                    </div>

                    <!-- 编辑约束表单 -->
                    ${editingConstraint ? renderConstraintEditForm(editingConstraint) : ''}

                    <!-- 已识别约束预览 -->
                    ${constraints.length > 0 ? `
                        <div class="tt-constraint-preview">
                            <div class="tt-preview-header">
                                <strong>已识别约束 (${constraints.length})</strong>
                                ${review.conflictCheckDone && constraints.some(c => c.hasConflict) ? `
                                    <span class="tt-conflict-badge">
                                        <i data-lucide="alert-triangle"></i>
                                        ${constraints.filter(c => c.hasConflict).length} 条冲突
                                    </span>
                                ` : ''}
                                <button class="tt-btn-link" data-action="clear-all-constraints" type="button">清空全部</button>
                            </div>
                            <div class="tt-constraint-list">
                                ${constraints.map(c => renderConstraintCard(c, state)).join('')}
                            </div>
                        </div>
                    ` : ''}

                    <!-- 操作按钮 -->
                    <div class="tt-dialog-actions">
                        <button class="tt-btn" data-action="close-constraint-dialog" type="button">取消</button>
                        ${constraints.length > 0 ? `
                            <button class="tt-btn tt-btn--primary" data-action="apply-constraints" type="button">
                                <i data-lucide="check"></i>
                                <span>应用约束 (${constraints.length})</span>
                            </button>
                        ` : ''}
                    </div>
                `}
            </section>
        </div>
    `;
}

function renderInputTabs(mode, parsing) {
    const tabs = [
        { key: 'text', icon: 'message-square', label: '对话输入' },
        { key: 'file', icon: 'upload', label: '上传文件' },
        { key: 'manual', icon: 'list-plus', label: '手动填写' },
    ];

    return tabs.map(tab => `
        <button
            class="tt-tab-btn ${mode === tab.key ? 'is-active' : ''}"
            role="tab"
            aria-selected="${mode === tab.key}"
            data-action="switch-constraint-mode"
            data-mode="${tab.key}"
            type="button"
            ${parsing ? 'disabled' : ''}
        >
            <i data-lucide="${tab.icon}"></i>
            <span>${tab.label}</span>
        </button>
    `).join('');
}

function renderInputArea(state, mode, parsing, review) {
    if (mode === 'text') {
        return `
            <div class="tt-text-input">
                <label>
                    <span>描述您的排课要求</span>
                    <textarea
                        id="tt-constraint-text-input"
                        rows="6"
                        placeholder="例如：张老师周一上午不排课；数学尽量安排在上午；体育避开第一节"
                        ${parsing ? 'disabled' : ''}
                    >${escapeHtml(review?.text || '')}</textarea>
                </label>
                <div class="tt-quick-examples">
                    ${['张老师周一不排课', '数学尽量排上午', '体育避开第一节'].map(ex => `
                        <button class="tt-example-chip" data-action="use-example" data-text="${escapeAttr(ex)}" type="button">
                            ${escapeHtml(ex)}
                        </button>
                    `).join('')}
                </div>
                ${parsing ? `
                    <div class="tt-parsing-status">
                        <i data-lucide="loader-2" class="tt-spin"></i>
                        <div class="tt-parsing-info">
                            <span>${escapeHtml(review?.phaseText || '正在理解您的要求...')}</span>
                            ${review?.parseProgress !== undefined ? `
                                <div class="tt-progress-bar">
                                    <div class="tt-progress-fill" style="width: ${review.parseProgress}%"></div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                ` : `
                    <button
                        class="tt-btn tt-btn--primary tt-btn--block"
                        data-action="parse-constraints"
                        type="button"
                    >
                        <i data-lucide="wand-sparkles"></i>
                        <span>理解我的要求</span>
                    </button>
                `}
            </div>
        `;
    }

    if (mode === 'file') {
        return `
            <div class="tt-file-input">
                <label class="tt-file-upload-area" for="tt-constraint-file-input">
                    <input type="file" id="tt-constraint-file-input" accept=".txt,.csv,.xlsx,.xls" hidden ${parsing ? 'disabled' : ''}>
                    <i data-lucide="upload-cloud"></i>
                    <strong>${escapeHtml(review.fileName || '点击选择文件')}</strong>
                    <span>支持 TXT / CSV / XLSX 格式</span>
                </label>
                ${review.fileName ? `
                    <button class="tt-btn tt-btn--primary tt-btn--block" data-action="parse-constraints" type="button" ${parsing ? 'disabled' : ''}>
                        <i data-lucide="${parsing ? 'loader-2' : 'file-text'}" ${parsing ? 'class="tt-spin"' : ''}></i>
                        <span>${parsing ? '正在解析...' : '解析文件内容'}</span>
                    </button>
                ` : ''}
            </div>
        `;
    }

    if (mode === 'manual') {
        return `
            <div class="tt-manual-input">
                <div class="tt-form-grid">
                    <label>
                        <span>约束类型</span>
                        <select id="tt-manual-type">
                            <option value="forbid">禁止安排</option>
                            <option value="prefer">优先安排</option>
                            <option value="avoid">尽量避开</option>
                        </select>
                    </label>
                    <label>
                        <span>对象</span>
                        <input type="text" id="tt-manual-target" placeholder="教师名或课程名">
                    </label>
                    <label>
                        <span>时间</span>
                        <input type="text" id="tt-manual-time" placeholder="周一上午 或 第1-2节">
                    </label>
                </div>
                <button class="tt-btn tt-btn--primary" data-action="add-manual-constraint" type="button">
                    <i data-lucide="plus"></i>
                    <span>添加约束</span>
                </button>
            </div>
        `;
    }

    return '';
}
