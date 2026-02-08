/**
 * App Launcher - 课堂工具箱启动器
 * 显示玻璃拟态九宫格，用于选择和启动各个工具
 */

const TOOLS_CONFIG = [
    {
        id: 'seating',
        icon: '🪑',
        title: '座位安排',
        desc: 'AI 智能排座',
        module: 'seating-planner'
    },
    {
        id: 'sound',
        icon: '🔊',
        title: '噪音检测',
        desc: '实时音量监控',
        module: 'sound-monitor'
    },
    {
        id: 'picker',
        icon: '🎲',
        title: '随机点名',
        desc: '老虎机式抽取',
        module: 'random-picker'
    },
    {
        id: 'vote',
        icon: '📊',
        title: '投票抢答',
        desc: '实时互动统计',
        module: 'vote-system'
    }
];

class AppLauncher {
    constructor() {
        this.overlay = null;
        this.modal = null;
        this.toolContainer = null;
        this.currentTool = null;
        this._init();
    }

    _init() {
        this._createDOM();
        this._bindEvents();
        console.log('[AppLauncher] Initialized');
    }

    _createDOM() {
        // Create overlay
        this.overlay = document.createElement('div');
        this.overlay.className = 'app-launcher-overlay';
        this.overlay.innerHTML = `
            <div class="app-launcher-modal">
                <button class="app-launcher-close" aria-label="关闭">
                    <i data-lucide="x"></i>
                </button>
                <div class="app-launcher-header">
                    <h2 class="app-launcher-title">
                        <span>🧊</span> 课堂工具箱
                    </h2>
                    <p class="app-launcher-subtitle">选择一个工具开始使用</p>
                </div>
                <div class="app-grid">
                    ${TOOLS_CONFIG.map(tool => `
                        <div class="app-card" data-tool="${tool.id}">
                            <span class="app-card-icon">${tool.icon}</span>
                            <h3 class="app-card-title">${tool.title}</h3>
                            <p class="app-card-desc">${tool.desc}</p>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);

        // Create tool container (immersive mode)
        this.toolContainer = document.createElement('div');
        this.toolContainer.id = 'tool-container';
        this.toolContainer.className = 'tool-container';
        document.body.appendChild(this.toolContainer);

        // Refresh Lucide icons
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    _bindEvents() {
        // Close button
        const closeBtn = this.overlay.querySelector('.app-launcher-close');
        closeBtn.addEventListener('click', () => this.close());

        // Overlay click to close
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close();
            }
        });

        // Tool card clicks
        const cards = this.overlay.querySelectorAll('.app-card');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                const toolId = card.dataset.tool;
                this._launchTool(toolId);
            });
        });

        // ESC key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.toolContainer.classList.contains('active')) {
                    this._closeTool();
                } else if (this.overlay.classList.contains('active')) {
                    this.close();
                }
            }
        });
    }

    open() {
        this.overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    close() {
        this.overlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    async _launchTool(toolId) {
        const tool = TOOLS_CONFIG.find(t => t.id === toolId);
        if (!tool) {
            console.error(`[AppLauncher] Tool not found: ${toolId}`);
            return;
        }

        console.log(`[AppLauncher] Launching tool: ${tool.title}`);
        this.close();

        // Show immersive container
        this.toolContainer.innerHTML = `
            <div class="tool-header">
                <div class="tool-title">
                    <span>${tool.icon}</span>
                    <span>${tool.title}</span>
                </div>
                <button class="tool-back-btn" id="tool-back-btn">
                    <i data-lucide="arrow-left"></i>
                    <span>返回</span>
                </button>
            </div>
            <div class="tool-body" id="tool-body">
                <div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-muted);">
                    <p>正在加载 ${tool.title}...</p>
                </div>
            </div>
        `;
        
        this.toolContainer.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Refresh icons
        if (window.lucide) {
            window.lucide.createIcons();
        }

        // Bind back button
        document.getElementById('tool-back-btn').addEventListener('click', () => {
            this._closeTool();
        });

        // Dynamically load tool module
        try {
            const module = await import(`./${tool.module}.js`);
            if (module.default && typeof module.default.init === 'function') {
                module.default.init(document.getElementById('tool-body'));
            } else if (typeof module.init === 'function') {
                module.init(document.getElementById('tool-body'));
            }
            this.currentTool = tool.id;
        } catch (err) {
            console.error(`[AppLauncher] Failed to load tool: ${tool.module}`, err);
            document.getElementById('tool-body').innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); text-align:center;">
                    <span style="font-size:3rem; margin-bottom:16px;">🚧</span>
                    <p style="font-size:1.25rem; margin-bottom:8px;">功能开发中...</p>
                    <p style="font-size:0.875rem;">该工具模块尚未实现</p>
                </div>
            `;
        }
    }

    _closeTool() {
        this.toolContainer.classList.remove('active');
        this.toolContainer.innerHTML = '';
        this.currentTool = null;
        document.body.style.overflow = '';
    }
}

// Export singleton
const appLauncher = new AppLauncher();
export default appLauncher;
