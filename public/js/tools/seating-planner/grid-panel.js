import { isLayoutSeat } from '../classroom-layout.js';
import {
    colHasStudents,
    deleteAisleColumn,
    deleteAisleRow,
    deleteLocalAisle,
    hasLocalAisle,
    insertAisleColumn,
    insertAisleRow,
    insertLocalAisle,
    normalizeLocalAisles,
    rowHasStudents,
} from '../seating-core.js';

class SeatingGridPanelMethods {
bindPodiumEvents() {
        const left = document.getElementById('sp-guardian-left');
        const right = document.getElementById('sp-guardian-right');
        [left, right].forEach((seat, index) => {
            if (!seat) return;
            // Drag Start
            seat.addEventListener('dragstart', e => this.handleDragStart(e, -1, index));
            seat.addEventListener('dragend', e => this.handleDragEnd(e));
            // Drop Target
            seat.addEventListener('dragover', e => this.handleDragOver(e));
            seat.addEventListener('dragenter', e => this.handleDragEnter(e, seat));
            seat.addEventListener('dragleave', e => this.handleDragLeave(e, seat));
            seat.addEventListener('drop', e => this.handleDrop(e, -1, index)); // Row -1
            // Context Menu (optional, maybe just clear)
            seat.addEventListener('contextmenu', e => {
                e.preventDefault();
                if (this.guardians[index]) {
                    this.saveSnapshot();
                    this.guardians[index] = null;
                    this.renderPodiumSeats();
                    this.showToast('护法座位已清空', 'success');
                }
            });
        });
    }

renderPodiumSeats() {
        const left = document.getElementById('sp-guardian-left');
        const right = document.getElementById('sp-guardian-right');
        [left, right].forEach((seat, index) => {
            if (!seat) return;
            const studentId = this.guardians[index];
            // Clear current content (keep the desk div if we want, but easiest is rebuild)
            seat.innerHTML = '';
            // Reset classes
            seat.className = 'sp-seat sp-seat--guardian';
            delete seat.dataset.studentId;
            this.unbindSeatDetailPopover(seat);
            if (studentId) {
                const student = this.studentMap.get(studentId);
                if (student) {
                    seat.classList.add('sp-seat--filled');
                    seat.dataset.studentId = student.id;
                    seat.setAttribute('draggable', 'true'); // Make draggable

                    // === The Desk ===
                    const desk = document.createElement('div');
                    desk.className = 'sp-desk';
                    // Name Tag
                    const nameTag = document.createElement('span');
                    nameTag.className = 'sp-name-tag';
                    nameTag.textContent = student.name;
                    desk.appendChild(nameTag);
                    const meta = this.renderSeatMeta(student);
                    if (meta) desk.appendChild(meta);
                    desk.appendChild(this.renderDeskItems(student));
                    seat.appendChild(desk);
                    // === The Chair Back ===
                    const chair = document.createElement('div');
                    chair.className = `sp-chair sp-chair--${student.gender === 'M' ? 'male' : 'female'}`;
                    seat.appendChild(chair);

                    this.bindSeatDetailPopover(seat, student.id);

                } else {
                    // Invalid ID? Treat as empty
                    this.guardians[index] = null;
                    seat.classList.add('sp-seat--empty');
                    const desk = document.createElement('div');
                    desk.className = 'sp-desk';
                    seat.appendChild(desk);
                    seat.removeAttribute('draggable');
                }
            } else {
                seat.classList.add('sp-seat--empty');
                const desk = document.createElement('div');
                desk.className = 'sp-desk';
                seat.appendChild(desk);
                seat.removeAttribute('draggable');
            }
        });
    }

handleDragStart(e, row, col) {
        this._justDragged = true;
        if (this._dragResetTimer) {
            clearTimeout(this._dragResetTimer);
            this._dragResetTimer = null;
        }
        this.hideSeatDetailPopover();
        this.dragSource = { row, col };
        e.target.classList.add('sp-seat--dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Use timeout to allow drag image to be generated before hiding element
        setTimeout(() => e.target.style.opacity = '0.4', 0);
    }

handleDragEnd(e) {
        e.target.classList.remove('sp-seat--dragging');
        e.target.style.opacity = '1';
        this.dragSource = null;
        document.querySelectorAll('.sp-seat--drag-over').forEach(c => c.classList.remove('sp-seat--drag-over'));
        if (this._dragResetTimer) clearTimeout(this._dragResetTimer);
        this._dragResetTimer = setTimeout(() => {
            this._justDragged = false;
            this._dragResetTimer = null;
        }, 180);
    }

handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }

handleDragEnter(e, cell) {
        e.preventDefault(); if (!cell.classList.contains('sp-seat--dragging')) cell.classList.add('sp-seat--drag-over');
    }

handleDragLeave(e, cell) { cell.classList.remove('sp-seat--drag-over'); }

handleDrop(e, targetRow, targetCol) {
        e.preventDefault();
        e.currentTarget.classList.remove('sp-seat--drag-over');
        if (!this.dragSource) return;
        const { row: sr, col: sc } = this.dragSource;
        if (sr === targetRow && sc === targetCol) return;
        this.swapSeats(sr, sc, targetRow, targetCol);
    }

swapSeats(r1, c1, r2, c2) {
        const val1 = this.getSeat(r1, c1);
        const val2 = this.getSeat(r2, c2);

        this.setSeat(r1, c1, val2);
        this.setSeat(r2, c2, val1);
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        const s1 = this.studentMap.get(val1);
        const s2 = this.studentMap.get(val2);
        this.recordDiagnosticEvent('seat_swap', {
            from: { row: r1, col: c1, studentId: val1 || null },
            to: { row: r2, col: c2, studentId: val2 || null },
            guardian: r1 === -1 || r2 === -1,
        });
        if (r1 === -1 || r2 === -1) {
            this.showToast(`护法位已更新`, 'success');
        } else {
            this.showToast(`已交换: ${s2?.name || '空位'} ↔ ${s1?.name || '空位'}`, 'success');
        }
    }

layoutTemplateLabel(template) {
        return {
            standard: '普通',
            pairs: '双人同桌',
            triples: '三人一组',
            single: '单人考试',
            'center-aisle': '中间过道',
            'horizontal-aisle': '横过道',
            islands: '小组岛',
            custom: '自定义',
            ai: 'AI 布局'
        }[template] || '自定义';
    }

createVirtualSeatCell(r, c, localAisles = this.getCurrentLocalAisles()) {
        const cell = document.createElement('div');
        cell.className = 'sp-seat';
        cell.dataset.row = r;
        cell.dataset.col = c;

        const isColAisle = this.colAisles.includes(c);
        const isRowAisle = this.rowAisles.includes(r);
        const isLayoutBlocked = !isLayoutSeat(this.classroomLayout, r, c);
        if (isColAisle || isRowAisle || isLayoutBlocked) {
            cell.classList.add('sp-seat--aisle');
            const line = document.createElement('span');
            line.className = `sp-aisle-line ${isRowAisle ? 'sp-aisle-line--horizontal' : 'sp-aisle-line--vertical'}`;
            cell.appendChild(line);
            cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
            return cell;
        }

        const studentId = this.layout[r]?.[c];
        const desk = document.createElement('div');
        desk.className = 'sp-desk';
        if (studentId && studentId !== '_aisle_') {
            const student = this.studentMap.get(studentId);
            cell.classList.add('sp-seat--filled');
            cell.dataset.studentId = studentId;
            const nameTag = document.createElement('span');
            nameTag.className = 'sp-name-tag';
            nameTag.textContent = student?.name || studentId;
            desk.appendChild(nameTag);
            const meta = this.renderSeatMeta(student);
            if (meta) desk.appendChild(meta);
            desk.appendChild(this.renderDeskItems(student));
            const chair = document.createElement('div');
            chair.className = `sp-chair sp-chair--${student?.gender === 'M' ? 'male' : 'female'}`;
            cell.appendChild(desk);
            cell.appendChild(chair);
            cell.setAttribute('draggable', 'true');
            cell.addEventListener('dragstart', e => this.handleDragStart(e, r, c));
            cell.addEventListener('dragend', e => this.handleDragEnd(e));
            if (student) this.bindSeatDetailPopover(cell, studentId);
        } else {
            cell.classList.add('sp-seat--empty');
            cell.appendChild(desk);
        }
        cell.addEventListener('dragover', e => this.handleDragOver(e));
        cell.addEventListener('dragenter', e => this.handleDragEnter(e, cell));
        cell.addEventListener('dragleave', e => this.handleDragLeave(e, cell));
        cell.addEventListener('drop', e => this.handleDrop(e, r, c));
        cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
        this.appendLocalAisleMarkers(cell, r, c, localAisles);
        return cell;
    }

renderVirtualGrid() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;
        const scroller = grid.closest('.sp-classroom-view');
        const rowHeight = this.constructor.VIRTUAL_GRID_ROW_HEIGHT;
        const fitScale = Number.parseFloat(grid.style.getPropertyValue('--sp-grid-fit-scale')) || 1;
        const visibleRowHeight = Math.max(1, rowHeight * fitScale);
        const overscan = this.constructor.VIRTUAL_GRID_ROW_OVERSCAN;
        const viewportHeight = scroller?.clientHeight || 720;
        const scrollTop = Math.max(0, (scroller?.scrollTop || 0) - (grid.offsetTop || 0));
        const startRow = Math.max(0, Math.floor(scrollTop / visibleRowHeight) - overscan);
        const visibleRows = Math.ceil(viewportHeight / visibleRowHeight) + overscan * 2;
        const endRow = Math.min(this.rows, startRow + visibleRows);
        const localAisles = this.getCurrentLocalAisles();

