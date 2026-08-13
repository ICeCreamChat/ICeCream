const SVG_NS = 'http://www.w3.org/2000/svg';

// Bootstrap Icons person-walking, MIT licensed.
const WALKING_ICON_PATHS = [
    'M9.5 1.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0M6.44 3.752A.75.75 0 0 1 7 3.5h1.445c.742 0 1.32.643 1.243 1.38l-.43 4.083a1.8 1.8 0 0 1-.088.395l-.318.906.213.242a.8.8 0 0 1 .114.175l2 4.25a.75.75 0 1 1-1.357.638l-1.956-4.154-1.68-1.921A.75.75 0 0 1 6 8.96l.138-2.613-.435.489-.464 2.786a.75.75 0 1 1-1.48-.246l.5-3a.75.75 0 0 1 .18-.375l2-2.25Z',
    'M6.25 11.745v-1.418l1.204 1.375.261.524a.8.8 0 0 1-.12.231l-2.5 3.25a.75.75 0 1 1-1.19-.914zm4.22-4.215-.494-.494.205-1.843.006-.067 1.124 1.124h1.44a.75.75 0 0 1 0 1.5H11a.75.75 0 0 1-.531-.22Z',
];

function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

function appendWalkingIcon(parent, { centerX, centerY, scale }) {
    const icon = svgElement('g', {
        class: 'sp-arrangement-svg__walkway-icon',
        transform: `translate(${centerX - 8 * scale} ${centerY - 8 * scale}) scale(${scale})`,
        'aria-hidden': 'true',
    });
    WALKING_ICON_PATHS.forEach(d => icon.appendChild(svgElement('path', { d })));
    parent.appendChild(icon);
}

function appendWalkwaySurface(parent, {
    x,
    y,
    width,
    height,
    orientation,
    compact,
    isMain = false,
    showIcon = false,
}) {
    const modifier = isMain ? ' sp-arrangement-svg__walkway-surface--main' : '';
    const edgeModifier = isMain ? ' sp-arrangement-svg__walkway-edge--main' : '';
    parent.appendChild(svgElement('rect', {
        x,
        y,
        width,
        height,
        class: `sp-arrangement-svg__walkway-surface${modifier}`,
    }));
    if (orientation === 'vertical') {
        parent.appendChild(svgElement('path', {
            d: `M ${x + 2} ${y} V ${y + height} M ${x + width - 2} ${y} V ${y + height}`,
            class: `sp-arrangement-svg__walkway-edge${edgeModifier}`,
        }));
    } else {
        parent.appendChild(svgElement('path', {
            d: `M ${x} ${y + 2} H ${x + width} M ${x} ${y + height - 2} H ${x + width}`,
            class: `sp-arrangement-svg__walkway-edge${edgeModifier}`,
        }));
    }
    if (showIcon) {
        appendWalkingIcon(parent, {
            centerX: x + width / 2,
            centerY: y + height / 2,
            scale: compact ? 1.15 : 1.55,
        });
    }
}

function appendCrossMainAisle(parent, { vertical, horizontal, compact }) {
    const vx1 = vertical.x;
    const vx2 = vertical.x + vertical.width;
    const vy1 = vertical.y;
    const vy2 = vertical.y + vertical.height;
    const hx1 = horizontal.x;
    const hx2 = horizontal.x + horizontal.width;
    const hy1 = horizontal.y;
    const hy2 = horizontal.y + horizontal.height;
    const crossPath = [
        `M ${vx1} ${vy1}`,
        `H ${vx2}`,
        `V ${hy1}`,
        `H ${hx2}`,
        `V ${hy2}`,
        `H ${vx2}`,
        `V ${vy2}`,
        `H ${vx1}`,
        `V ${hy2}`,
        `H ${hx1}`,
        `V ${hy1}`,
        `H ${vx1}`,
        'Z',
    ].join(' ');
    parent.appendChild(svgElement('path', {
        d: crossPath,
        class: 'sp-arrangement-svg__walkway-surface sp-arrangement-svg__walkway-surface--main sp-arrangement-svg__main-aisle--cross',
    }));
    parent.appendChild(svgElement('path', {
        d: crossPath,
        class: 'sp-arrangement-svg__walkway-edge sp-arrangement-svg__walkway-edge--main',
    }));
    appendWalkingIcon(parent, {
        centerX: vertical.x + vertical.width / 2,
        centerY: horizontal.y + horizontal.height / 2,
        scale: compact ? 1.15 : 1.55,
    });
}

