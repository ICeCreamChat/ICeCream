import { sanitizeHtml } from '../utils/sanitize.js';
import {
    createClassroomLayout,
    getLayoutCapacity as getClassroomCapacity,
    isLayoutSeat,
    layoutToLegacyAisles,
} from './classroom-layout.js';
import {
    colHasStudents,
    deleteAisleColumn,
    deleteAisleRow,
    deleteLocalAisle,
    evaluateSeatingConstraints,
    evaluateSeatingQuality,
    getPlacedStudentIds,
    hasLocalAisle,
    insertAisleColumn,
    insertAisleRow,
    insertLocalAisle,
    normalizeLocalAisles,
    rowHasStudents,
} from './seating-core.js';
import * as seatingApi from './seating-planner/api-client.js';
import { seatingAssistantMethods } from './seating-planner/assistant-panel.js';
import { seatingArrangementDiagramMethods } from './seating-planner/arrangement-diagram-panel.js';
import { seatingExportMethods } from './seating-planner/export-panel.js';
import { seatingFeedbackMethods } from './seating-planner/feedback-panel.js';
import { seatingGridMethods } from './seating-planner/grid-panel.js';
import { seatingLayoutPreviewMethods } from './seating-planner/layout-preview-panel.js';
import { seatingRosterMethods } from './seating-planner/roster-panel.js';
import { seatingSeatDetailMethods } from './seating-planner/seat-detail-panel.js';

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
        this._seatDetailPopover = null;
        this._seatDetailOutsideClickHandler = null;
        this._seatDetailKeyHandler = null;
        this._seatDetailAnchor = null;
        this._seatDetailStudentId = null;
        this._seatDetailScrollTargets = [];
        this._seatDetailScrollHandler = null;
        this._seatDetailResizeHandler = null;
        this._seatDetailSyncFrame = null;
        this._justDragged = false;
        this._dragResetTimer = null;
        this._seatDetailSuppressClickUntil = 0;
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
        this.recognizedArrangement = null;
        this.arrangementPromptSnapshot = '';
        this.arrangementRecognitionStale = false;
        this.arrangementEditorDraft = null;
        this.diagramEdits = [];
        this.pendingLayoutPreview = null;
        this._diagnosticEvents = [];
        this._lastErrors = [];
        this._feedbackScreenshot = null;
        this._feedbackScreenshotPromise = null;
        this._feedbackScreenshotCaptureId = 0;
        this._feedbackScreenshotState = 'idle';
        this._feedbackScreenshotQueuedPrivacyMode = null;
        this._feedbackScreenshotRunning = false;
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
        this.updateLayoutRequirementSummary();
        console.log('[SeatingPlanner] Initialized with new design');
    }

    destroy() {
        document.body?.classList.remove('sp-arrangement-editor-open');
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
        this.hideSeatDetailPopover();
        if (this._dragResetTimer) {
            clearTimeout(this._dragResetTimer);
            this._dragResetTimer = null;
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

    getEscapeDocument() {
        if (this.container?.ownerDocument) return this.container.ownerDocument;
        return typeof document !== 'undefined' ? document : null;
    }

    isEscapeLayerVisible(element) {
        if (!element) return false;
        if (element.classList?.contains('sp-hidden')) return false;
        if (element.style?.display === 'none') return false;
        return true;
    }

    closeRosterBulkPanel() {
        this.getEscapeDocument()?.getElementById?.('sp-roster-bulk-panel')?.classList.add('sp-hidden');
    }

    handleEscape(event) {
        if (event?.key !== 'Escape') return false;
        event.preventDefault?.();
        event.stopPropagation?.();

        const doc = this.getEscapeDocument();
        const byId = id => doc?.getElementById?.(id);
        const feedbackDialog = byId('sp-feedback-dialog');
        const imageReview = byId('sp-image-review');
        const rosterBulkPanel = byId('sp-roster-bulk-panel');
        const layoutPreview = byId('sp-layout-preview-confirm');
        const arrangementEditor = byId('sp-arrangement-editor');
        const contextMenu = byId('sp-context-menu');
        const chat = byId('sp-chat');
        const chatConfirm = byId('sp-chat-confirm');

        if (this.isEscapeLayerVisible(feedbackDialog)) {
            this.closeFeedbackDialog();
            return true;
        }

        if (this.isEscapeLayerVisible(imageReview) && this.isEscapeLayerVisible(rosterBulkPanel)) {
            this.closeRosterBulkPanel();
            return true;
        }

        if (this.isEscapeLayerVisible(imageReview)) {
            this.closeImageReview();
            return true;
        }

        if (this.isSuggestionOpen?.('arrange')) {
            this.hideSuggestions('arrange');
            return true;
        }

        if (arrangementEditor?.classList?.contains('is-open')) {
            this.closeArrangementEditor?.();
            return true;
        }

        if (this.pendingLayoutPreview || this.isEscapeLayerVisible(layoutPreview)) {
            this.cancelLayoutPreview();
            return true;
        }

        if (contextMenu?.classList?.contains('sp-context-menu--visible')) {
            this.hideContextMenu();
            return true;
        }

        if (this._seatDetailPopover || doc?.querySelector?.('.sp-seat-detail-popover')) {
            this.hideSeatDetailPopover();
            return true;
        }

        if (this._chatDragState) {
            this.stopChatDrag();
            return true;
        }

        if (this._chatIconDragState) {
            this.stopChatIconDrag();
            return true;
        }

        if (this._chatPending || this.isEscapeLayerVisible(chatConfirm)) {
            this.cancelChatPending();
            return true;
        }

        if (this._chatExpanded || chat?.classList?.contains('sp-chat--open')) {
            this.toggleChat(false);
            return true;
        }

        if (this.showScoreAnalysis || this.showArrangementExplain) {
            this.showScoreAnalysis = false;
            this.showArrangementExplain = false;
            this.updateStatus();
            return true;
        }

        return true;
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

    getLayoutRequirementSpec() {
        return this.recognizedArrangement?.arrangementSpec
            ? structuredClone(this.recognizedArrangement.arrangementSpec)
            : null;
    }

    updateLayoutRequirementSummary() {
        const target = document.getElementById('sp-layout-requirement-summary');
        if (!target) return;
        if (this.arrangementRecognitionStale) {
            target.textContent = '要求已修改，请重新识别';
        } else if (this.recognizedArrangement?.arrangementSpec?.layoutSpecVersion === 2) {
            target.textContent = '规则已识别，可检查示意图或放大编辑';
        } else {
            target.textContent = '等待 AI 识别自然语言排座要求';
        }
        this.updateArrangementActionState?.();
    }

    updateArrangementActionState() {
        const prompt = this.getArrangePrompt();
        const recognized = Boolean(this.recognizedArrangement?.arrangementSpec) && !this.arrangementRecognitionStale;
        const recognizeButton = document.getElementById('sp-parse-arrangement');
        const generateButton = document.getElementById('sp-generate');
        if (recognizeButton) recognizeButton.disabled = this._isGenerating || !prompt;
        if (generateButton) generateButton.disabled = this._isGenerating || !this.students.length || !recognized || Boolean(this.pendingLayoutPreview);
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

            const res = await seatingApi.fetchSuggestions(payload, { signal: controller.signal });
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

    normalizeLayoutPreview(data) {
        const errors = [];
        const sourceLayout = data?.classroomLayout;
        if (!sourceLayout || !Array.isArray(sourceLayout.cells)) {
            throw new Error('AI 没有返回有效布局预览');
        }
        const rows = Number(sourceLayout.rows || sourceLayout.cells.length);
        const cols = Number(sourceLayout.cols || sourceLayout.cells[0]?.length || 0);
        if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
            throw new Error('AI 返回的布局尺寸不合法');
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
        if (errors.length) throw new Error(errors.join('；'));

        const groups = Array.from({ length: rows }, (_, r) => {
            const groupRow = Array.isArray(sourceLayout.groups?.[r]) ? sourceLayout.groups[r] : [];
            return Array.from({ length: cols }, (_, c) => groupRow[c] ?? null);
        });
        return {
            reply: data.reply || '已生成布局预览',
            classroomLayout: {
                rows,
                cols,
                cells,
                groups,
                guardians: {
                    enabled: Boolean(sourceLayout.guardians?.enabled),
                    left: null,
                    right: null,
                },
                template: sourceLayout.template || 'ai-preview',
                groupSize: sourceLayout.groupSize || 1,
                localAisles: normalizeLocalAisles(sourceLayout.localAisles, rows, cols),
            },
            layoutIntent: data.layoutIntent || null,
            warnings: Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [],
            reasoning: data.reasoning || '',
            source: data.source || null,
            stats: data.stats || null,
            arrangementSpec: data.arrangementSpec || null,
        };
    }

    applyArrangementResult(data, { save = true, preserveLayoutPreview = false } = {}) {
        const arrangement = this.normalizeArrangementForApply(data);
        if (!preserveLayoutPreview) this.cancelLayoutPreview();
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

    async requestLayoutPreview(prompt, options = {}) {
        this.recordDiagnosticEvent('layout_preview_request', {
            prompt,
            studentCount: this.students.length,
            constraintCount: this.constraints.length,
        });
        const arrangementSpec = options.arrangementSpec || this.getLayoutRequirementSpec();
        const res = await seatingApi.fetchLayoutPreview({
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
            ...(arrangementSpec ? { arrangementSpec } : {}),
            diagramEdits: Array.isArray(options.diagramEdits) ? options.diagramEdits : [],
        });
        const result = await res.json().catch(() => ({ success: false, error: 'AI 布局预览返回格式错误' }));
        if (!res.ok || !result.success) {
            this.recordDiagnosticEvent('layout_preview_request_failed', {
                status: res.status,
                error: result.error || 'AI layout preview failed',
            });
            const details = Array.isArray(result.details) && result.details.length ? `：${result.details.join('；')}` : '';
            throw new Error(`${result.error || 'AI 布局预览失败'}${details}`);
        }
        const preview = this.normalizeLayoutPreview(result.data);
        this.recordDiagnosticEvent('layout_preview_request_success', {
            source: preview.source || null,
            stats: preview.stats || null,
            warnings: preview.warnings || [],
        });
        return preview;
    }

    async requestLayoutSpec(prompt) {
        this.recordDiagnosticEvent('layout_spec_request', {
            prompt,
            studentCount: this.students.length,
        });
        const res = await seatingApi.fetchLayoutSpec({
            prompt,
            studentCount: this.students.length,
        });
        const result = await res.json().catch(() => ({ success: false, error: 'AI 规则识别返回格式错误' }));
        if (!res.ok || !result.success || !result.data?.arrangementSpec) {
            throw new Error(result.error || 'AI 规则识别失败');
        }
        return {
            arrangementSpec: structuredClone(result.data.arrangementSpec),
            originalArrangementSpec: structuredClone(result.data.arrangementSpec),
            interpretation: result.data.interpretation || null,
            warnings: Array.isArray(result.data.warnings) ? result.data.warnings.filter(Boolean) : [],
            source: result.data.source || null,
            prompt,
        };
    }

    async requestAiArrangement(prompt, options = {}) {
        this.recordDiagnosticEvent('arrangement_request', {
            prompt,
            studentCount: this.students.length,
            constraintCount: this.constraints.length,
            confirmedLayout: Boolean(options.confirmedLayout),
        });
        const res = await seatingApi.fetchArrangement({
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
            ...(options.confirmedLayout ? { confirmedLayout: options.confirmedLayout } : {}),
            ...(options.arrangementSpec ? { arrangementSpec: options.arrangementSpec } : {}),
            diagramEdits: Array.isArray(options.diagramEdits) ? options.diagramEdits : this.diagramEdits,
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





    // ========== Drag & Drop ==========













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
                            <div id="sp-layout-requirement-summary" class="sp-layout-requirement-summary"></div>
                            <div class="sp-autocomplete-anchor">
                                <textarea id="sp-arrange-prompt" class="sp-arrange-prompt" rows="5" placeholder="用自然语言描述排座方式，例如：两人一组，每组之间设置可通行过道；讲台旁安排左右护法" aria-autocomplete="list" aria-expanded="false" aria-controls="sp-arrange-completions"></textarea>
                                <div id="sp-arrange-completions" class="sp-autocomplete sp-autocomplete--above sp-hidden" role="listbox"></div>
                            </div>
                            <button type="button" id="sp-parse-arrangement" class="sp-btn sp-btn--secondary sp-btn--block">
                                <i data-lucide="scan-search"></i>
                                识别排座要求
                            </button>
                            <div id="sp-arrangement-recognition" class="sp-arrangement-recognition" aria-live="polite">
                                <div class="sp-arrangement-recognition__header">
                                    <span>识别结果</span>
                                    <span id="sp-arrangement-edit-status" class="sp-arrangement-edit-status">尚未识别</span>
                                </div>
                                <div id="sp-arrangement-diagram" class="sp-arrangement-diagram" aria-label="排座要求识别图"></div>
                                <div id="sp-arrangement-rule-facts" class="sp-arrangement-rule-facts"></div>
                                <div class="sp-arrangement-legend" aria-label="规则示意图图例">
                                    <span><i class="sp-rule-legend sp-rule-legend--seat"></i>座位</span>
                                    <span><i class="sp-rule-legend sp-rule-legend--gap"></i>普通间距</span>
                                    <span><i class="sp-rule-legend sp-rule-legend--walkway" data-lucide="person-standing"></i>可通行过道</span>
                                </div>
                                <button type="button" id="sp-arrangement-open-editor" class="sp-btn sp-btn--sm sp-btn--block" disabled>
                                    <i data-lucide="maximize-2"></i>
                                    放大编辑
                                </button>
                            </div>
                        </section>

                        <!-- Generate Button -->
                        <button id="sp-generate" class="sp-btn sp-btn--primary sp-btn--block" disabled>
                            <i data-lucide="layout-grid"></i>
                            生成布局预览
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
                            <div id="sp-layout-preview-confirm" class="sp-canvas-preview-bar sp-hidden" aria-live="polite" aria-label="布局预览待确认">
                                <div class="sp-canvas-preview-copy">
                                    <span class="sp-canvas-preview-badge">布局预览</span>
                                    <div class="sp-layout-preview-legend" aria-label="布局预览图例">
                                        <span><i class="sp-preview-legend sp-preview-legend--seat"></i>座位</span>
                                        <span><i class="sp-preview-legend sp-preview-legend--group"></i>同组</span>
                                        <span><i class="sp-preview-legend sp-preview-legend--gap"></i>间距</span>
                                        <span><i class="sp-preview-legend sp-preview-legend--walkway" data-lucide="person-standing"></i>过道</span>
                                    </div>
                                    <strong id="sp-layout-preview-summary">已生成布局</strong>
                                    <span id="sp-layout-preview-meta">5 排 · 30 组 · 60 座</span>
                                </div>
                                <div class="sp-layout-preview-actions">
                                    <button type="button" class="sp-btn sp-btn--sm" id="sp-layout-preview-edit">
                                        <i data-lucide="arrow-left"></i>
                                        返回修改规则
                                    </button>
                                    <button type="button" class="sp-btn sp-btn--sm sp-btn--primary" id="sp-layout-preview-assign">
                                        <i data-lucide="check"></i>
                                        确认并排学生
                                    </button>
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
                            <div class="sp-status-middle"></div>
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

                <div id="sp-arrangement-editor" class="sp-arrangement-editor" aria-hidden="true">
                    <div class="sp-arrangement-editor__backdrop"></div>
                    <section class="sp-arrangement-editor__dialog" role="dialog" aria-modal="true" aria-labelledby="sp-arrangement-editor-title">
                        <header class="sp-arrangement-editor__header">
                            <div>
                                <h2 id="sp-arrangement-editor-title">编辑排座规则图</h2>
                                <p id="sp-arrangement-editor-facts"></p>
                            </div>
                            <button type="button" id="sp-arrangement-editor-close" class="sp-icon-btn" aria-label="关闭规则图编辑器" title="关闭">
                                <i data-lucide="x"></i>
                            </button>
                        </header>
                        <div class="sp-arrangement-editor__body">
                            <div id="sp-arrangement-editor-diagram" class="sp-arrangement-editor__diagram" aria-label="可编辑排座规则图"></div>
                            <div class="sp-arrangement-editor__controls" aria-label="排座规则选项">
                                <fieldset class="sp-arrangement-mode-group" data-control-target="groupSize">
                                    <legend>每组人数</legend>
                                    <div class="sp-arrangement-mode-buttons sp-arrangement-mode-buttons--four">
                                        <button type="button" data-target="groupSize" data-arrangement-mode="1">1 人</button>
                                        <button type="button" data-target="groupSize" data-arrangement-mode="2">2 人</button>
                                        <button type="button" data-target="groupSize" data-arrangement-mode="3">3 人</button>
                                        <button type="button" data-target="groupSize" data-arrangement-mode="4">4 人</button>
                                    </div>
                                </fieldset>
                                <fieldset class="sp-arrangement-mode-group">
                                    <legend>组间边界</legend>
                                    <div class="sp-arrangement-mode-buttons">
                                        <button type="button" data-target="betweenGroups" data-arrangement-mode="none">无</button>
                                        <button type="button" data-target="betweenGroups" data-arrangement-mode="gap">普通间距</button>
                                        <button type="button" data-target="betweenGroups" data-arrangement-mode="walkway">可通行过道</button>
                                    </div>
                                </fieldset>
                                <fieldset class="sp-arrangement-mode-group">
                                    <legend>排间边界</legend>
                                    <div class="sp-arrangement-mode-buttons">
                                        <button type="button" data-target="betweenRows" data-arrangement-mode="none">无</button>
                                        <button type="button" data-target="betweenRows" data-arrangement-mode="gap">普通间距</button>
                                        <button type="button" data-target="betweenRows" data-arrangement-mode="walkway">可通行过道</button>
                                    </div>
                                </fieldset>
                                <fieldset class="sp-arrangement-mode-group">
                                    <legend>主过道</legend>
                                    <div class="sp-arrangement-mode-buttons sp-arrangement-mode-buttons--four">
                                        <button type="button" data-target="mainAisle" data-arrangement-mode="none">无</button>
                                        <button type="button" data-target="mainAisle" data-arrangement-mode="vertical">竖向</button>
                                        <button type="button" data-target="mainAisle" data-arrangement-mode="horizontal">横向</button>
                                        <button type="button" data-target="mainAisle" data-arrangement-mode="cross">十字</button>
                                    </div>
                                </fieldset>
                            </div>
                        </div>
                        <footer class="sp-arrangement-editor__footer">
                            <button type="button" id="sp-arrangement-editor-cancel" class="sp-btn sp-btn--sm">取消</button>
                            <button type="button" id="sp-arrangement-restore-ai" class="sp-btn sp-btn--sm">
                                <i data-lucide="rotate-ccw"></i>
                                恢复 AI 识别
                            </button>
                            <button type="button" id="sp-arrangement-apply" class="sp-btn sp-btn--sm sp-btn--primary">
                                <i data-lucide="check"></i>
                                应用修改
                            </button>
                        </footer>
                    </section>
                </div>

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
                            <div class="sp-feedback-field sp-feedback-screenshot">
                                <div class="sp-feedback-screenshot-head">
                                    <span class="sp-feedback-label">前端截图</span>
                                    <label class="sp-feedback-screenshot-toggle" for="sp-feedback-screenshot-redact">
                                        <input type="checkbox" id="sp-feedback-screenshot-redact" checked>
                                        <span>遮挡学生姓名和详情</span>
                                    </label>
                                </div>
                                <div class="sp-feedback-screenshot-preview" id="sp-feedback-screenshot-preview" aria-live="polite">
                                    <span class="sp-feedback-screenshot-placeholder">打开反馈后会自动截图</span>
                                </div>
                                <div class="sp-feedback-screenshot-actions">
                                    <span class="sp-feedback-screenshot-status" id="sp-feedback-screenshot-status">等待截图</span>
                                    <button type="button" class="sp-btn sp-btn--sm sp-feedback-screenshot-recapture" id="sp-feedback-screenshot-recapture">
                                        <i data-lucide="camera"></i>
                                        重新截图
                                    </button>
                                    <button type="button" class="sp-btn sp-btn--sm sp-feedback-screenshot-fallback" id="sp-feedback-screenshot-fallback" title="自动快照可能不完全一致">
                                        <i data-lucide="image"></i>
                                        自动快照（可能不完全一致）
                                    </button>
                                </div>
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
        $('sp-feedback-screenshot-recapture')?.addEventListener('click', () => this.captureFeedbackScreenshot({
            privacyMode: this.getFeedbackScreenshotPrivacyMode(),
            mode: 'screen',
            hideDialog: true,
        }));
        $('sp-feedback-screenshot-fallback')?.addEventListener('click', () => this.captureFeedbackScreenshot({
            privacyMode: this.getFeedbackScreenshotPrivacyMode(),
            mode: 'dom-fallback',
            hideDialog: false,
        }));
        $('sp-feedback-screenshot-redact')?.addEventListener('change', () => this.captureFeedbackScreenshot({
            privacyMode: this.getFeedbackScreenshotPrivacyMode(),
            mode: 'screen',
            hideDialog: true,
        }));
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
            this.cancelLayoutPreview();
            this.clearArrangementRecognition?.();
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
        $('sp-parse-arrangement')?.addEventListener('click', () => this.recognizeArrangementRequirements?.());
        $('sp-layout-preview-assign')?.addEventListener('click', () => this.confirmLayoutPreview());
        $('sp-layout-preview-edit')?.addEventListener('click', () => this.returnToArrangementEditor?.());
        this.bindArrangementDiagramEvents?.();
        const arrangePrompt = $('sp-arrange-prompt');
        arrangePrompt?.addEventListener('keydown', e => {
            if (this.handleSuggestionKeyDown(e, 'arrange')) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.recognizeArrangementRequirements?.();
        });
        arrangePrompt?.addEventListener('input', () => this.handleArrangementPromptInput?.());
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











    // ========== Relationship Highlighting ==========




    // ========== Layout Sync ==========












































    // ========== Context Menu ==========






    async parseConstraints() {
        const text = document.getElementById('sp-constraints-input')?.value?.trim();
        if (!text) return this.showToast('请输入学生需求', 'warning');

        const btn = document.getElementById('sp-parse-constraints');
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" class="sp-spin"></i> 解析中...';
        if (window.lucide) window.lucide.createIcons();

        try {
            const res = await seatingApi.fetchConstraintParse({ text, students: this.students });
            const result = await res.json();
            if (!result.success) throw new Error(result.error);

            this.constraints = Array.isArray(result.data.constraints) ? result.data.constraints : [];
            const warnings = Array.isArray(result.data.warnings) ? result.data.warnings.filter(Boolean) : [];
            const list = document.getElementById('sp-constraints-list');
            if (this.constraints.length === 0) {
                const message = warnings.length ? `解析未得到可执行需求：${warnings.join('；')}` : '未识别到学生需求';
                list.innerHTML = '';
                const empty = document.createElement('div');
                empty.style.cssText = 'text-align:center;color:var(--sp-text-muted);font-size:0.85rem;padding:16px;';
                empty.textContent = message;
                list.appendChild(empty);
            } else {
                list.innerHTML = '';
                const iconMap = {
                    front_row: 'eye',
                    back_row: 'arrow-down',
                    avoid_first_row: 'arrow-down',
                    avoid_last_row: 'arrow-up',
                    avoid_front_row: 'arrow-down',
                    avoid_back_row: 'arrow-up',
                    avoid_behind: 'move-up',
                    avoid_near: 'x-circle',
                    avoid_low_grade_deskmate: 'shield-alert',
                    prefer_front_middle: 'crosshair',
                    prefer_front_mid_rows: 'panel-top',
                    prefer_aisle: 'footprints',
                    prefer_edge: 'panel-left',
                    prefer_high_grade_neighbor: 'graduation-cap',
                    prefer_near: 'heart',
                    avoid: 'x-circle',
                    not_adjacent: 'x-circle',
                    prefer: 'heart',
                    pair: 'link',
                    must_adjacent: 'link',
                };
                const typeMap = {
                    front_row: 'front',
                    back_row: 'front',
                    avoid_first_row: 'avoid',
                    avoid_last_row: 'avoid',
                    avoid_front_row: 'avoid',
                    avoid_back_row: 'avoid',
                    avoid_behind: 'avoid',
                    avoid_near: 'avoid',
                    avoid_low_grade_deskmate: 'avoid',
                    prefer_front_middle: 'prefer',
                    prefer_front_mid_rows: 'prefer',
                    prefer_aisle: 'prefer',
                    prefer_edge: 'prefer',
                    prefer_high_grade_neighbor: 'prefer',
                    prefer_near: 'prefer',
                    avoid: 'avoid',
                    not_adjacent: 'avoid',
                    prefer: 'prefer',
                    pair: 'prefer',
                    must_adjacent: 'prefer',
                };
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

            this.renderConstraintsList(warnings);
            if (window.lucide) window.lucide.createIcons();
            this.refreshConstraintStatus();
            this.updateStatus();
            if (warnings.length) this.showToast(warnings.join('；'), 'warning');
            else this.showToast(`识别到 ${this.constraints.length} 条学生需求`, 'success');
            this.hideSuggestions('arrange');
        } catch (err) {
            this.showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles"></i> 提取需求';
            if (window.lucide) window.lucide.createIcons();
        }
    }

    renderConstraintsList(warnings = []) {
        const list = document.getElementById('sp-constraints-list');
        if (!list) return;

        const cleanWarnings = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
        list.innerHTML = '';
        if (!this.constraints.length) {
            const message = cleanWarnings.length
                ? `解析未得到可执行需求：${cleanWarnings.join('；')}`
                : '未识别到学生需求';
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align:center;color:var(--sp-text-muted);font-size:0.85rem;padding:16px;';
            empty.textContent = message;
            list.appendChild(empty);
            return;
        }

        const iconMap = {
            front_row: 'eye',
            back_row: 'arrow-down',
            avoid_first_row: 'arrow-down',
            avoid_last_row: 'arrow-up',
            avoid_front_row: 'arrow-down',
            avoid_back_row: 'arrow-up',
            avoid_behind: 'move-up',
            avoid_near: 'x-circle',
            avoid_low_grade_deskmate: 'shield-alert',
            prefer_front_middle: 'crosshair',
            prefer_front_mid_rows: 'panel-top',
            prefer_aisle: 'footprints',
            prefer_edge: 'panel-left',
            prefer_high_grade_neighbor: 'graduation-cap',
            prefer_near: 'heart',
            avoid: 'x-circle',
            not_adjacent: 'x-circle',
            prefer: 'heart',
            pair: 'link',
            must_adjacent: 'link',
        };
        const typeMap = {
            front_row: 'front',
            back_row: 'front',
            avoid_first_row: 'avoid',
            avoid_last_row: 'avoid',
            avoid_front_row: 'avoid',
            avoid_back_row: 'avoid',
            avoid_behind: 'avoid',
            avoid_near: 'avoid',
            avoid_low_grade_deskmate: 'avoid',
            prefer_front_middle: 'prefer',
            prefer_front_mid_rows: 'prefer',
            prefer_aisle: 'prefer',
            prefer_edge: 'prefer',
            prefer_high_grade_neighbor: 'prefer',
            prefer_near: 'prefer',
            avoid: 'avoid',
            not_adjacent: 'avoid',
            prefer: 'prefer',
            pair: 'prefer',
            must_adjacent: 'prefer',
        };

        this.constraints.forEach((constraint, index) => {
            const priority = constraint.priority === 'hard' ? 'hard' : 'soft';
            const row = document.createElement('div');
            row.className = 'sp-constraint';

            const iconSpan = document.createElement('span');
            iconSpan.className = `sp-constraint-icon sp-constraint-icon--${typeMap[constraint.type] || 'front'}`;
            iconSpan.innerHTML = `<i data-lucide="${iconMap[constraint.type] || 'circle'}"></i>`;
            row.appendChild(iconSpan);

            const textSpan = document.createElement('span');
            textSpan.className = 'sp-constraint-text';
            textSpan.textContent = `${constraint.target}${constraint.related ? ` -> ${constraint.related}` : ''}: ${constraint.reason}`;
            row.appendChild(textSpan);

            const actions = document.createElement('span');
            actions.className = 'sp-constraint-actions';

            const priorityButton = document.createElement('button');
            priorityButton.type = 'button';
            priorityButton.className = `sp-constraint-priority sp-constraint-priority--${priority}`;
            priorityButton.textContent = priority === 'hard' ? '必须' : '尽量';
            priorityButton.title = this.constraintPriorityTitle(priority);
            priorityButton.setAttribute('aria-label', `切换为${priority === 'hard' ? '尽量' : '必须'}`);
            priorityButton.setAttribute('data-constraint-priority', String(index));
            priorityButton.addEventListener('click', () => this.toggleConstraintPriority(index));
            actions.appendChild(priorityButton);

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'sp-constraint-delete';
            deleteButton.title = '删除这条需求';
            deleteButton.setAttribute('aria-label', '删除这条需求');
            deleteButton.setAttribute('data-delete-constraint', String(index));
            deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
            deleteButton.addEventListener('click', () => this.deleteConstraint(index));
            actions.appendChild(deleteButton);

            row.appendChild(actions);
            list.appendChild(row);
        });

        if (window.lucide) window.lucide.createIcons();
    }

    constraintPriorityTitle(priority) {
        return priority === 'hard'
            ? '必须：未满足会导致“需调整”。点击切换为尽量。'
            : '尽量：影响评分，但不影响可行性。点击切换为必须。';
    }

    toggleConstraintPriority(index) {
        if (!Number.isInteger(index) || !this.constraints[index]) return;
        const current = this.constraints[index].priority === 'hard' ? 'hard' : 'soft';
        this.constraints[index].priority = current === 'hard' ? 'soft' : 'hard';
        this.renderConstraintsList();
        this.refreshConstraintStatus();
        this.updateStatus();
        this.renderScoreAnalysisPanel();
    }

    deleteConstraint(index) {
        if (!Number.isInteger(index) || !this.constraints[index]) return;
        this.constraints.splice(index, 1);
        this.renderConstraintsList();
        this.refreshConstraintStatus();
        this.updateStatus();
        this.renderScoreAnalysisPanel();
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
            colAisles: this.colAisles,
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
        const mixedLayoutText = layoutFacts.mixedColumnPattern || layoutFacts.columnPattern?.length
            ? `两边1人组，中间2人组 · ${layoutFacts.physicalRows || layoutFacts.rows || this.rows} 排`
            : '';
        const rows = [
            ['布局', mixedLayoutText || (layoutFacts.groupsPerRow
                ? `${Math.ceil((stats.studentCount || this.students.length || 0) / Math.max(1, (layoutFacts.groupsPerRow || 1) * (layoutFacts.groupSize || 1)))} 排 × ${layoutFacts.groupsPerRow} 组 × ${layoutFacts.groupSize} 座`
                : `${layoutFacts.physicalRows || layoutFacts.rows || this.rows} 排 × ${layoutFacts.physicalCols || layoutFacts.cols || this.cols} 列`)],
            ['过道', layoutFacts.verticalBetweenGroups ? '组间竖过道' : '无组间竖过道'],
            ['容量', layoutFacts.capacityPolicy === 'fixed' ? '固定容量' : '自动扩容'],
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
        if (stats.scoreOptimizationApplied || Number.isFinite(Number(stats.scoreBeforePercent))) {
            const before = Number.isFinite(Number(stats.scoreBeforePercent)) ? stats.scoreBeforePercent : '-';
            const after = Number.isFinite(Number(stats.scoreAfterPercent)) ? stats.scoreAfterPercent : before;
            const rounds = stats.scoreOptimizationRounds || 0;
            rows.push(['高分优化', stats.scoreOptimizationApplied ? `${before} → ${after}（${rounds} 轮）` : '未找到更高分交换']);
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

        const legend = document.createElement('div');
        legend.className = 'sp-score-analysis-legend';
        const hardLegend = document.createElement('span');
        hardLegend.textContent = '必须：未满足会导致需调整';
        const softLegend = document.createElement('span');
        softLegend.textContent = '尽量：影响评分，不影响可行性';
        legend.append(hardLegend, softLegend);
        panel.appendChild(legend);

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
            const item = document.createElement('div');
            item.className = `sp-score-analysis-item sp-score-analysis-item--${issue.level === 'hard' ? 'hard' : 'soft'}`;

            const headerButton = document.createElement('button');
            headerButton.type = 'button';
            headerButton.className = 'sp-score-analysis-item-header';
            headerButton.setAttribute('aria-expanded', 'false');

            const main = document.createElement('span');
            main.className = 'sp-score-analysis-main';
            main.textContent = issue.name;
            const detail = document.createElement('span');
            detail.className = 'sp-score-analysis-detail';
            detail.textContent = issue.message || `${issue.matches.length} 项扣分`;
            const score = document.createElement('span');
            score.className = 'sp-score-analysis-score';
            score.textContent = String(issue.score);

            const matchList = document.createElement('div');
            matchList.className = 'sp-score-analysis-matches sp-hidden';
            issue.matches.forEach(match => {
                const matchButton = document.createElement('button');
                matchButton.type = 'button';
                matchButton.className = 'sp-score-analysis-match';
                matchButton.textContent = this.formatScoreMatchDetail(issue, match);
                matchButton.addEventListener('click', event => {
                    event.stopPropagation();
                    this.highlightSingleMatch(match);
                });
                matchList.appendChild(matchButton);
            });

            headerButton.addEventListener('click', () => {
                const expanded = headerButton.getAttribute('aria-expanded') === 'true';
                headerButton.setAttribute('aria-expanded', String(!expanded));
                matchList.classList.toggle('sp-hidden', expanded);
                this.highlightScoreIssue(index);
            });

            headerButton.append(main, detail, score);
            item.append(headerButton, matchList);
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

    highlightSingleMatch(match) {
        const rawCells = match?.cells?.length
            ? match.cells
            : (match?.studentIds || []).map(id => this._findPos(id)).filter(Boolean);
        const cells = rawCells.filter(cell => Number.isInteger(cell?.r) && Number.isInteger(cell?.c));
        if (!cells.length) {
            this.showToast('这条评分明细没有可高亮的座位', 'info');
            return;
        }
        const seen = new Set();
        const uniqueCells = cells.filter(cell => {
            const key = `${cell.r},${cell.c}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        this.highlightCells(uniqueCells);
    }

    resolveStatusStudentId(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        if (this.studentMap.has(text)) return text;
        return this.students.find(student => student.id === text || student.name === text)?.id || text;
    }

    highlightStatusWarning(warning) {
        if (!warning) return;
        const cells = warning.cells?.length
            ? warning.cells
            : (warning.studentIds?.length
                ? warning.studentIds
                : [warning.target, warning.related].map(value => this.resolveStatusStudentId(value)))
                .filter(Boolean)
                .map(id => this._findPos(id))
                .filter(Boolean);
        if (!cells.length) {
            this.showToast('这条警告没有可高亮的座位', 'info');
            return;
        }
        this.highlightCells(cells);
    }

    buildCompactStatusWarning(unplacedCount) {
        const quality = this._qualityEvaluation || {};
        const parts = [];
        if ((quality.hardViolationCount || 0) > 0) parts.push(`${quality.hardViolationCount} 条需调整`);
        else if (this.unsatisfied.length > 0) parts.push(`${this.unsatisfied.length} 条未满足`);
        if (unplacedCount > 0) parts.push(`${unplacedCount} 名未安排`);
        if (!parts.length) return null;

        const firstUnsatisfied = this.unsatisfied[0];
        if (firstUnsatisfied) {
            return {
                label: parts.join(' / '),
                target: firstUnsatisfied.target,
                related: firstUnsatisfied.related,
            };
        }

        const firstHardIssue = (quality.constraints || [])
            .find(issue => issue.level === 'hard' && issue.matches?.length);
        const firstMatch = firstHardIssue?.matches?.[0];
        return {
            label: parts.join(' / '),
            cells: firstMatch?.cells || [],
            studentIds: firstMatch?.studentIds || firstHardIssue?.involvedStudentIds || [],
        };
    }

    activateStatusWarningChip(warning) {
        this.showScoreAnalysis = true;
        this.updateStatus();
        const canHighlight = warning?.cells?.length || warning?.studentIds?.length || warning?.target || warning?.related;
        if (canHighlight) this.highlightStatusWarning(warning);
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
        const guardianText = this.classroomLayout?.guardians?.enabled ? '护法开' : '护法关';
        const appliedStrategies = Array.isArray(this.arrangementStats?.appliedStrategies)
            ? this.arrangementStats.appliedStrategies.filter(Boolean)
            : [];
        const sourceLabel = this.arrangementSource === 'timefold_solver'
            ? 'Timefold 优化'
            : (this.arrangementSource ? '本地排座' : '');
        const sourceIcon = this.arrangementSource === 'timefold_solver' ? 'cpu' : 'shuffle';
        const scoreSummary = `评分 ${quality.percent} · ${quality.feasible ? '可行' : '需调整'}`;
        const compactWarning = this.buildCompactStatusWarning(unplacedCount);
        this._statusWarning = compactWarning;

        let html = `
            <div class="sp-status-left">
                <span class="sp-status-item ${quality.feasible ? 'sp-status-item--success' : 'sp-status-item--warning'}" title="${scoreSummary}">
                    <i data-lucide="${quality.feasible ? 'badge-check' : 'alert-triangle'}"></i>
                    ${scoreSummary}
                </span>
                <span class="sp-status-item sp-status-item--success">
                    <i data-lucide="check-circle"></i>
                    满足 ${evaluation.satisfied}/${evaluation.total} 需求
                </span>
                ${sourceLabel ? `
                    <span class="sp-status-chip sp-status-chip--solver sp-status-item--solver">
                        <i data-lucide="${sourceIcon}"></i>
                        ${sourceLabel}
                    </span>` : ''}
            </div>
            <div class="sp-status-middle">
                <span class="sp-status-chip">
                    <i data-lucide="layout-grid"></i>
                    ${layoutName} · ${capacity} 席 · ${guardianText}
                </span>
                ${appliedStrategies.length ? `
                    <span class="sp-status-chip">
                        <i data-lucide="sliders-horizontal"></i>
                        已应用：${appliedStrategies.join('、')}
                    </span>` : ''}
                ${compactWarning ? `
                    <span class="sp-status-chip sp-status-warning-chip">
                        <i data-lucide="alert-triangle"></i>
                        ${compactWarning.label}
                    </span>` : ''}
            </div>
            <div class="sp-status-right"></div>
        `;

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
        const statusWarningChip = status.querySelector('.sp-status-warning-chip');
        if (statusWarningChip) {
            statusWarningChip.setAttribute('role', 'button');
            statusWarningChip.setAttribute('tabindex', '0');
            statusWarningChip.setAttribute('title', '打开评分分析并定位相关座位');
            statusWarningChip.addEventListener('click', () => this.activateStatusWarningChip(this._statusWarning));
            statusWarningChip.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.activateStatusWarningChip(this._statusWarning);
                }
            });
        }
        this.renderSeatDetailsToggle();
        this.renderArrangementExplainPanel();
        this.renderScoreAnalysisPanel();
        if (window.lucide) window.lucide.createIcons();
    }

    // ========== Toast ==========

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

Object.assign(
    SeatingPlanner.prototype,
    seatingAssistantMethods,
    seatingArrangementDiagramMethods,
    seatingExportMethods,
    seatingFeedbackMethods,
    seatingGridMethods,
    seatingLayoutPreviewMethods,
    seatingRosterMethods,
    seatingSeatDetailMethods
);

// Export
const seatingPlanner = new SeatingPlanner();
export function init(container) { seatingPlanner.init(container); }
export default seatingPlanner;
