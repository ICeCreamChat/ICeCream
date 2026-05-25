import { setAnimationEngine } from './animation-engine-state.js';

class AnimationEntryLauncher {
    constructor() {
        this.overlay = null;
        this.panel = null;
        this.modeSwitcher = null;
        this.manimWorkbench = null;
        this.geogebraStudioShell = null;
        this.initialized = false;
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    init({ modeSwitcher, manimWorkbench, geogebraStudioShell } = {}) {
        if (this.initialized) return;
        this.initialized = true;
        this.modeSwitcher = modeSwitcher || null;
        this.manimWorkbench = manimWorkbench || null;
        this.geogebraStudioShell = geogebraStudioShell || null;
        this.createOverlay();
    }

    createOverlay() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'animation-entry-launcher hidden';
        this.overlay.setAttribute('aria-hidden', 'true');
        this.overlay.innerHTML = `
            <section class="animation-entry-panel" role="dialog" aria-modal="true" aria-label="选择动画类型">
                <header class="animation-entry-head">
                    <strong>选择动画类型</strong>
                    <button type="button" class="animation-entry-close" aria-label="关闭">
                        <i data-lucide="x"></i>
                    </button>
                </header>
                <div class="animation-entry-grid">
                    <button type="button" class="animation-entry-card" data-animation-entry-engine="manim">
                        <i data-lucide="clapperboard"></i>
                        <span>
                            <strong>Manim 视频动画</strong>
                            <small>生成可渲染的教学视频</small>
                        </span>
                    </button>
                    <button type="button" class="animation-entry-card" data-animation-entry-engine="geogebra">
                        <i data-lucide="compass"></i>
                        <span>
                            <strong>GeoGebra 动态几何</strong>
                            <small>打开可交互的几何画布</small>
                        </span>
                    </button>
                </div>
            </section>
        `;
        document.body.appendChild(this.overlay);
        this.panel = this.overlay.querySelector('.animation-entry-panel');

        this.overlay.addEventListener('click', (event) => {
            if (event.target === this.overlay) {
                this.close();
            }
        });
        this.overlay.querySelector('.animation-entry-close')?.addEventListener('click', () => this.close());
        this.overlay.querySelectorAll('[data-animation-entry-engine]').forEach(button => {
            button.addEventListener('click', () => this.selectEngine(button.dataset.animationEntryEngine));
        });
    }

    open() {
        if (!this.overlay) {
            this.createOverlay();
        }
        this.overlay.classList.remove('hidden');
        this.overlay.classList.add('open');
        this.overlay.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.handleKeydown);
        this.panel?.querySelector('.animation-entry-card')?.focus();
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    close() {
        this.overlay?.classList.remove('open');
        this.overlay?.classList.add('hidden');
        this.overlay?.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', this.handleKeydown);
    }

    handleKeydown(event) {
        if (event.key === 'Escape') {
            this.close();
        }
    }

    selectEngine(engine) {
        if (engine === 'manim') {
            setAnimationEngine('manim');
            this.close();
            this.geogebraStudioShell?.close?.();
            this.modeSwitcher?.setMode?.('manim', true);
            this.manimWorkbench?.open?.();
            document.getElementById('chat-input')?.focus();
            return;
        } else if (engine === 'geogebra') {
            setAnimationEngine('geogebra');
            this.close();
            this.manimWorkbench?.close?.();
            this.modeSwitcher?.setMode?.('manim', true);
            this.geogebraStudioShell?.open?.();
            return;
        } else {
            return;
        }
    }
}

export const animationEntryLauncher = new AnimationEntryLauncher();
