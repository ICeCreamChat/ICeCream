import { escapeHtml, showToast } from '../utils/helpers.js';
import { geogebraCanvas } from './geogebra-canvas.js';

const GEOGEBRA_STUDIO_SESSION_KEY = 'icecream_geogebra_studio_v1';
const GEOGEBRA_STUDIO_XML_LIMIT = 220000;
const GEOGEBRA_STUDIO_TABS = ['objects', 'adjust', 'commands', 'manual', 'projects', 'history'];
const GEOGEBRA_PROBLEM_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GEOGEBRA_PROBLEM_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const GEOGEBRA_STUDIO_BASE64_LIMIT = 900000;

const FALLBACK_STATUS = {
    assetsAvailable: false,
    aiAvailable: false,
    commandIndexReady: false,
};

function normalizeCommands(commands) {
    if (Array.isArray(commands)) {
        return commands.map(command => String(command || '').trim()).filter(Boolean).slice(0, 32);
    }
    return String(commands || '')
        .split(/\n|;/)
        .map(command => command.trim())
        .filter(Boolean)
        .slice(0, 32);
}

function objectDisplayName(item = {}) {
    return String(item.name || item.label || '').trim();
}

function summarizeExecution(records = []) {
    const failedRecord = records.find(record => !record.success);
    return {
        records,
        failedRecord,
        success: Boolean(records.length) && !failedRecord,
    };
}

function compactHistory(records = []) {
    return records.slice(-60).map(record => ({
        command: String(record.command || '').slice(0, 500),
        success: Boolean(record.success),
        label: String(record.label || '').slice(0, 120),
        error: String(record.error || '').slice(0, 240),
        source: String(record.source || '').slice(0, 80),
        createdAt: record.createdAt || new Date().toISOString(),
    }));
}

class GeoGebraStudio {
    constructor() {
        this.root = null;
        this.actions = {};
        this.activeTab = 'objects';
        this.commandHistory = [];
        this.selectedObjectNames = [];
        this.latestCanvasSnapshot = null;
        this.latestSummary = '';
        this.latestFollowUp = '';
        this.repairSummary = '';
        this.latestError = '';
        this.studioNotes = '';
        this.problemParseStatus = '';
        this.problemImageName = '';
        this.lastProblemImageFile = null;
        this.pendingProblemPlan = null;
        this.problemReviewText = '';
        this.problemExtractedText = '';
        this.problemImageDescription = '';
        this.adjustMessage = '';
        this.manualCommands = '';
        this.manualQuery = '';
        this.manualResults = [];
        this.manualStatus = '';
        this.projectPages = [];
        this.activeProjectPageId = '';
        this.busy = false;
        this.canvasMounted = false;
        this.canvasMountPromise = null;
        this.canvasLoadState = 'idle';
        this.canvasLoadError = '';
        this.sessionRestored = false;
        this.undoStack = [];
        this.redoStack = [];
        this.renderContext = { status: { ...FALLBACK_STATUS } };
        this.loadSession();
    }

    loadSession() {
        try {
            const rawSession = window.localStorage?.getItem(GEOGEBRA_STUDIO_SESSION_KEY);
            if (!rawSession) return;
            const session = JSON.parse(rawSession);
            this.commandHistory = compactHistory(session.commandHistory || []);
            this.selectedObjectNames = Array.isArray(session.selectedObjectNames)
                ? session.selectedObjectNames.map(String).filter(Boolean).slice(0, 20)
                : [];
            this.latestSummary = String(session.latestSummary || '');
            this.latestFollowUp = String(session.latestFollowUp || '');
            this.repairSummary = String(session.repairSummary || '');
            this.latestError = String(session.latestError || '');
            this.studioNotes = String(session.studioNotes || '');
            this.problemParseStatus = String(session.problemParseStatus || '');
            this.problemImageName = String(session.problemImageName || '');
            this.pendingProblemPlan = session.pendingProblemPlan && typeof session.pendingProblemPlan === 'object'
                ? session.pendingProblemPlan
                : null;
            this.problemReviewText = String(session.problemReviewText || '');
            this.problemExtractedText = String(session.problemExtractedText || '');
            this.problemImageDescription = String(session.problemImageDescription || '');
            this.adjustMessage = String(session.adjustMessage || '');
            this.manualCommands = String(session.manualCommands || '');
            this.manualQuery = String(session.manualQuery || '');
            this.manualResults = Array.isArray(session.manualResults) ? session.manualResults.slice(0, 10) : [];
            this.manualStatus = String(session.manualStatus || '');
            this.projectPages = Array.isArray(session.projectPages) ? session.projectPages.slice(0, 20) : [];
            this.activeProjectPageId = String(session.activeProjectPageId || '');
            if (session.latestCanvasSnapshot?.xml) {
                this.latestCanvasSnapshot = session.latestCanvasSnapshot;
            }
        } catch {
            // Local Studio state is optional; a corrupt session should not block the applet.
        }
    }

    saveSession() {
        try {
            const snapshot = this.latestCanvasSnapshot?.xml?.length <= GEOGEBRA_STUDIO_XML_LIMIT
                ? {
                    xml: this.latestCanvasSnapshot.xml,
                    perspective: this.latestCanvasSnapshot.perspective || 'G',
                    selectedObjects: this.latestCanvasSnapshot.selectedObjects || [],
                    createdAt: this.latestCanvasSnapshot.createdAt,
                }
                : null;
            window.localStorage?.setItem(GEOGEBRA_STUDIO_SESSION_KEY, JSON.stringify({
                commandHistory: compactHistory(this.commandHistory),
                selectedObjectNames: this.selectedObjectNames.slice(0, 20),
                latestSummary: this.latestSummary,
                latestFollowUp: this.latestFollowUp,
                repairSummary: this.repairSummary,
                latestError: this.latestError,
                studioNotes: this.studioNotes,
                problemParseStatus: this.problemParseStatus,
                problemImageName: this.problemImageName,
                pendingProblemPlan: this.pendingProblemPlan,
                problemReviewText: this.problemReviewText,
                problemExtractedText: this.problemExtractedText,
                problemImageDescription: this.problemImageDescription,
                adjustMessage: this.adjustMessage,
                manualCommands: this.manualCommands,
                manualQuery: this.manualQuery,
                manualResults: this.manualResults.slice(0, 10),
                manualStatus: this.manualStatus,
                projectPages: this.projectPages.slice(0, 20).map(page => ({
                    ...page,
                    base64: page.base64 && page.base64.length <= GEOGEBRA_STUDIO_BASE64_LIMIT ? page.base64 : '',
                })),
                activeProjectPageId: this.activeProjectPageId,
                latestCanvasSnapshot: snapshot,
            }));
        } catch {
            // Storage quota is not fatal; the current in-memory Studio still works.
        }
    }

