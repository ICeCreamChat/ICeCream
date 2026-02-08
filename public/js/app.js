/**
 * ICeCream - 统一智能平台
 * 前端主入口 (模块化重构版)
 * Copyright (c) 2026 ICeCreamChat
 */

// ================================
// 核心模块导入
// ================================
import { modeSwitcher } from './core/mode-switcher.js';
import { intentConfirm } from './core/intent-confirm.js';
import { messageHandler } from './core/message-handler.js';
import { sessionManager } from './core/session-manager.js';
import { imageUploader } from './core/image-uploader.js';
import { CodePanel } from './core/code-panel.js';
import { showToast, devLog, dataURLtoBlob } from './utils/helpers.js';
import appLauncher from './tools/app-launcher.js';



// ================================
// 应用主类
// ================================
class ICeCreamApp {
    constructor() {
        this.elements = {
            themeToggle: null,
            sidebar: null,
            mobileMenuBtn: null,
            sidebarOverlay: null,
            newChatBtn: null,
            moreBtn: null,
            dropdownMenu: null,
            btnClear: null
        };
        this.codePanel = null;
    }

    /**
     * 初始化应用
     */
    async init() {
        // 缓存 DOM 元素
        this._cacheElements();

        // 初始化外部组件 (来自 MathSolver)
        this._initExternalModules();

        // 初始化核心模块
        this._initCoreModules();

        // 绑定事件
        this._bindEvents();

        // 初始化主题
        this._initTheme();

        // 加载已保存的消息
        this._loadMessages();

        // 刷新图标
        if (window.lucide) {
            window.lucide.createIcons();
        }

        // 检查服务状态
        await this._checkServiceStatus();

        devLog.info('ICeCream App initialized');
    }

    /**
     * 缓存 DOM 元素
     * @private
     */
    _cacheElements() {
        this.elements.themeToggle = document.getElementById('theme-toggle');
        this.elements.sidebar = document.getElementById('sidebar');
        this.elements.mobileMenuBtn = document.getElementById('mobile-menu-btn');
        this.elements.sidebarOverlay = document.getElementById('sidebar-overlay');
        this.elements.newChatBtn = document.getElementById('new-chat-btn');
        this.elements.moreBtn = document.getElementById('more-btn');
        this.elements.dropdownMenu = document.getElementById('dropdownMenu');
        this.elements.btnClear = document.getElementById('btn-clear');
        this.elements.appsBtn = document.getElementById('apps-btn');
    }

    /**
     * 初始化外部模块 (MathSolver 兼容)
     * @private
     */
    _initExternalModules() {
        if (window.StateManager) {
            window.StateManager.init();
        }

        if (window.ParticleEngine) {
            window.ParticleEngine.init();
            window.ParticleEngine.initPerformanceOptimization?.();
            console.log('[ICeCream] ParticleEngine initialized');
        }

        // 初始化 MathSolver 移植的模块
        if (window.UiManager) {
            window.UiManager.init();
            console.log('[ICeCream] UiManager initialized');
        }

        if (window.ContextPanel) {
            window.ContextPanel.init();
            console.log('[ICeCream] ContextPanel initialized');
        }

        if (window.ThemeManager) {
            window.ThemeManager.init();
            console.log('[ICeCream] ThemeManager initialized');
        }

        if (window.CursorEffects) {
            window.CursorEffects.init();
            console.log('[ICeCream] CursorEffects initialized');
        }

        // 注意: ChatSystem 已被新的 sessionManager 模块替代
        // 不再调用 ChatSystem.init()，否则会清空 #messages 容器，破坏欢迎屏幕
        // if (window.ChatSystem) {
        //     window.ChatSystem.init();
        //     console.log('[ICeCream] ChatSystem initialized');
        // }
    }

    /**
     * 初始化核心模块
     * @private
     */
    _initCoreModules() {
        //代码面板
        this.codePanel = new CodePanel();

        // 模态切换器
        modeSwitcher.init({
            onModeChange: (mode) => {
                devLog.log('Mode changed to', mode);
            }
        });

        // 意图确认
        intentConfirm.init({
            onConfirm: async (intent, data) => {
                await this._handleIntentConfirm(intent, data);
            }
        });

        // 消息处理器
        messageHandler.init({
            onMessageAdded: (message) => {
                sessionManager.addMessage(message);
            },
            codePanel: this.codePanel
        });

        // 会话管理器
        sessionManager.init({
            onSessionLoad: (messages) => {
                messageHandler.clearMessages();
                messageHandler.hideWelcomeScreen();
                messages.forEach(msg => {
                    messageHandler.addMessage(msg.role, msg.content, msg.image);
                });
                this._closeSidebar();
            },
            onSessionClear: () => {
                messageHandler.clearMessages();
                this._closeSidebar();
            }
        });

        // 图片上传器
        imageUploader.init();
    }

