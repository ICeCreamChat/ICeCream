import { escapeHtml, showToast } from '../utils/helpers.js';

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
        this.recentJobs = [];
        this.failures = [];
        this.replaySummary = '';
        this.initialized = false;
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
        const headerRight = document.querySelector('.header-right');
        if (!headerRight) return;

        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.id = 'manim-workbench-btn';
        this.button.className = 'icon-btn manim-workbench-btn';
        this.button.title = '动画工作台';
        this.button.setAttribute('aria-label', '动画工作台');
        this.button.innerHTML = '<i data-lucide="sliders-horizontal"></i>';
        this.button.addEventListener('click', () => this.toggle());

        const appsBtn = document.getElementById('apps-btn');
        headerRight.insertBefore(this.button, appsBtn || headerRight.firstChild);
        this.refreshIcons();
    }

    createPanel() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'manim-workbench-overlay hidden';
        this.overlay.innerHTML = `
            <aside class="manim-workbench-panel" role="dialog" aria-modal="true" aria-label="动画工作台">
                <header class="manim-workbench-header">
                    <div>
                        <strong>动画工作台</strong>
                        <span>技能、素材、任务和诊断</span>
                    </div>
                    <button type="button" class="manim-workbench-close" aria-label="关闭动画工作台">
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

    setMode(mode) {
        this.mode = mode || 'auto';
        const visible = this.mode === 'manim';
        this.button?.classList.toggle('is-visible', visible);
        this.button?.setAttribute('aria-hidden', String(!visible));
        if (!visible && this.isOpen) {
            this.close();
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
            this.loadJobs(),
            this.loadFailures(),
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
            this.mergeRecentJob(this.currentJob);
        } else if (event.type === 'progress' && this.currentJob) {
            this.currentJob.currentStage = event.step || event.stage || this.currentJob.currentStage;
            this.currentJob.summary = event.message || this.currentJob.summary;
            this.mergeRecentJob(this.currentJob);
        } else if (event.type === 'result') {
            this.handleAgentResult(event);
        } else if (event.type === 'error' && this.currentJob) {
            this.currentJob.status = 'failed';
            this.currentJob.summary = event.error || '生成失败';
            this.mergeRecentJob(this.currentJob);
        }
        this.renderIfOpen();
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
        this.mergeRecentJob(this.currentJob);
        this.loadJobs();
        this.renderIfOpen();
    }

    mergeRecentJob(job) {
        if (!job?.jobId) return;
        this.recentJobs = [job, ...this.recentJobs.filter(item => item.jobId !== job.jobId)].slice(0, 8);
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
        if (this.loading.jobs) return;
        this.loading.jobs = true;
        try {
            const response = await fetch('/api/manim/jobs?limit=8');
            const data = await response.json();
            if (response.ok && Array.isArray(data.jobs)) {
                this.recentJobs = data.jobs.map(normalizeJob);
                if (!this.currentJob && this.recentJobs.length) {
                    this.currentJob = this.recentJobs[0];
                }
            }
        } catch (error) {
            console.warn('[ManimWorkbench] jobs load failed:', error);
        } finally {
            this.loading.jobs = false;
            this.renderIfOpen();
        }
    }

    async loadFailures() {
        if (this.loading.failures) return;
        this.loading.failures = true;
        try {
            const response = await fetch('/api/manim/failures?limit=8');
            const data = await response.json();
            if (response.ok && Array.isArray(data.failures)) {
                this.failures = data.failures;
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
            this.mergeRecentJob(this.currentJob);
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

    async uploadReferenceDataUrl(dataUrl, filename = '参考图.jpg', mimeType = 'image/jpeg') {
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
        };
        this.referenceImages = [reference, ...this.referenceImages.filter(item => item.referenceId !== reference.referenceId)].slice(0, 6);
        showToast('参考图已加入动画工作台', 'success');
        this.renderIfOpen();
        return reference;
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
            ${this.renderDiagnosticsSection()}
        `;
        this.bindPanelActions();
        this.refreshIcons();
    }

    renderSettingsSection() {
        return `
            <section class="manim-workbench-section">
                <div class="manim-workbench-section-head">
                    <strong>生成设置</strong>
                    <span>影响下一次动画生成</span>
                </div>
                <div class="manim-style-grid">
                    ${STYLE_PRESETS.map(style => `
                        <button type="button" class="manim-style-option ${style.id === this.selectedStyle ? 'active' : ''}" data-style-id="${escapeHtml(style.id)}">
                            <span>${escapeHtml(style.name)}</span>
                            <small>${escapeHtml(style.description)}</small>
                        </button>
                    `).join('')}
                </div>
                <div class="manim-workbench-subtitle">运行时技能</div>
                <div class="manim-skill-grid">
                    ${this.skills.map(skill => `
                        <button type="button" class="manim-skill-chip ${this.selectedSkillIds.has(skill.id) ? 'active' : ''}" data-skill-id="${escapeHtml(skill.id)}" title="${escapeHtml(skill.guidance || '')}">
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
                        <span>${item.width && item.height ? `${item.width} × ${item.height}` : '下一次生成会携带此素材'}</span>
                    </div>
                    <button type="button" class="manim-reference-remove" data-reference-id="${escapeHtml(item.referenceId || '')}" aria-label="移除参考图">
                        <i data-lucide="x"></i>
                    </button>
                </div>
            `).join('')
            : '<div class="manim-workbench-empty">可上传参考图，让动画更贴近示例。</div>';
        return `
            <section class="manim-workbench-section">
                <div class="manim-workbench-section-head">
                    <strong>参考素材</strong>
                    <button type="button" class="manim-workbench-link" data-action="upload-reference">添加参考图</button>
                </div>
                <div class="manim-reference-list">${refs}</div>
            </section>
        `;
    }

    renderJobsSection() {
        const current = this.currentJob;
        const currentHtml = current?.jobId
            ? `
                <div class="manim-current-job">
                    <div>
                        <strong>${escapeHtml(current.jobId)}</strong>
                        <span>${escapeHtml(formatJobStatus(current.status))}${current.currentStage ? ` · ${escapeHtml(current.currentStage)}` : ''}</span>
                    </div>
                    <button type="button" class="manim-workbench-secondary" data-action="cancel-job">取消</button>
                    ${current.summary ? `<p>${escapeHtml(current.summary)}</p>` : ''}
                </div>
            `
            : '<div class="manim-workbench-empty">发送动画请求后，这里会显示制作状态。</div>';
        const recentHtml = this.recentJobs.length
            ? this.recentJobs.slice(0, 5).map(job => `
                <div class="manim-job-row">
                    <span>${escapeHtml(job.jobId || '未命名任务')}</span>
                    <strong>${escapeHtml(formatJobStatus(job.status))}</strong>
                </div>
            `).join('')
            : '<div class="manim-workbench-empty compact">暂无最近任务。</div>';
        return `
            <section class="manim-workbench-section">
                <div class="manim-workbench-section-head">
                    <strong>任务状态</strong>
                    <button type="button" class="manim-workbench-link" data-action="refresh-jobs">刷新</button>
                </div>
                ${currentHtml}
                <div class="manim-workbench-subtitle">最近任务</div>
                <div class="manim-job-list">${recentHtml}</div>
            </section>
        `;
    }

    renderDiagnosticsSection() {
        const failuresHtml = this.failures.length
            ? this.failures.slice(0, 6).map(item => {
                const eventId = item.eventId || item.id || '';
                return `
                    <div class="manim-failure-row">
                        <div>
                            <strong>${escapeHtml(item.prompt || item.message || item.stage || '失败样本')}</strong>
                            <span>${escapeHtml(item.reason || item.error || item.summary || '可回放静态诊断')}</span>
                        </div>
                        <button type="button" class="manim-workbench-secondary" data-replay-id="${escapeHtml(eventId)}">回放</button>
                    </div>
                `;
            }).join('')
            : '<div class="manim-workbench-empty">暂无失败记录。</div>';
        return `
            <details class="manim-workbench-section manim-workbench-diagnostics">
                <summary>
                    <strong>高级诊断</strong>
                    <span>失败样本、规则命中、缓存与 Job 信息</span>
                </summary>
                ${this.replaySummary ? `<div class="manim-diagnostic-note">${escapeHtml(this.replaySummary)}</div>` : ''}
                <div class="manim-failure-list">${failuresHtml}</div>
                <button type="button" class="manim-workbench-link" data-action="refresh-failures">刷新失败样本</button>
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
        this.body?.querySelector('[data-action="upload-reference"]')?.addEventListener('click', () => this.fileInput?.click());
        this.body?.querySelector('[data-action="refresh-jobs"]')?.addEventListener('click', () => this.loadJobs());
        this.body?.querySelector('[data-action="refresh-failures"]')?.addEventListener('click', () => this.loadFailures());
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
