/**
 * Code Panel Module
 * 处理 Manim 代码显示、编辑和 AI 修改建议
 */
export class CodePanel {
    constructor() {
        this.codeVideoMap = new Map();
        this.videoUrlMap = new Map();
        this.videoHistoryMap = new Map(); // [Manim Port] History State
        this.monacoEditor = null;
        this.currentCode = '';
        this.currentVideoId = null; // Track current video
        this.abortController = null; // [Stop Button] Track active request
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
    registerVideo(videoId, code, videoUrl) {
        if (code) this.codeVideoMap.set(videoId, code);
        if (videoUrl) this.videoUrlMap.set(videoId, videoUrl);
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

            // "Nuclear" overrides
            targetBtn.style.cssText = 'background-color: #ef4444 !important; border-color: #ef4444 !important; color: white !important;';
            targetBtn.disabled = false;
        }

        // Re-init icons
        if (window.lucide) lucide.createIcons();

        // Start Simulated Progress
        this.startProgressSimulation();

        try {
            const currentCode = this.monacoEditor ? this.monacoEditor.getValue() : this.currentCode;

            const response = await fetch('/api/manim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: prompt,
                    code: currentCode,
                    type: 'modification'
                }),
                signal: signal
            });

            const data = await response.json();

            if (data.success && data.code) {
                // [Fix] Strip Markdown
                let cleanCode = data.code;
                cleanCode = cleanCode.replace(/^```(?:python)?\s*/i, "");
                cleanCode = cleanCode.replace(/\s*```$/, "");

                if (this.monacoEditor) {
                    this.monacoEditor.setValue(cleanCode);
                }

                this.pendingHistoryDescription = prompt;
                this.renderCode(cleanCode);
            } else {
                console.error('AI Mod Failed:', data);
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
                targetBtn.innerHTML = '<i data-lucide="sparkles" style="width:16px;"></i> 生成';
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
     * 渲染当前代码 (已升级：支持错误高亮)
     */
    async renderCode(codeOverride = null, recordHistory = true) {
        const code = codeOverride || (this.monacoEditor ? this.monacoEditor.getValue() : this.currentCode);
        if (!code) return;

        // 1. 清除之前的错误标记
        this.clearErrors();

        const renderBtn = this.elements.renderBtn;
        if (renderBtn) {
            renderBtn.disabled = true;
            renderBtn.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;"></div> 渲染中...';
        }

        try {
            const response = await fetch('/api/manim/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await response.json();

            if (data.success && data.videoUrl) {
                // Update Video
                const newUrl = data.videoUrl;
                this.latestVideoUrl = newUrl; // Track for sync on close

                this.elements.videoPreview.innerHTML = `
                    <video controls autoplay loop playsinline style="width:100%; height:100%; object-fit:contain;">
                        <source src="${newUrl}?t=${Date.now()}" type="video/mp4">
                    </video>
                `;

                // 📜 [MathSpace] If there's a pending history description (from AI modify), add to history now
                if (this.pendingHistoryDescription) {
                    this.addHistoryEntry(this.pendingHistoryDescription, code);
                    this.pendingHistoryDescription = null;
                } else if (recordHistory) {
                    // Manual run without AI
                    this.addHistoryEntry('手动运行', code);
                }

                // Re-render list (because innerHTML wiped it, wait, now it doesn't!)
                // [FIX] Since we removed history-root overwriting, we don't strictly need to rerender list unless logic changed.
                // But updateVersionIndicator operates on #manim-history-root which is stable now.
                this.updateVersionIndicator();
            } else {
                // ❌ 失败时：调用高亮函数
                console.error('Render Failed:', data.error);
                // 优先显示详细信息，如果没有则显示 error
                const errorMsg = data.details || data.error || '未知错误';
                this.highlightError(errorMsg);

                // 仅在非语法错误时弹窗 (语法错误直接看编辑器红线)
                if (!errorMsg.includes('line')) {
                    alert('渲染失败: ' + errorMsg);
                }
            }
        } catch (err) {
            console.error('Render Error:', err);
            alert('渲染请求失败');
        } finally {
            if (renderBtn) {
                renderBtn.disabled = false;
                renderBtn.innerHTML = '<i data-lucide="play" style="width:16px;"></i> 运行';
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

        // ✨ 新增：绑定 Ctrl+S (或 Cmd+S) 触发渲染
        this.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            console.log('⌨️ Shortcut: Ctrl+S triggered render');
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
                <video controls autoplay loop playsinline style="width:100%; height:100%; object-fit:contain;">
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
            container.className = 'history-list-container';
            container.innerHTML = `
                <div class="history-list-header">
                    <span>📜 修改历史</span>
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
        container.className = 'history-list-container';



        // [UI Refinement] Flex layout: Text/Badge (Left) ... Spacer ... Icon (Right)
        container.innerHTML = `
            <div class="history-list-header"  style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <span style="display: flex; align-items: center; gap: 8px;">
                    📜 修改历史
                    <span class="history-count-badge">${this.codeHistory.length}</span>
                </span>
                
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
            div.innerHTML = `
                <span class="history-version">v${vNum}</span>
                <span class="history-desc">${entry.description}</span>
                ${!isCurrent
                    ? `<button class="history-revert-btn" data-index="${index}">↩ 回退</button>`
                    : '<span class="history-current-tag">当前</span>'}
            `;
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

    startSuggestionCarousel(code) {
        // [Manim Port] AI Carousel
        const suggestions = [];
        if (/Circle/i.test(code)) suggestions.push('把圆改成红色');
        if (/Square/i.test(code)) suggestions.push('让方块旋转起来');
        if (/Text/i.test(code)) suggestions.push('改变文字字体');
        suggestions.push('添加一个淡入动画', '背景改成深蓝色');

        // Update BOTH mobile and desktop inputs
        const updatePlaceholder = (placeholder) => {
            if (this.elements.aiInput) {
                this.elements.aiInput.placeholder = placeholder;
            }
            if (this.elements.aiInputDesktop) {
                this.elements.aiInputDesktop.placeholder = placeholder;
            }
        };

        let idx = 0;
        // Clear prev interval if stored
        if (this.suggestionInterval) clearInterval(this.suggestionInterval);

        const cycle = () => {
            updatePlaceholder(`试试：${suggestions[idx % suggestions.length]}`);
            idx++;
        };
        cycle();
        this.suggestionInterval = setInterval(cycle, 3000);
    }

    close() {
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