    render(context = {}) {
        this.renderContext = {
            ...this.renderContext,
            ...context,
            status: { ...FALLBACK_STATUS, ...(context.status || this.renderContext.status || {}) },
        };

        return `
            <section class="geogebra-studio-root" aria-label="GeoGebra Studio">
                ${this.renderHead()}
                <div class="geogebra-studio-layout">
                    ${this.renderCanvasArea()}
                    ${this.renderSidebar()}
                </div>
            </section>
        `;
    }

    renderHead() {
        const status = { ...FALLBACK_STATUS, ...(this.renderContext.status || {}) };
        return `
            <header class="geogebra-studio-head">
                <div>
                    <span class="manim-workbench-eyebrow">GeoGebra Studio</span>
                    <strong>动态几何工作台</strong>
                    <small>调整对象、执行命令、上传题目并继续用 AI 修改构图。</small>
                </div>
                <div class="geogebra-head-actions">
                    <button type="button" class="manim-workbench-secondary geogebra-problem-upload" data-geogebra-studio-action="upload-problem" ${this.busy ? 'disabled' : ''}>
                        <i data-lucide="image-plus"></i>
                        <span>上传题目</span>
                    </button>
                    <div class="geogebra-status-row">
                        ${this.renderStatusChip('离线资源', status.assetsAvailable)}
                        ${this.renderStatusChip('AI 调整', status.aiAvailable)}
                        ${this.renderStatusChip('命令索引', status.commandIndexReady)}
                    </div>
                </div>
            </header>
        `;
    }

    renderStatusChip(label, enabled) {
        return `
            <span class="geogebra-status-chip ${enabled ? 'ready' : 'offline'}">
                <i data-lucide="${enabled ? 'check-circle-2' : 'circle-alert'}"></i>
                ${escapeHtml(label)}
            </span>
        `;
    }

    renderCanvasArea() {
        const isLoading = this.canvasLoadState === 'loading' || (!this.canvasMounted && this.canvasLoadState !== 'error');
        const isError = this.canvasLoadState === 'error';
        return `
            <main class="geogebra-studio-canvas-pane">
                <div class="geogebra-canvas-shell">
                    <div id="geogebra-canvas-root" class="geogebra-canvas-root" role="application" aria-label="GeoGebra 动态几何画布"></div>
                    <div class="geogebra-canvas-loading" data-geogebra-canvas-loading ${isLoading ? '' : 'hidden'}>
                        <span>正在加载 GeoGebra 离线画布...</span>
                    </div>
                    <div class="geogebra-canvas-error-state" data-geogebra-canvas-error ${isError ? '' : 'hidden'}>
                        <strong>GeoGebra 画布加载失败</strong>
                        <span>${escapeHtml(this.canvasLoadError || this.latestError || '离线运行时暂时无法启动。')}</span>
                        <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="retry-canvas">
                            <i data-lucide="refresh-ccw"></i>
                            <span>重试加载</span>
                        </button>
                    </div>
                </div>
                ${this.renderFooter()}
            </main>
        `;
    }

    renderFooter() {
        return `
            <div class="geogebra-studio-footer">
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="refresh-objects">
                    <i data-lucide="scan-search"></i>
                    <span>刷新对象</span>
                </button>
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="undo" ${this.undoStack.length ? '' : 'disabled'}>
                    <i data-lucide="undo-2"></i>
                    <span>撤销</span>
                </button>
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="redo" ${this.redoStack.length ? '' : 'disabled'}>
                    <i data-lucide="redo-2"></i>
                    <span>重做</span>
                </button>
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="reset">
                    <i data-lucide="rotate-ccw"></i>
                    <span>重置</span>
                </button>
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="export">
                    <i data-lucide="image-down"></i>
                    <span>导出</span>
                </button>
                <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="export-ggb">
                    <i data-lucide="download"></i>
                    <span>导出GGB</span>
                </button>
            </div>
        `;
    }

    renderSidebar() {
        return `
            <aside class="geogebra-studio-sidebar">
                <div class="geogebra-studio-tabs" role="tablist" aria-label="GeoGebra Studio panels">
                    ${this.renderTab('objects', '对象')}
                    ${this.renderTab('adjust', 'AI 调整')}
                    ${this.renderTab('commands', '命令')}
                    ${this.renderTab('manual', '参考')}
                    ${this.renderTab('projects', '草稿')}
                    ${this.renderTab('history', '历史')}
                </div>
                <div class="geogebra-studio-panel">
                    ${this.renderActivePanel()}
                </div>
                ${this.renderStudioMessages()}
            </aside>
        `;
    }

    renderTab(id, label) {
        const active = this.activeTab === id;
        return `
            <button type="button" class="${active ? 'active' : ''}" data-geogebra-studio-tab="${escapeHtml(id)}" role="tab" aria-selected="${active}">
                ${escapeHtml(label)}
            </button>
        `;
    }

    renderActivePanel() {
        if (this.activeTab === 'adjust') return this.renderAdjustPanel();
        if (this.activeTab === 'commands') return this.renderCommandPanel();
        if (this.activeTab === 'manual') return this.renderManualReferencePanel();
        if (this.activeTab === 'projects') return this.renderProjectsPanel();
        if (this.activeTab === 'history') return this.renderHistoryPanel();
        return this.renderObjectsPanel();
    }

