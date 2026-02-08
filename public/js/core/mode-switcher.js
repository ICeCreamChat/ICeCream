/**
 * ICeCream - 模态切换器模块
 * 管理聊天/动画/解题模式切换
 */

// 从 window 获取常量 (constants.js 作为普通脚本加载)
const MODE_HINTS = window.MODE_HINTS;
const MODE_LOADING_TEXTS = window.MODE_LOADING_TEXTS;
const MODE_PLACEHOLDERS = window.MODE_PLACEHOLDERS;

/**
 * 模态切换器类
 */
class ModeSwitcher {
    constructor() {
        this.currentMode = 'auto';
        this.elements = {
            modeTabs: null,
            modeHint: null,
            chatInput: null
        };
        this.onModeChange = null;
    }

    /**
     * 初始化模态切换器
     * @param {Object} options - 配置选项
     * @param {Function} options.onModeChange - 模式变化回调
     */
    init(options = {}) {
        this.elements.modeTabs = document.querySelectorAll('.mode-tab');
        this.elements.modeHint = document.getElementById('mode-hint');
        this.elements.chatInput = document.getElementById('chat-input');
        this.onModeChange = options.onModeChange || null;

        this._bindEvents();
    }

    /**
     * 绑定事件
     * @private
     */
    _bindEvents() {
        this.elements.modeTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.mode;
                this.setMode(mode);
            });
        });

        // Feature cards 点击切换模式
        document.querySelectorAll('.feature-card').forEach(card => {
            card.addEventListener('click', () => {
                const mode = card.dataset.mode;
                if (mode) {
                    this.setMode(mode);
                    this.elements.chatInput?.focus();
                }
            });
        });
    }

    /**
     * 设置当前模式
     * @param {string} mode - 模式名称: auto | chat | manim | solver
     * @param {boolean} triggerCallback - 是否触发回调 (默认 true)
     */
    setMode(mode, triggerCallback = true) {
        this.currentMode = mode;

        // 更新 Tab 激活状态
        this.elements.modeTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        // 更新提示文字
        if (this.elements.modeHint) {
            this.elements.modeHint.textContent = MODE_HINTS[mode] || MODE_HINTS.auto;
        }

        // 更新输入框占位符
        if (this.elements.chatInput) {
            this.elements.chatInput.placeholder = MODE_PLACEHOLDERS[mode] || MODE_PLACEHOLDERS.auto;
        }

        // 触发回调
        if (triggerCallback && this.onModeChange) {
            this.onModeChange(mode);
        }
    }

    /**
     * 获取当前模式
     * @returns {string} 当前模式
     */
    getMode() {
        return this.currentMode;
    }

    /**
     * 获取当前模式的加载文字
     * @returns {string} 加载提示文字
     */
    getLoadingText() {
        return MODE_LOADING_TEXTS[this.currentMode] || MODE_LOADING_TEXTS.auto;
    }
}

// 导出单例
export const modeSwitcher = new ModeSwitcher();
