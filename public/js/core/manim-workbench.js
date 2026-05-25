import { escapeHtml, showToast } from '../utils/helpers.js';
import { ManimSketchPad } from './manim-sketch-pad.js';

const FALLBACK_SKILLS = [
    { id: 'function_graph', name: '函数图像', guidance: '符号刻度、分阶段绘制曲线、关键点标注。' },
    { id: 'geometry', name: '几何证明', guidance: '清晰线条、角标和标签，避免文字重叠。' },
    { id: 'data_visualization', name: '数据图表', guidance: '柱状图、折线图和趋势结论。' },
    { id: 'flow_explanation', name: '流程解释', guidance: '节点、箭头和分步状态转移。' },
    { id: 'physics_motion', name: '物理运动', guidance: '轨迹、方向、速度和受力标注。' },
    { id: 'text_formula_layout', name: '文字公式布局', guidance: '中文用 Text，公式用 MathTex。' },
];

const STYLE_PRESETS = [
    {
        id: 'teaching_premium',
        name: '精品教学',
        description: '浅色画布、清晰分区、适合默认课堂讲解。',
        skillIds: [],
    },
    {
        id: 'middle_school_math',
        name: '初中数学',
        description: '定义更清楚，步骤更少，标签更易读。',
        skillIds: ['middle_school_math'],
    },
    {
        id: 'blackboard_style',
        name: '黑板风格',
        description: '适合明确需要板书氛围的讲解。',
        skillIds: ['blackboard_style'],
    },
    {
        id: 'short_video_style',
        name: '短视频风格',
        description: '节奏更快，每屏只保留一个重点。',
        skillIds: ['short_video_style'],
    },
    {
        id: 'competition_geometry',
        name: '竞赛几何',
        description: '强化辅助线、角标和公式推导。',
        skillIds: ['geometry', 'formula_derivation'],
    },
];

const WORKBENCH_POSITION_KEY = 'icecream_manim_workbench_position_v1';
const WORKBENCH_VIEWPORT_MARGIN = 12;
const WORKBENCH_DESKTOP_QUERY = '(min-width: 769px)';

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function normalizeJob(job = {}) {
    return {
        jobId: job.jobId || job.id || '',
        status: job.status || 'pending',
        currentStage: job.currentStage || job.current_stage || job.stage || '',
        summary: job.summary || job.message || '',
        updatedAt: job.updatedAt || job.updated_at || '',
    };
}

function formatJobStatus(status = '') {
    const map = {
        pending: '等待中',
        running: '运行中',
        completed: '已完成',
        success: '已完成',
        failed: '失败',
        cancelled: '已取消',
        cancel_requested: '正在取消',
    };
    return map[String(status).toLowerCase()] || status || '未知';
}

function formatJobStatusClass(status = '') {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'completed' || normalized === 'success') return 'success';
    if (normalized === 'failed') return 'error';
    if (normalized === 'cancelled' || normalized === 'cancel_requested') return 'warning';
    if (normalized === 'running') return 'active';
    return 'idle';
}

function formatJobStage(stage = '') {
    const map = {
        planner: '理解需求',
        plan: '理解需求',
        reference: '参考素材',
        storyboard: '设计分镜',
        style: '教学风格',
        skills: '选择技能',
        coder: '生成代码',
        critic: '静态检查',
        inspect: '布局检查',
        preview: '视觉检查',
        visual_check: '视觉检查',
        repair: '自动修复',
        render: '最终渲染',
    };
    return map[String(stage || '').toLowerCase()] || stage || '等待开始';
}