    renderObjectsPanel() {
        const objects = this.latestCanvasSnapshot?.objects || [];
        const selected = new Set(this.selectedObjectNames);
        const objectRows = objects.length
            ? objects.slice(0, 80).map(item => {
                const name = objectDisplayName(item);
                const active = selected.has(name);
                return `
                    <button type="button" class="geogebra-studio-object-row ${active ? 'active' : ''}" data-geogebra-studio-object="${escapeHtml(name)}">
                        <span>
                            <strong>${escapeHtml(name || '未命名对象')}</strong>
                            <small>${escapeHtml(item.type || 'object')}</small>
                        </span>
                        <i data-lucide="${active ? 'check-circle-2' : 'circle'}"></i>
                    </button>
                `;
            }).join('')
            : '<div class="manim-workbench-empty compact">画布中暂时没有对象。可以从主输入框或命令区创建几何图形。</div>';

        return `
            <div class="geogebra-studio-section">
                <div class="geogebra-studio-section-head">
                    <strong>对象检查器</strong>
                    <span>${objects.length} 个对象，${this.selectedObjectNames.length} 个选中</span>
                </div>
                <div class="geogebra-studio-object-list">${objectRows}</div>
                ${this.renderSelectedInspector(objects)}
            </div>
        `;
    }

    renderSelectedInspector(objects = []) {
        const selectedObjects = this.getSelectedObjects(objects);
        if (!selectedObjects.length) {
            return '<div class="geogebra-studio-inspector muted">选择对象后，会在这里显示定义和值，并作为 AI 调整上下文。</div>';
        }
        return `
            <div class="geogebra-studio-inspector">
                ${selectedObjects.map(item => `
                    <div class="geogebra-studio-inspector-card">
                        <strong>${escapeHtml(objectDisplayName(item))}</strong>
                        <dl>
                            <dt>类型</dt><dd>${escapeHtml(item.type || '-')}</dd>
                            <dt>定义</dt><dd>${escapeHtml(item.definition || '-')}</dd>
                            <dt>值</dt><dd>${escapeHtml(item.value || '-')}</dd>
                        </dl>
                    </div>
                `).join('')}
            </div>
        `;
    }

    renderAdjustPanel() {
        return `
            <div class="geogebra-studio-section">
                <div class="geogebra-studio-section-head">
                    <strong>自然语言调整</strong>
                    <span>${this.busy ? '正在生成命令' : '会携带当前画布与选中对象'}</span>
                </div>
                <textarea class="geogebra-studio-adjust-input" data-geogebra-studio-adjust-input rows="5" placeholder="例如：把选中的点改成红色并显示标签">${escapeHtml(this.adjustMessage)}</textarea>
                <button type="button" class="manim-workbench-primary geogebra-studio-wide-action" data-geogebra-studio-action="run-adjust" ${this.busy ? 'disabled' : ''}>
                    <i data-lucide="sparkles"></i>
                    <span>应用 AI 调整</span>
                </button>
            </div>
        `;
    }

    renderCommandPanel() {
        return `
            <div class="geogebra-studio-section">
                <div class="geogebra-studio-section-head">
                    <strong>命令编辑器</strong>
                    <span>一行一条 GeoGebra 命令</span>
                </div>
                <textarea class="geogebra-studio-command-editor" data-geogebra-studio-command-editor rows="8" spellcheck="false" placeholder="A = (0, 0)&#10;B = (4, 0)&#10;c = Circle(A, B)">${escapeHtml(this.manualCommands)}</textarea>
                <button type="button" class="manim-workbench-primary geogebra-studio-wide-action" data-geogebra-studio-action="run-commands" ${this.busy ? 'disabled' : ''}>
                    <i data-lucide="play"></i>
                    <span>执行命令</span>
                </button>
            </div>
        `;
    }

    renderManualReferencePanel() {
        const rows = this.manualResults.length
            ? this.manualResults.map(match => `
                <article class="geogebra-manual-result">
                    <strong>${escapeHtml(match.title || '')}</strong>
                    <small>${escapeHtml(match.type || '')} · ${escapeHtml(match.source || '')}</small>
                    <p>${escapeHtml(match.summary || '')}</p>
                    ${(match.syntax || []).length ? `<code>${escapeHtml(match.syntax[0])}</code>` : ''}
                    ${(match.examples || []).length ? `<button type="button" class="manim-workbench-secondary" data-geogebra-manual-example="${escapeHtml(match.examples[0])}">填入示例</button>` : ''}
                </article>
            `).join('')
            : '<div class="manim-workbench-empty compact">搜索 Circle、Locus、Midpoint、getBase64 等命令或 API。</div>';
        return `
            <div class="geogebra-studio-section geogebra-manual-reference">
                <div class="geogebra-studio-section-head">
                    <strong>GeoGebra 手册参考</strong>
                    <span>${escapeHtml(this.manualStatus || '本地紧凑索引')}</span>
                </div>
                <input class="geogebra-studio-manual-search" data-geogebra-manual-search-input value="${escapeHtml(this.manualQuery)}" placeholder="搜索命令、工具、API，例如 Locus 或 getBase64">
                <button type="button" class="manim-workbench-primary geogebra-studio-wide-action" data-geogebra-studio-action="search-manual" ${this.busy ? 'disabled' : ''}>
                    <i data-lucide="book-open-text"></i>
                    <span>搜索参考</span>
                </button>
                <div class="geogebra-manual-results">${rows}</div>
            </div>
        `;
    }

    renderProjectsPanel() {
        const rows = this.projectPages.length
            ? this.projectPages.map(page => `
                <article class="geogebra-project-page ${page.id === this.activeProjectPageId ? 'active' : ''}">
                    <button type="button" data-geogebra-project-load="${escapeHtml(page.id)}">
                        <strong>${escapeHtml(page.title || '未命名草稿')}</strong>
                        <small>${escapeHtml(page.updatedAt || page.createdAt || '')}</small>
                    </button>
                    <button type="button" class="manim-workbench-secondary" data-geogebra-project-delete="${escapeHtml(page.id)}">
                        <i data-lucide="trash-2"></i>
                    </button>
                </article>
            `).join('')
            : '<div class="manim-workbench-empty compact">还没有草稿页。可以先保存当前画布，之后再恢复继续编辑。</div>';
        return `
            <div class="geogebra-studio-section geogebra-projects-panel">
                <div class="geogebra-studio-section-head">
                    <strong>Studio 草稿页</strong>
                    <span>${this.projectPages.length} 页</span>
                </div>
                <div class="geogebra-project-actions">
                    <button type="button" class="manim-workbench-primary" data-geogebra-studio-action="save-page">
                        <i data-lucide="save"></i>
                        <span>保存当前页</span>
                    </button>
                    <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="new-page">
                        <i data-lucide="file-plus-2"></i>
                        <span>新建页</span>
                    </button>
                </div>
                <div class="geogebra-project-list">${rows}</div>
            </div>
        `;
    }

