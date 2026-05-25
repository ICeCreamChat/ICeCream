import { showToast } from '../utils/helpers.js';
import { geogebraCanvas } from './geogebra-canvas.js';
import { geogebraStudio, summarizeExecution } from './geogebra-studio.js';

const GEOGEBRA_STATUS_FALLBACK = {
    assetsAvailable: false,
    aiAvailable: false,
    commandIndexReady: false,
    license: 'GeoGebra Non-Commercial License',
};

class GeoGebraWorkbench {
    constructor() {
        this.status = { ...GEOGEBRA_STATUS_FALLBACK };
        this.statusLoading = false;
        this.busy = false;
    }

    looksLikeGeoGebraRequest(message = '') {
        const text = String(message || '').toLowerCase();
        return /(geogebra|ggb|动态几何|几何画板|拖动点|可拖动|拖动顶点|交互几何|外接圆|内切圆)/i.test(text);
    }

    async prepare() {
        await this.refreshStatus();
        await geogebraStudio.mountCanvas();
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
            geogebraStudio.latestError = error?.message || 'GeoGebra status unavailable';
        } finally {
            this.statusLoading = false;
        }
        geogebraStudio.refresh({ status: this.status, busy: this.busy });
        return this.status;
    }

    resetSessionRuntime() {
        geogebraStudio.resetSessionRuntime();
    }

    clearTransientProblemState() {
        geogebraStudio.clearTransientProblemState();
        geogebraStudio.saveSession();
    }

    render() {
        return geogebraStudio.render({
            status: this.status,
            busy: this.busy,
        });
    }

    bindPanelActions(root) {
        geogebraStudio.bind(root, {
            repairFailedCommand: (payload) => this.repairFailedCommand(payload),
        });
    }

    refreshVisiblePanel() {
        geogebraStudio.refresh({
            status: this.status,
            busy: this.busy,
        });
    }

    async runGeoGebraPlan(message) {
        this.busy = true;
        geogebraStudio.busy = true;
        geogebraStudio.latestError = '';
        this.refreshVisiblePanel();

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

            const planOutcome = await geogebraStudio.executePlanCommands(planPayload.data || {}, {
                source: 'plan',
                label: 'plan',
                resetBeforeExecute: true,
                requireVisibleObjects: true,
            });
            let records = planOutcome.records || [];

            if (planOutcome.failedRecord) {
                const repairOutcome = await this.repairFailedCommand({
                    message,
                    canvasSnapshot: geogebraCanvas.readCanvas(),
                    failedCommand: planOutcome.failedRecord,
                });
                records = [...records, ...(repairOutcome.records || [])];
            }

            const executionSummary = summarizeExecution(records);
            return {
                success: executionSummary.success,
                summary: geogebraStudio.latestSummary,
                followUp: geogebraStudio.latestFollowUp,
                repairSummary: geogebraStudio.repairSummary,
                commands: records,
                commandHistory: geogebraStudio.getCommandHistory(),
            };
        } catch (error) {
            geogebraStudio.latestError = error?.message || 'GeoGebra 运行失败';
            throw error;
        } finally {
            this.busy = false;
            geogebraStudio.busy = false;
            this.refreshVisiblePanel();
        }
    }

    async repairFailedCommand({ message, canvasSnapshot, failedCommand }) {
        const response = await fetch('/api/geogebra/repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                canvas: canvasSnapshot,
                commandHistory: geogebraStudio.getCommandHistory(),
                failedCommand,
            }),
        });
        const repairPayload = await response.json();
        if (!response.ok || !repairPayload?.success) {
            geogebraStudio.repairSummary = repairPayload?.error || 'GeoGebra 修复失败';
            geogebraStudio.refresh({ status: this.status, busy: this.busy });
            return { records: [] };
        }

        const repairBody = repairPayload.data || {};
        geogebraStudio.repairSummary = repairBody.repairSummary || repairBody.summary || '已尝试修复失败命令';
        geogebraStudio.latestFollowUp = repairBody.followUp || geogebraStudio.latestFollowUp;
        const repairOutcome = await geogebraStudio.executePlanCommands(repairBody, {
            source: 'repair',
            label: 'repair',
            preserveSummary: true,
            preserveRepairSummary: true,
        });
        return {
            ...repairOutcome,
            repairSummary: geogebraStudio.repairSummary,
        };
    }

    formatChatReply(outcome = {}) {
        return geogebraStudio.formatChatReply(outcome);
    }
}

export const geogebraWorkbench = new GeoGebraWorkbench();