function boundaryLabel(value) {
    return { none: '不留间距', gap: '普通间距', walkway: '可通行过道' }[value] || '不留间距';
}

function mainAisleLabel(value) {
    return {
        none: '无主过道',
        vertical: '竖向主过道',
        horizontal: '横向主过道',
        cross: '十字主过道',
    }[value] || '无主过道';
}

function normalizeRuleSpec(spec = {}) {
    const groupSize = Math.min(4, Math.max(1, Number.parseInt(spec.groupSize, 10) || 1));
    const circulation = spec.circulation || {};
    return {
        ...structuredClone(spec),
        layoutSpecVersion: 2,
        groupSize,
        layoutMode: groupSize > 1 ? 'grouped' : 'standard',
        circulation: {
            betweenGroups: ['none', 'gap', 'walkway'].includes(circulation.betweenGroups)
                ? circulation.betweenGroups
                : 'none',
            betweenRows: ['none', 'gap', 'walkway'].includes(circulation.betweenRows)
                ? circulation.betweenRows
                : 'none',
            mainAisle: ['none', 'vertical', 'horizontal', 'cross'].includes(circulation.mainAisle)
                ? circulation.mainAisle
                : 'none',
        },
    };
}

class SeatingArrangementDiagramPanelMethods {
    currentArrangementRule() {
        return this.arrangementEditorDraft?.arrangementSpec
            || this.recognizedArrangement?.arrangementSpec
            || null;
    }

