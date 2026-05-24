import { escapeHtml, showToast } from '../utils/helpers.js';
import { geogebraCanvas } from './geogebra-canvas.js';

const GEOGEBRA_STATUS_FALLBACK = {
    assetsAvailable: false,
    aiAvailable: false,
    commandIndexReady: false,
    license: 'GeoGebra Non-Commercial License',
};

function normalizeCommands(commands) {
    return Array.isArray(commands)
        ? commands.map(command => String(command || '').trim()).filter(Boolean).slice(0, 24)
        : [];
}

function summarizeExecution(records = []) {
    const failedRecord = records.find(record => !record.success);
    return {
        records,
        failedRecord,
        success: Boolean(records.length) && !failedRecord,
    };
}

class GeoGebraWorkbench {
    constructor() {
        this.status = { ...GEOGEBRA_STATUS_FALLBACK };
        this.statusLoading = false;
        this.commandHistory = [];
        this.latestSummary = '';
        this.latestFollowUp = '';
        this.repairSummary = '';
        this.latestError = '';
        this.busy = false;
        this.canvasMounted = false;
    }

    looksLikeGeoGebraRequest(message = '') {
        const text = String(message || '').toLowerCase();
        return /(geogebra|ggb|动态几何|几何画板|拖动点|可拖动|拖动顶点|交互几何|外接圆|内切圆)/i.test(text);
    }

    async prepare() {
        await this.refreshStatus();
        await this.mountCanvas();
    }

    async refreshStatus() {
        if (this.statusLoading) return this.status;
        this.statusLoading = true;
        try {
            const response = await fetch('/api/geogebra/status');
            const statusPayload = await response.json();
            if (response.ok && statusPayload?.success && statusPayload?.data) {
                this.status = { ...GEOGEBRA_STATUS_FALLBACK, ...statusPayload.data };
            }
        } catch (error) {
            this.latestError = error?.message || 'GeoGebra status unavailable';
        } finally {
            this.statusLoading = false;
        }
        return this.status;
    }

    async mountCanvas() {
        await geogebraCanvas.mount('geogebra-canvas-root');
        this.canvasMounted = true;
    }

    resetSessionRuntime() {
        this.commandHistory = [];
        this.latestSummary = '';
        this.latestFollowUp = '';
        this.repairSummary = '';
        this.latestError = '';
    }

