import { layoutToLegacyAisles } from '../classroom-layout.js';
import { normalizeLocalAisles } from '../seating-core.js';

class SeatingLayoutPreviewPanelMethods {
    normalizePreviewClassroomLayout(layout = {}) {
        const source = structuredClone(layout || {});
        const sourceCells = Array.isArray(source.cells) ? source.cells : [];
        const rows = Math.max(1, Number.parseInt(source.rows, 10) || sourceCells.length || 1);
        const cols = Math.max(
            1,
            Number.parseInt(source.cols, 10)
                || Math.max(1, ...sourceCells.map(row => Array.isArray(row) ? row.length : 0))
        );
        const cells = Array.from({ length: rows }, (_, r) => {
            const row = Array.isArray(sourceCells[r]) ? sourceCells[r] : [];
            return Array.from({ length: cols }, (_, c) => {
                const cell = row[c];
                if (cell === 'aisle' || cell === 'empty') return cell;
                return 'seat';
            });
        });
        const groups = Array.from({ length: rows }, (_, r) => {
            const row = Array.isArray(source.groups?.[r]) ? source.groups[r] : [];
            return Array.from({ length: cols }, (_, c) => row[c] ?? null);
        });
        return {
            ...source,
            rows,
            cols,
            cells,
            groups,
            localAisles: normalizeLocalAisles(source.localAisles, rows, cols),
            guardians: {
                enabled: Boolean(source.guardians?.enabled),
                left: source.guardians?.left ?? null,
                right: source.guardians?.right ?? null,
            },
        };
    }

    previewAssignmentGrid(layout) {
        return Array.from({ length: layout.rows }, () => Array(layout.cols).fill(null));
    }

    getConfirmedPreviewLayout() {
        return this.normalizePreviewClassroomLayout(
            this.pendingLayoutPreview?.classroomLayout || this.classroomLayout || {}
        );
    }

    capturePrimaryCanvasState() {
        return {
            rows: this.rows,
            cols: this.cols,
            layout: structuredClone(this.layout),
            classroomLayout: structuredClone(this.classroomLayout),
            guardians: [...this.guardians],
            rowAisles: [...this.rowAisles],
            colAisles: [...this.colAisles],
            unassigned: [...this.unassigned],
        };
    }

    setPrimaryPreviewMode(active) {
        document.querySelector('.sp-classroom-view')?.classList.toggle('sp-classroom-view--preview', active);
        document.querySelector('.sp-app')?.classList.toggle('sp-app--layout-preview', active);
    }

    applyLayoutPreviewToPrimaryCanvas(layout) {
        const normalized = this.normalizePreviewClassroomLayout(layout);
        this.rows = normalized.rows;
        this.cols = normalized.cols;
        this.classroomLayout = structuredClone(normalized);
        this.layout = this.previewAssignmentGrid(normalized);
        this.guardians = [null, null];
        this.unassigned = [];
        const aisles = layoutToLegacyAisles(this.classroomLayout);
        this.rowAisles = aisles.rowAisles;
        this.colAisles = aisles.colAisles;
        if (this.pendingLayoutPreview) {
            this.pendingLayoutPreview.classroomLayout = structuredClone(this.classroomLayout);
        }
        document.getElementById('sp-podium-row')?.classList.toggle('is-expanded', Boolean(normalized.guardians?.enabled));
        this.setPrimaryPreviewMode(true);
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
    }

    restorePrimaryCanvasState(state) {
        if (!state) return;
        this.rows = state.rows;
        this.cols = state.cols;
        this.layout = structuredClone(state.layout);
        this.classroomLayout = structuredClone(state.classroomLayout);
        this.guardians = [...state.guardians];
        this.rowAisles = [...state.rowAisles];
        this.colAisles = [...state.colAisles];
        this.unassigned = [...state.unassigned];
        document.getElementById('sp-podium-row')?.classList.toggle('is-expanded', Boolean(this.classroomLayout?.guardians?.enabled));
        this.setPrimaryPreviewMode(false);
        this.refreshConstraintStatus();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
    }

    primaryLayoutPreviewFacts(preview = this.pendingLayoutPreview) {
        const layout = this.normalizePreviewClassroomLayout(preview?.classroomLayout || {});
        const seats = layout.cells.flat().filter(cell => cell === 'seat').length;
        const groups = new Set(layout.groups.flat().filter(groupId => groupId !== null && groupId !== undefined)).size;
        const rows = layout.cells.filter(row => row.some(cell => cell === 'seat')).length;
        const guardianReserve = layout.guardians?.enabled ? Math.min(2, this.students.length) : 0;
        const emptySeats = Math.max(0, seats - Math.max(0, this.students.length - guardianReserve));
        const spec = preview?.arrangementSpec || {};
        return { layout, seats, groups, rows, emptySeats, spec };
    }

    renderPrimaryLayoutPreviewSummary() {
        if (!this.pendingLayoutPreview) return;
        const summary = document.getElementById('sp-layout-preview-summary');
        const meta = document.getElementById('sp-layout-preview-meta');
        const { seats, groups, rows, emptySeats, spec } = this.primaryLayoutPreviewFacts();
        const groupSize = Math.max(1, Number(spec.groupSize || this.classroomLayout?.groupSize) || 1);
        const ruleParts = [
            groupSize > 1 ? `${groupSize}人一组` : '单人座位',
            spec.groupGap === 'normal' ? '组间留距' : '组间不留距',
        ];
        if (spec.aislePolicy?.mainVertical) ruleParts.push('中央竖主过道');
        if (spec.aislePolicy?.mainHorizontal) ruleParts.push('中央横主过道');
        if (summary) summary.textContent = ruleParts.join(' · ');
        if (meta) {
            meta.textContent = `${rows} 排 · ${groups || seats} ${groups ? '组' : '列'} · ${seats} 座${emptySeats ? ` · ${emptySeats} 个空位` : ''} · 确认后安排学生`;
        }
    }

