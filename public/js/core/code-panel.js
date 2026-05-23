/**
 * Code Panel Module
 * 处理 Manim 代码显示、编辑和 AI 修改建议
 */
export class CodePanel {
    constructor() {
        this.codeVideoMap = new Map();
        this.videoUrlMap = new Map();
        this.sceneManifestMap = new Map();
        this.studioFrameSetMap = new Map();
        this.videoHistoryMap = new Map(); // [Manim Port] History State
        this.monacoEditor = null;
        this.currentCode = '';
        this.currentVideoId = null; // Track current video
        this.currentSceneManifest = null;
        this.runtimeSceneManifest = null;
        this.currentStudioFrameSet = null;
        this.selectedStudioFrameId = null;
        this.studioRevision = 0;
        this.manualStudioObjects = [];
        this.isManualSelectionMode = false;
        this.studioPointerState = null;
        this.selectedSceneObject = null;
        this.selectedSceneObjects = new Map();
        this.canvasEditState = this.createCanvasEditState();
        this.sceneObjectPickerState = null;
        this.sceneObjectHoverPreviewState = null;
        this.detectedSceneRegions = [];
        this.sceneHitTargets = [];
        this.sceneCollisionGroups = [];
        this.studioCanvasBridge = null;
        this.studioCanvasRoot = null;
        this.useReactStudioCanvas = true;
        this.abortController = null; // [Stop Button] Track active request
        this.suggestionController = null;
        this.studioReportEl = null;
        this.elements = {
            panel: document.getElementById('code-panel'),
            overlay: document.getElementById('code-panel-overlay'),
            closeBtn: document.getElementById('code-close-btn'),
            renderBtn: document.getElementById('code-render-btn'),
            // Mobile AI input/button
            aiInput: document.getElementById('ai-instruction-input'),
            aiBtn: document.getElementById('ai-modify-btn'),
            // Desktop AI input/button
            aiInputDesktop: document.getElementById('ai-instruction-input-desktop'),
            aiBtnDesktop: document.getElementById('ai-modify-btn-desktop'),
            previewPanel: document.getElementById('video-preview-container'),
            referenceVideo: document.getElementById('studio-video-reference-container'),
            frameStrip: document.getElementById('studio-frame-strip'),
            calibrationWrap: document.getElementById('studio-calibration-frame-wrap'),
            videoPreview: document.getElementById('video-inner-container'),
            interactionOverlay: document.getElementById('studio-interaction-overlay'),
            objectInspector: document.getElementById('studio-object-inspector'),
            monacoContainer: document.getElementById('monaco-container'),
            mobileTabs: document.querySelectorAll('.mobile-tab-btn'),
            mobileCodeView: document.querySelector('.mobile-code-view'),
            // New mobile panel tabs
            mobilePanelTabs: document.querySelectorAll('.mobile-panel-tab'),
            mobilePreviewTab: document.getElementById('mobile-preview-tab'),
            mobileCodeTab: document.getElementById('mobile-code-tab')
        };

        this.init();
    }

