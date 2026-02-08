/**
 * MathSolver - ChatSystem Module
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles chat sessions, history, and message management.
 */
const ChatSystem = {
    // ==========================================
    // Initialization
    // ==========================================
    init() {
        this.renderHistoryList();
        const currentId = StateManager.getCurrentSessionId();
        const sessions = StateManager.getChatSessions();

        if (currentId && sessions.find(s => s.id === currentId)) {
            this.loadSession(currentId);
        } else {
            this.startNewChat();
        }
    },

    // ==========================================
    // Session Management
    // ==========================================
    startNewChat() {
        const sessions = StateManager.getChatSessions();

        // Reuse empty session if exists
        if (sessions.length > 0) {
            const lastSession = sessions[0];
            if (lastSession.messages.length === 1 && lastSession.messages[0].role === 'bot') {
                StateManager.setCurrentSessionId(lastSession.id);
                this.renderHistoryList();
                this.loadSession(lastSession.id);
                this.closeSidebarMobile();
                return;
            }
        }

        const newId = Date.now().toString();
        const newSession = {
            id: newId,
            title: "新对话 " + new Date().toLocaleTimeString(),
            messages: [{
                role: 'bot',
                text: "👋 你好！我是 **MathSolver**，你的 AI 数学解题助手。\n\n📸 请点击下方按钮上传数学题图片，我会帮你识别题目并给出详细解答。"
            }]
        };

        sessions.unshift(newSession);
        StateManager.setChatSessions(sessions);
        StateManager.setCurrentSessionId(newId);
        StateManager.saveSessionsToStorage();

        this.renderHistoryList();
        this.loadSession(newId);

        if (window.lucide) window.lucide.createIcons();
    },

    loadSession(id) {
        StateManager.setCurrentSessionId(id);
        const session = StateManager.findSession(id);
        if (!session) return;

        const container = document.getElementById('messages');
        container.innerHTML = '';
        session.messages.forEach(msg => {
            if (window.displayMessage) {
                window.displayMessage(msg.role, msg.text, msg.imageUrl, false, msg.contextData);
            }
        });

        this.updateSidebarActiveState();
        this.closeSidebarMobile();
    },

    async deleteSession(e, id) {
        e.stopPropagation();

        const confirmed = await window.showConfirm('确认删除', '确定要删除此对话吗？此操作无法撤销。');

        if (confirmed) {
            let sessions = StateManager.getChatSessions();
            sessions = sessions.filter(s => s.id !== id);
            StateManager.setChatSessions(sessions);
            StateManager.saveSessionsToStorage();

            this.renderHistoryList();

            if (sessions.length === 0) {
                this.startNewChat();
            } else if (StateManager.getCurrentSessionId() === id) {
                this.loadSession(sessions[0].id);
            }

            window.showToast('对话已删除', 'success');
        }
    },

    async clearAllHistory() {
        const confirmed = await window.showConfirm('确认清空', '确定要清空所有对话历史吗？此操作将永久删除所有记录。');

        if (confirmed) {
            localStorage.removeItem('mathSolverSessions');
            localStorage.removeItem('mathSolverCurrentSession');
            StateManager.setChatSessions([]);
            this.startNewChat();

            const dropdown = document.getElementById('dropdownMenu');
            if (dropdown) dropdown.classList.remove('show');

            window.showToast('所有历史已清空', 'success');
        }
    },

    // ==========================================
    // Message Management
    // ==========================================
    saveMessageToCurrentSession(role, text, imageUrl = null, contextData = null) {
        const session = StateManager.getCurrentSession();
        if (session) {
            session.messages.push({ role, text, imageUrl, contextData });

            if (session.messages.length === 2 && role === 'user') {
                session.title = "数学题 " + new Date().toLocaleTimeString();
                this.renderHistoryList();
            }

            StateManager.saveSessionsToStorage();
        }
    },

    // ==========================================
    // UI Helpers
    // ==========================================
    renderHistoryList() {
        const list = document.getElementById('history-list');
        if (!list) return;

        list.innerHTML = '';
        const sessions = StateManager.getChatSessions();
        const currentId = StateManager.getCurrentSessionId();

        sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = `history-item ${session.id === currentId ? 'active' : ''}`;
            item.onclick = () => this.loadSession(session.id);
            item.innerHTML = `<span>${session.title}</span><span class="delete-chat" onclick="ChatSystem.deleteSession(event, '${session.id}')"><i data-lucide="x" style="width:16px;"></i></span>`;
            list.appendChild(item);
        });

        if (window.lucide) window.lucide.createIcons();
    },

    updateSidebarActiveState() {
        document.querySelectorAll('.history-item').forEach(item => item.classList.remove('active'));
        this.renderHistoryList();
    },

    closeSidebarMobile() {
        const { MOBILE_BREAKPOINT } = window.CONSTANTS;
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');

        if (window.innerWidth <= MOBILE_BREAKPOINT && sidebar && overlay) {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        }
    }
};

window.ChatSystem = ChatSystem;