        this._virtualGridActive = true;
        grid.classList.add('sp-grid--virtual');
        grid.innerHTML = '';
        grid.style.gridTemplateColumns = '';
        grid.style.height = `${Math.max(this.rows * rowHeight, rowHeight)}px`;

        const windowEl = document.createElement('div');
        windowEl.className = 'sp-grid-window';
        windowEl.style.gridTemplateColumns = `repeat(${this.cols}, minmax(90px, 1fr))`;
        windowEl.style.transform = `translateY(${startRow * rowHeight}px)`;
        for (let r = startRow; r < endRow; r++) {
            for (let c = 0; c < this.cols; c++) {
                windowEl.appendChild(this.createVirtualSeatCell(r, c, localAisles));
            }
        }
        grid.appendChild(windowEl);

        if (scroller && this._virtualGridScrollTarget !== scroller) {
            if (this._virtualGridScrollTarget && this._virtualGridScrollHandler) {
                this._virtualGridScrollTarget.removeEventListener('scroll', this._virtualGridScrollHandler);
            }
            this._virtualGridScrollTarget = scroller;
            this._virtualGridScrollHandler = () => {
                if (this._virtualGridActive) window.requestAnimationFrame(() => this.renderVirtualGrid());
            };
            scroller.addEventListener('scroll', this._virtualGridScrollHandler);
        }
        requestAnimationFrame(() => {
            this.fitGridToClassroomView();
            this.syncPodiumSeatWidth();
            this.renderAisleGapHandles();
        });
    }

