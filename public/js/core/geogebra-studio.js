import { escapeHtml, showToast } from '../utils/helpers.js';
import { geogebraCanvas } from './geogebra-canvas.js';

const GEOGEBRA_STUDIO_SESSION_KEY = 'icecream_geogebra_studio_v1';
const GEOGEBRA_STUDIO_XML_LIMIT = 220000;
const GEOGEBRA_STUDIO_TABS = ['objects', 'adjust', 'commands', 'history'];

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
        this.adjustMessage = '';
        this.manualCommands = '';
        this.busy = false;
        this.canvasMounted = false;
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
            this.adjustMessage = String(session.adjustMessage || '');
            this.manualCommands = String(session.manualCommands || '');
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
                adjustMessage: this.adjustMessage,
                manualCommands: this.manualCommands,
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
                    <small>调整对象、执行命令、保留历史并继续用 AI 修改构图。</small>
                </div>
                <div class="geogebra-status-row">
                    ${this.renderStatusChip('离线资源', status.assetsAvailable)}
                    ${this.renderStatusChip('AI 调整', status.aiAvailable)}
                    ${this.renderStatusChip('命令索引', status.commandIndexReady)}
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

    renderStudioMessages() {
        return `
            <div class="geogebra-studio-messages">
                ${this.latestSummary ? `<div class="geogebra-summary">${escapeHtml(this.latestSummary)}</div>` : ''}
                ${this.studioNotes ? `<div class="geogebra-studio-note">${escapeHtml(this.studioNotes)}</div>` : ''}
                ${this.repairSummary ? `<div class="geogebra-repair-summary">${escapeHtml(this.repairSummary)}</div>` : ''}
                ${this.latestFollowUp ? `<div class="geogebra-follow-up">${escapeHtml(this.latestFollowUp)}</div>` : ''}
                ${this.latestError ? `<div class="geogebra-error">${escapeHtml(this.latestError)}</div>` : ''}
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

        this.root.querySelectorAll('[data-geogebra-studio-action]').forEach(button => {
            button.addEventListener('click', () => this.handleAction(button.dataset.geogebraStudioAction));
        });

        if (!options.skipMount && !this.canvasMounted) {
            this.mountCanvas();
        }
    }

    async mountCanvas(options = {}) {
        this.canvasLoadState = 'loading';
        this.canvasLoadError = '';
        this.latestError = '';
        this.refreshCanvasOverlay();
        try {
            if (options.forceRebuild) {
                await geogebraCanvas.rebuild('geogebra-canvas-root');
            } else {
                await geogebraCanvas.mount('geogebra-canvas-root');
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
        } else if (action === 'run-adjust') {
            await this.runStudioAdjustment();
        } else if (action === 'run-commands') {
            await this.executeManualCommands();
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
