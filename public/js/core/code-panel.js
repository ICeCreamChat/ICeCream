/**
 * Code Panel Module
 * 处理 Manim 代码显示、编辑和 AI 修改建议
 */
export class CodePanel {
    constructor() {
        this.codeVideoMap = new Map();
        this.videoUrlMap = new Map();
        this.sceneManifestMap = new Map();
        this.videoHistoryMap = new Map(); // [Manim Port] History State
        this.monacoEditor = null;
        this.currentCode = '';
        this.currentVideoId = null; // Track current video
        this.currentSceneManifest = null;
        this.runtimeSceneManifest = null;
        this.selectedSceneObject = null;
        this.detectedSceneRegions = [];
        this.sceneHitTargets = [];
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
        const manifest = sceneManifest.runtimeSceneManifest || sceneManifest;
        this.sceneManifestMap.set(videoId, manifest);
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

    ensureInteractionOverlay() {
        if (!this.elements.videoPreview) return null;
        let overlay = this.elements.videoPreview.querySelector('#studio-interaction-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'studio-interaction-overlay';
            overlay.className = 'studio-interaction-overlay';
            overlay.setAttribute('aria-label', '可交互对象层');
            this.elements.videoPreview.appendChild(overlay);
        }
        this.elements.interactionOverlay = overlay;
        return overlay;
    }

    bindVideoOverlayRefresh() {
        const video = this.elements.videoPreview?.querySelector('video');
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
        const video = this.elements.videoPreview?.querySelector('video');
        const duration = Number(video?.duration || 0);
        const current = Number(video?.currentTime || 0);
        const bboxes = Array.isArray(object?.bboxes) ? object.bboxes : [];
        if (bboxes.length) {
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

    buildInteractiveHitTargets(objects) {
        return objects.map((object, index) => ({
            object,
            box: this.getSceneObjectBoxForCurrentTime(object, index, objects.length),
            role: this.getSceneObjectRole(object),
            matchedByVision: false,
        }));
    }

    renderSceneOverlay() {
        const overlay = this.ensureInteractionOverlay();
        if (!overlay) return;

        const objects = Array.isArray(this.currentSceneManifest?.objects)
            ? this.currentSceneManifest.objects.filter(item => this.shouldExposeSceneObject(item)).slice(0, 18)
            : [];
        if (!objects.length) {
            overlay.innerHTML = '';
            overlay.classList.add('hidden');
            this.renderObjectInspector();
            return;
        }

        overlay.classList.remove('hidden');
        const targets = this.buildInteractiveHitTargets(objects);
        this.sceneHitTargets = targets;
        overlay.innerHTML = `
            ${targets.map(({ object, box, matchedByVision }) => `
                    <button type="button"
                        class="studio-object-hotspot${this.selectedSceneObject?.id === object.id ? ' selected' : ''}${matchedByVision ? ' is-vision-matched' : ''}"
                        data-object-id="${this.escapeHtml(object.id)}"
                        style="left:${(box.x * 100).toFixed(2)}%; top:${(box.y * 100).toFixed(2)}%; width:${(box.width * 100).toFixed(2)}%; height:${(box.height * 100).toFixed(2)}%;"
                        aria-label="视频元素：${this.escapeHtml(this.getSceneObjectDisplayLabel(object))}"
                        title="视频元素：${this.escapeHtml(this.getSceneObjectDisplayLabel(object))}">
                        <span class="studio-object-rect"></span>
                        <span class="studio-object-label">${this.escapeHtml(this.getSceneObjectDisplayLabel(object))}</span>
                    </button>
                `).join('')}
        `;

        overlay.querySelectorAll('.studio-object-hotspot').forEach(btn => {
            btn.addEventListener('click', event => {
                event.stopPropagation();
                this.selectSceneObject(btn.dataset.objectId);
            });
        });
    }

    selectSceneObject(objectId) {
        const objects = Array.isArray(this.currentSceneManifest?.objects) ? this.currentSceneManifest.objects : [];
        this.selectedSceneObject = objects.find(item => item.id === objectId) || null;
        this.renderSceneOverlay();
        this.renderObjectInspector();
    }

    renderObjectInspector(message = '') {
        const inspector = this.elements.objectInspector;
        if (!inspector) return;

        const object = this.selectedSceneObject;
        if (!object) {
            inspector.classList.add('hidden');
            inspector.innerHTML = '';
            return;
        }

        inspector.classList.remove('hidden');
        const editable = new Set(Array.isArray(object.editable) ? object.editable : []);
        inspector.innerHTML = `
            <div class="studio-object-inspector-header">
                <div>
                    <span>已选对象</span>
                    <strong>${this.escapeHtml(object.label || object.id)}</strong>
                </div>
                <button type="button" class="studio-object-close" aria-label="关闭对象属性">×</button>
            </div>
            <div class="studio-object-meta">
                <span>ID：${this.escapeHtml(object.id)}</span>
                <span>类型：${this.escapeHtml(this.localizeSceneObjectType(object.type))}</span>
            </div>
            ${message ? `<div class="studio-object-message">${this.escapeHtml(message)}</div>` : ''}
            <div class="studio-object-actions">
                ${editable.has('replace_text') ? '<button type="button" data-studio-patch="replace_text">改文字</button>' : ''}
                ${editable.has('set_color') ? '<button type="button" data-studio-patch="set_color">改为蓝色</button>' : ''}
                ${editable.has('move') ? '<button type="button" data-studio-patch="move_up">上移</button><button type="button" data-studio-patch="move_down">下移</button>' : ''}
                ${editable.has('scale') ? '<button type="button" data-studio-patch="scale_down">缩小</button>' : ''}
                ${editable.has('delete') ? '<button type="button" data-studio-patch="delete" class="danger">删除</button>' : ''}
            </div>
        `;

        inspector.querySelector('.studio-object-close')?.addEventListener('click', () => {
            this.selectedSceneObject = null;
            this.renderSceneOverlay();
            this.renderObjectInspector();
        });

        inspector.querySelectorAll('[data-studio-patch]').forEach(btn => {
            btn.addEventListener('click', () => this.handleInspectorPatch(btn.dataset.studioPatch));
        });
    }

    async handleInspectorPatch(action) {
        if (!this.selectedSceneObject) return;
        const objectId = this.selectedSceneObject.id;
        let patch = null;

        if (action === 'replace_text') {
            const nextText = window.prompt?.('输入新的文字内容', this.selectedSceneObject.text || this.selectedSceneObject.label || '') || '';
            if (!nextText.trim()) return;
            patch = { operation: 'replace_text', objectId, text: nextText.trim() };
        } else if (action === 'set_color') {
            patch = { operation: 'set_color', objectId, color: '#0284C7' };
        } else if (action === 'move_up') {
            patch = { operation: 'move', objectId, dx: 0, dy: 0.35 };
        } else if (action === 'move_down') {
            patch = { operation: 'move', objectId, dx: 0, dy: -0.35 };
        } else if (action === 'scale_down') {
            patch = { operation: 'scale', objectId, factor: 0.88 };
        } else if (action === 'delete') {
            if (window.confirm && !window.confirm('确定删除这个对象吗？')) return;
            patch = { operation: 'delete', objectId };
        }

        if (patch) {
            await this.applyScenePatch(patch);
        }
    }

    async applyScenePatch(patch) {
        const code = this.monacoEditor ? this.monacoEditor.getValue() : this.currentCode;
        if (!code?.trim()) return;
        this.renderObjectInspector('正在应用交互修复...');

        try {
            const response = await fetch('/api/manim/patch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, patch }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                this.renderObjectInspector(data.warning || data.error || '交互修复失败。');
                return;
            }

            this.currentCode = data.code || code;
            const manifest = data.runtimeSceneManifest || data.sceneManifest;
            if (manifest) {
                this.currentSceneManifest = manifest.runtimeSceneManifest || manifest;
                this.runtimeSceneManifest = this.currentSceneManifest;
                if (this.currentVideoId) this.registerSceneManifest(this.currentVideoId, manifest);
            }
            if (this.monacoEditor) this.monacoEditor.setValue(this.currentCode);
            this.pendingHistoryDescription = data.patchSummary || '交互修复';
            this.renderSceneOverlay();
            this.renderObjectInspector(data.patchSummary || '已应用交互修复，正在重新渲染。');
            await this.renderCode(this.currentCode);
        } catch (error) {
            console.error('Studio patch failed:', error);
            this.renderObjectInspector('交互修复请求失败，请稍后再试。');
        }
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
                // ... (成功逻辑保持不变) ...
                const newUrl = data.videoUrl;
                this.latestVideoUrl = newUrl;
                this.currentCode = code;
                const manifest = data.runtimeSceneManifest || data.sceneManifest;
                if (manifest) {
                    this.currentSceneManifest = manifest.runtimeSceneManifest || manifest;
                    this.runtimeSceneManifest = this.currentSceneManifest;
                    if (this.currentVideoId) this.registerSceneManifest(this.currentVideoId, manifest);
                }

                this.elements.videoPreview.innerHTML = `
                    <video class="studio-preview-video" controls autoplay loop playsinline>
                        <source src="${newUrl}?t=${Date.now()}" type="video/mp4">
                    </video>
                `;
                this.ensureInteractionOverlay();
                this.renderSceneOverlay();
                this.bindVideoOverlayRefresh();

                if (this.pendingHistoryDescription) {
                    this.addHistoryEntry(this.pendingHistoryDescription, code);
                    this.pendingHistoryDescription = null;
                } else if (recordHistory) {
                    this.addHistoryEntry('手动运行', code);
                }
                if (this.updateVersionIndicator) this.updateVersionIndicator();

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
        this.latestVideoUrl = null;
        const code = this.codeVideoMap.get(videoId) || '# No code available';
        const videoUrl = this.videoUrlMap.get(videoId);

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
        this.selectedSceneObject = null;

        // Update Editors
        if (this.monacoEditor) {
            this.monacoEditor.setValue(code);
        }

        const mobilePre = document.getElementById('mobile-code-pre');
        if (mobilePre) mobilePre.textContent = code;

        // Update Video Preview (WITHOUT wiping history container)
        // this.elements.videoPreview is #video-inner-container
        if (videoUrl && this.elements.videoPreview) {
            this.elements.videoPreview.innerHTML = `
                <video class="studio-preview-video" controls autoplay loop playsinline>
                    <source src="${videoUrl}" type="video/mp4">
                </video>
            `;
        } else {
            this.elements.videoPreview.innerHTML = `
                <div class="video-preview-placeholder">
                    <span>🎬</span>
                    <p>视频预览区</p>
                </div>
            `;
        }
        this.ensureInteractionOverlay();
        this.renderSceneOverlay();
        this.bindVideoOverlayRefresh();
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