renderGrid() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        const totalCells = this.rows * this.cols;
        if (totalCells > this.constructor.VIRTUAL_GRID_CELL_THRESHOLD) {
            return this.renderVirtualGrid();
        }

        this._virtualGridActive = false;
        grid.classList.remove('sp-grid--virtual');
        grid.style.height = '';
        grid.innerHTML = '';
        grid.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;
        const localAisles = this.getCurrentLocalAisles();
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = document.createElement('div');
                cell.className = 'sp-seat';
                cell.dataset.row = r;
                cell.dataset.col = c;

                const isColAisle = this.colAisles.includes(c);
                const isRowAisle = this.rowAisles.includes(r);
                const isLayoutBlocked = !isLayoutSeat(this.classroomLayout, r, c);

                if (isColAisle || isRowAisle || isLayoutBlocked) {
                    cell.classList.add('sp-seat--aisle');
                    const line = document.createElement('span');
                    line.className = `sp-aisle-line ${isRowAisle ? 'sp-aisle-line--horizontal' : 'sp-aisle-line--vertical'}`;
                    cell.appendChild(line);
                    cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
                    grid.appendChild(cell);
                    continue;
                }

                const studentId = this.layout[r]?.[c];
                if (studentId && studentId !== '_aisle_') {
                    const student = this.studentMap.get(studentId);
                    if (student) {
                        cell.classList.add('sp-seat--filled');
                        cell.dataset.studentId = student.id;

                        // === The Desk ===
                        const desk = document.createElement('div');
                        desk.className = 'sp-desk';

                        // Name Tag (姓名贴) - show only the name, strip gender/grade suffix
                        const nameTag = document.createElement('span');
                        nameTag.className = 'sp-name-tag';
                        // API may return name as "张三 男 84", extract only the name part
                        let displayName = student.name;
                        if (student.gender || student.grade) {
                            displayName = displayName.replace(/\s+[男女]\s*\d*\s*$/, '').trim();
                        }
                        nameTag.textContent = displayName || student.name;
                        desk.appendChild(nameTag);
                        const meta = this.renderSeatMeta(student);
                        if (meta) desk.appendChild(meta);

                        desk.appendChild(this.renderDeskItems(student));
                        cell.appendChild(desk);

                        // === The Chair Back ===
                        const chair = document.createElement('div');
                        chair.className = `sp-chair sp-chair--${student.gender === 'M' ? 'male' : 'female'}`;
                        cell.appendChild(chair);

                        // Hover interaction
                        cell.addEventListener('mouseenter', () => this.highlightRelationships(student.id));
                        cell.addEventListener('mouseleave', () => this.clearHighlights());

                        // Drag events
                        cell.setAttribute('draggable', 'true');
                        cell.addEventListener('dragstart', e => this.handleDragStart(e, r, c));
                        cell.addEventListener('dragend', e => this.handleDragEnd(e));
                        this.bindSeatDetailPopover(cell, student.id);
                    }
                } else {
                    cell.classList.add('sp-seat--empty');
                    // Empty desk placeholder
                    const emptyDesk = document.createElement('div');
                    emptyDesk.className = 'sp-desk';
                    cell.appendChild(emptyDesk);
                }

                // Drop target events
                cell.addEventListener('dragover', e => this.handleDragOver(e));
                cell.addEventListener('dragenter', e => this.handleDragEnter(e, cell));
                cell.addEventListener('dragleave', e => this.handleDragLeave(e, cell));
                cell.addEventListener('drop', e => this.handleDrop(e, r, c));

                // Context menu
                cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));

                this.appendLocalAisleMarkers(cell, r, c, localAisles);
                grid.appendChild(cell);
            }
        }

        if (window.lucide) window.lucide.createIcons();

        // Sync podium seat width with grid seats
        requestAnimationFrame(() => {
            this.fitGridToClassroomView();
            this.syncPodiumSeatWidth();
            this.renderAisleGapHandles();
        });
        // Add resize listener if not already added
        if (!this._resizeHandler) {
            this._resizeHandler = () => {
                this.fitGridToClassroomView();
                this.syncPodiumSeatWidth();
                this.renderAisleGapHandles();
                this.syncChatPosition();
            };
            window.addEventListener('resize', this._resizeHandler);
        }
    }

