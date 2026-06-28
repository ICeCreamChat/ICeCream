import { layoutToLegacyAisles } from '../classroom-layout.js';
import {
    deleteAisleColumn,
    deleteAisleRow,
    deleteLocalAisle,
    hasLocalAisle,
    insertAisleColumn,
    insertAisleRow,
    insertLocalAisle,
    normalizeLocalAisles,
} from '../seating-core.js';

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

    gridTemplateForPreview(cols) {
        return Array.from({ length: cols * 2 - 1 }, (_, index) => (
            index % 2 === 0 ? 'var(--sp-preview-cell)' : 'var(--sp-preview-gap)'
        )).join(' ');
    }

    measureLayoutPreview(layout, target) {
        const cols = Math.max(1, Number(layout?.cols) || 1);
        const rows = Math.max(1, Number(layout?.rows) || 1);
        const bounds = target?.getBoundingClientRect?.();
        const panelBounds = target?.closest?.('.sp-layout-preview')?.getBoundingClientRect?.();
        const measuredWidth = Math.floor(
            target?.clientWidth
            || bounds?.width
            || panelBounds?.width
            || 288
        );
        const availableWidth = Math.max(120, measuredWidth - 16);
        const gapCount = Math.max(0, cols - 1);
        const totalCells = rows * cols;
        const previewCellTarget = totalCells > 220 || cols >= 16
            ? 16
            : totalCells > 160 || cols >= 13
                ? 18
                : cols >= 11
                    ? 22
                    : 26;
        const minCell = 16;
        const maxCell = 28;
        const fillCell = Math.floor((availableWidth - gapCount * 4) / cols);
        const cellSize = Math.max(minCell, Math.min(maxCell, Math.max(previewCellTarget, fillCell)));
        const gapSize = gapCount > 0 ? Math.max(3, Math.min(5, Math.round(cellSize * 0.18))) : 0;
        const canvasWidth = cols * cellSize + gapCount * gapSize;

        const density = totalCells > 220 || cellSize <= 16
            ? 'micro'
            : totalCells > 160 || cellSize <= 18
                ? 'compact'
                : 'normal';

        return { cellSize, gapSize, canvasWidth, density };
    }

    applyPreviewClassroomLayout(layout) {
        if (!this.pendingLayoutPreview) return;
        this.pendingLayoutPreview = {
            ...this.pendingLayoutPreview,
            classroomLayout: this.normalizePreviewClassroomLayout(layout),
        };
        this.renderEditableLayoutPreviewGrid();
    }

    getConfirmedPreviewLayout() {
        return this.normalizePreviewClassroomLayout(this.pendingLayoutPreview?.classroomLayout || {});
    }

    renderPreviewLocalGap({ orientation, row, col, layout, localAisles, readOnly = false }) {
        const active = hasLocalAisle(localAisles, orientation, row, col);
        const groupId = this.previewGapGroupId(layout, orientation, row, col, localAisles);
        const canEdit = !readOnly && (active || this.isSeatPairForLocalAisle(layout, orientation, row, col));
        const allowed = active || canEdit || groupId !== null;
        if (!allowed || (readOnly && !active)) {
            const spacer = document.createElement('span');
            spacer.className = `sp-layout-preview-local-gap sp-layout-preview-local-gap--${orientation} sp-layout-preview-local-gap--disabled`;
            if (groupId !== null) {
                spacer.classList.add(
                    'sp-layout-preview-local-gap--group-link',
                    Number(groupId) % 2 === 0
                        ? 'sp-layout-preview-local-gap--group-even'
                        : 'sp-layout-preview-local-gap--group-odd',
                );
                spacer.dataset.groupLink = String(groupId);
            }
            return spacer;
        }
        const control = document.createElement(canEdit ? 'button' : 'span');
        if (canEdit) control.type = 'button';
        control.className = `sp-layout-preview-local-gap sp-layout-preview-local-gap--${orientation}`;
        if (active) control.classList.add('is-active');
        if (groupId !== null) {
            control.classList.add(
                'sp-layout-preview-local-gap--group-link',
                Number(groupId) % 2 === 0
                    ? 'sp-layout-preview-local-gap--group-even'
                    : 'sp-layout-preview-local-gap--group-odd',
            );
            control.dataset.groupLink = String(groupId);
        }
        if (canEdit) {
            control.dataset.previewAction = 'toggle-local';
            control.dataset.orientation = orientation;
            control.dataset.row = String(row);
            control.dataset.col = String(col);
            control.title = active ? '删除局部过道' : '添加局部过道';
            control.setAttribute('aria-label', active ? '删除局部过道' : '添加局部过道');
        }
        return control;
    }

    renderLayoutPreviewStudent() {
        const student = document.createElement('span');
        student.className = 'sp-layout-preview-student';

        const head = document.createElement('span');
        head.className = 'sp-layout-preview-student-head';
        student.appendChild(head);

        const body = document.createElement('span');
        body.className = 'sp-layout-preview-student-body';
        student.appendChild(body);

        const desk = document.createElement('span');
        desk.className = 'sp-layout-preview-student-desk';
        student.appendChild(desk);

        const badge = document.createElement('span');
        badge.className = 'sp-layout-preview-student-badge';
        student.appendChild(badge);

        return student;
    }

    renderLayoutPreviewGuardianSeat(side) {
        const seat = document.createElement('span');
        const sideClass = side === 'left'
            ? 'sp-layout-preview-guardian-seat--left'
            : 'sp-layout-preview-guardian-seat--right';
        seat.className = 'sp-layout-preview-guardian-seat ' + sideClass;
        seat.setAttribute('aria-hidden', 'true');
        seat.appendChild(this.renderLayoutPreviewStudent());
        return seat;
    }

    previewCellHasSameGroup(layout, groupId, row, col) {
        if (groupId === null || groupId === undefined) return false;
        return layout.cells?.[row]?.[col] === 'seat'
            && String(layout.groups?.[row]?.[col]) === String(groupId);
    }

    previewGapGroupId(layout, orientation, row, col, localAisles) {
        if (hasLocalAisle(localAisles, orientation, row, col)) return null;
        const first = { row, col };
        const second = orientation === 'vertical'
            ? { row, col: col + 1 }
            : { row: row + 1, col };
        if (layout.cells?.[first.row]?.[first.col] !== 'seat') return null;
        if (layout.cells?.[second.row]?.[second.col] !== 'seat') return null;
        const groupId = layout.groups?.[first.row]?.[first.col];
        if (groupId === null || groupId === undefined) return null;
        return this.previewCellHasSameGroup(layout, groupId, second.row, second.col)
            ? groupId
            : null;
    }

    renderEditableLayoutPreviewGrid(preview = this.pendingLayoutPreview) {
        const target = document.getElementById('sp-layout-preview-mini');
        if (!target || !preview?.classroomLayout) return;
        const layout = this.normalizePreviewClassroomLayout(preview.classroomLayout);
        this.pendingLayoutPreview.classroomLayout = layout;
        const { rowAisles, colAisles } = layoutToLegacyAisles(layout);
        const localAisles = normalizeLocalAisles(layout.localAisles, layout.rows, layout.cols);
        const template = this.gridTemplateForPreview(layout.cols);
        const measurement = this.measureLayoutPreview(layout, target);
        const readOnly = Boolean(preview.readOnly || preview.confirmed);

        target.innerHTML = '';
        target.style.setProperty('--sp-preview-cell', `${measurement.cellSize}px`);
        target.style.setProperty('--sp-preview-gap', `${measurement.gapSize}px`);
        target.style.setProperty('--sp-preview-canvas-width', `${measurement.canvasWidth}px`);
        target.classList.remove('sp-layout-preview-mini--normal', 'sp-layout-preview-mini--compact', 'sp-layout-preview-mini--micro');
        target.classList.add(`sp-layout-preview-mini--${measurement.density}`);
        target.classList.toggle('sp-layout-preview-mini--dense', measurement.density !== 'normal');
        target.classList.toggle('sp-layout-preview-mini--readonly', readOnly);

        const stage = document.createElement('div');
        stage.className = 'sp-layout-preview-stage';

        if (layout.guardians?.enabled) {
            const podiumBand = document.createElement('div');
            podiumBand.className = 'sp-layout-preview-podium-band';
            podiumBand.appendChild(this.renderLayoutPreviewGuardianSeat('left'));
            const podium = document.createElement('span');
            podium.className = 'sp-layout-preview-podium';
            podium.textContent = '讲台';
            podiumBand.appendChild(podium);
            podiumBand.appendChild(this.renderLayoutPreviewGuardianSeat('right'));
            stage.appendChild(podiumBand);
        }

        const matrix = document.createElement('div');
        matrix.className = 'sp-layout-preview-matrix';
        matrix.style.setProperty('--sp-preview-template', template);

        for (let r = 0; r < layout.rows; r++) {
            const row = document.createElement('div');
            row.className = 'sp-layout-preview-row';
            row.style.gridTemplateColumns = template;
            const isRowAisle = rowAisles.includes(r);

            for (let c = 0; c < layout.cols; c++) {
                const isColAisle = colAisles.includes(c);
                const removable = isRowAisle || isColAisle;
                const cell = document.createElement(removable && !readOnly ? 'button' : 'span');
                const cellType = layout.cells[r]?.[c] === 'seat' ? 'seat' : layout.cells[r]?.[c] === 'aisle' ? 'aisle' : 'empty';
                cell.className = `sp-layout-preview-cell sp-layout-preview-cell--${cellType}`;
                if (cellType === 'seat') {
                    const groupId = layout.groups?.[r]?.[c];
                    if (groupId !== null && groupId !== undefined) {
                        cell.dataset.group = String(groupId);
                        cell.classList.add(Number(groupId) % 2 === 0
                            ? 'sp-layout-preview-cell--group-even'
                            : 'sp-layout-preview-cell--group-odd');
                    }
                    cell.appendChild(this.renderLayoutPreviewStudent());
                }
                if (removable && !readOnly) {
                    cell.type = 'button';
                    cell.classList.add('sp-layout-preview-cell--removable');
                    cell.dataset.previewAction = isRowAisle ? 'delete-row' : 'delete-col';
                    cell.dataset.row = String(r);
                    cell.dataset.col = String(c);
                    cell.title = isRowAisle ? '删除整行过道' : '删除整列过道';
                    cell.setAttribute('aria-label', isRowAisle ? '删除整行过道' : '删除整列过道');
                }
                row.appendChild(cell);
                if (c < layout.cols - 1) {
                    row.appendChild(this.renderPreviewLocalGap({
                        orientation: 'vertical',
                        row: r,
                        col: c,
                        layout,
                        localAisles,
                        readOnly,
                    }));
                }
            }
            matrix.appendChild(row);

            if (r < layout.rows - 1) {
                const gapRow = document.createElement('div');
                gapRow.className = 'sp-layout-preview-row-gap';
                gapRow.style.gridTemplateColumns = template;
                const canInsertRow = !rowAisles.includes(r) && !rowAisles.includes(r + 1);
                if (canInsertRow && !readOnly) {
                    const fullRow = document.createElement('button');
                    fullRow.type = 'button';
                    fullRow.className = 'sp-layout-preview-full-row-handle';
                    fullRow.dataset.previewAction = 'insert-row';
                    fullRow.dataset.row = String(r + 1);
                    fullRow.title = '插入整行过道';
                    fullRow.setAttribute('aria-label', '插入整行过道');
                    gapRow.appendChild(fullRow);
                }
                for (let c = 0; c < layout.cols; c++) {
                    gapRow.appendChild(this.renderPreviewLocalGap({
                        orientation: 'horizontal',
                        row: r,
                        col: c,
                        layout,
                        localAisles,
                        readOnly,
                    }));
                    if (c < layout.cols - 1) {
                        const spacer = document.createElement('span');
                        spacer.className = 'sp-layout-preview-gap-corner';
                        gapRow.appendChild(spacer);
                    }
                }
                matrix.appendChild(gapRow);
            }
        }

        stage.appendChild(matrix);
        target.appendChild(stage);
    }

    insertPreviewAisleRowAt(index) {
        const layout = this.getConfirmedPreviewLayout();
        const result = insertAisleRow({
            layout: this.previewAssignmentGrid(layout),
            classroomLayout: layout,
            index,
        });
        this.applyPreviewClassroomLayout(result.classroomLayout);
    }

    insertPreviewAisleColumnAt(index) {
        const layout = this.getConfirmedPreviewLayout();
        const result = insertAisleColumn({
            layout: this.previewAssignmentGrid(layout),
            classroomLayout: layout,
            index,
        });
        this.applyPreviewClassroomLayout(result.classroomLayout);
    }

    deletePreviewAisleRowAt(index) {
        const layout = this.getConfirmedPreviewLayout();
        const result = deleteAisleRow({
            layout: this.previewAssignmentGrid(layout),
            classroomLayout: layout,
            index,
        });
        this.applyPreviewClassroomLayout(result.classroomLayout);
    }

    deletePreviewAisleColumnAt(index) {
        const layout = this.getConfirmedPreviewLayout();
        const result = deleteAisleColumn({
            layout: this.previewAssignmentGrid(layout),
            classroomLayout: layout,
            index,
        });
        this.applyPreviewClassroomLayout(result.classroomLayout);
    }

    togglePreviewLocalAisle(orientation, row, col) {
        const layout = this.getConfirmedPreviewLayout();
        const localAisles = normalizeLocalAisles(layout.localAisles, layout.rows, layout.cols);
        const active = hasLocalAisle(localAisles, orientation, row, col);
        if (!active && !this.isSeatPairForLocalAisle(layout, orientation, row, col)) {
            this.showToast('局部过道只能添加在相邻座位之间', 'warning');
            return;
        }
        const next = active
            ? deleteLocalAisle({ classroomLayout: layout, orientation, row, col })
            : insertLocalAisle({ classroomLayout: layout, orientation, row, col });
        this.applyPreviewClassroomLayout(next);
    }

    handleLayoutPreviewEditClick(event) {
        const control = event.target.closest?.('[data-preview-action]');
        const target = document.getElementById('sp-layout-preview-mini');
        if (!control || !target?.contains(control) || !this.pendingLayoutPreview) return;
        if (this.pendingLayoutPreview.readOnly || this.pendingLayoutPreview.confirmed) return;
        event.preventDefault();
        event.stopPropagation();

        const action = control.dataset.previewAction;
        const row = Number.parseInt(control.dataset.row, 10);
        const col = Number.parseInt(control.dataset.col, 10);
        const orientation = control.dataset.orientation;
        try {
            if (action === 'insert-row') this.insertPreviewAisleRowAt(row);
            if (action === 'insert-col') this.insertPreviewAisleColumnAt(col);
            if (action === 'delete-row') this.deletePreviewAisleRowAt(row);
            if (action === 'delete-col') this.deletePreviewAisleColumnAt(col);
            if (action === 'toggle-local') this.togglePreviewLocalAisle(orientation, row, col);
        } catch (error) {
            this.showToast(error.message || '无法编辑布局预览', 'warning');
        }
    }

    showLayoutPreviewConfirmation(preview, prompt) {
        this.pendingLayoutPreview = {
            ...preview,
            prompt,
            classroomLayout: this.normalizePreviewClassroomLayout(preview.classroomLayout),
            readOnly: false,
            confirmed: false,
        };
        const panel = document.getElementById('sp-layout-preview-confirm');
        panel?.classList.remove('sp-hidden');
        this.renderEditableLayoutPreviewGrid();
        if (window.lucide) window.lucide.createIcons();
    }

    showConfirmedLayoutPreview(preview = {}) {
        if (!preview.classroomLayout) return;
        this.pendingLayoutPreview = {
            ...preview,
            classroomLayout: this.normalizePreviewClassroomLayout(preview.classroomLayout),
            readOnly: true,
            confirmed: true,
            source: preview.source || 'confirmed_layout',
        };
        const panel = document.getElementById('sp-layout-preview-confirm');
        panel?.classList.remove('sp-hidden');
        this.renderEditableLayoutPreviewGrid();
        if (window.lucide) window.lucide.createIcons();
    }

    cancelLayoutPreview() {
        this.pendingLayoutPreview = null;
        document.getElementById('sp-layout-preview-confirm')?.classList.add('sp-hidden');
        const mini = document.getElementById('sp-layout-preview-mini');
        if (mini) mini.innerHTML = '';
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
        const confirmedPreview = {
            ...preview,
            classroomLayout: structuredClone(confirmedLayout),
        };
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
            this.showConfirmedLayoutPreview(confirmedPreview);
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
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> AI 设计布局中...';
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
            this.showToast('AI 生成失败: ' + err.message, 'error');
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