    /**
     * 绑定事件
     * @private
     */
    _bindEvents() {
        // 主题切换
        this.elements.themeToggle?.addEventListener('click', () => this._toggleTheme());

        // 移动端菜单
        this.elements.mobileMenuBtn?.addEventListener('click', () => this._toggleSidebar());
        this.elements.sidebarOverlay?.addEventListener('click', () => this._closeSidebar());

        // 新建对话
        this.elements.newChatBtn?.addEventListener('click', () => {
            sessionManager.startNewSession();
        });

        // 工具栏下拉菜单
        this.elements.moreBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.elements.dropdownMenu?.classList.toggle('show');
        });

        // 清空当前对话
        this.elements.btnClear?.addEventListener('click', () => {
            this.elements.dropdownMenu?.classList.remove('show');
            sessionManager.clearCurrentChat();
        });

        // 点击外部关闭下拉菜单
        document.addEventListener('click', () => {
            this.elements.dropdownMenu?.classList.remove('show');
        });

        // 课堂工具箱按钮
        this.elements.appsBtn?.addEventListener('click', () => {
            appLauncher.open();
        });
    }

    /**
     * 处理意图确认
     * @private
     */
    async _handleIntentConfirm(intent, data) {
        messageHandler.setLoading(true);

        try {
            // Use FormData to support image re-upload
            const formData = new FormData();
            formData.append('message', data.originalMessage || '');
            formData.append('mode', intent);

            // Re-append image if it was part of the original request
            if (data.originalImage) {
                const blob = dataURLtoBlob(data.originalImage);
                formData.append('image', blob, 'image.png');
            }

            const response = await fetch('/api/message', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            messageHandler.handleResponse(result);
        } catch (error) {
            messageHandler.addMessage('bot', `抱歉，发生了错误：${error.message}`);
        } finally {
            messageHandler.setLoading(false);
        }
    }

    /**
     * 初始化主题
     * @private
     */
    _initTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
        }
    }

    /**
     * 切换主题
     * @private
     */
    _toggleTheme() {
        document.body.classList.toggle('light-mode');
        const isLight = document.body.classList.contains('light-mode');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
    }

    /**
     * 切换侧边栏
     * @private
     */
    _toggleSidebar() {
        this.elements.sidebar?.classList.toggle('open');
        this.elements.sidebarOverlay?.classList.toggle('active');
    }

    /**
     * 关闭侧边栏
     * @private
     */
    _closeSidebar() {
        this.elements.sidebar?.classList.remove('open');
        this.elements.sidebarOverlay?.classList.remove('active');
    }

    /**
     * 加载已保存的消息
     * @private
     */
    _loadMessages() {
        const messages = sessionManager.loadSavedMessages();
        if (messages.length > 0) {
            messageHandler.hideWelcomeScreen();
            messages.forEach(msg => {
                messageHandler.addMessage(msg.role, msg.content, msg.image);
            });
        } else {
            // 没有消息时显示欢迎屏幕
            messageHandler.showWelcomeScreen();
        }
    }

    /**
     * 检查服务状态
     * @private
     */
    async _checkServiceStatus() {
        try {
            const healthResponse = await fetch('/api/health');
            if (!healthResponse.ok) {
                showToast('服务连接失败，请检查后端是否启动', 'error');
                return;
            }

            const manimResponse = await fetch('/api/manim/status');
            const manimStatus = await manimResponse.json();

            if (!manimStatus.data?.available) {
                devLog.warn('Manim 服务未启动');
                this._showServiceWarning('manim');
            } else {
                devLog.info('Manim 服务已就绪');
            }
        } catch (error) {
            devLog.error('服务状态检查失败', error.message);
            showToast('服务连接失败，请检查服务是否启动', 'error');
        }
    }

    /**
     * 显示服务警告
     * @private
     */
    _showServiceWarning(service) {
        const warnings = {
            manim: '动画服务未启动，动画功能暂不可用。如需使用，请运行 Manim 服务。'
        };

        const key = `service_warning_${service}_shown`;
        if (!sessionStorage.getItem(key)) {
            showToast(warnings[service], 'warning');
            sessionStorage.setItem(key, 'true');
        }
    }
}

// ================================
// 应用启动
// ================================
const app = new ICeCreamApp();

document.addEventListener('DOMContentLoaded', () => {
    app.init();
});

// ================================
// 导出全局 API (调试用)
// ================================
window.ICeCream = {
    app,
    modeSwitcher,
    messageHandler,
    sessionManager,
    showToast,
    appLauncher
};