getConstraintIndicators(studentId) {
        const results = [];
        const student = this.studentMap.get(studentId);
        const studentName = student?.name;

        // Check unsatisfied constraints (may use ID or name)
        for (const u of this.unsatisfied) {
            if (u.target === studentId || u.target === studentName) {
                results.push({ type: 'warning', icon: 'alert-triangle', reason: u.reason });
            }
        }

        // Check all constraints (constraints use student names)
        for (const c of this.constraints) {
            if (c.target === studentName) {
                if (c.type === 'front_row') {
                    results.push({ type: 'success', icon: 'eye', reason: '需坐前排' });
                }
                if (c.type === 'avoid') {
                    results.push({ type: 'error', icon: 'x-circle', reason: `避免与${c.related}相邻` });
                }
            }
        }
        return results;
    }

highlightRelationships(studentId) {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        // Add highlighting mode to grid
        grid.classList.add('sp-grid--highlighting');

        // Get related students from constraints (constraints use names, not IDs)
        const relatedIds = new Set();
        const hoveredStudent = this.studentMap.get(studentId);
        const hoveredName = hoveredStudent?.name;
        if (hoveredName) {
            for (const c of this.constraints) {
                if (c.target === hoveredName && c.related) {
                    const relatedStudent = this.students.find(s => s.name === c.related);
                    if (relatedStudent) relatedIds.add(relatedStudent.id);
                }
                if (c.related === hoveredName) {
                    const targetStudent = this.students.find(s => s.name === c.target);
                    if (targetStudent) relatedIds.add(targetStudent.id);
                }
            }
        }

        // Highlight current and related students
        const seats = grid.querySelectorAll('.sp-seat--filled');
        seats.forEach(seat => {
            const seatStudentId = seat.dataset.studentId;
            if (seatStudentId === studentId || relatedIds.has(seatStudentId)) {
                seat.classList.add('sp-seat--highlighted');
            }
        });
    }

