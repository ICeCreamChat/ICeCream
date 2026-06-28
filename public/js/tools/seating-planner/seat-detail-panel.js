class SeatingSeatDetailPanelMethods {
    renderSeatMeta(student) {
        const details = [];
        if (student?.grade !== undefined && student?.grade !== null && student.grade !== '') {
            details.push({ label: '成绩', value: student.grade });
        }
        if (student?.height !== undefined && student?.height !== null && student.height !== '') {
            details.push({ label: '身高', value: student.height });
        }
        if (!details.length) return null;
        const meta = document.createElement('div');
        meta.className = 'sp-seat-meta';
        if (!this.showSeatDetails) meta.classList.add('sp-seat-meta--hidden');
        for (const detail of details) {
            const item = document.createElement('span');
            item.className = 'sp-seat-meta-item';
            item.textContent = `${detail.label}:${detail.value}`;
            meta.appendChild(item);
        }
        return meta;
    }

    needReferencesStudent(need, studentId) {
        const student = this.studentMap.get(studentId);
        const studentName = student?.name;
        return [need?.target, need?.related, need?.studentId, need?.student, need?.id]
            .filter(Boolean)
            .some(value => value === studentId || value === studentName);
    }

    studentHasUnmetNeed(studentId) {
        return this.unsatisfied.some(need => this.needReferencesStudent(need, studentId));
    }

    studentHasAnyNeed(studentId) {
        return this.constraints.some(need => this.needReferencesStudent(need, studentId));
    }

    studentHasSatisfiedNeed(studentId) {
        return this.studentHasAnyNeed(studentId) && !this.studentHasUnmetNeed(studentId);
    }

    studentHasVisionNeed(studentId) {
        const visionPattern = /近视|戴眼镜|视力|看不清|看不见|看不到|黑板/;
        return this.constraints.some(need => {
            if (!this.needReferencesStudent(need, studentId)) return false;
            return visionPattern.test(`${need.type || ''} ${need.reason || ''} ${need.related || ''}`);
        });
    }

    createDeskItem(className, text, title) {
        const item = document.createElement('span');
        item.className = `sp-desk-item ${className}`;
        item.textContent = text;
        item.title = title;
        return item;
    }

    renderDeskItems(student) {
        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'sp-desk-items';
        if (!student?.id) return itemsContainer;

        if (this.studentHasVisionNeed(student.id)) {
            itemsContainer.appendChild(this.createDeskItem('sp-desk-item--glasses', '👓', '近视或看清需求'));
        }
        if (this.isTopGradeStudent(student)) {
            itemsContainer.appendChild(this.createDeskItem('sp-desk-item--books', '📚', `成绩: ${student.grade}分`));
        }
        if (this.studentHasSatisfiedNeed(student.id)) {
            itemsContainer.appendChild(this.createDeskItem('sp-desk-item--candy', '🍬', '心愿已满足'));
        }
        if (this.studentHasUnmetNeed(student.id)) {
            const warning = this.unsatisfied.find(need => this.needReferencesStudent(need, student.id));
            itemsContainer.appendChild(this.createDeskItem('sp-desk-item--quiet', '⚠️', warning?.reason || '需求未满足'));
        }

        return itemsContainer;
    }

    createSeatDetailMeta(label, value) {
        const item = document.createElement('span');
        item.className = 'sp-seat-detail-meta-item';
        item.textContent = `${label}: ${value ?? '-'}`;
        return item;
    }

    createSeatDetailIconRow(icon, title, description, modifier = '') {
        const row = document.createElement('div');
        row.className = `sp-seat-detail-icon-row ${modifier}`.trim();
        const iconEl = document.createElement('span');
        iconEl.className = 'sp-seat-detail-icon';
        iconEl.textContent = icon;
        const text = document.createElement('span');
        const label = document.createElement('strong');
        label.textContent = title;
        const detail = document.createElement('small');
        detail.textContent = description;
        text.append(label, detail);
        row.append(iconEl, text);
        return row;
    }

    getStudentRelatedNeeds(studentId) {
        return this.constraints.filter(need => this.needReferencesStudent(need, studentId));
    }

    needMatchesUnsatisfied(need, unsatisfied) {
        if (!need || !unsatisfied) return false;
        const sameType = (need.type || '') === (unsatisfied.type || '');
        const sameTarget = String(need.target || '') === String(unsatisfied.target || '');
        const sameRelated = String(need.related || '') === String(unsatisfied.related || '');
        return sameType && sameTarget && sameRelated;
    }

    isNeedCurrentlyUnsatisfied(need, studentId) {
        return this.unsatisfied.some(item =>
            this.needReferencesStudent(item, studentId) && this.needMatchesUnsatisfied(need, item)
        );
    }

    formatSeatDetailConstraintType(type) {
        const labels = {
            front_row: '前排',
            back_row: '后排',
            avoid_first_row: '避开第一排',
            avoid_last_row: '避开最后一排',
            avoid_front_row: '避开前排',
            avoid_back_row: '避开后排',
            avoid_behind: '不要坐后面',
            avoid_near: '不要太近',
            avoid_low_grade_deskmate: '避开低分同桌',
            prefer_front_middle: '前排中间',
            prefer_front_mid_rows: '前中排',
            prefer_aisle: '靠过道',
            prefer_edge: '靠边',
            prefer_high_grade_neighbor: '高分同伴',
            prefer_near: '尽量靠近',
            avoid: '不要相邻',
            not_adjacent: '不能相邻',
            prefer: '偏好相邻',
            pair: '安排同桌',
            must_adjacent: '必须相邻',
        };
        return labels[type] || type || '座位需求';
    }

    buildSeatDetail(studentId) {
        const student = this.studentMap.get(studentId);
        if (!student) return null;

        const panel = document.createElement('div');
        panel.className = 'sp-seat-detail-content';

        const header = document.createElement('div');
        header.className = 'sp-seat-detail-header';
        const title = document.createElement('strong');
        title.className = 'sp-seat-detail-name';
        title.textContent = student.name || student.id;
        const meta = document.createElement('div');
        meta.className = 'sp-seat-detail-meta';
        meta.append(
            this.createSeatDetailMeta('性别', student.gender === 'M' ? '男' : (student.gender === 'F' ? '女' : '-')),
            this.createSeatDetailMeta('成绩', student.grade ?? '-'),
            this.createSeatDetailMeta('身高', student.height ?? '-')
        );
        header.append(title, meta);
        panel.appendChild(header);

        const icons = document.createElement('div');
        icons.className = 'sp-seat-detail-icons';
        const iconRows = [];
        if (this.studentHasVisionNeed(student.id)) {
            iconRows.push(this.createSeatDetailIconRow('👓', '视力/看清需求', '有近视、戴眼镜、看清黑板或前排相关需求。'));
        }
        if (this.isTopGradeStudent(student)) {
            iconRows.push(this.createSeatDetailIconRow('📚', '成绩前 20%', '当前成绩属于班级前 20%，会在成绩策略中被优先照顾。'));
        }
        if (this.studentHasSatisfiedNeed(student.id)) {
            iconRows.push(this.createSeatDetailIconRow('🍬', '需求已满足', '该学生相关需求当前没有未满足项。', 'sp-seat-detail-icon-row--success'));
        }
        if (this.studentHasUnmetNeed(student.id)) {
            const warning = this.unsatisfied.find(need => this.needReferencesStudent(need, student.id));
            iconRows.push(this.createSeatDetailIconRow('⚠️', '需求未满足', warning?.reason || '该学生仍有需求未满足。', 'sp-seat-detail-icon-row--warning'));
        }
        if (!iconRows.length) {
            iconRows.push(this.createSeatDetailIconRow('•', '暂无特殊图标', '当前座位没有额外桌面标记。'));
        }
        icons.append(...iconRows);
        panel.appendChild(icons);

        const constraints = document.createElement('div');
        constraints.className = 'sp-seat-detail-constraints';
        const constraintsTitle = document.createElement('strong');
        constraintsTitle.textContent = '相关需求';
        constraints.appendChild(constraintsTitle);

        const relatedNeeds = this.getStudentRelatedNeeds(student.id);
        if (!relatedNeeds.length) {
            const empty = document.createElement('div');
            empty.className = 'sp-seat-detail-empty';
            empty.textContent = '暂无相关需求。';
            constraints.appendChild(empty);
        } else {
            relatedNeeds.forEach(need => {
                const unmet = this.isNeedCurrentlyUnsatisfied(need, student.id);
                const row = document.createElement('div');
                row.className = `sp-seat-detail-constraint ${unmet ? 'is-unmet' : 'is-met'}`;

                const main = document.createElement('span');
                main.className = 'sp-seat-detail-constraint-text';
                const priority = need.priority === 'hard' ? '必须' : '尽量';
                const relation = need.related ? ` -> ${need.related}` : '';
                main.textContent = `${priority} · ${this.formatSeatDetailConstraintType(need.type)} · ${need.target || student.name}${relation}`;
                if (need.reason) {
                    const reason = document.createElement('small');
                    reason.textContent = need.reason;
                    main.appendChild(reason);
                }

                const status = document.createElement('span');
                status.className = `sp-seat-detail-status ${unmet ? 'is-unmet' : 'is-met'}`;
                status.textContent = unmet ? '未满足' : '已满足';
                row.append(main, status);
                constraints.appendChild(row);
            });
        }
        panel.appendChild(constraints);
        return panel;
    }

    positionSeatDetailPopover(popover, anchor) {
        if (!popover || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        const width = popover.offsetWidth || 320;
        const height = popover.offsetHeight || 220;
        const margin = 12;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || width;
        const left = Math.min(
            Math.max(8, rect.left + rect.width / 2 - width / 2),
            Math.max(8, viewportWidth - width - 8)
        );
        const placeAbove = rect.top >= height + margin + 8;
        const top = placeAbove
            ? rect.top - height - margin
            : rect.bottom + margin;
        popover.classList.toggle('sp-seat-detail-popover--above', placeAbove);
        popover.classList.toggle('sp-seat-detail-popover--below', !placeAbove);
        popover.style.left = `${left}px`;
        popover.style.top = `${Math.max(8, top)}px`;
    }

    findSeatDetailAnchor(studentId) {
        if (!studentId) return null;
        return Array.from(document.querySelectorAll('.sp-seat--filled[data-student-id]'))
            .find(seat => seat.dataset.studentId === studentId) || null;
    }

    scheduleSeatDetailPopoverSync() {
        if (!this._seatDetailPopover || this._seatDetailSyncFrame) return;
        this._seatDetailSyncFrame = requestAnimationFrame(() => this.syncSeatDetailPopoverPosition());
    }

    syncSeatDetailPopoverPosition() {
        this._seatDetailSyncFrame = null;
        if (!this._seatDetailPopover || !this._seatDetailStudentId) return;

        let anchor = this._seatDetailAnchor;
        if (!anchor?.isConnected || anchor.dataset.studentId !== this._seatDetailStudentId) {
            anchor?.classList?.remove('sp-seat--detail-open');
            anchor = this.findSeatDetailAnchor(this._seatDetailStudentId);
            this._seatDetailAnchor = anchor;
            if (anchor) anchor.classList.add('sp-seat--detail-open');
        }

        if (!anchor) {
            this.hideSeatDetailPopover();
            return;
        }

        const rect = anchor.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const isVisible = rect.width > 0
            && rect.height > 0
            && rect.right > 0
            && rect.bottom > 0
            && rect.left < viewportWidth
            && rect.top < viewportHeight;

        if (!isVisible) {
            this.hideSeatDetailPopover();
            return;
        }

        this.positionSeatDetailPopover(this._seatDetailPopover, anchor);
    }

    bindSeatDetailPositionSync(anchor) {
        this.unbindSeatDetailPositionSync();
        this._seatDetailScrollHandler = () => this.scheduleSeatDetailPopoverSync();
        this._seatDetailResizeHandler = () => this.scheduleSeatDetailPopoverSync();

        const scrollTargets = [
            anchor?.closest('.sp-classroom-view'),
            this.container?.closest('.tool-body'),
        ].filter(Boolean);
        this._seatDetailScrollTargets = Array.from(new Set(scrollTargets));
        this._seatDetailScrollTargets.forEach(target => {
            target.addEventListener('scroll', this._seatDetailScrollHandler, { passive: true });
        });
        window.addEventListener('resize', this._seatDetailResizeHandler);
    }

    unbindSeatDetailPositionSync() {
        if (this._seatDetailScrollHandler) {
            this._seatDetailScrollTargets.forEach(target => {
                target.removeEventListener('scroll', this._seatDetailScrollHandler);
            });
        }
        if (this._seatDetailResizeHandler) {
            window.removeEventListener('resize', this._seatDetailResizeHandler);
        }
        if (this._seatDetailSyncFrame) {
            cancelAnimationFrame(this._seatDetailSyncFrame);
            this._seatDetailSyncFrame = null;
        }
        this._seatDetailScrollTargets = [];
        this._seatDetailScrollHandler = null;
        this._seatDetailResizeHandler = null;
    }

    showSeatDetailPopover(event, studentId) {
        const detail = this.buildSeatDetail(studentId);
        if (!detail) return;

        this.hideSeatDetailPopover();
        const anchor = event.currentTarget;
        this._seatDetailAnchor = anchor;
        this._seatDetailStudentId = studentId;
        anchor.classList.add('sp-seat--detail-open');
        const popover = document.createElement('div');
        popover.className = 'sp-seat-detail-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '座位详情');
        popover.appendChild(detail);
        document.body.appendChild(popover);
        this._seatDetailPopover = popover;
        this.positionSeatDetailPopover(popover, anchor);
        this.bindSeatDetailPositionSync(anchor);

        this._seatDetailOutsideClickHandler = clickEvent => {
            const currentAnchor = this._seatDetailAnchor;
            if (popover.contains(clickEvent.target) || currentAnchor?.contains(clickEvent.target)) return;
            this.hideSeatDetailPopover();
        };
        this._seatDetailKeyHandler = keyEvent => {
            if (keyEvent.key === 'Escape') this.hideSeatDetailPopover();
        };
        document.addEventListener('keydown', this._seatDetailKeyHandler);
        setTimeout(() => {
            if (this._seatDetailPopover === popover) {
                document.addEventListener('click', this._seatDetailOutsideClickHandler);
            }
        }, 0);
    }

    hideSeatDetailPopover() {
        if (this._seatDetailAnchor) {
            this._seatDetailAnchor.classList.remove('sp-seat--detail-open');
            this._seatDetailAnchor = null;
        }
        this._seatDetailStudentId = null;
        this.unbindSeatDetailPositionSync();
        if (this._seatDetailOutsideClickHandler) {
            document.removeEventListener('click', this._seatDetailOutsideClickHandler);
            this._seatDetailOutsideClickHandler = null;
        }
        if (this._seatDetailKeyHandler) {
            document.removeEventListener('keydown', this._seatDetailKeyHandler);
            this._seatDetailKeyHandler = null;
        }
        if (this._seatDetailPopover) {
            this._seatDetailPopover.remove();
            this._seatDetailPopover = null;
        }
    }

    bindSeatDetailPopover(cell, studentId) {
        if (!cell || !studentId) return;
        this.unbindSeatDetailPopover(cell);
        cell._seatDetailPointerDownHandler = event => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            cell._seatDetailPointerStart = {
                x: event.clientX,
                y: event.clientY,
                at: Date.now(),
            };
        };
        cell._seatDetailPointerUpHandler = event => {
            const start = cell._seatDetailPointerStart;
            cell._seatDetailPointerStart = null;
            if (!start) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            const dx = Math.abs(event.clientX - start.x);
            const dy = Math.abs(event.clientY - start.y);
            if (dx > 5 || dy > 5 || this._justDragged) return;
            event.stopPropagation();
            this._seatDetailSuppressClickUntil = Date.now() + 220;
            this.showSeatDetailPopover(event, studentId);
        };
        cell._seatDetailClickHandler = event => {
            if (Date.now() < this._seatDetailSuppressClickUntil) {
                event.stopPropagation();
                return;
            }
            if (this._justDragged) return;
            event.stopPropagation();
            this.showSeatDetailPopover(event, studentId);
        };
        cell.addEventListener('pointerdown', cell._seatDetailPointerDownHandler);
        cell.addEventListener('pointerup', cell._seatDetailPointerUpHandler);
        cell.addEventListener('click', cell._seatDetailClickHandler);
    }

    unbindSeatDetailPopover(cell) {
        if (!cell) return;
        if (cell._seatDetailPointerDownHandler) {
            cell.removeEventListener('pointerdown', cell._seatDetailPointerDownHandler);
            cell._seatDetailPointerDownHandler = null;
        }
        if (cell._seatDetailPointerUpHandler) {
            cell.removeEventListener('pointerup', cell._seatDetailPointerUpHandler);
            cell._seatDetailPointerUpHandler = null;
        }
        if (cell._seatDetailClickHandler) {
            cell.removeEventListener('click', cell._seatDetailClickHandler);
            cell._seatDetailClickHandler = null;
        }
        cell._seatDetailPointerStart = null;
    }
}

export const seatingSeatDetailMethods = Object.fromEntries(
    Object.getOwnPropertyNames(SeatingSeatDetailPanelMethods.prototype)
        .filter(name => name !== 'constructor')
        .map(name => [name, SeatingSeatDetailPanelMethods.prototype[name]])
);
