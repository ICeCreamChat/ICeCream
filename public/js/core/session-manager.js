/**
 * ICeCream - 会话管理模块
 * 处理聊天历史记录的存储和加载
 */

import { showToast, showConfirm } from '../utils/helpers.js';

/**
 * 会话管理器类
 */
class SessionManager {
    constructor() {
        this.messages = [];
        this.currentSessionId = null;
        this.elements = {
            historyList: null,
            messages: null,
            welcomeScreen: null
        };
        this.onSessionLoad = null;
        this.onSessionClear = null;
    }

    /**
     * 初始化会话管理器
     * @param {Object} options - 配置选项
     * @param {Function} options.onSessionLoad - 会话加载回调
     * @param {Function} options.onSessionClear - 会话清空回调
     */
    init(options = {}) {
        this.elements.historyList = document.getElementById('history-list');
        this.elements.messages = document.getElementById('messages');
        this.elements.welcomeScreen = document.getElementById('welcome-screen');
        this.onSessionLoad = options.onSessionLoad || null;
        this.onSessionClear = options.onSessionClear || null;

        // 获取当前会话 ID
        this.currentSessionId = localStorage.getItem('icecream_current_session');
        if (!this.currentSessionId) {
            this.currentSessionId = Date.now().toString();
            localStorage.setItem('icecream_current_session', this.currentSessionId);
        }

        // 加载历史记录列表
        this.renderHistoryList();
    }

    /**
     * 获取所有会话列表
     * @returns {Array} 会话列表
     */
    getSessions() {
        return JSON.parse(localStorage.getItem('icecream_sessions') || '[]');
    }

    /**
     * 保存当前会话
     */
    saveSession() {
        if (this.messages.length === 0) return;

        const sessions = this.getSessions();
        const existingIndex = sessions.findIndex(s => s.id === this.currentSessionId);

        const sessionData = {
            id: this.currentSessionId,
            title: this.messages[0]?.content?.slice(0, 20) || '新对话',
            messages: this.messages.slice(-50),
            updatedAt: Date.now()
        };

        if (existingIndex >= 0) {
            sessions[existingIndex] = sessionData;
        } else {
            sessions.unshift(sessionData);
        }

        localStorage.setItem('icecream_sessions', JSON.stringify(sessions.slice(0, 20)));
        this.renderHistoryList();
    }

    /**
     * 保存消息到本地存储
     */
    saveMessages() {
        try {
            const messagesToSave = this.messages.slice(-50);
            localStorage.setItem('icecream_messages', JSON.stringify(messagesToSave));
            this.saveSession();
        } catch (e) {
            console.warn('Failed to save messages:', e);
        }
    }

    /**
     * 加载已保存的消息
     * @returns {Array} 消息列表
     */
    loadSavedMessages() {
        try {
            const saved = localStorage.getItem('icecream_messages');
            if (saved) {
                this.messages = JSON.parse(saved);
                return this.messages;
            }
        } catch (e) {
            console.warn('Failed to load saved messages:', e);
        }
        return [];
    }

    /**
     * 添加消息到当前会话
     * @param {Object} message - 消息对象 { role, content, image }
     */
    addMessage(message) {
        this.messages.push(message);
        this.saveMessages();
    }

    /**
     * 加载指定会话
     * @param {string} sessionId - 会话 ID
     */
    loadSession(sessionId) {
        const sessions = this.getSessions();
        const session = sessions.find(s => s.id === sessionId);

        if (!session) return;

        this.currentSessionId = sessionId;
        localStorage.setItem('icecream_current_session', sessionId);
        this.messages = session.messages || [];

        // 触发回调
        if (this.onSessionLoad) {
            this.onSessionLoad(session.messages);
        }

        this.renderHistoryList();
    }

    /**
     * 开始新会话
     */
    startNewSession() {
        console.log('[SessionManager] Starting new session...');
        this.currentSessionId = Date.now().toString();
        localStorage.setItem('icecream_current_session', this.currentSessionId);
        this.messages = [];
        localStorage.removeItem('icecream_messages');

        // 隐藏并清空题目看板 (Context Panel)
        const contextPanel = document.getElementById('context-panel');
        if (contextPanel) {
            contextPanel.classList.add('hidden');
        }
        const contextImage = document.getElementById('context-image');
        if (contextImage) {
            contextImage.src = '';
        }
        const contextText = document.getElementById('context-text');
        if (contextText) {
            contextText.textContent = '';
        }

        // 触发回调
        if (this.onSessionClear) {
            this.onSessionClear();
        }

        this.renderHistoryList();
        showToast('新对话已创建', 'success');
        console.log('[SessionManager] New session created:', this.currentSessionId);
    }