clearHighlights() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        grid.classList.remove('sp-grid--highlighting');
        const seats = grid.querySelectorAll('.sp-seat--highlighted');
        seats.forEach(seat => seat.classList.remove('sp-seat--highlighted'));
    }

fitGridToClassroomView() {
        const grid = document.getElementById('sp-grid');
        const view = grid?.closest('.sp-classroom-view');
        if (!grid || !view) return 1;

        grid.style.setProperty('--sp-grid-fit-scale', '1');
        grid.style.marginBottom = '';

        const viewStyle = window.getComputedStyle(view);
        if (view.clientWidth <= 0) return 1;
        const horizontalPadding = (Number.parseFloat(viewStyle.paddingLeft) || 0)
            + (Number.parseFloat(viewStyle.paddingRight) || 0);
        const availableWidth = Math.max(1, view.clientWidth - horizontalPadding);
        const gridWindow = grid.querySelector('.sp-grid-window');
        const gridStyle = window.getComputedStyle(grid);
        const gridPadding = (Number.parseFloat(gridStyle.paddingLeft) || 0)
            + (Number.parseFloat(gridStyle.paddingRight) || 0);
        const naturalWidth = Math.max(
            grid.scrollWidth,
            gridWindow ? gridWindow.scrollWidth + gridPadding : 0
        );
        const scale = naturalWidth > availableWidth
            ? Math.max(0.25, Math.min(1, availableWidth / naturalWidth))
            : 1;
        const roundedScale = Number(scale.toFixed(4));

        grid.style.setProperty('--sp-grid-fit-scale', String(roundedScale));

        const naturalHeight = Math.max(grid.scrollHeight, grid.offsetHeight);
        const collapsedHeight = naturalHeight * (1 - roundedScale);
        grid.style.marginBottom = collapsedHeight > 1 ? `-${collapsedHeight}px` : '';

        return roundedScale;
    }

syncPodiumSeatWidth() {
        const gridSeat = document.querySelector('.sp-grid .sp-seat');
        const podiumSeats = document.querySelectorAll('.sp-podium-row .sp-seat');
        if (gridSeat && podiumSeats.length) {
            const width = gridSeat.getBoundingClientRect().width;
            podiumSeats.forEach(seat => {
                seat.style.width = `${width}px`;
                seat.style.minWidth = `${width}px`;
            });
        }
    }

getVisibleGridSeatBounds() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return null;
        const rects = [...grid.querySelectorAll('.sp-seat[data-row]')]
            .map(seat => seat.getBoundingClientRect())
            .filter(rect => rect.width > 0 && rect.height > 0);
        if (!rects.length) return grid.getBoundingClientRect();

        const left = Math.min(...rects.map(rect => rect.left));
        const right = Math.max(...rects.map(rect => rect.right));
        const top = Math.min(...rects.map(rect => rect.top));
        const bottom = Math.max(...rects.map(rect => rect.bottom));
        return {
            left,
            right,
            top,
            bottom,
            width: right - left,
            height: bottom - top,
        };
    }

