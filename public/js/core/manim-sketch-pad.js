import { showToast } from '../utils/helpers.js';

const MAX_SKETCH_PAGES = 4;
const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const DEFAULT_COLORS = ['#111827', '#0284C7', '#16A34A', '#DC2626', '#F59E0B'];

function createPage(index = 1) {
    return {
        id: `sketch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        title: `草图 ${index}`,
        strokes: [],
        redoStack: [],
    };
}

function hasStrokeContent(page) {
    return Boolean(page?.strokes?.some(stroke => stroke.points?.length > 1));
}

export class ManimSketchPad {
    constructor({ onComplete } = {}) {
        this.onComplete = onComplete;
        this.overlay = null;
        this.shell = null;
        this.canvas = null;
        this.ctx = null;
        this.pages = [createPage(1)];
        this.activePageId = this.pages[0].id;
        this.tool = 'pen';
        this.color = DEFAULT_COLORS[1];
        this.width = 5;
        this.gridVisible = true;
        this.currentStroke = null;
        this.pointerId = null;
        this.dirty = false;
        this.exporting = false;
        this.boundResize = this.resizeCanvas.bind(this);
        this.boundKeydown = this.handleKeydown.bind(this);
    }

    open() {
        if (!this.overlay) {
            this.createOverlay();
        }

        this.resetDraft();
        this.overlay.classList.remove('hidden');
        document.body.classList.add('manim-sketch-open');
        this.render();
        requestAnimationFrame(() => this.resizeCanvas());
        window.addEventListener('resize', this.boundResize);
        window.addEventListener('keydown', this.boundKeydown);
    }

    resetDraft() {
        this.pages = [createPage(1)];
        this.activePageId = this.pages[0].id;
        this.tool = 'pen';
        this.color = DEFAULT_COLORS[1];
        this.width = 5;
        this.gridVisible = true;
        this.currentStroke = null;
        this.pointerId = null;
        this.dirty = false;
        this.exporting = false;
    }

    createOverlay() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'manim-sketch-overlay hidden';
        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (event) => {
            if (event.target === this.overlay) {
                this.requestClose();
            }
        });
    }

    get activePage() {
        return this.pages.find(page => page.id === this.activePageId) || this.pages[0];
    }

    render() {
        if (!this.overlay) return;

        this.overlay.innerHTML = `
            <section class="manim-sketch-shell" role="dialog" aria-modal="true" aria-label="在线手绘参考图">
                <header class="manim-sketch-header">
                    <div>
                        <span>参考素材</span>
                        <strong>在线手绘</strong>
                        <small>画一个草图，作为下一次动画生成的参考图。</small>
                    </div>
                    <button type="button" class="manim-sketch-icon-btn" data-sketch-action="close" aria-label="关闭在线手绘">
                        <i data-lucide="x"></i>
                    </button>
                </header>

                <div class="manim-sketch-toolbar" aria-label="手绘工具栏">
                    ${this.renderToolButton('pen', 'pencil', '画笔')}
                    ${this.renderToolButton('eraser', 'eraser', '橡皮')}
                    <div class="manim-sketch-divider"></div>
                    <button type="button" class="manim-sketch-tool-btn" data-sketch-action="undo" ${this.activePage.strokes.length ? '' : 'disabled'}>
                        <i data-lucide="undo-2"></i><span>撤销</span>
                    </button>
                    <button type="button" class="manim-sketch-tool-btn" data-sketch-action="redo" ${this.activePage.redoStack.length ? '' : 'disabled'}>
                        <i data-lucide="redo-2"></i><span>重做</span>
                    </button>
                    <button type="button" class="manim-sketch-tool-btn" data-sketch-action="clear" ${hasStrokeContent(this.activePage) ? '' : 'disabled'}>
                        <i data-lucide="trash-2"></i><span>清空</span>
                    </button>
                    <button type="button" class="manim-sketch-tool-btn ${this.gridVisible ? 'active' : ''}" data-sketch-action="toggle-grid">
                        <i data-lucide="grid-3x3"></i><span>网格</span>
                    </button>
                </div>

                <div class="manim-sketch-options">
                    <div class="manim-sketch-colors" aria-label="颜色选择">
                        ${DEFAULT_COLORS.map(color => `
                            <button type="button" class="manim-sketch-color ${color === this.color ? 'active' : ''}" style="--sketch-color:${color}" data-sketch-color="${color}" aria-label="选择颜色 ${color}"></button>
                        `).join('')}
                    </div>
                    <label class="manim-sketch-width">
                        <span>线宽</span>
                        <input type="range" min="2" max="18" step="1" value="${this.width}" data-sketch-action="width">
                        <strong>${this.width}px</strong>
                    </label>
                    <div class="manim-sketch-hint">Shift 拉直线段 · Ctrl+Z 撤销</div>
                </div>

                <div class="manim-sketch-stage">
                    <div class="manim-sketch-canvas-wrap">
                        <canvas class="manim-sketch-canvas tool-${this.tool}"></canvas>
                    </div>
                </div>

                <footer class="manim-sketch-footer">
                    <div class="manim-sketch-pages" aria-label="手绘页">
                        ${this.pages.map((page, index) => `
                            <button type="button" class="manim-sketch-page ${page.id === this.activePageId ? 'active' : ''}" data-sketch-page="${page.id}">
                                <span>${index + 1}</span>${hasStrokeContent(page) ? '<i data-lucide="check"></i>' : ''}
                            </button>
                        `).join('')}
                        <button type="button" class="manim-sketch-page add" data-sketch-action="add-page" ${this.pages.length >= MAX_SKETCH_PAGES ? 'disabled' : ''} aria-label="添加草图页">
                            <i data-lucide="plus"></i>
                        </button>
                        <button type="button" class="manim-sketch-page danger" data-sketch-action="delete-page" ${this.pages.length <= 1 ? 'disabled' : ''} aria-label="删除当前草图页">
                            <i data-lucide="minus"></i>
                        </button>
                    </div>
                    <div class="manim-sketch-actions">
                        <button type="button" class="manim-sketch-secondary" data-sketch-action="close">取消</button>
                        <button type="button" class="manim-sketch-primary" data-sketch-action="complete" ${this.exporting ? 'disabled' : ''}>
                            <i data-lucide="image-plus"></i>
                            <span>${this.exporting ? '正在加入...' : '加入参考素材'}</span>
                        </button>
                    </div>
                </footer>
            </section>
        `;

        this.shell = this.overlay.querySelector('.manim-sketch-shell');
        this.canvas = this.overlay.querySelector('.manim-sketch-canvas');
        this.ctx = this.canvas?.getContext('2d') || null;
        this.bindEvents();
        this.refreshIcons();
        requestAnimationFrame(() => this.resizeCanvas());
    }

    renderToolButton(tool, icon, label) {
        return `
            <button type="button" class="manim-sketch-tool-btn ${this.tool === tool ? 'active' : ''}" data-sketch-tool="${tool}">
                <i data-lucide="${icon}"></i><span>${label}</span>
            </button>
        `;
    }

    bindEvents() {
        this.overlay.querySelectorAll('[data-sketch-tool]').forEach(button => {
            button.addEventListener('click', () => {
                this.tool = button.dataset.sketchTool || 'pen';
                this.render();
            });
        });

        this.overlay.querySelectorAll('[data-sketch-color]').forEach(button => {
            button.addEventListener('click', () => {
                this.color = button.dataset.sketchColor || this.color;
                this.tool = 'pen';
                this.render();
            });
        });

        this.overlay.querySelectorAll('[data-sketch-page]').forEach(button => {
            button.addEventListener('click', () => {
                this.activePageId = button.dataset.sketchPage || this.activePageId;
                this.render();
            });
        });

        this.overlay.querySelectorAll('[data-sketch-action]').forEach(element => {
            element.addEventListener('click', () => this.handleAction(element.dataset.sketchAction));
        });

        this.overlay.querySelector('[data-sketch-action="width"]')?.addEventListener('input', (event) => {
            this.width = Number(event.target.value || 5);
            const label = this.overlay.querySelector('.manim-sketch-width strong');
            if (label) label.textContent = `${this.width}px`;
        });

        this.canvas?.addEventListener('pointerdown', (event) => this.startStroke(event));
        this.canvas?.addEventListener('pointermove', (event) => this.extendStroke(event));
        this.canvas?.addEventListener('pointerup', (event) => this.endStroke(event));
        this.canvas?.addEventListener('pointercancel', (event) => this.endStroke(event));
        this.canvas?.addEventListener('pointerleave', (event) => this.endStroke(event));
    }

    async handleAction(action) {
        switch (action) {
            case 'close':
                this.requestClose();
                break;
            case 'undo':
                this.undo();
                break;
            case 'redo':
                this.redo();
                break;
            case 'clear':
                this.clearPage();
                break;
            case 'toggle-grid':
                this.gridVisible = !this.gridVisible;
                this.render();
                break;
            case 'add-page':
                this.addPage();
                break;
            case 'delete-page':
                this.deletePage();
                break;
            case 'complete':
                await this.complete();
                break;
            default:
                break;
        }
    }

    requestClose() {
        if (this.dirty && !window.confirm('手绘草稿尚未加入参考素材，确定关闭吗？')) {
            return;
        }
        this.close();
    }

    close() {
        this.overlay?.classList.add('hidden');
        document.body.classList.remove('manim-sketch-open');
        window.removeEventListener('resize', this.boundResize);
        window.removeEventListener('keydown', this.boundKeydown);
    }

    addPage() {
        if (this.pages.length >= MAX_SKETCH_PAGES) {
            showToast('最多支持 4 张手绘参考图', 'warning');
            return;
        }
        const page = createPage(this.pages.length + 1);
        this.pages.push(page);
        this.activePageId = page.id;
        this.dirty = true;
        this.render();
    }

    deletePage() {
        if (this.pages.length <= 1) return;
        if (hasStrokeContent(this.activePage) && !window.confirm('删除当前草图页？')) {
            return;
        }
        const index = this.pages.findIndex(page => page.id === this.activePageId);
        this.pages = this.pages.filter(page => page.id !== this.activePageId);
        this.activePageId = this.pages[Math.max(0, index - 1)]?.id || this.pages[0].id;
        this.dirty = true;
        this.render();
    }

    undo() {
        const page = this.activePage;
        const stroke = page.strokes.pop();
        if (stroke) {
            page.redoStack.push(stroke);
            this.dirty = true;
            this.render();
        }
    }

    redo() {
        const page = this.activePage;
        const stroke = page.redoStack.pop();
        if (stroke) {
            page.strokes.push(stroke);
            this.dirty = true;
            this.render();
        }
    }

    handleKeydown(event) {
        if (!this.overlay || this.overlay.classList.contains('hidden')) return;
        if (this.isEditableTarget(event.target)) return;

        const key = String(event.key || '').toLowerCase();
        const isUndoCombo = (event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey;
        const isRedoCombo = ((event.ctrlKey || event.metaKey) && key === 'y')
            || ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'z');

        if (isUndoCombo) {
            event.preventDefault();
            this.undo();
        } else if (isRedoCombo) {
            event.preventDefault();
            this.redo();
        }
    }

    isEditableTarget(target) {
        const tag = String(target?.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
    }

    clearPage() {
        const page = this.activePage;
        if (!hasStrokeContent(page)) return;
        if (!window.confirm('清空当前画布？')) return;
        page.strokes = [];
        page.redoStack = [];
        this.dirty = true;
        this.render();
    }

    startStroke(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        this.pointerId = event.pointerId;
        this.canvas.setPointerCapture?.(event.pointerId);
        const point = this.getPointerPoint(event);
        this.currentStroke = {
            tool: this.tool,
            color: this.tool === 'eraser' ? '#000000' : this.color,
            width: this.width,
            anchor: point,
            straight: Boolean(event.shiftKey),
            points: [point],
        };
        this.activePage.redoStack = [];
        this.drawCanvas();
    }

    extendStroke(event) {
        if (!this.currentStroke || event.pointerId !== this.pointerId) return;
        event.preventDefault();
        const point = this.getPointerPoint(event);

        if (event.shiftKey || this.currentStroke.straight) {
            this.currentStroke.straight = true;
            this.currentStroke.points = [this.currentStroke.anchor || this.currentStroke.points[0], point];
            this.drawCanvas();
            return;
        }

        const previous = this.currentStroke.points[this.currentStroke.points.length - 1];
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.002) {
            return;
        }
        this.currentStroke.points.push(point);
        this.drawCanvas();
    }

    endStroke(event) {
        if (!this.currentStroke || event.pointerId !== this.pointerId) return;
        event.preventDefault();
        this.canvas.releasePointerCapture?.(event.pointerId);
        if (this.currentStroke.points.length > 1) {
            this.activePage.strokes.push(this.currentStroke);
            this.dirty = true;
        }
        this.currentStroke = null;
        this.pointerId = null;
        this.drawCanvas();
    }

    getPointerPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = rect.width ? (event.clientX - rect.left) / rect.width : 0;
        const y = rect.height ? (event.clientY - rect.top) / rect.height : 0;
        return {
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1, Math.max(0, y)),
        };
    }

    resizeCanvas() {
        if (!this.canvas || !this.ctx || this.overlay?.classList.contains('hidden')) return;
        const rect = this.canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const width = Math.round(rect.width * dpr);
        const height = Math.round(rect.height * dpr);
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.drawCanvas();
    }

    drawCanvas() {
        if (!this.ctx || !this.canvas) return;
        this.drawPage(this.ctx, this.canvas.width, this.canvas.height, this.activePage, {
            includeCurrentStroke: true,
            scaleBase: this.canvas.width / 800,
        });
    }

    drawPage(ctx, width, height, page, { includeCurrentStroke = false, scaleBase = 1 } = {}) {
        ctx.save();
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        if (this.gridVisible) {
            this.drawGrid(ctx, width, height);
        }
        for (const stroke of page.strokes) {
            this.drawStroke(ctx, width, height, stroke, scaleBase);
        }
        if (includeCurrentStroke && this.currentStroke) {
            this.drawStroke(ctx, width, height, this.currentStroke, scaleBase);
        }
        ctx.restore();
    }

    drawGrid(ctx, width, height) {
        const step = width / 16;
        ctx.save();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        ctx.lineWidth = Math.max(1, width / 1280);
        for (let x = step; x < width; x += step) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        for (let y = step; y < height; y += step) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        ctx.restore();
    }

    drawStroke(ctx, width, height, stroke, scaleBase = 1) {
        if (!stroke.points?.length) return;
        ctx.save();
        ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = stroke.color || '#111827';
        ctx.lineWidth = Math.max(1.5, stroke.width * scaleBase);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        stroke.points.forEach((point, index) => {
            const x = point.x * width;
            const y = point.y * height;
            if (index === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();
        ctx.restore();
    }

    async complete() {
        const drawablePages = this.pages.filter(hasStrokeContent);
        if (!drawablePages.length) {
            showToast('请先画一点内容，再加入参考素材', 'warning');
            return;
        }

        try {
            this.exporting = true;
            this.render();
            const exports = drawablePages.map((page, index) => ({
                dataUrl: this.exportPage(page),
                filename: `手绘参考图-${String(index + 1).padStart(2, '0')}.png`,
            }));
            await this.onComplete?.(exports);
            this.dirty = false;
            this.close();
        } catch (error) {
            showToast(error.message || '手绘参考图加入失败', 'error');
        } finally {
            this.exporting = false;
            if (!this.overlay?.classList.contains('hidden')) {
                this.render();
            }
        }
    }

    exportPage(page) {
        const canvas = document.createElement('canvas');
        canvas.width = EXPORT_WIDTH;
        canvas.height = EXPORT_HEIGHT;
        const ctx = canvas.getContext('2d');
        this.drawPage(ctx, EXPORT_WIDTH, EXPORT_HEIGHT, page, {
            includeCurrentStroke: false,
            scaleBase: EXPORT_WIDTH / 800,
        });
        return canvas.toDataURL('image/png');
    }

    refreshIcons() {
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }
}