    finishLayoutPreview() {
        this.pendingLayoutPreview = null;
        document.getElementById('sp-layout-preview-confirm')?.classList.add('sp-hidden');
        this.setPrimaryPreviewMode(false);
    }

    showLayoutPreviewConfirmation(preview, prompt) {
        const previousState = this.pendingLayoutPreview?.previousState || this.capturePrimaryCanvasState();
        this.pendingLayoutPreview = {
            ...preview,
            prompt,
            classroomLayout: this.normalizePreviewClassroomLayout(preview.classroomLayout),
            previousState,
        };
        const panel = document.getElementById('sp-layout-preview-confirm');
        panel?.classList.remove('sp-hidden');
        this.applyLayoutPreviewToPrimaryCanvas(this.pendingLayoutPreview.classroomLayout);
        this.renderPrimaryLayoutPreviewSummary();
        if (window.lucide) window.lucide.createIcons();
    }

    cancelLayoutPreview() {
        const previousState = this.pendingLayoutPreview?.previousState;
        this.pendingLayoutPreview = null;
        document.getElementById('sp-layout-preview-confirm')?.classList.add('sp-hidden');
        if (previousState) this.restorePrimaryCanvasState(previousState);
        else this.setPrimaryPreviewMode(false);
    }

    async regenerateLayoutPreview() {
        const prompt = this.pendingLayoutPreview?.prompt || this.getArrangePrompt();
        this.cancelLayoutPreview();
        if (prompt) await this.generateSeating();
    }

    async confirmLayoutPreview() {
        if (!this.pendingLayoutPreview || this._isGenerating) return;
        const preview = this.pendingLayoutPreview;
        const confirmedLayout = this.getConfirmedPreviewLayout();
        this._isGenerating = true;
        const assignButton = document.getElementById('sp-layout-preview-assign');
        const originalHtml = assignButton?.innerHTML;
        if (assignButton) {
            assignButton.disabled = true;
            assignButton.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 排学生中...';
        }
        if (window.lucide) window.lucide.createIcons();
        try {
            const data = await this.requestAiArrangement(preview.prompt, {
                confirmedLayout,
                arrangementSpec: this.pendingLayoutPreview.arrangementSpec,
            });
            const arrangement = this.applyArrangementResult(data, { preserveLayoutPreview: true });
            this.finishLayoutPreview();
            this.showToast(arrangement.reply || '座位表生成完成', 'success');
            this.recordDiagnosticEvent('generate_seating_success', {
                source: arrangement.source || null,
                stats: arrangement.stats || null,
                warnings: arrangement.warnings || [],
            });
            this.showArrangementWarnings(arrangement.warnings);
        } catch (err) {
            console.error('[SeatingPlanner] Confirmed arrangement failed:', err);
            this.recordDiagnosticEvent('generate_seating_failed', {
                error: err.message || 'confirmed_arrangement_failed',
            });
            this.showToast('排学生失败: ' + err.message, 'error');
        } finally {
            this._isGenerating = false;
            if (assignButton) {
                assignButton.disabled = false;
                assignButton.innerHTML = originalHtml || '<i data-lucide="check"></i> 确认排学生';
            }
            if (window.lucide) window.lucide.createIcons();
        }
    }

    async generateSeating() {
        if (!this.students.length) return this.showToast('请先导入名单', 'warning');
        const prompt = this.getArrangePrompt();
        if (!prompt) return this.showToast('请先描述教室和排座需求', 'warning');
        if (this._isGenerating) return; // Loading guard
        this._isGenerating = true;
        this.recordDiagnosticEvent('generate_seating_started', {
            prompt,
            studentCount: this.students.length,
        });

        const btn = document.getElementById('sp-generate');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 生成布局中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const preview = await this.requestLayoutPreview(prompt);
            this.showLayoutPreviewConfirmation(preview, prompt);
            this.showToast(preview.reply || '布局预览已生成，请确认后排学生', 'success');
            this.recordDiagnosticEvent('layout_preview_ready', {
                source: preview.source || null,
                stats: preview.stats || null,
                warnings: preview.warnings || [],
            });
            this.showArrangementWarnings(preview.warnings);
        } catch (err) {
            console.error('[SeatingPlanner] Generation failed:', err);
            this.recordDiagnosticEvent('generate_seating_failed', {
                error: err.message || 'generation_failed',
            });
            this.showToast('布局生成失败: ' + err.message, 'error');
        } finally {
            this._isGenerating = false;
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles"></i> 生成座位表';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    showArrangementWarnings(warnings = []) {
        const actionableWarnings = warnings
            .filter(Boolean)
            .filter(warning => /未安排|不足|无法|不能|失败|错误|无效|越界|重复|过道|缺少|覆盖|不合法|不满足|容量|未知/.test(warning));
        if (actionableWarnings.length) {
            this.showToast(actionableWarnings.join('；'), 'warning');
        }
    }
}

export const seatingLayoutPreviewMethods = Object.fromEntries(
    Object.getOwnPropertyNames(SeatingLayoutPreviewPanelMethods.prototype)
        .filter(name => name !== 'constructor')
        .map(name => [name, SeatingLayoutPreviewPanelMethods.prototype[name]])
);