getGridSeatElement(row, col) {
        return document.querySelector(`.sp-grid .sp-seat[data-row="${row}"][data-col="${col}"]`);
    }

getCurrentLocalAisles() {
        const localAisles = normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols);
        if (this.classroomLayout) this.classroomLayout.localAisles = localAisles;
        return localAisles;
    }

isSeatPairForLocalAisle(layout, orientation, row, col) {
        if (!layout?.cells) return false;
        if (orientation === 'vertical') {
            return layout.cells?.[row]?.[col] === 'seat'
                && layout.cells?.[row]?.[col + 1] === 'seat';
        }
        if (orientation === 'horizontal') {
            return layout.cells?.[row]?.[col] === 'seat'
                && layout.cells?.[row + 1]?.[col] === 'seat';
        }
        return false;
    }

appendLocalAisleMarkers(cell, row, col, localAisles = this.getCurrentLocalAisles()) {
        if (!cell || !isLayoutSeat(this.classroomLayout, row, col)) return;
        if (hasLocalAisle(localAisles, 'vertical', row, col)
            && this.isSeatPairForLocalAisle(this.classroomLayout, 'vertical', row, col)) {
            const marker = document.createElement('span');
            marker.className = 'sp-local-aisle-marker sp-local-aisle-marker--vertical';
            cell.appendChild(marker);
        }
        if (hasLocalAisle(localAisles, 'horizontal', row, col)
            && this.isSeatPairForLocalAisle(this.classroomLayout, 'horizontal', row, col)) {
            const marker = document.createElement('span');
            marker.className = 'sp-local-aisle-marker sp-local-aisle-marker--horizontal';
            cell.appendChild(marker);
        }
    }

isInteractiveSeatCell(row, col) {
        return row >= 0
            && row < this.rows
            && col >= 0
            && col < this.cols
            && !this.rowAisles.includes(row)
            && !this.colAisles.includes(col)
            && isLayoutSeat(this.classroomLayout, row, col);
    }

shouldShowRowGap(row, col) {
        return this.isInteractiveSeatCell(row, col) && this.isInteractiveSeatCell(row + 1, col);
    }

shouldShowColumnGap(row, col) {
        return this.isInteractiveSeatCell(row, col) && this.isInteractiveSeatCell(row, col + 1);
    }

shouldShowRowAisleBoundary(row) {
        return Number.isInteger(row)
            && row > 0
            && row < this.rows
            && !this.rowAisles.includes(row - 1)
            && !this.rowAisles.includes(row);
    }

shouldShowColumnAisleBoundary(col) {
        return Number.isInteger(col)
            && col > 0
            && col < this.cols
            && !this.colAisles.includes(col - 1)
            && !this.colAisles.includes(col);
    }

