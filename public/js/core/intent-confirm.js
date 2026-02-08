/**
 * ICeCream - 意图确认模块
 * 处理低置信度时的用户意图确认 UI
 */

/**
 * 意图确认器类
 */
class IntentConfirm {
    constructor() {
        this.element = null;
        this.pendingData = null;
        this.onConfirm = null;
    }

    /**
     * 初始化意图确认器
     * @param {Object} options - 配置选项
     * @param {Function} options.onConfirm - 确认回调 (intent) => void
     */
    init(options = {}) {
        this.element = document.getElementById('intent-confirm');
        this.onConfirm = options.onConfirm || null;

        this._bindEvents();
    }

    /**
     * 绑定事件
     * @private
     */
    _bindEvents() {
        document.querySelectorAll('.intent-option').forEach(option => {
            option.addEventListener('click', () => {
                const intent = option.dataset.intent;
                this.confirm(intent);
            });
        });
    }

    /**
     * 显示意图确认 UI
     * @param {Object} data - 待确认的数据
     */
    show(data) {
        this.pendingData = data;
        if (this.element) {
            this.element.classList.remove('hidden');
        }
    }

    /**
     * 隐藏意图确认 UI
     */
    hide() {
        if (this.element) {
            this.element.classList.add('hidden');
        }
    }

    /**
     * 确认意图
     * @param {string} intent - 用户选择的意图
     */
    confirm(intent) {
        this.hide();

        if (this.onConfirm && this.pendingData) {
            this.onConfirm(intent, this.pendingData);
        }

        this.pendingData = null;
    }

    /**
     * 获取待确认的数据
     * @returns {Object|null} 待确认数据
     */
    getPendingData() {
        return this.pendingData;
    }
}

// 导出单例
export const intentConfirm = new IntentConfirm();