    buildArrangementSvg(specInput, { compact = false } = {}) {
        const spec = normalizeRuleSpec(specInput);
        const rows = compact ? 1 : 2;
        const groupsPerRow = 4;
        const deskWidth = compact ? 20 : 30;
        const deskHeight = compact ? 20 : 28;
        const chairWidth = compact ? 10 : 15;
        const chairHeight = compact ? 7 : 10;
        const chairOverlap = compact ? 2 : 3;
        const deskGap = compact ? 3 : 5;
        const groupPad = compact ? 5 : 8;
        const groupWidth = spec.groupSize * deskWidth + Math.max(0, spec.groupSize - 1) * deskGap + groupPad * 2;
        const groupHeight = deskHeight + chairHeight - chairOverlap + groupPad * 2;
        // Even "none" keeps groups visually separate; the rule only removes extra spacing.
        const groupSeparation = compact ? 7 : 14;
        const normalGap = compact ? 11 : 22;
        const walkwayGap = compact ? 18 : 34;
        const mainWalkwayGap = compact ? 26 : 42;
        const mainVertical = ['vertical', 'cross'].includes(spec.circulation.mainAisle);
        const mainHorizontal = ['horizontal', 'cross'].includes(spec.circulation.mainAisle);
        const mainBoundaryIndex = Math.floor(groupsPerRow / 2) - 1;
        const boundaryModeAt = groupIndex => (
            mainVertical && groupIndex === mainBoundaryIndex ? 'walkway' : spec.circulation.betweenGroups
        );
        const boundaryWidthFor = (mode, groupIndex) => (
            mainVertical && groupIndex === mainBoundaryIndex
                ? mainWalkwayGap
                : mode === 'walkway' ? walkwayGap : mode === 'gap' ? normalGap : groupSeparation
        );
        const boundaryWidths = Array.from(
            { length: groupsPerRow - 1 },
            (_, groupIndex) => boundaryWidthFor(boundaryModeAt(groupIndex), groupIndex)
        );
        const rowBoundaryMode = mainHorizontal ? 'walkway' : spec.circulation.betweenRows;
        const rowBoundaryHeight = rowBoundaryMode === 'walkway'
            ? (compact ? 0 : mainHorizontal ? 48 : 28)
            : rowBoundaryMode === 'gap'
                ? (compact ? 0 : 15)
                : (compact ? 0 : groupSeparation);
        const padding = compact ? 8 : 24;
        const width = padding * 2 + groupsPerRow * groupWidth
            + boundaryWidths.reduce((total, boundaryWidth) => total + boundaryWidth, 0);
        const height = padding * 2 + rows * groupHeight + Math.max(0, rows - 1) * rowBoundaryHeight;
        const svg = svgElement('svg', {
            viewBox: `0 0 ${width} ${height}`,
            role: 'img',
            'aria-label': compact ? '四组排座规则示意图' : '两排四组排座规则编辑示意图',
        });
        svg.classList.add('sp-arrangement-svg', compact ? 'sp-arrangement-svg--compact' : 'sp-arrangement-svg--editor');

        const groupX = groupIndex => padding + groupIndex * groupWidth
            + boundaryWidths.slice(0, groupIndex).reduce((total, boundaryWidth) => total + boundaryWidth, 0);
        const groupY = rowIndex => padding + rowIndex * (groupHeight + rowBoundaryHeight);

        for (let groupIndex = 0; groupIndex < groupsPerRow - 1; groupIndex++) {
            const boundaryX = groupX(groupIndex) + groupWidth;
            const isMainBoundary = mainVertical && groupIndex === mainBoundaryIndex;
            const boundaryMode = boundaryModeAt(groupIndex);
            const boundaryWidth = boundaryWidths[groupIndex];
            const boundary = svgElement('g', {
                class: `sp-arrangement-svg__boundary sp-arrangement-svg__boundary--${boundaryMode}`,
                'data-diagram-target': compact ? '' : (isMainBoundary ? 'mainAisle' : 'betweenGroups'),
                tabindex: compact ? '-1' : '0',
                role: compact ? 'img' : 'button',
                'aria-label': isMainBoundary ? mainAisleLabel(spec.circulation.mainAisle) : boundaryLabel(boundaryMode),
            });
            boundary.appendChild(svgElement('rect', {
                x: boundaryX,
                y: padding / 2,
                width: boundaryWidth,
                height: height - padding,
                class: 'sp-arrangement-svg__boundary-hit',
            }));
            if (boundaryMode === 'walkway' && !isMainBoundary) {
                appendWalkwaySurface(boundary, {
                    x: boundaryX,
                    y: padding / 2,
                    width: boundaryWidth,
                    height: height - padding,
                    orientation: 'vertical',
                    compact,
                });
            }
            svg.appendChild(boundary);
        }

        if (!compact && rows > 1) {
            const boundaryY = groupY(0) + groupHeight;
            const boundaryMode = rowBoundaryMode;
            const boundary = svgElement('g', {
                class: `sp-arrangement-svg__boundary sp-arrangement-svg__boundary--${boundaryMode}`,
                'data-diagram-target': mainHorizontal ? 'mainAisle' : 'betweenRows',
                tabindex: '0',
                role: 'button',
                'aria-label': mainHorizontal ? mainAisleLabel(spec.circulation.mainAisle) : boundaryLabel(boundaryMode),
            });
            boundary.appendChild(svgElement('rect', {
                x: padding / 2,
                y: boundaryY,
                width: width - padding,
                height: rowBoundaryHeight,
                class: 'sp-arrangement-svg__boundary-hit',
            }));
            if (boundaryMode === 'walkway' && !mainHorizontal) {
                appendWalkwaySurface(boundary, {
                    x: padding / 2,
                    y: boundaryY,
                    width: width - padding,
                    height: rowBoundaryHeight,
                    orientation: 'horizontal',
                    compact,
                });
            }
            svg.appendChild(boundary);
        }

        if (mainVertical || (mainHorizontal && !compact)) {
            const mainAisle = svgElement('g', {
                class: 'sp-arrangement-svg__boundary sp-arrangement-svg__boundary--main',
                'data-diagram-target': compact ? '' : 'mainAisle',
                tabindex: compact ? '-1' : '0',
                role: compact ? 'img' : 'button',
                'aria-label': mainAisleLabel(spec.circulation.mainAisle),
            });
            const vertical = {
                x: groupX(mainBoundaryIndex) + groupWidth,
                y: padding / 2,
                width: boundaryWidths[mainBoundaryIndex],
                height: height - padding,
            };
            const horizontal = {
                x: padding / 2,
                y: groupY(0) + groupHeight,
                width: width - padding,
                height: rowBoundaryHeight,
            };
            if (mainVertical && mainHorizontal && !compact) {
                appendCrossMainAisle(mainAisle, { vertical, horizontal, compact });
            } else if (mainVertical) {
                appendWalkwaySurface(mainAisle, {
                    ...vertical,
                    orientation: 'vertical',
                    compact,
                    isMain: true,
                    showIcon: true,
                });
            } else if (mainHorizontal && !compact) {
                appendWalkwaySurface(mainAisle, {
                    ...horizontal,
                    orientation: 'horizontal',
                    compact,
                    isMain: true,
                    showIcon: true,
                });
            }
            svg.appendChild(mainAisle);
        }

        for (let row = 0; row < rows; row++) {
            for (let groupIndex = 0; groupIndex < groupsPerRow; groupIndex++) {
                const x = groupX(groupIndex);
                const y = groupY(row);
                const group = svgElement('g', {
                    class: 'sp-arrangement-svg__group',
                    'data-diagram-target': compact ? '' : 'groupSize',
                    tabindex: compact ? '-1' : '0',
                    role: compact ? 'img' : 'button',
                    'aria-label': `${spec.groupSize} 人一组`,
                });
                group.appendChild(svgElement('rect', {
                    x,
                    y,
                    width: groupWidth,
                    height: groupHeight,
                    rx: compact ? 4 : 6,
                    class: 'sp-arrangement-svg__group-outline',
                }));
                for (let seat = 0; seat < spec.groupSize; seat++) {
                    const deskX = x + groupPad + seat * (deskWidth + deskGap);
                    group.appendChild(svgElement('rect', {
                        x: deskX,
                        y: y + groupPad,
                        width: deskWidth,
                        height: deskHeight,
                        rx: compact ? 3 : 4,
                        class: 'sp-arrangement-svg__desk',
                    }));
                    group.appendChild(svgElement('line', {
                        x1: deskX + (compact ? 4 : 5),
                        y1: y + groupPad + deskHeight - (compact ? 4 : 6),
                        x2: deskX + deskWidth - (compact ? 4 : 5),
                        y2: y + groupPad + deskHeight - (compact ? 4 : 6),
                        class: 'sp-arrangement-svg__desk-edge',
                    }));
                    group.appendChild(svgElement('rect', {
                        x: deskX + (deskWidth - chairWidth) / 2,
                        y: y + groupPad + deskHeight - chairOverlap,
                        width: chairWidth,
                        height: chairHeight,
                        rx: compact ? 2.5 : 4,
                        class: 'sp-arrangement-svg__chair',
                    }));
                }
                svg.appendChild(group);
            }
        }
        return svg;
    }