renderAisleGapHandles() {
        const layer = document.getElementById('sp-aisle-gap-layer');
        const grid = document.getElementById('sp-grid');
        const view = document.querySelector('.sp-classroom-view');
        if (!layer || !grid || !view) return;
        layer.replaceChildren();
        if (!this.rows || !this.cols) return;

        const viewRect = view.getBoundingClientRect();
        const visualGridBounds = this.getVisibleGridSeatBounds();
        if (!visualGridBounds) return;
        const toLayerLeft = value => value - viewRect.left + view.scrollLeft;
        const toLayerTop = value => value - viewRect.top + view.scrollTop;
        const firstVisibleRow = Number(grid.querySelector('.sp-seat[data-row]')?.dataset.row ?? 0);
        const lastVisibleRow = Number([...grid.querySelectorAll('.sp-seat[data-row]')].at(-1)?.dataset.row ?? this.rows - 1);
        for (let row = Math.max(1, firstVisibleRow); row <= Math.min(this.rows - 1, lastVisibleRow + 1); row++) {
            if (!this.shouldShowRowAisleBoundary(row)) continue;
            const upper = this.getGridSeatElement(row - 1, 0);
            const lower = this.getGridSeatElement(row, 0);
            if (!upper || !lower) continue;
            const upperRect = upper.getBoundingClientRect();
            const lowerRect = lower.getBoundingClientRect();
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = `sp-aisle-gap sp-aisle-gap--row`;
            handle.title = '点击插入横过道';
            handle.setAttribute('aria-label', `在第 ${row} 排和第 ${row + 1} 排之间插入横过道`);
            handle.dataset.insertRow = String(row);
            handle.style.left = `${toLayerLeft(visualGridBounds.left)}px`;
            handle.style.top = `${toLayerTop((upperRect.bottom + lowerRect.top) / 2) - 7}px`;
            handle.style.width = `${visualGridBounds.width}px`;
            handle.style.height = '14px';
            handle.addEventListener('click', event => {
                event.stopPropagation();
                this.insertAisleRowAt(row);
            });
            layer.appendChild(handle);
        }

        for (let col = 1; col < this.cols; col++) {
            if (!this.shouldShowColumnAisleBoundary(col)) continue;
            const left = this.getGridSeatElement(firstVisibleRow, col - 1);
            const right = this.getGridSeatElement(firstVisibleRow, col);
            const bottomCell = this.getGridSeatElement(Math.min(lastVisibleRow, this.rows - 1), col - 1);
            if (!left || !right || !bottomCell) continue;
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            const bottomRect = bottomCell.getBoundingClientRect();
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = `sp-aisle-gap sp-aisle-gap--col`;
            handle.title = '点击插入竖过道';
            handle.setAttribute('aria-label', `在第 ${col} 列和第 ${col + 1} 列之间插入竖过道`);
            handle.dataset.insertCol = String(col);
            handle.style.left = `${toLayerLeft((leftRect.right + rightRect.left) / 2) - 7}px`;
            handle.style.top = `${toLayerTop(leftRect.top)}px`;
            handle.style.width = '14px';
            handle.style.height = `${Math.max(14, bottomRect.bottom - leftRect.top)}px`;
            handle.addEventListener('click', event => {
                event.stopPropagation();
                this.insertAisleColumnAt(col);
            });
            layer.appendChild(handle);
        }
    }

applyAisleEditResult(result, message) {
        this.layout = result.layout;
        this.rows = result.rows;
        this.cols = result.cols;
        this.classroomLayout = result.classroomLayout;
        this.classroomLayout.localAisles = normalizeLocalAisles(this.classroomLayout.localAisles, this.rows, this.cols);
        this.classroomLayout.guardians.left = this.guardians[0] || null;
        this.classroomLayout.guardians.right = this.guardians[1] || null;
        this.rowAisles = result.rowAisles;
        this.colAisles = result.colAisles;
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        if (message) this.showToast(message, 'success');
    }

applyLocalAisleEdit(nextClassroomLayout, message) {
        this.classroomLayout = structuredClone(nextClassroomLayout);
        this.classroomLayout.localAisles = normalizeLocalAisles(this.classroomLayout.localAisles, this.rows, this.cols);
        this.classroomLayout.guardians.left = this.guardians[0] || null;
        this.classroomLayout.guardians.right = this.guardians[1] || null;
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        if (message) this.showToast(message, 'success');
    }

insertLocalAisleAt(orientation, row, col) {
        try {
            const next = insertLocalAisle({
                classroomLayout: this.classroomLayout,
                orientation,
                row,
                col,
            });
            this.applyLocalAisleEdit(next, '已在两个座位之间插入局部过道');
        } catch (error) {
            this.showToast(error.message || '无法插入局部过道', 'warning');
        }
    }

deleteLocalAisleAt(orientation, row, col) {
        try {
            const next = deleteLocalAisle({
                classroomLayout: this.classroomLayout,
                orientation,
                row,
                col,
            });
            this.applyLocalAisleEdit(next, '已删除局部过道');
        } catch (error) {
            this.showToast(error.message || '无法删除局部过道', 'warning');
        }
    }