function shortJobId(jobId = '') {
    const value = String(jobId || '').trim();
    if (!value) return '未命名任务';
    return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function formatReferenceMeta(item = {}) {
    if (item.width && item.height) {
        return `${item.width} × ${item.height}`;
    }
    return '下次生成会携带此素材';
}

function canCancelJob(status = '') {
    return ['pending', 'running', 'cancel_requested'].includes(String(status || '').toLowerCase());
}

class ManimWorkbench {
    constructor() {
        this.button = null;
        this.overlay = null;
        this.panel = null;
        this.body = null;
        this.fileInput = null;
        this.mode = 'auto';
        this.isOpen = false;
        this.loading = {
            skills: false,
            jobs: false,
            failures: false,
        };
        this.skills = FALLBACK_SKILLS;
        this.selectedSkillIds = new Set();
        this.selectedStyle = 'teaching_premium';
        this.referenceImages = [];
        this.currentJob = null;
        this.sessionFailures = [];
        this.globalFailures = [];
        this.globalFailuresLoaded = false;
        this.replaySummary = '';
        this.initialized = false;
        this.dragState = null;
        this.sketchPad = null;
        this.handleWorkbenchResize = this.handleWorkbenchResize.bind(this);
        this.handleDragMove = this.handleDragMove.bind(this);
        this.handleDragEnd = this.handleDragEnd.bind(this);
    }

    init({ modeSwitcher } = {}) {
        if (this.initialized) return;
        this.initialized = true;
        this.mode = modeSwitcher?.getMode?.() || 'auto';
        this.createButton();
        this.createPanel();
        this.setMode(this.mode);
        this.render();
    }

    createButton() {
        const manimTab = document.querySelector('.mode-tab[data-mode="manim"]');
        if (!manimTab?.parentElement) return;

        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.id = 'manim-workbench-btn';
        this.button.className = 'manim-workbench-btn manim-workbench-tab';
        this.button.title = 'Manim 工作台';
        this.button.setAttribute('aria-label', 'Manim 工作台');
        this.button.innerHTML = '<i data-lucide="sliders-horizontal"></i><span>Manim</span>';
        this.button.addEventListener('click', () => this.toggle());

        manimTab.insertAdjacentElement('afterend', this.button);
        this.refreshIcons();
    }

    createPanel() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'manim-workbench-overlay hidden';
        this.overlay.innerHTML = `
            <aside class="manim-workbench-panel" role="dialog" aria-modal="true" aria-label="Manim 工作台">
                <header class="manim-workbench-header">
                    <div class="manim-workbench-title-block">
                        <span class="manim-workbench-eyebrow">Manim 制作台</span>
                        <strong>Manim 工作台</strong>
                        <span>配置素材、技能和当前任务</span>
                    </div>
                    <button type="button" class="manim-workbench-close" aria-label="关闭 Manim 工作台">
                        <i data-lucide="x"></i>
                    </button>
                </header>
                <div class="manim-workbench-body"></div>
                <input class="manim-workbench-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
            </aside>
        `;
        document.body.appendChild(this.overlay);
        this.panel = this.overlay.querySelector('.manim-workbench-panel');
        this.body = this.overlay.querySelector('.manim-workbench-body');
        this.fileInput = this.overlay.querySelector('.manim-workbench-file');

        this.initDragControls();

        this.overlay.addEventListener('click', (event) => {
            if (event.target === this.overlay) {
                this.close();
            }
        });
        this.overlay.querySelector('.manim-workbench-close')?.addEventListener('click', () => this.close());
        this.fileInput?.addEventListener('change', async () => {
            const file = this.fileInput?.files?.[0];
            this.fileInput.value = '';
            if (file) {
                await this.uploadReferenceFile(file);
            }
        });
    }

    initDragControls() {
        const header = this.overlay?.querySelector('.manim-workbench-header');
        if (!header || !this.panel) return;

        header.classList.add('manim-workbench-drag-handle');
        header.tabIndex = 0;
        header.title = '\u62d6\u52a8\u8c03\u6574\u4f4d\u7f6e\uff0c\u53cc\u51fb\u6062\u590d\u9ed8\u8ba4\u4f4d\u7f6e';
        header.setAttribute('aria-label', '拖动 Manim 工作台，双击恢复默认位置');
        header.addEventListener('pointerdown', (event) => this.handleDragStart(event));
        header.addEventListener('dblclick', () => this.resetWorkbenchPosition());
        header.addEventListener('keydown', (event) => this.handleDragKeydown(event));
        window.addEventListener('resize', this.handleWorkbenchResize);
    }

    isDesktopWorkbench() {
        return typeof window !== 'undefined' && window.matchMedia(WORKBENCH_DESKTOP_QUERY).matches;
    }

    isInteractiveDragTarget(target) {
        return Boolean(target?.closest?.('button, a, input, select, textarea, label, summary, [data-no-drag]'));
    }

    getPanelSize() {
        const rect = this.panel?.getBoundingClientRect?.();
        return {
            width: rect?.width || this.panel?.offsetWidth || Math.min(408, window.innerWidth - 32),
            height: rect?.height || this.panel?.offsetHeight || Math.min(860, window.innerHeight - 36),
        };
    }

    getDefaultWorkbenchPosition() {
        const { width } = this.getPanelSize();
        return {
            left: window.innerWidth - width - 18,
            top: 18,
        };
    }

    getCurrentWorkbenchPosition() {
        const rect = this.panel?.getBoundingClientRect?.();
        return {
            left: rect?.left || this.getDefaultWorkbenchPosition().left,
            top: rect?.top || this.getDefaultWorkbenchPosition().top,
        };
    }

    clampWorkbenchPosition(position = {}) {
        const { width, height } = this.getPanelSize();
        const maxLeft = Math.max(WORKBENCH_VIEWPORT_MARGIN, window.innerWidth - width - WORKBENCH_VIEWPORT_MARGIN);
        const maxTop = Math.max(WORKBENCH_VIEWPORT_MARGIN, window.innerHeight - height - WORKBENCH_VIEWPORT_MARGIN);
        const left = Number.isFinite(position.left) ? position.left : this.getDefaultWorkbenchPosition().left;
        const top = Number.isFinite(position.top) ? position.top : this.getDefaultWorkbenchPosition().top;

        return {
            left: Math.min(Math.max(WORKBENCH_VIEWPORT_MARGIN, left), maxLeft),
            top: Math.min(Math.max(WORKBENCH_VIEWPORT_MARGIN, top), maxTop),
        };
    }

    loadWorkbenchPosition() {
        try {
            const value = window.localStorage?.getItem(WORKBENCH_POSITION_KEY);
            if (!value) return null;
            const parsed = JSON.parse(value);
            if (!Number.isFinite(parsed?.left) || !Number.isFinite(parsed?.top)) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    saveWorkbenchPosition(position) {
        try {
            window.localStorage?.setItem(WORKBENCH_POSITION_KEY, JSON.stringify(position));
        } catch {
            // Position persistence is a convenience; dragging should still work without storage.
        }
    }

    clearWorkbenchPositionStyles() {
        if (!this.panel) return;
        this.panel.classList.remove('is-positioned', 'is-dragging');
        this.panel.style.left = '';
        this.panel.style.top = '';
    }

    setWorkbenchPosition(position, { persist = false } = {}) {
        if (!this.panel || !this.isDesktopWorkbench()) {
            this.clearWorkbenchPositionStyles();
            return null;
        }

        const nextPosition = this.clampWorkbenchPosition(position);
        this.panel.classList.add('is-positioned');
        this.panel.style.left = `${Math.round(nextPosition.left)}px`;
        this.panel.style.top = `${Math.round(nextPosition.top)}px`;
        if (persist) {
            this.saveWorkbenchPosition(nextPosition);
        }
        return nextPosition;
    }

    applyInitialWorkbenchPosition() {
        if (!this.panel) return;
        if (!this.isDesktopWorkbench()) {
            this.clearWorkbenchPositionStyles();
            return;
        }

        requestAnimationFrame(() => {
            if (!this.isOpen) return;
            const storedPosition = this.loadWorkbenchPosition();
            this.setWorkbenchPosition(storedPosition || this.getDefaultWorkbenchPosition());
        });
    }

    resetWorkbenchPosition() {
        if (!this.isDesktopWorkbench()) return;
        this.setWorkbenchPosition(this.getDefaultWorkbenchPosition(), { persist: true });
    }

    handleWorkbenchResize() {
        if (!this.panel) return;
        if (!this.isDesktopWorkbench()) {
            this.clearWorkbenchPositionStyles();
            return;
        }
        if (this.isOpen) {
            this.setWorkbenchPosition(this.getCurrentWorkbenchPosition(), { persist: true });
        }
    }

    handleDragStart(event) {
        if (!this.panel || !this.isDesktopWorkbench()) return;
        if (event.button !== 0 || this.isInteractiveDragTarget(event.target)) return;

        const rect = this.panel.getBoundingClientRect();
        this.dragState = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
        };
        this.panel.classList.add('is-dragging');
        this.setWorkbenchPosition({ left: rect.left, top: rect.top });
        event.preventDefault();

        window.addEventListener('pointermove', this.handleDragMove);
        window.addEventListener('pointerup', this.handleDragEnd);
        window.addEventListener('pointercancel', this.handleDragEnd);
    }

    handleDragMove(event) {
        if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
        event.preventDefault();
        this.setWorkbenchPosition({
            left: event.clientX - this.dragState.offsetX,
            top: event.clientY - this.dragState.offsetY,
        });
    }

    handleDragEnd(event) {
        if (this.dragState && event.pointerId === this.dragState.pointerId) {
            this.setWorkbenchPosition(this.getCurrentWorkbenchPosition(), { persist: true });
        }
        this.dragState = null;
        this.panel?.classList.remove('is-dragging');
        window.removeEventListener('pointermove', this.handleDragMove);
        window.removeEventListener('pointerup', this.handleDragEnd);
        window.removeEventListener('pointercancel', this.handleDragEnd);
    }

    handleDragKeydown(event) {
        if (!this.isDesktopWorkbench()) return;
        const step = event.shiftKey ? 48 : 16;
        const current = this.getCurrentWorkbenchPosition();
        const next = { ...current };

        if (event.key === 'ArrowLeft') next.left -= step;
        else if (event.key === 'ArrowRight') next.left += step;
        else if (event.key === 'ArrowUp') next.top -= step;
        else if (event.key === 'ArrowDown') next.top += step;
        else if (event.key === 'Home') {
            event.preventDefault();
            this.resetWorkbenchPosition();
            return;
        } else {
            return;
        }

        event.preventDefault();
        this.setWorkbenchPosition(next, { persist: true });
    }

    setMode(mode) {
        this.mode = mode || 'auto';
        const visible = this.mode === 'manim';
        this.button?.classList.toggle('is-visible', visible);
        this.button?.setAttribute('aria-hidden', String(!visible));
        if (!visible && this.isOpen) {
            this.close();
        }
        if (!visible) {
            this.resetSessionRuntime();
        }
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        this.isOpen = true;
        this.overlay?.classList.remove('hidden');
        this.overlay?.classList.add('open');
        this.button?.classList.add('active');
        this.applyInitialWorkbenchPosition();
        this.loadInitialData();
        this.render();
    }

    close() {
        this.isOpen = false;
        this.overlay?.classList.remove('open');
        this.overlay?.classList.add('hidden');
        this.button?.classList.remove('active');
    }

    async loadInitialData() {
        await Promise.allSettled([
            this.loadSkills(),
        ]);
    }

    getAgentOptions() {
        const preset = STYLE_PRESETS.find(item => item.id === this.selectedStyle) || STYLE_PRESETS[0];
        return {
            skillIds: unique([...this.selectedSkillIds, ...(preset.skillIds || [])]),
            referenceImageIds: this.referenceImages.map(item => item.referenceId).filter(Boolean),
        };
    }

    handleAgentEvent(event = {}) {
        if (event.type === 'job' && event.job) {
            this.currentJob = normalizeJob(event.job);
        } else if (event.type === 'progress' && this.currentJob) {
            this.currentJob.currentStage = event.step || event.stage || this.currentJob.currentStage;
            this.currentJob.summary = event.message || this.currentJob.summary;
        } else if (event.type === 'reference') {
            this.mergeReferenceAnalysis(event);
        } else if (event.type === 'result') {
            this.handleAgentResult(event);
        } else if (event.type === 'error' && this.currentJob) {
            this.currentJob.status = 'failed';
            this.currentJob.summary = event.error || '生成失败';
        }
        this.renderIfOpen();
    }

    mergeReferenceAnalysis(event = {}) {
        const specs = event.referenceSpecs || [];
        if (!specs.length) return;
        const byId = new Map(specs.map(item => [item.referenceId, item]));
        this.referenceImages = this.referenceImages.map(item => {
            const spec = byId.get(item.referenceId);
            if (!spec) return item;
            return {
                ...item,
                analysisStatus: spec.status || 'pass',
                analysisSummary: spec.summary || spec.warning || '参考图已解析',
                analysisWarnings: spec.warnings || [],
            };
        });
    }

    handleAgentResult(result = {}) {
        if (!this.currentJob) {
            this.currentJob = normalizeJob({
                jobId: result.agentTrace?.jobId || '',
                status: result.rendered ? 'completed' : 'failed',
                currentStage: 'render',
                summary: result.rendered ? '最终动画已生成' : (result.warning || result.error || '未生成视频'),
            });
        } else {
            this.currentJob.status = result.rendered ? 'completed' : 'failed';
            this.currentJob.currentStage = 'render';
            this.currentJob.summary = result.rendered ? '最终动画已生成' : (result.warning || result.error || '未生成视频');
        }
        this.captureSessionFailure(result);
        this.renderIfOpen();
    }

    captureSessionFailure(result = {}) {
        const hasProblem = result.success === false || !result.rendered || Boolean(result.warning || result.error);
        if (!hasProblem) return;

        const trace = result.agentTrace || {};
        const eventId = trace.failureEventId || result.failureEventId || '';
        const item = {
            id: eventId || `session-${Date.now()}`,
            eventId,
            source: 'session',
            message: trace.brief?.message || result.message || this.currentJob?.summary || '当前动画请求',
            summary: result.warning || result.error || trace.failureReason || '当前请求未生成可用视频',
            stage: this.currentJob?.currentStage || 'agent_result',
        };
        this.sessionFailures = [
            item,
            ...this.sessionFailures.filter(existing => (existing.eventId || existing.id) !== (item.eventId || item.id)),
        ].slice(0, 6);
    }

    resetSessionRuntime() {
        this.currentJob = null;
        this.sessionFailures = [];
        this.globalFailures = [];
        this.globalFailuresLoaded = false;
        this.replaySummary = '';
        this.renderIfOpen();
    }

    isDebugMode() {
        try {
            return window.localStorage?.getItem('icecream_manim_debug') === '1';
        } catch {
            return false;
        }
    }

    async loadSkills() {
        if (this.loading.skills) return;
        this.loading.skills = true;
        try {
            const response = await fetch('/api/manim/skills');
            const data = await response.json();
            if (response.ok && Array.isArray(data.skills) && data.skills.length) {
                this.skills = data.skills;
            }
        } catch (error) {
            console.warn('[ManimWorkbench] skills load failed:', error);
        } finally {
            this.loading.skills = false;
            this.renderIfOpen();
        }
    }

    async loadJobs() {
        if (this.loading.jobs) return [];
        this.loading.jobs = true;
        try {
            const response = await fetch('/api/manim/jobs?limit=8');
            const data = await response.json();
            return response.ok && Array.isArray(data.jobs) ? data.jobs.map(normalizeJob) : [];
        } catch (error) {
            console.warn('[ManimWorkbench] jobs load failed:', error);
            return [];
        } finally {
            this.loading.jobs = false;
        }
    }

    async loadFailures() {
        if (!this.isDebugMode()) return;
        if (this.loading.failures) return;
        this.loading.failures = true;
        try {
            const response = await fetch('/api/manim/failures?limit=8');
            const data = await response.json();
            if (response.ok && Array.isArray(data.failures)) {
                this.globalFailures = data.failures.map(item => ({ ...item, source: 'global' }));
                this.globalFailuresLoaded = true;
            }
        } catch (error) {
            console.warn('[ManimWorkbench] failures load failed:', error);
        } finally {
            this.loading.failures = false;
            this.renderIfOpen();
        }
    }

    async cancelCurrentJob() {
        const jobId = this.currentJob?.jobId;
        if (!jobId) return;
        try {
            const response = await fetch(`/api/manim/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok || data.success === false) {
                throw new Error(data.error || '取消任务失败');
            }
            this.currentJob = normalizeJob(data.job || { ...this.currentJob, status: 'cancelled' });
            showToast('已请求取消当前动画任务', 'success');
        } catch (error) {
            showToast(error.message || '取消任务失败', 'error');
        } finally {
            this.renderIfOpen();
        }
    }

    async replayFailure(eventId) {
        if (!eventId) return;
        this.replaySummary = '正在回放失败样本...';
        this.renderIfOpen();
        try {
            const response = await fetch(`/api/manim/failures/${encodeURIComponent(eventId)}/replay`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok || data.success === false) {
                throw new Error(data.error || '回放失败样本失败');
            }
            const samples = data.replay?.samples || [];
            this.replaySummary = samples.length
                ? `回放完成：${samples.length} 条样本已重新检查。`
                : '回放完成，暂无可展示样本。';
            showToast('失败样本回放完成', 'success');
        } catch (error) {
            this.replaySummary = error.message || '回放失败样本失败';
            showToast(this.replaySummary, 'error');
        } finally {
            this.renderIfOpen();
        }
    }

    validateReferenceFile(file) {
        const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
        const maxSize = 8 * 1024 * 1024;
        if (!allowedTypes.includes(file.type)) {
            throw new Error('请上传 PNG、JPG 或 WebP 参考图');
        }
        if (file.size > maxSize) {
            throw new Error('参考图不能超过 8MB');
        }
    }

    readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('读取参考图失败'));
            reader.readAsDataURL(file);
        });
    }

    async uploadReferenceDataUrl(dataUrl, filename = '参考图.jpg', mimeType = 'image/jpeg', options = {}) {
        const dataBase64 = String(dataUrl || '').split(',')[1] || '';
        if (!dataBase64) {
            throw new Error('参考图数据为空');
        }

        const response = await fetch('/api/manim/reference-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename,
                mimeType,
                dataBase64,
            }),
        });
        const data = await response.json();
        if (!response.ok || data.success === false) {
            throw new Error(data.error || '参考图上传失败');
        }
        const reference = {
            ...(data.reference || {}),
            previewDataUrl: dataUrl,
            filename: data.reference?.filename || filename,
            analysisStatus: 'uploaded',
            analysisSummary: '已上传，生成时会解析参考图。',
        };
        this.referenceImages = [reference, ...this.referenceImages.filter(item => item.referenceId !== reference.referenceId)].slice(0, 6);
        if (!options.silent) {
            showToast('参考图已加入 Manim 工作台', 'success');
        }
        this.renderIfOpen();
        return reference;
    }

    async uploadSketchReferences(exports = []) {
        if (!exports.length) {
            throw new Error('手绘参考图为空');
        }

        for (let index = exports.length - 1; index >= 0; index -= 1) {
            const item = exports[index];
            await this.uploadReferenceDataUrl(
                item.dataUrl,
                item.filename || `手绘参考图-${String(index + 1).padStart(2, '0')}.png`,
                'image/png',
                { silent: true },
            );
        }

        showToast(`已加入 ${exports.length} 张手绘参考图`, 'success');
        this.renderIfOpen();
    }

    async uploadReferenceFile(file) {
        try {
            this.validateReferenceFile(file);
            const dataUrl = await this.readFileAsDataUrl(file);
            await this.uploadReferenceDataUrl(dataUrl, file.name, file.type);
        } catch (error) {
            showToast(error.message || '参考图上传失败', 'error');
        } finally {
            this.renderIfOpen();
        }
    }

    removeReference(referenceId) {
        this.referenceImages = this.referenceImages.filter(item => item.referenceId !== referenceId);
        this.renderIfOpen();
    }

    openSketchPad() {
        if (!this.sketchPad) {
            this.sketchPad = new ManimSketchPad({
                onComplete: (exports) => this.uploadSketchReferences(exports),
            });
        }
        this.sketchPad.open();
    }

    toggleSkill(skillId) {
        if (this.selectedSkillIds.has(skillId)) {
            this.selectedSkillIds.delete(skillId);
        } else {
            this.selectedSkillIds.add(skillId);
        }
        this.renderIfOpen();
    }

    setStyle(styleId) {
        this.selectedStyle = styleId;
        this.renderIfOpen();
    }

    renderIfOpen() {
        if (this.isOpen) {
            this.render();
        }
    }

    render() {
        if (!this.body) return;
        this.body.innerHTML = `
            ${this.renderSettingsSection()}
            ${this.renderReferenceSection()}
            ${this.renderJobsSection()}
            ${this.isDebugMode() ? this.renderDebugDiagnosticsSection() : ''}
        `;
        this.bindPanelActions();
        this.refreshIcons();
    }

    renderSettingsSection() {
        const selectedStyle = STYLE_PRESETS.find(style => style.id === this.selectedStyle) || STYLE_PRESETS[0];
        const selectedSkillCount = this.getAgentOptions().skillIds.length;
        return `
            <section class="manim-workbench-section manim-workbench-config">
                <div class="manim-workbench-section-head">
                    <strong>生成设置</strong>
                    <span>下一次动画会使用这些选项</span>
                </div>
                <div class="manim-config-summary">
                    <div>
                        <span>教学风格</span>
                        <strong>${escapeHtml(selectedStyle.name)}</strong>
                    </div>
                    <div>
                        <span>已选技能</span>
                        <strong>${selectedSkillCount} 项</strong>
                    </div>
                </div>
                <div class="manim-workbench-subtitle">教学风格</div>
                <div class="manim-style-list">
                    ${STYLE_PRESETS.map(style => `
                        <button type="button" class="manim-style-option ${style.id === this.selectedStyle ? 'active' : ''}" data-style-id="${escapeHtml(style.id)}">
                            <span>
                                <strong>${escapeHtml(style.name)}</strong>
                                <small>${escapeHtml(style.description)}</small>
                            </span>
                            <i data-lucide="${style.id === this.selectedStyle ? 'check-circle-2' : 'circle'}"></i>
                        </button>
                    `).join('')}
                </div>
                <div class="manim-workbench-subtitle">运行时技能</div>
                <div class="manim-skill-grid">
                    ${this.skills.map(skill => `
                        <button type="button" class="manim-skill-chip ${this.selectedSkillIds.has(skill.id) ? 'active' : ''}" data-skill-id="${escapeHtml(skill.id)}" title="${escapeHtml(skill.guidance || '')}">
                            <i data-lucide="${this.selectedSkillIds.has(skill.id) ? 'check' : 'plus'}"></i>
                            <span>${escapeHtml(skill.name || skill.id)}</span>
                        </button>
                    `).join('')}
                </div>
            </section>
        `;
    }

    renderReferenceSection() {
        const refs = this.referenceImages.length
            ? this.referenceImages.map(item => `
                <div class="manim-reference-item">
                    <img src="${escapeHtml(item.previewDataUrl || '')}" alt="${escapeHtml(item.filename || '参考图')}">
                    <div>
                        <strong>${escapeHtml(item.filename || item.referenceId || '参考图')}</strong>
                        <span>${escapeHtml(item.analysisSummary || formatReferenceMeta(item))}</span>
                    </div>
                    <button type="button" class="manim-reference-remove" data-reference-id="${escapeHtml(item.referenceId || '')}" aria-label="移除参考图">
                        <i data-lucide="x"></i>
                    </button>
                </div>
            `).join('')
            : '<div class="manim-workbench-empty compact">暂无参考图。上传后会随下一次动画生成一起发送。</div>';
        return `
            <section class="manim-workbench-section manim-workbench-reference">
                <div class="manim-workbench-section-head">
                    <strong>参考素材</strong>
                    <span>只服务动画生成</span>
                </div>
                <div class="manim-reference-actions">
                    <button type="button" class="manim-reference-dropzone" data-action="upload-reference">
                        <i data-lucide="image-plus"></i>
                        <span>
                            <strong>上传参考图</strong>
                            <small>PNG、JPG、WebP，最多 8MB</small>
                        </span>
                    </button>
                    <button type="button" class="manim-reference-dropzone manim-reference-sketch" data-action="draw-reference">
                        <i data-lucide="pencil-line"></i>
                        <span>
                            <strong>在线手绘</strong>
                            <small>没有图片时，直接画草图</small>
                        </span>
                    </button>
                </div>
                <div class="manim-reference-list">${refs}</div>
            </section>
        `;
    }

    renderJobsSection() {
        const current = this.currentJob;
        if (!current?.jobId) return '';

        const showCancel = canCancelJob(current.status);
        return `
            <section class="manim-workbench-section manim-workbench-jobs">
                <div class="manim-workbench-section-head">
                    <strong>当前任务</strong>
                    <span>仅显示本次会话</span>
                </div>
                <div class="manim-current-job">
                    <div class="manim-current-job-main">
                        <span class="manim-status-badge ${escapeHtml(formatJobStatusClass(current.status))}">${escapeHtml(formatJobStatus(current.status))}</span>
                        <strong title="${escapeHtml(current.jobId)}">${escapeHtml(shortJobId(current.jobId))}</strong>
                        <small>${escapeHtml(formatJobStage(current.currentStage))}</small>
                    </div>
                    ${showCancel ? '<button type="button" class="manim-workbench-secondary" data-action="cancel-job">取消</button>' : ''}
                    ${current.summary ? `<p>${escapeHtml(current.summary)}</p>` : ''}
                </div>
            </section>
        `;
    }

    renderDebugDiagnosticsSection() {
        const failureItems = [
            ...this.sessionFailures,
            ...(this.globalFailuresLoaded ? this.globalFailures : []),
        ];
        const seenFailureIds = new Set();
        const visibleFailures = failureItems.filter(item => {
            const key = item.eventId || item.id || item.message || item.stage || Math.random();
            if (seenFailureIds.has(key)) return false;
            seenFailureIds.add(key);
            return true;
        }).slice(0, 6);
        const failuresHtml = visibleFailures.length
            ? visibleFailures.map(item => {
                const eventId = item.eventId || item.id || '';
                const sourceLabel = item.source === 'global' ? '历史样本' : '当前会话';
                return `
                    <div class="manim-failure-row">
                        <div>
                            <strong>${escapeHtml(item.prompt || item.message || item.stage || '失败样本')}</strong>
                            <span>${escapeHtml(sourceLabel)} · ${escapeHtml(item.reason || item.error || item.summary || '可回放静态诊断')}</span>
                        </div>
                        ${eventId ? `<button type="button" class="manim-workbench-secondary" data-replay-id="${escapeHtml(eventId)}">回放</button>` : ''}
                    </div>
                `;
            }).join('')
            : '<div class="manim-workbench-empty">当前会话暂无失败记录。全局失败样本不会自动展示。</div>';
        const refreshLabel = this.globalFailuresLoaded ? '刷新全局失败样本' : '加载全局失败样本';

        return `
            <details class="manim-workbench-section manim-workbench-diagnostics manim-workbench-debug">
                <summary>
                    <span>
                        <strong>开发诊断</strong>
                        <small>仅调试使用；全局失败样本需手动加载</small>
                    </span>
                    <i data-lucide="chevron-down"></i>
                </summary>
                ${this.replaySummary ? `<div class="manim-diagnostic-note">${escapeHtml(this.replaySummary)}</div>` : ''}
                <div class="manim-failure-list">${failuresHtml}</div>
                <button type="button" class="manim-workbench-link" data-action="refresh-failures">${refreshLabel}</button>
            </details>
        `;
    }

    bindPanelActions() {
        this.body?.querySelectorAll('[data-style-id]').forEach(button => {
            button.addEventListener('click', () => this.setStyle(button.dataset.styleId));
        });
        this.body?.querySelectorAll('[data-skill-id]').forEach(button => {
            button.addEventListener('click', () => this.toggleSkill(button.dataset.skillId));
        });
        this.body?.querySelectorAll('[data-action="upload-reference"]').forEach(button => {
            button.addEventListener('click', () => this.fileInput?.click());
        });
        this.body?.querySelectorAll('[data-action="draw-reference"]').forEach(button => {
            button.addEventListener('click', () => this.openSketchPad());
        });
        this.body?.querySelectorAll('[data-action="refresh-failures"]').forEach(button => {
            button.addEventListener('click', () => this.loadFailures());
        });
        this.body?.querySelector('[data-action="cancel-job"]')?.addEventListener('click', () => this.cancelCurrentJob());
        this.body?.querySelectorAll('[data-reference-id]').forEach(button => {
            button.addEventListener('click', () => this.removeReference(button.dataset.referenceId));
        });
        this.body?.querySelectorAll('[data-replay-id]').forEach(button => {
            button.addEventListener('click', () => this.replayFailure(button.dataset.replayId));
        });
    }

    refreshIcons() {
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }
}

export const manimWorkbench = new ManimWorkbench();