    render() {
        return `
            <section class="manim-workbench-section geogebra-workbench-panel">
                <div class="manim-workbench-section-head">
                    <strong>GeoGebra 动态几何</strong>
                    <span>本地离线 HTML5 画布，主输入框可直接生成命令</span>
                </div>
                <div class="geogebra-status-row">
                    ${this.renderStatusChip('离线资源', this.status.assetsAvailable)}
                    ${this.renderStatusChip('AI 规划', this.status.aiAvailable)}
                    ${this.renderStatusChip('命令索引', this.status.commandIndexReady)}
                </div>
                <div class="geogebra-canvas-shell">
                    <div id="geogebra-canvas-root" class="geogebra-canvas-root" role="application" aria-label="GeoGebra 动态几何画布"></div>
                </div>
                <div class="geogebra-action-row">
                    <button type="button" class="manim-workbench-secondary" data-geogebra-action="reset">
                        <i data-lucide="rotate-ccw"></i>
                        <span>重置</span>
                    </button>
                    <button type="button" class="manim-workbench-secondary" data-geogebra-action="refresh-status">
                        <i data-lucide="refresh-cw"></i>
                        <span>状态</span>
                    </button>
                    <button type="button" class="manim-workbench-secondary" data-geogebra-action="export">
                        <i data-lucide="image-down"></i>
                        <span>导出</span>
                    </button>
                </div>
            </section>
            <section class="manim-workbench-section geogebra-command-history">
                <div class="manim-workbench-section-head">
                    <strong>命令记录</strong>
                    <span>${this.busy ? '正在执行 GeoGebra 命令' : '失败时会自动请求修复'}</span>
                </div>
                ${this.renderCommandHistory()}
                ${this.latestSummary ? `<div class="geogebra-summary">${escapeHtml(this.latestSummary)}</div>` : ''}
                ${this.repairSummary ? `<div class="geogebra-repair-summary">${escapeHtml(this.repairSummary)}</div>` : ''}
                ${this.latestFollowUp ? `<div class="geogebra-follow-up">${escapeHtml(this.latestFollowUp)}</div>` : ''}
                ${this.latestError ? `<div class="geogebra-error">${escapeHtml(this.latestError)}</div>` : ''}
            </section>
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

    renderCommandHistory() {
        if (!this.commandHistory.length) {
            return '<div class="manim-workbench-empty compact">暂无命令。切到 GeoGebra 后，在主输入框描述你要构造的图形。</div>';
        }
        return `
            <div class="geogebra-command-list">
                ${this.commandHistory.slice(-20).map(record => `
                    <div class="geogebra-command-row ${record.success ? 'success' : 'error'}">
                        <code>${escapeHtml(record.command)}</code>
                        <span>${record.success ? escapeHtml(record.label || 'ok') : escapeHtml(record.error || 'failed')}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    bindPanelActions(root) {
        this.mountCanvas().catch(error => {
            this.latestError = error?.message || 'GeoGebra 画布加载失败';
            showToast(this.latestError, 'error');
            this.refreshVisiblePanel(root);
        });

        root?.querySelector('[data-geogebra-action="reset"]')?.addEventListener('click', () => {
            geogebraCanvas.reset();
            this.resetSessionRuntime();
            this.refreshVisiblePanel(root);
        });
        root?.querySelector('[data-geogebra-action="refresh-status"]')?.addEventListener('click', async () => {
            await this.refreshStatus();
            this.refreshVisiblePanel(root);
        });
        root?.querySelector('[data-geogebra-action="export"]')?.addEventListener('click', () => {
            const pngBase64 = geogebraCanvas.exportPngBase64();
            if (!pngBase64) {
                showToast('GeoGebra 当前画布暂时无法导出', 'error');
                return;
            }
            const anchor = document.createElement('a');
            anchor.href = `data:image/png;base64,${pngBase64}`;
            anchor.download = `geogebra-${Date.now()}.png`;
            anchor.click();
        });
    }

    refreshVisiblePanel(root) {
        const history = root?.querySelector('.geogebra-command-history');
        if (!history) return;
        history.outerHTML = `
            <section class="manim-workbench-section geogebra-command-history">
                <div class="manim-workbench-section-head">
                    <strong>命令记录</strong>
                    <span>${this.busy ? '正在执行 GeoGebra 命令' : '失败时会自动请求修复'}</span>
                </div>
                ${this.renderCommandHistory()}
                ${this.latestSummary ? `<div class="geogebra-summary">${escapeHtml(this.latestSummary)}</div>` : ''}
                ${this.repairSummary ? `<div class="geogebra-repair-summary">${escapeHtml(this.repairSummary)}</div>` : ''}
                ${this.latestFollowUp ? `<div class="geogebra-follow-up">${escapeHtml(this.latestFollowUp)}</div>` : ''}
                ${this.latestError ? `<div class="geogebra-error">${escapeHtml(this.latestError)}</div>` : ''}
            </section>
        `;
    }

    async runGeoGebraPlan(message) {
        this.busy = true;
        this.latestError = '';
        try {
            await this.prepare();

            const canvasSnapshot = geogebraCanvas.readCanvas();
            const selectedObjects = geogebraCanvas.readSelectedObjects();
            const response = await fetch('/api/geogebra/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    canvas: canvasSnapshot,
                    selectedObjects,
                    preferredPerspective: canvasSnapshot.perspective || 'G',
                }),
            });
            const planPayload = await response.json();
            if (!response.ok || !planPayload?.success) {
                throw new Error(planPayload?.error || 'GeoGebra 规划失败');
            }

            const planBody = planPayload.data || {};
            geogebraCanvas.setPerspective(planBody.perspective || 'G');
            this.latestSummary = planBody.summary || '已生成 GeoGebra 命令';
            this.latestFollowUp = planBody.followUp || '';
            this.repairSummary = '';

            const commandRecords = await geogebraCanvas.executeCommands(normalizeCommands(planBody.commands));
            this.commandHistory.push(...commandRecords);
            let executionSummary = summarizeExecution(commandRecords);

            if (executionSummary.failedRecord) {
                const repairRecords = await this.repairFailedCommand({
                    message,
                    canvasSnapshot: geogebraCanvas.readCanvas(),
                    failedCommand: executionSummary.failedRecord,
                });
                this.commandHistory.push(...repairRecords);
                executionSummary = summarizeExecution([...commandRecords, ...repairRecords]);
            }

            return {
                success: executionSummary.success,
                summary: this.latestSummary,
                followUp: this.latestFollowUp,
                repairSummary: this.repairSummary,
                commands: commandRecords,
                commandHistory: this.commandHistory.slice(-20),
            };
        } catch (error) {
            this.latestError = error?.message || 'GeoGebra 运行失败';
            throw error;
        } finally {
            this.busy = false;
        }
    }

    async repairFailedCommand({ message, canvasSnapshot, failedCommand }) {
        const response = await fetch('/api/geogebra/repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                canvas: canvasSnapshot,
                commandHistory: this.commandHistory.slice(-20),
                failedCommand,
            }),
        });
        const repairPayload = await response.json();
        if (!response.ok || !repairPayload?.success) {
            this.repairSummary = repairPayload?.error || 'GeoGebra 修复失败';
            return [];
        }

        const repairBody = repairPayload.data || {};
        this.repairSummary = repairBody.repairSummary || repairBody.summary || '已尝试修复失败命令';
        this.latestFollowUp = repairBody.followUp || this.latestFollowUp;
        geogebraCanvas.setPerspective(repairBody.perspective || canvasSnapshot.perspective || 'G');
        return geogebraCanvas.executeCommands(normalizeCommands(repairBody.commands));
    }

    formatChatReply(outcome = {}) {
        const visibleCommands = (outcome.commandHistory || []).slice(-8);
        const commandLines = visibleCommands.length
            ? visibleCommands.map(record => `- \`${record.command}\`${record.success ? '' : `：${record.error || 'failed'}`}`).join('\n')
            : '- 暂无可显示命令';
        const followUp = outcome.followUp ? `\n\n${outcome.followUp}` : '';
        const repair = outcome.repairSummary ? `\n\n修复：${outcome.repairSummary}` : '';
        return `GeoGebra 动态几何已更新。\n\n${outcome.summary || '命令已执行。'}${repair}${followUp}\n\n${commandLines}`;
    }
}

export const geogebraWorkbench = new GeoGebraWorkbench();