insertAisleRowAt(index) {
        try {
            this.applyAisleEditResult(
                insertAisleRow({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已插入第 ${index} 排和第 ${index + 1} 排之间的横过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法插入横过道', 'warning');
        }
    }

insertAisleColumnAt(index) {
        try {
            this.applyAisleEditResult(
                insertAisleColumn({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已插入第 ${index} 列和第 ${index + 1} 列之间的竖过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法插入竖过道', 'warning');
        }
    }

deleteAisleRowAt(index) {
        try {
            this.applyAisleEditResult(
                deleteAisleRow({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已删除第 ${index + 1} 排横过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法删除横过道', 'warning');
        }
    }

deleteAisleColumnAt(index) {
        try {
            this.applyAisleEditResult(
                deleteAisleColumn({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已删除第 ${index + 1} 列竖过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法删除竖过道', 'warning');
        }
    }

showContextMenu(e, row, col) {
        e.preventDefault();
        this.contextTarget = { row, col };

        const menu = document.getElementById('sp-context-menu');
        if (!menu) return;

        const isColAisle = this.colAisles.includes(col);
        const isRowAisle = this.rowAisles.includes(row);
        const isAisle = isColAisle || isRowAisle || !isLayoutSeat(this.classroomLayout, row, col);
        this.contextTarget = { row, col, aisleType: isRowAisle ? 'row' : isColAisle ? 'col' : null };

        menu.querySelector('[data-action="set-col-aisle"]').style.display = 'none';
        menu.querySelector('[data-action="set-row-aisle"]').style.display = 'none';
        menu.querySelector('[data-action="clear-aisle"]').style.display = (isRowAisle || isColAisle) ? 'flex' : 'none';
        menu.querySelector('[data-action="clear-seat"]').style.display = isAisle ? 'none' : 'flex';

        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('sp-context-menu--visible');
    }

hideContextMenu() {
        document.getElementById('sp-context-menu')?.classList.remove('sp-context-menu--visible');
    }

handleMenuAction(action) {
        if (!this.contextTarget) return;
        const { row, col, aisleType } = this.contextTarget;
        let changed = false;

        switch (action) {
            case 'set-col-aisle':
                if (colHasStudents(this.layout, col)) {
                    this.showToast('该列已有学生，请先移动或清空后再设为过道', 'warning');
                    break;
                }
                if (!this.colAisles.includes(col)) {
                    this.colAisles.push(col);
                    changed = true;
                    this.showToast(`第 ${col + 1} 列设为竖过道`, 'success');
                }
                break;
            case 'set-row-aisle':
                if (rowHasStudents(this.layout, row)) {
                    this.showToast('该行已有学生，请先移动或清空后再设为过道', 'warning');
                    break;
                }
                if (!this.rowAisles.includes(row)) {
                    this.rowAisles.push(row);
                    changed = true;
                    this.showToast(`第 ${row + 1} 行设为横过道`, 'success');
                }
                break;
            case 'clear-aisle':
                if (aisleType === 'row') {
                    this.deleteAisleRowAt(row);
                    this.hideContextMenu();
                    return;
                }
                if (aisleType === 'col') {
                    this.deleteAisleColumnAt(col);
                    this.hideContextMenu();
                    return;
                }
                break;
            case 'clear-seat':
                if (this.layout[row]?.[col]) {
                    this.layout[row][col] = null;
                    changed = true;
                    this.showToast('座位已清空', 'success');
                }
                break;
        }

        this.hideContextMenu();
        if (changed) {
            this.classroomLayout = this.legacyLayoutToClassroomLayout('custom');
            this.refreshConstraintStatus();
            this.saveSnapshot();
            this.renderGrid();
            this.updateStatus();
        }
    }
}

export const seatingGridMethods = Object.fromEntries(
    Object.getOwnPropertyNames(SeatingGridPanelMethods.prototype)
        .filter(name => name !== 'constructor')
        .map(name => [name, SeatingGridPanelMethods.prototype[name]])
);