    /**
     * 删除指定会话
     * @param {string} sessionId - 会话 ID
     */
    async deleteSession(sessionId) {
        const confirmed = await showConfirm('确认删除', '确定要删除此对话吗？此操作无法撤销。');

        if (confirmed) {
            let sessions = this.getSessions();
            sessions = sessions.filter(s => s.id !== sessionId);
            localStorage.setItem('icecream_sessions', JSON.stringify(sessions));

            this.renderHistoryList();

            // 如果删除的是当前会话，创建新会话
            if (this.currentSessionId === sessionId) {
                if (sessions.length > 0) {
                    this.loadSession(sessions[0].id);
                } else {
                    this.startNewSession();
                }
            }

            showToast('对话已删除', 'success');
        }
    }

    /**
     * 清空当前对话
     */
    clearCurrentChat() {
        this.messages = [];

        if (this.elements.messages) {
            // 只删除消息元素，保留欢迎屏幕
            const messageElements = this.elements.messages.querySelectorAll('.message');
            messageElements.forEach(el => el.remove());
        }

        if (this.elements.welcomeScreen) {
            this.elements.welcomeScreen.style.display = 'flex';
        }

        // 隐藏并清空题目看板 (Context Panel)
        const contextPanel = document.getElementById('context-panel');
        if (contextPanel) {
            contextPanel.classList.add('hidden');
        }
        const contextImage = document.getElementById('context-image');
        if (contextImage) {
            contextImage.src = '';
        }
        const contextText = document.getElementById('context-text');
        if (contextText) {
            contextText.textContent = '';
        }

        // 从历史记录中删除当前会话
        let sessions = this.getSessions();
        sessions = sessions.filter(s => s.id !== this.currentSessionId);
        localStorage.setItem('icecream_sessions', JSON.stringify(sessions));

        // 创建新会话 ID 并清空本地消息存储
        this.currentSessionId = Date.now().toString();
        localStorage.setItem('icecream_current_session', this.currentSessionId);
        localStorage.removeItem('icecream_messages');

        // 重新渲染历史记录列表
        this.renderHistoryList();

        showToast('对话已清空', 'success');
    }

    /**
     * 清空所有历史
     */
    async clearAllHistory() {
        const confirmed = await showConfirm('确认清空', '确定要清空所有对话历史吗？此操作将永久删除所有记录。');

        if (confirmed) {
            localStorage.removeItem('icecream_sessions');
            localStorage.removeItem('icecream_current_session');
            localStorage.removeItem('icecream_messages');
            this.startNewSession();
            this.renderHistoryList();
            showToast('所有历史已清空', 'success');
        }
    }

    /**
     * 渲染历史记录列表
     */
    renderHistoryList() {
        if (!this.elements.historyList) return;

        this.elements.historyList.innerHTML = '';
        const sessions = this.getSessions();

        sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = `history-item ${session.id === this.currentSessionId ? 'active' : ''}`;
            item.onclick = () => this.loadSession(session.id);

            // 转义标题防止 XSS
            const titleDiv = document.createElement('div');
            titleDiv.textContent = session.title;
            const safeTitle = titleDiv.innerHTML;

            item.innerHTML = `
                <span class="history-title">${safeTitle}</span>
                <button class="delete-btn" title="删除对话">
                    <i data-lucide="x"></i>
                </button>
            `;

            // 绑定删除按钮事件 (事件委托)
            item.querySelector('.delete-btn').onclick = (e) => {
                e.stopPropagation();
                this.deleteSession(session.id);
            };

            this.elements.historyList.appendChild(item);
        });

        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    /**
     * 获取当前消息列表
     * @returns {Array} 消息列表
     */
    getMessages() {
        return this.messages;
    }
}

// 导出单例
export const sessionManager = new SessionManager();
