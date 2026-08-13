const SVG_NS = 'http://www.w3.org/2000/svg';

function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
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
        const groupsPerRow = 3;
        const deskWidth = compact ? 20 : 30;
        const deskHeight = compact ? 20 : 28;
        const deskGap = compact ? 3 : 5;
        const groupPad = compact ? 5 : 8;
        const groupWidth = spec.groupSize * deskWidth + Math.max(0, spec.groupSize - 1) * deskGap + groupPad * 2;
        const groupHeight = deskHeight + groupPad * 2;
        const normalGap = compact ? 9 : 15;
        const walkwayGap = compact ? 38 : 62;
        const boundaryWidth = spec.circulation.betweenGroups === 'walkway'
            ? walkwayGap
            : spec.circulation.betweenGroups === 'gap'
                ? normalGap
                : compact ? 4 : 7;
        const rowBoundaryHeight = spec.circulation.betweenRows === 'walkway'
            ? (compact ? 0 : 48)
            : spec.circulation.betweenRows === 'gap'
                ? (compact ? 0 : 15)
                : (compact ? 0 : 7);
        const padding = compact ? 8 : 24;
        const width = padding * 2 + groupsPerRow * groupWidth + (groupsPerRow - 1) * boundaryWidth;
        const height = padding * 2 + rows * groupHeight + Math.max(0, rows - 1) * rowBoundaryHeight;
        const svg = svgElement('svg', {
            viewBox: `0 0 ${width} ${height}`,
            role: 'img',
            'aria-label': compact ? '三组排座规则示意图' : '两排三组排座规则编辑示意图',
        });
        svg.classList.add('sp-arrangement-svg', compact ? 'sp-arrangement-svg--compact' : 'sp-arrangement-svg--editor');

        const mainVertical = ['vertical', 'cross'].includes(spec.circulation.mainAisle);
        const mainHorizontal = ['horizontal', 'cross'].includes(spec.circulation.mainAisle);
        const groupX = groupIndex => padding + groupIndex * (groupWidth + boundaryWidth);
        const groupY = rowIndex => padding + rowIndex * (groupHeight + rowBoundaryHeight);

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
                    if (!compact) {
                        group.appendChild(svgElement('line', {
                            x1: deskX + 5,
                            y1: y + groupPad + deskHeight - 6,
                            x2: deskX + deskWidth - 5,
                            y2: y + groupPad + deskHeight - 6,
                            class: 'sp-arrangement-svg__desk-edge',
                        }));
                    }
                }
                svg.appendChild(group);

                if (groupIndex >= groupsPerRow - 1) continue;
                const boundaryX = x + groupWidth;
                const isMainBoundary = mainVertical && groupIndex === 1;
                const boundaryMode = isMainBoundary ? 'walkway' : spec.circulation.betweenGroups;
                const boundary = svgElement('g', {
                    class: `sp-arrangement-svg__boundary sp-arrangement-svg__boundary--${boundaryMode}`,
                    'data-diagram-target': compact ? '' : (isMainBoundary ? 'mainAisle' : 'betweenGroups'),
                    tabindex: compact ? '-1' : '0',
                    role: compact ? 'img' : 'button',
                    'aria-label': isMainBoundary ? mainAisleLabel(spec.circulation.mainAisle) : boundaryLabel(boundaryMode),
                });
                if (boundaryMode === 'walkway') {
                    boundary.appendChild(svgElement('line', {
                        x1: boundaryX + 7,
                        y1: y + groupHeight / 2,
                        x2: boundaryX + boundaryWidth - 7,
                        y2: y + groupHeight / 2,
                        class: 'sp-arrangement-svg__walkway-arrow',
                    }));
                    boundary.appendChild(svgElement('path', {
                        d: `M ${boundaryX + 7} ${y + groupHeight / 2} l 6 -4 v 8 z M ${boundaryX + boundaryWidth - 7} ${y + groupHeight / 2} l -6 -4 v 8 z`,
                        class: 'sp-arrangement-svg__walkway-arrowhead',
                    }));
                    if (boundaryWidth >= 36) {
                        const label = svgElement('text', {
                            x: boundaryX + boundaryWidth / 2,
                            y: y + groupHeight / 2 - 7,
                            class: 'sp-arrangement-svg__walkway-label',
                            'text-anchor': 'middle',
                        });
                        label.textContent = '过道';
                        boundary.appendChild(label);
                    }
                } else if (boundaryMode === 'gap') {
                    boundary.appendChild(svgElement('line', {
                        x1: boundaryX + boundaryWidth / 2,
                        y1: y + 8,
                        x2: boundaryX + boundaryWidth / 2,
                        y2: y + groupHeight - 8,
                        class: 'sp-arrangement-svg__gap-mark',
                    }));
                }
                svg.appendChild(boundary);
            }
        }

        if (!compact && rows > 1) {
            const boundaryY = groupY(0) + groupHeight;
            const isMainBoundary = mainHorizontal;
            const boundaryMode = isMainBoundary ? 'walkway' : spec.circulation.betweenRows;
            const boundary = svgElement('g', {
                class: `sp-arrangement-svg__boundary sp-arrangement-svg__boundary--${boundaryMode}`,
                'data-diagram-target': isMainBoundary ? 'mainAisle' : 'betweenRows',
                tabindex: '0',
                role: 'button',
                'aria-label': isMainBoundary ? mainAisleLabel(spec.circulation.mainAisle) : boundaryLabel(boundaryMode),
            });
            if (boundaryMode === 'walkway') {
                boundary.appendChild(svgElement('line', {
                    x1: padding + width * 0.25,
                    y1: boundaryY + rowBoundaryHeight / 2,
                    x2: width - padding - width * 0.25,
                    y2: boundaryY + rowBoundaryHeight / 2,
                    class: 'sp-arrangement-svg__walkway-arrow',
                }));
                const label = svgElement('text', {
                    x: width / 2,
                    y: boundaryY + rowBoundaryHeight / 2 - 8,
                    class: 'sp-arrangement-svg__walkway-label',
                    'text-anchor': 'middle',
                });
                label.textContent = '过道';
                boundary.appendChild(label);
            } else if (boundaryMode === 'gap') {
                boundary.appendChild(svgElement('line', {
                    x1: padding + 12,
                    y1: boundaryY + rowBoundaryHeight / 2,
                    x2: width - padding - 12,
                    y2: boundaryY + rowBoundaryHeight / 2,
                    class: 'sp-arrangement-svg__gap-mark',
                }));
            }
            svg.appendChild(boundary);
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
        if (facts) facts.textContent = '代表性示意：2 排 × 3 组，修改会应用到整个布局';
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