    renderArrangementFacts(specInput) {
        const facts = document.getElementById('sp-arrangement-rule-facts');
        if (!facts) return;
        facts.replaceChildren();
        const spec = normalizeRuleSpec(specInput);
        const rows = [
            ['每组人数', `${spec.groupSize} 人`],
            ['组间形式', boundaryLabel(spec.circulation.betweenGroups)],
            ['排间形式', boundaryLabel(spec.circulation.betweenRows)],
            ['主过道', mainAisleLabel(spec.circulation.mainAisle)],
        ];
        for (const [label, value] of rows) {
            const item = document.createElement('div');
            const name = document.createElement('span');
            const detail = document.createElement('strong');
            name.textContent = label;
            detail.textContent = value;
            item.append(name, detail);
            facts.appendChild(item);
        }
    }

    renderArrangementRecognition(recognition = this.recognizedArrangement) {
        const wrapper = document.getElementById('sp-arrangement-diagram');
        const status = document.getElementById('sp-arrangement-edit-status');
        if (!wrapper) return;
        wrapper.replaceChildren();
        if (!recognition?.arrangementSpec) {
            const empty = document.createElement('div');
            empty.className = 'sp-arrangement-diagram__empty';
            empty.textContent = '等待识别';
            wrapper.appendChild(empty);
            document.getElementById('sp-arrangement-rule-facts')?.replaceChildren();
            if (status) status.textContent = '尚未识别';
            this.updateArrangementDiagramControls();
            return;
        }
        wrapper.appendChild(this.buildArrangementSvg(recognition.arrangementSpec, { compact: true }));
        this.renderArrangementFacts(recognition.arrangementSpec);
        if (status) {
            status.textContent = this.arrangementRecognitionStale
                ? '要求已修改，请重新识别'
                : JSON.stringify(recognition.arrangementSpec) === JSON.stringify(recognition.originalArrangementSpec)
                    ? recognition.source === 'ai_rule_parser'
                        ? 'AI 识别完成'
                        : '本地规则解析'
                    : '已应用人工修改';
        }
        this.updateArrangementDiagramControls();
    }

