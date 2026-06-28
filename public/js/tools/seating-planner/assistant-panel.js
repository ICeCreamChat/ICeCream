import { sanitizeHtml } from '../../utils/sanitize.js';
import {
    applySeatingOperations,
    getPlacedStudentIds,
    parseFallbackSeatingOperations,
} from '../seating-core.js';
import * as seatingApi from './api-client.js';

export const seatingAssistantMethods = {
    getChatLayoutSnapshot() {
        const blocked = new Set(this.getBlockedLayoutCells().map(cell => `${cell.r},${cell.c}`));
        return Array.from({ length: this.rows }, (_, r) => (
            Array.from({ length: this.cols }, (_, c) => {
                if (this.rowAisles.includes(r) || this.colAisles.includes(c) || blocked.has(`${r},${c}`)) {
                    return '_aisle_';
                }
                return this.layout?.[r]?.[c] || null;
            })
        ));
    },

    showChatPendingConfirmation(text) {
        const confirm = document.getElementById('sp-chat-confirm');
        const label = document.getElementById('sp-chat-confirm-text');
        if (label) label.textContent = text || '确认执行此操作？';
        if (confirm) {
            confirm.style.display = 'flex';
            // Scroll chat messages to bottom so confirm bar is visible
            const msgs = document.getElementById('sp-chat-messages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }
    },

    async confirmMajorArrangementFromChat(prompt) {
        if (!prompt) return;
        await this.arrangeFromChat(prompt);
    },

    async arrangeFromChat(prompt) {
        if (!this.students.length) {
            this.appendChatMessage('请先导入名单，再描述要怎么排座。', 'ai');
            return;
        }
        this.appendChatMessage('<span class="sp-chat-typing">正在重新设计教室...</span>', 'ai');
        try {
            const data = await this.requestAiArrangement(prompt);
            const msgs = document.getElementById('sp-chat-messages');
            const typing = msgs?.querySelector('.sp-chat-typing');
            if (typing) typing.closest('.sp-chat-msg').remove();
            const arrangement = this.applyArrangementResult(data);
            this.recordDiagnosticEvent('chat_arrangement_success', {
                source: arrangement.source || null,
                stats: arrangement.stats || null,
                warnings: arrangement.warnings || [],
            });
            this.appendChatMessage(arrangement.reply, 'ai');
            if (arrangement.warnings.length) this.appendChatMessage(arrangement.warnings.join('；'), 'ai');
            this.hideSuggestions('arrange');
        } catch (err) {
            const msgs = document.getElementById('sp-chat-messages');
            const typing = msgs?.querySelector('.sp-chat-typing');
            if (typing) typing.closest('.sp-chat-msg').remove();
            this.appendChatMessage(`没有更新座位表：${err.message}`, 'ai');
            this.recordDiagnosticEvent('chat_arrangement_failed', {
                error: err.message || 'chat_arrangement_failed',
            });
            this.showToast(err.message, 'error');
        }
    },

    bindChatEvents() {
        const toggle = document.getElementById('sp-chat-toggle');
        const close = document.getElementById('sp-chat-close');
        const header = document.getElementById('sp-chat-header');
        const send = document.getElementById('sp-chat-send');
        const input = document.getElementById('sp-chat-input');
        const apply = document.getElementById('sp-chat-apply');
        const cancel = document.getElementById('sp-chat-cancel');

        toggle?.addEventListener('pointerdown', e => this.startChatIconDrag(e));
        toggle?.addEventListener('click', () => {
            if (this.suppressChatToggleClick()) return;
            this.toggleChat(true);
        });
        close?.addEventListener('click', () => this.toggleChat(false));
        header?.addEventListener('pointerdown', e => this.startChatDrag(e));
        send?.addEventListener('click', () => this.sendChatMessage());
        input?.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.isComposing) this.sendChatMessage();
        });
        apply?.addEventListener('click', () => this.applyChatPending());
        cancel?.addEventListener('click', () => this.cancelChatPending());

        // Mode toggle buttons
        document.querySelectorAll('.sp-chat-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setChatMode(btn.dataset.chatMode));
        });
    },

    setChatMode(mode) {
        if (!mode || mode === this._chatMode) return;
        this._chatMode = mode;
        document.querySelectorAll('.sp-chat-mode-btn').forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.chatMode === mode);
        });
        // Update input placeholder to hint at current mode
        const input = document.getElementById('sp-chat-input');
        if (input) {
            const placeholders = {
                auto: '输入指令，如：把张三往前挪...',
                micro: '微调模式 — 如：把张三和李四换一下',
                regenerate: '重排模式 — 如：重新排成考试模式',
            };
            input.placeholder = placeholders[mode] || placeholders.auto;
        }
    },

    toggleChat(open) {
        this._chatExpanded = open;
        const chat = document.getElementById('sp-chat');
        const panel = document.getElementById('sp-chat-panel');
        const toggle = document.getElementById('sp-chat-toggle');
        if (open) {
            chat.classList.add('sp-chat--open');
            panel.style.display = 'flex';
            toggle.style.display = 'none';
            requestAnimationFrame(() => this.syncChatPosition());
            document.getElementById('sp-chat-input')?.focus();
        } else {
            chat.classList.remove('sp-chat--open');
            panel.style.display = 'none';
            toggle.style.display = 'flex';
            requestAnimationFrame(() => this.syncChatPosition());
        }
    },

    getClampedChatPosition(left, top, width, height) {
        const margin = 12;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        return {
            left: Math.min(Math.max(left, margin), maxLeft),
            top: Math.min(Math.max(top, margin), maxTop),
        };
    },

    setChatPosition(left, top, width, height) {
        const chat = document.getElementById('sp-chat');
        if (!chat) return;
        const rect = chat.getBoundingClientRect();
        const clamped = this.getClampedChatPosition(
            left,
            top,
            width || rect.width,
            height || rect.height
        );
        this._chatPosition = clamped;
        chat.classList.add('sp-chat--positioned');
        chat.style.setProperty('--sp-chat-left', `${Math.round(clamped.left)}px`);
        chat.style.setProperty('--sp-chat-top', `${Math.round(clamped.top)}px`);
    },

    syncChatPosition() {
        if (!this._chatPosition) return;
        const chat = document.getElementById('sp-chat');
        if (!chat) return;
        const rect = chat.getBoundingClientRect();
        this.setChatPosition(this._chatPosition.left, this._chatPosition.top, rect.width, rect.height);
    },

    suppressChatToggleClick() {
        if (!this._suppressChatToggleClick) return false;
        this._suppressChatToggleClick = false;
        return true;
    },

    startChatIconDrag(event) {
        if (this._chatExpanded) return;
        if (event.button !== undefined && event.button !== 0) return;
        const chat = document.getElementById('sp-chat');
        if (!chat) return;
        const rect = chat.getBoundingClientRect();
        this._chatIconDragState = {
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
            height: rect.height,
            moved: false,
        };
        window.addEventListener('pointermove', this._chatIconPointerMoveHandler);
        window.addEventListener('pointerup', this._chatIconPointerUpHandler);
        window.addEventListener('pointercancel', this._chatIconPointerUpHandler);
    },

    handleChatIconDragMove(event) {
        if (!this._chatIconDragState) return;
        const state = this._chatIconDragState;
        const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
        if (!state.moved && distance < this.constructor.CHAT_DRAG_THRESHOLD) return;
        state.moved = true;
        const chat = document.getElementById('sp-chat');
        chat?.classList.add('sp-chat--dragging');
        this.setChatPosition(event.clientX - state.offsetX, event.clientY - state.offsetY, state.width, state.height);
        event.preventDefault();
    },

    stopChatIconDrag() {
        if (this._chatIconDragState) {
            const chat = document.getElementById('sp-chat');
            chat?.classList.remove('sp-chat--dragging');
            if (this._chatIconDragState.moved) this._suppressChatToggleClick = true;
            this._chatIconDragState = null;
        }
        window.removeEventListener('pointermove', this._chatIconPointerMoveHandler);
        window.removeEventListener('pointerup', this._chatIconPointerUpHandler);
        window.removeEventListener('pointercancel', this._chatIconPointerUpHandler);
    },

    startChatDrag(event) {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.target.closest('button, input')) return;

        const chat = document.getElementById('sp-chat');
        if (!chat) return;
        const rect = chat.getBoundingClientRect();
        this._chatDragState = {
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
            height: rect.height,
        };
        chat.classList.add('sp-chat--dragging');
        this.setChatPosition(rect.left, rect.top, rect.width, rect.height);
        window.addEventListener('pointermove', this._chatPointerMoveHandler);
        window.addEventListener('pointerup', this._chatPointerUpHandler);
        window.addEventListener('pointercancel', this._chatPointerUpHandler);
        event.preventDefault();
    },

    handleChatDragMove(event) {
        if (!this._chatDragState) return;
        const { offsetX, offsetY, width, height } = this._chatDragState;
        this.setChatPosition(event.clientX - offsetX, event.clientY - offsetY, width, height);
        event.preventDefault();
    },

    stopChatDrag() {
        if (this._chatDragState) {
            const chat = document.getElementById('sp-chat');
            chat?.classList.remove('sp-chat--dragging');
            this._chatDragState = null;
        }
        window.removeEventListener('pointermove', this._chatPointerMoveHandler);
        window.removeEventListener('pointerup', this._chatPointerUpHandler);
        window.removeEventListener('pointercancel', this._chatPointerUpHandler);
    },

    getSuggestionConfig(kind) {
        if (kind !== 'arrange') return null;
        return { inputId: 'sp-arrange-prompt', listId: 'sp-arrange-completions', target: 'arrange' };
    },

    getSuggestionElements(kind) {
        const config = this.getSuggestionConfig(kind);
        return {
            config,
            input: config ? document.getElementById(config.inputId) : null,
            list: config ? document.getElementById(config.listId) : null
        };
    },

    clearSuggestionState(kind) {
        const state = this._suggestionState?.[kind];
        if (!state) return;
        if (state.debounce) clearTimeout(state.debounce);
        state.controller?.abort();
        state.debounce = null;
        state.controller = null;
        state.items = [];
        state.index = -1;
        state.lastText = '';
        this.hideSuggestions(kind);
    },

    scheduleSuggestionRefresh(kind, immediate = false, options = {}) {
        const state = this._suggestionState?.[kind];
        if (!state) return;
        if (state.debounce) clearTimeout(state.debounce);
        const { input } = this.getSuggestionElements(kind);
        const text = input?.value?.trim() || '';
        if (kind === 'arrange' && options.source !== 'input') {
            state.debounce = null;
            return;
        }
        if (!text) {
            state.controller?.abort();
            state.debounce = null;
            state.lastText = '';
            this.setSuggestionItems(kind, []);
            return;
        }
        if (kind === 'arrange') {
            if (text !== this._arrangeSuggestionDismissedText) {
                this._arrangeSuggestionDismissedText = '';
            } else {
                state.debounce = null;
                return;
            }
        }
        state.debounce = setTimeout(() => this.requestSuggestions(kind), immediate ? 0 : 600);
    },

    buildSuggestionPayload(kind) {
        const config = this.getSuggestionConfig(kind);
        if (!config) return null;
        const input = document.getElementById(config.inputId);
        return {
            target: config.target,
            text: input?.value?.trim() || '',
            students: this.students.map(student => ({
                id: student.id,
                name: student.name,
                gender: student.gender,
                grade: student.grade,
                height: student.height,
            })),
            constraints: this.constraints,
            strategy: this.strategy,
            layout: this.layout.map(row => row.map(cell => cell || null)),
            rows: this.rows,
            cols: this.cols,
            history: [],
            count: 5,
        };
    },

    async requestSuggestions(kind) {
        const state = this._suggestionState?.[kind];
        if (!state || !this.container) return;
        const payload = this.buildSuggestionPayload(kind);
        if (!payload) return;
        if (!payload.text) {
            this.setSuggestionItems(kind, []);
            return;
        }
        const signature = JSON.stringify({
            target: payload.target,
            text: payload.text,
            studentCount: payload.students.length,
            constraints: payload.constraints.length,
            strategy: payload.strategy,
            placed: getPlacedStudentIds(payload.layout, {
                rows: this.rows,
                cols: this.cols,
                rowAisles: this.rowAisles,
                colAisles: this.colAisles
            }).length,
        });
        if (signature === state.lastText) {
            if (state.items.length) this.renderSuggestionList(kind);
            return;
        }
        state.lastText = signature;

        state.controller?.abort();
        const controller = new AbortController();
        state.controller = controller;

        try {
            const res = await seatingApi.fetchSuggestions(payload, { signal: controller.signal });
            if (!res.ok) throw new Error(`Suggestion request failed: ${res.status}`);
            const result = await res.json();
            const suggestions = Array.isArray(result?.data?.suggestions)
                ? result.data.suggestions
                : [];
            this.setSuggestionItems(kind, suggestions, payload.text);
        } catch (error) {
            if (error.name !== 'AbortError') this.setSuggestionItems(kind, []);
        } finally {
            if (state.controller === controller) state.controller = null;
        }
    },

    normalizeSuggestionItems(items = [], currentText = '') {
        const current = String(currentText || '').trim();
        if (!current) return [];
        const seen = new Set();
        const normalized = [];

        for (const item of items) {
            const text = String(item ?? '').replace(/^试试[:：]\s*/, '').trim();
            if (!text || text === current || !this.isSuggestionRelated(current, text)) continue;
            const clipped = text.length > 80 ? text.slice(0, 80) : text;
            if (seen.has(clipped)) continue;
            seen.add(clipped);
            normalized.push(clipped);
            if (normalized.length >= 5) break;
        }

        return normalized;
    },

    isSuggestionRelated(currentText, suggestionText) {
        const compact = value => String(value || '').toLowerCase().replace(/\s+/g, '');
        const current = compact(currentText);
        const suggestion = compact(suggestionText);
        if (!current || !suggestion) return false;
        if (suggestion.startsWith(current) || suggestion.includes(current)) return true;

        const probe = current.length <= 2 ? current : current.slice(0, Math.min(4, current.length));
        if (probe && suggestion.includes(probe)) return true;

        const chars = [...new Set([...current].filter(ch => /[a-z0-9\u4e00-\u9fa5]/i.test(ch)))];
        if (!chars.length) return false;
        const matched = chars.filter(ch => suggestion.includes(ch)).length;
        const required = current.length <= 2 ? chars.length : Math.min(3, Math.ceil(chars.length / 2));
        return matched >= required;
    },

    setSuggestionItems(kind, items = [], currentText = '') {
        const state = this._suggestionState?.[kind];
        if (!state) return;
        const { input } = this.getSuggestionElements(kind);
        const sourceText = String(currentText || input?.value || '').trim();
        if (kind === 'arrange' && sourceText && sourceText === this._arrangeSuggestionDismissedText) {
            state.items = [];
            state.index = -1;
            this.hideSuggestions(kind);
            return;
        }
        state.items = this.normalizeSuggestionItems(items, currentText || input?.value || '');
        state.index = state.items.length ? 0 : -1;
        this.renderSuggestionList(kind);
    },

    renderSuggestionList(kind) {
        const state = this._suggestionState?.[kind];
        const { config, input, list } = this.getSuggestionElements(kind);
        if (!list || !input || !state?.items.length) {
            this.hideSuggestions(kind);
            return;
        }

        list.replaceChildren();
        state.items.forEach((item, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.id = `${config.listId}-option-${index}`;
            option.className = `sp-autocomplete-option${index === state.index ? ' is-active' : ''}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === state.index));
            option.textContent = item;
            option.addEventListener('mousedown', event => event.preventDefault());
            option.addEventListener('click', () => {
                state.index = index;
                this.acceptSuggestion(kind);
            });
            list.appendChild(option);
        });

        input.setAttribute('aria-expanded', 'true');
        this.updateSuggestionActive(kind);
        list.classList.remove('sp-hidden');
    },

    hideSuggestions(kind) {
        const state = this._suggestionState?.[kind];
        const { input, list } = this.getSuggestionElements(kind);
        const wasOpen = Boolean(list && !list.classList.contains('sp-hidden'));
        if (kind === 'arrange' && wasOpen && input?.value?.trim()) {
            this._arrangeSuggestionDismissedText = input.value.trim();
        }
        if (state) state.index = state.items.length ? Math.max(0, state.index) : -1;
        list?.classList.add('sp-hidden');
        input?.setAttribute('aria-expanded', 'false');
        input?.removeAttribute('aria-activedescendant');
    },

    isSuggestionOpen(kind) {
        const { list } = this.getSuggestionElements(kind);
        return Boolean(list && !list.classList.contains('sp-hidden'));
    },

    updateSuggestionActive(kind) {
        const state = this._suggestionState?.[kind];
        const { input, list } = this.getSuggestionElements(kind);
        if (!state || !input || !list) return;
        const options = [...list.querySelectorAll('.sp-autocomplete-option')];
        options.forEach((option, index) => {
            const active = index === state.index;
            option.classList.toggle('is-active', active);
            option.setAttribute('aria-selected', String(active));
        });
        const activeOption = options[state.index];
        if (activeOption) {
            input.setAttribute('aria-activedescendant', activeOption.id);
            activeOption.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    },

    handleSuggestionKeyDown(event, kind) {
        const state = this._suggestionState?.[kind];
        if (!state || event.isComposing || event.ctrlKey || event.metaKey || !state.items.length) return false;
        const open = this.isSuggestionOpen(kind);

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) this.renderSuggestionList(kind);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            state.index = (state.index + delta + state.items.length) % state.items.length;
            this.updateSuggestionActive(kind);
            return true;
        }

        if (event.key === 'Escape' && open) {
            event.preventDefault();
            this.hideSuggestions(kind);
            return true;
        }

        if ((event.key === 'Enter' || event.key === 'Tab') && open) {
            event.preventDefault();
            this.acceptSuggestion(kind);
            return true;
        }

        return false;
    },

    acceptSuggestion(kind) {
        const state = this._suggestionState?.[kind];
        const { input } = this.getSuggestionElements(kind);
        if (!state?.items.length || !input) return false;
        const index = state.index >= 0 ? state.index : 0;
        input.value = state.items[index];
        input.focus();
        input.setSelectionRange?.(input.value.length, input.value.length);
        this.hideSuggestions(kind);
        return true;
    },

    appendChatMessage(text, role = 'user') {
        const container = document.getElementById('sp-chat-messages');
        const msg = document.createElement('div');
        msg.className = `sp-chat-msg sp-chat-msg--${role}`;
        const bubble = document.createElement('div');
        bubble.className = 'sp-chat-bubble';
        if (role === 'user') {
            bubble.textContent = text;
        } else {
            bubble.innerHTML = sanitizeHtml(text);
        }
        msg.appendChild(bubble);
        container.appendChild(msg);
        container.scrollTop = container.scrollHeight;
    },

    async sendChatMessage() {
        const input = document.getElementById('sp-chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        this.appendChatMessage(text, 'user');
        this.recordDiagnosticEvent('chat_request', {
            mode: this._chatMode,
            text,
        });

        if (!this.students.length) {
            this.appendChatMessage('请先导入名单，然后我就可以帮你调整或重新生成座位表。', 'ai');
            return;
        }

        const layoutSnapshot = this.getChatLayoutSnapshot();
        this._chatHistory.push({ role: 'user', content: text });
        this.appendChatMessage('<span class="sp-chat-typing">思考中...</span>', 'ai');

        try {
            const res = await seatingApi.fetchChat({
                message: text,
                history: this._chatHistory.slice(-10), // last 10 messages
                layout: layoutSnapshot,
                students: this.students.map(s => ({ id: s.id, name: s.name, gender: s.gender, grade: s.grade })),
                guardians: this.guardians,
                rows: this.rows,
                cols: this.cols,
                mode: this._chatMode !== 'auto' ? this._chatMode : '',
            });
            const result = await res.json();

            // Remove typing indicator
            const msgs = document.getElementById('sp-chat-messages');
            const typing = msgs.querySelector('.sp-chat-typing');
            if (typing) typing.closest('.sp-chat-msg').remove();

            if (!result.success) {
                this.recordDiagnosticEvent('chat_failed', {
                    error: result.error || 'unknown_error',
                });
                this.appendChatMessage('抱歉，出了点问题: ' + (result.error || '未知错误'), 'ai');
                return;
            }

            const data = result.data || {};
            const { reply } = data;
            const intent = data.intent || (data.mutationIntent ? 'direct_edit' : 'explain');
            let operations = Array.isArray(data.operations) ? data.operations : [];
            this.recordDiagnosticEvent('chat_response', {
                intent,
                operationCount: operations.length,
                rejected: data.rejected || [],
                needsAction: Boolean(data.needsAction),
            });
            this._chatHistory.push({ role: 'assistant', content: reply });

            const buildFallback = () => parseFallbackSeatingOperations({
                message: text,
                layout: this.layout,
                students: this.students,
                guardians: this.guardians,
                rows: this.rows,
                cols: this.cols,
                rowAisles: this.rowAisles,
                colAisles: this.colAisles,
                blockedCells: this.getBlockedLayoutCells(),
            });
            let fallback = null;

            if (intent === 'regenerate') {
                if (reply) this.appendChatMessage(reply, 'ai');
                this._chatPending = {
                    type: 'arrangement',
                    prompt: data.arrangementPrompt || text,
                };
                this.showChatPendingConfirmation(data.confirmationText || '这会重新生成座位表并可能大幅改变当前安排，确认继续吗？');
                return;
            }

            if (intent === 'batch_tune') {
                if (data.mutationIntent) {
                    fallback = buildFallback();
                    if (fallback.operations.length > 0
                        && fallback.operations.every(op => op?.type === 'set_guardian')) {
                        operations = fallback.operations;
                    } else if (operations.length === 0 && fallback.operations.length > 0) {
                        operations = fallback.operations;
                    }
                }
                if (operations.length > 0) {
                    this._chatPending = {
                        type: 'operations',
                        intent,
                        operations,
                        reply: reply || '',
                    };
                    this.showChatPendingConfirmation(data.confirmationText || '这会批量调整当前座位，但不改变布局，确认执行吗？');
                    return;
                }
                if (reply) this.appendChatMessage(reply, 'ai');
                const reason = (data.rejected || []).map(item => item.reason).filter(Boolean).join('；') || '没有可确认执行的批量调整';
                this.appendChatMessage(`没有可执行调整：${reason}`, 'ai');
                return;
            }
            if (intent === 'direct_edit' && operations.length === 0 && data.mutationIntent) {
                fallback = buildFallback();
                if (fallback.operations.length > 0) {
                    operations = fallback.operations;
                    this.appendChatMessage('我已按本地规则识别出可执行调整，正在直接修改座位。', 'ai');
                }
            }

            if (operations.length > 0) {
                let outcome = this.executeChatOps(operations);
                if (intent === 'direct_edit' && outcome.applied === 0 && data.mutationIntent) {
                    fallback = fallback || buildFallback();
                    if (fallback.operations.length > 0) {
                        const fallbackOutcome = this.executeChatOps(fallback.operations);
                        if (fallbackOutcome.applied > 0) {
                            this.appendChatMessage('目标位置落在不可坐区域，我已改用同一排最近的合法中间座位。', 'ai');
                            return;
                        }
                        outcome = fallbackOutcome;
                    }
                }
                if (outcome.applied > 0) {
                    if (outcome.rejected === 0 && reply) this.appendChatMessage(reply, 'ai');
                    const failed = outcome.rejected > 0 ? `，${outcome.rejected} 项未执行` : '';
                    this.appendChatMessage(`✅ 已调整 ${outcome.applied} 项${failed}`, 'ai');
                } else {
                    const reason = outcome.reasons?.join('；') || '目标座位不合法或学生信息不完整';
                    this.appendChatMessage(`没有可执行调整：${reason}。`, 'ai');
                }
                return;
            }

            if (reply) this.appendChatMessage(reply, 'ai');

            const rejected = [...(data.rejected || []), ...(fallback?.rejected || [])];
            if (intent !== 'clarify' && (data.needsAction || fallback?.mutationIntent || rejected.length)) {
                const reason = rejected.map(item => item.reason).filter(Boolean).join('；') || '没有可执行调整';
                this.appendChatMessage(`没有可执行调整：${reason}`, 'ai');
            }
        } catch (err) {
            // Remove typing indicator
            const msgs = document.getElementById('sp-chat-messages');
            const typing = msgs.querySelector('.sp-chat-typing');
            if (typing) typing.closest('.sp-chat-msg').remove();

            this.appendChatMessage('网络错误，请稍后重试', 'ai');
            this.recordDiagnosticEvent('chat_network_error', {
                error: err.message || 'network_error',
            });
            console.error('[Chat]', err);
        }
    },

    async applyChatPending() {
        if (this._chatPending?.type === 'arrangement') {
            const { prompt } = this._chatPending;
            this._chatPending = null;
            document.getElementById('sp-chat-confirm').style.display = 'none';
            await this.confirmMajorArrangementFromChat(prompt);
            return;
        }
        if (this._chatPending) {
            const operations = Array.isArray(this._chatPending) ? this._chatPending : this._chatPending.operations;
            const storedReply = this._chatPending.reply || '';
            const outcome = this.executeChatOps(operations);
            if (storedReply) this.appendChatMessage(storedReply, 'ai');
            if (outcome.applied > 0) {
                const failed = outcome.rejected > 0 ? `，${outcome.rejected} 项未执行` : '';
                this.appendChatMessage(`✅ 已执行 ${outcome.applied} 项${failed}`, 'ai');
            } else {
                const reason = outcome.reasons?.join('；') || '所有操作均未生效';
                this.appendChatMessage(`没有可执行调整：${reason}`, 'ai');
            }
            this._chatPending = null;
        }
        document.getElementById('sp-chat-confirm').style.display = 'none';
    },

    cancelChatPending() {
        const wasArrangement = this._chatPending?.type === 'arrangement';
        this._chatPending = null;
        document.getElementById('sp-chat-confirm').style.display = 'none';
        this.appendChatMessage(wasArrangement ? '已取消重新生成座位表。' : '❌ 已取消', 'ai');
    },

    executeChatOps(operations) {
        const result = applySeatingOperations({
            layout: this.layout,
            students: this.students,
            guardians: this.guardians,
            operations,
            rows: this.rows,
            cols: this.cols,
            rowAisles: this.rowAisles,
            colAisles: this.colAisles,
            blockedCells: this.getBlockedLayoutCells(),
        });

        if (result.rejected.length) {
            const reasons = result.rejected.map(item => item.reason).join('；');
            this.appendChatMessage(`⚠️ ${result.rejected.length} 项未执行：${reasons}`, 'ai');
        }

        if (result.applied.length) {
            this.layout = result.layout;
            this.guardians = result.guardians || this.guardians;
            if (this.classroomLayout?.guardians) {
                this.classroomLayout.guardians.left = this.guardians[0] || null;
                this.classroomLayout.guardians.right = this.guardians[1] || null;
                this.classroomLayout.guardians.enabled = Boolean(this.classroomLayout.guardians.enabled || this.guardians[0] || this.guardians[1]);
            }
            if (this.guardians.some(Boolean)) {
                document.getElementById('sp-podium-row')?.classList.add('is-expanded');
            }
            this.refreshConstraintStatus();
            this.saveSnapshot();
            this.renderGrid();
            this.renderPodiumSeats();
            this.updateStatus();
            this.highlightCells(result.affectedCells);
        }

        this.recordDiagnosticEvent(result.applied.length > 0 ? 'chat_operations_applied' : 'chat_operations_noop', {
            operationCount: operations?.length || 0,
            applied: result.applied.length,
            rejected: result.rejected.length,
            reasons: result.rejected.map(item => item.reason).filter(Boolean),
            guardians: result.guardians || this.guardians,
            affectedCells: result.affectedCells || [],
        });

        return {
            applied: result.applied.length,
            rejected: result.rejected.length,
            reasons: result.rejected.map(item => item.reason).filter(Boolean),
        };
    }
};
