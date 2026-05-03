import { sanitizeHtml } from '../utils/sanitize.js';
import {
    createClassroomLayout,
    getLayoutCapacity as getClassroomCapacity,
    isLayoutSeat,
    layoutToLegacyAisles,
} from './classroom-layout.js';
import {
    applySeatingOperations,
    colHasStudents,
    deleteAisleColumn,
    deleteAisleRow,
    deleteLocalAisle,
    evaluateSeatingConstraints,
    evaluateSeatingQuality,
    getPlacedStudentIds,
    insertAisleColumn,
    insertAisleRow,
    insertLocalAisle,
    normalizeLocalAisles,
    parseFallbackSeatingOperations,
    rowHasStudents,
} from './seating-core.js';

/**
 * Smart Seating Planner - 智能座位编排系统
 * Professional Redesign - Based on UI/UX Pro Max
 */

// Polyfill for structuredClone in older browsers
if (typeof structuredClone === 'undefined') {
    window.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

class SeatingPlanner {
    constructor() {
        this.students = [];
        this.studentMap = new Map(); // id -> student for O(1) lookup
        this.constraints = [];
        this.layout = [];
        this.rows = 6;
        this.cols = 8;
        this.colAisles = [];
        this.rowAisles = [];
        this.classroomLayout = createClassroomLayout({ rows: this.rows, cols: this.cols, template: 'standard' });
        this.strategy = {
            genderBalance: true,
            gradeStrategy: 'none',  // 'none' | 'priority' | 'balance'
            heightOrder: false
        };
        this.unsatisfied = [];
        this.container = null;
        this.dragSource = null;
        this.contextTarget = null;
        this.guardians = [null, null];
        this.unassigned = [];
        // Loading guard
        this._isGenerating = false;
        // Undo/Redo
        this._history = [];
        this._historyIndex = -1;
        // Debounce timer
        this._gridResizeTimer = null;
        // AI Chat
        this._chatHistory = [];
        this._chatExpanded = false;
        this._chatPending = null; // pending operation for confirmation
        this._chatPosition = null;
        this._chatDragState = null;
        this._chatIconDragState = null;
        this._suppressChatToggleClick = false;
        this._chatPointerMoveHandler = event => this.handleChatDragMove(event);
        this._chatPointerUpHandler = event => this.stopChatDrag(event);
        this._chatIconPointerMoveHandler = event => this.handleChatIconDragMove(event);
        this._chatIconPointerUpHandler = event => this.stopChatIconDrag(event);
        this._suggestionState = {
            arrange: { items: [], index: -1, debounce: null, controller: null, lastText: '' },
        };
        this._arrangeSuggestionDismissedText = '';
        this._chatMode = 'auto'; // 'auto' | 'micro' | 'regenerate'
        this._constraintEvaluation = { total: 0, satisfied: 0, unsatisfied: [], hardUnsatisfied: [], softUnsatisfied: [] };
        this._qualityEvaluation = { feasible: true, hardScore: 0, softScore: 0, percent: 100, label: '优秀', constraints: [], topIssues: [], hardViolationCount: 0, softViolationCount: 0 };
        this.arrangementStats = null;
        this.arrangementSource = null;
        this.arrangementInterpretation = null;
        this.arrangementSpec = null;
        this._diagnosticEvents = [];
        this._lastErrors = [];
        this.showSeatDetails = true;
        this.showScoreAnalysis = false;
        this.showArrangementExplain = false;
    }

    // ========== Constants ==========
    static MAX_HISTORY = 30;
    static VISIBLE_TAG_COUNT = 6;
    static DEFAULT_ROWS = 6;
    static DEFAULT_COLS = 8;
    static VIRTUAL_GRID_CELL_THRESHOLD = 1200;
    static VIRTUAL_GRID_ROW_HEIGHT = 104;
    static VIRTUAL_GRID_ROW_OVERSCAN = 5;
    static CHAT_DRAG_THRESHOLD = 6;

    // Build student Map from array for O(1) lookups
    _buildStudentMap() {
        this.studentMap = new Map();
        for (const s of this.students) {
            this.studentMap.set(s.id, s);
        }
    }

    getTopGradeStudentIds(minimumCount = 1) {
        const ranked = this.students
            .filter(student => Number.isFinite(Number(student?.grade)))
            .sort((a, b) => {
                const gradeDiff = Number(b.grade) - Number(a.grade);
                if (gradeDiff !== 0) return gradeDiff;
                return String(a.id).localeCompare(String(b.id));
            });
        if (!ranked.length) return new Set();
        const count = Math.max(minimumCount, Math.ceil(ranked.length * 0.2));
        return new Set(ranked.slice(0, count).map(student => student.id));
    }

    isTopGradeStudent(studentOrId, topGradeIds = this.getTopGradeStudentIds()) {
        const id = typeof studentOrId === 'object' ? studentOrId?.id : studentOrId;
        return Boolean(id && topGradeIds.has(id));
    }

    // ========== Undo / Redo ==========
    saveSnapshot() {
        // Trim future states if we branched
        if (this._historyIndex < this._history.length - 1) {
            this._history = this._history.slice(0, this._historyIndex + 1);
        }
        this._history.push({
            layout: structuredClone(this.layout),
            guardians: [...this.guardians],
            colAisles: [...this.colAisles],
            rowAisles: [...this.rowAisles],
            classroomLayout: structuredClone(this.classroomLayout),
            unassigned: [...this.unassigned]
        });
        if (this._history.length > SeatingPlanner.MAX_HISTORY) {
            this._history.shift();
        }
        this._historyIndex = this._history.length - 1;
    }

    undo() {
        if (this._historyIndex <= 0) return this.showToast('没有可撤销的操作', 'warning');
        this._historyIndex--;
        const snap = this._history[this._historyIndex];
        this.layout = structuredClone(snap.layout);
        this.guardians = [...snap.guardians];
        this.colAisles = [...(snap.colAisles || [])];
        this.rowAisles = [...(snap.rowAisles || [])];
        this.classroomLayout = snap.classroomLayout ? structuredClone(snap.classroomLayout) : this.legacyLayoutToClassroomLayout();
        this.unassigned = [...(snap.unassigned || [])];
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        this.showToast('已撤销', 'info');
    }

    redo() {
        if (this._historyIndex >= this._history.length - 1) return this.showToast('没有可重做的操作', 'warning');
        this._historyIndex++;
        const snap = this._history[this._historyIndex];
        this.layout = structuredClone(snap.layout);
        this.guardians = [...snap.guardians];
        this.colAisles = [...(snap.colAisles || [])];
        this.rowAisles = [...(snap.rowAisles || [])];
        this.classroomLayout = snap.classroomLayout ? structuredClone(snap.classroomLayout) : this.legacyLayoutToClassroomLayout();
        this.unassigned = [...(snap.unassigned || [])];
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        this.showToast('已重做', 'info');
    }

    init(container) {
        this.container = container;
        this.render();
        this.bindEvents();
        this.bindPodiumEvents(); // Bind events for static podium seats
        console.log('[SeatingPlanner] Initialized with new design');
    }

    destroy() {
        // Clean up global event listeners to prevent memory leaks
        if (this._undoRedoHandler) {
            document.removeEventListener('keydown', this._undoRedoHandler);
            this._undoRedoHandler = null;
        }
        if (this._textKeyDownHandler) {
            window.removeEventListener('keydown', this._textKeyDownHandler);
            this._textKeyDownHandler = null;
        }
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this._virtualGridScrollTarget && this._virtualGridScrollHandler) {
            this._virtualGridScrollTarget.removeEventListener('scroll', this._virtualGridScrollHandler);
            this._virtualGridScrollTarget = null;
            this._virtualGridScrollHandler = null;
        }
        if (this._seatDetailsToggleHandler) {
            document.removeEventListener('click', this._seatDetailsToggleHandler);
            this._seatDetailsToggleHandler = null;
        }
        this.clearSuggestionState('arrange');
        this.stopChatDrag();
        this.stopChatIconDrag();
        // Clean up guide scroll observer
        if (this._guideObserver) {
            this._guideObserver.disconnect();
            this._guideObserver = null;
        }
        this.container = null;
        console.log('[SeatingPlanner] Destroyed and cleaned up listeners');
    }

    // Helper to get seat value (student ID or null)
    getSeat(r, c) {
        if (r === -1) {
            return this.guardians[c];
        }
        return this.layout[r]?.[c];
    }

    // Helper to set seat value
    setSeat(r, c, val) {
        if (r === -1) {
            this.guardians[c] = val;
        } else {
            if (!this.layout[r]) this.layout[r] = [];
            this.layout[r][c] = val;
        }
    }

    legacyLayoutToClassroomLayout(template = 'custom') {
        const layout = createClassroomLayout({
            rows: this.rows,
            cols: this.cols,
            template: 'standard',
            guardiansEnabled: this.isGuardiansEnabled(),
            guardians: { left: this.guardians[0], right: this.guardians[1] }
        });
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (this.rowAisles.includes(r) || this.colAisles.includes(c)) {
                    layout.cells[r][c] = 'aisle';
                    layout.groups[r][c] = null;
                }
            }
        }
        layout.template = template;
        layout.localAisles = normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols);
        return layout;
    }

    isGuardiansEnabled() {
        return document.getElementById('sp-podium-row')?.classList.contains('is-expanded')
            || Boolean(this.classroomLayout?.guardians?.enabled);
    }

    getBlockedLayoutCells(layout = this.classroomLayout) {
        const blocked = [];
        for (let r = 0; r < (layout?.rows || this.rows); r++) {
            for (let c = 0; c < (layout?.cols || this.cols); c++) {
                if (!isLayoutSeat(layout, r, c)) blocked.push({ r, c });
            }
        }
        return blocked;
    }

    getArrangePrompt() {
        return document.getElementById('sp-arrange-prompt')?.value?.trim() || '';
    }

    pickArrangeCompletion(suggestions = [], currentText = '') {
        const normalized = currentText
            ? this.normalizeSuggestionItems(suggestions, currentText)
            : suggestions
                .map(item => String(item ?? '').replace(/^试试[:：]\s*/, '').trim())
                .filter(Boolean);
        return normalized[0] || '';
    }

    async completeArrangePrompt() {
        const prompt = document.getElementById('sp-arrange-prompt');
        const button = document.getElementById('sp-complete-arrange-prompt');
        if (!prompt || !button) return;

        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i><span>补全中</span>';
        if (window.lucide) window.lucide.createIcons();

        const state = this._suggestionState?.arrange;
        state?.controller?.abort();
        const controller = new AbortController();
        if (state) state.controller = controller;

        try {
            const payload = this.buildSuggestionPayload('arrange');
            if (!payload) throw new Error('无法读取排座要求');
            payload.count = 3;

            const res = await fetch('/api/tools/seating/suggestions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`Suggestion request failed: ${res.status}`);
            const result = await res.json();
            const suggestions = Array.isArray(result?.data?.suggestions)
                ? result.data.suggestions
                : [];
            const completion = this.pickArrangeCompletion(suggestions, payload.text);
            if (!completion) throw new Error('AI 暂时没有给出可用补全');

            prompt.value = completion;
            prompt.focus();
            prompt.setSelectionRange?.(prompt.value.length, prompt.value.length);
            this._arrangeSuggestionDismissedText = '';
            this.hideSuggestions('arrange');
            this.recordDiagnosticEvent('arrange_completion_success', {
                suggestionCount: suggestions.length,
                textLength: completion.length,
            });
            this.showToast('已补全排座要求', 'success');
        } catch (error) {
            if (error.name !== 'AbortError') {
                this.recordDiagnosticEvent('arrange_completion_failed', {
                    error: error.message || 'completion_failed',
                });
                this.showToast(error.message || '补全要求失败，请稍后再试', 'warning');
            }
        } finally {
            if (state?.controller === controller) state.controller = null;
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.innerHTML = originalHtml;
            if (window.lucide) window.lucide.createIcons();
        }
    }

    getCurrentAssignments() {
        const assignments = [];
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const studentId = this.layout?.[r]?.[c];
                if (studentId && studentId !== '_aisle_') assignments.push({ studentId, row: r, col: c });
            }
        }
        return assignments;
    }

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
    }

    normalizeArrangementForApply(data) {
        const errors = [];
        const sourceLayout = data?.classroomLayout;
        if (!sourceLayout || !Array.isArray(sourceLayout.cells)) {
            throw new Error('AI 没有返回有效教室布局');
        }
        const rows = Number(sourceLayout.rows || sourceLayout.cells.length);
        const cols = Number(sourceLayout.cols || sourceLayout.cells[0]?.length || 0);
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
            throw new Error('AI 返回的教室尺寸不合法');
        }

        const cells = sourceLayout.cells.map((row, r) => {
            if (!Array.isArray(row) || row.length !== cols) {
                errors.push(`第 ${r + 1} 行列数不一致`);
                return Array.from({ length: cols }, () => 'empty');
            }
            return row.map((cell, c) => {
                if (cell === 'seat' || cell === 1 || cell === true || cell === '1') return 'seat';
                if (cell === 'aisle' || cell === 0 || cell === false || cell === '0') return 'aisle';
                if (cell === 'empty') return 'empty';
                errors.push(`第 ${r + 1} 行第 ${c + 1} 列不是合法格子`);
                return 'empty';
            });
        });
        if (cells.length !== rows) errors.push('布局行数不一致');

        const groups = Array.from({ length: rows }, (_, r) => {
            const groupRow = Array.isArray(sourceLayout.groups?.[r]) ? sourceLayout.groups[r] : [];
            return Array.from({ length: cols }, (_, c) => groupRow[c] ?? null);
        });
        const classroomLayout = {
            rows,
            cols,
            cells,
            groups,
            guardians: {
                enabled: Boolean(sourceLayout.guardians?.enabled || data.guardians?.left || data.guardians?.right),
                left: data.guardians?.left ?? sourceLayout.guardians?.left ?? null,
                right: data.guardians?.right ?? sourceLayout.guardians?.right ?? null,
            },
            template: sourceLayout.template || 'ai',
            groupSize: sourceLayout.groupSize || 1,
            localAisles: normalizeLocalAisles(sourceLayout.localAisles, rows, cols),
        };

        const knownIds = new Set(this.students.map(student => student.id));
        const placedStudents = new Set();
        const occupiedSeats = new Set();
        const assignments = [];
        for (const item of data.assignments || []) {
            const studentId = String(item.studentId || item.student_id || item.id || '').trim();
            const row = Number(item.row);
            const col = Number(item.col);
            if (!knownIds.has(studentId)) {
                errors.push(`未知学生 id: ${studentId || '空'}`);
                continue;
            }
            if (placedStudents.has(studentId)) {
                errors.push(`${this.studentMap.get(studentId)?.name || studentId} 被重复安排`);
                continue;
            }
            if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= rows || col >= cols) {
                errors.push(`${this.studentMap.get(studentId)?.name || studentId} 的座位越界`);
                continue;
            }
            if (classroomLayout.cells[row][col] !== 'seat') {
                errors.push(`${this.studentMap.get(studentId)?.name || studentId} 被安排到过道或空地`);
                continue;
            }
            const seatKey = `${row},${col}`;
            if (occupiedSeats.has(seatKey)) {
                errors.push(`第${row + 1}排第${col + 1}列被重复安排`);
                continue;
            }
            assignments.push({ studentId, row, col });
            placedStudents.add(studentId);
            occupiedSeats.add(seatKey);
        }

        const guardians = {
            left: classroomLayout.guardians.left || null,
            right: classroomLayout.guardians.right || null,
        };
        for (const id of [guardians.left, guardians.right].filter(Boolean)) {
            if (!knownIds.has(id)) errors.push(`护法位包含未知学生 id: ${id}`);
            if (placedStudents.has(id)) errors.push(`${this.studentMap.get(id)?.name || id} 被重复安排`);
            placedStudents.add(id);
        }

        const unassigned = (Array.isArray(data.unassigned) ? data.unassigned : [])
            .map(item => typeof item === 'object' ? (item.studentId || item.id) : item)
            .map(id => String(id || '').trim())
            .filter(Boolean);
        const unassignedSet = new Set(unassigned);
        for (const id of unassignedSet) {
            if (!knownIds.has(id)) errors.push(`未安排名单包含未知学生 id: ${id}`);
            if (placedStudents.has(id)) errors.push(`${this.studentMap.get(id)?.name || id} 同时被安排和未安排`);
        }
        const missing = this.students.filter(student => !placedStudents.has(student.id) && !unassignedSet.has(student.id));
        if (missing.length) errors.push(`缺少学生：${missing.map(student => student.name).join('、')}`);

        if (errors.length) throw new Error(errors.join('；'));
        return {
            reply: data.reply || '已根据需求生成座位表',
            classroomLayout,
            assignments,
            guardians,
            unassigned,
            warnings: Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [],
            reasoning: data.reasoning || '',
            source: data.source || null,
            stats: data.stats || null,
            interpretation: data.interpretation || null,
            arrangementSpec: data.arrangementSpec || null,
        };
    }

    applyArrangementResult(data, { save = true } = {}) {
        const arrangement = this.normalizeArrangementForApply(data);
        this.rows = arrangement.classroomLayout.rows;
        this.cols = arrangement.classroomLayout.cols;
        this.classroomLayout = structuredClone(arrangement.classroomLayout);
        this.classroomLayout.localAisles = normalizeLocalAisles(this.classroomLayout.localAisles, this.rows, this.cols);
        this.guardians = [arrangement.guardians.left || null, arrangement.guardians.right || null];
        this.classroomLayout.guardians.left = this.guardians[0];
        this.classroomLayout.guardians.right = this.guardians[1];
        this.classroomLayout.guardians.enabled = Boolean(this.classroomLayout.guardians.enabled || this.guardians[0] || this.guardians[1]);
        this.unassigned = [...arrangement.unassigned];
        this.arrangementStats = arrangement.stats || null;
        this.arrangementSource = arrangement.source || null;
        this.arrangementInterpretation = arrangement.interpretation || null;
        this.arrangementSpec = arrangement.arrangementSpec || null;

        this.layout = Array.from({ length: this.rows }, () => Array(this.cols).fill(null));
        for (const assignment of arrangement.assignments) {
            this.layout[assignment.row][assignment.col] = assignment.studentId;
        }

        const aisles = layoutToLegacyAisles(this.classroomLayout);
        this.rowAisles = aisles.rowAisles;
        this.colAisles = aisles.colAisles;
        if (this.classroomLayout.guardians.enabled) {
            document.getElementById('sp-podium-row')?.classList.add('is-expanded');
        } else {
            document.getElementById('sp-podium-row')?.classList.remove('is-expanded');
        }
        this.refreshConstraintStatus();
        if (save) this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        document.getElementById('sp-export-png') && (document.getElementById('sp-export-png').disabled = false);
        document.getElementById('sp-export-excel') && (document.getElementById('sp-export-excel').disabled = false);
        return arrangement;
    }

    async requestAiArrangement(prompt) {
        this.recordDiagnosticEvent('arrangement_request', {
            prompt,
            studentCount: this.students.length,
            constraintCount: this.constraints.length,
        });
        const res = await fetch('/api/tools/seating/arrange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                students: this.students.map(student => ({
                    id: student.id,
                    name: student.name,
                    gender: student.gender,
                    grade: student.grade,
                    height: student.height,
                })),
                constraints: this.constraints,
                strategy: this.strategy,
                previousLayout: this.classroomLayout,
                previousAssignments: this.getCurrentAssignments(),
            }),
        });
        const result = await res.json().catch(() => ({ success: false, error: 'AI 排座服务返回格式错误' }));
        if (!res.ok || !result.success) {
            this.recordDiagnosticEvent('arrangement_request_failed', {
                status: res.status,
                error: result.error || 'AI arrange failed',
            });
            const details = Array.isArray(result.details) && result.details.length ? `：${result.details.join('；')}` : '';
            throw new Error(`${result.error || 'AI 排座失败'}${details}`);
        }
        this.recordDiagnosticEvent('arrangement_request_success', {
            source: result.data?.source || null,
            stats: result.data?.stats || null,
            warnings: result.data?.warnings || [],
        });
        return result.data;
    }

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
    }

    async confirmMajorArrangementFromChat(prompt) {
        if (!prompt) return;
        await this.arrangeFromChat(prompt);
    }

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
    }

    applyClassroomLayout(layout, { save = true } = {}) {
        const hidden = [];
        for (let r = 0; r < this.layout.length; r++) {
            for (let c = 0; c < (this.layout[r]?.length || 0); c++) {
                const id = this.layout[r]?.[c];
                if (id && id !== '_aisle_' && (r >= layout.rows || c >= layout.cols || layout.cells?.[r]?.[c] !== 'seat')) {
                    hidden.push(id);
                }
            }
        }
        if (hidden.length > 0) {
            this.showToast(`新布局会覆盖 ${hidden.length} 名已安排学生，请先重新生成或清空相关座位`, 'warning');
            return false;
        }

        this.rows = layout.rows;
        this.cols = layout.cols;
        this.classroomLayout = structuredClone(layout);
        this.classroomLayout.localAisles = normalizeLocalAisles(this.classroomLayout.localAisles, this.rows, this.cols);
        this.classroomLayout.guardians.left = this.guardians[0];
        this.classroomLayout.guardians.right = this.guardians[1];
        const aisles = layoutToLegacyAisles(this.classroomLayout);
        this.rowAisles = aisles.rowAisles;
        this.colAisles = aisles.colAisles;
        document.getElementById('sp-rows') && (document.getElementById('sp-rows').value = this.rows);
        document.getElementById('sp-cols') && (document.getElementById('sp-cols').value = this.cols);
        if (layout.guardians?.enabled) {
            document.getElementById('sp-podium-row')?.classList.add('is-expanded');
        } else {
            document.getElementById('sp-podium-row')?.classList.remove('is-expanded');
        }
        this.refreshConstraintStatus();
        if (save) this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        return true;
    }


    // ========== Podium / Guardian Seats ==========
    bindPodiumEvents() {
        const left = document.getElementById('sp-guardian-left');
        const right = document.getElementById('sp-guardian-right');
        [left, right].forEach((seat, index) => {
            if (!seat) return;
            // Drag Start
            seat.addEventListener('dragstart', e => this.handleDragStart(e, -1, index));
            seat.addEventListener('dragend', e => this.handleDragEnd(e));
            // Drop Target
            seat.addEventListener('dragover', e => this.handleDragOver(e));
            seat.addEventListener('dragenter', e => this.handleDragEnter(e, seat));
            seat.addEventListener('dragleave', e => this.handleDragLeave(e, seat));
            seat.addEventListener('drop', e => this.handleDrop(e, -1, index)); // Row -1
            // Context Menu (optional, maybe just clear)
            seat.addEventListener('contextmenu', e => {
                e.preventDefault();
                if (this.guardians[index]) {
                    this.saveSnapshot();
                    this.guardians[index] = null;
                    this.renderPodiumSeats();
                    this.showToast('护法座位已清空', 'success');
                }
            });
        });
    }

    renderPodiumSeats() {
        const left = document.getElementById('sp-guardian-left');
        const right = document.getElementById('sp-guardian-right');
        [left, right].forEach((seat, index) => {
            if (!seat) return;
            const studentId = this.guardians[index];
            // Clear current content (keep the desk div if we want, but easiest is rebuild)
            seat.innerHTML = '';
            // Reset classes
            seat.className = 'sp-seat sp-seat--guardian';
            if (studentId) {
                const student = this.studentMap.get(studentId);
                if (student) {
                    seat.classList.add('sp-seat--filled');
                    seat.dataset.studentId = student.id;
                    seat.setAttribute('draggable', 'true'); // Make draggable

                    // === The Desk ===
                    const desk = document.createElement('div');
                    desk.className = 'sp-desk';
                    // Name Tag
                    const nameTag = document.createElement('span');
                    nameTag.className = 'sp-name-tag';
                    nameTag.textContent = student.name;
                    desk.appendChild(nameTag);
                    const meta = this.renderSeatMeta(student);
                    if (meta) desk.appendChild(meta);
                    seat.appendChild(desk);
                    // === The Chair Back ===
                    const chair = document.createElement('div');
                    chair.className = `sp-chair sp-chair--${student.gender === 'M' ? 'male' : 'female'}`;
                    seat.appendChild(chair);

                    // === Tooltip ===
                    const tooltip = document.createElement('div');
                    tooltip.className = 'sp-seat-tooltip';
                    tooltip.textContent = `${student.name} (左右护法)`;
                    seat.appendChild(tooltip);

                } else {
                    // Invalid ID? Treat as empty
                    this.guardians[index] = null;
                    seat.classList.add('sp-seat--empty');
                    const desk = document.createElement('div');
                    desk.className = 'sp-desk';
                    seat.appendChild(desk);
                    seat.removeAttribute('draggable');
                }
            } else {
                seat.classList.add('sp-seat--empty');
                const desk = document.createElement('div');
                desk.className = 'sp-desk';
                seat.appendChild(desk);
                seat.removeAttribute('draggable');
            }
        });
    }


    // ========== Drag & Drop ==========
    handleDragStart(e, row, col) {
        this.dragSource = { row, col };
        e.target.classList.add('sp-seat--dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Use timeout to allow drag image to be generated before hiding element
        setTimeout(() => e.target.style.opacity = '0.4', 0);
    }

    handleDragEnd(e) {
        e.target.classList.remove('sp-seat--dragging');
        e.target.style.opacity = '1';
        this.dragSource = null;
        document.querySelectorAll('.sp-seat--drag-over').forEach(c => c.classList.remove('sp-seat--drag-over'));
    }

    handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    handleDragEnter(e, cell) {
        e.preventDefault(); if (!cell.classList.contains('sp-seat--dragging')) cell.classList.add('sp-seat--drag-over');
    }

    handleDragLeave(e, cell) { cell.classList.remove('sp-seat--drag-over'); }

    handleDrop(e, targetRow, targetCol) {
        e.preventDefault();
        e.currentTarget.classList.remove('sp-seat--drag-over');
        if (!this.dragSource) return;
        const { row: sr, col: sc } = this.dragSource;
        if (sr === targetRow && sc === targetCol) return;
        this.swapSeats(sr, sc, targetRow, targetCol);
    }

    swapSeats(r1, c1, r2, c2) {
        const val1 = this.getSeat(r1, c1);
        const val2 = this.getSeat(r2, c2);

        this.setSeat(r1, c1, val2);
        this.setSeat(r2, c2, val1);
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        const s1 = this.studentMap.get(val1);
        const s2 = this.studentMap.get(val2);
        this.recordDiagnosticEvent('seat_swap', {
            from: { row: r1, col: c1, studentId: val1 || null },
            to: { row: r2, col: c2, studentId: val2 || null },
            guardian: r1 === -1 || r2 === -1,
        });
        if (r1 === -1 || r2 === -1) {
            this.showToast(`护法位已更新`, 'success');
        } else {
            this.showToast(`已交换: ${s2?.name || '空位'} ↔ ${s1?.name || '空位'}`, 'success');
        }
    }

    render() {
        this.container.innerHTML = `
            <div class="sp-app">
                <!-- Header -->
                <header class="sp-header">
                    <div class="sp-header-left">
                        <h1 class="sp-title">
                            <span class="sp-title-icon">
                                <i data-lucide="layout-grid"></i>
                            </span>
                            智能座位安排
                        </h1>
                        <span class="sp-badge" id="sp-student-count">
                            <i data-lucide="users"></i>
                            <span>0 人</span>
                        </span>
                    </div>
                    <div class="sp-header-right">
                        <div class="sp-legend">
                            <span class="sp-legend-item">
                                <span class="sp-legend-dot sp-legend-dot--male"></span>男
                            </span>
                            <span class="sp-legend-item">
                                <span class="sp-legend-dot sp-legend-dot--female"></span>女
                            </span>
                        </div>
                        <button id="sp-export-png" class="sp-icon-btn" disabled title="导出图片">
                            <i data-lucide="image"></i>
                        </button>
                        <button id="sp-export-excel" class="sp-icon-btn" disabled title="导出Excel">
                            <i data-lucide="table"></i>
                        </button>
                    </div>
                </header>

                <!-- Main content -->
                <main class="sp-main">
                    <!-- Left Panel -->
                    <aside class="sp-panel">
                        <!-- Students Section -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="users"></i>
                                    学生名单
                                </h3>
                                <div class="sp-section-actions">
                                    <input type="file" id="sp-image-input" accept="image/*" class="sp-hidden">
                                    <button class="sp-section-action" id="sp-upload-image" title="拍照/上传图片">
                                        <i data-lucide="camera"></i>
                                    </button>
                                    <button class="sp-section-action" id="sp-clear-students" title="清空">
                                        <i data-lucide="trash-2"></i>
                                    </button>
                                </div>
                            </div>
                            <div class="sp-dropzone" id="sp-dropzone">
                                <input type="file" id="sp-file-input" class="sp-file-input" accept=".csv,.xlsx,.xls,.txt">
                                <div class="sp-dropzone-icon">
                                    <i data-lucide="upload"></i>
                                </div>
                                <div class="sp-dropzone-text">点击选择或拖拽文件</div>
                                <div class="sp-dropzone-hint">支持 Excel / CSV / 文本</div>
                            </div>
                            <textarea id="sp-students-input" class="sp-textarea sp-hidden"                                placeholder="粘贴学生名单，每行一人&#10;&#10;支持格式:&#10;张三&#10;李四 男 180 85"></textarea>
                            <button id="sp-parse-students" class="sp-btn sp-btn--block sp-btn--sm sp-hidden">
                                <i data-lucide="check"></i>
                                编辑名单
                            </button>
                            <div id="sp-students-preview" class="sp-tags"></div>
                        </section>

                        <!-- Constraints Section -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="message-circle"></i>
                                    学生需求
                                </h3>
                            </div>
                            <textarea id="sp-constraints-input" class="sp-textarea"
                                placeholder="收集学生想坐哪里，想避开谁，或需要老师照顾的情况&#10;&#10;例如:&#10;张三视力不好想坐前排&#10;李四和王五不想坐一起&#10;赵六想和钱七同桌"></textarea>
                            <button id="sp-parse-constraints" class="sp-btn sp-btn--block sp-btn--sm">
                                <i data-lucide="sparkles"></i>
                                提取需求
                            </button>
                            <div id="sp-constraints-list" class="sp-constraints"></div>
                        </section>

                        <!-- Strategy Section -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="settings"></i>
                                    搭配偏好
                                </h3>
                            </div>
                            <div class="sp-strategies">
                                <label class="sp-strategy">
                                    <input type="checkbox" id="sp-gender" checked>
                                    <span class="sp-strategy-toggle"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="users"></i>
                                        男女搭配
                                    </span>
                                </label>
                                <label class="sp-strategy">
                                    <input type="checkbox" id="sp-height">
                                    <span class="sp-strategy-toggle"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="arrow-up-down"></i>
                                        身高照顾
                                    </span>
                                </label>
                            </div>
                            <div class="sp-section-header sp-mt-sm">
                                <h3 class="sp-section-title">
                                    <i data-lucide="bar-chart-3"></i>
                                    成绩策略
                                </h3>
                            </div>
                            <div class="sp-strategies sp-strategies--radio">
                                <label class="sp-strategy">
                                    <input type="radio" name="sp-grade-strategy" value="none" checked>
                                    <span class="sp-strategy-radio"></span>
                                    <span class="sp-strategy-label">无</span>
                                </label>
                                <label class="sp-strategy">
                                    <input type="radio" name="sp-grade-strategy" value="priority">
                                    <span class="sp-strategy-radio"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="trophy"></i>
                                        优秀优先
                                    </span>
                                </label>
                                <label class="sp-strategy">
                                    <input type="radio" name="sp-grade-strategy" value="balance">
                                    <span class="sp-strategy-radio"></span>
                                    <span class="sp-strategy-label">
                                        <i data-lucide="shuffle"></i>
                                        强弱互补
                                    </span>
                                </label>
                            </div>
                        </section>

                        <!-- AI seating requirement -->
                        <section class="sp-section">
                            <div class="sp-section-header">
                                <h3 class="sp-section-title">
                                    <i data-lucide="sparkles"></i>
                                    排座要求
                                </h3>
                                <button type="button" id="sp-complete-arrange-prompt" class="sp-btn sp-btn--sm sp-arrange-complete">
                                    <i data-lucide="wand-sparkles"></i>
                                    <span>补全要求</span>
                                </button>
                            </div>
                            <div class="sp-autocomplete-anchor">
                                <textarea id="sp-arrange-prompt" class="sp-arrange-prompt" rows="4" placeholder="例如：两人一组，中间留过道，讲台旁安排左右护法，护法位置要一个成绩较差一个成绩较好的" aria-autocomplete="list" aria-expanded="false" aria-controls="sp-arrange-completions"></textarea>
                                <div id="sp-arrange-completions" class="sp-autocomplete sp-autocomplete--above sp-hidden" role="listbox"></div>
                            </div>
                        </section>

                        <!-- Generate Button -->
                        <button id="sp-generate" class="sp-btn sp-btn--primary sp-btn--block" disabled>
                            <i data-lucide="sparkles"></i>
                            生成座位表
                        </button>
                    </aside>

                    <!-- Right Classroom -->
                    <section class="sp-classroom">
                        <div class="sp-classroom-view">
                            <!-- Cinematic Blackboard Scene -->
                            <div class="sp-blackboard-scene">
                                <!-- The Blackboard -->
                                <div class="sp-blackboard" id="sp-blackboard">
                                    <div class="sp-blackboard-frame"></div>
                                    <!-- Ghost Symbols (High School Subjects) -->
                                    <div class="sp-blackboard-notes">
                                        <div>今天也要加油 ✨</div>
                                        <div>本项目感谢李妮姗女士出谋划策 ✨</div>
                                    </div>
                                    <!-- Chalk Tray -->
                                    <div class="sp-chalk-tray" id="sp-chalk-tray">
                                        <div class="sp-chalk sp-chalk--white"></div>
                                        <div class="sp-chalk sp-chalk--red"></div>
                                        <div class="sp-chalk sp-chalk--yellow"></div>
                                        <div class="sp-eraser"></div>
                                        <div class="sp-chalk sp-chalk--blue"></div>
                                    </div>
                                </div>
                                <!-- Podium Row: Left Guardian + Podium + Right Guardian -->
                                <div class="sp-podium-row" id="sp-podium-row">
                                    <!-- Left Guardian Seat -->
                                    <div class="sp-seat sp-seat--guardian sp-seat--empty" id="sp-guardian-left">
                                        <div class="sp-desk"></div>
                                    </div>
                                    <!-- Podium (Center) -->
                                    <div class="sp-podium" id="sp-podium">
                                        <div class="sp-podium-toggle" id="sp-podium-toggle" title="启用/禁用左右护法"></div>
                                    </div>
                                    <!-- Right Guardian Seat -->
                                    <div class="sp-seat sp-seat--guardian sp-seat--empty" id="sp-guardian-right">
                                        <div class="sp-desk"></div>
                                    </div>
                                </div>
                            </div>
                            <div id="sp-grid" class="sp-grid"></div>
                            <div id="sp-aisle-gap-layer" class="sp-aisle-gap-layer" aria-hidden="true"></div>
                        </div>
                        <div class="sp-status" id="sp-status">
                            <div class="sp-status-left">
                                <span class="sp-status-item">
                                    <i data-lucide="info"></i>
                                    点击右键设置过道
                                </span>
                            </div>
                            <div class="sp-status-right"></div>
                        </div>
                        <div class="sp-arrangement-explain sp-hidden" id="sp-arrangement-explain" aria-live="polite"></div>
                        <div class="sp-score-analysis sp-hidden" id="sp-score-analysis" aria-live="polite"></div>

                        <!-- AI Floating Chat Bar -->
                        <div class="sp-chat" id="sp-chat">
                            <button class="sp-chat-toggle" id="sp-chat-toggle" title="ICeCream 座位助手" aria-label="打开 ICeCream 座位助手">
                                <i data-lucide="bot"></i>
                            </button>
                            <div class="sp-chat-panel" id="sp-chat-panel">
                                <div class="sp-chat-header" id="sp-chat-header" title="拖动浮窗">
                                    <div class="sp-chat-header-left">
                                        <span class="sp-chat-drag-icon" aria-hidden="true">
                                            <i data-lucide="grip-vertical"></i>
                                        </span>
                                        <span class="sp-chat-title-icon">
                                            <i data-lucide="bot"></i>
                                        </span>
                                        <span>ICeCream 座位助手</span>
                                    </div>
                                    <div class="sp-chat-mode" id="sp-chat-mode">
                                        <button type="button" class="sp-chat-mode-btn is-active" data-chat-mode="auto" title="自动判断大改还是微调">自动</button>
                                        <button type="button" class="sp-chat-mode-btn" data-chat-mode="micro" title="仅微调，不重新排座">微调</button>
                                        <button type="button" class="sp-chat-mode-btn" data-chat-mode="regenerate" title="重新生成整张座位表">重排</button>
                                    </div>
                                    <button class="sp-chat-close" id="sp-chat-close" aria-label="关闭 ICeCream 座位助手">
                                        <i data-lucide="x"></i>
                                    </button>
                                </div>
                                <div class="sp-chat-messages" id="sp-chat-messages">
                                    <div class="sp-chat-msg sp-chat-msg--ai">
                                        <div class="sp-chat-bubble">你好！我是 ICeCream 座位助手，可以帮你微调座位。试试说：<br>• "帮我检查一下现在的座位"<br>• "把张三和李四换一下"<br>• "把成绩弱的同学分散开"<br>• "重新排成考试模式"</div>
                                    </div>
                                </div>
                                <div class="sp-chat-confirm" id="sp-chat-confirm" style="display:none">
                                    <span id="sp-chat-confirm-text">确认执行此操作？</span>
                                    <div class="sp-chat-confirm-btns">
                                        <button class="sp-btn sp-btn--sm" id="sp-chat-cancel">取消</button>
                                        <button class="sp-btn sp-btn--sm sp-btn--primary" id="sp-chat-apply">确认</button>
                                    </div>
                                </div>
                                <div class="sp-chat-input-row">
                                     <div class="sp-chat-input-wrap">
                                        <input type="text" class="sp-chat-input" id="sp-chat-input" placeholder="输入指令，如：把张三往前挪..." autocomplete="off" />
                                    </div>
                                    <button class="sp-chat-send" id="sp-chat-send" aria-label="发送">
                                        <i data-lucide="send"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>
                </main>

                <!-- Context Menu -->
                <div id="sp-context-menu" class="sp-context-menu">
                    <button class="sp-context-item" data-action="set-col-aisle">
                        <i data-lucide="move-vertical"></i>
                        设为竖过道（整列）
                    </button>
                    <button class="sp-context-item" data-action="set-row-aisle">
                        <i data-lucide="move-horizontal"></i>
                        设为横过道（整行）
                    </button>
                    <button class="sp-context-item" data-action="clear-aisle">
                        <i data-lucide="square"></i>
                        取消过道
                    </button>
                    <div class="sp-context-divider"></div>
                    <button class="sp-context-item" data-action="clear-seat">
                        <i data-lucide="user-minus"></i>
                        清空座位
                    </button>
                </div>

                <div id="sp-image-review" class="sp-image-review sp-hidden" role="dialog" aria-modal="true" aria-labelledby="sp-image-review-title">
                    <div class="sp-image-review-panel">
                        <div class="sp-image-review-header">
                            <h3 id="sp-image-review-title">识别结果确认</h3>
                            <button type="button" class="sp-image-review-close" id="sp-image-review-cancel" aria-label="取消">
                                <i data-lucide="x"></i>
                            </button>
                        </div>
                        <div class="sp-image-review-warnings" id="sp-image-review-warnings"></div>
                        <div class="sp-roster-toolbar sp-hidden" id="sp-roster-toolbar">
                            <button type="button" class="sp-btn sp-btn--sm" id="sp-roster-add-row">
                                <i data-lucide="user-plus"></i>
                                添加一行
                            </button>
                            <button type="button" class="sp-btn sp-btn--sm" id="sp-roster-bulk-toggle">
                                <i data-lucide="clipboard-paste"></i>
                                批量粘贴
                            </button>
                        </div>
                        <div class="sp-roster-bulk-panel sp-hidden" id="sp-roster-bulk-panel">
                            <textarea id="sp-roster-bulk-text" class="sp-roster-bulk-text" rows="4" placeholder="每行一个学生，例如：张三 男 170 85"></textarea>
                            <div class="sp-roster-bulk-actions">
                                <button type="button" class="sp-btn sp-btn--sm sp-btn--primary" id="sp-roster-bulk-append">追加到表格</button>
                            </div>
                        </div>
                        <div class="sp-image-review-table-wrap">
                            <table class="sp-image-review-table">
                                <thead>
                                    <tr>
                                        <th class="sp-image-review-index-head">序号</th>
                                        <th>姓名</th>
                                        <th>性别</th>
                                        <th>身高</th>
                                        <th>成绩</th>
                                        <th class="sp-roster-action-head">操作</th>
                                    </tr>
                                </thead>
                                <tbody id="sp-image-review-body"></tbody>
                            </table>
                        </div>
                        <div class="sp-image-review-actions">
                            <button type="button" class="sp-btn sp-btn--sm" id="sp-image-review-reupload">重新上传</button>
                            <button type="button" class="sp-btn sp-btn--sm" id="sp-image-review-cancel-secondary">取消</button>
                            <button type="button" class="sp-btn sp-btn--sm sp-btn--primary" id="sp-image-review-confirm">确认导入</button>
                        </div>
                    </div>
                </div>

                <div id="sp-feedback-dialog" class="sp-feedback sp-hidden" role="dialog" aria-modal="true" aria-labelledby="sp-feedback-title">
                    <div class="sp-feedback-panel">
                        <div class="sp-feedback-header">
                            <h3 id="sp-feedback-title">反馈座位安排问题</h3>
                            <button type="button" class="sp-feedback-close" id="sp-feedback-cancel" aria-label="关闭反馈">
                                <i data-lucide="x"></i>
                            </button>
                        </div>
                        <div class="sp-feedback-body">
                            <div class="sp-feedback-note">
                                会附带脱敏座位快照，帮助我们复现问题
                            </div>
                            <div class="sp-feedback-field">
                                <span class="sp-feedback-label">问题类型</span>
                                <div class="sp-feedback-chips" data-feedback-group="category">
                                    <button type="button" class="sp-feedback-chip is-active" data-value="understand">排座要求没听懂</button>
                                    <button type="button" class="sp-feedback-chip" data-value="result">座位结果不对</button>
                                    <button type="button" class="sp-feedback-chip" data-value="guardian">护法/微调不对</button>
                                    <button type="button" class="sp-feedback-chip" data-value="ui">界面/导出问题</button>
                                    <button type="button" class="sp-feedback-chip" data-value="other">其他</button>
                                </div>
                            </div>
                            <label class="sp-feedback-field" for="sp-feedback-message">
                                <span class="sp-feedback-label">直接写您觉得哪里不对</span>
                                <textarea id="sp-feedback-message" class="sp-feedback-textarea" rows="5" maxlength="2000" placeholder="例如：我说右护法换成成绩一般的男生，但它提示成功后座位没有变化。"></textarea>
                            </label>
                            <label class="sp-feedback-field" for="sp-feedback-expected">
                                <span class="sp-feedback-label">您希望它怎么做</span>
                                <textarea id="sp-feedback-expected" class="sp-feedback-textarea" rows="3" maxlength="1000" placeholder="例如：右护法应该换成一个成绩中等的男生，并告诉我换成了谁。"></textarea>
                            </label>
                            <div class="sp-feedback-field">
                                <span class="sp-feedback-label">影响程度</span>
                                <div class="sp-feedback-chips" data-feedback-group="severity">
                                    <button type="button" class="sp-feedback-chip is-active" data-value="blocking">影响使用</button>
                                    <button type="button" class="sp-feedback-chip" data-value="workaround">还能绕过</button>
                                    <button type="button" class="sp-feedback-chip" data-value="suggestion">只是建议</button>
                                </div>
                            </div>
                        </div>
                        <div class="sp-feedback-actions">
                            <button type="button" class="sp-btn sp-btn--sm" id="sp-feedback-cancel-secondary">取消</button>
                            <button type="button" class="sp-btn sp-btn--sm sp-btn--primary" id="sp-feedback-submit">
                                <i data-lucide="send"></i>
                                提交反馈
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Transition Zone -->
                <div class="sp-guide-transition" id="sp-guide-transition">
                    <span class="sp-guide-transition-text">了解如何使用</span>
                    <svg class="sp-guide-transition-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
                </div>

                <!-- ======================== -->
                <!-- Page 2: 使用指南 Premium -->
                <!-- ======================== -->
                <section class="sp-guide" id="sp-guide">
                    <!-- Hero -->
                    <div class="sp-guide-hero sp-animate">
                        <div class="sp-guide-hero-illustration">
                            <svg viewBox="0 0 480 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <!-- Classroom scene SVG -->
                                <!-- Blackboard -->
                                <rect x="80" y="10" width="320" height="80" rx="8" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
                                <text x="240" y="55" text-anchor="middle" fill="currentColor" font-size="16" font-weight="600" opacity="0.5">智 能 座 位 安 排</text>
                                <!-- Desk row 1 -->
                                <rect x="110" y="110" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <rect x="175" y="110" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <rect x="255" y="110" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <rect x="320" y="110" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <!-- Desk row 2 -->
                                <rect x="110" y="155" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <rect x="175" y="155" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <rect x="255" y="155" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <rect x="320" y="155" width="50" height="30" rx="4" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                <!-- Student dots -->
                                <circle cx="125" cy="105" r="5" fill="#06b6d4" opacity="0.7"/>
                                <circle cx="145" cy="105" r="5" fill="#f472b6" opacity="0.7"/>
                                <circle cx="190" cy="105" r="5" fill="#06b6d4" opacity="0.7"/>
                                <circle cx="210" cy="105" r="5" fill="#f472b6" opacity="0.7"/>
                                <circle cx="270" cy="105" r="5" fill="#f472b6" opacity="0.7"/>
                                <circle cx="290" cy="105" r="5" fill="#06b6d4" opacity="0.7"/>
                                <circle cx="335" cy="105" r="5" fill="#06b6d4" opacity="0.7"/>
                                <circle cx="355" cy="105" r="5" fill="#f472b6" opacity="0.7"/>
                                <!-- AI sparkle -->
                                <circle cx="240" cy="55" r="40" fill="url(#guideGlow)" opacity="0.15"/>
                                <defs>
                                    <radialGradient id="guideGlow">
                                        <stop offset="0%" stop-color="#06b6d4"/>
                                        <stop offset="100%" stop-color="transparent"/>
                                    </radialGradient>
                                </defs>
                            </svg>
                        </div>
                        <h2>轻松五步，搞定全班座位</h2>
                        <p>智能排座，告别手动烦恼</p>
                    </div>

                    <!-- Step Cards (alternating left-right) -->
                    <div class="sp-guide-steps">
                        <!-- Step 1: Import -->
                        <div class="sp-guide-step sp-animate">
                            <div class="sp-guide-step-visual sp-guide-step-visual--1">
                                <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <rect x="50" y="30" width="100" height="100" rx="12" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
                                    <!-- Grid lines -->
                                    <line x1="50" y1="60" x2="150" y2="60" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="50" y1="85" x2="150" y2="85" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="50" y1="105" x2="150" y2="105" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="90" y1="30" x2="90" y2="130" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="125" y1="30" x2="125" y2="130" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <!-- Upload arrow -->
                                    <path d="M100 145 L100 75" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
                                    <path d="M88 90 L100 75 L112 90" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                                    <!-- Text cells -->
                                    <text x="65" y="48" fill="currentColor" font-size="9" opacity="0.5">姓名</text>
                                    <text x="95" y="48" fill="currentColor" font-size="9" opacity="0.5">性别</text>
                                    <text x="130" y="48" fill="currentColor" font-size="9" opacity="0.5">身高</text>
                                    <text x="60" y="75" fill="currentColor" font-size="8" opacity="0.35">张三</text>
                                    <text x="60" y="98" fill="currentColor" font-size="8" opacity="0.35">李四</text>
                                    <text x="60" y="120" fill="currentColor" font-size="8" opacity="0.35">王五</text>
                                </svg>
                            </div>
                            <div class="sp-guide-step-content">
                                <span class="sp-guide-step-badge sp-guide-step-badge--1">Step 1</span>
                                <h3>导入学生名单</h3>
                                <p>支持多种方式快速导入全班学生信息，几秒完成数据准备。</p>
                                <ul class="sp-guide-step-features">
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>上传 Excel / CSV / 文本文件</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>直接粘贴学生名单</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>拍照识别（AI OCR 自动提取）</li>
                                </ul>
                            </div>
                        </div>

                        <!-- Step 2: Constraints -->
                        <div class="sp-guide-step sp-animate">
                            <div class="sp-guide-step-visual sp-guide-step-visual--2">
                                <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <!-- Chat bubbles -->
                                    <rect x="30" y="25" width="120" height="36" rx="12" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
                                    <text x="90" y="48" text-anchor="middle" fill="currentColor" font-size="9" opacity="0.5">张三视力不好要坐前排</text>
                                    <rect x="50" y="72" width="130" height="36" rx="12" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
                                    <text x="115" y="95" text-anchor="middle" fill="currentColor" font-size="9" opacity="0.5">李四和王五不能坐在一起</text>
                                    <!-- Connection lines -->
                                    <circle cx="170" cy="43" r="5" fill="currentColor" opacity="0.2"/>
                                    <circle cx="170" cy="90" r="5" fill="currentColor" opacity="0.2"/>
                                    <line x1="170" y1="48" x2="170" y2="85" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.2"/>
                                    <!-- AI parse icon -->
                                    <circle cx="100" cy="130" r="14" fill="currentColor" opacity="0.1" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
                                    <path d="M94 130 L100 124 L106 130 M94 130 L100 136 L106 130" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>
                                </svg>
                            </div>
                            <div class="sp-guide-step-content">
                                <span class="sp-guide-step-badge sp-guide-step-badge--2">Step 2</span>
                                <h3>收集学生需求</h3>
                                <p>把学生自己的座位心愿和需要照顾的情况告诉 AI，它会整理成可执行规则。</p>
                                <ul class="sp-guide-step-features">
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>「张三视力不好，要坐前排」</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>「李四和王五不想坐在一起」</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>「小组长均匀分布在各区域」</li>
                                </ul>
                            </div>
                        </div>

                        <!-- Step 3: Strategy -->
                        <div class="sp-guide-step sp-animate">
                            <div class="sp-guide-step-visual sp-guide-step-visual--3">
                                <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <!-- Gear -->
                                    <circle cx="100" cy="65" r="28" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="1.5" opacity="0.25"/>
                                    <circle cx="100" cy="65" r="14" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
                                    <!-- Gear teeth -->
                                    <rect x="96" y="33" width="8" height="10" rx="2" fill="currentColor" opacity="0.2"/>
                                    <rect x="96" y="87" width="8" height="10" rx="2" fill="currentColor" opacity="0.2"/>
                                    <rect x="68" y="61" width="10" height="8" rx="2" fill="currentColor" opacity="0.2"/>
                                    <rect x="122" y="61" width="10" height="8" rx="2" fill="currentColor" opacity="0.2"/>
                                    <!-- Tick labels -->
                                    <rect x="40" y="115" width="50" height="22" rx="11" fill="currentColor" opacity="0.08" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                    <text x="65" y="130" text-anchor="middle" fill="currentColor" font-size="8" opacity="0.45">男女搭配</text>
                                    <rect x="100" y="115" width="50" height="22" rx="11" fill="currentColor" opacity="0.12" stroke="currentColor" stroke-width="1" opacity="0.3"/>
                                    <text x="125" y="130" text-anchor="middle" fill="currentColor" font-size="8" opacity="0.55">身高排序</text>
                                </svg>
                            </div>
                            <div class="sp-guide-step-content">
                                <span class="sp-guide-step-badge sp-guide-step-badge--3">Step 3</span>
                                <h3>选择排座策略</h3>
                                <p>灵活组合多种智能策略，满足各种课堂管理需求。</p>
                                <ul class="sp-guide-step-features">
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>男女搭配 — 自动交叉安排</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>身高排序 — 矮前高后</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>成绩优先/强弱互补</li>
                                </ul>
                            </div>
                        </div>

                        <!-- Step 4: AI Generate -->
                        <div class="sp-guide-step sp-animate">
                            <div class="sp-guide-step-visual sp-guide-step-visual--4">
                                <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <!-- Seat grid materializing -->
                                    <rect x="45" y="50" width="32" height="24" rx="4" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1" opacity="0.25"/>
                                    <rect x="84" y="50" width="32" height="24" rx="4" fill="currentColor" opacity="0.12" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                    <rect x="123" y="50" width="32" height="24" rx="4" fill="currentColor" opacity="0.09" stroke="currentColor" stroke-width="1" opacity="0.15"/>
                                    <rect x="45" y="84" width="32" height="24" rx="4" fill="currentColor" opacity="0.12" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                    <rect x="84" y="84" width="32" height="24" rx="4" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1" opacity="0.25"/>
                                    <rect x="123" y="84" width="32" height="24" rx="4" fill="currentColor" opacity="0.12" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                    <!-- Magic wand / sparkle -->
                                    <path d="M160 30 L165 40 L175 35 L170 45 L180 50 L170 55 L175 65 L165 60 L160 70 L155 60 L145 65 L150 55 L140 50 L150 45 L145 35 L155 40 Z" fill="currentColor" opacity="0.15"/>
                                    <circle cx="160" cy="50" r="6" fill="currentColor" opacity="0.25"/>
                                    <!-- Names appearing -->
                                    <text x="53" y="65" fill="currentColor" font-size="7" opacity="0.4">张三</text>
                                    <text x="92" y="65" fill="currentColor" font-size="7" opacity="0.35">李四</text>
                                    <text x="131" y="65" fill="currentColor" font-size="7" opacity="0.25">王五</text>
                                    <text x="53" y="100" fill="currentColor" font-size="7" opacity="0.35">赵六</text>
                                    <text x="92" y="100" fill="currentColor" font-size="7" opacity="0.4">孙七</text>
                                </svg>
                            </div>
                            <div class="sp-guide-step-content">
                                <span class="sp-guide-step-badge sp-guide-step-badge--4">Step 4</span>
                                <h3>AI 智能排座</h3>
                                <p>一键生成座位表，AI 综合所有约束和策略，生成较优排列并提供可解释评分。</p>
                                <ul class="sp-guide-step-features">
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>一键自动生成较优座位方案并展示评分依据</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><path d="m2 2 20 20"/><path d="M4.929 4.929A9.969 9.969 0 0 0 2 12c0 2.761 1.12 5.263 2.929 7.071"/><path d="M7.05 7.05A6.979 6.979 0 0 0 5 12c0 1.933.784 3.683 2.05 4.95"/></svg>AI 助手对话微调座位</li>
                                </ul>
                            </div>
                        </div>

                        <!-- Step 5: Export -->
                        <div class="sp-guide-step sp-animate">
                            <div class="sp-guide-step-visual sp-guide-step-visual--5">
                                <svg viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <!-- Image preview -->
                                    <rect x="30" y="30" width="75" height="100" rx="8" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="1.5" opacity="0.2"/>
                                    <rect x="38" y="38" width="59" height="40" rx="4" fill="currentColor" opacity="0.08"/>
                                    <text x="67" y="62" text-anchor="middle" fill="currentColor" font-size="7" opacity="0.35">座位表.png</text>
                                    <!-- Table preview -->
                                    <rect x="95" y="30" width="75" height="100" rx="8" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="1.5" opacity="0.2"/>
                                    <line x1="103" y1="55" x2="162" y2="55" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="103" y1="70" x2="162" y2="70" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="103" y1="85" x2="162" y2="85" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <line x1="130" y1="42" x2="130" y2="120" stroke="currentColor" stroke-width="0.8" opacity="0.15"/>
                                    <text x="132" y="50" text-anchor="middle" fill="currentColor" font-size="7" opacity="0.35">Excel</text>
                                    <!-- Share arrow -->
                                    <path d="M100 145 L100 135" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
                                    <circle cx="100" cy="147" r="3" fill="currentColor" opacity="0.2"/>
                                    <circle cx="85" cy="140" r="3" fill="currentColor" opacity="0.2"/>
                                    <circle cx="115" cy="140" r="3" fill="currentColor" opacity="0.2"/>
                                    <line x1="100" y1="147" x2="85" y2="140" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                    <line x1="100" y1="147" x2="115" y2="140" stroke="currentColor" stroke-width="1" opacity="0.2"/>
                                </svg>
                            </div>
                            <div class="sp-guide-step-content">
                                <span class="sp-guide-step-badge sp-guide-step-badge--5">Step 5</span>
                                <h3>导出结果</h3>
                                <p>一键导出，方便打印或分享给班级家长群。</p>
                                <ul class="sp-guide-step-features">
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>PNG 图片（含教室黑板风格）</li>
                                    <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2"/><path d="M8 17h2"/><path d="M14 13h2"/><path d="M14 17h2"/></svg>Excel 表格（方便存档）</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <!-- Tips -->
                    <div class="sp-guide-tips-header sp-animate">
                        <h3>进阶小贴士</h3>
                        <p>掌握这些技巧，让座位安排更高效</p>
                    </div>
                    <div class="sp-guide-tips">
                        <div class="sp-guide-tip sp-animate">
                            <div class="sp-guide-tip-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l2 2"/><path d="M14 9l2 2"/><path d="m7 11 1-1 1 1"/><path d="m16 11 1-1 1 1"/><path d="M12 20a8 8 0 0 0 3-15.1"/><path d="M12 20a8 8 0 0 1-3-15.1"/><path d="M12 20V10"/><path d="m10 8 2-2 2 2"/></svg>
                            </div>
                            <div>
                                <h5>拖拽调整</h5>
                                <p>生成座位后，直接拖拽学生姓名即可交换座位位置</p>
                            </div>
                        </div>
                        <div class="sp-guide-tip sp-animate">
                            <div class="sp-guide-tip-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                            </div>
                            <div>
                                <h5>黑板涂鸦</h5>
                                <p>点击黑板区域可添加粉笔文字标注，自由定制教室</p>
                            </div>
                        </div>
                        <div class="sp-guide-tip sp-animate">
                            <div class="sp-guide-tip-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><path d="M2 12a10 10 0 0 0 18.667 5"/><path d="M22 12A10 10 0 0 0 3.333 7"/><path d="M12 12v4h4"/></svg>
                            </div>
                            <div>
                                <h5>AI 对话</h5>
                                <p>打开 AI 助手，用自然语言微调座位安排</p>
                            </div>
                        </div>
                        <div class="sp-guide-tip sp-animate">
                            <div class="sp-guide-tip-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
                            </div>
                            <div>
                                <h5>撤销重做</h5>
                                <p>Ctrl+Z 撤销上一步操作，Ctrl+Y 重做</p>
                            </div>
                        </div>
                    </div>

                    <!-- CTA -->
                    <div class="sp-guide-cta sp-animate">
                        <h3>准备好了吗？</h3>
                        <p>现在就开始安排你的课堂座位吧！</p>
                        <button class="sp-guide-cta-btn" id="sp-guide-back-top">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                            返回顶部，开始使用
                        </button>
                    </div>
                </section>
            </div>
        `;

        if (window.lucide) window.lucide.createIcons();
        this.renderGrid();
        this.refreshConstraintStatus();
        this.updateStatus();

        // Initialize Blackboard Text Interaction
        this.initBlackboardText();
        this.initPodiumToggle();
        this.bindChatEvents();
        this.hideSuggestions('arrange');

        // Initialize guide scroll animations
        this._initGuideAnimations();
    }

    // ========== Guide Scroll Animations ==========
    _initGuideAnimations() {
        const guide = document.getElementById('sp-guide');
        if (!guide) return;

        // Scroll container is tool-body (the parent that scrolls)
        const scrollRoot = this.container.closest('.tool-body') || this.container;

        // IntersectionObserver for fade-in elements
        const animatables = guide.querySelectorAll('.sp-animate');

        if (this._guideObserver) {
            this._guideObserver.disconnect();
        }

        this._guideObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const el = entry.target;
                    const stagger = el.dataset.stagger || 0;
                    setTimeout(() => {
                        el.classList.add('is-visible');
                    }, stagger * 100);
                    this._guideObserver.unobserve(el);
                }
            });
        }, {
            root: scrollRoot === this.container ? null : scrollRoot,
            rootMargin: '0px 0px -50px 0px',
            threshold: 0.1
        });

        // Assign stagger indices to siblings
        animatables.forEach((el) => {
            if (el.classList.contains('sp-guide-tip')) {
                const tips = guide.querySelectorAll('.sp-guide-tip');
                el.dataset.stagger = Array.from(tips).indexOf(el);
            }
            this._guideObserver.observe(el);
        });

        // Transition Zone: click to scroll into guide
        const transitionZone = document.getElementById('sp-guide-transition');
        if (transitionZone) {
            transitionZone.addEventListener('click', () => {
                guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }

        // Back to top button
        const backTopBtn = document.getElementById('sp-guide-back-top');
        if (backTopBtn) {
            backTopBtn.addEventListener('click', () => {
                const spApp = this.container.querySelector('.sp-app');
                if (spApp) {
                    spApp.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else {
                    this.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        }
    }

    initPodiumToggle() {
        const toggle = document.getElementById('sp-podium-toggle');
        const podiumRow = document.getElementById('sp-podium-row');
        if (toggle && podiumRow) {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent bubbling layout jitters
                podiumRow.classList.toggle('is-expanded');
                // Update tooltip/title based on state
                const isExpanded = podiumRow.classList.contains('is-expanded');
                if (this.classroomLayout?.guardians) {
                    this.classroomLayout.guardians.enabled = isExpanded;
                    this.classroomLayout.guardians.left = isExpanded ? this.guardians[0] : null;
                    this.classroomLayout.guardians.right = isExpanded ? this.guardians[1] : null;
                }
                toggle.title = isExpanded ? '收起左右护法' : '启用左右护法';
                this.updateStatus();
            });
        }
    }

    initBlackboardText() {
        const blackboard = document.getElementById('sp-blackboard');
        if (!blackboard) return;

        let selectedEl = null;
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const deselectAll = () => {
            const texts = blackboard.querySelectorAll('.sp-chalk-text');
            texts.forEach(el => {
                el.classList.remove('sp-selected', 'sp-editing');
                el.contentEditable = false;
            });
            selectedEl = null;
        };

        // Cleanup old global listeners if they exist
        if (this._textKeyDownHandler) window.removeEventListener('keydown', this._textKeyDownHandler);

        // Mousedown / Touchstart: Select & Start Drag
        const onPointerDown = (e) => {
            const isTouch = e.type === 'touchstart';
            const clientX = isTouch ? e.touches[0].clientX : e.clientX;
            const clientY = isTouch ? e.touches[0].clientY : e.clientY;
            const textEl = (isTouch ? document.elementFromPoint(clientX, clientY) : e.target)?.closest('.sp-chalk-text');
            if (textEl) {
                if (selectedEl !== textEl) {
                    deselectAll();
                    selectedEl = textEl;
                    textEl.classList.add('sp-selected');
                }
                if (!textEl.isContentEditable) {
                    isDragging = true;
                    startX = clientX;
                    startY = clientY;
                    initialLeft = textEl.offsetLeft;
                    initialTop = textEl.offsetTop;
                    e.preventDefault();
                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                    window.addEventListener('touchmove', onTouchMove, { passive: false });
                    window.addEventListener('touchend', onTouchEnd);
                }
            }
        };
        blackboard.addEventListener('mousedown', onPointerDown);
        blackboard.addEventListener('touchstart', onPointerDown, { passive: false });

        const onMouseMove = (e) => {
            if (isDragging && selectedEl) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;

                // Clamp Position
                const rect = blackboard.getBoundingClientRect();
                // Safe area: 10px padding
                // Width: text width? sp-chalk-text min-width 20px.
                const elWidth = selectedEl.offsetWidth;
                const elHeight = selectedEl.offsetHeight;
                if (newLeft < 0) newLeft = 0;
                if (newLeft > rect.width - elWidth) newLeft = rect.width - elWidth;
                if (newTop < 0) newTop = 0;
                if (newTop > rect.height - elHeight) newTop = rect.height - elHeight;

                selectedEl.style.left = `${newLeft}px`;
                selectedEl.style.top = `${newTop}px`;
            }
        };

        const onMouseUp = () => {
            isDragging = false;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
        };

        const onTouchMove = (e) => {
            if (isDragging && selectedEl) {
                e.preventDefault();
                const touch = e.touches[0];
                const dx = touch.clientX - startX;
                const dy = touch.clientY - startY;
                let newLeft = initialLeft + dx;
                let newTop = initialTop + dy;
                const rect = blackboard.getBoundingClientRect();
                const elWidth = selectedEl.offsetWidth;
                const elHeight = selectedEl.offsetHeight;
                if (newLeft < 0) newLeft = 0;
                if (newLeft > rect.width - elWidth) newLeft = rect.width - elWidth;
                if (newTop < 0) newTop = 0;
                if (newTop > rect.height - elHeight) newTop = rect.height - elHeight;
                selectedEl.style.left = `${newLeft}px`;
                selectedEl.style.top = `${newTop}px`;
            }
        };

        const onTouchEnd = () => {
            isDragging = false;
            window.removeEventListener('touchmove', onTouchMove);
            window.removeEventListener('touchend', onTouchEnd);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        // Click: Create New (BG)
        blackboard.addEventListener('click', (e) => {
            if (e.target.closest('.sp-chalk-text') || e.target.closest('.sp-blackboard-notes')) return;

            // Deselect existing
            deselectAll();

            const rect = blackboard.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Boundary Check: Ensure text is within safe writing area
            // Frame is 6px, but let's give more padding (10px) top/bottom
            // Blackboard height is 120px.            // Safe Y: 10px to 110px.
            if (y < 10 || y > 110) return;
            // Safe X: 10px to rect.width - 10px
            if (x < 10 || x > rect.width - 10) return;

            const textEl = document.createElement('div');
            textEl.className = 'sp-chalk-text sp-editing sp-selected';
            textEl.contentEditable = true;
            textEl.style.left = `${x}px`;
            textEl.style.top = `${y}px`;
            blackboard.appendChild(textEl);
            selectedEl = textEl;
            textEl.focus({ preventScroll: true }); // Prevent layout jump
            // Handle blur: remove element if left empty

            textEl.addEventListener('blur', () => {
                textEl.contentEditable = false;
                textEl.classList.remove('sp-editing');
                if (!textEl.textContent.trim()) {
                    textEl.remove();
                    if (selectedEl === textEl) selectedEl = null;
                }
            });
        });

        // Double Click: Edit
        blackboard.addEventListener('dblclick', (e) => {
            const textEl = e.target.closest('.sp-chalk-text');
            if (textEl) {
                textEl.contentEditable = true;
                textEl.classList.add('sp-editing');
                textEl.focus();
            }
        });

        // Wheel: Resize
        blackboard.addEventListener('wheel', (e) => {
            if (selectedEl) {
                e.preventDefault();
                const style = window.getComputedStyle(selectedEl);
                let currentSize = parseFloat(style.fontSize);
                const delta = e.deltaY > 0 ? -2 : 2; // Resize step
                let newSize = currentSize + delta;
                if (newSize < 12) newSize = 12;
                if (newSize > 120) newSize = 120; // Max size limit
                selectedEl.style.fontSize = `${newSize}px`;
            }
        }, { passive: false });

        // Global Keydown (Delete / Enter)
        this._textKeyDownHandler = (e) => {
            // Only active if blackboard exists and we have selection
            if (!document.getElementById('sp-blackboard')) return;
            // Don't intercept keys when user is typing in input/textarea
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;

            if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEl && !selectedEl.isContentEditable) {
                selectedEl.remove();
                selectedEl = null;
            }
            if (e.key === 'Enter' && !e.shiftKey && selectedEl && selectedEl.isContentEditable) {
                e.preventDefault();
                selectedEl.blur();
            }
        };
        window.addEventListener('keydown', this._textKeyDownHandler);
    }

    bindEvents() {
        const $ = id => document.getElementById(id);

        // Dropzone toggle
        const dropzone = $('sp-dropzone');
        const textarea = $('sp-students-input');
        const parseBtn = $('sp-parse-students');
        // Dropzone - clicking triggers file input
        const fileInput = $('sp-file-input');
        dropzone?.addEventListener('click', () => {
            fileInput?.click();
        });

        // Image Upload
        const imgInput = $('sp-image-input');
        const imgBtn = $('sp-upload-image');
        imgBtn?.addEventListener('click', () => imgInput?.click());
        imgInput?.addEventListener('change', e => {
            if (e.target.files[0]) this.handleImageUpload(e.target.files[0]);
        });
        $('sp-image-review-confirm')?.addEventListener('click', () => this.confirmImageReview());
        $('sp-image-review-cancel')?.addEventListener('click', () => this.closeImageReview());
        $('sp-image-review-cancel-secondary')?.addEventListener('click', () => this.closeImageReview());
        $('sp-image-review-reupload')?.addEventListener('click', () => {
            this.closeImageReview();
            if (imgInput) {
                imgInput.value = '';
                imgInput.click();
            }
        });
        $('sp-roster-add-row')?.addEventListener('click', () => this.addRosterReviewRow());
        $('sp-roster-bulk-toggle')?.addEventListener('click', () => this.toggleRosterBulkPanel());
        $('sp-roster-bulk-append')?.addEventListener('click', () => this.appendRosterBulkText());
        $('sp-image-review-body')?.addEventListener('click', e => {
            const button = e.target.closest?.('.sp-roster-delete-row');
            if (!button) return;
            button.closest('tr')?.remove();
            this.renumberReviewRows();
            this.updateRosterReviewTitle();
        });
        $('sp-feedback-cancel')?.addEventListener('click', () => this.closeFeedbackDialog());
        $('sp-feedback-cancel-secondary')?.addEventListener('click', () => this.closeFeedbackDialog());
        $('sp-feedback-submit')?.addEventListener('click', () => this.submitFeedback());
        $('sp-feedback-dialog')?.addEventListener('click', e => {
            if (e.target?.id === 'sp-feedback-dialog') this.closeFeedbackDialog();
        });
        document.querySelectorAll('[data-feedback-group]').forEach(group => {
            group.addEventListener('click', e => {
                const chip = e.target.closest?.('.sp-feedback-chip');
                if (!chip) return;
                group.querySelectorAll('.sp-feedback-chip').forEach(item => item.classList.remove('is-active'));
                chip.classList.add('is-active');
            });
        });

        // File input change handler
        fileInput?.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) this.handleFileUpload(file);
        });

        // File drag and drop
        dropzone?.addEventListener('dragover', e => {
            e.preventDefault();
            dropzone.classList.add('sp-dropzone--active');
        });
        dropzone?.addEventListener('dragleave', () => {
            dropzone.classList.remove('sp-dropzone--active');
        });
        dropzone?.addEventListener('drop', e => {
            e.preventDefault();
            dropzone.classList.remove('sp-dropzone--active');
            const file = e.dataTransfer.files[0];
            if (file) this.handleFileUpload(file);
        });

        // Edit parsed students in a review-style table
        $('sp-parse-students')?.addEventListener('click', () => this.openRosterEditor());
        // Clear students
        $('sp-clear-students')?.addEventListener('click', () => {
            this.students = [];
            this._buildStudentMap();
            this.unassigned = [];
            this.arrangementStats = null;
            this.arrangementSource = null;
            this.arrangementInterpretation = null;
            this.arrangementSpec = null;
            this.recordDiagnosticEvent('students_cleared', {});
            this.showArrangementExplain = false;
            $('sp-student-count').innerHTML = '<i data-lucide="users"></i><span>0 人</span>';
            $('sp-students-preview').innerHTML = '';
            $('sp-students-input').value = '';
            $('sp-generate').disabled = true;
            $('sp-dropzone').classList.remove('sp-hidden');
            $('sp-students-input').classList.add('sp-hidden');
            $('sp-parse-students').classList.add('sp-hidden');
            this.updateStatus();
            this.hideSuggestions('arrange');
            if (window.lucide) window.lucide.createIcons();
        });

        // Parse constraints
        $('sp-parse-constraints')?.addEventListener('click', () => this.parseConstraints());

        if (this._seatDetailsToggleHandler) document.removeEventListener('click', this._seatDetailsToggleHandler);
        this._seatDetailsToggleHandler = e => {
            const explainToggle = e.target.closest?.('#sp-toggle-arrangement-explain');
            if (explainToggle) {
                this.showArrangementExplain = !this.showArrangementExplain;
                this.updateStatus();
                return;
            }

            const scoreToggle = e.target.closest?.('#sp-toggle-score-analysis');
            if (scoreToggle) {
                this.showScoreAnalysis = !this.showScoreAnalysis;
                this.updateStatus();
                return;
            }

            const toggle = e.target.closest?.('#sp-toggle-seat-details');
            if (!toggle) return;
            this.showSeatDetails = !this.showSeatDetails;
            this.renderGrid();
            this.renderPodiumSeats();
            this.updateStatus();
        };
        document.addEventListener('click', this._seatDetailsToggleHandler);

        // Generate
        $('sp-generate')?.addEventListener('click', () => this.generateSeating());
        const arrangePrompt = $('sp-arrange-prompt');
        arrangePrompt?.addEventListener('keydown', e => {
            if (this.handleSuggestionKeyDown(e, 'arrange')) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.generateSeating();
        });
        arrangePrompt?.addEventListener('focus', () => this.hideSuggestions('arrange'));
        arrangePrompt?.addEventListener('blur', () => setTimeout(() => this.hideSuggestions('arrange'), 120));
        $('sp-complete-arrange-prompt')?.addEventListener('click', () => this.completeArrangePrompt());

        // Exports
        $('sp-export-png')?.addEventListener('click', () => this.exportPNG());
        $('sp-export-excel')?.addEventListener('click', () => this.exportXLSX());

        // Keyboard shortcuts (Ctrl+Z / Ctrl+Y) — use named handler for cleanup
        if (this._undoRedoHandler) document.removeEventListener('keydown', this._undoRedoHandler);
        this._undoRedoHandler = (e) => {
            if (!this.container) return;
            if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
            if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) { e.preventDefault(); this.redo(); }
        };
        document.addEventListener('keydown', this._undoRedoHandler);

        // Strategy toggles
        $('sp-gender')?.addEventListener('change', e => {
            this.strategy.genderBalance = e.target.checked;
            this.scheduleSuggestionRefresh('arrange');
        });
        $('sp-height')?.addEventListener('change', e => {
            this.strategy.heightOrder = e.target.checked;
            this.scheduleSuggestionRefresh('arrange');
        });
        // Grade strategy radio group (mutually exclusive)
        document.querySelectorAll('input[name="sp-grade-strategy"]').forEach(radio => {
            radio.addEventListener('change', e => {
                if (e.target.checked) this.strategy.gradeStrategy = e.target.value;
                this.scheduleSuggestionRefresh('arrange');
            });
        });

        // Context menu
        document.addEventListener('click', () => this.hideContextMenu());
        $('sp-context-menu')?.querySelectorAll('.sp-context-item').forEach(item => {
            item.addEventListener('click', e => {
                e.stopPropagation();
                this.handleMenuAction(item.dataset.action);
            });
        });
    }

    layoutTemplateLabel(template) {
        return {
            standard: '普通',
            pairs: '双人同桌',
            triples: '三人一组',
            single: '单人考试',
            'center-aisle': '中间过道',
            'horizontal-aisle': '横过道',
            islands: '小组岛',
            custom: '自定义',
            ai: 'AI 布局'
        }[template] || '自定义';
    }

    renderSeatMeta(student) {
        const details = [];
        if (student?.grade !== undefined && student?.grade !== null && student.grade !== '') {
            details.push({ label: '成绩', value: student.grade });
        }
        if (student?.height !== undefined && student?.height !== null && student.height !== '') {
            details.push({ label: '身高', value: student.height });
        }
        if (!details.length) return null;
        const meta = document.createElement('div');
        meta.className = 'sp-seat-meta';
        if (!this.showSeatDetails) meta.classList.add('sp-seat-meta--hidden');
        for (const detail of details) {
            const item = document.createElement('span');
            item.className = 'sp-seat-meta-item';
            item.textContent = `${detail.label}:${detail.value}`;
            meta.appendChild(item);
        }
        return meta;
    }

    createVirtualSeatCell(r, c) {
        const cell = document.createElement('div');
        cell.className = 'sp-seat';
        cell.dataset.row = r;
        cell.dataset.col = c;

        const isColAisle = this.colAisles.includes(c);
        const isRowAisle = this.rowAisles.includes(r);
        const isLayoutBlocked = !isLayoutSeat(this.classroomLayout, r, c);
        if (isColAisle || isRowAisle || isLayoutBlocked) {
            cell.classList.add('sp-seat--aisle');
            const line = document.createElement('span');
            line.className = `sp-aisle-line ${isRowAisle ? 'sp-aisle-line--horizontal' : 'sp-aisle-line--vertical'}`;
            cell.appendChild(line);
            cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
            return cell;
        }

        const studentId = this.layout[r]?.[c];
        const desk = document.createElement('div');
        desk.className = 'sp-desk';
        if (studentId && studentId !== '_aisle_') {
            const student = this.studentMap.get(studentId);
            cell.classList.add('sp-seat--filled');
            cell.dataset.studentId = studentId;
            const nameTag = document.createElement('span');
            nameTag.className = 'sp-name-tag';
            nameTag.textContent = student?.name || studentId;
            desk.appendChild(nameTag);
            const meta = this.renderSeatMeta(student);
            if (meta) desk.appendChild(meta);
            const chair = document.createElement('div');
            chair.className = `sp-chair sp-chair--${student?.gender === 'M' ? 'male' : 'female'}`;
            cell.appendChild(desk);
            cell.appendChild(chair);
            cell.setAttribute('draggable', 'true');
            cell.addEventListener('dragstart', e => this.handleDragStart(e, r, c));
            cell.addEventListener('dragend', e => this.handleDragEnd(e));
        } else {
            cell.classList.add('sp-seat--empty');
            cell.appendChild(desk);
        }
        cell.addEventListener('dragover', e => this.handleDragOver(e));
        cell.addEventListener('dragenter', e => this.handleDragEnter(e, cell));
        cell.addEventListener('dragleave', e => this.handleDragLeave(e, cell));
        cell.addEventListener('drop', e => this.handleDrop(e, r, c));
        cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
        return cell;
    }

    renderVirtualGrid() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;
        const scroller = grid.closest('.sp-classroom-view');
        const rowHeight = SeatingPlanner.VIRTUAL_GRID_ROW_HEIGHT;
        const overscan = SeatingPlanner.VIRTUAL_GRID_ROW_OVERSCAN;
        const viewportHeight = scroller?.clientHeight || 720;
        const scrollTop = Math.max(0, (scroller?.scrollTop || 0) - (grid.offsetTop || 0));
        const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
        const visibleRows = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
        const endRow = Math.min(this.rows, startRow + visibleRows);

        this._virtualGridActive = true;
        grid.classList.add('sp-grid--virtual');
        grid.innerHTML = '';
        grid.style.gridTemplateColumns = '';
        grid.style.height = `${Math.max(this.rows * rowHeight, rowHeight)}px`;

        const windowEl = document.createElement('div');
        windowEl.className = 'sp-grid-window';
        windowEl.style.gridTemplateColumns = `repeat(${this.cols}, minmax(90px, 1fr))`;
        windowEl.style.transform = `translateY(${startRow * rowHeight}px)`;
        for (let r = startRow; r < endRow; r++) {
            for (let c = 0; c < this.cols; c++) {
                windowEl.appendChild(this.createVirtualSeatCell(r, c));
            }
        }
        grid.appendChild(windowEl);

        if (scroller && this._virtualGridScrollTarget !== scroller) {
            if (this._virtualGridScrollTarget && this._virtualGridScrollHandler) {
                this._virtualGridScrollTarget.removeEventListener('scroll', this._virtualGridScrollHandler);
            }
            this._virtualGridScrollTarget = scroller;
            this._virtualGridScrollHandler = () => {
                if (this._virtualGridActive) window.requestAnimationFrame(() => this.renderVirtualGrid());
            };
            scroller.addEventListener('scroll', this._virtualGridScrollHandler);
        }
        requestAnimationFrame(() => {
            this.syncPodiumSeatWidth();
            this.renderAisleGapHandles();
        });
    }

    renderGrid() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        const totalCells = this.rows * this.cols;
        if (totalCells > SeatingPlanner.VIRTUAL_GRID_CELL_THRESHOLD) {
            return this.renderVirtualGrid();
        }

        this._virtualGridActive = false;
        grid.classList.remove('sp-grid--virtual');
        grid.style.height = '';
        grid.innerHTML = '';
        grid.style.gridTemplateColumns = `repeat(${this.cols}, 1fr)`;
        const topGradeIds = this.getTopGradeStudentIds();

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                const cell = document.createElement('div');
                cell.className = 'sp-seat';
                cell.dataset.row = r;
                cell.dataset.col = c;

                const isColAisle = this.colAisles.includes(c);
                const isRowAisle = this.rowAisles.includes(r);
                const isLayoutBlocked = !isLayoutSeat(this.classroomLayout, r, c);

                if (isColAisle || isRowAisle || isLayoutBlocked) {
                    cell.classList.add('sp-seat--aisle');
                    const line = document.createElement('span');
                    line.className = `sp-aisle-line ${isRowAisle ? 'sp-aisle-line--horizontal' : 'sp-aisle-line--vertical'}`;
                    cell.appendChild(line);
                    cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));
                    grid.appendChild(cell);
                    continue;
                }

                const studentId = this.layout[r]?.[c];
                if (studentId && studentId !== '_aisle_') {
                    const student = this.studentMap.get(studentId);
                    if (student) {
                        cell.classList.add('sp-seat--filled');
                        cell.dataset.studentId = student.id;

                        // === The Desk ===
                        const desk = document.createElement('div');
                        desk.className = 'sp-desk';

                        // Name Tag (姓名贴) - show only the name, strip gender/grade suffix
                        const nameTag = document.createElement('span');
                        nameTag.className = 'sp-name-tag';
                        // API may return name as "张三 男 84", extract only the name part
                        let displayName = student.name;
                        if (student.gender || student.grade) {
                            displayName = displayName.replace(/\s+[男女]\s*\d*\s*$/, '').trim();
                        }
                        nameTag.textContent = displayName || student.name;
                        desk.appendChild(nameTag);
                        const meta = this.renderSeatMeta(student);
                        if (meta) desk.appendChild(meta);

                        // Desk Items Container
                        const itemsContainer = document.createElement('div');
                        itemsContainer.className = 'sp-desk-items';

                        // Status items based on student data (returns array for multi-constraint support)
                        const indicators = this.getConstraintIndicators(student.id);
                        // Glasses - for vision constraint (近视)
                        if (indicators.some(i => i.reason?.includes('视力'))) {
                            const glasses = document.createElement('span');
                            glasses.className = 'sp-desk-item sp-desk-item--glasses';
                            glasses.textContent = '👓';
                            glasses.title = '近视需要关照';
                            itemsContainer.appendChild(glasses);
                        }

                        // Books - for top-ranked grades
                        if (this.isTopGradeStudent(student, topGradeIds)) {
                            const books = document.createElement('span');
                            books.className = 'sp-desk-item sp-desk-item--books';
                            books.textContent = '📚';
                            books.title = `成绩: ${student.grade}分`;
                            itemsContainer.appendChild(books);
                        }

                        // Candy - wish fulfilled (心愿达成)
                        if (indicators.some(i => i.type === 'success')) {
                            const candy = document.createElement('span');
                            candy.className = 'sp-desk-item sp-desk-item--candy';
                            candy.textContent = '🍬';
                            candy.title = '心愿已满足';
                            itemsContainer.appendChild(candy);
                        }

                        // Warning indicator
                        const warningIndicator = indicators.find(i => i.type === 'warning');
                        if (warningIndicator) {
                            const warning = document.createElement('span');
                            warning.className = 'sp-desk-item sp-desk-item--quiet';
                            warning.textContent = '⚠️';
                            warning.title = warningIndicator.reason;
                            itemsContainer.appendChild(warning);
                        }

                        desk.appendChild(itemsContainer);
                        cell.appendChild(desk);

                        // === The Chair Back ===
                        const chair = document.createElement('div');
                        chair.className = `sp-chair sp-chair--${student.gender === 'M' ? 'male' : 'female'}`;
                        cell.appendChild(chair);

                        // === Tooltip ===
                        const tooltip = document.createElement('div');
                        tooltip.className = 'sp-seat-tooltip';
                        const gradeText = student.grade ? ` | 成绩: ${student.grade}` : '';
                        const heightText = student.height ? ` | 身高: ${student.height}` : '';
                        const genderText = student.gender === 'M' ? '男' : '女';
                        tooltip.textContent = `${student.name} (${genderText})${gradeText}${heightText}`;
                        cell.appendChild(tooltip);

                        // Hover interaction
                        cell.addEventListener('mouseenter', () => this.highlightRelationships(student.id));
                        cell.addEventListener('mouseleave', () => this.clearHighlights());

                        // Drag events
                        cell.setAttribute('draggable', 'true');
                        cell.addEventListener('dragstart', e => this.handleDragStart(e, r, c));
                        cell.addEventListener('dragend', e => this.handleDragEnd(e));
                    }
                } else {
                    cell.classList.add('sp-seat--empty');
                    // Empty desk placeholder
                    const emptyDesk = document.createElement('div');
                    emptyDesk.className = 'sp-desk';
                    cell.appendChild(emptyDesk);
                }

                // Drop target events
                cell.addEventListener('dragover', e => this.handleDragOver(e));
                cell.addEventListener('dragenter', e => this.handleDragEnter(e, cell));
                cell.addEventListener('dragleave', e => this.handleDragLeave(e, cell));
                cell.addEventListener('drop', e => this.handleDrop(e, r, c));

                // Context menu
                cell.addEventListener('contextmenu', e => this.showContextMenu(e, r, c));

                grid.appendChild(cell);
            }
        }

        if (window.lucide) window.lucide.createIcons();

        // Sync podium seat width with grid seats
        requestAnimationFrame(() => {
            this.syncPodiumSeatWidth();
            this.renderAisleGapHandles();
        });
        // Add resize listener if not already added
        if (!this._resizeHandler) {
            this._resizeHandler = () => {
                this.syncPodiumSeatWidth();
                this.renderAisleGapHandles();
                this.syncChatPosition();
            };
            window.addEventListener('resize', this._resizeHandler);
        }
    }

    getConstraintIndicators(studentId) {
        const results = [];
        const student = this.studentMap.get(studentId);
        const studentName = student?.name;

        // Check unsatisfied constraints (may use ID or name)
        for (const u of this.unsatisfied) {
            if (u.target === studentId || u.target === studentName) {
                results.push({ type: 'warning', icon: 'alert-triangle', reason: u.reason });
            }
        }

        // Check all constraints (constraints use student names)
        for (const c of this.constraints) {
            if (c.target === studentName) {
                if (c.type === 'front_row') {
                    results.push({ type: 'success', icon: 'eye', reason: '需坐前排' });
                }
                if (c.type === 'avoid') {
                    results.push({ type: 'error', icon: 'x-circle', reason: `避免与${c.related}相邻` });
                }
            }
        }
        return results;
    }

    // ========== Relationship Highlighting ==========
    highlightRelationships(studentId) {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        // Add highlighting mode to grid
        grid.classList.add('sp-grid--highlighting');

        // Get related students from constraints (constraints use names, not IDs)
        const relatedIds = new Set();
        const hoveredStudent = this.studentMap.get(studentId);
        const hoveredName = hoveredStudent?.name;
        if (hoveredName) {
            for (const c of this.constraints) {
                if (c.target === hoveredName && c.related) {
                    const relatedStudent = this.students.find(s => s.name === c.related);
                    if (relatedStudent) relatedIds.add(relatedStudent.id);
                }
                if (c.related === hoveredName) {
                    const targetStudent = this.students.find(s => s.name === c.target);
                    if (targetStudent) relatedIds.add(targetStudent.id);
                }
            }
        }

        // Highlight current and related students
        const seats = grid.querySelectorAll('.sp-seat--filled');
        seats.forEach(seat => {
            const seatStudentId = seat.dataset.studentId;
            if (seatStudentId === studentId || relatedIds.has(seatStudentId)) {
                seat.classList.add('sp-seat--highlighted');
            }
        });
    }

    clearHighlights() {
        const grid = document.getElementById('sp-grid');
        if (!grid) return;

        grid.classList.remove('sp-grid--highlighting');
        const seats = grid.querySelectorAll('.sp-seat--highlighted');
        seats.forEach(seat => seat.classList.remove('sp-seat--highlighted'));
    }

    // ========== Layout Sync ==========
    syncPodiumSeatWidth() {
        const gridSeat = document.querySelector('.sp-grid .sp-seat');
        const podiumSeats = document.querySelectorAll('.sp-podium-row .sp-seat');
        if (gridSeat && podiumSeats.length) {
            const width = gridSeat.getBoundingClientRect().width;
            podiumSeats.forEach(seat => {
                seat.style.width = `${width}px`;
                seat.style.minWidth = `${width}px`;
            });
        }
    }

    getGridSeatElement(row, col) {
        return document.querySelector(`.sp-grid .sp-seat[data-row="${row}"][data-col="${col}"]`);
    }

    getCurrentLocalAisles() {
        const localAisles = normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols);
        if (this.classroomLayout) this.classroomLayout.localAisles = localAisles;
        return localAisles;
    }

    isInteractiveSeatCell(row, col) {
        return row >= 0
            && row < this.rows
            && col >= 0
            && col < this.cols
            && !this.rowAisles.includes(row)
            && !this.colAisles.includes(col)
            && isLayoutSeat(this.classroomLayout, row, col);
    }

    shouldShowRowGap(row, col) {
        return this.isInteractiveSeatCell(row, col) && this.isInteractiveSeatCell(row + 1, col);
    }

    shouldShowColumnGap(row, col) {
        return this.isInteractiveSeatCell(row, col) && this.isInteractiveSeatCell(row, col + 1);
    }

    shouldShowRowAisleBoundary(row) {
        return Number.isInteger(row)
            && row > 0
            && row < this.rows
            && !this.rowAisles.includes(row - 1)
            && !this.rowAisles.includes(row);
    }

    shouldShowColumnAisleBoundary(col) {
        return Number.isInteger(col)
            && col > 0
            && col < this.cols
            && !this.colAisles.includes(col - 1)
            && !this.colAisles.includes(col);
    }

    renderAisleGapHandles() {
        const layer = document.getElementById('sp-aisle-gap-layer');
        const grid = document.getElementById('sp-grid');
        const view = document.querySelector('.sp-classroom-view');
        if (!layer || !grid || !view) return;
        layer.replaceChildren();
        if (!this.rows || !this.cols) return;

        const viewRect = view.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        const toLayerLeft = value => value - viewRect.left + view.scrollLeft;
        const toLayerTop = value => value - viewRect.top + view.scrollTop;
        const firstVisibleRow = Number(grid.querySelector('.sp-seat[data-row]')?.dataset.row ?? 0);
        const lastVisibleRow = Number([...grid.querySelectorAll('.sp-seat[data-row]')].at(-1)?.dataset.row ?? this.rows - 1);
        for (let row = Math.max(1, firstVisibleRow); row <= Math.min(this.rows - 1, lastVisibleRow + 1); row++) {
            if (!this.shouldShowRowAisleBoundary(row)) continue;
            const upper = this.getGridSeatElement(row - 1, 0);
            const lower = this.getGridSeatElement(row, 0);
            if (!upper || !lower) continue;
            const upperRect = upper.getBoundingClientRect();
            const lowerRect = lower.getBoundingClientRect();
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = `sp-aisle-gap sp-aisle-gap--row`;
            handle.title = '点击插入横过道';
            handle.setAttribute('aria-label', `在第 ${row} 排和第 ${row + 1} 排之间插入横过道`);
            handle.dataset.insertRow = String(row);
            handle.style.left = `${toLayerLeft(gridRect.left)}px`;
            handle.style.top = `${toLayerTop((upperRect.bottom + lowerRect.top) / 2) - 7}px`;
            handle.style.width = `${gridRect.width}px`;
            handle.style.height = '14px';
            handle.addEventListener('click', event => {
                event.stopPropagation();
                this.insertAisleRowAt(row);
            });
            layer.appendChild(handle);
        }

        for (let col = 1; col < this.cols; col++) {
            if (!this.shouldShowColumnAisleBoundary(col)) continue;
            const left = this.getGridSeatElement(firstVisibleRow, col - 1);
            const right = this.getGridSeatElement(firstVisibleRow, col);
            const bottomCell = this.getGridSeatElement(Math.min(lastVisibleRow, this.rows - 1), col - 1);
            if (!left || !right || !bottomCell) continue;
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            const bottomRect = bottomCell.getBoundingClientRect();
            const handle = document.createElement('button');
            handle.type = 'button';
            handle.className = `sp-aisle-gap sp-aisle-gap--col`;
            handle.title = '点击插入竖过道';
            handle.setAttribute('aria-label', `在第 ${col} 列和第 ${col + 1} 列之间插入竖过道`);
            handle.dataset.insertCol = String(col);
            handle.style.left = `${toLayerLeft((leftRect.right + rightRect.left) / 2) - 7}px`;
            handle.style.top = `${toLayerTop(leftRect.top)}px`;
            handle.style.width = '14px';
            handle.style.height = `${Math.max(14, bottomRect.bottom - leftRect.top)}px`;
            handle.addEventListener('click', event => {
                event.stopPropagation();
                this.insertAisleColumnAt(col);
            });
            layer.appendChild(handle);
        }
    }

    applyAisleEditResult(result, message) {
        this.layout = result.layout;
        this.rows = result.rows;
        this.cols = result.cols;
        this.classroomLayout = result.classroomLayout;
        this.classroomLayout.localAisles = normalizeLocalAisles(this.classroomLayout.localAisles, this.rows, this.cols);
        this.classroomLayout.guardians.left = this.guardians[0] || null;
        this.classroomLayout.guardians.right = this.guardians[1] || null;
        this.rowAisles = result.rowAisles;
        this.colAisles = result.colAisles;
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        if (message) this.showToast(message, 'success');
    }

    applyLocalAisleEdit(nextClassroomLayout, message) {
        this.classroomLayout = structuredClone(nextClassroomLayout);
        this.classroomLayout.localAisles = normalizeLocalAisles(this.classroomLayout.localAisles, this.rows, this.cols);
        this.classroomLayout.guardians.left = this.guardians[0] || null;
        this.classroomLayout.guardians.right = this.guardians[1] || null;
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        if (message) this.showToast(message, 'success');
    }

    insertLocalAisleAt(orientation, row, col) {
        try {
            const next = insertLocalAisle({
                classroomLayout: this.classroomLayout,
                orientation,
                row,
                col,
            });
            this.applyLocalAisleEdit(next, '已在两个座位之间插入局部过道');
        } catch (error) {
            this.showToast(error.message || '无法插入局部过道', 'warning');
        }
    }

    deleteLocalAisleAt(orientation, row, col) {
        try {
            const next = deleteLocalAisle({
                classroomLayout: this.classroomLayout,
                orientation,
                row,
                col,
            });
            this.applyLocalAisleEdit(next, '已删除局部过道');
        } catch (error) {
            this.showToast(error.message || '无法删除局部过道', 'warning');
        }
    }

    insertAisleRowAt(index) {
        try {
            this.applyAisleEditResult(
                insertAisleRow({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已插入第 ${index} 排和第 ${index + 1} 排之间的横过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法插入横过道', 'warning');
        }
    }

    insertAisleColumnAt(index) {
        try {
            this.applyAisleEditResult(
                insertAisleColumn({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已插入第 ${index} 列和第 ${index + 1} 列之间的竖过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法插入竖过道', 'warning');
        }
    }

    deleteAisleRowAt(index) {
        try {
            this.applyAisleEditResult(
                deleteAisleRow({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已删除第 ${index + 1} 排横过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法删除横过道', 'warning');
        }
    }

    deleteAisleColumnAt(index) {
        try {
            this.applyAisleEditResult(
                deleteAisleColumn({ layout: this.layout, classroomLayout: this.classroomLayout, index }),
                `已删除第 ${index + 1} 列竖过道`
            );
        } catch (error) {
            this.showToast(error.message || '无法删除竖过道', 'warning');
        }
    }



    // ========== Context Menu ==========
    showContextMenu(e, row, col) {
        e.preventDefault();
        this.contextTarget = { row, col };

        const menu = document.getElementById('sp-context-menu');
        if (!menu) return;

        const isColAisle = this.colAisles.includes(col);
        const isRowAisle = this.rowAisles.includes(row);
        const isAisle = isColAisle || isRowAisle || !isLayoutSeat(this.classroomLayout, row, col);
        this.contextTarget = { row, col, aisleType: isRowAisle ? 'row' : isColAisle ? 'col' : null };

        menu.querySelector('[data-action="set-col-aisle"]').style.display = 'none';
        menu.querySelector('[data-action="set-row-aisle"]').style.display = 'none';
        menu.querySelector('[data-action="clear-aisle"]').style.display = (isRowAisle || isColAisle) ? 'flex' : 'none';
        menu.querySelector('[data-action="clear-seat"]').style.display = isAisle ? 'none' : 'flex';

        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.add('sp-context-menu--visible');
    }

    hideContextMenu() {
        document.getElementById('sp-context-menu')?.classList.remove('sp-context-menu--visible');
    }

    handleMenuAction(action) {
        if (!this.contextTarget) return;
        const { row, col, aisleType } = this.contextTarget;
        let changed = false;

        switch (action) {
            case 'set-col-aisle':
                if (colHasStudents(this.layout, col)) {
                    this.showToast('该列已有学生，请先移动或清空后再设为过道', 'warning');
                    break;
                }
                if (!this.colAisles.includes(col)) {
                    this.colAisles.push(col);
                    changed = true;
                    this.showToast(`第 ${col + 1} 列设为竖过道`, 'success');
                }
                break;
            case 'set-row-aisle':
                if (rowHasStudents(this.layout, row)) {
                    this.showToast('该行已有学生，请先移动或清空后再设为过道', 'warning');
                    break;
                }
                if (!this.rowAisles.includes(row)) {
                    this.rowAisles.push(row);
                    changed = true;
                    this.showToast(`第 ${row + 1} 行设为横过道`, 'success');
                }
                break;
            case 'clear-aisle':
                if (aisleType === 'row') {
                    this.deleteAisleRowAt(row);
                    this.hideContextMenu();
                    return;
                }
                if (aisleType === 'col') {
                    this.deleteAisleColumnAt(col);
                    this.hideContextMenu();
                    return;
                }
                break;
            case 'clear-seat':
                if (this.layout[row]?.[col]) {
                    this.layout[row][col] = null;
                    changed = true;
                    this.showToast('座位已清空', 'success');
                }
                break;
        }

        this.hideContextMenu();
        if (changed) {
            this.classroomLayout = this.legacyLayoutToClassroomLayout('custom');
            this.refreshConstraintStatus();
            this.saveSnapshot();
            this.renderGrid();
            this.updateStatus();
        }
    }

    // ========== File Upload ==========
    showStudentEditor(text = '') {
        const textarea = document.getElementById('sp-students-input');
        const dropzone = document.getElementById('sp-dropzone');
        const parseBtn = document.getElementById('sp-parse-students');
        if (textarea) {
            textarea.value = text;
            textarea.classList.add('sp-hidden');
        }
        dropzone?.classList.add('sp-hidden');
        parseBtn?.classList.remove('sp-hidden');
    }

    formatStudentsForEditor(students = []) {
        return students.map(student => this.formatReviewedStudentLine(student)).filter(Boolean).join('\n');
    }

    openRosterEditor() {
        const students = this.students.length ? this.students : [];
        if (!students.length) {
            this.showToast('请先导入学生名单', 'warning');
            return;
        }
        this.showRosterReview(students);
    }

    async handleFileUpload(file) {
        try {
            const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
            if (ext === '.xlsx' || ext === '.xls') {
                await this.handleRosterFileUpload(file);
                return;
            }

            const text = await file.text();
            this.showStudentEditor(text);
            this.parseStudents();
        } catch (err) {
            console.error('[SeatingPlanner] File read error:', err);
            this.showToast('文件读取失败', 'error');
        }
    }

    async handleRosterFileUpload(file) {
        const formData = new FormData();
        formData.append('file', file, file.name);

        const res = await fetch('/api/tools/seating/parse-students-file', {
            method: 'POST',
            body: formData
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error || '名单文件解析失败');

        this.students = result.data.students;
        this._buildStudentMap();
        this.showStudentEditor(this.formatStudentsForEditor(result.data.students));

        const badge = document.getElementById('sp-student-count');
        badge.innerHTML = `<i data-lucide="users"></i><span>${result.data.count} 人</span>`;
        document.getElementById('sp-generate').disabled = false;
        this.renderStudentPreview(result.data.students, result.data.count);
        if (window.lucide) window.lucide.createIcons();
        this.showToast(`成功导入 ${result.data.count} 名学生`, 'success');
        this.hideSuggestions('arrange');
    }

    /**
     * Compress image via Canvas before upload.
     * Shrinks to max 1600px on longest side, outputs JPEG 0.8.
     * Typically reduces 5-10MB phone photos to ~100-300KB.
     */
    async compressImage(file) {
        const MAX_SIZE = 1600;
        const QUALITY = 0.8;

        const bitmap = await createImageBitmap(file);
        let { width, height } = bitmap;

        // Scale down if either dimension exceeds MAX_SIZE
        if (width > MAX_SIZE || height > MAX_SIZE) {
            const ratio = Math.min(MAX_SIZE / width, MAX_SIZE / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
        }

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
        console.log(`[SeatingPlanner] Image compressed: ${(file.size / 1024).toFixed(0)}KB → ${(blob.size / 1024).toFixed(0)}KB (${width}×${height})`);
        return blob;
    }

    async handleImageUpload(file) {
        // Limit size (20MB raw — will be compressed before upload)
        if (file.size > 20 * 1024 * 1024) {
            return this.showToast('图片太大了 (限制20MB)', 'warning');
        }

        const btn = document.getElementById('sp-upload-image');
        const originalIcon = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i>';
        if (window.lucide) window.lucide.createIcons();

        try {
            // Compress image client-side before uploading
            const compressed = await this.compressImage(file);

            const formData = new FormData();
            formData.append('image', compressed, 'photo.jpg');

            const res = await fetch('/api/tools/seating/parse-image', {
                method: 'POST',
                body: formData
            });

            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.showImageReview(result.data);

        } catch (err) {
            console.error(err);
            this.showToast(err.message || '识别失败', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalIcon;
            if (window.lucide) window.lucide.createIcons();
            // Clear input
            document.getElementById('sp-image-input').value = '';
        }
    }

    formatReviewedStudentLine(s) {
        let line = s.name || '';
        if (s.gender) line += ` ${s.gender === 'M' ? '男' : '女'}`;
        if (s.height !== undefined && s.height !== null && s.height !== '') line += ` ${s.height}`;
        if (s.grade !== undefined && s.grade !== null && s.grade !== '') line += ` ${s.grade}`;
        return line.trim();
    }

    showImageReview(data = {}) {
        const students = Array.isArray(data.students) ? data.students : [];
        this._imageReviewMode = 'image';
        this._pendingImageReview = students;
        const modal = document.getElementById('sp-image-review');
        const title = document.getElementById('sp-image-review-title');
        const warnings = document.getElementById('sp-image-review-warnings');
        const confirmButton = document.getElementById('sp-image-review-confirm');
        const reuploadButton = document.getElementById('sp-image-review-reupload');
        if (title) title.textContent = students.length ? `识别结果确认（${students.length}人）` : '识别结果确认';
        if (confirmButton) confirmButton.textContent = '确认导入';
        reuploadButton?.classList.remove('sp-hidden');
        this.setRosterEditorControlsVisible(false);
        warnings.textContent = (data.warnings || []).join('；');
        warnings.classList.toggle('sp-hidden', !(data.warnings || []).length);
        this.renderImageReviewRows(students, { roster: false });
        modal?.classList.remove('sp-hidden');
        if (window.lucide) window.lucide.createIcons();
    }

    showRosterReview(students = []) {
        this._imageReviewMode = 'roster';
        this._pendingImageReview = students;
        const modal = document.getElementById('sp-image-review');
        const title = document.getElementById('sp-image-review-title');
        const warnings = document.getElementById('sp-image-review-warnings');
        const confirmButton = document.getElementById('sp-image-review-confirm');
        const reuploadButton = document.getElementById('sp-image-review-reupload');
        if (title) title.textContent = students.length ? `名单编辑（${students.length}人）` : '名单编辑';
        if (confirmButton) confirmButton.textContent = '确认更新';
        reuploadButton?.classList.add('sp-hidden');
        this.setRosterEditorControlsVisible(true);
        warnings?.classList.add('sp-hidden');
        if (warnings) warnings.textContent = '';
        this.renderImageReviewRows(students, { roster: true });
        modal?.classList.remove('sp-hidden');
        if (window.lucide) window.lucide.createIcons();
    }

    closeImageReview() {
        this._imageReviewMode = null;
        this._pendingImageReview = null;
        this.setRosterEditorControlsVisible(false);
        document.getElementById('sp-image-review')?.classList.add('sp-hidden');
    }

    setRosterEditorControlsVisible(visible) {
        const modal = document.getElementById('sp-image-review');
        const toolbar = document.getElementById('sp-roster-toolbar');
        const bulkPanel = document.getElementById('sp-roster-bulk-panel');
        modal?.classList.toggle('sp-image-review--roster', visible);
        toolbar?.classList.toggle('sp-hidden', !visible);
        if (!visible) bulkPanel?.classList.add('sp-hidden');
    }

    createReviewField(field, value, issues = []) {
        const input = document.createElement(field === 'gender' ? 'select' : 'input');
        input.className = 'sp-image-review-field';
        input.dataset.field = field;
        if (field === 'gender') {
            [['', ''], ['M', '男'], ['F', '女']].forEach(([optionValue, label]) => {
                const option = document.createElement('option');
                option.value = optionValue;
                option.textContent = label;
                input.appendChild(option);
            });
            input.value = value || '';
        } else {
            input.value = value ?? '';
            if (field === 'height' || field === 'grade') input.type = 'number';
        }
        const issueText = issues.join('|');
        const warningByField = {
            name: /missing_name|duplicate_name/,
            height: /missing_height|height_out_of_range/,
            grade: /grade_out_of_range/,
        };
        if (warningByField[field]?.test(issueText)) input.classList.add('sp-image-review-field--warning');
        return input;
    }

    createImageReviewRow(student = {}, index = 0, { roster = false } = {}) {
        const issues = Array.isArray(student.issues) ? student.issues : [];
        const row = document.createElement('tr');
        if (student.id) row.dataset.studentId = String(student.id);
        if (issues.length) row.classList.add('sp-image-review-row--warning');
        const indexCell = document.createElement('td');
        indexCell.className = 'sp-image-review-index';
        indexCell.textContent = String(index + 1);
        row.appendChild(indexCell);
        ['name', 'gender', 'height', 'grade'].forEach(field => {
            const cell = document.createElement('td');
            cell.appendChild(this.createReviewField(field, student[field], issues));
            row.appendChild(cell);
        });
        const actionCell = document.createElement('td');
        actionCell.className = 'sp-roster-action';
        if (roster) {
            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'sp-roster-delete-row';
            deleteButton.title = '删除此学生';
            deleteButton.setAttribute('aria-label', '删除此学生');
            deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
            actionCell.appendChild(deleteButton);
        }
        row.appendChild(actionCell);
        return row;
    }

    renderImageReviewRows(students = [], options = {}) {
        const body = document.getElementById('sp-image-review-body');
        if (!body) return;
        body.replaceChildren();
        students.forEach((student, index) => {
            body.appendChild(this.createImageReviewRow(student, index, options));
        });
        this.renumberReviewRows();
    }

    addRosterReviewRow(student = {}) {
        const body = document.getElementById('sp-image-review-body');
        if (!body) return;
        body.appendChild(this.createImageReviewRow(student, body.querySelectorAll('tr').length, { roster: true }));
        this.renumberReviewRows();
        this.updateRosterReviewTitle();
        if (window.lucide) window.lucide.createIcons();
    }

    renumberReviewRows() {
        [...document.querySelectorAll('#sp-image-review-body tr')].forEach((row, index) => {
            const indexCell = row.querySelector('.sp-image-review-index');
            if (indexCell) indexCell.textContent = String(index + 1);
        });
    }

    updateRosterReviewTitle() {
        if (this._imageReviewMode !== 'roster') return;
        const title = document.getElementById('sp-image-review-title');
        const count = document.querySelectorAll('#sp-image-review-body tr').length;
        if (title) title.textContent = count ? `名单编辑（${count}人）` : '名单编辑';
    }

    toggleRosterBulkPanel() {
        document.getElementById('sp-roster-bulk-panel')?.classList.toggle('sp-hidden');
    }

    async appendRosterBulkText() {
        const textarea = document.getElementById('sp-roster-bulk-text');
        const button = document.getElementById('sp-roster-bulk-append');
        const text = textarea?.value?.trim() || '';
        if (!text) {
            this.showToast('请先粘贴学生名单', 'warning');
            return;
        }
        if (button) button.disabled = true;
        try {
            const res = await fetch('/api/tools/seating/parse-students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error || '名单解析失败');
            const students = Array.isArray(result.data?.students) ? result.data.students : [];
            if (!students.length) {
                this.showToast('没有解析到可追加的学生', 'warning');
                return;
            }
            students.forEach(student => this.addRosterReviewRow({
                name: student.name,
                gender: student.gender,
                height: student.height,
                grade: student.grade,
            }));
            if (textarea) textarea.value = '';
            document.getElementById('sp-roster-bulk-panel')?.classList.add('sp-hidden');
            this.showToast(`已追加 ${students.length} 名学生`, 'success');
        } catch (err) {
            console.error('[SeatingPlanner] Bulk roster parse error:', err);
            this.showToast(err.message || '批量名单解析失败', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    getImageReviewStudents({ includePartial = false } = {}) {
        const rows = [...document.querySelectorAll('#sp-image-review-body tr')];
        return rows.map(row => {
            const value = field => row.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
            const numeric = field => {
                const raw = value(field);
                return raw === '' ? undefined : Number(raw);
            };
            const student = {
                id: row.dataset.studentId || '',
                name: value('name'),
                gender: value('gender'),
                height: numeric('height'),
                grade: numeric('grade'),
            };
            student._hasAnyValue = Boolean(student.name || student.gender || student.height !== undefined || student.grade !== undefined);
            return student;
        }).filter(student => includePartial ? student._hasAnyValue : student.name);
    }

    appendReviewedStudentsToInput(students) {
        const newStudentsText = students.map(s => this.formatReviewedStudentLine(s)).filter(Boolean).join('\n');
        const textarea = document.getElementById('sp-students-input');
        const current = textarea?.value?.trim() || '';
        const nextText = current ? (current + '\n' + newStudentsText) : newStudentsText;
        this.showStudentEditor(nextText);
        this.parseStudents();
    }

    updateReviewedStudentsInInput(students) {
        const nextText = this.formatStudentsForEditor(students);
        this.showStudentEditor(nextText);
        this.parseStudents();
    }

    nextStudentId(usedIds = new Set()) {
        let max = 0;
        for (const id of usedIds) {
            const match = String(id || '').match(/^s(\d+)$/i);
            if (match) max = Math.max(max, Number(match[1]));
        }
        let next = max + 1;
        let candidate = `s${String(next).padStart(2, '0')}`;
        while (usedIds.has(candidate)) {
            next += 1;
            candidate = `s${String(next).padStart(2, '0')}`;
        }
        return candidate;
    }

    normalizeRosterReviewStudent(student, id) {
        const normalizeNumber = value => {
            if (value === undefined || value === null || value === '') return undefined;
            const num = Number(value);
            return Number.isFinite(num) ? num : undefined;
        };
        return {
            id,
            name: String(student.name || '').trim(),
            gender: student.gender === 'M' || student.gender === 'F' ? student.gender : '',
            height: normalizeNumber(student.height),
            grade: normalizeNumber(student.grade),
        };
    }

    buildRosterUpdateFromReview(reviewStudents = []) {
        const previousIds = new Set(this.students.map(student => student.id));
        const usedIds = new Set(previousIds);
        const keptIds = new Set();
        const addedIds = [];
        const students = [];
        for (const item of reviewStudents) {
            const name = String(item?.name || '').trim();
            if (!name) continue;
            let id = String(item.id || '').trim();
            if (!previousIds.has(id) || keptIds.has(id)) {
                id = this.nextStudentId(usedIds);
                addedIds.push(id);
            }
            usedIds.add(id);
            keptIds.add(id);
            students.push(this.normalizeRosterReviewStudent({ ...item, name }, id));
        }
        const nextIds = new Set(students.map(student => student.id));
        const removedIds = this.students
            .map(student => student.id)
            .filter(id => !nextIds.has(id));
        return { students, removedIds, addedIds };
    }

    getPlacedRosterStudentIds() {
        const placed = new Set();
        for (const row of this.layout || []) {
            for (const id of row || []) {
                if (id && id !== '_aisle_') placed.add(id);
            }
        }
        for (const id of this.guardians || []) {
            if (id) placed.add(id);
        }
        return placed;
    }

    clearRemovedRosterStudentReferences(removedIds = []) {
        const removed = new Set(removedIds);
        if (!removed.size) return;
        for (const row of this.layout || []) {
            for (let c = 0; c < (row?.length || 0); c++) {
                if (removed.has(row[c])) row[c] = null;
            }
        }
        this.guardians = (this.guardians || [null, null]).map(id => removed.has(id) ? null : id);
        if (this.classroomLayout?.guardians) {
            if (removed.has(this.classroomLayout.guardians.left)) this.classroomLayout.guardians.left = null;
            if (removed.has(this.classroomLayout.guardians.right)) this.classroomLayout.guardians.right = null;
        }
        this.unassigned = (this.unassigned || []).filter(id => !removed.has(id));
    }

    applyRosterReviewState(update) {
        this.clearRemovedRosterStudentReferences(update.removedIds);
        this.students = update.students;
        this._buildStudentMap();

        const knownIds = new Set(this.students.map(student => student.id));
        const placedIds = this.getPlacedRosterStudentIds();
        const nextUnassigned = [];
        const pushUnassigned = id => {
            if (knownIds.has(id) && !placedIds.has(id) && !nextUnassigned.includes(id)) nextUnassigned.push(id);
        };
        (this.unassigned || []).forEach(pushUnassigned);
        this.students.forEach(student => pushUnassigned(student.id));
        this.unassigned = nextUnassigned;
    }

    syncRosterEditorAfterUpdate() {
        this.showStudentEditor(this.formatStudentsForEditor(this.students));
        const badge = document.getElementById('sp-student-count');
        if (badge) badge.innerHTML = `<i data-lucide="users"></i><span>${this.students.length} 人</span>`;
        const generateButton = document.getElementById('sp-generate');
        if (generateButton) generateButton.disabled = this.students.length === 0;
        this.renderStudentPreview(this.students, this.students.length);
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        this.hideSuggestions('arrange');
        if (window.lucide) window.lucide.createIcons();
    }

    applyRosterReviewUpdate(reviewStudents = []) {
        const update = this.buildRosterUpdateFromReview(reviewStudents);
        this.applyRosterReviewState(update);
        this.syncRosterEditorAfterUpdate();
        return update;
    }

    validateRosterReviewRows() {
        const rows = [...document.querySelectorAll('#sp-image-review-body tr')];
        const seenNames = new Map();
        let invalid = false;
        let firstMessage = '';
        rows.forEach(row => {
            row.classList.remove('sp-image-review-row--warning');
            row.querySelectorAll('.sp-image-review-field--warning').forEach(field => {
                field.classList.remove('sp-image-review-field--warning');
            });
        });
        const flag = (row, field, message) => {
            row.classList.add('sp-image-review-row--warning');
            row.querySelector(`[data-field="${field}"]`)?.classList.add('sp-image-review-field--warning');
            invalid = true;
            if (!firstMessage) firstMessage = message;
        };
        rows.forEach(row => {
            const value = field => row.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
            const name = value('name');
            const gender = value('gender');
            const heightRaw = value('height');
            const gradeRaw = value('grade');
            const hasAny = Boolean(name || gender || heightRaw || gradeRaw);
            if (!hasAny) return;
            if (!name) flag(row, 'name', '请补全红色行的姓名，或删除该空行');
            if (name) {
                const existingRow = seenNames.get(name);
                if (existingRow) {
                    flag(row, 'name', `名单中有重复姓名：${name}`);
                    flag(existingRow, 'name', `名单中有重复姓名：${name}`);
                } else {
                    seenNames.set(name, row);
                }
            }
            const height = heightRaw === '' ? undefined : Number(heightRaw);
            if (height !== undefined && (!Number.isFinite(height) || height < 80 || height > 240)) {
                flag(row, 'height', '身高需要在 80-240 厘米之间');
            }
            const grade = gradeRaw === '' ? undefined : Number(gradeRaw);
            if (grade !== undefined && (!Number.isFinite(grade) || grade < 0 || grade > 100)) {
                flag(row, 'grade', '成绩需要在 0-100 之间');
            }
        });
        return { ok: !invalid, message: firstMessage };
    }

    confirmImageReview() {
        if (this._imageReviewMode === 'roster') {
            this.confirmRosterReview();
            return;
        }
        const students = this.getImageReviewStudents();
        if (!students.length) {
            this.showToast('请至少保留一名学生', 'warning');
            return;
        }
        this.appendReviewedStudentsToInput(students);
        this.closeImageReview();
        this.showToast(`已导入 ${students.length} 名学生`, 'success');
    }

    confirmRosterReview() {
        const validation = this.validateRosterReviewRows();
        if (!validation.ok) {
            this.showToast(validation.message || '请先修正红色字段', 'warning');
            return;
        }
        const students = this.getImageReviewStudents({ includePartial: true }).filter(student => student.name);
        if (!students.length) {
            this.showToast('请至少保留一名学生', 'warning');
            return;
        }
        this.applyRosterReviewUpdate(students);
        this.closeImageReview();
        this.showToast(`已更新 ${students.length} 名学生`, 'success');
    }

    // ========== API Calls ==========
    renderStudentPreview(students, count) {
        const visibleCount = SeatingPlanner.VISIBLE_TAG_COUNT;
        const preview = document.getElementById('sp-students-preview');
        if (!preview) return;
        preview.innerHTML = '';
        students.slice(0, visibleCount).forEach(s => {
            const tag = document.createElement('span');
            tag.className = `sp-tag ${s.gender === 'M' ? 'sp-tag--male' : s.gender === 'F' ? 'sp-tag--female' : ''}`;
            tag.textContent = s.name;
            preview.appendChild(tag);
        });
        if (count > visibleCount) {
            preview.insertAdjacentHTML('beforeend', `<span class="sp-tag sp-tag--more">+${count - visibleCount}</span>`);
        }
    }

    async parseStudents() {
        const text = document.getElementById('sp-students-input')?.value?.trim();
        if (!text) return this.showToast('请输入学生名单', 'warning');

        try {
            const res = await fetch('/api/tools/seating/parse-students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.students = result.data.students;
            this._buildStudentMap();
            const badge = document.getElementById('sp-student-count');
            badge.innerHTML = `<i data-lucide="users"></i><span>${result.data.count} 人</span>`;
            if (window.lucide) window.lucide.createIcons();
            document.getElementById('sp-generate').disabled = false;

            // Preview tags
            this.renderStudentPreview(result.data.students, result.data.count);

            this.showToast(`成功导入 ${result.data.count} 名学生`, 'success');
            this.hideSuggestions('arrange');
        } catch (err) {
            this.showToast(err.message, 'error');
        }
    }

    async parseConstraints() {
        const text = document.getElementById('sp-constraints-input')?.value?.trim();
        if (!text) return this.showToast('请输入学生需求', 'warning');

        const btn = document.getElementById('sp-parse-constraints');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 解析中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const res = await fetch('/api/tools/seating/parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, students: this.students })
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.constraints = result.data.constraints;
            const list = document.getElementById('sp-constraints-list');
            if (this.constraints.length === 0) {
                list.innerHTML = '<div style="text-align:center;color:var(--sp-text-muted);font-size:0.85rem;padding:16px;">未识别到学生需求</div>';
            } else {
                list.innerHTML = '';
                const iconMap = { front_row: 'eye', back_row: 'arrow-down', avoid: 'x-circle', prefer: 'heart', pair: 'link' };
                const typeMap = { front_row: 'front', avoid: 'avoid', prefer: 'prefer', pair: 'prefer', back_row: 'front' };
                this.constraints.forEach(c => {
                    const div = document.createElement('div');
                    div.className = 'sp-constraint';

                    const iconSpan = document.createElement('span');
                    iconSpan.className = `sp-constraint-icon sp-constraint-icon--${typeMap[c.type] || 'front'}`;
                    iconSpan.innerHTML = `<i data-lucide="${iconMap[c.type] || 'circle'}"></i>`;
                    div.appendChild(iconSpan);

                    const textSpan = document.createElement('span');
                    textSpan.className = 'sp-constraint-text';
                    textSpan.textContent = `${c.target}${c.related ? ` ⇄ ${c.related}` : ''}: ${c.reason}`;
                    div.appendChild(textSpan);

                    const prioritySpan = document.createElement('span');
                    prioritySpan.className = `sp-constraint-priority sp-constraint-priority--${c.priority}`;
                    prioritySpan.textContent = c.priority === 'hard' ? '必须' : '尽量';
                    div.appendChild(prioritySpan);

                    list.appendChild(div);
                });
            }

            if (window.lucide) window.lucide.createIcons();
            this.refreshConstraintStatus();
            this.updateStatus();
            this.showToast(`识别到 ${this.constraints.length} 条学生需求`, 'success');
            this.hideSuggestions('arrange');
        } catch (err) {
            this.showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles"></i> 提取需求';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    async generateSeating() {
        if (!this.students.length) return this.showToast('请先导入名单', 'warning');
        const prompt = this.getArrangePrompt();
        if (!prompt) return this.showToast('请先描述教室和排座需求', 'warning');
        if (this._isGenerating) return; // Loading guard
        this._isGenerating = true;
        this.recordDiagnosticEvent('generate_seating_started', {
            prompt,
            studentCount: this.students.length,
        });

        const btn = document.getElementById('sp-generate');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> AI 排座中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const data = await this.requestAiArrangement(prompt);
            const arrangement = this.applyArrangementResult(data);
            this.showToast(arrangement.reply || 'AI 座位表生成完成', 'success');
            this.recordDiagnosticEvent('generate_seating_success', {
                source: arrangement.source || null,
                stats: arrangement.stats || null,
                warnings: arrangement.warnings || [],
            });
            this.showArrangementWarnings(arrangement.warnings);
        } catch (err) {
            console.error('[SeatingPlanner] Generation failed:', err);
            this.recordDiagnosticEvent('generate_seating_failed', {
                error: err.message || 'generation_failed',
            });
            this.showToast('AI 生成失败: ' + err.message, 'error');
        } finally {
            this._isGenerating = false;
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles"></i> 生成座位表';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    showArrangementWarnings(warnings = []) {
        const actionableWarnings = warnings
            .filter(Boolean)
            .filter(warning => /未安排|不足|无法|不能|失败|错误|无效|越界|重复|过道|缺少|覆盖|不合法|不满足|容量|未知/.test(warning));
        if (actionableWarnings.length) {
            this.showToast(actionableWarnings.join('；'), 'warning');
        }
    }

    // ========== Seat Score Matrix ==========
    /**
     * Calculate a quality score for every seat in the grid.
     * Higher score = better seat (center-front golden zone).
     * Accounts for aisles splitting the room into blocks.
     * @returns {number[][]} scores – same shape as this.layout
     */
    calculateSeatScores() {
        const scores = [];
        // Determine usable (non-aisle) row indices
        const usableRows = [];
        for (let r = 0; r < this.rows; r++) {
            const hasSeat = Array.from({ length: this.cols }, (_, c) => c)
                .some(c => isLayoutSeat(this.classroomLayout, r, c) && !this.colAisles.includes(c));
            if (!this.rowAisles.includes(r) && hasSeat) usableRows.push(r);
        }
        const totalUsableRows = usableRows.length;

        // Determine column blocks separated by column-aisles
        // Each block is an array of usable column indices
        const colBlocks = [];
        let currentBlock = [];
        for (let c = 0; c < this.cols; c++) {
            const columnHasSeat = Array.from({ length: this.rows }, (_, r) => r)
                .some(r => isLayoutSeat(this.classroomLayout, r, c) && !this.rowAisles.includes(r));
            if (this.colAisles.includes(c) || !columnHasSeat) {
                if (currentBlock.length) colBlocks.push(currentBlock);
                currentBlock = [];
            } else {
                currentBlock.push(c);
            }
        }
        if (currentBlock.length) colBlocks.push(currentBlock);

        // Row score: Gaussian peak at ~1/3 from front of usable rows
        const peakRowPos = Math.max(0, totalUsableRows * 0.33);
        const rowSigma = totalUsableRows * 0.45; // spread
        const rowScoreMap = new Map();
        usableRows.forEach((r, idx) => {
            const dist = idx - peakRowPos;
            rowScoreMap.set(r, Math.exp(-(dist * dist) / (2 * rowSigma * rowSigma)));
        });

        const usableColumns = [];
        for (let c = 0; c < this.cols; c++) {
            const columnHasSeat = Array.from({ length: this.rows }, (_, r) => r)
                .some(r => isLayoutSeat(this.classroomLayout, r, c) && !this.rowAisles.includes(r));
            if (!this.colAisles.includes(c) && columnHasSeat) usableColumns.push(c);
        }
        const usableColumnIndex = new Map(usableColumns.map((c, index) => [c, index]));
        const globalColumnCenter = Math.max(0, (usableColumns.length - 1) / 2);
        const globalColumnSigma = usableColumns.length * 0.35 || 1;

        // Column score: prefer the whole classroom center, while keeping a small within-block preference.
        const colScoreMap = new Map();
        for (const block of colBlocks) {
            const blockCenter = (block.length - 1) / 2;
            const colSigma = block.length * 0.45 || 1;
            block.forEach((c, idx) => {
                const globalDist = (usableColumnIndex.get(c) ?? 0) - globalColumnCenter;
                const globalScore = Math.exp(-(globalDist * globalDist) / (2 * globalColumnSigma * globalColumnSigma));
                const blockDist = idx - blockCenter;
                const blockScore = Math.exp(-(blockDist * blockDist) / (2 * colSigma * colSigma));
                let score = globalScore * (0.75 + 0.25 * blockScore);
                // Aisle-adjacent penalty: check if neighboring column is an aisle
                if (this.colAisles.includes(c - 1) || this.colAisles.includes(c + 1)) {
                    score *= 0.95;
                }
                colScoreMap.set(c, score);
            });
        }

        // Aisle-row adjacent penalty
        const rowAisleAdjacentSet = new Set();
        for (const ar of this.rowAisles) {
            if (ar - 1 >= 0) rowAisleAdjacentSet.add(ar - 1);
            if (ar + 1 < this.rows) rowAisleAdjacentSet.add(ar + 1);
        }

        // Build final score matrix
        for (let r = 0; r < this.rows; r++) {
            scores[r] = new Array(this.cols).fill(0);
            for (let c = 0; c < this.cols; c++) {
                if (this.colAisles.includes(c) || this.rowAisles.includes(r) || !isLayoutSeat(this.classroomLayout, r, c)) {
                    scores[r][c] = -1; // aisle marker
                    continue;
                }
                const rs = rowScoreMap.get(r) || 0;
                const cs = colScoreMap.get(c) || 0;
                let raw = rs * cs;
                if (rowAisleAdjacentSet.has(r)) raw *= 0.93;
                scores[r][c] = Math.round(raw * 100); // 0-100 scale
            }
        }
        return scores;
    }

    // ========== Local Deterministic Algorithm ==========
    applyConstraints({ seatScores, allSeats, placed, occupied, placeSeat, isFree }) {
        const frontRowIds = new Set();
        const backRowIds = new Set();
        const avoidPairs = [];
        const pairIds = []; // must-sit-together pairs

        // Parse constraints
        for (const c of this.constraints) {
            if (c.type === 'front_row') {
                const s = this.students.find(st => st.name === c.target);
                if (s) frontRowIds.add(s.id);
            }
            if (c.type === 'back_row') {
                const s = this.students.find(st => st.name === c.target);
                if (s) backRowIds.add(s.id);
            }
            if (c.type === 'avoid') {
                const s1 = this.students.find(st => st.name === c.target);
                const s2 = this.students.find(st => st.name === c.related);
                if (s1 && s2) avoidPairs.push([s1.id, s2.id]);
            }
            if (c.type === 'pair') {
                const s1 = this.students.find(st => st.name === c.target);
                const s2 = this.students.find(st => st.name === c.related);
                if (s1 && s2) pairIds.push([s1.id, s2.id]);
            }
        }

        // Determine row zones for front/back constraints
        const usableRows = [];
        for (let r = 0; r < this.rows; r++) {
            const hasSeat = Array.from({ length: this.cols }, (_, c) => c)
                .some(c => isLayoutSeat(this.classroomLayout, r, c) && !this.colAisles.includes(c));
            if (!this.rowAisles.includes(r) && hasSeat) usableRows.push(r);
        }
        const frontThreshold = Math.ceil(usableRows.length / 3);
        const backThreshold = usableRows.length - Math.ceil(usableRows.length / 3);
        const frontZoneRows = new Set(usableRows.slice(0, frontThreshold));
        const backZoneRows = new Set(usableRows.slice(backThreshold));

        // Helper: get best free seats in a zone, sorted by score desc
        const bestSeatsInZone = (zoneRows) => {
            return allSeats.filter(s => zoneRows.has(s.r) && isFree(s.r, s.c));
        };

        // ========== Round 1: Hard Constraints ==========

        // 1a. Pair constraints — find best adjacent free pair
        for (const [id1, id2] of pairIds) {
            if (placed.has(id1) || placed.has(id2)) continue;
            let bestPair = null, bestScore = -1;
            for (const seat of allSeats) {
                if (!isFree(seat.r, seat.c)) continue;
                // Check right neighbor
                if (isFree(seat.r, seat.c + 1)) {
                    const pairScore = seat.score + (seatScores[seat.r]?.[seat.c + 1] || 0);
                    if (pairScore > bestScore) {
                        bestScore = pairScore;
                        bestPair = [{ r: seat.r, c: seat.c }, { r: seat.r, c: seat.c + 1 }];
                    }
                }
            }
            if (bestPair) {
                placeSeat(id1, bestPair[0].r, bestPair[0].c);
                placeSeat(id2, bestPair[1].r, bestPair[1].c);
            }
        }

        // 1b. Front-row constraints
        for (const id of frontRowIds) {
            if (placed.has(id)) continue;
            const available = bestSeatsInZone(frontZoneRows);
            if (available.length) {
                placeSeat(id, available[0].r, available[0].c);
            }
        }

        // 1c. Back-row constraints
        for (const id of backRowIds) {
            if (placed.has(id)) continue;
            const available = bestSeatsInZone(backZoneRows);
            if (available.length) {
                placeSeat(id, available[0].r, available[0].c);
            }
        }

        return { avoidPairs };
    }

    sortSeatsByScore(seats) {
        return [...seats].sort((a, b) => {
            const scoreDiff = (b.score || 0) - (a.score || 0);
            if (scoreDiff !== 0) return scoreDiff;
            if (a.r !== b.r) return a.r - b.r;
            return a.c - b.c;
        });
    }

    interleaveStudentsByGender(students) {
        const males = students.filter(s => s.gender === 'M');
        const females = students.filter(s => s.gender === 'F');
        const unknown = students.filter(s => s.gender !== 'M' && s.gender !== 'F');
        const interleaved = [];
        let mi = 0, fi = 0, ui = 0;
        for (let i = 0; i < students.length; i++) {
            if (i % 2 === 0) {
                if (mi < males.length) interleaved.push(males[mi++]);
                else if (fi < females.length) interleaved.push(females[fi++]);
                else if (ui < unknown.length) interleaved.push(unknown[ui++]);
            } else {
                if (fi < females.length) interleaved.push(females[fi++]);
                else if (mi < males.length) interleaved.push(males[mi++]);
                else if (ui < unknown.length) interleaved.push(unknown[ui++]);
            }
        }
        return interleaved;
    }

    placeTopGradeStudentsInBestSeats(students, seats, placeSeat) {
        const topGradeIds = this.getTopGradeStudentIds();
        const excellentStudents = students
            .filter(student => this.isTopGradeStudent(student, topGradeIds))
            .sort((a, b) => {
                const gradeDiff = Number(b.grade) - Number(a.grade);
                if (gradeDiff !== 0) return gradeDiff;
                return String(a.id).localeCompare(String(b.id));
            });
        const bestSeats = this.sortSeatsByScore(seats);
        const placedExcellent = new Set();
        let seatIndex = 0;
        for (const student of excellentStudents) {
            while (seatIndex < bestSeats.length) {
                const seat = bestSeats[seatIndex++];
                if (placeSeat(student.id, seat.r, seat.c)) {
                    placedExcellent.add(student.id);
                    break;
                }
            }
        }
        return placedExcellent;
    }

    placeStudentsInSeatOrder(students, seats, placeSeat) {
        for (let i = 0; i < students.length && i < seats.length; i++) {
            placeSeat(students[i].id, seats[i].r, seats[i].c);
        }
    }

    generateSeatingLocal() {
        const students = [...this.students];
        const { genderBalance, gradeStrategy, heightOrder } = this.strategy;

        // Calculate seat scores
        const seatScores = this.calculateSeatScores();

        // Build list of available seats sorted by score (descending = best first)
        const allSeats = [];
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (seatScores[r][c] >= 0) { // skip aisles
                    allSeats.push({ r, c, score: seatScores[r][c] });
                }
            }
        }
        const usesGroupedLayout = (this.classroomLayout?.groupSize || 1) > 1
            || this.classroomLayout?.template === 'islands';
        if (usesGroupedLayout) {
            allSeats.sort((a, b) => {
                const groupA = this.classroomLayout?.groups?.[a.r]?.[a.c] ?? Number.MAX_SAFE_INTEGER;
                const groupB = this.classroomLayout?.groups?.[b.r]?.[b.c] ?? Number.MAX_SAFE_INTEGER;
                if (groupA !== groupB) return groupA - groupB;
                if (a.r !== b.r) return a.r - b.r;
                return a.c - b.c;
            });
        } else if (heightOrder) {
            allSeats.sort((a, b) => {
                if (a.r !== b.r) return a.r - b.r; // Row 0 first
                return b.score - a.score; // Center preferred within row
            });
        } else {
            allSeats.sort((a, b) => b.score - a.score);
        }

        // Reset layout & tracking
        this.layout = Array.from({ length: this.rows }, () => Array(this.cols).fill(null));
        const placed = new Set();
        const occupied = new Set();

        const isFree = (r, c) => {
            if (this.colAisles.includes(c) || this.rowAisles.includes(r) || !isLayoutSeat(this.classroomLayout, r, c)) return false;
            return !occupied.has(`${r},${c}`);
        };

        const placeSeat = (studentId, r, c) => {
            if (occupied.has(`${r},${c}`)) return false;
            this.layout[r][c] = studentId; // Set ID
            placed.add(studentId);
            occupied.add(`${r},${c}`);
            return true;
        };
        // ========== Step 1: Apply Constraints ==========
        const { avoidPairs } = this.applyConstraints({
            seatScores, allSeats, placed, occupied, placeSeat, isFree
        });

        // ========== Round 2 & 3: Remaining Students ==========
        const remaining = students.filter(s => !placed.has(s.id));

        // Sort remaining students by strategy
        if (heightOrder) {
            // Height: short students first (they get high-score = front seats)
            remaining.sort((a, b) => (a.height || 0) - (b.height || 0));
        } else if (gradeStrategy === 'balance') {
            // Grade balance: interleave high and low
            remaining.sort((a, b) => (b.grade || 0) - (a.grade || 0));
            const balanced = [];
            let lo = 0, hi = remaining.length - 1;
            let toggle = true;
            while (lo <= hi) {
                balanced.push(toggle ? remaining[lo++] : remaining[hi--]);
                toggle = !toggle;
            }
            remaining.length = 0;
            remaining.push(...balanced);
        } else if (gradeStrategy !== 'priority') {
            // No grade strategy: random shuffle
            for (let i = remaining.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
        }

        // Apply gender interleave if enabled
        if (genderBalance && gradeStrategy !== 'priority') {
            const interleaved = this.interleaveStudentsByGender(remaining);
            remaining.length = 0;
            remaining.push(...interleaved);
        }

        const guardiansEnabled = Boolean(this.classroomLayout?.guardians?.enabled || this.isGuardiansEnabled());
        this.guardians = guardiansEnabled ? [null, null] : [null, null];
        if (guardiansEnabled) {
            for (let i = 0; i < this.guardians.length && remaining.length > 0; i++) {
                const guardianStudent = remaining.shift();
                this.guardians[i] = guardianStudent.id;
                placed.add(guardianStudent.id);
            }
            this.classroomLayout.guardians = {
                enabled: true,
                left: this.guardians[0],
                right: this.guardians[1]
            };
            document.getElementById('sp-podium-row')?.classList.add('is-expanded');
        }

        const placePriorityRegion = (regionStudents, regionSeats) => {
            const placedExcellent = this.placeTopGradeStudentsInBestSeats(
                regionStudents,
                regionSeats.filter(s => isFree(s.r, s.c)),
                placeSeat
            );
            let rest = regionStudents.filter(student => !placedExcellent.has(student.id));
            if (genderBalance) rest = this.interleaveStudentsByGender(rest);
            this.placeStudentsInSeatOrder(rest, regionSeats.filter(s => isFree(s.r, s.c)), placeSeat);
        };

        // Height + excellence: height decides row, top 20% gets center seats inside that row.
        if (!usesGroupedLayout && heightOrder && gradeStrategy === 'priority') {
            // Group students by target row based on height order
            const freeSeats = allSeats.filter(s => isFree(s.r, s.c));
            // Sort free seats by row first (front to back), then score desc within row
            freeSeats.sort((a, b) => a.r !== b.r ? a.r - b.r : b.score - a.score);
            // Students already sorted short→tall; top 20% students get the best scored seat in their row.
            const rowGroups = new Map();
            let si = 0;
            for (const seat of freeSeats) {
                if (si >= remaining.length) break;
                if (!rowGroups.has(seat.r)) rowGroups.set(seat.r, { seats: [], students: [] });
                rowGroups.get(seat.r).seats.push(seat);
                rowGroups.get(seat.r).students.push(remaining[si++]);
            }
            for (const [, group] of rowGroups) {
                placePriorityRegion(group.students, group.seats);
            }
        } else if (gradeStrategy === 'priority') {
            const freeSeats = allSeats.filter(s => isFree(s.r, s.c));
            placePriorityRegion(remaining, freeSeats);
        } else {
            // Standard: assign students in order to best available seats
            const freeSeats = allSeats.filter(s => isFree(s.r, s.c));
            for (let i = 0; i < remaining.length && i < freeSeats.length; i++) {
                placeSeat(remaining[i].id, freeSeats[i].r, freeSeats[i].c);
            }
        }

        // ========== Step 4: Avoid-pair post-processing ==========
        for (const [id1, id2] of avoidPairs) {
            const pos1 = this._findPos(id1);
            const pos2 = this._findPos(id2);
            if (!pos1 || !pos2) continue;
            const dist = Math.abs(pos1.r - pos2.r) + Math.abs(pos1.c - pos2.c);
            if (dist <= 1) {
                // Try to swap id2 with a distant student
                let swapped = false;
                for (let r = 0; r < this.rows && !swapped; r++) {
                    for (let c = 0; c < this.cols && !swapped; c++) {
                        if (this.colAisles.includes(c) || this.rowAisles.includes(r) || !isLayoutSeat(this.classroomLayout, r, c)) continue;
                        const candidateId = this.layout[r][c];
                        if (!candidateId || candidateId === '_aisle_' || candidateId === id1 || candidateId === id2) continue;
                        // Check new distance after swap
                        const newDist1 = Math.abs(pos1.r - r) + Math.abs(pos1.c - c);
                        const newDist2 = Math.abs(pos2.r - r) + Math.abs(pos2.c - c); // id1 stays, id2 goes here; check candidate won't be adjacent to id1
                        if (newDist1 > 1) { // id2 moves to (r,c) which is > 1 away from id1
                            // Also ensure candidate moving to pos2 won't violate other avoid pairs
                            this.layout[r][c] = id2;
                            this.layout[pos2.r][pos2.c] = candidateId;
                            swapped = true;
                        }
                    }
                }
            }
        }

        this.protectExcellentStudentsFromLastRow();
        this.unassigned = students.filter(student => !placed.has(student.id)).map(student => student.id);
        this.refreshConstraintStatus();
        this.saveSnapshot();
        this.renderGrid();
        this.renderPodiumSeats();
        this.updateStatus();
        document.getElementById('sp-export-png').disabled = false;
        document.getElementById('sp-export-excel').disabled = false;
        this.showToast('座位表生成完成!', 'success');
    }

    // ========== AI Floating Chat Bar ==========
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
    }

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
    }

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
    }

    getClampedChatPosition(left, top, width, height) {
        const margin = 12;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        return {
            left: Math.min(Math.max(left, margin), maxLeft),
            top: Math.min(Math.max(top, margin), maxTop),
        };
    }

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
    }

    syncChatPosition() {
        if (!this._chatPosition) return;
        const chat = document.getElementById('sp-chat');
        if (!chat) return;
        const rect = chat.getBoundingClientRect();
        this.setChatPosition(this._chatPosition.left, this._chatPosition.top, rect.width, rect.height);
    }

    suppressChatToggleClick() {
        if (!this._suppressChatToggleClick) return false;
        this._suppressChatToggleClick = false;
        return true;
    }

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
    }

    handleChatIconDragMove(event) {
        if (!this._chatIconDragState) return;
        const state = this._chatIconDragState;
        const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
        if (!state.moved && distance < SeatingPlanner.CHAT_DRAG_THRESHOLD) return;
        state.moved = true;
        const chat = document.getElementById('sp-chat');
        chat?.classList.add('sp-chat--dragging');
        this.setChatPosition(event.clientX - state.offsetX, event.clientY - state.offsetY, state.width, state.height);
        event.preventDefault();
    }

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
    }

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
    }

    handleChatDragMove(event) {
        if (!this._chatDragState) return;
        const { offsetX, offsetY, width, height } = this._chatDragState;
        this.setChatPosition(event.clientX - offsetX, event.clientY - offsetY, width, height);
        event.preventDefault();
    }

    stopChatDrag() {
        if (this._chatDragState) {
            const chat = document.getElementById('sp-chat');
            chat?.classList.remove('sp-chat--dragging');
            this._chatDragState = null;
        }
        window.removeEventListener('pointermove', this._chatPointerMoveHandler);
        window.removeEventListener('pointerup', this._chatPointerUpHandler);
        window.removeEventListener('pointercancel', this._chatPointerUpHandler);
    }

    getSuggestionConfig(kind) {
        if (kind !== 'arrange') return null;
        return { inputId: 'sp-arrange-prompt', listId: 'sp-arrange-completions', target: 'arrange' };
    }

    getSuggestionElements(kind) {
        const config = this.getSuggestionConfig(kind);
        return {
            config,
            input: config ? document.getElementById(config.inputId) : null,
            list: config ? document.getElementById(config.listId) : null
        };
    }

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
    }

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
    }

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
    }

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
            const res = await fetch('/api/tools/seating/suggestions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    isSuggestionOpen(kind) {
        const { list } = this.getSuggestionElements(kind);
        return Boolean(list && !list.classList.contains('sp-hidden'));
    }

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
    }

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
    }

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
    }

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
    }

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
            const res = await fetch('/api/tools/seating/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    history: this._chatHistory.slice(-10), // last 10 messages
                    layout: layoutSnapshot,
                    students: this.students.map(s => ({ id: s.id, name: s.name, gender: s.gender, grade: s.grade })),
                    guardians: this.guardians,
                    rows: this.rows,
                    cols: this.cols,
                    mode: this._chatMode !== 'auto' ? this._chatMode : '',
                })
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
    }

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
    }

    cancelChatPending() {
        const wasArrangement = this._chatPending?.type === 'arrangement';
        this._chatPending = null;
        document.getElementById('sp-chat-confirm').style.display = 'none';
        this.appendChatMessage(wasArrangement ? '已取消重新生成座位表。' : '❌ 已取消', 'ai');
    }

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

    highlightCells(cells) {
        for (const { r, c } of cells) {
            const cell = r === -1
                ? document.getElementById(c === 0 ? 'sp-guardian-left' : 'sp-guardian-right')
                : document.querySelector(`.sp-grid .sp-seat[data-row="${r}"][data-col="${c}"]`);
            if (cell) {
                cell.classList.add('sp-seat--highlight');
                setTimeout(() => cell.classList.remove('sp-seat--highlight'), 2000);
            }
        }
    }

    protectExcellentStudentsFromLastRow() {
        if (this.strategy.gradeStrategy !== 'priority') return 0;
        const usableRows = [];
        for (let r = 0; r < this.rows; r++) {
            if (this.rowAisles.includes(r)) continue;
            const hasSeat = Array.from({ length: this.cols }, (_, c) => c)
                .some(c => !this.colAisles.includes(c) && isLayoutSeat(this.classroomLayout, r, c));
            if (hasSeat) usableRows.push(r);
        }
        const lastRow = usableRows.at(-1);
        if (lastRow === undefined) return 0;

        const studentFor = id => this.studentMap.get(id) || this.students.find(student => student.id === id);
        const topGradeIds = this.getTopGradeStudentIds();
        const isExcellentId = id => this.isTopGradeStudent(studentFor(id), topGradeIds);
        const seatScores = this.calculateSeatScores();
        const seatScore = seat => seatScores[seat.r]?.[seat.c] ?? 0;
        const findEmptySeatBeforeLastRow = () => {
            const seats = [];
            for (const r of usableRows) {
                if (r === lastRow) break;
                for (let c = 0; c < this.cols; c++) {
                    if (this.colAisles.includes(c) || !isLayoutSeat(this.classroomLayout, r, c)) continue;
                    if (!this.layout[r]?.[c]) seats.push({ r, c });
                }
            }
            return this.sortSeatsByScore(seats.map(seat => ({ ...seat, score: seatScore(seat) })))[0] || null;
        };
        const findLowestNonExcellentBeforeLastRow = () => {
            let best = null;
            for (const r of usableRows) {
                if (r === lastRow) break;
                for (let c = 0; c < this.cols; c++) {
                    if (this.colAisles.includes(c) || !isLayoutSeat(this.classroomLayout, r, c)) continue;
                    const id = this.layout[r]?.[c];
                    if (!id || id === '_aisle_' || isExcellentId(id)) continue;
                    const grade = Number(studentFor(id)?.grade);
                    const gradeScore = Number.isFinite(grade) ? grade : Number.POSITIVE_INFINITY;
                    const quality = seatScore({ r, c });
                    if (!best
                        || quality > best.quality
                        || (quality === best.quality && gradeScore < best.gradeScore)
                        || (quality === best.quality && gradeScore === best.gradeScore && (r > best.r || (r === best.r && c > best.c)))) {
                        best = { r, c, id, gradeScore, quality };
                    }
                }
            }
            return best;
        };

        const excellentLastRowSeats = [];
        for (let c = 0; c < this.cols; c++) {
            const id = this.layout[lastRow]?.[c];
            if (id && id !== '_aisle_' && isExcellentId(id)) excellentLastRowSeats.push({ r: lastRow, c, id });
        }
        excellentLastRowSeats.sort((a, b) => (Number(studentFor(b.id)?.grade) || 0) - (Number(studentFor(a.id)?.grade) || 0));

        let moved = 0;
        for (const seat of excellentLastRowSeats) {
            if (this.layout[seat.r]?.[seat.c] !== seat.id || !isExcellentId(seat.id)) continue;
            const emptySeat = findEmptySeatBeforeLastRow();
            if (emptySeat) {
                this.layout[emptySeat.r][emptySeat.c] = seat.id;
                this.layout[seat.r][seat.c] = null;
                moved++;
                continue;
            }
            const swapCandidate = findLowestNonExcellentBeforeLastRow();
            if (!swapCandidate) continue;
            this.layout[swapCandidate.r][swapCandidate.c] = seat.id;
            this.layout[seat.r][seat.c] = swapCandidate.id;
            moved++;
        }
        return moved;
    }

    _findPos(id) {
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                if (this.layout[r][c] === id) return { r, c };
            }
        }
        return null;
    }

    refreshConstraintStatus() {
        this._constraintEvaluation = evaluateSeatingConstraints({
            layout: this.layout,
            students: this.students,
            constraints: this.constraints,
            rows: this.rows,
            cols: this.cols,
            rowAisles: this.rowAisles,
            localAisles: this.classroomLayout?.localAisles,
        });
        this.unsatisfied = this._constraintEvaluation.unsatisfied;
        this._qualityEvaluation = evaluateSeatingQuality({
            layout: this.layout,
            students: this.students,
            constraints: this.constraints,
            classroomLayout: this.classroomLayout,
            guardians: this.guardians,
            unassigned: this.unassigned,
            strategy: this.strategy,
            rows: this.rows,
            cols: this.cols,
            rowAisles: this.rowAisles,
            colAisles: this.colAisles,
            localAisles: this.classroomLayout?.localAisles,
        });
        return this._constraintEvaluation;
    }

    renderSeatDetailsToggle() {
        const statusRight = document.querySelector('#sp-status .sp-status-right');
        if (!statusRight) return;

        if (this.arrangementInterpretation || this.arrangementStats) {
            const explainButton = document.createElement('button');
            explainButton.type = 'button';
            explainButton.id = 'sp-toggle-arrangement-explain';
            explainButton.className = 'sp-icon-btn sp-seat-details-toggle';
            explainButton.title = this.showArrangementExplain ? '隐藏需求理解与优化说明' : '显示需求理解与优化说明';
            explainButton.setAttribute('aria-label', explainButton.title);
            explainButton.setAttribute('aria-pressed', String(this.showArrangementExplain));
            explainButton.innerHTML = '<i data-lucide="info"></i>';
            statusRight.appendChild(explainButton);
        }

        const scoreButton = document.createElement('button');
        scoreButton.type = 'button';
        scoreButton.id = 'sp-toggle-score-analysis';
        scoreButton.className = 'sp-icon-btn sp-seat-details-toggle';
        scoreButton.title = this.showScoreAnalysis ? '隐藏评分分析' : '显示评分分析';
        scoreButton.setAttribute('aria-label', scoreButton.title);
        scoreButton.setAttribute('aria-pressed', String(this.showScoreAnalysis));
        scoreButton.innerHTML = '<i data-lucide="clipboard-check"></i>';
        statusRight.appendChild(scoreButton);

        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'sp-toggle-seat-details';
        button.className = 'sp-icon-btn sp-seat-details-toggle';
        button.title = this.showSeatDetails ? '隐藏成绩和身高' : '显示成绩和身高';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', String(this.showSeatDetails));
        button.innerHTML = `<i data-lucide="${this.showSeatDetails ? 'eye-off' : 'eye'}"></i>`;
        statusRight.appendChild(button);
    }

    scoreStudentName(id) {
        return this.studentMap.get(id)?.name || id || '未知学生';
    }

    formatScoreMatchDetail(issue, match) {
        const names = (match.studentIds || []).map(id => this.scoreStudentName(id)).filter(Boolean);
        const subject = names.length ? names.join('、') : (match.text || '相关座位');
        const reason = match.reason || match.actual || issue.message || issue.name;
        if (match.expected && match.actual && match.expected !== match.actual) {
            return `${subject}：应${match.expected}，当前${match.actual}`;
        }
        return `${subject}：${reason}`;
    }

    renderArrangementExplainPanel() {
        const panel = document.getElementById('sp-arrangement-explain');
        if (!panel) return;

        panel.replaceChildren();
        if (!this.showArrangementExplain) {
            panel.classList.add('sp-hidden');
            return;
        }

        const interpretation = this.arrangementInterpretation || {};
        const stats = this.arrangementStats || {};
        const layoutFacts = interpretation.layoutFacts || {};
        const solverFacts = interpretation.solverFacts || {};
        panel.classList.remove('sp-hidden');

        const header = document.createElement('div');
        header.className = 'sp-arrangement-explain-header';
        const title = document.createElement('strong');
        title.textContent = '需求理解';
        const confidence = document.createElement('span');
        confidence.textContent = interpretation.confidence ? `置信度：${interpretation.confidence}` : '';
        header.append(title, confidence);
        panel.appendChild(header);

        const summary = document.createElement('p');
        summary.className = 'sp-arrangement-explain-summary';
        summary.textContent = interpretation.summary || '已根据排座要求生成布局。';
        panel.appendChild(summary);

        const grid = document.createElement('div');
        grid.className = 'sp-arrangement-explain-grid';
        const rows = [
            ['布局', layoutFacts.groupsPerRow
                ? `${Math.ceil((stats.studentCount || this.students.length || 0) / Math.max(1, (layoutFacts.groupsPerRow || 1) * (layoutFacts.groupSize || 1)))} 排 × ${layoutFacts.groupsPerRow} 组 × ${layoutFacts.groupSize} 座`
                : `${layoutFacts.rows || this.rows} 排 × ${layoutFacts.physicalCols || layoutFacts.cols || this.cols} 列`],
            ['过道', layoutFacts.verticalBetweenGroups ? '组间竖过道' : '无组间竖过道'],
            ['优化', solverFacts.used ? 'Timefold Solver' : '本地排座'],
            ['说明', 'Timefold 负责学生分配，不改变布局列数'],
        ];
        if (solverFacts.used || stats.solverUsed) {
            rows.push(['分数', `硬约束 ${stats.hardScore ?? solverFacts.hardScore ?? 0} · 软分数 ${stats.softScore ?? solverFacts.softScore ?? 0}`]);
            if (Number.isFinite(Number(stats.durationMs ?? solverFacts.durationMs))) {
                rows.push(['用时', `${stats.durationMs ?? solverFacts.durationMs} ms`]);
            }
        } else if (stats.fallbackReason || solverFacts.fallbackReason) {
            rows.push(['回退', stats.fallbackReason || solverFacts.fallbackReason]);
        }
        for (const [label, value] of rows) {
            const item = document.createElement('div');
            item.className = 'sp-arrangement-explain-item';
            const name = document.createElement('span');
            name.textContent = label;
            const detail = document.createElement('strong');
            detail.textContent = String(value || '-');
            item.append(name, detail);
            grid.appendChild(item);
        }
        panel.appendChild(grid);

        const assumptions = Array.isArray(interpretation.assumptions)
            ? interpretation.assumptions.filter(Boolean)
            : [];
        if (assumptions.length) {
            const note = document.createElement('div');
            note.className = 'sp-arrangement-explain-note';
            note.textContent = `自动推断：${assumptions.join('；')}`;
            panel.appendChild(note);
        }
    }

    renderScoreAnalysisPanel() {
        const panel = document.getElementById('sp-score-analysis');
        if (!panel) return;

        panel.replaceChildren();
        if (!this.showScoreAnalysis) {
            panel.classList.add('sp-hidden');
            return;
        }

        const quality = this._qualityEvaluation || {};
        const issues = Array.isArray(quality.constraints)
            ? quality.constraints.filter(item => item.matches?.length)
            : [];
        this._scoreIssueMap = issues;
        panel.classList.remove('sp-hidden');

        const header = document.createElement('div');
        header.className = 'sp-score-analysis-header';
        const title = document.createElement('strong');
        title.textContent = `评分 ${quality.percent ?? 100} · ${quality.feasible ? '可行' : '需调整'}`;
        const meta = document.createElement('span');
        meta.textContent = `硬约束 ${quality.hardViolationCount || 0} 项 · 软约束 ${quality.softViolationCount || 0} 项`;
        header.append(title, meta);
        panel.appendChild(header);

        if (!issues.length) {
            const empty = document.createElement('div');
            empty.className = 'sp-score-analysis-empty';
            empty.textContent = '当前座位表没有明显扣分项。';
            panel.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.className = 'sp-score-analysis-list';
        issues.forEach((issue, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = `sp-score-analysis-item sp-score-analysis-item--${issue.level === 'hard' ? 'hard' : 'soft'}`;
            item.addEventListener('click', () => this.highlightScoreIssue(index));

            const main = document.createElement('span');
            main.className = 'sp-score-analysis-main';
            main.textContent = issue.name;
            const detail = document.createElement('span');
            detail.className = 'sp-score-analysis-detail';
            detail.textContent = issue.message || `${issue.matches.length} 项扣分`;
            const score = document.createElement('span');
            score.className = 'sp-score-analysis-score';
            score.textContent = String(issue.score);

            const matchList = document.createElement('span');
            matchList.className = 'sp-score-analysis-matches';
            issue.matches.forEach(match => {
                const matchLine = document.createElement('span');
                matchLine.className = 'sp-score-analysis-match';
                matchLine.textContent = this.formatScoreMatchDetail(issue, match);
                matchList.appendChild(matchLine);
            });

            item.append(main, detail, matchList, score);
            list.appendChild(item);
        });
        panel.appendChild(list);
    }

    highlightScoreIssue(index) {
        const issue = this._scoreIssueMap?.[index];
        if (!issue) return;
        const cells = issue.involvedCells?.length
            ? issue.involvedCells
            : (issue.involvedStudentIds || []).map(id => this._findPos(id)).filter(Boolean);
        if (!cells.length) {
            this.showToast('这个评分项没有可高亮的网格座位', 'info');
            return;
        }
        this.highlightCells(cells);
    }

    updateStatus() {
        const status = document.getElementById('sp-status');
        if (!status) return;
        this.refreshConstraintStatus();
        const evaluation = this._constraintEvaluation;
        const quality = this._qualityEvaluation;
        const capacity = getClassroomCapacity(this.classroomLayout);
        const guardianPlacedCount = this.classroomLayout?.guardians?.enabled
            ? this.guardians.filter(Boolean).length
            : 0;
        const placedCount = getPlacedStudentIds(this.layout, {
            rows: this.rows,
            cols: this.cols,
            rowAisles: this.rowAisles,
            colAisles: this.colAisles
        }).length + guardianPlacedCount;
        const unplacedCount = Math.max(this.unassigned.length, this.students.length - placedCount, 0);
        const layoutName = this.layoutTemplateLabel(this.classroomLayout?.template || 'standard');
        const guardianText = this.classroomLayout?.guardians?.enabled ? '护法已启用' : '护法关闭';
        const appliedStrategies = Array.isArray(this.arrangementStats?.appliedStrategies)
            ? this.arrangementStats.appliedStrategies.filter(Boolean)
            : [];
        const sourceLabel = this.arrangementSource === 'timefold_solver'
            ? 'Timefold 优化'
            : (this.arrangementSource ? '本地排座' : '');
        const sourceIcon = this.arrangementSource === 'timefold_solver' ? 'cpu' : 'shuffle';
        let html = `
            <div class="sp-status-left">
                <span class="sp-status-item ${quality.feasible ? 'sp-status-item--success' : 'sp-status-item--warning'}">
                    <i data-lucide="${quality.feasible ? 'badge-check' : 'alert-triangle'}"></i>
                    评分 ${quality.percent} · ${quality.feasible ? '可行' : '需调整'}
                </span>
                ${sourceLabel ? `
                <span class="sp-status-item sp-status-item--solver">
                    <i data-lucide="${sourceIcon}"></i>
                    ${sourceLabel}
                </span>` : ''}
                <span class="sp-status-item sp-status-item--success">
                    <i data-lucide="check-circle"></i>
                    满足 ${evaluation.satisfied}/${evaluation.total} 需求
                </span>
                <span class="sp-status-item">
                    <i data-lucide="layout-grid"></i>
                    ${layoutName} · 可用 ${capacity}/${this.students.length || 0} · ${guardianText}
                </span>
        `;

        if (!quality.feasible && quality.hardViolationCount > 0) {
            html += `
                <span class="sp-status-item sp-status-item--warning">
                    <i data-lucide="shield-alert"></i>
                    硬约束 ${quality.hardViolationCount} 项
                </span>
            `;
        }

        if (appliedStrategies.length) {
            html += `
                <span class="sp-status-item">
                    <i data-lucide="sliders-horizontal"></i>
                    已应用：${appliedStrategies.join('、')}
                </span>
            `;
        }

        if (this.unsatisfied.length > 0) {
            html += `
                <span class="sp-status-item sp-status-item--warning">
                    <i data-lucide="alert-triangle"></i>
                    ${this.unsatisfied[0].target}: ${this.unsatisfied[0].reason}
                </span>
            `;
        }

        if (unplacedCount > 0) {
            html += `
                <span class="sp-status-item sp-status-item--warning">
                    <i data-lucide="users"></i>
                    ${unplacedCount} 名学生未安排（可用座位 ${capacity} 个）
                </span>
            `;
        }

        html += '</div><div class="sp-status-right"></div>';
        status.innerHTML = sanitizeHtml(html);
        const solverStatus = status.querySelector('.sp-status-item--solver');
        if (solverStatus) {
            solverStatus.setAttribute('role', 'button');
            solverStatus.setAttribute('tabindex', '0');
            solverStatus.setAttribute('aria-pressed', String(this.showArrangementExplain));
            solverStatus.addEventListener('click', () => {
                this.showArrangementExplain = !this.showArrangementExplain;
                this.updateStatus();
            });
            solverStatus.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.showArrangementExplain = !this.showArrangementExplain;
                    this.updateStatus();
                }
            });
        }
        this.renderSeatDetailsToggle();
        this.renderArrangementExplainPanel();
        this.renderScoreAnalysisPanel();
        if (window.lucide) window.lucide.createIcons();
    }

    // ========== Exports ==========
    suppressHtml2CanvasAmdRegistration() {
        const amdDefine = window.define;
        if (typeof amdDefine !== 'function' || !amdDefine.amd) return () => {};

        const previousAmd = amdDefine.amd;
        try {
            amdDefine.amd = undefined;
        } catch (error) {
            return () => {};
        }

        return () => {
            try {
                amdDefine.amd = previousAmd;
            } catch (error) {
                // Monaco owns the AMD loader; failing to restore should not block export retry handling.
            }
        };
    }

    async ensureHtml2Canvas() {
        if (typeof window.html2canvas === 'function') return window.html2canvas;

        const loadScript = (retry = false) => new Promise((resolve, reject) => {
            const restoreAmd = this.suppressHtml2CanvasAmdRegistration();
            let done = false;
            let timer = null;
            const finish = callback => {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                restoreAmd();
                callback();
            };
            let script = document.querySelector('script[data-html2canvas-loader]');
            if (retry && script) {
                script.remove();
                script = null;
            }
            let shouldAppend = false;
            if (!script) {
                script = document.createElement('script');
                script.src = `/js/libs/html2canvas.min.js${retry ? '?html2canvas-retry=1' : ''}`;
                script.dataset.html2canvasLoader = 'true';
                script.async = true;
                shouldAppend = true;
            }
            if (typeof window.html2canvas === 'function') {
                finish(resolve);
                return;
            }
            if (script.dataset.loaded === 'true') {
                finish(resolve);
                return;
            }
            timer = setTimeout(() => {
                script.remove();
                finish(() => reject(new Error('html2canvas load timed out')));
            }, 5000);
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                finish(resolve);
            }, { once: true });
            script.addEventListener('error', () => {
                script.dataset.failed = 'true';
                finish(() => reject(new Error('本地图片导出组件加载失败')));
            }, { once: true });
            if (shouldAppend) document.head.appendChild(script);
        });

        let firstError = null;
        try {
            await loadScript(false);
        } catch (error) {
            firstError = error;
        }
        if (typeof window.html2canvas !== 'function') {
            try {
                await loadScript(true);
            } catch (error) {
                throw firstError || error;
            }
        }

        if (typeof window.html2canvas !== 'function') {
            throw new Error('本地图片导出组件已加载，但没有注册 window.html2canvas，请刷新后重试');
        }
        return window.html2canvas;
    }

    async ensureHtml2CanvasLegacy() {
        let script = document.querySelector('script[data-html2canvas-loader]');
        if (!script) {
            script = document.createElement('script');
            script.src = '/js/libs/html2canvas.min.js';
            script.dataset.html2canvasLoader = 'true';
            script.async = true;
            document.head.appendChild(script);
        }

        await new Promise((resolve, reject) => {
            if (typeof window.html2canvas === 'function' || script.dataset.loaded === 'true') {
                resolve();
                return;
            }
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                resolve();
            }, { once: true });
            script.addEventListener('error', () => reject(new Error('本地图片导出组件加载失败')), { once: true });
        });

        if (typeof window.html2canvas !== 'function') {
            throw new Error('本地图片导出组件不可用，请刷新后重试');
        }
        return window.html2canvas;
    }

    setExportMode(active) {
        document.querySelectorAll('.sp-aisle-gap-layer, .sp-chat, .sp-context-menu, .sp-seat-tooltip')
            .forEach(element => element.classList.toggle('sp-export-hide', Boolean(active)));
    }

    async exportPNG() {
        try {
            const html2canvas = await this.ensureHtml2Canvas();
            const target = document.querySelector('.sp-classroom-view');
            if (!target) throw new Error('没有可导出的座位图');
            const isLightMode = document.body.classList.contains('light-mode');
            this.setExportMode(true);
            await new Promise(resolve => requestAnimationFrame(resolve));
            const canvas = await html2canvas(target, {
                backgroundColor: isLightMode ? '#f8fafc' : '#0f172a',
                scale: 2,
                useCORS: true,
            });
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.png`;
            link.href = canvas.toDataURL();
            link.click();
            this.showToast('图片已下载', 'success');
        } catch (err) {
            this.recordDiagnosticEvent('export_png_failed', {
                error: err.message || 'export_png_failed',
            });
            this.showToast('导出失败: ' + err.message, 'error');
        } finally {
            this.setExportMode(false);
        }
    }

    exportSnapshot() {
        return {
            rows: this.rows,
            cols: this.cols,
            layout: this.layout.map(row => row.map(value => value || null)),
            classroomLayout: structuredClone(this.classroomLayout),
            localAisles: normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols),
            guardians: [...this.guardians],
            students: this.students.map(student => ({
                id: student.id,
                name: student.name,
                gender: student.gender,
                grade: student.grade,
                height: student.height,
            })),
        };
    }

    openFeedbackDialog() {
        const dialog = document.getElementById('sp-feedback-dialog');
        if (!dialog) return;
        dialog.classList.remove('sp-hidden');
        document.getElementById('sp-feedback-message')?.focus();
        if (window.lucide) window.lucide.createIcons();
    }

    closeFeedbackDialog() {
        const dialog = document.getElementById('sp-feedback-dialog');
        if (!dialog) return;
        dialog.classList.add('sp-hidden');
    }

    getFeedbackSelection(group, fallback) {
        return document.querySelector(`[data-feedback-group="${group}"] .sp-feedback-chip.is-active`)?.dataset.value || fallback;
    }

    makeFeedbackAnonymizer() {
        const idToAnon = new Map();
        const nameToAnon = new Map();
        this.students.forEach((student, index) => {
            const anonId = `stu_${String(index + 1).padStart(3, '0')}`;
            if (student.id) idToAnon.set(String(student.id), anonId);
            if (student.name) nameToAnon.set(String(student.name), anonId);
        });
        return { idToAnon, nameToAnon };
    }

    anonymizeFeedbackText(value, anonymizer = this.makeFeedbackAnonymizer()) {
        let text = String(value ?? '');
        const names = Array.from(anonymizer.nameToAnon.entries())
            .filter(([name]) => name)
            .sort((a, b) => b[0].length - a[0].length);
        for (const [name, anonId] of names) {
            text = text.split(name).join(anonId);
        }
        return text;
    }

    isDiagnosticSensitiveKey(key) {
        return /(api[_-]?key|authorization|bearer|token|jwt|secret|password|passwd|smtp[_-]?(pass|password)|auth(code)?|credential)/i
            .test(String(key ?? ''));
    }

    redactDiagnosticText(value, maxLength = 1000) {
        let text = String(value ?? '');
        text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
        text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]');
        text = text.replace(
            /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASS|AUTHORIZATION|JWT|SMTP[_-]?PASS)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'",\s;]+/gi,
            '$1=[REDACTED]'
        );
        text = text.replace(
            /\b((?:smtp|api|bearer|authorization|token|secret|password|pass|auth|授权码)\s*(?:key|pass|password|token|code|secret|授权码)?)\s*[:= ]+\s*['"]?[A-Za-z0-9._~+/-]{8,}/gi,
            '$1 [REDACTED]'
        );
        text = text.replace(/\b(?=[A-Za-z0-9._~+/-]*[A-Za-z])(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{24,}\b/g, '[REDACTED]');
        return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
    }

    anonymizeFeedbackValue(value, anonymizer) {
        if (value == null) return value;
        if (typeof value === 'string') {
            if (anonymizer.idToAnon.has(value)) return anonymizer.idToAnon.get(value);
            return this.redactDiagnosticText(this.anonymizeFeedbackText(value, anonymizer));
        }
        if (Array.isArray(value)) return value.map(item => this.anonymizeFeedbackValue(item, anonymizer));
        if (typeof value === 'object') {
            const result = {};
            for (const [key, item] of Object.entries(value)) {
                if (key === 'name' || key === 'studentName') continue;
                if (this.isDiagnosticSensitiveKey(key)) {
                    result[key] = '[REDACTED]';
                    continue;
                }
                result[key] = this.anonymizeFeedbackValue(item, anonymizer);
            }
            return result;
        }
        return value;
    }

    recordDiagnosticEvent(type, detail = {}) {
        const anonymizer = this.makeFeedbackAnonymizer();
        const event = {
            at: new Date().toISOString(),
            type: this.redactDiagnosticText(type, 80),
            detail: this.anonymizeFeedbackValue(detail, anonymizer),
        };
        this._diagnosticEvents = [...(this._diagnosticEvents || []), event].slice(-20);
        if (/error|fail|failed|warning|noop|rejected/i.test(String(type))) {
            this._lastErrors = [...(this._lastErrors || []), event].slice(-10);
        }
        return event;
    }

    async loadBackendDiagnostics() {
        try {
            const response = await fetch('/api/tools/seating/diagnostics', { method: 'GET' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) throw new Error(result.error || 'diagnostics_request_failed');
            return this.anonymizeFeedbackValue(result.data || {}, this.makeFeedbackAnonymizer());
        } catch (error) {
            return {
                available: false,
                error: 'diagnostics_request_failed',
                message: this.redactDiagnosticText(error.message || 'diagnostics_request_failed', 300),
            };
        }
    }

    toFeedbackBand(value, step = 10) {
        const number = Number(value);
        if (!Number.isFinite(number)) return 'unknown';
        const start = Math.floor(number / step) * step;
        return `${start}-${start + step - 1}`;
    }

    buildFeedbackSnapshot() {
        const anonymizer = this.makeFeedbackAnonymizer();
        const arrangePrompt = typeof document !== 'undefined'
            ? document.getElementById('sp-arrange-prompt')?.value?.trim() || ''
            : '';
        const quality = this._qualityEvaluation || {};
        const constraintEvaluation = this._constraintEvaluation || {};
        const availableSeats = getClassroomCapacity(this.classroomLayout);
        const assignedCount = new Set(getPlacedStudentIds(this.layout)).size + this.guardians.filter(Boolean).length;
        const win = typeof window !== 'undefined' ? window : null;

        const snapshot = {
            version: 2,
            diagnosticsVersion: 2,
            rows: this.rows,
            cols: this.cols,
            strategy: structuredClone(this.strategy || {}),
            arrangePrompt: this.anonymizeFeedbackText(arrangePrompt, anonymizer),
            students: this.students.map(student => ({
                anonId: anonymizer.idToAnon.get(String(student.id)),
                gender: student.gender || 'unknown',
                gradeBand: this.toFeedbackBand(student.grade),
                heightBand: this.toFeedbackBand(student.height),
            })),
            layout: this.layout.map(row => row.map(value => this.anonymizeFeedbackValue(value || null, anonymizer))),
            guardians: {
                left: this.anonymizeFeedbackValue(this.guardians?.[0] || null, anonymizer),
                right: this.anonymizeFeedbackValue(this.guardians?.[1] || null, anonymizer),
                enabled: Boolean(this.classroomLayout?.guardians?.enabled || this.guardians?.[0] || this.guardians?.[1]),
            },
            classroomLayout: {
                rows: this.classroomLayout?.rows || this.rows,
                cols: this.classroomLayout?.cols || this.cols,
                template: this.classroomLayout?.template || 'standard',
                groupSize: this.classroomLayout?.groupSize || 1,
                localAisles: normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols),
            },
            rowAisles: [...(this.rowAisles || [])],
            colAisles: [...(this.colAisles || [])],
            constraints: this.anonymizeFeedbackValue(this.constraints || [], anonymizer),
            unsatisfied: this.anonymizeFeedbackValue(this.unsatisfied || [], anonymizer),
            unassigned: this.anonymizeFeedbackValue(this.unassigned || [], anonymizer),
            arrangementSource: this.arrangementSource || null,
            arrangementSpec: this.anonymizeFeedbackValue(this.arrangementSpec || null, anonymizer),
            arrangementStats: this.anonymizeFeedbackValue(this.arrangementStats || null, anonymizer),
            arrangementInterpretation: this.anonymizeFeedbackValue(this.arrangementInterpretation || null, anonymizer),
            diagnostics: {
                page: {
                    tool: 'seating',
                    version: 2,
                    url: win?.location?.href || '',
                    theme: typeof document !== 'undefined' && document.body?.classList?.contains('light-mode') ? 'light' : 'dark',
                    width: win?.innerWidth || 0,
                    height: win?.innerHeight || 0,
                    userAgent: this.redactDiagnosticText(win?.navigator?.userAgent || '', 500),
                    capturedAt: new Date().toISOString(),
                },
                seatingState: {
                    rows: this.rows,
                    cols: this.cols,
                    availableSeats,
                    assignedCount,
                    unassignedCount: this.unassigned?.length || 0,
                    guardianEnabled: Boolean(this.classroomLayout?.guardians?.enabled || this.guardians?.some(Boolean)),
                    rowAisles: [...(this.rowAisles || [])],
                    colAisles: [...(this.colAisles || [])],
                    localAisles: normalizeLocalAisles(this.classroomLayout?.localAisles, this.rows, this.cols),
                },
                arrangement: {
                    source: this.arrangementSource || null,
                    spec: this.anonymizeFeedbackValue(this.arrangementSpec || null, anonymizer),
                    stats: this.anonymizeFeedbackValue(this.arrangementStats || null, anonymizer),
                    interpretation: this.anonymizeFeedbackValue(this.arrangementInterpretation || null, anonymizer),
                },
                scoring: {
                    quality: this.anonymizeFeedbackValue(quality, anonymizer),
                    constraints: this.anonymizeFeedbackValue(constraintEvaluation, anonymizer),
                },
            },
            diagnosticEvents: this.anonymizeFeedbackValue(this._diagnosticEvents || [], anonymizer),
            lastErrors: this.anonymizeFeedbackValue(this._lastErrors || [], anonymizer),
            quality: {
                feasible: Boolean(quality.feasible),
                percent: quality.percent,
                label: quality.label,
                hardScore: quality.hardScore,
                softScore: quality.softScore,
                hardViolationCount: quality.hardViolationCount,
                softViolationCount: quality.softViolationCount,
                topIssues: this.anonymizeFeedbackValue(quality.topIssues || [], anonymizer),
            },
            anonymizer,
        };
        return snapshot;
    }

    async buildFeedbackPayload() {
        const snapshot = this.buildFeedbackSnapshot();
        const { anonymizer, ...safeSnapshot } = snapshot;
        safeSnapshot.backendDiagnostics = await this.loadBackendDiagnostics();
        const message = document.getElementById('sp-feedback-message')?.value?.trim() || '';
        const expected = document.getElementById('sp-feedback-expected')?.value?.trim() || '';
        const win = typeof window !== 'undefined' ? window : null;
        return {
            message: this.redactDiagnosticText(this.anonymizeFeedbackText(message, anonymizer), 2000),
            expected: this.redactDiagnosticText(this.anonymizeFeedbackText(expected, anonymizer), 1000),
            category: this.getFeedbackSelection('category', 'other'),
            severity: this.getFeedbackSelection('severity', 'workaround'),
            snapshot: safeSnapshot,
            client: {
                url: win?.location?.href || '',
                width: win?.innerWidth || 0,
                height: win?.innerHeight || 0,
                theme: document.body?.classList?.contains('light-mode') ? 'light' : 'dark',
                sentAt: new Date().toISOString(),
            },
        };
    }

    async submitFeedback() {
        const button = document.getElementById('sp-feedback-submit');
        const message = document.getElementById('sp-feedback-message')?.value?.trim() || '';
        if (message.length < 5) {
            this.showToast('请至少写 5 个字，方便我们复现问题', 'warning');
            return;
        }

        const originalHtml = button?.innerHTML;
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 提交中';
            if (window.lucide) window.lucide.createIcons();
        }

        try {
            const response = await fetch('/api/tools/seating/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(await this.buildFeedbackPayload()),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.success) {
                throw new Error(result.error || '反馈提交失败');
            }
            const id = result.data?.id || '已记录';
            this.closeFeedbackDialog();
            const messageInput = document.getElementById('sp-feedback-message');
            const expectedInput = document.getElementById('sp-feedback-expected');
            if (messageInput) messageInput.value = '';
            if (expectedInput) expectedInput.value = '';
            this.showToast(`反馈已提交：${id}`, 'success');
        } catch (error) {
            this.showToast(error.message || '反馈提交失败，请稍后再试', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = originalHtml;
                if (window.lucide) window.lucide.createIcons();
            }
        }
    }

    async exportXLSX() {
        try {
            const res = await fetch('/api/tools/seating/export-xlsx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.exportSnapshot()),
            });
            if (!res.ok) {
                const error = await res.json().catch(() => ({}));
                throw new Error(error.error || '导出服务暂时不可用');
            }
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
                throw new Error('导出服务返回格式错误');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `座位表_${new Date().toISOString().split('T')[0]}.xlsx`;
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            this.showToast('Excel 已下载', 'success');
        } catch (err) {
            this.recordDiagnosticEvent('export_xlsx_failed', {
                error: err.message || 'export_xlsx_failed',
            });
            this.showToast('导出失败: ' + err.message, 'error');
        }
    }

    exportCSV() {
        let csv = '\uFEFF'; // BOM for Excel
        for (let r = 0; r < this.rows; r++) {
            const row = [];
            for (let c = 0; c < this.cols; c++) {
                if (this.colAisles.includes(c) || this.rowAisles.includes(r)) {
                    row.push('');
                } else {
                    const id = this.layout[r]?.[c];
                    const name = this.studentMap.get(id)?.name || '';
                    // Escape names containing commas or quotes for CSV safety
                    row.push(name.includes(',') || name.includes('"') ? `"${name.replace(/"/g, '""')}"` : name);
                }
            }
            csv += row.join(',') + '\n';
        }
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `座位表_${new Date().toISOString().split('T')[0]}.csv`;
        link.href = url;
        link.click();
        // Release Blob URL
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        this.showToast('CSV 已下载', 'success');
    }

    showToast(msg, type = 'info') {
        if (type === 'error' || type === 'warning') {
            this.recordDiagnosticEvent(`toast_${type}`, { message: msg });
        }
        if (window.ICeCream?.showToast) {
            window.ICeCream.showToast(msg, type);
        } else {
            console.log(`[${type.toUpperCase()}] ${msg}`);
        }
    }
}

// Export
const seatingPlanner = new SeatingPlanner();
export function init(container) { seatingPlanner.init(container); }
export default seatingPlanner;