    renderArrangementEditor() {
        const wrapper = document.getElementById('sp-arrangement-editor-diagram');
        const spec = this.arrangementEditorDraft?.arrangementSpec;
        if (!wrapper || !spec) return;
        wrapper.replaceChildren(this.buildArrangementSvg(spec));
        const facts = document.getElementById('sp-arrangement-editor-facts');
        if (facts) facts.textContent = '代表性示意：2 排 × 4 组，修改会应用到整个布局';
        this.updateArrangementEditorControls();
    }

    updateArrangementEditorControls() {
        const spec = this.arrangementEditorDraft?.arrangementSpec;
        if (!spec) return;
        document.querySelectorAll('[data-arrangement-mode]').forEach(button => {
            const target = button.dataset.target;
            const current = target === 'groupSize' ? String(spec.groupSize) : String(spec.circulation?.[target] || 'none');
            const active = current === button.dataset.arrangementMode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    updateArrangementDiagramControls() {
        const openEditor = document.getElementById('sp-arrangement-open-editor');
        if (openEditor) {
            openEditor.disabled = !this.recognizedArrangement?.arrangementSpec || this.arrangementRecognitionStale;
        }
        this.updateArrangementActionState?.();
    }

    openArrangementEditor() {
        if (!this.recognizedArrangement?.arrangementSpec || this.arrangementRecognitionStale) {
            return this.showToast('请先识别当前排座要求', 'warning');
        }
        this.arrangementEditorDraft = {
            arrangementSpec: structuredClone(this.recognizedArrangement.arrangementSpec),
        };
        const modal = document.getElementById('sp-arrangement-editor');
        modal?.classList.add('is-open');
        modal?.setAttribute('aria-hidden', 'false');
        document.body?.classList.add('sp-arrangement-editor-open');
        this.renderArrangementEditor();
        document.getElementById('sp-arrangement-editor-close')?.focus();
    }

    closeArrangementEditor() {
        const modal = document.getElementById('sp-arrangement-editor');
        modal?.classList.remove('is-open');
        modal?.setAttribute('aria-hidden', 'true');
        document.body?.classList.remove('sp-arrangement-editor-open');
        this.arrangementEditorDraft = null;
    }

    focusArrangementControl(target) {
        const control = document.querySelector(`.sp-arrangement-mode-group[data-control-target="${target}"]`)
            || document.querySelector(`[data-target="${target}"]`)?.closest('.sp-arrangement-mode-group');
        control?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        control?.classList.add('is-focused');
        setTimeout(() => control?.classList.remove('is-focused'), 700);
        control?.querySelector('button')?.focus();
    }

    setArrangementDiagramMode(target, value) {
        const spec = this.arrangementEditorDraft?.arrangementSpec;
        if (!spec || value == null) return;
        if (target === 'groupSize') {
            spec.groupSize = Math.min(4, Math.max(1, Number.parseInt(value, 10) || 1));
            spec.layoutMode = spec.groupSize > 1 ? 'grouped' : 'standard';
            spec.columnPattern = [];
            delete spec.customPattern;
        } else if (target === 'betweenGroups' || target === 'betweenRows') {
            spec.circulation[target] = value;
        } else if (target === 'mainAisle') {
            spec.circulation.mainAisle = value;
        }
        spec.groupGap = spec.circulation.betweenGroups === 'gap' ? 'normal' : 'none';
        spec.aislePolicy = {
            ...(spec.aislePolicy || {}),
            verticalBetweenGroups: spec.circulation.betweenGroups !== 'none',
            horizontalBetweenGroupRows: spec.circulation.betweenRows !== 'none',
            mainVertical: ['vertical', 'cross'].includes(spec.circulation.mainAisle),
            mainHorizontal: ['horizontal', 'cross'].includes(spec.circulation.mainAisle),
        };
        this.renderArrangementEditor();
    }

    restoreArrangementAiRecognition() {
        if (!this.arrangementEditorDraft || !this.recognizedArrangement?.originalArrangementSpec) return;
        this.arrangementEditorDraft.arrangementSpec = structuredClone(this.recognizedArrangement.originalArrangementSpec);
        this.renderArrangementEditor();
    }

    applyArrangementEditorDraft() {
        if (!this.arrangementEditorDraft?.arrangementSpec || !this.recognizedArrangement) return;
        this.recognizedArrangement.arrangementSpec = structuredClone(this.arrangementEditorDraft.arrangementSpec);
        this.diagramEdits = [];
        this.closeArrangementEditor();
        this.renderArrangementRecognition();
        this.updateLayoutRequirementSummary();
        this.showToast('排座规则修改已应用', 'success');
    }

    bindArrangementDiagramEvents() {
        const editor = document.getElementById('sp-arrangement-editor-diagram');
        const focusTarget = event => {
            const control = event.target.closest?.('[data-diagram-target]');
            if (!control || !control.dataset.diagramTarget) return;
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            this.focusArrangementControl(control.dataset.diagramTarget);
        };
        editor?.addEventListener('click', focusTarget);
        editor?.addEventListener('keydown', focusTarget);
        document.getElementById('sp-arrangement-open-editor')?.addEventListener('click', () => this.openArrangementEditor());
        document.getElementById('sp-arrangement-editor-close')?.addEventListener('click', () => this.closeArrangementEditor());
        document.getElementById('sp-arrangement-editor-cancel')?.addEventListener('click', () => this.closeArrangementEditor());
        document.getElementById('sp-arrangement-restore-ai')?.addEventListener('click', () => this.restoreArrangementAiRecognition());
        document.getElementById('sp-arrangement-apply')?.addEventListener('click', () => this.applyArrangementEditorDraft());
        document.getElementById('sp-arrangement-editor')?.addEventListener('click', event => {
            if (event.target?.matches?.('.sp-arrangement-editor__backdrop')) {
                this.closeArrangementEditor();
                return;
            }
            const mode = event.target.closest?.('[data-arrangement-mode]');
            if (mode) this.setArrangementDiagramMode(mode.dataset.target, mode.dataset.arrangementMode);
        });
    }

    handleArrangementPromptInput() {
        const prompt = this.getArrangePrompt();
        this.arrangementRecognitionStale = Boolean(this.recognizedArrangement)
            && prompt !== this.arrangementPromptSnapshot;
        this.updateLayoutRequirementSummary();
        this.renderArrangementRecognition();
    }

    async recognizeArrangementRequirements() {
        const prompt = this.getArrangePrompt();
        if (!prompt) return this.showToast('请先描述排座要求', 'warning');
        if (this._isGenerating) return;
        const button = document.getElementById('sp-parse-arrangement');
        const originalHtml = button?.innerHTML;
        this._isGenerating = true;
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 识别中...';
        }
        this.updateArrangementActionState();
        if (window.lucide) window.lucide.createIcons();
        try {
            this.recognizedArrangement = await this.requestLayoutSpec(prompt);
            this.arrangementPromptSnapshot = prompt;
            this.arrangementRecognitionStale = false;
            this.diagramEdits = [];
            this.renderArrangementRecognition();
            this.updateLayoutRequirementSummary();
            this.showArrangementWarnings?.(this.recognizedArrangement.warnings);
            if (this.recognizedArrangement.source === 'ai_rule_parser') {
                this.showToast('AI 排座规则识别完成', 'success');
            } else {
                this.showToast('AI 规则未采用，当前使用本地规则解析', 'warning');
            }
        } catch (error) {
            this.showToast(`规则识别失败: ${error.message}`, 'error');
        } finally {
            this._isGenerating = false;
            if (button) button.innerHTML = originalHtml || '<i data-lucide="scan-search"></i> 识别排座要求';
            this.updateArrangementActionState();
            if (window.lucide) window.lucide.createIcons();
        }
    }

    clearArrangementRecognition() {
        this.recognizedArrangement = null;
        this.arrangementPromptSnapshot = '';
        this.arrangementRecognitionStale = false;
        this.arrangementEditorDraft = null;
        this.diagramEdits = [];
        this.renderArrangementRecognition(null);
        this.updateLayoutRequirementSummary();
    }
}

export const seatingArrangementDiagramMethods = Object.fromEntries(
    Object.getOwnPropertyNames(SeatingArrangementDiagramPanelMethods.prototype)
        .filter(name => name !== 'constructor')
        .map(name => [name, SeatingArrangementDiagramPanelMethods.prototype[name]])
);
