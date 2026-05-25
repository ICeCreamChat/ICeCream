import { showToast } from '../utils/helpers.js';
import { setAnimationEngine } from './animation-engine-state.js';
import { geogebraWorkbench } from './geogebra-workbench.js';

class GeoGebraStudioShell {
    constructor() {
        this.overlay = null;
        this.panel = null;
        this.body = null;
        this.modeSwitcher = null;
        this.initialized = false;
        this.isOpen = false;
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    init({ modeSwitcher } = {}) {
        if (this.initialized) return;
        this.initialized = true;
        this.modeSwitcher = modeSwitcher || null;
        this.createShell();
    }

    createShell() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'geogebra-studio-shell hidden';
        this.overlay.setAttribute('aria-hidden', 'true');
        this.overlay.innerHTML = `
            <section class="geogebra-studio-shell-panel" role="dialog" aria-modal="true" aria-label="GeoGebra Studio">
                <header class="geogebra-studio-shell-bar">
                    <div>
                        <span>动画 / GeoGebra</span>
                        <strong>GeoGebra Studio</strong>
                    </div>
                    <button type="button" class="geogebra-studio-shell-close" aria-label="关闭 GeoGebra Studio">
                        <i data-lucide="x"></i>
                    </button>
                </header>
                <div class="geogebra-studio-shell-body"></div>
            </section>
        `;
        document.body.appendChild(this.overlay);
        this.panel = this.overlay.querySelector('.geogebra-studio-shell-panel');
        this.body = this.overlay.querySelector('.geogebra-studio-shell-body');

        this.overlay.addEventListener('click', (event) => {
            if (event.target === this.overlay) {
                this.close();
            }
        });
        this.overlay.querySelector('.geogebra-studio-shell-close')?.addEventListener('click', () => this.close());
    }

    setMode(mode) {
        if (mode !== 'manim' && this.isOpen) {
            this.close();
        }
    }

    open() {
        if (!this.overlay) {
            this.createShell();
        }

        setAnimationEngine('geogebra');
        this.modeSwitcher?.setMode?.('manim', true);
        geogebraWorkbench.clearTransientProblemState();
        this.isOpen = true;
        this.overlay.classList.remove('hidden');
        this.overlay.classList.add('open');
        this.overlay.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', this.handleKeydown);

        this.render();
        geogebraWorkbench.prepare().catch(error => {
            showToast(error?.message || 'GeoGebra Studio 初始化失败', 'error');
        });
        this.panel?.querySelector('button, textarea')?.focus();
    }

    close() {
        geogebraWorkbench.stopTrajectoryDemo();
        this.isOpen = false;
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

    render() {
        if (!this.body) return;
        this.body.innerHTML = geogebraWorkbench.render();
        geogebraWorkbench.bindPanelActions(this.body);
        this.refreshIcons();
    }

    refreshVisiblePanel() {
        if (!this.isOpen) return;
        geogebraWorkbench.refreshVisiblePanel();
    }

    resetSessionRuntime() {
        geogebraWorkbench.resetSessionRuntime();
    }

    refreshIcons() {
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }
}

export const geogebraStudioShell = new GeoGebraStudioShell();