    init() {
        if (!this.elements.panel) return;

        // Bind events
        this.elements.closeBtn?.addEventListener('click', () => this.close());
        this.elements.overlay?.addEventListener('click', () => this.close());

        // Render
        this.elements.renderBtn?.addEventListener('click', () => this.renderCode());

        // AI Modification (Mobile)
        this.elements.aiBtn?.addEventListener('click', () => this.requestAIModification());
        this.elements.aiInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.requestAIModification();
        });

        // AI Modification (Desktop) - sync both inputs
        this.elements.aiBtnDesktop?.addEventListener('click', () => this.requestAIModification(true));
        this.elements.aiInputDesktop?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.requestAIModification(true);
        });

        this.elements.panel?.querySelector('.studio-manual-selection')?.addEventListener('click', () => this.enableManualSelectionMode());
        this.elements.panel?.querySelector('.studio-apply-layout-btn')?.addEventListener('click', () => this.applySelectedLayoutCalibration());
        document.addEventListener('keydown', event => this.handleStudioKeydown(event));
        document.addEventListener('pointerdown', event => this.handleStudioGlobalPointerDown(event));

        // Legacy Mobile Tabs
        this.elements.mobileTabs.forEach(btn => {
            btn.addEventListener('click', () => this.switchMobileTab(btn.dataset.tab));
        });

        // [NEW] Mobile Panel Tabs (Preview/Code)
        this.initMobilePanelTabs();

        // [Manim Pro Max] Mobile Video Collapse - REMOVED for new tab layout
        // Now handled via tab switching

        // Initialize Monaco
        if (window.monacoReady) {
            window.monacoReady.then(() => this.initMonaco());
        }
    }

    createCanvasEditState() {
        return {
            selectedObjectIds: [],
            manualRegions: [],
            pendingObjectEdits: new Map(),
            pendingNewObjects: [],
            pendingDeletes: new Set(),
            objectBoxOverrides: new Map(),
            naturalLanguageCommand: '',
            baseFrameId: '',
            baseTime: 0,
            tool: 'select',
            displayMode: 'clean',
        };
    }

    resetCanvasEditState(options = {}) {
        const keepTool = options.keepTool ? this.canvasEditState?.tool : null;
        this.canvasEditState = this.createCanvasEditState();
        if (keepTool) this.canvasEditState.tool = keepTool;
    }

    shouldUseReactStudioCanvas() {
        return Boolean(
            this.useReactStudioCanvas &&
            this.elements.videoPreview &&
            window.ManimStudioCanvas &&
            typeof window.ManimStudioCanvas.mount === 'function'
        );
    }

    ensureReactStudioCanvas() {
        if (!this.shouldUseReactStudioCanvas()) return false;
        const container = this.elements.videoPreview;
        if (!container) return false;

        container.classList.add('has-react-studio-canvas');
        this.elements.panel?.classList.add('react-studio-canvas-active');
        this.elements.calibrationWrap?.classList.add('has-react-studio-canvas');
        if (!this.studioCanvasRoot || this.studioCanvasRoot.parentElement !== container) {
            if (this.studioCanvasBridge?.unmount) {
                this.studioCanvasBridge.unmount();
            }
            this.studioCanvasBridge = null;
            this.studioCanvasRoot = document.createElement('div');
            this.studioCanvasRoot.id = 'studio-konva-root';
            this.studioCanvasRoot.className = 'studio-konva-root';
            container.appendChild(this.studioCanvasRoot);
        }

        if (this.elements.interactionOverlay) {
            this.elements.interactionOverlay.classList.add('hidden');
            this.elements.interactionOverlay.innerHTML = '';
        }
        if (this.elements.objectInspector) {
            this.elements.objectInspector.classList.add('hidden');
            this.elements.objectInspector.innerHTML = '';
        }

        if (!this.studioCanvasBridge) {
            this.studioCanvasBridge = window.ManimStudioCanvas.mount(this.studioCanvasRoot, this.getReactStudioCanvasProps());
        }
        return true;
    }

    getReactStudioCanvasProps() {
        return {
            studioRevision: this.studioRevision || 0,
            manifest: this.runtimeSceneManifest || this.currentSceneManifest || null,
            frameSet: this.currentStudioFrameSet || null,
            selectedFrameId: this.selectedStudioFrameId || '',
            recommendedFrameId: this.currentStudioFrameSet?.recommendedFrameId || '',
            videoUrl: this.latestVideoUrl || '',
            theme: document.body.classList.contains('light-mode') ? 'light' : 'dark',
            onFrameChange: (frameId) => this.handleReactStudioFrameChange(frameId),
            onDraftChange: (editState) => this.handleReactStudioDraftChange(editState),
            onSelectionChange: (selection) => this.handleReactStudioSelectionChange(selection),
            onApply: (editState) => this.handleReactStudioApply(editState),
        };
    }

    syncReactStudioCanvas() {
        if (!this.ensureReactStudioCanvas()) {
            this.elements.panel?.classList.remove('react-studio-canvas-active');
            this.elements.calibrationWrap?.classList.remove('has-react-studio-canvas');
            this.elements.videoPreview?.classList.remove('has-react-studio-canvas');
            return false;
        }
        this.studioCanvasBridge?.update?.(this.getReactStudioCanvasProps());
        return true;
    }

    stripStudioCacheParam(url = '') {
        const value = String(url || '');
        if (!value) return '';
        try {
            const parsed = new URL(value, window.location.origin);
            parsed.searchParams.delete('studioRev');
            parsed.searchParams.delete('_studioRev');
            const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
            return value.startsWith('http') ? parsed.toString() : path;
        } catch (_) {
            return value.replace(/([?&])(?:_?studioRev)=[^&#]*(&?)/g, (match, prefix, suffix) => (prefix === '?' && suffix ? '?' : suffix ? prefix : ''));
        }
    }

    withStudioCacheBust(url = '', revision = this.studioRevision) {
        const base = this.stripStudioCacheParam(url);
        if (!base) return '';
        const separator = base.includes('?') ? '&' : '?';
        return `${base}${separator}studioRev=${encodeURIComponent(String(revision || 0))}`;
    }

    normalizeStudioFrameSetForRevision(frameSet, revision = this.studioRevision) {
        if (!frameSet || !Array.isArray(frameSet.frames)) return null;
        const frames = frameSet.frames.map(frame => {
            const rawImageUrl = frame.rawImageUrl || this.stripStudioCacheParam(frame.imageUrl || frame.url || '');
            const imageUrl = rawImageUrl ? this.withStudioCacheBust(rawImageUrl, revision) : '';
            return {
                ...frame,
                rawImageUrl,
                imageUrl,
                url: imageUrl || frame.url || '',
                _imageLoadFailed: false,
                imageAvailable: frame.imageAvailable !== false,
            };
        });
        const recommendedFrameId = frameSet.recommendedFrameId || frames[0]?.frameId || '';
        return {
            ...frameSet,
            frames,
            recommendedFrameId,
        };
    }

    handleReactStudioFrameChange(frameId) {
        if (frameId && String(frameId) !== String(this.selectedStudioFrameId || '')) {
            this.selectedStudioFrameId = frameId;
            this.renderStudioFrameStrip();
        }
    }

    handleReactStudioDraftChange(editState = {}) {
        this.canvasEditState = this.convertReactStudioCanvasState(editState);
        this.manualStudioObjects = this.canvasEditState.manualRegions || [];
        this.hydrateSelectedSceneObjects(editState);
    }

    handleReactStudioSelectionChange(selection = {}) {
        this.hydrateSelectedSceneObjects(selection);
    }

    async handleReactStudioApply(editState = {}) {
        this.handleReactStudioDraftChange(editState);
        const command = String(editState.naturalLanguageCommand || editState.naturalLanguageEdit?.command || '').trim();
        await this.applyScenePatch({
            operation: command ? 'natural_language_edit' : 'layout_calibrate',
            objectId: editState.selectedObjectIds?.[0] || '',
            command,
        });
    }

    convertReactStudioCanvasState(editState = {}) {
        const next = this.createCanvasEditState();
        next.selectedObjectIds = Array.isArray(editState.selectedObjectIds) ? editState.selectedObjectIds.map(String) : [];
        next.pendingObjectEdits = new Map(
            (editState.objectEdits || editState.pendingObjectEdits || [])
                .map(edit => [String(edit.objectId || ''), edit])
                .filter(([id]) => Boolean(id))
        );
        next.pendingNewObjects = Array.isArray(editState.newObjects)
            ? editState.newObjects
            : (Array.isArray(editState.pendingNewObjects) ? editState.pendingNewObjects : []);
        next.pendingDeletes = new Set(editState.deletedObjectIds || editState.pendingDeletes || []);
        next.manualRegions = Array.isArray(editState.manualReferenceRegions)
            ? editState.manualReferenceRegions
            : (Array.isArray(editState.manualRegions) ? editState.manualRegions : []);
        next.objectBoxOverrides = new Map(
            (editState.objectBoxOverrides || [])
                .map(item => [String(item.objectId || ''), item.normalizedBBox || item.bbox])
                .filter(([id, box]) => Boolean(id) && Boolean(box))
        );
        next.naturalLanguageCommand = String(editState.naturalLanguageCommand || editState.naturalLanguageEdit?.command || '');
        next.baseFrameId = editState.baseFrameId || editState.naturalLanguageEdit?.baseFrameId || this.selectedStudioFrameId || '';
        next.baseTime = Number(editState.baseTime || editState.naturalLanguageEdit?.baseTime || 0);
        next.tool = editState.tool || 'select';
        return next;
    }

    hydrateSelectedSceneObjects(selection = {}) {
        const ids = Array.isArray(selection.selectedObjectIds) ? selection.selectedObjectIds.map(String) : [];
        const snapshots = new Map(
            (selection.selectedObjects || selection.selectedObjectSnapshots || [])
                .map(item => [String(item?.id || ''), item])
                .filter(([id]) => Boolean(id))
        );
        const nextSelection = new Map();
        ids.forEach(id => {
            const object = this.findStudioObjectById(id) || snapshots.get(id);
            if (object) nextSelection.set(id, object);
        });
        this.selectedSceneObjects = nextSelection;
        this.selectedSceneObject = nextSelection.values().next().value || null;
    }

    findStudioObjectById(id) {
        const objectId = String(id || '');
        if (!objectId) return null;
        const manifestObject = this.getAllSelectableSceneObjects().find(item => String(item.id || '') === objectId);
        if (manifestObject) return manifestObject;
        const manualObject = (this.manualStudioObjects || []).find(item => String(item.id || '') === objectId);
        if (manualObject) return manualObject;
        const newObject = (this.canvasEditState?.pendingNewObjects || []).find(item => String(item.id || '') === objectId);
        return newObject || null;
    }

    getCanvasTool() {
        return this.canvasEditState?.tool || 'select';
    }

    normalizeCanvasTool(tool = 'select') {
        const normalized = String(tool || 'select').trim();
        const aliases = {
            box: 'box-select',
            box_select: 'box-select',
            marquee: 'box-select',
            draw: 'manual',
            draw_region: 'manual',
            'draw-region': 'manual',
            region: 'manual',
            addText: 'add_text',
            addFormula: 'add_formula',
            addArrow: 'add_arrow',
        };
        return aliases[normalized] || normalized || 'select';
    }

    isStudioDebugMode() {
        try {
            return window.localStorage?.getItem('icecream_manim_debug') === '1';
        } catch (error) {
            return false;
        }
    }

    setCanvasTool(tool = 'select') {
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        const normalizedTool = this.normalizeCanvasTool(tool);
        this.canvasEditState.tool = normalizedTool;
        this.isManualSelectionMode = normalizedTool === 'manual';
        this.ensureInteractionOverlay()?.classList.toggle('is-manual-drawing', this.isManualSelectionMode);
        this.renderSceneOverlay();
        this.renderObjectInspector();
    }

    hasPendingCanvasEdits() {
        const state = this.canvasEditState || {};
        return Boolean(
            state.pendingObjectEdits?.size ||
            state.pendingNewObjects?.length ||
            state.pendingDeletes?.size ||
            state.objectBoxOverrides?.size ||
            state.manualRegions?.length ||
            String(state.naturalLanguageCommand || '').trim()
        );
    }

    updateCanvasSelectionState() {
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        const frame = this.getSelectedStudioFrame();
        this.canvasEditState.selectedObjectIds = this.getSelectedSceneObjects().map(item => String(item.id || '')).filter(Boolean);
        this.canvasEditState.baseFrameId = frame?.frameId || this.selectedStudioFrameId || '';
        this.canvasEditState.baseTime = Number(frame?.time || 0);
    }

    recordCanvasObjectEdit(object, operation = 'layout_calibrate') {
        if (!object?.id) return;
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        const objectId = String(object.id || '');
        if (objectId.startsWith('manual_')) {
            this.canvasEditState.manualRegions = this.getManualReferenceRegions();
            return;
        }
        if (object.isNewObject || objectId.startsWith('new_')) {
            const index = this.canvasEditState.pendingNewObjects.findIndex(item => String(item.id || '') === objectId);
            if (index >= 0) this.canvasEditState.pendingNewObjects[index] = object;
            return;
        }
        const frame = this.getSelectedStudioFrame();
        const sourceBBox = this.normalizeStudioBox(object._studioOriginalBBox || this.getSceneObjectBoxForCurrentTime(object, 0, 1));
        const normalizedBBox = this.normalizeStudioBox(this.getEditedSceneObjectBox(object, 0, 1));
        const eps = 0.002;
        if (Math.abs(sourceBBox.x - normalizedBBox.x) < eps &&
            Math.abs(sourceBBox.y - normalizedBBox.y) < eps &&
            Math.abs(sourceBBox.width - normalizedBBox.width) < eps &&
            Math.abs(sourceBBox.height - normalizedBBox.height) < eps) {
            if (this.isStudioDebugMode()) console.warn('[Studio] recordCanvasObjectEdit: sourceBBox === normalizedBBox for', objectId, sourceBBox);
            return;
        }
        this.canvasEditState.pendingObjectEdits.set(objectId, {
            operation,
            objectId,
            sourceBBox,
            normalizedBBox,
            baseFrameId: frame?.frameId || this.selectedStudioFrameId || '',
            baseTime: Number(frame?.time || 0),
        });
    }

    deleteSelectedStudioObjects() {
        const selected = this.getSelectedSceneObjects();
        if (!selected.length) {
            this.renderObjectInspector('请先选择要删除的对象。');
            return;
        }
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        selected.forEach(object => {
            const objectId = String(object.id || '');
            if (!objectId) return;
            if (objectId.startsWith('manual_')) {
                this.manualStudioObjects = this.manualStudioObjects.filter(item => String(item.id || '') !== objectId);
                return;
            }
            if (object.isNewObject || objectId.startsWith('new_')) {
                this.canvasEditState.pendingNewObjects = this.canvasEditState.pendingNewObjects
                    .filter(item => String(item.id || '') !== objectId);
                return;
            }
            this.canvasEditState.pendingDeletes.add(objectId);
        });
        this.canvasEditState.manualRegions = this.getManualReferenceRegions();
        this.clearSceneSelection({ silent: true });
        this.renderSceneOverlay();
        this.renderObjectInspector('已在校准画布中隐藏选中对象。点击“应用到整段动画”后会重构视频。');
    }

    createCanvasNewObject(kind = 'text', point = { x: 0.5, y: 0.5 }) {
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        const frame = this.getSelectedStudioFrame();
        const normalizedPoint = {
            x: Math.max(0.04, Math.min(0.96, Number(point?.x || 0.5))),
            y: Math.max(0.04, Math.min(0.96, Number(point?.y || 0.5))),
        };
        const presets = {
            text: { label: '新增文字', type: 'Text', role: 'text', width: 0.24, height: 0.07, text: '新增文字' },
            formula: { label: '新增公式', type: 'MathTex', role: 'formula', width: 0.20, height: 0.07, text: 'x' },
            arrow: { label: '新增箭头', type: 'Arrow', role: 'connector', width: 0.26, height: 0.06, text: '' },
        };
        const preset = presets[kind] || presets.text;
        const bbox = this.normalizeStudioBox({
            x: normalizedPoint.x - preset.width / 2,
            y: normalizedPoint.y - preset.height / 2,
            width: preset.width,
            height: preset.height,
        });
        const object = {
            id: `new_${kind}_${Date.now()}`,
            type: preset.type,
            publicType: preset.type,
            role: preset.role,
            label: preset.label,
            text: preset.text,
            bbox,
            bboxes: [{ frameId: frame?.frameId || this.selectedStudioFrameId || 'new', bbox }],
            editable: ['move', 'scale', 'delete', 'replace_text', 'set_color'],
            isNewObject: true,
            kind,
            _studioOriginalBBox: bbox,
        };
        this.canvasEditState.pendingNewObjects = [...this.canvasEditState.pendingNewObjects, object];
        this.selectSceneObjects([object], { silent: true });
        this.renderSceneOverlay();
        this.renderObjectInspector(`已添加${preset.label}占位对象。可拖动位置，也可以用自然语言修改内容。`);
        return object;
    }

    renderCanvasTooling() {
        const tool = this.getCanvasTool();
        const hasSelection = this.getSelectedSceneObjects().length > 0;
        const canApply = this.hasPendingCanvasEdits() || hasSelection;
        const button = (id, label) => `
            <button type="button" class="${tool === id ? 'active' : ''}" data-studio-canvas-tool="${id}">${label}</button>
        `;
        return `
            <div class="studio-canvas-tooling" aria-label="静态画布工具">
                ${button('select', '选择')}
                ${button('box-select', '框选')}
                ${button('manual', '手动画框')}
                <button type="button" class="${tool === 'add_text' ? 'active' : ''}" data-studio-add-object="text">添加文字</button>
                <button type="button" class="${tool === 'add_formula' ? 'active' : ''}" data-studio-add-object="formula">添加公式</button>
                <button type="button" class="${tool === 'add_arrow' ? 'active' : ''}" data-studio-add-object="arrow">添加箭头</button>
                <button type="button" data-studio-delete-selected ${hasSelection ? '' : 'disabled'}>删除</button>
                <button type="button" class="primary" data-studio-apply-layout ${canApply ? '' : 'disabled'}>应用到整段动画</button>
            </div>
        `;
    }

    bindCanvasToolingEvents(overlay) {
        if (!overlay) return;
        const toolbar = overlay.querySelector('.studio-canvas-tooling');
        toolbar?.addEventListener('pointerdown', event => event.stopPropagation());
        toolbar?.addEventListener('click', event => event.stopPropagation());
        toolbar?.querySelectorAll('[data-studio-canvas-tool]').forEach(btn => {
            btn.addEventListener('click', () => this.setCanvasTool(btn.dataset.studioCanvasTool || 'select'));
        });
        toolbar?.querySelectorAll('[data-studio-add-object]').forEach(btn => {
            btn.addEventListener('click', () => this.setCanvasTool(`add_${btn.dataset.studioAddObject || 'text'}`));
        });
        toolbar?.querySelector('[data-studio-delete-selected]')?.addEventListener('click', () => this.deleteSelectedStudioObjects());
        toolbar?.querySelector('[data-studio-apply-layout]')?.addEventListener('click', () => this.applySelectedLayoutCalibration());
    }

    /**
     * Initialize mobile panel tab switching (Preview / Code)
     */
    initMobilePanelTabs() {
        const tabs = this.elements.mobilePanelTabs;
        const previewTab = this.elements.mobilePreviewTab;
        const codeTab = this.elements.mobileCodeTab;

        if (!tabs.length || !previewTab || !codeTab) return;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Update active state on tabs
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const target = tab.dataset.tab;

                if (target === 'preview') {
                    previewTab.classList.remove('hidden');
                    codeTab.classList.remove('active');
                } else {
                    previewTab.classList.add('hidden');
                    codeTab.classList.add('active');
                    // Resize Monaco after tab switch
                    setTimeout(() => this.monacoEditor?.layout(), 50);
                }

                // Re-init Lucide icons for new content
                if (window.lucide) lucide.createIcons();
            });
        });
    }

    // ... initMonaco ...

    // ... open/close ...

    /**
     * 注册视频数据
     */
    registerVideo(videoId, code, videoUrl, sceneManifest = null) {
        if (code) this.codeVideoMap.set(videoId, code);
        if (videoUrl) this.videoUrlMap.set(videoId, videoUrl);
        if (sceneManifest) this.registerSceneManifest(videoId, sceneManifest);
    }

    registerSceneManifest(videoId, sceneManifest) {
        if (!videoId || !sceneManifest) return;
        const manifest = sceneManifest.runtimeSceneManifest || sceneManifest.sceneManifest || sceneManifest;
        this.sceneManifestMap.set(videoId, manifest);
        const studioFrameSet = sceneManifest.studioFrameSet || sceneManifest.agentTrace?.studioFrameSet || null;
        if (studioFrameSet) {
            this.studioFrameSetMap.set(videoId, {
                ...studioFrameSet,
                recommendedFrameId: sceneManifest.recommendedFrameId || studioFrameSet.recommendedFrameId,
            });
        }
    }

    /**
     * AI 代码修改请求
     * @param {boolean} fromDesktop - If true, use desktop input instead of mobile
     */
    async requestAIModification(fromDesktop = false) {
        // [Stop Button] Check if already running -> ABORT
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            this.stopProgressSimulation(); // Stop animation
            return;
        }

        // Select correct input based on context
        const input = fromDesktop ? this.elements.aiInputDesktop : this.elements.aiInput;
        const btn = fromDesktop ? this.elements.aiBtnDesktop : this.elements.aiBtn;
        if (!input) return;

        const prompt = input.value.trim();
        if (!prompt) return;

        // Init AbortController
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        // UI Loading -> Stop Button
        input.disabled = true;
        const orgPlaceholder = input.placeholder;
        input.placeholder = "✨ AI 正在思考 (点击停止)...";
        input.value = "";

        // Button Loading -> Stop Style with Progress Icon
        // Apply to BOTH mobile and desktop buttons
        const targetBtn = fromDesktop ? this.elements.aiBtnDesktop : this.elements.aiBtn;
        if (targetBtn) {
            targetBtn.innerHTML = `
                <div class="progress-stop-icon">
                    <div class="progress-fill" id="btn-progress-fill" style="height: 0%;"></div>
                </div>
                停止
            `;
            targetBtn.classList.add('btn-stop');
            targetBtn.disabled = false;
        }

        // Re-init icons
        if (window.lucide) lucide.createIcons();

        // Start Simulated Progress
        this.startProgressSimulation();

        try {
            const currentCode = this.monacoEditor ? this.monacoEditor.getValue() : this.currentCode;

            const data = await this.runManimAgentModification(prompt, currentCode, signal);

            if (data.success && data.code) {
                // [Fix] Strip Markdown
                let cleanCode = data.code;
                cleanCode = cleanCode.replace(/^```(?:python)?\s*/i, "");
                cleanCode = cleanCode.replace(/\s*```$/, "");

                this.renderStudioPatchReport(data, currentCode, cleanCode);

                if (this.monacoEditor) {
                    this.monacoEditor.setValue(cleanCode);
                }

                this.pendingHistoryDescription = prompt;
                this.renderCode(cleanCode);
            } else if (data.clarification) {
                const options = Array.isArray(data.clarification.options)
                    ? `\n\n可选方向：${data.clarification.options.join(' / ')}`
                    : '';
                alert(`${data.clarification.question || '请补充动画修改目标'}${options}`);
            } else {
                console.error('AI Mod Failed:', data);
                this.renderStudioPatchReport(data, currentCode, currentCode, true);
                alert('AI 生成失败: ' + (data.error || 'Unknown error'));
            }

        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('🛑 Request cancelled by user');
            } else {
                console.error('AI Network Error:', err);
                alert('网络错误，请重试');
            }
        } finally {
            // Finish Progress (Jump to 100% then reset)
            await this.finishProgressSimulation();

            // Restore UI - handle BOTH mobile and desktop buttons
            this.abortController = null;
            input.disabled = false;
            input.placeholder = orgPlaceholder;
            const targetBtn = fromDesktop ? this.elements.aiBtnDesktop : this.elements.aiBtn;
            if (targetBtn) {
                targetBtn.innerHTML = '<i data-lucide="sparkles"></i> 生成';
                targetBtn.disabled = false;
                targetBtn.classList.remove('btn-stop');
                targetBtn.style.cssText = '';
                targetBtn.style.backgroundColor = '';
                targetBtn.style.borderColor = '';
                lucide.createIcons();
            }
            input.focus();
        }
    }

    async runManimAgentModification(prompt, currentCode, signal) {
        const clientId = localStorage.getItem('icecream_client_id') || 'code_panel';
        const response = await fetch('/api/manim/agent/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: prompt,
                mode: 'modify',
                currentCode,
                clientId
            }),
            signal
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || 'Manim Agent 修改失败');
        }

        let latestCode = '';
        let result = null;
        let patchPlan = null;

        await this.readAgentNdjson(response, (event) => {
            if (event.type === 'code') {
                latestCode = event.code || latestCode;
            } else if (event.type === 'code_delta') {
                latestCode = event.code || `${latestCode}${event.delta || ''}`;
            } else if (event.type === 'patch_plan') {
                patchPlan = event.patchPlan;
            } else if (event.type === 'result' || event.type === 'clarification') {
                result = event;
            } else if (event.type === 'error') {
                if (!event.recoverable) {
                    throw new Error(event.error || 'Manim Agent 修改失败');
                }
            }
        });

        if (result && !result.code && latestCode) {
            result.code = latestCode;
        }
        if (result && patchPlan) {
            result.agentTrace = {
                ...(result.agentTrace || {}),
                patchPlan,
            };
        }

        return result || { success: false, error: 'Manim Agent 没有返回修改结果' };
    }

    ensureStudioReport() {
        if (this.studioReportEl && document.body.contains(this.studioReportEl)) {
            return this.studioReportEl;
        }
        const editorPane = this.elements.panel?.querySelector('.panel-editor') || this.elements.panel?.querySelector('.code-panel-body');
        if (!editorPane) return null;
        this.studioReportEl = document.createElement('div');
        this.studioReportEl.className = 'code-panel-studio-report hidden';
        editorPane.prepend(this.studioReportEl);
        return this.studioReportEl;
    }

    renderStudioPatchReport(result, beforeCode, afterCode, failed = false) {
        const report = this.ensureStudioReport();
        if (!report) return;

        const trace = result?.agentTrace || {};
        const patchPlan = trace.patchPlan || {};
        const operations = Array.isArray(patchPlan.operations) ? patchPlan.operations : [];
        const beforeLines = String(beforeCode || '').split('\n');
        const afterLines = String(afterCode || '').split('\n');
        const changed = beforeCode !== afterCode;
        const lineDelta = afterLines.length - beforeLines.length;
        const statusText = failed ? '修改未应用' : changed ? '已应用到编辑器' : '无需改动';
        const statusClass = failed ? 'error' : changed ? 'success' : 'warning';
        const checks = [
            trace.quality?.static?.summary,
            trace.quality?.visual?.summary,
            result?.warning,
        ].filter(Boolean);

        const operationHtml = operations.length
            ? operations.map(item => `<li>${this.escapeHtml(item)}</li>`).join('')
            : '<li>Agent 未返回具体操作，已保留生成结果供检查。</li>';
        const checksHtml = checks.length
            ? checks.map(item => `<li>${this.escapeHtml(item)}</li>`).join('')
            : '<li>修改结果已通过现有链路处理。</li>';

        report.classList.remove('hidden');
        this.elements.panel?.classList.add('studio-report-visible');
        report.innerHTML = `
            <div class="studio-report-header">
                <div>
                    <span class="studio-report-kicker">Studio 修改</span>
                    <strong>${this.escapeHtml(patchPlan.summary || 'AI 修改摘要')}</strong>
                </div>
                <span class="studio-report-status ${statusClass}">${statusText}</span>
            </div>
            <div class="studio-report-grid">
                <div>
                    <span>代码变化</span>
                    <strong>${changed ? `${lineDelta >= 0 ? '+' : ''}${lineDelta} 行` : '0 行'}</strong>
                </div>
                <div>
                    <span>检查状态</span>
                    <strong>${failed ? '需要处理' : '已完成'}</strong>
                </div>
            </div>
            <div class="studio-report-section">
                <span>修改计划</span>
                <ul>${operationHtml}</ul>
            </div>
            <div class="studio-report-section">
                <span>检查结果</span>
                <ul>${checksHtml}</ul>
            </div>
            ${changed ? '<button type="button" class="studio-report-revert">回滚到修改前</button>' : ''}
        `;

        const revertBtn = report.querySelector('.studio-report-revert');
        revertBtn?.addEventListener('click', () => {
            if (this.monacoEditor) {
                this.monacoEditor.setValue(beforeCode || '');
            }
            this.pendingHistoryDescription = '回滚 AI 修改';
            report.classList.add('hidden');
            this.elements.panel?.classList.remove('studio-report-visible');
        }, { once: true });
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    escapeCssUrl(value) {
        return String(value ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\)/g, '\\)');
    }

    expandStudioBoxForThumbnail(box) {
        const normalized = this.normalizeStudioBox(box || {});
        const padX = Math.max(normalized.width * 0.16, 0.018);
        const padY = Math.max(normalized.height * 0.16, 0.018);
        const centerX = normalized.x + normalized.width / 2;
        const centerY = normalized.y + normalized.height / 2;
        const targetWidth = Math.min(1, Math.max(0.06, normalized.width + padX * 2));
        const targetHeight = Math.min(1, Math.max(0.06, normalized.height + padY * 2));
        const x = Math.max(0, Math.min(1 - targetWidth, centerX - targetWidth / 2));
        const y = Math.max(0, Math.min(1 - targetHeight, centerY - targetHeight / 2));
        return { x, y, width: targetWidth, height: targetHeight };
    }

    getSceneObjectPreviewStyle(object, box = null) {
        const frame = this.getSelectedStudioFrame();
        if (!frame?.imageUrl) return '';
        const sourceBox = this.expandStudioBoxForThumbnail(box || this.getSceneObjectBoxForCurrentTime(object, 0, 1));
        const width = Math.max(0.001, Math.min(1, sourceBox.width));
        const height = Math.max(0.001, Math.min(1, sourceBox.height));
        const positionX = width >= 0.995 ? 50 : (sourceBox.x / Math.max(0.001, 1 - width)) * 100;
        const positionY = height >= 0.995 ? 50 : (sourceBox.y / Math.max(0.001, 1 - height)) * 100;
        return [
            `background-image:url("${this.escapeCssUrl(frame.imageUrl)}")`,
            `background-size:${(100 / width).toFixed(2)}% ${(100 / height).toFixed(2)}%`,
            `background-position:${positionX.toFixed(2)}% ${positionY.toFixed(2)}%`,
        ].join(';');
    }

    getSceneObjectThumbnailStyle(object, box = null) {
        return this.getSceneObjectPreviewStyle(object, box);
    }

    renderSceneObjectThumbnail(object, box = null) {
        const style = this.getSceneObjectPreviewStyle(object, box);
        if (!style) {
            return '<div class="studio-object-picker-thumbnail is-empty"><span>无预览</span></div>';
        }
        return `<div class="studio-object-picker-thumbnail" style="${this.escapeHtml(style)}" aria-hidden="true"></div>`;
    }

    renderSceneObjectHoverPreview(object, box = null) {
        const style = this.getSceneObjectPreviewStyle(object, box);
        const label = this.getSceneObjectDisplayLabel(object);
        const typeLabel = this.localizeSceneObjectType(object?.type || object?.publicType || '');
        const imageHtml = style
            ? `<div class="studio-object-hover-preview-image" style="${this.escapeHtml(style)}" aria-hidden="true"></div>`
            : '<div class="studio-object-hover-preview-image is-empty"><span>暂无预览</span></div>';
        return `
            ${imageHtml}
            <div class="studio-object-hover-preview-meta">
                <strong>${this.escapeHtml(label)}</strong>
                <span>${this.escapeHtml(typeLabel)}</span>
            </div>
        `;
    }

    ensureSceneObjectHoverPreviewElement(options = {}) {
        const overlay = this.ensureInteractionOverlay();
        if (!overlay) return null;
        let preview = overlay.querySelector('.studio-object-hover-preview');
        if (!preview) {
            preview = document.createElement('div');
            overlay.appendChild(preview);
        }
        preview.className = `studio-object-hover-preview${options.touchAction === 'toggle-preview' ? ' is-touch-preview' : ''}`;
        return preview;
    }

    showSceneObjectHoverPreview(objectId, anchorEl, options = {}) {
        const group = this.sceneCollisionGroups?.find(item => item.id === this.sceneObjectPickerState?.groupId);
        const target = group?.targets?.find(item => String(item.object?.id || '') === String(objectId));
        if (!target?.object) return;
        this.sceneObjectHoverPreviewState = {
            objectId: String(objectId),
            groupId: group.id,
            touchAction: options.touchAction || 'hover',
        };
        const preview = this.ensureSceneObjectHoverPreviewElement(options);
        if (!preview) return;
        preview.innerHTML = this.renderSceneObjectHoverPreview(target.object, target.box);
        preview.classList.remove('hidden');
        this.positionSceneObjectHoverPreview(anchorEl, preview);
    }

    hideSceneObjectHoverPreview(options = {}) {
        const preview = this.elements.interactionOverlay?.querySelector('.studio-object-hover-preview');
        if (preview) preview.remove();
        if (!options.keepState) {
            this.sceneObjectHoverPreviewState = null;
        }
    }

    positionSceneObjectHoverPreview(anchorEl, previewEl = null) {
        const overlay = this.ensureInteractionOverlay();
        const preview = previewEl || overlay?.querySelector('.studio-object-hover-preview');
        if (!overlay || !anchorEl || !preview) return;
        const overlayRect = overlay.getBoundingClientRect();
        const anchorRect = anchorEl.getBoundingClientRect();
        const width = preview.offsetWidth || 264;
        const height = preview.offsetHeight || 198;
        const gutter = 10;
        let left = anchorRect.right - overlayRect.left + gutter;
        let top = anchorRect.top - overlayRect.top - 4;
        if (left + width > overlayRect.width - gutter) {
            left = anchorRect.left - overlayRect.left - width - gutter;
        }
        if (left < gutter) {
            left = Math.min(overlayRect.width - width - gutter, Math.max(gutter, anchorRect.left - overlayRect.left));
        }
        if (top + height > overlayRect.height - gutter) {
            top = overlayRect.height - height - gutter;
        }
        if (top < gutter) top = gutter;
        preview.style.left = `${Math.max(gutter, left)}px`;
        preview.style.top = `${Math.max(gutter, top)}px`;
    }

    getSelectedStudioFrame() {
        const frames = Array.isArray(this.currentStudioFrameSet?.frames) ? this.currentStudioFrameSet.frames : [];
        return frames.find(frame => frame.frameId === this.selectedStudioFrameId)
            || frames.find(frame => frame.frameId === this.currentStudioFrameSet?.recommendedFrameId)
            || frames[0]
            || null;
    }

    renderStudioFrameStrip() {
        const strip = this.elements.frameStrip || this.elements.panel?.querySelector('#studio-frame-strip');
        if (!strip) return;
        const frames = Array.isArray(this.currentStudioFrameSet?.frames) ? this.currentStudioFrameSet.frames : [];
        if (!frames.length) {
            strip.innerHTML = '<div class="studio-frame-empty">暂无可校准关键帧。运行后会在这里显示推荐帧和阶段帧。</div>';
            return;
        }
        strip.innerHTML = frames.map((frame, index) => `
            <button type="button"
                class="studio-frame-btn${frame.frameId === this.selectedStudioFrameId ? ' active' : ''}${frame.isRecommended ? ' recommended' : ''}"
                data-frame-id="${this.escapeHtml(frame.frameId)}"
                title="${this.escapeHtml(frame.reason || '')}">
                <span class="studio-frame-label">${this.escapeHtml(frame.isRecommended ? '推荐帧' : (frame.label || `阶段 ${index + 1}`))}</span>
                <span class="studio-frame-meta">${Number(frame.objectCount || 0)} 个对象</span>
            </button>
        `).join('');
        strip.querySelectorAll('.studio-frame-btn').forEach(btn => {
            btn.addEventListener('click', () => this.selectStudioFrame(btn.dataset.frameId));
        });
    }

    selectStudioFrame(frameId) {
        const frames = Array.isArray(this.currentStudioFrameSet?.frames) ? this.currentStudioFrameSet.frames : [];
        const frame = frames.find(item => item.frameId === frameId) || frames[0] || null;
        this.closeSceneObjectPicker({ silent: true });
        this.hideSceneObjectHoverPreview();
        this.selectedStudioFrameId = frame?.frameId || null;
        this.clearInvalidStudioFrameSelection(frame);
        this.showStudioFrameImage(frame);
        this.renderStudioFrameStrip();
        this.renderSceneOverlay();
    }

    clearInvalidStudioFrameSelection(frame) {
        if (!frame || !(this.selectedSceneObjects instanceof Map) || !this.selectedSceneObjects.size) return;
        const frameIds = new Set(Array.isArray(frame.objectIds) ? frame.objectIds.map(String) : []);
        let changed = false;
        [...this.selectedSceneObjects.entries()].forEach(([id, object]) => {
            const objectId = String(id || object?.id || '');
            let visible = true;
            if (objectId.startsWith('manual_')) {
                visible = (object?.bboxes || []).some(item => String(item?.frameId || '') === String(frame.frameId));
            } else if (frameIds.size) {
                visible = frameIds.has(objectId);
            }
            if (!visible) {
                this.selectedSceneObjects.delete(objectId);
                changed = true;
            }
        });
        if (changed) {
            this.syncPrimarySceneSelection();
            this.renderObjectInspector();
        }
    }

    showStudioFrameImage(frame) {
        const stage = this.elements.videoPreview;
        if (!stage) return;
        const existing = stage.querySelector('.studio-calibration-frame, .studio-calibration-empty-state, .studio-calibration-empty');
        if (!frame?.imageUrl) {
            this.renderStudioFrameEmptyState('没有找到适合校准的关键帧。可以播放视频后使用当前画面作为参考。');
            return;
        }
        const image = document.createElement('img');
        image.className = 'studio-calibration-frame';
        image.src = frame.imageUrl;
        image.alt = `${frame.isRecommended ? '推荐帧' : '关键帧'}：${frame.reason || '用于校准'}`;
        image.addEventListener('error', () => this.handleStudioFrameImageError(frame), { once: true });
        if (existing) {
            existing.replaceWith(image);
        } else {
            stage.prepend(image);
        }
    }

    handleStudioFrameImageError(frame) {
        const label = frame?.label || (frame?.isRecommended ? '推荐帧' : '关键帧');
        if (frame) {
            frame.imageAvailable = false;
            frame._imageLoadFailed = true;
        }

        const frames = Array.isArray(this.currentStudioFrameSet?.frames) ? this.currentStudioFrameSet.frames : [];
        const fallbackFrame = frames
            .filter(item => item && item.frameId !== frame?.frameId && item.imageUrl && !item._imageLoadFailed)
            .sort((left, right) => Number(right.objectCount || 0) - Number(left.objectCount || 0))[0];

        if (fallbackFrame) {
            this.selectedStudioFrameId = fallbackFrame.frameId;
            this.clearInvalidStudioFrameSelection(fallbackFrame);
            this.renderStudioFrameStrip();
            this.showStudioFrameImage(fallbackFrame);
            this.renderSceneOverlay();
            this.renderObjectInspector(`${label}图片加载失败，已切换到可用关键帧。`);
            return;
        }

        this.renderStudioFrameStrip();
        this.renderStudioFrameEmptyState(`${label}图片加载失败。你可以重新运行抽帧，或播放视频后手动画框校准。`);
    }

    renderStudioFrameEmptyState(message) {
        const stage = this.elements.videoPreview;
        if (!stage) return;
        const existing = stage.querySelector('.studio-calibration-frame, .studio-calibration-empty-state, .studio-calibration-empty');
        const empty = document.createElement('div');
        empty.className = 'studio-calibration-frame studio-calibration-empty-state';
        empty.innerHTML = `
            <strong>关键帧暂不可用</strong>
            <span>${this.escapeHtml(message || '没有找到适合校准的关键帧。')}</span>
        `;
        if (existing) {
            existing.replaceWith(empty);
        } else {
            stage.prepend(empty);
        }
    }

    normalizeStudioBox(box) {
        const x = Math.max(0, Math.min(0.98, Number(box?.x) || 0));
        const y = Math.max(0, Math.min(0.98, Number(box?.y) || 0));
        const width = Math.max(0.02, Math.min(1 - x, Number(box?.width) || 0.08));
        const height = Math.max(0.02, Math.min(1 - y, Number(box?.height) || 0.06));
        return { x, y, width, height };
    }

    updateSceneObjectBox(object, box, options = {}) {
        if (!object) return;
        const normalized = this.normalizeStudioBox(box);
        if (!object._studioOriginalBBox && !options.skipOriginal) {
            object._studioOriginalBBox = this.getSceneObjectBoxForCurrentTime(object, 0, 1);
        }
        object.bbox = normalized;
        if (object.id) {
            if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
            this.canvasEditState.objectBoxOverrides.set(String(object.id), normalized);
        }
        const frameId = this.selectedStudioFrameId || this.getSelectedStudioFrame()?.frameId || 'manual';
        const bboxes = Array.isArray(object.bboxes) ? [...object.bboxes] : [];
        const index = bboxes.findIndex(item => item?.frameId === frameId);
        const nextEntry = { frameId, bbox: normalized };
        if (index >= 0) {
            bboxes[index] = { ...bboxes[index], ...nextEntry };
        } else {
            bboxes.push(nextEntry);
        }
        object.bboxes = bboxes;
    }

    enableManualSelectionMode() {
        this.isManualSelectionMode = true;
        this.clearSceneSelection({ silent: true });
        this.ensureInteractionOverlay()?.classList.add('is-manual-drawing');
        this.renderObjectInspector();
        this.renderSceneOverlay();
    }

    createManualStudioObject(box = null) {
        const frame = this.getSelectedStudioFrame();
        const bbox = this.normalizeStudioBox(box || { x: 0.34, y: 0.34, width: 0.28, height: 0.18 });
        const object = {
            id: `manual_${Date.now()}`,
            type: 'Manual',
            label: '手动画框对象',
            role: 'object',
            bbox,
            bboxes: [{ frameId: frame?.frameId || this.selectedStudioFrameId || 'manual', bbox }],
            editable: ['move', 'scale', 'delete', 'manual_region'],
            _studioOriginalBBox: bbox,
        };
        this.manualStudioObjects = [...this.manualStudioObjects, object];
        if (this.canvasEditState) {
            this.canvasEditState.manualRegions = this.getManualReferenceRegions();
        }
        this.selectSceneObjects([object], { silent: true });
        this.renderSceneOverlay();
        this.renderObjectInspector('已创建手动画框。你可以拖动调整，再应用到整段动画。');
        return object;
    }

    renderVideoPreview(videoUrl) {
        if (!this.elements.videoPreview) return;
        const frames = Array.isArray(this.currentStudioFrameSet?.frames) ? this.currentStudioFrameSet.frames : [];
        const recommendedFrameId = this.currentStudioFrameSet?.recommendedFrameId || frames[0]?.frameId || null;
        this.selectedStudioFrameId = this.selectedStudioFrameId || recommendedFrameId;
        const selectedFrame = frames.find(frame => frame.frameId === this.selectedStudioFrameId)
            || frames.find(frame => frame.frameId === recommendedFrameId)
            || frames[0]
            || null;

        const reference = this.elements.referenceVideo || this.elements.panel?.querySelector('#studio-video-reference-container');
        if (videoUrl) {
            if (reference) {
                reference.innerHTML = `
                    <video class="studio-preview-video" controls autoplay loop playsinline>
                        <source src="${videoUrl}" type="video/mp4">
                    </video>
                `;
            }
            this.renderStudioFrameStrip();
            this.showStudioFrameImage(selectedFrame);
            this.bindVideoOverlayRefresh();
        } else {
            if (reference) {
                reference.innerHTML = `
                <div class="video-preview-placeholder">
                    <i data-lucide="clapperboard"></i>
                    <p>视频预览区</p>
                </div>
            `;
            }
            this.renderStudioFrameStrip();
            this.renderStudioFrameEmptyState('运行后会在这里显示推荐关键帧。');
        }
        this.bindCalibrationFrameDrawing();
        this.ensureInteractionOverlay();
        this.renderSceneOverlay();
        if (window.lucide) lucide.createIcons();
    }

    bindCalibrationFrameDrawing() {
        const stage = this.elements.videoPreview;
        if (!stage || stage.dataset.studioDrawingBound === '1') return;
        stage.dataset.studioDrawingBound = '1';
        stage.addEventListener('pointerdown', event => {
            if (event.target.closest('.studio-live-object, .studio-object-hotspot, .studio-object-cluster, .studio-object-picker, .studio-canvas-tooling')) return;
            const tool = this.getCanvasTool();
            const isAddTool = tool.startsWith('add_');
            const startMarquee = tool === 'box-select' || (tool === 'select' && (event.shiftKey || event.ctrlKey || event.metaKey));
            const shouldDraw = tool === 'manual' || this.isManualSelectionMode;
            const rect = stage.getBoundingClientRect();
            const startX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            const startY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));

            if (isAddTool) {
                this.closeSceneObjectPicker({ silent: true });
                this.createCanvasNewObject(tool.replace('add_', ''), { x: startX, y: startY });
                event.preventDefault();
                return;
            }

            if (!shouldDraw && !startMarquee) {
                this.closeSceneObjectPicker();
                this.clearSceneSelection({ silent: true });
                this.renderSceneOverlay();
                this.renderObjectInspector();
                return;
            }
            const object = shouldDraw
                ? this.createManualStudioObject({ x: startX, y: startY, width: 0.02, height: 0.02 })
                : null;
            this.studioPointerState = {
                mode: shouldDraw ? 'draw' : 'select_marquee',
                object,
                startX,
                startY,
                rect,
                additive: startMarquee,
            };
            stage.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        stage.addEventListener('pointermove', event => this.handleStudioPointerMove(event));
        stage.addEventListener('pointerup', event => this.finishStudioPointer(event));
        stage.addEventListener('pointercancel', event => this.finishStudioPointer(event));
    }

    ensureInteractionOverlay() {
        if (!this.elements.videoPreview) return null;
        const target = this.elements.videoPreview;
        let overlay = target.querySelector('#studio-interaction-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'studio-interaction-overlay';
            overlay.className = 'studio-interaction-overlay';
            overlay.setAttribute('aria-label', '可交互对象层');
            target.appendChild(overlay);
        }
        this.elements.interactionOverlay = overlay;
        return overlay;
    }

    bindVideoOverlayRefresh() {
        const video = this.elements.referenceVideo?.querySelector('video') || this.elements.panel?.querySelector('#studio-video-reference-container video');
        if (!video || video.dataset.studioOverlayBound === '1') return;
        video.dataset.studioOverlayBound = '1';
        let lastRefresh = 0;
        const refresh = () => {
            this.renderSceneOverlay();
        };
        const timedRefresh = () => {
            const now = Date.now();
            if (now - lastRefresh < 400) return;
            lastRefresh = now;
            refresh();
        };
        video.addEventListener('loadeddata', refresh, { once: true });
        video.addEventListener('seeked', refresh);
        video.addEventListener('pause', refresh);
        video.addEventListener('timeupdate', timedRefresh);
    }

    handleStudioKeydown(event) {
        if (!this.elements.panel?.classList.contains('open') && !this.elements.panel?.classList.contains('active')) return;
        if (event.key !== 'Escape') return;
        if (this.sceneObjectHoverPreviewState) {
            this.hideSceneObjectHoverPreview();
        }
        if (this.sceneObjectPickerState) {
            this.closeSceneObjectPicker();
            event.preventDefault();
            return;
        }
        if (this.getSelectedSceneObjects().length) {
            this.clearSceneSelection();
            event.preventDefault();
        }
    }

    handleStudioGlobalPointerDown(event) {
        if (!this.elements.panel?.classList.contains('open') && !this.elements.panel?.classList.contains('active')) return;
        const target = event.target;
        if (target?.closest?.('.studio-live-object, .studio-object-picker, .studio-object-cluster, .studio-object-hotspot, .studio-object-hover-preview')) return;
        this.hideSceneObjectHoverPreview();
        if (this.sceneObjectPickerState) {
            this.closeSceneObjectPicker();
        }
    }

    localizeSceneObjectType(type) {
        const map = {
            Text: '文字',
            SafeText: '文字',
            Tex: '公式',
            MathTex: '公式',
            SafeMathTex: '公式',
            Circle: '圆形',
            Square: '正方形',
            Triangle: '三角形',
            Rectangle: '矩形',
            Polygon: '多边形',
            Line: '线段',
            Arrow: '箭头',
            Dot: '点',
            Graph: '曲线',
            VGroup: '组合',
            Axes: '坐标系',
            Manual: '手动画框',
        };
        return map[type] || '对象';
    }

    getSceneObjectDisplayLabel(item) {
        const text = String(item?.text || '').trim();
        if (/[\u4e00-\u9fff]/.test(text) && text.length <= 18) return text;

        const id = String(item?.id || item?.label || '').toLowerCase();
        const rules = [
            [/title/, '标题'],
            [/subtitle|sub_title/, '副标题'],
            [/step|banner/, '步骤说明'],
            [/summary|conclusion/, '总结'],
            [/formula|math|tex/, '公式'],
            [/axes|axis/, '坐标系'],
            [/graph|curve|plot/, '曲线'],
            [/point|dot|key/, '关键点'],
            [/arrow/, '箭头'],
            [/line/, '线段'],
            [/circle/, '圆形'],
            [/square/, '正方形'],
            [/triangle/, '三角形'],
            [/label|txt|text/, '文字标签'],
        ];
        const matched = rules.find(([pattern]) => pattern.test(id));
        if (matched) return matched[1];

        return `${this.localizeSceneObjectType(item?.type)} ${String(item?.id || '').replace(/_/g, ' ').trim() || '对象'}`;
    }

    getSceneObjectRole(item) {
        const id = String(item?.id || item?.label || '').toLowerCase();
        const type = String(item?.type || '');
        if (/title/.test(id)) return 'title';
        if (/subtitle|sub_title/.test(id)) return 'subtitle';
        if (/step|banner/.test(id)) return 'step';
        if (/summary|conclusion/.test(id)) return 'summary';
        if (/formula|math|tex/.test(id) || /MathTex|Tex/.test(type)) return 'formula';
        if (/axes|axis/.test(id) || type === 'Axes') return 'axes';
        if (/graph|curve|plot/.test(id)) return 'graph';
        if (/point|dot|key/.test(id) || type === 'Dot') return 'point';
        if (/arrow/.test(id) || type === 'Arrow') return 'connector';
        if (/line/.test(id) || type === 'Line') return 'connector';
        if (/Circle|Square|Triangle|Polygon/.test(type)) return 'shape';
        return item?.role || 'object';
    }

    shouldExposeSceneObject(item) {
        const id = String(item?.id || '').toLowerCase();
        const type = String(item?.type || '');
        if (/background|bg|panel/.test(id)) return false;
        if (/x_labels|y_labels|labels_group|formula_group|axes_group/.test(id)) return false;
        if (type === 'VGroup' && /(group|labels|mob)$/.test(id) && !/(key|point|graph|curve|title|summary|formula)/.test(id)) return false;
        return true;
    }

    normalizeSceneBox(box) {
        if (!box || typeof box !== 'object') return null;
        const x = Number(box.x);
        const y = Number(box.y);
        const width = Number(box.width);
        const height = Number(box.height);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
        return {
            x: Math.max(0.01, Math.min(0.96, x)),
            y: Math.max(0.01, Math.min(0.94, y)),
            width: Math.max(0.04, Math.min(0.72, width)),
            height: Math.max(0.04, Math.min(0.46, height)),
        };
    }

    fallbackSceneBox(item, index, total) {
        const role = this.getSceneObjectRole(item);
        const byRole = {
            title: { x: 0.33, y: 0.04, width: 0.34, height: 0.07 },
            subtitle: { x: 0.36, y: 0.11, width: 0.28, height: 0.055 },
            step: { x: 0.14, y: 0.22, width: 0.36, height: 0.075 },
            axes: { x: 0.24, y: 0.34, width: 0.52, height: 0.38 },
            graph: { x: 0.20, y: 0.35, width: 0.60, height: 0.34 },
            shape: { x: 0.30, y: 0.30, width: 0.40, height: 0.42 },
            formula: { x: 0.30, y: 0.74, width: 0.40, height: 0.09 },
            summary: { x: 0.24, y: 0.84, width: 0.52, height: 0.08 },
            connector: { x: 0.20, y: 0.48, width: 0.60, height: 0.10 },
        };
        if (byRole[role]) return byRole[role];
        if (role === 'point') {
            const slot = index % 5;
            return { x: 0.22 + slot * 0.14, y: 0.58, width: 0.08, height: 0.08 };
        }
        const cols = 4;
        const row = Math.floor(index / cols);
        const col = index % cols;
        const y = Math.min(0.82, 0.24 + row * 0.13);
        return { x: 0.12 + col * 0.20, y, width: Math.max(0.10, Math.min(0.18, 0.72 / Math.max(1, Math.min(total, cols)))), height: 0.08 };
    }

    getSceneObjectBoxForCurrentTime(object, index = 0, total = 1) {
        const selectedFrame = this.getSelectedStudioFrame();
        const video = this.elements.referenceVideo?.querySelector('video') || this.elements.panel?.querySelector('#studio-video-reference-container video');
        const duration = Number(video?.duration || 0);
        const current = Number(video?.currentTime || 0);
        const bboxes = Array.isArray(object?.bboxes) ? object.bboxes : [];
        if (bboxes.length) {
            if (selectedFrame?.frameId) {
                const byFrame = bboxes.find(item => String(item?.frameId || '') === String(selectedFrame.frameId));
                if (byFrame) return this.normalizeSceneBox(byFrame.bbox || byFrame);
            }
            const normalizedTime = duration > 0 ? current / duration : 0;
            const exact = bboxes.find(item => {
                const range = item.timeRange;
                return Array.isArray(range) && range.length === 2
                    ? normalizedTime >= Number(range[0]) && normalizedTime <= Number(range[1])
                    : false;
            });
            const selected = exact || bboxes[0];
            return this.normalizeSceneBox(selected.bbox || selected);
        }
        return this.normalizeSceneBox(object?.bbox) || this.fallbackSceneBox(object, index, total);
    }

    getSceneObjectPriority(object, box = null) {
        const role = this.getSceneObjectRole(object);
        const type = String(object?.type || object?.publicType || '').toLowerCase();
        const id = String(object?.id || '').toLowerCase();
        const area = box ? Number(box.width || 0) * Number(box.height || 0) : 1;
        if (id.startsWith('manual_')) return 950;
        if (['title', 'subtitle', 'step', 'summary', 'formula', 'text'].includes(role)) return 850 - area * 100;
        if (/text|tex|math|formula/.test(type)) return 820 - area * 100;
        if (role === 'point') return 760;
        if (role === 'connector') return 650;
        if (role === 'graph') return 600;
        if (role === 'shape') return 560;
        if (role === 'axes') return 360;
        if (/group|panel|background|card/.test(type + id)) return 120;
        return 420 - area * 40;
    }

    prioritizeSceneObjects(objects) {
        return [...objects].sort((left, right) => {
            const leftBox = this.getSceneObjectBoxForCurrentTime(left, 0, 1);
            const rightBox = this.getSceneObjectBoxForCurrentTime(right, 0, 1);
            return this.getSceneObjectPriority(right, rightBox) - this.getSceneObjectPriority(left, leftBox);
        });
    }

    getAllSelectableSceneObjects() {
        const deletedIds = this.canvasEditState?.pendingDeletes || new Set();
        return [
            ...(Array.isArray(this.currentSceneManifest?.objects) ? this.currentSceneManifest.objects : []),
            ...this.manualStudioObjects,
            ...(Array.isArray(this.canvasEditState?.pendingNewObjects) ? this.canvasEditState.pendingNewObjects : []),
        ].filter(item => !deletedIds.has(String(item?.id || '')));
    }

    getSelectedSceneObjects() {
        if (!(this.selectedSceneObjects instanceof Map)) {
            this.selectedSceneObjects = new Map();
        }
        return [...this.selectedSceneObjects.values()].filter(Boolean);
    }

    syncPrimarySceneSelection() {
        const selected = this.getSelectedSceneObjects();
        this.selectedSceneObject = selected[0] || null;
        return this.selectedSceneObject;
    }

    clearSceneSelection(options = {}) {
        this.selectedSceneObjects = new Map();
        this.selectedSceneObject = null;
        this.sceneObjectPickerState = null;
        this.hideSceneObjectHoverPreview();
        if (!options.silent) {
            this.renderSceneOverlay();
            this.renderObjectInspector();
        }
    }

    closeSceneObjectPicker(options = {}) {
        if (!this.sceneObjectPickerState) return;
        this.sceneObjectPickerState = null;
        this.hideSceneObjectHoverPreview();
        if (!options.silent) {
            this.renderSceneOverlay();
        }
    }

    normalizeSelectionGesture(event) {
        if (event?.shiftKey || event?.ctrlKey || event?.metaKey) return 'toggle';
        return 'replace';
    }

    selectSceneObjects(objects, options = {}) {
        const mode = options.mode || 'replace';
        if (!(this.selectedSceneObjects instanceof Map)) {
            this.selectedSceneObjects = new Map();
        }
        if (mode === 'replace') {
            this.selectedSceneObjects = new Map();
        }
        objects.filter(Boolean).forEach(object => {
            const id = String(object.id || '');
            if (!id) return;
            if (mode === 'toggle' && this.selectedSceneObjects.has(id)) {
                this.selectedSceneObjects.delete(id);
            } else {
                this.selectedSceneObjects.set(id, object);
            }
        });
        this.syncPrimarySceneSelection();
        this.updateCanvasSelectionState();
        if (!options.silent) {
            this.renderSceneOverlay();
            this.renderObjectInspector();
        }
    }

    unionStudioBoxes(boxes) {
        const valid = boxes.filter(box => box && Number.isFinite(Number(box.x)) && Number.isFinite(Number(box.y)));
        if (!valid.length) return null;
        const left = Math.min(...valid.map(box => box.x));
        const top = Math.min(...valid.map(box => box.y));
        const right = Math.max(...valid.map(box => box.x + box.width));
        const bottom = Math.max(...valid.map(box => box.y + box.height));
        return this.normalizeStudioBox({
            x: left,
            y: top,
            width: Math.max(0.02, right - left),
            height: Math.max(0.02, bottom - top),
        });
    }

    getSelectedSceneUnionBox() {
        return this.unionStudioBoxes(
            this.getSelectedSceneObjects().map(object => this.getEditedSceneObjectBox(object, 0, 1))
        );
    }

    getEditedSceneObjectBox(object, index = 0, total = 1) {
        if (!object) return null;
        const override = this.canvasEditState?.objectBoxOverrides?.get?.(String(object.id || ''));
        if (override) return this.normalizeStudioBox(override);
        return this.getSceneObjectBoxForCurrentTime(object, index, total);
    }

    getStudioLiveObjectSelector(objectId) {
        const value = String(objectId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `[data-live-object-id="${value}"]`;
    }

    getStudioProxyKind(object = {}) {
        const type = String(object.type || object.publicType || '').toLowerCase();
        const role = String(object.role || object.semanticRole || '').toLowerCase();
        const id = String(object.id || '').toLowerCase();
        if (id.startsWith('manual_')) return 'manual';
        if (id.startsWith('new_') || object.isNewObject) return object.kind || 'new';
        if (/mathtex|tex|formula/.test(type) || /formula|math|公式/.test(role)) return 'formula';
        if (/text|label|safetext/.test(type) || /title|subtitle|summary|step|label|text|文字/.test(role)) return 'text';
        if (/dot|point/.test(type) || /point|点/.test(role)) return 'point';
        if (/arrow/.test(type) || /arrow|箭头/.test(role)) return 'arrow';
        if (/line|curve|graph/.test(type) || /curve|line|graph|曲线|线/.test(role)) return 'curve';
        if (/axes|axis/.test(type) || /axis|axes|坐标/.test(role)) return 'axes';
        if (/circle|square|triangle|polygon|rectangle/.test(type)) return 'shape';
        return 'object';
    }

    getStudioObjectProxyText(object = {}) {
        const text = object.text || object.label || object.name || this.getSceneObjectDisplayLabel(object);
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    renderStudioObjectProxyContent(object, box, kind) {
        const label = this.getStudioObjectProxyText(object);
        const cropStyle = this.getSceneObjectPreviewStyle(object, box);
        if (kind === 'text' || kind === 'formula' || kind === 'manual' || kind === 'new') {
            return `<span class="studio-live-text">${this.escapeHtml(label || this.localizeSceneObjectType(object.type || object.publicType || ''))}</span>`;
        }
        if (kind === 'point') {
            return `<span class="studio-live-dot"></span><span class="studio-live-caption">${this.escapeHtml(label || '点')}</span>`;
        }
        if (kind === 'arrow') {
            return `<span class="studio-live-arrow"></span><span class="studio-live-caption">${this.escapeHtml(label || '箭头')}</span>`;
        }
        if (cropStyle) {
            return `<span class="studio-live-crop" style="${this.escapeHtml(cropStyle)}"></span><span class="studio-live-caption">${this.escapeHtml(label || this.localizeSceneObjectType(object.type || object.publicType || ''))}</span>`;
        }
        return `<span class="studio-live-caption">${this.escapeHtml(label || this.localizeSceneObjectType(object.type || object.publicType || '对象'))}</span>`;
    }

    shouldRenderStudioLiveObject(object, target, selectedIds, options = {}) {
        const id = String(object?.id || '');
        if (!id) return false;
        if (options.debugMode) return true;
        if (selectedIds?.has?.(id)) return true;
        if (id.startsWith('manual_') || id.startsWith('new_') || object?.isNewObject) return true;
        if (options.clusterMemberIds?.has?.(id)) return false;
        return true;
    }

    getRenderableStudioObjects(objects, targets, selectedIds, groups = [], options = {}) {
        const clusterMemberIds = new Set(
            groups
                .filter(group => group.kind === 'cluster')
                .flatMap(group => group.objectIds || [])
                .map(String)
        );
        const targetById = new Map(targets.map(target => [String(target.object?.id || ''), target]));
        return objects.filter(object => this.shouldRenderStudioLiveObject(
            object,
            targetById.get(String(object?.id || '')),
            selectedIds,
            { ...options, clusterMemberIds }
        ));
    }

    renderStudioObjectLayer(objects, targets, selectedIds, options = {}) {
        const targetById = new Map(targets.map(target => [String(target.object?.id || ''), target]));
        const deletedIds = this.canvasEditState?.pendingDeletes || new Set();
        return `
            <div class="studio-object-layer" aria-label="对象化交互编辑层">
                ${objects.map((object, index) => {
                    const id = String(object.id || '');
                    if (!id || deletedIds.has(id)) return '';
                    const target = targetById.get(id);
                    const box = target?.box || this.getEditedSceneObjectBox(object, index, objects.length);
                    if (!box) return '';
                    const kind = this.getStudioProxyKind(object);
                    const selected = selectedIds.has(id);
                    const zIndex = Math.max(90, Number(target?.zIndex || 0) + 90);
                    const quiet = !options.debugMode && !selected && !object.isNewObject && !id.startsWith('manual_') && !id.startsWith('new_');
                    return `
                    <button type="button"
                        class="studio-live-object is-${this.escapeHtml(kind)}${selected ? ' is-selected' : ''}${object.isNewObject ? ' is-new' : ''}${options.debugMode ? ' is-debug-visible' : ''}${quiet ? ' is-quiet' : ''}"
                        data-live-object-id="${this.escapeHtml(id)}"
                        data-object-id="${this.escapeHtml(id)}"
                        style="left:${(box.x * 100).toFixed(2)}%; top:${(box.y * 100).toFixed(2)}%; width:${(box.width * 100).toFixed(2)}%; height:${(box.height * 100).toFixed(2)}%; z-index:${zIndex};"
                        aria-label="可拖动对象：${this.escapeHtml(this.getSceneObjectDisplayLabel(object))}"
                        title="拖动调整：${this.escapeHtml(this.getSceneObjectDisplayLabel(object))}">
                        ${this.renderStudioObjectProxyContent(object, box, kind)}
                    </button>`;
                }).join('')}
            </div>
        `;
    }

    syncStudioLiveObjectsToDom(objects = []) {
        const overlay = this.elements.interactionOverlay || this.ensureInteractionOverlay();
        if (!overlay) return;
        objects.filter(Boolean).forEach((object, index) => {
            const id = String(object.id || '');
            const node = overlay.querySelector(this.getStudioLiveObjectSelector(id));
            if (!node) return;
            const box = this.getEditedSceneObjectBox(object, index, objects.length || 1);
            if (!box) return;
            node.style.left = `${(box.x * 100).toFixed(2)}%`;
            node.style.top = `${(box.y * 100).toFixed(2)}%`;
            node.style.width = `${(box.width * 100).toFixed(2)}%`;
            node.style.height = `${(box.height * 100).toFixed(2)}%`;
        });
    }

    getBoxIntersection(left, right) {
        if (!left || !right) return null;
        const x1 = Math.max(left.x, right.x);
        const y1 = Math.max(left.y, right.y);
        const x2 = Math.min(left.x + left.width, right.x + right.width);
        const y2 = Math.min(left.y + left.height, right.y + right.height);
        const width = Math.max(0, x2 - x1);
        const height = Math.max(0, y2 - y1);
        return { x: x1, y: y1, width, height, area: width * height };
    }

    shouldGroupHitTargets(left, right) {
        const overlap = this.getBoxIntersection(left.box, right.box);
        if (!overlap?.area) return false;
        const leftArea = Math.max(0.0001, left.box.width * left.box.height);
        const rightArea = Math.max(0.0001, right.box.width * right.box.height);
        const minCoverage = overlap.area / Math.min(leftArea, rightArea);
        const iou = overlap.area / Math.max(0.0001, leftArea + rightArea - overlap.area);
        const leftCenterInsideRight = (
            left.box.x + left.box.width / 2 >= right.box.x &&
            left.box.x + left.box.width / 2 <= right.box.x + right.box.width &&
            left.box.y + left.box.height / 2 >= right.box.y &&
            left.box.y + left.box.height / 2 <= right.box.y + right.box.height
        );
        const rightCenterInsideLeft = (
            right.box.x + right.box.width / 2 >= left.box.x &&
            right.box.x + right.box.width / 2 <= left.box.x + left.box.width &&
            right.box.y + right.box.height / 2 >= left.box.y &&
            right.box.y + right.box.height / 2 <= left.box.y + left.box.height
        );
        return minCoverage >= 0.38 || iou >= 0.22 || ((leftCenterInsideRight || rightCenterInsideLeft) && minCoverage >= 0.24);
    }

    buildCollisionGroups(targets) {
        const sorted = [...targets].sort((left, right) => right.zIndex - left.zIndex);
        const groups = [];
        sorted.forEach(target => {
            let group = groups.find(item => item.targets.some(existing => this.shouldGroupHitTargets(existing, target)));
            if (!group) {
                group = { targets: [] };
                groups.push(group);
            }
            group.targets.push(target);
        });

        return groups.map((group, index) => {
            const sortedTargets = [...group.targets].sort((left, right) => right.zIndex - left.zIndex);
            const box = this.unionStudioBoxes(sortedTargets.map(item => item.box)) || sortedTargets[0]?.box;
            const ids = sortedTargets.map(item => String(item.object?.id || '')).filter(Boolean);
            return {
                id: `cluster_${index + 1}`,
                kind: sortedTargets.length > 1 ? 'cluster' : 'single',
                targets: sortedTargets,
                object: sortedTargets[0]?.object,
                box,
                objectIds: ids,
                zIndex: Math.max(...sortedTargets.map(item => item.zIndex), 10) + (sortedTargets.length > 1 ? 50 : 0),
            };
        }).sort((left, right) => left.zIndex - right.zIndex);
    }

    buildInteractiveHitTargets(objects) {
        return objects.map((object, index) => {
            const box = this.getEditedSceneObjectBox(object, index, objects.length);
            const priority = this.getSceneObjectPriority(object, box);
            return {
                object,
                box,
                role: this.getSceneObjectRole(object),
                matchedByVision: false,
                zIndex: Math.max(5, Math.round(priority)),
            };
        }).sort((left, right) => left.zIndex - right.zIndex);
    }

    startStudioObjectDrag(event, objectId) {
        if (event.button !== undefined && event.button !== 0) return;
        const overlay = this.ensureInteractionOverlay();
        if (!overlay) return;
        const gesture = this.normalizeSelectionGesture(event);
        this.selectSceneObject(objectId, { mode: gesture, silent: true });
        if (gesture === 'toggle') {
            this.renderSceneOverlay();
            this.renderObjectInspector();
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const object = this.selectedSceneObject;
        if (!object) return;
        const box = this.getEditedSceneObjectBox(object, 0, 1);
        const rect = overlay.getBoundingClientRect();
        const selectedObjects = this.getSelectedSceneObjects();
        const objectsToMove = selectedObjects.some(item => item.id === object.id) && selectedObjects.length > 1
            ? selectedObjects
            : [object];
        this.studioPointerState = {
            mode: 'move',
            object,
            objects: objectsToMove,
            rect,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startBox: { ...box },
            startBoxes: new Map(objectsToMove.map(item => [
                String(item.id || ''),
                { ...this.getEditedSceneObjectBox(item, 0, 1) },
            ])),
            moved: false,
        };
        overlay.classList.add('is-object-dragging');
        overlay.setPointerCapture?.(event.pointerId);
        this.renderObjectInspector();
        event.preventDefault();
        event.stopPropagation();
    }

    startStudioLiveObjectDrag(event, objectId) {
        this.closeSceneObjectPicker({ silent: true });
        this.hideSceneObjectHoverPreview();
        this.startStudioObjectDrag(event, objectId);
    }

    handleStudioPointerMove(event) {
        const state = this.studioPointerState;
        if (!state || !state.rect?.width || !state.rect?.height) return;

        if (state.mode === 'draw') {
            const currentX = Math.max(0, Math.min(1, (event.clientX - state.rect.left) / state.rect.width));
            const currentY = Math.max(0, Math.min(1, (event.clientY - state.rect.top) / state.rect.height));
            const x = Math.min(state.startX, currentX);
            const y = Math.min(state.startY, currentY);
            const width = Math.abs(currentX - state.startX);
            const height = Math.abs(currentY - state.startY);
            this.updateSceneObjectBox(state.object, { x, y, width, height }, { skipOriginal: true });
            state.moved = width > 0.01 || height > 0.01;
        } else if (state.mode === 'select_marquee') {
            const currentX = Math.max(0, Math.min(1, (event.clientX - state.rect.left) / state.rect.width));
            const currentY = Math.max(0, Math.min(1, (event.clientY - state.rect.top) / state.rect.height));
            const x = Math.min(state.startX, currentX);
            const y = Math.min(state.startY, currentY);
            const width = Math.abs(currentX - state.startX);
            const height = Math.abs(currentY - state.startY);
            state.selectionBox = { x, y, width, height };
            state.moved = width > 0.015 || height > 0.015;
            this.renderSceneOverlay();
        } else if (state.mode === 'move') {
            const dx = (event.clientX - state.startClientX) / state.rect.width;
            const dy = (event.clientY - state.startClientY) / state.rect.height;
            const movingObjects = (state.objects || [state.object]).filter(Boolean);
            movingObjects.forEach(object => {
                const startBox = state.startBoxes?.get(String(object.id || '')) || state.startBox;
                const nextBox = {
                    ...startBox,
                    x: startBox.x + dx,
                    y: startBox.y + dy,
                };
                this.updateSceneObjectBox(object, nextBox);
            });
            state.moved = Math.abs(dx) > 0.003 || Math.abs(dy) > 0.003;
            if (state.object) this.selectedSceneObject = state.object;
            this.syncStudioLiveObjectsToDom(movingObjects);
            event.preventDefault();
            return;
        }
        if (state.object) this.selectedSceneObject = state.object;
        this.renderSceneOverlay();
        event.preventDefault();
    }

    finishStudioPointer(event) {
        const state = this.studioPointerState;
        if (!state) return;
        this.studioPointerState = null;
        this.isManualSelectionMode = false;
        if (this.canvasEditState?.tool === 'manual') this.canvasEditState.tool = 'select';
        this.ensureInteractionOverlay()?.classList.remove('is-manual-drawing', 'is-object-dragging');

        if (state.mode === 'draw') {
            const box = this.getEditedSceneObjectBox(state.object, 0, 1);
            if (!state.moved || box.width < 0.025 || box.height < 0.025) {
                this.manualStudioObjects = this.manualStudioObjects.filter(item => item.id !== state.object.id);
                this.clearSceneSelection({ silent: true });
                this.renderObjectInspector('手动画框太小，已取消。');
            } else {
                this.recordCanvasObjectEdit(state.object, 'manual_region');
                this.selectSceneObjects([state.object], { silent: true });
                this.renderObjectInspector('已创建手动画框。可继续拖动校准，或应用到整段动画。');
            }
        } else if (state.mode === 'select_marquee') {
            if (state.moved && state.selectionBox) {
                this.selectSceneObjectsInBox(state.selectionBox, { mode: state.additive ? 'toggle' : 'replace' });
            }
        } else if (state.mode === 'move' && state.moved) {
            (state.objects || [state.object]).filter(Boolean).forEach(object => {
                this.recordCanvasObjectEdit(object, 'layout_calibrate');
            });
            this.syncPrimarySceneSelection();
            this.updateCanvasSelectionState();
            const count = this.getSelectedSceneObjects().length;
            this.renderObjectInspector(count > 1
                ? `已调整 ${count} 个对象的位置。点击“应用到整段动画”后会重构 Manim 代码。`
                : '位置已在关键帧上调整。点击“应用到整段动画”后会重构 Manim 代码。');
        }
        this.renderSceneOverlay();
        event?.preventDefault?.();
    }

    renderSceneOverlay() {
        if (this.syncReactStudioCanvas()) {
            return;
        }
        const overlay = this.ensureInteractionOverlay();
        if (!overlay) return;

        const selectedFrame = this.getSelectedStudioFrame();
        const hasFrameFilter = Array.isArray(selectedFrame?.objectIds);
        const frameObjectIds = new Set(hasFrameFilter ? selectedFrame.objectIds.map(String) : []);
        const manifestObjects = this.prioritizeSceneObjects(
            this.getAllSelectableSceneObjects().filter(item => this.shouldExposeSceneObject(item))
        ).slice(0, 64);
        const deletedIds = this.canvasEditState?.pendingDeletes || new Set();
        const objects = manifestObjects.filter(item => {
            const id = String(item.id || '');
            if (deletedIds.has(id)) return false;
            if (id.startsWith('manual_') || id.startsWith('new_') || item.isNewObject) return true;
            return !hasFrameFilter || frameObjectIds.has(id);
        });
        if (!objects.length) {
            this.sceneObjectPickerState = null;
            this.hideSceneObjectHoverPreview();
            overlay.innerHTML = this.renderCanvasTooling();
            overlay.classList.remove('hidden');
            overlay.classList.toggle('is-manual-drawing', Boolean(this.isManualSelectionMode));
            overlay.classList.toggle('is-debug-visible', this.isStudioDebugMode());
            this.bindCanvasToolingEvents(overlay);
            this.renderObjectInspector();
            return;
        }

        overlay.classList.remove('hidden');
        overlay.classList.toggle('is-manual-drawing', Boolean(this.isManualSelectionMode));
        const debugMode = this.isStudioDebugMode();
        overlay.classList.toggle('is-debug-visible', debugMode);
        const targets = this.buildInteractiveHitTargets(objects);
        const groups = this.buildCollisionGroups(targets);
        this.sceneHitTargets = targets;
        this.sceneCollisionGroups = groups;
        const selectedIds = new Set(this.getSelectedSceneObjects().map(item => String(item.id || '')));
        const renderableObjects = this.getRenderableStudioObjects(objects, targets, selectedIds, groups, { debugMode });
        const pickerGroup = groups.find(item => item.id === this.sceneObjectPickerState?.groupId);
        if (this.sceneObjectPickerState && !pickerGroup) {
            this.sceneObjectPickerState = null;
            this.hideSceneObjectHoverPreview();
        }
        const pickerHtml = pickerGroup ? this.renderSceneObjectPicker(pickerGroup) : '';
        const marquee = this.studioPointerState?.mode === 'select_marquee' && this.studioPointerState.selectionBox
            ? this.studioPointerState.selectionBox
            : null;
        overlay.innerHTML = `
            ${this.renderCanvasTooling()}
            ${this.renderStudioObjectLayer(renderableObjects, targets, selectedIds, { debugMode })}
            ${groups.map(group => {
                if (group.kind === 'cluster') {
                    const box = group.box;
                    const selected = group.objectIds.some(id => selectedIds.has(id));
                    return `
                    <button type="button"
                        class="studio-object-cluster${selected ? ' selected' : ''}"
                        data-cluster-id="${this.escapeHtml(group.id)}"
                        style="left:${(box.x * 100).toFixed(2)}%; top:${(box.y * 100).toFixed(2)}%; width:${(box.width * 100).toFixed(2)}%; height:${(box.height * 100).toFixed(2)}%; z-index:${group.zIndex + 170};"
                        aria-label="重叠对象组：${group.objectIds.length} 个对象">
                        <span class="studio-object-rect"></span>
                        <span class="studio-object-cluster-badge">${group.objectIds.length} 个对象</span>
                    </button>`;
                }
                return '';
            }).join('')}
            ${pickerHtml}
            ${marquee ? `<div class="studio-selection-marquee" style="left:${(marquee.x * 100).toFixed(2)}%; top:${(marquee.y * 100).toFixed(2)}%; width:${(marquee.width * 100).toFixed(2)}%; height:${(marquee.height * 100).toFixed(2)}%;"></div>` : ''}
        `;

        this.bindCanvasToolingEvents(overlay);
        if (overlay.dataset.studioWheelCloseBound !== '1') {
            overlay.dataset.studioWheelCloseBound = '1';
            overlay.addEventListener('wheel', event => {
                if (event.target?.closest?.('.studio-object-picker')) return;
                if (this.sceneObjectPickerState) this.closeSceneObjectPicker();
                this.hideSceneObjectHoverPreview();
            }, { passive: true });
        }
        overlay.querySelectorAll('.studio-live-object').forEach(btn => {
            btn.addEventListener('pointerdown', event => this.startStudioLiveObjectDrag(event, btn.dataset.liveObjectId));
            btn.addEventListener('click', event => {
                event.stopPropagation();
                if (event.shiftKey || event.ctrlKey || event.metaKey) return;
                this.closeSceneObjectPicker({ silent: true });
                this.selectSceneObject(btn.dataset.liveObjectId, { mode: this.normalizeSelectionGesture(event) });
            });
            btn.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this.closeSceneObjectPicker({ silent: true });
                this.selectSceneObject(btn.dataset.liveObjectId, { mode: 'replace' });
            });
        });
        overlay.querySelectorAll('.studio-object-hotspot').forEach(btn => {
            btn.addEventListener('pointerdown', event => this.startStudioObjectDrag(event, btn.dataset.objectId));
            btn.addEventListener('click', event => {
                event.stopPropagation();
                if (event.shiftKey || event.ctrlKey || event.metaKey) return;
                this.closeSceneObjectPicker({ silent: true });
                this.selectSceneObject(btn.dataset.objectId, { mode: this.normalizeSelectionGesture(event) });
            });
        });
        overlay.querySelectorAll('.studio-object-cluster').forEach(btn => {
            btn.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
            });
            btn.addEventListener('click', event => {
                event.stopPropagation();
                this.openSceneObjectPicker(btn.dataset.clusterId);
            });
        });
        overlay.querySelectorAll('[data-picker-object-id]').forEach(btn => {
            btn.addEventListener('pointerenter', event => {
                this.showSceneObjectHoverPreview(btn.dataset.pickerObjectId, btn, { touchAction: 'hover' });
            });
            btn.addEventListener('focus', event => {
                this.showSceneObjectHoverPreview(btn.dataset.pickerObjectId, btn, { touchAction: 'hover' });
            });
            btn.addEventListener('pointerleave', () => {
                if (this.sceneObjectHoverPreviewState?.touchAction !== 'toggle-preview') {
                    this.hideSceneObjectHoverPreview();
                }
            });
            btn.addEventListener('blur', () => {
                if (this.sceneObjectHoverPreviewState?.touchAction !== 'toggle-preview') {
                    this.hideSceneObjectHoverPreview();
                }
            });
            btn.addEventListener('pointerdown', event => {
                if (event.pointerType !== 'touch') return;
                const active = this.sceneObjectHoverPreviewState?.objectId === String(btn.dataset.pickerObjectId)
                    && this.sceneObjectHoverPreviewState?.touchAction === 'toggle-preview';
                btn.dataset.touchAction = active ? 'select-object' : 'toggle-preview';
                if (!active) {
                    this.showSceneObjectHoverPreview(btn.dataset.pickerObjectId, btn, { touchAction: 'toggle-preview' });
                }
            });
            btn.addEventListener('click', event => {
                event.stopPropagation();
                if (btn.dataset.touchAction === 'toggle-preview') {
                    delete btn.dataset.touchAction;
                    return;
                }
                delete btn.dataset.touchAction;
                if (event.shiftKey || event.ctrlKey || event.metaKey) {
                    this.selectSceneObject(btn.dataset.pickerObjectId, { mode: 'toggle' });
                    return;
                }
                this.closeSceneObjectPicker({ silent: true });
                this.selectSceneObject(btn.dataset.pickerObjectId, { mode: 'replace' });
            });
        });
        overlay.querySelectorAll('[data-picker-toggle-id]').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                this.selectSceneObject(btn.dataset.pickerToggleId, { mode: 'toggle' });
            });
        });
        overlay.querySelectorAll('[data-picker-close]').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                this.closeSceneObjectPicker();
            });
        });
        overlay.querySelectorAll('[data-picker-all]').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                const group = this.sceneCollisionGroups.find(item => item.id === btn.dataset.pickerAll);
                if (!group) return;
                this.closeSceneObjectPicker({ silent: true });
                this.selectSceneObjects(group.targets.map(item => item.object), { mode: 'replace' });
            });
        });
        overlay.querySelector('.studio-object-picker-list')?.addEventListener('scroll', () => {
            this.hideSceneObjectHoverPreview();
        }, { passive: true });
    }

    getSceneObjectPickerPosition(group) {
        const box = group.box || { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
        const topSafeArea = 0.025;
        const horizontalSafeArea = 0.02;
        const estimatedPickerWidth = 0.46;
        const centerX = Math.max(horizontalSafeArea, Math.min(1 - horizontalSafeArea, box.x + box.width / 2));
        const maxLeft = Math.max(horizontalSafeArea, 1 - estimatedPickerWidth - horizontalSafeArea);
        const left = Math.min(maxLeft, Math.max(horizontalSafeArea, centerX - estimatedPickerWidth / 2));
        return { left, top: topSafeArea };
    }

    renderSceneObjectPicker(group) {
        const position = this.getSceneObjectPickerPosition(group);
        const selectedIds = new Set(this.getSelectedSceneObjects().map(item => String(item.id || '')));
        const targets = [...group.targets].sort((leftTarget, rightTarget) => {
            const leftBox = leftTarget.box || this.getSceneObjectBoxForCurrentTime(leftTarget.object, 0, 1);
            const rightBox = rightTarget.box || this.getSceneObjectBoxForCurrentTime(rightTarget.object, 0, 1);
            return this.getSceneObjectPriority(rightTarget.object, rightBox) - this.getSceneObjectPriority(leftTarget.object, leftBox);
        });
        return `
            <div class="studio-object-picker" data-picker="${this.escapeHtml(group.id)}"
                data-picker-placement="top"
                style="left:${(position.left * 100).toFixed(2)}%; top:${(position.top * 100).toFixed(2)}%; z-index:${Math.max(1600, group.zIndex + 120)};">
                <div class="studio-object-picker-title">
                    <div>
                        <strong>选择对象</strong>
                        <span>${targets.length} 个重叠对象</span>
                    </div>
                    <div class="studio-object-picker-actions">
                        <button type="button" data-picker-all="${this.escapeHtml(group.id)}">全选</button>
                        <button type="button" class="studio-object-picker-close" data-picker-close aria-label="关闭对象选择">×</button>
                    </div>
                </div>
                <div class="studio-object-picker-list">
                    ${targets.map(({ object, box: targetBox }) => {
                        const objectId = String(object.id || '');
                        const selected = selectedIds.has(objectId);
                        const label = this.getSceneObjectDisplayLabel(object);
                        const typeLabel = this.localizeSceneObjectType(object.type || object.publicType || '');
                        return `
                    <div class="studio-object-picker-row${selected ? ' is-selected' : ''}">
                        <button type="button" class="studio-object-picker-main" data-picker-object-id="${this.escapeHtml(objectId)}" data-picker-preview-id="${this.escapeHtml(objectId)}">
                            <span class="studio-object-picker-copy">
                                <strong>${this.escapeHtml(label)}</strong>
                                <span>${this.escapeHtml(typeLabel)}</span>
                            </span>
                            <span class="studio-object-picker-status">${selected ? '已选' : '单独选择'}</span>
                        </button>
                        <button type="button" class="studio-object-picker-add" data-picker-toggle-id="${this.escapeHtml(objectId)}">${selected ? '移除' : '加入'}</button>
                    </div>
                    `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    openSceneObjectPicker(groupId) {
        this.sceneObjectPickerState = { groupId };
        this.renderSceneOverlay();
    }

    selectSceneObject(objectId, options = {}) {
        const objects = this.getAllSelectableSceneObjects();
        const previousId = this.selectedSceneObject?.id || '';
        const object = objects.find(item => String(item.id || '') === String(objectId || '')) || null;
        if (!object) return;
        this.selectSceneObjects([object], { mode: options.mode || 'replace', silent: true });
        if (this.selectedSceneObject?.id !== previousId) {
            this.lastStudioNaturalCommand = '';
        }
        this.renderSceneOverlay();
        this.renderObjectInspector();
    }

    selectSceneObjectsInBox(selectionBox, options = {}) {
        const targets = this.sceneHitTargets || [];
        const selected = targets
            .filter(target => {
                const overlap = this.getBoxIntersection(selectionBox, target.box);
                const targetArea = Math.max(0.0001, target.box.width * target.box.height);
                return Boolean(overlap?.area && overlap.area / targetArea >= 0.18);
            })
            .map(target => target.object);
        this.selectSceneObjects(selected, { mode: options.mode || 'replace' });
        if (selected.length > 1) {
            this.renderObjectInspector(`已框选 ${selected.length} 个对象。可以输入“整体上移、排开、改颜色”等要求。`);
        }
        if (!selected.length) {
            this.renderObjectInspector('没有框选到可编辑对象。');
        }
    }

    renderObjectInspector(message = '') {
        const inspector = this.elements.objectInspector;
        if (!inspector) return;

        const selectedObjects = this.getSelectedSceneObjects();
        const object = selectedObjects[0] || null;
        if (!object) {
            if (!this.hasPendingCanvasEdits() && !message) {
                inspector.classList.add('hidden');
                inspector.innerHTML = '';
                return;
            }
            inspector.classList.remove('hidden');
            inspector.innerHTML = `
                <div class="studio-object-inspector-header">
                    <div>
                        <span>画布待应用修改</span>
                        <strong>已在静态画布中编辑</strong>
                    </div>
                    <button type="button" class="studio-object-close" aria-label="关闭对象属性">×</button>
                </div>
                ${message ? `<div class="studio-object-message">${this.escapeHtml(message)}</div>` : ''}
                <div class="studio-object-natural-editor">
                    <label for="studio-object-command-input">用自然语言补充你想怎么改</label>
                    <textarea id="studio-object-command-input"
                        class="studio-object-command-input"
                        rows="3"
                        placeholder="例如：把这些元素排开，整体往上移一点，避免遮挡曲线">${this.escapeHtml(this.lastStudioNaturalCommand || this.canvasEditState?.naturalLanguageCommand || '')}</textarea>
                    <div class="studio-object-apply-row">
                        <span class="studio-object-hint">点击应用后会重构整段 Manim 动画。</span>
                        <button type="button" class="studio-object-apply">应用到整段动画</button>
                    </div>
                </div>
            `;
            inspector.querySelector('.studio-object-close')?.addEventListener('click', () => {
                this.renderObjectInspector();
            });
            const input = inspector.querySelector('#studio-object-command-input');
            input?.addEventListener('input', event => {
                this.lastStudioNaturalCommand = event.target.value || '';
                if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
                this.canvasEditState.naturalLanguageCommand = this.lastStudioNaturalCommand;
                this.renderSceneOverlay();
            });
            inspector.querySelector('.studio-object-apply')?.addEventListener('click', () => this.applySelectedLayoutCalibration());
            return;
        }

        inspector.classList.remove('hidden');
        const isMulti = selectedObjects.length > 1;
        const editable = new Set(
            selectedObjects.flatMap(item => Array.isArray(item.editable) ? item.editable : [])
        );
        const defaultCommand = this.lastStudioNaturalCommand || '';
        const chips = isMulti ? [
            '一起往上移一点',
            '整体缩小一点',
            '改成深蓝色',
            '这些文字排开，不要互相遮住',
            '删除这些对象',
        ] : [
            editable.has('replace_text') ? '把文字改成“周期为 2π”' : '',
            editable.has('set_color') ? '改成深蓝色' : '',
            editable.has('move') ? '往上移一点' : '',
            editable.has('move') ? '往右移一点' : '',
            editable.has('scale') ? '缩小一点' : '',
            editable.has('delete') ? '删除这个对象' : '',
        ].filter(Boolean);
        const selectionBox = this.getSelectedSceneUnionBox();
        const selectedChips = selectedObjects.map(item => `
            <span class="studio-selected-chip">
                ${this.escapeHtml(this.getSceneObjectDisplayLabel(item))}
                <button type="button" data-remove-selected-id="${this.escapeHtml(item.id)}" aria-label="从多选中移除">×</button>
            </span>
        `).join('');
        inspector.innerHTML = `
            <div class="studio-object-inspector-header">
                <div>
                    <span>${isMulti ? '已选对象组' : '已选对象'}</span>
                    <strong>${isMulti ? `已选 ${selectedObjects.length} 个对象` : this.escapeHtml(this.getSceneObjectDisplayLabel(object))}</strong>
                </div>
                <button type="button" class="studio-object-close" aria-label="关闭对象属性">×</button>
            </div>
            <div class="studio-object-meta">
                ${isMulti
                    ? `<span>对象数：${selectedObjects.length}</span><span>范围：${selectionBox ? `${Math.round(selectionBox.width * 100)}% × ${Math.round(selectionBox.height * 100)}%` : '未知'}</span>`
                    : `<span>ID：${this.escapeHtml(object.id)}</span><span>类型：${this.escapeHtml(this.localizeSceneObjectType(object.type))}</span>${object.stageId ? `<span>阶段：${this.escapeHtml(object.stageId)}</span>` : ''}`
                }
            </div>
            ${isMulti ? `<div class="studio-selected-chip-list">${selectedChips}</div>` : ''}
            ${message ? `<div class="studio-object-message">${this.escapeHtml(message)}</div>` : ''}
            <div class="studio-object-natural-editor">
                <label for="studio-object-command-input">用自然语言描述你想怎么改</label>
                <textarea id="studio-object-command-input"
                    class="studio-object-command-input"
                    rows="3"
                    placeholder="${isMulti ? '例如：这些文字整体往上移一点，缩小并排开不要重叠' : '例如：把这行文字改成“周期为 2π”，往上移一点，缩小并改成深蓝色'}">${this.escapeHtml(defaultCommand)}</textarea>
                <div class="studio-object-suggestions" aria-label="快捷修改建议">
                    ${chips.map(chip => `<button type="button" class="studio-object-suggestion" data-studio-suggestion="${this.escapeHtml(chip)}">${this.escapeHtml(chip)}</button>`).join('')}
                </div>
                <div class="studio-object-apply-row">
                    <span class="studio-object-hint">修改会转成安全代码补丁，并重新渲染整段动画。</span>
                    <button type="button" class="studio-object-apply">应用到整段动画</button>
                </div>
            </div>
        `;

        inspector.querySelector('.studio-object-close')?.addEventListener('click', () => {
            this.clearSceneSelection({ silent: true });
            this.renderSceneOverlay();
            this.renderObjectInspector();
        });
        inspector.querySelectorAll('[data-remove-selected-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectedSceneObjects.delete(String(btn.dataset.removeSelectedId || ''));
                this.syncPrimarySceneSelection();
                this.renderSceneOverlay();
                this.renderObjectInspector();
            });
        });

        const input = inspector.querySelector('#studio-object-command-input');
        input?.addEventListener('input', event => {
            this.lastStudioNaturalCommand = event.target.value || '';
            if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
            this.canvasEditState.naturalLanguageCommand = this.lastStudioNaturalCommand;
            this.renderSceneOverlay();
        });
        input?.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                this.applyNaturalLanguageEdit();
            }
        });

        inspector.querySelectorAll('[data-studio-suggestion]').forEach(btn => {
            btn.addEventListener('click', () => this.handleInspectorPatch(btn.dataset.studioSuggestion));
        });
        inspector.querySelector('.studio-object-apply')?.addEventListener('click', () => {
            this.applyNaturalLanguageEdit();
        });
    }

    handleInspectorPatch(suggestion) {
        const input = this.elements.objectInspector?.querySelector('#studio-object-command-input');
        if (!input) return;
        const current = String(input.value || '').trim();
        input.value = current ? `${current}，${suggestion}` : suggestion;
        this.lastStudioNaturalCommand = input.value;
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        this.canvasEditState.naturalLanguageCommand = input.value;
        this.renderSceneOverlay();
        input.focus();
    }

    async applyNaturalLanguageEdit(commandOverride = '') {
        if (!this.getSelectedSceneObjects().length && !this.hasPendingCanvasEdits()) return;
        const input = this.elements.objectInspector?.querySelector('#studio-object-command-input');
        const command = String(commandOverride || input?.value || '').trim();
        if (!command) {
            this.renderObjectInspector('请先描述你想怎么修改选中的对象。');
            return;
        }
        this.lastStudioNaturalCommand = command;
        if (!this.canvasEditState) this.canvasEditState = this.createCanvasEditState();
        this.canvasEditState.naturalLanguageCommand = command;
        await this.applyScenePatch({
            operation: 'natural_language_edit',
            objectId: this.selectedSceneObject?.id || '',
            command,
        });
    }

    snapshotSelectedSceneObject() {
        if (!this.selectedSceneObject) return null;
        const box = this.getEditedSceneObjectBox(this.selectedSceneObject, 0, 1);
        return {
            id: this.selectedSceneObject.id,
            label: this.getSceneObjectDisplayLabel(this.selectedSceneObject),
            type: this.selectedSceneObject.type || this.selectedSceneObject.publicType || '',
            publicType: this.selectedSceneObject.publicType || '',
            role: this.getSceneObjectRole(this.selectedSceneObject),
            text: this.selectedSceneObject.text || this.selectedSceneObject.label || '',
            bbox: box,
            codeAnchor: this.selectedSceneObject.codeAnchor || null,
        };
    }

    snapshotSceneObject(object) {
        if (!object) return null;
        const box = this.getEditedSceneObjectBox(object, 0, 1);
        return {
            id: object.id,
            label: this.getSceneObjectDisplayLabel(object),
            type: object.type || object.publicType || '',
            publicType: object.publicType || '',
            role: this.getSceneObjectRole(object),
            text: object.text || object.label || '',
            bbox: box,
            codeAnchor: object.codeAnchor || null,
        };
    }

    snapshotSelectedSceneObjects() {
        return this.getSelectedSceneObjects()
            .map(object => this.snapshotSceneObject(object))
            .filter(Boolean);
    }

    buildLayoutEditSpec(patch) {
        const frame = this.getSelectedStudioFrame();
        const selectedObjects = this.getSelectedSceneObjects();
        const selectedObjectIds = selectedObjects.map(item => String(item.id || '')).filter(Boolean);
        const selectedObjectSnapshots = this.snapshotSelectedSceneObjects();
        const selectionBBox = this.getSelectedSceneUnionBox();
        const selectedObjectId = selectedObjectIds[0] || '';
        const state = this.canvasEditState || this.createCanvasEditState();
        const pendingEdits = Array.from(state.pendingObjectEdits?.values?.() || []);
        const pendingDeleteIds = Array.from(state.pendingDeletes || []);
        const pendingNewObjects = Array.isArray(state.pendingNewObjects) ? state.pendingNewObjects : [];
        const makeEdit = (object) => {
            const sourceBBox = object
                ? (object._studioOriginalBBox || this.getSceneObjectBoxForCurrentTime(object, 0, 1))
                : null;
            const currentBBox = object ? this.getEditedSceneObjectBox(object, 0, 1) : null;
            const edit = {
                ...patch,
                objectId: object?.id || patch.objectId || '',
                baseFrameId: frame?.frameId || this.selectedStudioFrameId || '',
                baseTime: Number(frame?.time || 0),
            };
            if (sourceBBox) {
                edit.sourceBBox = sourceBBox;
                edit.normalizedBBox = patch.normalizedBBox || (patch.operation === 'layout_calibrate' && currentBBox ? currentBBox : {
                    ...sourceBBox,
                    x: Math.max(0.01, Math.min(0.96, sourceBBox.x + Number(patch.dx || 0) / 14.222)),
                    y: Math.max(0.01, Math.min(0.94, sourceBBox.y - Number(patch.dy || 0) / 8.0)),
                    width: patch.factor ? Math.max(0.04, Math.min(0.72, sourceBBox.width * Number(patch.factor || 1))) : sourceBBox.width,
                    height: patch.factor ? Math.max(0.04, Math.min(0.46, sourceBBox.height * Number(patch.factor || 1))) : sourceBBox.height,
                });
            }
            return edit;
        };
        const selectedEdits = selectedObjects
            .filter(object => !String(object.id || '').startsWith('manual_'))
            .filter(object => !String(object.id || '').startsWith('new_') && !object.isNewObject)
            .map(object => makeEdit(object));
        const mergedEdits = new Map();
        [...selectedEdits, ...pendingEdits].forEach(edit => {
            const objectId = String(edit.objectId || '');
            if (!objectId) return;
            mergedEdits.set(objectId, edit);
        });
        const eps = 0.002;
        const objectEdits = [...mergedEdits.values()].filter(edit => {
            const src = edit.sourceBBox;
            const tgt = edit.normalizedBBox;
            if (!src || !tgt) return true;
            if (edit.operation && edit.operation !== 'layout_calibrate' && edit.operation !== 'move' && edit.operation !== 'scale') return true;
            const same = Math.abs(src.x - tgt.x) < eps &&
                Math.abs(src.y - tgt.y) < eps &&
                Math.abs((src.width || 0) - (tgt.width || 0)) < eps &&
                Math.abs((src.height || 0) - (tgt.height || 0)) < eps;
            if (same && this.isStudioDebugMode()) console.warn('[Studio] buildLayoutEditSpec: filtered zero-displacement edit for', edit.objectId);
            return !same;
        });
        const manualRegions = this.getManualReferenceRegions();
        const newObjects = pendingNewObjects.map(object => ({
            id: object.id,
            kind: object.kind || 'text',
            type: object.type || object.publicType || 'Text',
            label: object.label || '新增对象',
            text: object.text || object.label || '',
            normalizedBBox: this.getEditedSceneObjectBox(object, 0, 1),
            baseFrameId: frame?.frameId || this.selectedStudioFrameId || '',
            baseTime: Number(frame?.time || 0),
        }));
        const command = String(patch.command || state.naturalLanguageCommand || this.lastStudioNaturalCommand || '').trim();
        const selectionMode = selectedObjectIds.length > 1
            ? 'multi'
            : (selectedObjectId.startsWith('manual_') ? 'manual' : (selectedObjectId ? 'single' : 'canvas'));
        const naturalLanguageEdit = patch.operation === 'natural_language_edit' ? {
            command,
            selectedObjectId,
            selectedObjectIds,
            selectedObjectSnapshot: selectedObjectSnapshots[0] || null,
            selectedObjectSnapshots,
            selectionMode,
            baseFrameId: frame?.frameId || this.selectedStudioFrameId || '',
            baseTime: Number(frame?.time || 0),
            normalizedBBox: selectionBBox,
            selectionBBox,
        } : null;
        const spec = {
            baseFrameId: frame?.frameId || this.selectedStudioFrameId || '',
            baseTime: Number(frame?.time || 0),
            selectedObjectId,
            selectedObjectIds,
            selectedObjectSnapshots,
            selectionBBox,
            objectEdits,
            edits: objectEdits,
            newObjects,
            deletedObjectIds: pendingDeleteIds,
            manualReferenceRegions: manualRegions,
        };
        if (selectedObjectIds.length > 1) {
            spec.groupEdit = {
                operation: patch.operation || '',
                objectIds: selectedObjectIds,
                selectionBBox,
                baseFrameId: spec.baseFrameId,
                baseTime: spec.baseTime,
            };
        }
        if (naturalLanguageEdit) {
            spec.naturalLanguageEdit = naturalLanguageEdit;
        }
        return spec;
    }

    getManualReferenceRegions() {
        const frame = this.getSelectedStudioFrame();
        return (this.manualStudioObjects || []).map((object, index) => {
            const box = this.getEditedSceneObjectBox(object, index, this.manualStudioObjects.length || 1);
            return {
                id: object.id || `manual_${index + 1}`,
                type: object.publicType || object.type || '手动画框',
                label: object.label || '手动画框区域',
                baseFrameId: frame?.frameId || this.selectedStudioFrameId || '',
                baseTime: Number(frame?.time || 0),
                normalizedBBox: box,
            };
        });
    }

    async applySelectedLayoutCalibration() {
        if (!this.getSelectedSceneObjects().length && !this.hasPendingCanvasEdits()) {
            this.renderObjectInspector('请先选择视频中的对象、拖动画布元素，或手动画框一个区域。');
            return;
        }
        const primaryObject = this.syncPrimarySceneSelection();
        if (!primaryObject && this.hasPendingCanvasEdits()) {
            await this.applyScenePatch({
                operation: 'layout_calibrate',
                objectId: '',
            });
            return;
        }
        const isManualObject = String(primaryObject.id || '').startsWith('manual_');
        await this.applyScenePatch({
            operation: isManualObject ? 'manual_region' : 'layout_calibrate',
            objectId: primaryObject.id,
            normalizedBBox: this.getEditedSceneObjectBox(primaryObject, 0, 1),
        });
    }

    async applyScenePatch(patch) {
        const code = this.monacoEditor ? this.monacoEditor.getValue() : this.currentCode;
        if (!code?.trim()) return;
        this.renderObjectInspector('正在应用到整段动画...');

        try {
            const layoutEditSpec = this.buildLayoutEditSpec(patch);
            if (this.isStudioDebugMode()) {
                console.log('[Studio] applyScenePatch layoutEditSpec:', JSON.stringify({
                    editsCount: layoutEditSpec.objectEdits?.length || 0,
                    newObjectsCount: layoutEditSpec.newObjects?.length || 0,
                    deletedCount: layoutEditSpec.deletedObjectIds?.length || 0,
                    manualCount: layoutEditSpec.manualReferenceRegions?.length || 0,
                    hasNaturalLanguage: Boolean(layoutEditSpec.naturalLanguageEdit),
                }));
            }
            const response = await fetch('/api/manim/layout-rebuild', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, layoutEditSpec }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                this.renderObjectInspector(data.warning || data.error || '关键帧重构失败。');
                return;
            }

            if (this.isStudioDebugMode()) {
                const codeChanged = data.code !== code;
                console.log('[Studio] layout-rebuild result:', { codeChanged, patchSummary: data.patchSummary, hasVideoUrl: Boolean(data.videoUrl) });
                if (!codeChanged) console.warn('[Studio] WARNING: layout-rebuild returned success but code is unchanged!');
            }

            this.currentCode = data.code || code;
            if (this.monacoEditor && this.monacoEditor.getValue() !== this.currentCode) {
                this.monacoEditor.setValue(this.currentCode);
            }
            this.pendingHistoryDescription = data.patchSummary || '关键帧校准';

            if (data.videoUrl) {
                await this.applyStudioRenderResult(data, {
                    codeFallback: this.currentCode,
                    recordHistory: true,
                    historyDescription: this.pendingHistoryDescription,
                    message: data.patchSummary || '已应用到整段动画。',
                });
                return;
            }

            const manifest = data.runtimeSceneManifest || data.sceneManifest;
            if (manifest) {
                this.currentSceneManifest = manifest.runtimeSceneManifest || manifest;
                this.runtimeSceneManifest = this.currentSceneManifest;
                if (this.currentVideoId) {
                    this.registerSceneManifest(this.currentVideoId, {
                        sceneManifest: data.sceneManifest || manifest,
                        runtimeSceneManifest: data.runtimeSceneManifest || manifest,
                        studioFrameSet: data.studioFrameSet,
                        recommendedFrameId: data.recommendedFrameId,
                    });
                }
            }

            this.renderSceneOverlay();
            this.renderObjectInspector(data.patchSummary || '已生成安全代码补丁，正在重新渲染整段动画。');
            this.manualStudioObjects = [];
            this.resetCanvasEditState();
            this.clearSceneSelection({ silent: true });
            await this.renderCode(this.currentCode, true);
        } catch (error) {
            console.error('Studio patch failed:', error);
            this.renderObjectInspector('关键帧重构请求失败，请稍后再试。');
        }
    }

    async applyStudioRenderResult(data = {}, options = {}) {
        const code = data.code || options.codeFallback || this.currentCode;
        const videoUrl = data.videoUrl || data.video_url || '';
        const manifest = data.runtimeSceneManifest || data.sceneManifest || null;
        const hasFrameSetField = Object.prototype.hasOwnProperty.call(data, 'studioFrameSet');
        const hasFreshStudioVisuals = Boolean(videoUrl || data.studioFrameSet || hasFrameSetField || manifest);
        const nextRevision = hasFreshStudioVisuals ? (Number(this.studioRevision || 0) + 1) : Number(this.studioRevision || 0);
        if (hasFreshStudioVisuals) {
            this.studioRevision = nextRevision;
        }

        if (code) {
            this.currentCode = code;
            if (this.currentVideoId) this.codeVideoMap.set(this.currentVideoId, code);
            if (this.monacoEditor && this.monacoEditor.getValue() !== code) {
                this.monacoEditor.setValue(code);
            }
        }

        if (manifest) {
            this.currentSceneManifest = manifest.runtimeSceneManifest || manifest;
            this.runtimeSceneManifest = this.currentSceneManifest;
            if (this.currentVideoId) {
                this.registerSceneManifest(this.currentVideoId, {
                    sceneManifest: data.sceneManifest || manifest,
                    runtimeSceneManifest: data.runtimeSceneManifest || manifest,
                    studioFrameSet: data.studioFrameSet,
                    recommendedFrameId: data.recommendedFrameId,
                });
            }
        }

        if (data.studioFrameSet) {
            const normalizedFrameSet = this.normalizeStudioFrameSetForRevision(data.studioFrameSet, this.studioRevision);
            const recommendedFrameId = data.recommendedFrameId || normalizedFrameSet?.recommendedFrameId || normalizedFrameSet?.frames?.[0]?.frameId || null;
            this.currentStudioFrameSet = normalizedFrameSet ? { ...normalizedFrameSet, recommendedFrameId } : null;
            this.selectedStudioFrameId = recommendedFrameId;
            if (this.currentVideoId) {
                this.studioFrameSetMap.set(this.currentVideoId, {
                    ...this.currentStudioFrameSet,
                    recommendedFrameId,
                });
            }
        } else if (videoUrl || hasFrameSetField) {
            this.currentStudioFrameSet = null;
            this.selectedStudioFrameId = null;
            if (this.currentVideoId) this.studioFrameSetMap.delete(this.currentVideoId);
        }

        if (videoUrl) {
            this.latestVideoUrl = videoUrl;
            if (this.currentVideoId) this.videoUrlMap.set(this.currentVideoId, videoUrl);
            const separator = videoUrl.includes('?') ? '&' : '?';
            this.renderVideoPreview(`${videoUrl}${separator}t=${Date.now()}`);
        } else {
            this.renderStudioFrameStrip();
            this.renderSceneOverlay();
        }

        this.manualStudioObjects = [];
        this.resetCanvasEditState();
        this.clearSceneSelection({ silent: true });
        this.renderSceneOverlay();
        this.renderObjectInspector(options.message || data.patchSummary || '已更新预览与校准数据。');
        requestAnimationFrame(() => this.syncReactStudioCanvas());

        const historyDescription = options.historyDescription || this.pendingHistoryDescription || '';
        if (options.recordHistory && code) {
            this.addHistoryEntry(historyDescription || '手动运行', code);
            this.pendingHistoryDescription = null;
        }
        if (this.updateVersionIndicator) this.updateVersionIndicator();
    }

    async readAgentNdjson(response, onEvent) {
        if (!response.body || !response.body.getReader) {
            const text = await response.text();
            text.split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
                onEvent(JSON.parse(line));
            });
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    onEvent(JSON.parse(trimmed));
                }
            }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
            onEvent(JSON.parse(buffer.trim()));
        }
    }

    startProgressSimulation() {
        this.progress = 0;
        const fillEl = document.getElementById('btn-progress-fill');
        if (!fillEl) return;

        this.progressTimer = setInterval(() => {
            // Logarithmic slowdown: As it gets closer to 95%, the increment gets smaller
            const remaining = 95 - this.progress;
            const increment = remaining * 0.05; // 5% of remaining distance

            // Minimum increment to keep moving slightly
            this.progress += Math.max(increment, 0.1);

            if (this.progress > 95) this.progress = 95;

            fillEl.style.height = `${this.progress}%`;
        }, 100);
    }

    stopProgressSimulation() {
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
    }

    async finishProgressSimulation() {
        this.stopProgressSimulation();
        const fillEl = document.getElementById('btn-progress-fill');
        if (fillEl) {
            fillEl.style.height = '100%';
            // Brief pause to show 100%
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    /**
     * ✨ 新增：在编辑器中高亮显示错误行
     */
    highlightError(errorDetails) {
        if (!this.monacoEditor || !errorDetails) return;

        // 简单的正则匹配 Python 报错行号
        // 格式通常是: File "...", line 10, in ...
        const lineMatch = errorDetails.match(/line (\d+)/);
        if (lineMatch) {
            const lineNumber = parseInt(lineMatch[1]);

            // 在 Monaco Editor 中设置错误标记
            const model = this.monacoEditor.getModel();
            monaco.editor.setModelMarkers(model, "owner", [{
                startLineNumber: lineNumber,
                startColumn: 1,
                endLineNumber: lineNumber,
                endColumn: 1000,
                message: errorDetails.split('\n').slice(-2).join('\n'), // 取最后两行报错信息
                severity: monaco.MarkerSeverity.Error
            }]);

            // 自动滚动到错误行
            this.monacoEditor.revealLineInCenter(lineNumber);
        }
    }

    /**
     * ✨ 新增：清除所有错误标记
     */
    clearErrors() {
        if (!this.monacoEditor) return;
        const model = this.monacoEditor.getModel();
        monaco.editor.setModelMarkers(model, "owner", []);
    }

    /**
     * 渲染当前代码 (已升级：Ctrl+E 极速响应 + 自动取消旧请求)
     */
    async renderCode(codeOverride = null, recordHistory = true) {
        const code = codeOverride || (this.monacoEditor ? this.monacoEditor.getValue() : this.currentCode);
        if (!code) return;

        // 🛑 1. 前端打断：如果有正在进行的请求，直接取消它
        // 这会触发 fetch 的 AbortError，从而跳过后续处理
        if (this.renderAbortController) {
            console.log('🛑 Aborting previous render request...');
            this.renderAbortController.abort();
            this.renderAbortController = null;
        }

        // 2. 创建新的中断控制器
        this.renderAbortController = new AbortController();
        const signal = this.renderAbortController.signal;

        // 清除之前的错误高亮（之前加的功能）
        if (this.clearErrors) this.clearErrors();

        const renderBtn = this.elements.renderBtn;
        if (renderBtn) {
            // 注意：不要禁用按钮，允许用户狂按 Ctrl+E 重试
            renderBtn.classList.add('is-rendering');
            renderBtn.innerHTML = '<div class="loading-spinner"></div> 渲染中...';
        }

        try {
            // 获取唯一 ID (与 session-manager.js 保持一致)
            const clientId = localStorage.getItem('icecream_client_id') ||
                'temp_' + Math.random().toString(36).substr(2);

            const response = await fetch('/api/manim/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code,
                    client_id: clientId // 👈 关键：带上身份证
                }),
                signal: signal // 👈 绑定信号，关键！
            });

            const data = await response.json();

            // 请求完成，清理 controller
            this.renderAbortController = null;

            if (data.success && data.videoUrl) {
                await this.applyStudioRenderResult(data, {
                    codeFallback: code,
                    recordHistory,
                    historyDescription: this.pendingHistoryDescription || (recordHistory ? '手动运行' : ''),
                    message: '渲染完成，预览、关键帧和热点已同步更新。',
                });
            } else {
                // 失败逻辑
                console.error('Render Failed:', data.error);
                const errorMsg = data.details || data.error || '未知错误';

                // 调用错误高亮（之前加的功能）
                if (this.highlightError) this.highlightError(errorMsg);

                if (!errorMsg.includes('line')) {
                    alert('渲染失败: ' + errorMsg);
                }
            }
        } catch (err) {
            // 🛑 捕获取消异常，不做任何干扰
            if (err.name === 'AbortError') {
                console.log('✋ Render request aborted by user (New Ctrl+E pressed)');
                return; // 直接退出，保持无感
            }
            console.error('Render Error:', err);
            alert('渲染请求失败');
        } finally {
            // 只有当这是“当前”请求时，才恢复按钮状态
            if (!signal.aborted && renderBtn) {
                renderBtn.disabled = false;
                renderBtn.classList.remove('is-rendering');
                renderBtn.innerHTML = '<i data-lucide="play"></i> 运行';
                if (window.lucide) lucide.createIcons();
            }
        }
    }

    initMonaco() {
        if (this.monacoEditor || !this.elements.monacoContainer) return;

        // [Manim Pro Max] Custom DeepSeek-Cyan Theme
        if (typeof monaco !== 'undefined') {
            monaco.editor.defineTheme('icecream-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [
                    { token: 'keyword', foreground: '00f0ff', fontStyle: 'bold' }, // Neon Cyan
                    { token: 'comment', foreground: '64748b', fontStyle: 'italic' }, // Slate Muted
                    { token: 'string', foreground: '60a5fa' }, // Light Blue
                    { token: 'number', foreground: 'f472b6' }, // Pink
                    { token: 'type', foreground: '34d399' }, // Emerald
                    { token: 'function', foreground: '38bdf8' } // Sky Blue
                ],
                colors: {
                    'editor.background': '#1e293b00', // Transparent for glass effect
                    'editor.lineHighlightBackground': '#ffffff08',
                    'editor.selectionBackground': '#00f0ff20',
                    'editorCursor.foreground': '#00f0ff',
                    'editorIndentGuide.background': '#ffffff10',
                    'editorIndentGuide.activeBackground': '#00f0ff40'
                }
            });
        }

        const isLight = document.body.classList.contains('light-mode');

        this.monacoEditor = monaco.editor.create(this.elements.monacoContainer, {
            value: this.currentCode || '# Manim code will appear here', // Use currentCode if available
            language: 'python',
            theme: isLight ? 'vs' : 'icecream-dark',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
            fontLigatures: true,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            padding: { top: 16 },
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                useShadows: false
            }
        });

        // ✨ 修改：绑定 Ctrl+E (Cmd+E) 触发渲染
        // 如果之前写了 KeyS，请改成 KeyE
        this.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, () => {
            console.log('⌨️ Shortcut: Ctrl+E triggered render');
            this.renderCode();
        });

        // Apply pending history or code if available
        if (this.currentCode) {
            this.monacoEditor.setValue(this.currentCode);
        }

        // Theme observer
        const observer = new MutationObserver(() => {
            const theme = document.body.classList.contains('light-mode') ? 'vs' : 'icecream-dark';
            monaco.editor.setTheme(theme);
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    /**
     * 打开代码面板
     * @param {string} videoId 
     * @param {string|null} messageId - Optional chat message ID to sync updates back to
     */
    open(videoId, messageId = null) {
        this.currentMessageId = messageId;
        const code = this.codeVideoMap.get(videoId) || '# No code available';
        const videoUrl = this.videoUrlMap.get(videoId);
        this.latestVideoUrl = videoUrl || null;
        this.studioRevision = Number(this.studioRevision || 0) + 1;

        // 📜 [MathSpace] Reset history if switching to a different video
        const previousVideoId = this.currentVideoId;
        if (previousVideoId && previousVideoId !== videoId) {
            console.log('📜 Switching video, resetting history');
            this.codeHistory = [];
            this.currentHistoryIndex = -1;
            this.pendingHistoryDescription = null;
        }

        this.currentCode = code;
        this.currentVideoId = videoId;
        this.currentSceneManifest = this.sceneManifestMap.get(videoId) || null;
        this.runtimeSceneManifest = this.currentSceneManifest;
        this.currentStudioFrameSet = this.normalizeStudioFrameSetForRevision(this.studioFrameSetMap.get(videoId) || null, this.studioRevision);
        this.selectedStudioFrameId = this.currentStudioFrameSet?.recommendedFrameId || null;
        this.manualStudioObjects = [];
        this.resetCanvasEditState();
        this.clearSceneSelection({ silent: true });

        // Update Editors
        if (this.monacoEditor) {
            this.monacoEditor.setValue(code);
        }

        const mobilePre = document.getElementById('mobile-code-pre');
        if (mobilePre) mobilePre.textContent = code;

        // Update Video Preview (WITHOUT wiping history container)
        // this.elements.videoPreview is #video-inner-container
        this.renderVideoPreview(videoUrl || null);
        this.renderObjectInspector();

        // Show panel
        this.elements.panel.classList.add('open');
        this.elements.overlay.classList.add('active');

        // 📜 [MathSpace] Initialize history with "原始版本" if empty and code is valid
        if (this.codeHistory.length === 0 && code && !code.startsWith('#')) {
            this.addHistoryEntry('原始版本', code);
        } else {
            // Just render the existing history
            this.updateVersionIndicator();
        }

        // AI Suggestions (Simplified + Carousel)
        this.startSuggestionCarousel(code);
    }

    /**
     * === 📜 MathSpace History System (Full Port) ===
     * Uses array-based history with currentHistoryIndex for proper rollback.
     * pendingHistoryDescription pattern ensures history is only added AFTER successful render.
     */

    // History State (stored per video, reset on switch)
    codeHistory = [];
    currentHistoryIndex = -1;
    pendingHistoryDescription = null; // Temp description, saved after render success

    // [Manim Port] Chat Context tracking
    currentMessageId = null;
    latestVideoUrl = null;

    /**
     * Add a new entry to history
     * @param {string} description - Human readable description (e.g., "原始版本", "把圆改成红色")
     * @param {string} code - The code snapshot
     */
    addHistoryEntry(description, code) {
        console.log('📜 addHistoryEntry:', description);

        const entry = {
            id: Date.now(),
            description: description,
            code: code,
            timestamp: new Date()
        };

        // If not at latest, truncate future history
        if (this.currentHistoryIndex < this.codeHistory.length - 1) {
            this.codeHistory = this.codeHistory.slice(0, this.currentHistoryIndex + 1);
        }

        this.codeHistory.push(entry);
        this.currentHistoryIndex = this.codeHistory.length - 1;

        console.log('📜 History length:', this.codeHistory.length, 'Index:', this.currentHistoryIndex);

        this.updateVersionIndicator();
    }

    /**
     * Revert to a specific version
     * @param {number} index - Index in codeHistory array
     */
    revertToVersion(index) {
        if (index < 0 || index >= this.codeHistory.length) return;

        const entry = this.codeHistory[index];
        this.currentHistoryIndex = index;

        // Update editors
        if (this.monacoEditor) {
            this.monacoEditor.setValue(entry.code);
        }

        const mobilePre = document.getElementById('mobile-code-pre');
        if (mobilePre) mobilePre.textContent = entry.code;

        this.currentCode = entry.code;

        this.updateVersionIndicator();
        console.log(`⏪ Reverted to: ${entry.description}`);
    }

    /**
     * Render the history list UI with version numbers and revert buttons
     * Supports collapsible history drawer
     */
    updateVersionIndicator() {
        const container = document.getElementById('manim-history-root');
        if (!container) {
            console.warn('⚠️ manim-history-root not found');
            return;
        }

        // Empty state
        if (this.codeHistory.length === 0) {
            container.className = 'history-list-container studio-history-panel';
            container.innerHTML = `
                <div class="history-list-header">
                    <span>修改历史</span>
                </div>
                <div class="history-empty">使用 AI 修改代码后，记录将显示在此处</div>
            `;
            return;
        }

        // Header with toggle icon and count badge (default EXPANDED)
        // [Fixed] Preserve expanded state across renders, default to true if not set
        let isExpanded = true;
        if (container.classList.contains('history-list-container')) { // Already initialized
            isExpanded = container.classList.contains('expanded');
        }

        // DISABLE: className reset breaks toggle
        // container.className = 'history-list-container' + (isExpanded ? ' expanded' : '');
        container.className = `history-list-container studio-history-panel${isExpanded ? ' expanded' : ''}`;



        // [UI Refinement] Flex layout: Text/Badge (Left) ... Spacer ... Icon (Right)
        container.innerHTML = `
            <div class="history-list-header">
                <span>
                    修改历史
                    <span class="history-count-badge">${this.codeHistory.length}</span>
                </span>
                <small>点击展开或收起</small>
            </div>
            <div class="history-list"></div>
        `;

        // Re-initialize icons for the new content
        if (window.lucide) {
            window.lucide.createIcons();
        }

        const listEl = container.querySelector('.history-list');

        // Render items (newest at top = reversed order)
        this.codeHistory.slice().reverse().forEach((entry, reverseIndex) => {
            const index = this.codeHistory.length - 1 - reverseIndex;
            const isCurrent = index === this.currentHistoryIndex;
            const vNum = index + 1;

            const div = document.createElement('div');
            div.className = `history-item ${isCurrent ? 'current' : ''}`;
            div.dataset.index = index;

            const version = document.createElement('span');
            version.className = 'history-version';
            version.textContent = `v${vNum}`;

            const desc = document.createElement('span');
            desc.className = 'history-desc';
            desc.textContent = entry.description;

            div.appendChild(version);
            div.appendChild(desc);

            if (!isCurrent) {
                const revert = document.createElement('button');
                revert.className = 'history-revert-btn';
                revert.dataset.index = index;
                revert.textContent = '↩ 回退';
                div.appendChild(revert);
            } else {
                const current = document.createElement('span');
                current.className = 'history-current-tag';
                current.textContent = '当前';
                div.appendChild(current);
            }

            listEl.appendChild(div);
        });

        // Bind header click for toggle
        const header = container.querySelector('.history-list-header');
        header.addEventListener('click', (e) => {
            // Don't toggle if clicking on a button or other interactive element inside header
            if (e.target.closest('button') || e.target.closest('.history-revert-btn')) {
                return;
            }
            container.classList.toggle('expanded');
            // Resize Monaco editor after transition
            setTimeout(() => this.monacoEditor?.layout(), 310);
        });

        // Bind revert buttons
        listEl.querySelectorAll('.history-revert-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                this.revertToVersion(idx);
            });
        });
    }

    // Legacy adapter for existing calls
    addHistory(code, type = '修改') {
        this.addHistoryEntry(type, code);
    }

    renderHistoryList() {
        this.updateVersionIndicator();
    }

    restoreHistory(index) {
        this.revertToVersion(index);
    }

    getLocalSuggestions(code) {
        const suggestions = [];
        if (/Circle/i.test(code)) suggestions.push('把圆改成红色');
        if (/Square/i.test(code)) suggestions.push('让方块旋转起来');
        if (/Text/i.test(code)) suggestions.push('改变文字字体');
        suggestions.push('添加一个淡入动画', '背景改成深蓝色');
        return suggestions;
    }

    startSuggestionCarousel(code) {
        // Update BOTH mobile and desktop inputs
        const updatePlaceholder = (placeholder) => {
            if (this.elements.aiInput) {
                this.elements.aiInput.placeholder = placeholder;
            }
            if (this.elements.aiInputDesktop) {
                this.elements.aiInputDesktop.placeholder = placeholder;
            }
        };

        if (this.suggestionInterval) clearInterval(this.suggestionInterval);
        this.suggestionController?.abort();
        this.suggestionController = new AbortController();

        const startCarousel = (suggestions) => {
            const items = suggestions.map(item => String(item).trim()).filter(Boolean);
            if (!items.length) return;
            let idx = 0;
            const cycle = () => {
                updatePlaceholder(`试试：${items[idx % items.length]}`);
                idx++;
            };
            cycle();
            this.suggestionInterval = setInterval(cycle, 3000);
        };

        fetch('/api/manim/suggestions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, count: 5 }),
            signal: this.suggestionController.signal,
        })
            .then(res => res.ok ? res.json() : Promise.reject(new Error('suggestions failed')))
            .then(result => {
                const suggestions = Array.isArray(result?.data?.suggestions) ? result.data.suggestions : [];
                startCarousel(suggestions.length ? suggestions : this.getLocalSuggestions(code));
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                startCarousel(this.getLocalSuggestions(code));
            });
    }

    close() {
        if (this.suggestionInterval) {
            clearInterval(this.suggestionInterval);
            this.suggestionInterval = null;
        }
        this.suggestionController?.abort();
        this.suggestionController = null;
        this.elements.panel.classList.remove('open');
        this.elements.overlay.classList.remove('active');

        // [Manim Port] Sync video back to chat if modified
        if (this.currentMessageId && this.latestVideoUrl) {
            console.log('🔄 Syncing updated video to chat:', this.currentMessageId);
            const msgEl = document.getElementById(this.currentMessageId);
            if (msgEl) {
                const videoEl = msgEl.querySelector('video');
                if (videoEl) {
                    const separator = this.latestVideoUrl.includes('?') ? '&' : '?';
                    videoEl.src = `${this.latestVideoUrl}${separator}t=${Date.now()}`;
                    videoEl.load();
                    // Also update dataset if needed, but videoId probably hasn't changed
                }
            }
        }

        this.currentMessageId = null;
        this.latestVideoUrl = null;
    }

    switchMobileTab(tab) {
        this.elements.mobileTabs.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        if (tab === 'video') {
            this.elements.videoPreview.classList.remove('tab-hidden');
            this.elements.mobileCodeView.classList.add('tab-hidden');
            if (this.elements.monacoContainer) this.elements.monacoContainer.style.display = 'none';
        } else {
            this.elements.videoPreview.classList.add('tab-hidden');
            this.elements.mobileCodeView.classList.remove('tab-hidden');
        }
    }

    generateLocalSuggestions(code) {

        const suggestions = [];
        if (/Circle/i.test(code)) suggestions.push('把圆形改成蓝色');
        if (/Text/i.test(code)) suggestions.push('修改文字内容');

        if (suggestions.length > 0) {
            const placeholder = `试试：${suggestions[0]}`;
            if (this.elements.aiInput) {
                this.elements.aiInput.placeholder = placeholder;
            }
            if (this.elements.aiInputDesktop) {
                this.elements.aiInputDesktop.placeholder = placeholder;
            }
        }
    }
}