    renderHistoryPanel() {
        return `
            <div class="geogebra-studio-section geogebra-command-history">
                <div class="geogebra-studio-section-head">
                    <strong>命令历史</strong>
                    <span>${this.commandHistory.length ? `最近 ${Math.min(this.commandHistory.length, 60)} 条` : '暂无执行记录'}</span>
                </div>
                ${this.renderCommandHistory()}
                ${this.commandHistory.length ? `
                    <button type="button" class="manim-workbench-secondary geogebra-studio-wide-action" data-geogebra-studio-action="clear-history">
                        <i data-lucide="trash-2"></i>
                        <span>清空历史</span>
                    </button>
                ` : ''}
            </div>
        `;
    }

    renderCommandHistory() {
        if (!this.commandHistory.length) {
            return '<div class="manim-workbench-empty compact">暂无命令。进入 GeoGebra Studio 后，可以用主输入框、AI 调整或命令编辑器创建图形。</div>';
        }
        return `
            <div class="geogebra-command-list">
                ${this.commandHistory.slice(-30).map(record => `
                    <div class="geogebra-command-row ${record.success ? 'success' : 'error'}">
                        <code>${escapeHtml(record.command)}</code>
                        <span>${record.success ? escapeHtml(record.label || record.source || 'ok') : escapeHtml(record.error || 'failed')}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    renderProblemReview() {
        if (!this.pendingProblemPlan) return '';
        return `
            <div class="geogebra-problem-review">
                <strong>题目解析复核</strong>
                <small>先确认 OCR/题意，再自动绘图。</small>
                <textarea data-geogebra-problem-review-input rows="4">${escapeHtml(this.problemReviewText || this.problemExtractedText || '')}</textarea>
                ${this.problemImageDescription ? `<p>${escapeHtml(this.problemImageDescription)}</p>` : ''}
                <div class="geogebra-problem-review-actions">
                    <button type="button" class="manim-workbench-primary" data-geogebra-studio-action="draw-problem-plan">
                        <i data-lucide="play"></i>
                        <span>按解析绘图</span>
                    </button>
                    <button type="button" class="manim-workbench-secondary" data-geogebra-studio-action="replan-problem-text">
                        <i data-lucide="refresh-cw"></i>
                        <span>按修正文题重算</span>
                    </button>
                </div>
            </div>
        `;
    }

    renderStudioMessages() {
        return `
            <div class="geogebra-studio-messages">
                ${this.problemParseStatus ? `<div class="geogebra-problem-status">${escapeHtml(this.problemParseStatus)}</div>` : ''}
                ${this.renderProblemReview()}
                ${this.latestSummary ? `<div class="geogebra-summary">${escapeHtml(this.latestSummary)}</div>` : ''}
                ${this.studioNotes ? `<div class="geogebra-studio-note">${escapeHtml(this.studioNotes)}</div>` : ''}
                ${this.repairSummary ? `<div class="geogebra-repair-summary">${escapeHtml(this.repairSummary)}</div>` : ''}
                ${this.latestFollowUp ? `<div class="geogebra-follow-up">${escapeHtml(this.latestFollowUp)}</div>` : ''}
                ${this.latestError ? `<div class="geogebra-error">${escapeHtml(this.latestError)}</div>` : ''}
                ${this.lastProblemImageFile && this.latestError ? `
                    <button type="button" class="manim-workbench-secondary geogebra-studio-wide-action" data-geogebra-studio-action="retry-problem-image">
                        <i data-lucide="refresh-ccw"></i>
                        <span>重试题目解析</span>
                    </button>
                ` : ''}
            </div>
        `;
    }

    bind(root, actions = {}, options = {}) {
        this.root = root || this.root;
        this.actions = actions || this.actions || {};
        if (!this.root) return;

        this.root.querySelectorAll('[data-geogebra-studio-tab]').forEach(button => {
            button.addEventListener('click', () => {
                this.activeTab = GEOGEBRA_STUDIO_TABS.includes(button.dataset.geogebraStudioTab)
                    ? button.dataset.geogebraStudioTab
                    : 'objects';
                this.refresh();
            });
        });

        this.root.querySelectorAll('[data-geogebra-studio-object]').forEach(button => {
            button.addEventListener('click', () => this.selectObject(button.dataset.geogebraStudioObject));
        });

        this.root.querySelector('[data-geogebra-studio-adjust-input]')?.addEventListener('input', (event) => {
            this.adjustMessage = event.target.value;
            this.saveSession();
        });
        this.root.querySelector('[data-geogebra-studio-command-editor]')?.addEventListener('input', (event) => {
            this.manualCommands = event.target.value;
            this.saveSession();
        });
        this.root.querySelector('[data-geogebra-manual-search-input]')?.addEventListener('input', (event) => {
            this.manualQuery = event.target.value;
            this.saveSession();
        });
        this.root.querySelector('[data-geogebra-problem-review-input]')?.addEventListener('input', (event) => {
            this.problemReviewText = event.target.value;
            this.saveSession();
        });

        this.root.querySelectorAll('[data-geogebra-manual-example]').forEach(button => {
            button.addEventListener('click', () => {
                this.manualCommands = [this.manualCommands, button.dataset.geogebraManualExample]
                    .map(value => String(value || '').trim())
                    .filter(Boolean)
                    .join('\n');
                this.activeTab = 'commands';
                this.saveSession();
                this.refresh();
            });
        });

        this.root.querySelectorAll('[data-geogebra-project-load]').forEach(button => {
            button.addEventListener('click', () => this.loadProjectPage(button.dataset.geogebraProjectLoad));
        });
        this.root.querySelectorAll('[data-geogebra-project-delete]').forEach(button => {
            button.addEventListener('click', () => this.deleteProjectPage(button.dataset.geogebraProjectDelete));
        });

        this.root.querySelectorAll('[data-geogebra-studio-action]').forEach(button => {
            button.addEventListener('click', () => this.handleAction(button.dataset.geogebraStudioAction));
        });

        if (!options.skipMount && this.needsCanvasMount()) {
            const domWasReplaced = this.canvasMounted && !this.isCanvasDomReady();
            if (domWasReplaced) {
                this.canvasMounted = false;
            }
            this.mountCanvas({
                forceRebuild: domWasReplaced,
                restoreSnapshot: domWasReplaced,
            });
        }
    }

    async mountCanvas(options = {}) {
        if (this.canvasMountPromise && !options.forceRebuild) {
            return this.canvasMountPromise;
        }
        this.canvasMountPromise = this.performCanvasMount(options).finally(() => {
            this.canvasMountPromise = null;
        });
        return this.canvasMountPromise;
    }

    needsCanvasMount() {
        const canvasRoot = this.getCanvasRoot();
        if (!canvasRoot) return false;
        return !this.canvasMounted || !this.isCanvasDomReady(canvasRoot);
    }

    getCanvasRoot() {
        return this.root?.querySelector?.('#geogebra-canvas-root') || document.getElementById('geogebra-canvas-root');
    }

    isCanvasDomReady(canvasRoot = this.getCanvasRoot()) {
        if (!canvasRoot) return false;
        const hasInjectedApplet = Boolean(canvasRoot.querySelector('.applet_scaler, .GeoGebraFrame, article, canvas, iframe'))
            || canvasRoot.childElementCount > 0;
        return canvasRoot.dataset.geogebraReady === 'true' && hasInjectedApplet;
    }

    async performCanvasMount(options = {}) {
        this.canvasLoadState = 'loading';
        this.canvasLoadError = '';
        this.latestError = '';
        this.refreshCanvasOverlay();
        try {
            if (options.restoreSnapshot) {
                this.sessionRestored = false;
            }
            if (options.forceRebuild) {
                await geogebraCanvas.rebuild('geogebra-canvas-root');
            } else {
                await geogebraCanvas.mount('geogebra-canvas-root');
            }
            if (!this.isCanvasDomReady()) {
                this.sessionRestored = false;
                await geogebraCanvas.rebuild('geogebra-canvas-root');
            }
            if (!this.isCanvasDomReady()) {
                await geogebraCanvas.mountIframeFallback(new Error('GeoGebra applet mounted but the current canvas DOM is empty'));
            }
            if (!this.isCanvasDomReady()) {
                throw new Error('GeoGebra applet mounted but the current canvas DOM is empty');
            }
            this.canvasMounted = true;
            this.canvasLoadState = 'ready';
            this.canvasLoadError = '';
            await this.restoreSavedCanvasOnce();
            this.refreshCanvasState();
            this.refresh();
            this.refreshCanvasOverlay();
        } catch (error) {
            this.latestError = error?.message || 'GeoGebra 画布加载失败';
            this.canvasLoadState = 'error';
            this.canvasLoadError = this.latestError;
            this.canvasMounted = false;
            showToast(this.latestError, 'error');
            this.refresh();
            this.refreshCanvasOverlay();
        }
    }

    refreshCanvasOverlay() {
        if (!this.root) return;
        const loading = this.root.querySelector('[data-geogebra-canvas-loading]');
        const error = this.root.querySelector('[data-geogebra-canvas-error]');
        if (loading) {
            loading.hidden = this.canvasLoadState !== 'loading' && (this.canvasMounted || this.canvasLoadState === 'error');
        }
        if (error) {
            error.hidden = this.canvasLoadState !== 'error';
            const errorText = error.querySelector('span');
            if (errorText) {
                errorText.textContent = this.canvasLoadError || this.latestError || '离线运行时暂时无法启动。';
            }
        }
        this.refreshIcons();
    }

    async restoreSavedCanvasOnce() {
        if (this.sessionRestored) return;
        this.sessionRestored = true;
        if (!this.latestCanvasSnapshot?.xml) return;
        await geogebraCanvas.restoreSnapshot(this.latestCanvasSnapshot);
    }

    refresh(context = {}) {
        if (!this.root) return;
        this.renderContext = {
            ...this.renderContext,
            ...context,
            status: { ...FALLBACK_STATUS, ...(context.status || this.renderContext.status || {}) },
        };
        const head = this.root.querySelector('.geogebra-studio-head');
        const sidebar = this.root.querySelector('.geogebra-studio-sidebar');
        const footer = this.root.querySelector('.geogebra-studio-footer');
        if (head) head.outerHTML = this.renderHead();
        if (sidebar) sidebar.outerHTML = this.renderSidebar();
        if (footer) footer.outerHTML = this.renderFooter();
        this.bind(this.root, this.actions, { skipMount: true });
        this.refreshIcons();
    }

    refreshIcons() {
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    refreshCanvasState() {
        const snapshot = geogebraCanvas.captureSnapshot('studio');
        this.latestCanvasSnapshot = snapshot;
        if (snapshot.selectedObjects?.length) {
            this.selectedObjectNames = snapshot.selectedObjects.map(String).filter(Boolean).slice(0, 20);
        }
        this.saveSession();
        return snapshot;
    }

    getSelectedObjects(objects = this.latestCanvasSnapshot?.objects || []) {
        const selected = new Set(this.selectedObjectNames);
        return objects.filter(item => selected.has(objectDisplayName(item)));
    }

    getCommandHistory() {
        return compactHistory(this.commandHistory);
    }

    resetSessionRuntime(options = {}) {
        this.commandHistory = [];
        this.latestSummary = '';
        this.latestFollowUp = '';
        this.repairSummary = '';
        this.latestError = '';
        this.studioNotes = '';
        this.problemParseStatus = '';
        this.problemImageName = '';
        this.lastProblemImageFile = null;
        this.pendingProblemPlan = null;
        this.problemReviewText = '';
        this.problemExtractedText = '';
        this.problemImageDescription = '';
        this.selectedObjectNames = [];
        this.undoStack = [];
        this.redoStack = [];
        if (!options.preserveEditors) {
            this.adjustMessage = '';
            this.manualCommands = '';
        }
        this.latestCanvasSnapshot = geogebraCanvas.captureSnapshot('reset');
        this.saveSession();
        this.refresh();
    }

    selectObject(name) {
        const objectName = String(name || '').trim();
        if (!objectName) return;
        if (this.selectedObjectNames.includes(objectName)) {
            this.selectedObjectNames = this.selectedObjectNames.filter(item => item !== objectName);
        } else {
            this.selectedObjectNames = [objectName, ...this.selectedObjectNames].slice(0, 20);
        }
        geogebraCanvas.setSelectedObjectNames(this.selectedObjectNames);
        this.saveSession();
        this.activeTab = 'objects';
        this.refresh();
    }

    async handleAction(action) {
        if (action === 'refresh-objects') {
            this.refreshCanvasState();
            this.refresh();
        } else if (action === 'retry-canvas') {
            await this.mountCanvas({ forceRebuild: true });
        } else if (action === 'reset') {
            await this.resetCanvas();
        } else if (action === 'undo') {
            await this.undo();
        } else if (action === 'redo') {
            await this.redo();
        } else if (action === 'export') {
            this.exportPng();
        } else if (action === 'export-ggb') {
            await this.exportGgb();
        } else if (action === 'upload-problem') {
            await this.selectProblemImage();
        } else if (action === 'retry-problem-image') {
            if (this.lastProblemImageFile) {
                await this.parseProblemImage(this.lastProblemImageFile);
            }
        } else if (action === 'run-adjust') {
            await this.runStudioAdjustment();
        } else if (action === 'run-commands') {
            await this.executeManualCommands();
        } else if (action === 'search-manual') {
            await this.searchManualReference();
        } else if (action === 'save-page') {
            await this.saveCurrentProjectPage();
        } else if (action === 'new-page') {
            await this.createProjectPage();
        } else if (action === 'draw-problem-plan') {
            await this.drawPendingProblemPlan();
        } else if (action === 'replan-problem-text') {
            await this.replanProblemText();
        } else if (action === 'clear-history') {
            this.commandHistory = [];
            this.saveSession();
            this.refresh();
        }
    }

    pushUndoSnapshot(label) {
        const snapshot = geogebraCanvas.captureSnapshot(label);
        if (snapshot.xml) {
            this.undoStack.push(snapshot);
            this.undoStack = this.undoStack.slice(-20);
            this.redoStack = [];
        }
    }

    async resetCanvas() {
        this.pushUndoSnapshot('reset');
        geogebraCanvas.reset();
        this.selectedObjectNames = [];
        this.latestSummary = 'GeoGebra 画布已重置';
        this.latestFollowUp = '';
        this.repairSummary = '';
        this.latestError = '';
        this.studioNotes = '';
        await new Promise(resolve => requestAnimationFrame(resolve));
        this.refreshCanvasState();
        this.refresh();
    }

    async undo() {
        const snapshot = this.undoStack.pop();
        if (!snapshot) return;
        const current = geogebraCanvas.captureSnapshot('redo');
        if (current.xml) {
            this.redoStack.push(current);
        }
        await geogebraCanvas.restoreSnapshot(snapshot);
        this.refreshCanvasState();
        this.latestSummary = '已恢复上一步构图';
        this.saveSession();
        this.refresh();
    }

    async redo() {
        const snapshot = this.redoStack.pop();
        if (!snapshot) return;
        const current = geogebraCanvas.captureSnapshot('undo');
        if (current.xml) {
            this.undoStack.push(current);
        }
        await geogebraCanvas.restoreSnapshot(snapshot);
        this.refreshCanvasState();
        this.latestSummary = '已重做下一步构图';
        this.saveSession();
        this.refresh();
    }

    exportPng() {
        const pngBase64 = geogebraCanvas.exportPngBase64();
        if (!pngBase64) {
            showToast('GeoGebra 当前画布暂时无法导出', 'error');
            return;
        }
        const anchor = document.createElement('a');
        anchor.href = `data:image/png;base64,${pngBase64}`;
        anchor.download = `geogebra-studio-${Date.now()}.png`;
        anchor.click();
    }

    async exportGgb() {
        const base64 = await geogebraCanvas.exportGgbBase64();
        if (!base64) {
            showToast('当前 GeoGebra 画布暂时无法导出 .ggb', 'error');
            return;
        }
        const anchor = document.createElement('a');
        anchor.href = `data:application/vnd.geogebra.file;base64,${base64}`;
        anchor.download = `geogebra-studio-${Date.now()}.ggb`;
        anchor.click();
    }

    async saveCurrentProjectPage() {
        await geogebraCanvas.mount('geogebra-canvas-root');
        const snapshot = this.refreshCanvasState();
        const base64 = await geogebraCanvas.getBase64();
        const now = new Date().toISOString();
        const pageId = this.activeProjectPageId || `page-${Date.now()}`;
        const existingIndex = this.projectPages.findIndex(page => page.id === pageId);
        const page = {
            id: pageId,
            title: this.latestSummary || `GeoGebra 草稿 ${this.projectPages.length + 1}`,
            snapshot,
            base64: base64 && base64.length <= GEOGEBRA_STUDIO_BASE64_LIMIT ? base64 : '',
            createdAt: this.projectPages[existingIndex]?.createdAt || now,
            updatedAt: now,
        };
        if (existingIndex >= 0) {
            this.projectPages.splice(existingIndex, 1, page);
        } else {
            this.projectPages.unshift(page);
        }
        this.projectPages = this.projectPages.slice(0, 20);
        this.activeProjectPageId = pageId;
        this.latestSummary = '已保存当前 GeoGebra 草稿页';
        this.saveSession();
        this.refresh();
    }

    async createProjectPage() {
        this.activeProjectPageId = `page-${Date.now()}`;
        await this.resetCanvas();
        this.latestSummary = '已新建 GeoGebra 草稿页';
        this.saveSession();
        this.refresh();
    }

    async loadProjectPage(pageId) {
        const page = this.projectPages.find(item => item.id === pageId);
        if (!page) return;
        await geogebraCanvas.mount('geogebra-canvas-root');
        let restored = false;
        if (page.base64) {
            restored = await geogebraCanvas.setBase64(page.base64);
        }
        if (!restored && page.snapshot?.xml) {
            restored = Boolean(await geogebraCanvas.restoreSnapshot(page.snapshot));
        }
        if (restored) {
            this.activeProjectPageId = page.id;
            this.latestSummary = `已恢复草稿页：${page.title || page.id}`;
            this.refreshCanvasState();
            this.saveSession();
            this.refresh();
        }
    }

    deleteProjectPage(pageId) {
        this.projectPages = this.projectPages.filter(page => page.id !== pageId);
        if (this.activeProjectPageId === pageId) {
            this.activeProjectPageId = '';
        }
        this.saveSession();
        this.refresh();
    }

    async searchManualReference() {
        const query = String(this.manualQuery || '').trim();
        if (!query) {
            showToast('请先输入要查找的 GeoGebra 命令或 API', 'error');
            return;
        }
        this.busy = true;
        this.manualStatus = '正在搜索本地手册索引...';
        this.refresh();
        try {
            const response = await fetch(`/api/geogebra/manual/search?q=${encodeURIComponent(query)}&limit=8`);
            const payload = await response.json();
            if (!response.ok || !payload?.success) {
                throw new Error(payload?.error || 'GeoGebra 手册搜索失败');
            }
            this.manualResults = payload.data?.matches || [];
            this.manualStatus = this.manualResults.length ? `找到 ${this.manualResults.length} 条参考` : '没有找到匹配参考';
            this.saveSession();
        } catch (error) {
            this.manualResults = [];
            this.manualStatus = error?.message || 'GeoGebra 手册搜索失败';
            showToast(this.manualStatus, 'error');
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    async executeCommandsWithUndo(commands, options = {}) {
        const normalizedCommands = normalizeCommands(commands);
        if (!normalizedCommands.length) return [];
        this.pushUndoSnapshot(options.label || 'commands');
        this.redoStack = [];
        const records = await geogebraCanvas.executeCommands(normalizedCommands);
        const source = options.source || 'studio';
        const createdAt = new Date().toISOString();
        this.commandHistory.push(...records.map(record => ({ ...record, source, createdAt })));
        this.commandHistory = compactHistory(this.commandHistory);
        this.refreshCanvasState();
        this.saveSession();
        return records;
    }

    async executePlanCommands(planBody = {}, options = {}) {
        this.busy = true;
        this.latestError = '';
        this.refresh();
        try {
            geogebraCanvas.setPerspective(planBody.perspective || 'G');
            if (!options.preserveSummary) {
                this.latestSummary = planBody.summary || '已生成 GeoGebra 命令';
            }
            this.latestFollowUp = planBody.followUp || this.latestFollowUp || '';
            this.studioNotes = planBody.studioNotes || this.studioNotes || '';
            if (planBody.repairSummary) {
                this.repairSummary = planBody.repairSummary;
            } else if (!options.preserveRepairSummary) {
                this.repairSummary = '';
            }
            const records = await this.executeCommandsWithUndo(planBody.commands, {
                source: options.source || 'plan',
                label: options.label || 'plan',
            });
            const summary = summarizeExecution(records);
            if (summary.failedRecord) {
                this.latestError = summary.failedRecord.error || 'GeoGebra 命令执行失败';
            }
            return summary;
        } finally {
            this.busy = false;
            this.saveSession();
            this.refresh();
        }
    }

    async executeManualCommands() {
        const commands = normalizeCommands(this.manualCommands);
        if (!commands.length) {
            showToast('请先输入 GeoGebra 命令', 'error');
            return summarizeExecution([]);
        }

        this.busy = true;
        this.latestError = '';
        this.refresh();
        try {
            const records = await this.executeCommandsWithUndo(commands, {
                source: 'manual',
                label: 'manual',
            });
            const summary = summarizeExecution(records);
            this.latestSummary = summary.success ? '手写命令已执行' : '部分手写命令执行失败';
            if (summary.failedRecord) {
                this.latestError = summary.failedRecord.error || 'GeoGebra 命令执行失败';
            }
            return summary;
        } finally {
            this.busy = false;
            this.saveSession();
            this.refresh();
        }
    }

    validateProblemImageFile(file) {
        if (!file) {
            throw new Error('请选择要解析的题目图片');
        }
        if (!GEOGEBRA_PROBLEM_IMAGE_TYPES.has(file.type)) {
            throw new Error('GeoGebra Studio 仅支持 PNG、JPG 或 WebP 题目图片');
        }
        if (file.size > GEOGEBRA_PROBLEM_IMAGE_MAX_BYTES) {
            throw new Error('题目图片不能超过 20MB');
        }
    }

    async selectProblemImage() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/webp';
        input.hidden = true;
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            input.remove();
            if (!file) return;
            try {
                this.validateProblemImageFile(file);
                await this.parseProblemImage(file);
            } catch (error) {
                this.latestError = error?.message || '题目图片解析失败';
                showToast(this.latestError, 'error');
                this.refresh();
            }
        }, { once: true });
        input.click();
    }

    async parseProblemImage(file) {
        this.validateProblemImageFile(file);
        this.lastProblemImageFile = file;
        this.problemImageName = file.name || '题目图片';
        this.problemParseStatus = `正在解析 ${this.problemImageName}...`;
        this.busy = true;
        this.latestError = '';
        this.refresh();

        try {
            await geogebraCanvas.mount('geogebra-canvas-root');
            const canvasSnapshot = this.refreshCanvasState();
            const selectedObjects = this.getSelectedObjects(canvasSnapshot.objects);
            const formData = new FormData();
            formData.append('image', file, file.name || 'geogebra-problem.png');
            formData.append('message', this.adjustMessage || '请解析上传的数学题目，优先重建题图或可交互几何图形，不需要输出完整解题步骤。');
            formData.append('canvas', JSON.stringify(canvasSnapshot));
            formData.append('selectedObjects', JSON.stringify(selectedObjects));
            formData.append('preferredPerspective', canvasSnapshot.perspective || 'G');

            const response = await fetch('/api/geogebra/studio/parse-image', {
                method: 'POST',
                body: formData,
            });
            const payload = await response.json();
            if (!response.ok || !payload?.success) {
                throw new Error(payload?.error || 'GeoGebra 题目解析失败');
            }

            const body = payload.data || {};
            this.pendingProblemPlan = body;
            this.problemExtractedText = String(body.extractedText || '');
            this.problemImageDescription = String(body.imageDescription || '');
            this.problemReviewText = this.problemExtractedText || this.adjustMessage || '';
            this.problemParseStatus = this.problemExtractedText
                ? `已解析题目，等待确认：${this.problemExtractedText.slice(0, 80)}${this.problemExtractedText.length > 80 ? '...' : ''}`
                : `${this.problemImageName} 已解析，请确认图形描述后再绘图`;
            this.latestSummary = body.summary || '已根据上传题目生成候选 GeoGebra 绘图计划';
            this.latestFollowUp = body.followUp || '请先核对 OCR 文本；如果识别不准，可以直接修改后重新生成。';
            this.studioNotes = body.studioNotes || '';
            this.activeTab = 'adjust';
            this.saveSession();
            return summarizeExecution([]);
        } catch (error) {
            this.latestError = error?.message || 'GeoGebra 题目解析失败';
            this.problemParseStatus = `${this.problemImageName} 解析失败`;
            showToast(this.latestError, 'error');
            return summarizeExecution([]);
        } finally {
            this.busy = false;
            this.saveSession();
            this.refresh();
        }
    }

    async drawPendingProblemPlan() {
        if (!this.pendingProblemPlan) {
            showToast('暂无可绘制的题目解析结果', 'error');
            return summarizeExecution([]);
        }
        const outcome = await this.executePlanCommands(this.pendingProblemPlan, {
            source: 'image_parse',
            label: 'image_parse',
        });
        if (!outcome.failedRecord) {
            this.pendingProblemPlan = null;
            this.problemParseStatus = '已根据确认后的题目解析完成绘图';
            this.saveSession();
            this.refresh();
        } else if (this.actions?.repairFailedCommand) {
            const repairOutcome = await this.actions.repairFailedCommand({
                message: this.problemReviewText || this.problemExtractedText || this.adjustMessage || '修复题目图片生成的 GeoGebra 命令',
                canvasSnapshot: geogebraCanvas.readCanvas(),
                failedCommand: outcome.failedRecord,
            });
            return summarizeExecution([...outcome.records, ...(repairOutcome?.records || [])]);
        }
        return outcome;
    }

    async replanProblemText() {
        const message = String(this.problemReviewText || '').trim();
        if (!message) {
            showToast('请先确认或修正题目文字', 'error');
            return summarizeExecution([]);
        }
        this.busy = true;
        this.latestError = '';
        this.problemParseStatus = '正在按修正文题重新生成绘图计划...';
        this.refresh();
        try {
            await geogebraCanvas.mount('geogebra-canvas-root');
            const canvasSnapshot = this.refreshCanvasState();
            const response = await fetch('/api/geogebra/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    canvas: canvasSnapshot,
                    selectedObjects: this.getSelectedObjects(canvasSnapshot.objects),
                    preferredPerspective: canvasSnapshot.perspective || 'G',
                }),
            });
            const payload = await response.json();
            if (!response.ok || !payload?.success) {
                throw new Error(payload?.error || 'GeoGebra 题目重算失败');
            }
            this.pendingProblemPlan = payload.data || null;
            this.latestSummary = payload.data?.summary || '已重新生成绘图计划';
            this.latestFollowUp = payload.data?.followUp || '';
            this.studioNotes = payload.data?.studioNotes || '';
            this.problemParseStatus = '已按修正文题重新生成计划，等待确认绘图';
            this.saveSession();
            return summarizeExecution([]);
        } catch (error) {
            this.latestError = error?.message || 'GeoGebra 题目重算失败';
            showToast(this.latestError, 'error');
            return summarizeExecution([]);
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    async runStudioAdjustment() {
        const message = String(this.adjustMessage || '').trim();
        if (!message) {
            showToast('请先描述要调整的内容', 'error');
            return summarizeExecution([]);
        }

        this.busy = true;
        this.latestError = '';
        this.refresh();
        try {
            await geogebraCanvas.mount('geogebra-canvas-root');
            const canvasSnapshot = this.refreshCanvasState();
            const response = await fetch('/api/geogebra/studio/adjust', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    canvas: canvasSnapshot,
                    selectedObjects: this.getSelectedObjects(canvasSnapshot.objects),
                    commandHistory: this.getCommandHistory(),
                    preferredPerspective: canvasSnapshot.perspective || 'G',
                }),
            });
            const payload = await response.json();
            if (!response.ok || !payload?.success) {
                throw new Error(payload?.error || 'GeoGebra Studio 调整失败');
            }

            const outcome = await this.executePlanCommands(payload.data || {}, {
                source: 'studio_adjust',
                label: 'studio_adjust',
            });

            if (outcome.failedRecord && this.actions?.repairFailedCommand) {
                const repairOutcome = await this.actions.repairFailedCommand({
                    message,
                    canvasSnapshot: geogebraCanvas.readCanvas(),
                    failedCommand: outcome.failedRecord,
                });
                return summarizeExecution([...outcome.records, ...(repairOutcome?.records || [])]);
            }
            return outcome;
        } catch (error) {
            this.latestError = error?.message || 'GeoGebra Studio 调整失败';
            showToast(this.latestError, 'error');
            throw error;
        } finally {
            this.busy = false;
            this.saveSession();
            this.refresh();
        }
    }

    formatChatReply(outcome = {}) {
        const visibleCommands = (outcome.commandHistory || this.getCommandHistory()).slice(-8);
        const commandLines = visibleCommands.length
            ? visibleCommands.map(record => `- \`${record.command}\`${record.success ? '' : `：${record.error || 'failed'}`}`).join('\n')
            : '- 暂无可显示命令';
        const followUp = outcome.followUp || this.latestFollowUp ? `\n\n${outcome.followUp || this.latestFollowUp}` : '';
        const repair = outcome.repairSummary || this.repairSummary ? `\n\n修复：${outcome.repairSummary || this.repairSummary}` : '';
        return `GeoGebra Studio 已更新。\n\n${outcome.summary || this.latestSummary || '命令已执行。'}${repair}${followUp}\n\n${commandLines}`;
    }
}

export const geogebraStudio = new GeoGebraStudio();
export { GEOGEBRA_STUDIO_SESSION_KEY, normalizeCommands, summarizeExecution };
