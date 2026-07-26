import {
    getConstraintRuleDefinition,
    getConstraintRuleEditorDefinition,
} from './constraint-rule-form-model.js';

function resizeConstraintChatInput(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}

export const INSPECTOR_POSITION_STORAGE_KEY = 'timetable.inspector.position.v1';
export const INSPECTOR_SIZE_STORAGE_KEY = 'timetable.inspector.size.v1';
const INSPECTOR_FLOATING_BREAKPOINT = 980;
const INSPECTOR_POSITION_MARGIN = 12;
const INSPECTOR_DRAG_THRESHOLD = 4;
const INSPECTOR_MIN_WIDTH = 480;
const INSPECTOR_MAX_WIDTH = 680;
const INSPECTOR_MIN_HEIGHT = 560;
const INSPECTOR_ISSUE_DEFAULT_LIMIT = 5;
const INSPECTOR_ISSUE_LIMIT_STEP = 20;
const RULE_TYPE_PICKER_MOBILE_BREAKPOINT = 640;
const RULE_TYPE_PICKER_VIEWPORT_MARGIN = 12;

function roundedFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : null;
}

function isCompactRuleTypePickerViewport() {
    const win = typeof window === 'undefined' ? null : window;
    if (!win) return false;
    if (typeof win.matchMedia === 'function') {
        return win.matchMedia(`(max-width: ${RULE_TYPE_PICKER_MOBILE_BREAKPOINT}px)`).matches;
    }
    return Number(win.innerWidth || 0) <= RULE_TYPE_PICKER_MOBILE_BREAKPOINT;
}

function ruleTypePickerViewport() {
    const win = typeof window === 'undefined' ? null : window;
    const doc = typeof document === 'undefined' ? null : document.documentElement;
    return {
        width: Number(win?.innerWidth || doc?.clientWidth || 0),
        height: Number(win?.innerHeight || doc?.clientHeight || 0),
    };
}

function ruleTypePickerElements(picker) {
    if (!picker) return {};
    return {
        input: picker.querySelector?.('[data-constraint-rule-type-input]') || null,
        trigger: picker.querySelector?.('[data-constraint-rule-type-trigger]') || null,
        listbox: picker.querySelector?.('[data-constraint-rule-type-listbox]') || null,
        help: picker.querySelector?.('[data-constraint-rule-type-help]') || null,
    };
}

function ruleTypePickerOptions(picker) {
    return [...(picker?.querySelectorAll?.('[data-constraint-rule-type-option]') || [])];
}

function hideRuleTypeHelp(picker) {
    const { help } = ruleTypePickerElements(picker);
    if (!help) return;
    help.hidden = true;
    help.removeAttribute('data-placement');
    help.style.removeProperty('left');
    help.style.removeProperty('top');
    help.style.removeProperty('width');
}

function positionRuleTypeListbox(picker) {
    const { trigger, listbox } = ruleTypePickerElements(picker);
    if (!trigger || !listbox || typeof trigger.getBoundingClientRect !== 'function') return;
    const triggerRect = trigger.getBoundingClientRect();
    const viewport = ruleTypePickerViewport();
    if (!viewport.width || !viewport.height) return;
    const margin = RULE_TYPE_PICKER_VIEWPORT_MARGIN;
    const width = Math.min(Math.max(220, triggerRect.width), Math.max(0, viewport.width - margin * 2));
    const left = Math.min(Math.max(margin, triggerRect.left), Math.max(margin, viewport.width - width - margin));
    const estimatedHeight = Math.min(320, Math.max(120, Number(listbox.scrollHeight) || 0));
    const belowTop = triggerRect.bottom + 6;
    const shouldOpenAbove = belowTop + estimatedHeight > viewport.height - margin
        && triggerRect.top - estimatedHeight - 6 >= margin;
    const top = shouldOpenAbove
        ? Math.max(margin, triggerRect.top - estimatedHeight - 6)
        : Math.min(belowTop, Math.max(margin, viewport.height - estimatedHeight - margin));
    listbox.style.left = `${Math.round(left)}px`;
    listbox.style.top = `${Math.round(top)}px`;
    listbox.style.width = `${Math.round(width)}px`;
    listbox.style.maxHeight = `${Math.max(120, Math.min(320, viewport.height - margin * 2))}px`;
    listbox.dataset.placement = shouldOpenAbove ? 'top' : 'bottom';
}

function positionRuleTypeHelp(picker) {
    const { trigger, listbox, help } = ruleTypePickerElements(picker);
    if (!trigger || !help || typeof trigger.getBoundingClientRect !== 'function') return;
    const viewport = ruleTypePickerViewport();
    if (!viewport.width || !viewport.height) return;
    const triggerRect = trigger.getBoundingClientRect();
    const listRect = listbox && !listbox.hidden && typeof listbox.getBoundingClientRect === 'function'
        ? listbox.getBoundingClientRect()
        : triggerRect;
    const activeOption = !listbox?.hidden
        ? (picker.querySelector?.('[data-constraint-rule-type-option].is-active')
            || picker.querySelector?.('[data-constraint-rule-type-option].is-selected'))
        : null;
    const activeRect = activeOption && typeof activeOption.getBoundingClientRect === 'function'
        ? activeOption.getBoundingClientRect()
        : triggerRect;
    const helpRect = help.getBoundingClientRect?.() || { width: 300, height: 100 };
    const margin = RULE_TYPE_PICKER_VIEWPORT_MARGIN;
    const sideGap = 10;
    const width = Math.min(Math.max(260, helpRect.width || 0), Math.max(0, viewport.width - margin * 2));
    const helpHeight = helpRect.height || 0;
    const anchorTop = Math.min(triggerRect.top, listRect.top);
    const anchorBottom = Math.max(triggerRect.bottom, listRect.bottom);
    const rightLeft = listRect.right + sideGap;
    const leftLeft = listRect.left - sideGap - width;
    const canPlaceRight = !isCompactRuleTypePickerViewport() && rightLeft + width <= viewport.width - margin;
    const canPlaceLeft = !isCompactRuleTypePickerViewport() && leftLeft >= margin;
    let left;
    let top;
    let placement;
    if (canPlaceRight || canPlaceLeft) {
        left = canPlaceRight ? rightLeft : leftLeft;
        top = Math.min(
            Math.max(margin, activeRect.top + activeRect.height / 2 - helpHeight / 2),
            Math.max(margin, viewport.height - helpHeight - margin),
        );
        placement = canPlaceRight ? 'right' : 'left';
    } else {
        const fitsAbove = anchorTop - helpHeight - 8 >= margin;
        left = Math.min(
            Math.max(margin, triggerRect.left + triggerRect.width / 2 - width / 2),
            Math.max(margin, viewport.width - width - margin),
        );
        top = fitsAbove
            ? anchorTop - helpHeight - 8
            : Math.min(anchorBottom + 8, Math.max(margin, viewport.height - helpHeight - margin));
        placement = fitsAbove ? 'top' : 'bottom';
    }
    help.style.left = `${Math.round(left)}px`;
    help.style.top = `${Math.round(top)}px`;
    help.style.width = `${Math.round(width)}px`;
    help.dataset.placement = placement;
}

function showRuleTypeHelp(picker, type) {
    const definition = getConstraintRuleEditorDefinition(type) || getConstraintRuleDefinition(type);
    const { help } = ruleTypePickerElements(picker);
    if (!definition || !help) return;
    const title = help.querySelector?.('[data-constraint-rule-help-title]');
    const text = help.querySelector?.('[data-constraint-rule-help-text]');
    const strength = help.querySelector?.('[data-constraint-rule-help-strength]');
    if (title) title.textContent = definition.label;
    if (text) text.textContent = definition.helpText || '';
    if (strength) strength.textContent = definition.strength === 'hard' ? '硬约束 · 必须遵守' : '软约束 · 尽量满足';
    help.dataset.strength = definition.strength;
    help.hidden = false;
    positionRuleTypeHelp(picker);
}

function closeRuleTypePicker(picker, { restoreFocus = false } = {}) {
    const { trigger, listbox } = ruleTypePickerElements(picker);
    if (!picker || !trigger || !listbox) return;
    picker.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    listbox.hidden = true;
    listbox.removeAttribute('data-placement');
    listbox.style.removeProperty('left');
    listbox.style.removeProperty('top');
    listbox.style.removeProperty('width');
    listbox.style.removeProperty('max-height');
    hideRuleTypeHelp(picker);
    if (restoreFocus) trigger.focus?.();
}

function closeOtherRuleTypePickers(picker) {
    const ownerDocument = picker?.ownerDocument || (typeof document === 'undefined' ? null : document);
    ownerDocument?.querySelectorAll?.('[data-constraint-rule-type-picker].is-open').forEach(other => {
        if (other !== picker) closeRuleTypePicker(other);
    });
}

function setActiveRuleTypeOption(picker, option, { showHelp = false } = {}) {
    if (!picker || !option) return;
    const { trigger } = ruleTypePickerElements(picker);
    ruleTypePickerOptions(picker).forEach(candidate => candidate.classList.toggle('is-active', candidate === option));
    picker.dataset.activeRuleType = option.dataset.constraintRuleType || '';
    if (trigger) trigger.setAttribute('aria-activedescendant', option.id);
    if (showHelp && !isCompactRuleTypePickerViewport()) {
        showRuleTypeHelp(picker, option.dataset.constraintRuleType || '');
    }
}

function openRuleTypePicker(picker) {
    const { input, trigger, listbox } = ruleTypePickerElements(picker);
    if (!picker || !input || !trigger || !listbox) return;
    closeOtherRuleTypePickers(picker);
    picker.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    listbox.hidden = false;
    const selected = ruleTypePickerOptions(picker).find(option => option.dataset.constraintRuleType === input.value)
        || ruleTypePickerOptions(picker)[0];
    if (selected) setActiveRuleTypeOption(picker, selected);
    positionRuleTypeListbox(picker);
}

function moveActiveRuleTypeOption(picker, direction) {
    const options = ruleTypePickerOptions(picker);
    if (!options.length) return;
    const activeType = picker.dataset.activeRuleType || '';
    const currentIndex = Math.max(0, options.findIndex(option => option.dataset.constraintRuleType === activeType));
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    setActiveRuleTypeOption(picker, options[nextIndex], { showHelp: true });
}

function commitRuleTypePickerSelection(controller, picker, type) {
    const { input, trigger } = ruleTypePickerElements(picker);
    if (!input || !type) return;
    const inputId = input.id;
    input.value = type;
    closeRuleTypePicker(picker);
    if (inputId === 'tt-manual-rule-type') {
        controller.updateManualConstraintType?.(type);
    } else if (inputId === 'tt-edit-constraint-type') {
        controller.updateEditingConstraintType?.(type);
    }
    setTimeout(() => {
        const nextTrigger = picker.ownerDocument?.getElementById?.(`${inputId}-trigger`);
        (nextTrigger || trigger)?.focus?.();
    }, 0);
}

function handleRuleTypePickerKeydown(event, controller) {
    const picker = event.target?.closest?.('[data-constraint-rule-type-picker]');
    if (!picker) return false;
    const { trigger } = ruleTypePickerElements(picker);
    const isOpen = picker.classList.contains('is-open');
    if (event.key === 'Escape') {
        if (!isOpen) return false;
        event.preventDefault();
        event.stopPropagation();
        closeRuleTypePicker(picker, { restoreFocus: true });
        return true;
    }
    if (event.target !== trigger) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen) openRuleTypePicker(picker);
        moveActiveRuleTypeOption(picker, event.key === 'ArrowDown' ? 1 : -1);
        return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!isOpen) {
            openRuleTypePicker(picker);
            return true;
        }
        const active = ruleTypePickerOptions(picker).find(option => option.dataset.constraintRuleType === picker.dataset.activeRuleType);
        if (active) commitRuleTypePickerSelection(controller, picker, active.dataset.constraintRuleType || '');
        return true;
    }
    if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        if (!isOpen) openRuleTypePicker(picker);
        const options = ruleTypePickerOptions(picker);
        setActiveRuleTypeOption(picker, options[event.key === 'Home' ? 0 : options.length - 1], { showHelp: true });
        return true;
    }
    return false;
}

function bindRuleTypePickerViewportEvents(container) {
    if (container.__ttRuleTypePickerViewportEventsBound) return;
    container.__ttRuleTypePickerViewportEventsBound = true;
    const ownerWindow = container.ownerDocument?.defaultView;
    const reposition = () => {
        const picker = container.querySelector?.('[data-constraint-rule-type-picker].is-open');
        if (!picker) return;
        positionRuleTypeListbox(picker);
        const { help } = ruleTypePickerElements(picker);
        if (help && !help.hidden) positionRuleTypeHelp(picker);
    };
    ownerWindow?.addEventListener?.('resize', reposition);
    ownerWindow?.addEventListener?.('scroll', reposition, true);
    container.querySelectorAll?.('[data-constraint-rule-type-listbox]').forEach(listbox => {
        if (listbox.__ttRuleTypePickerScrollBound) return;
        listbox.__ttRuleTypePickerScrollBound = true;
        listbox.addEventListener('scroll', () => {
            const picker = listbox.closest?.('[data-constraint-rule-type-picker]');
            const { help } = ruleTypePickerElements(picker);
            if (picker && help && !help.hidden) positionRuleTypeHelp(picker);
        });
    });
}

export function clampInspectorPosition(position = {}, viewport = {}, size = {}, margin = INSPECTOR_POSITION_MARGIN) {
    const viewportWidth = Math.max(0, Number(viewport.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport.height) || 0);
    const width = Math.max(0, Number(size.width) || 0);
    const height = Math.max(0, Number(size.height) || 0);
    const safeMargin = Math.max(0, Number(margin) || 0);
    const maxX = Math.max(safeMargin, viewportWidth - width - safeMargin);
    const maxY = Math.max(safeMargin, viewportHeight - height - safeMargin);
    const x = roundedFiniteNumber(position.x);
    const y = roundedFiniteNumber(position.y);
    return {
        x: Math.min(Math.max(x ?? safeMargin, safeMargin), maxX),
        y: Math.min(Math.max(y ?? safeMargin, safeMargin), maxY),
    };
}

export function loadInspectorPosition(storage = globalThis?.localStorage) {
    try {
        const raw = storage?.getItem?.(INSPECTOR_POSITION_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const x = roundedFiniteNumber(parsed?.x);
        const y = roundedFiniteNumber(parsed?.y);
        if (x === null || y === null) return null;
        return { x, y };
    } catch {
        return null;
    }
}

export function saveInspectorPosition(position = {}, storage = globalThis?.localStorage) {
    try {
        const x = roundedFiniteNumber(position.x);
        const y = roundedFiniteNumber(position.y);
        if (x === null || y === null) return false;
        storage?.setItem?.(INSPECTOR_POSITION_STORAGE_KEY, JSON.stringify({ x, y }));
        return true;
    } catch {
        return false;
    }
}

export function clampInspectorSize(size = {}, viewport = {}) {
    const viewportWidth = Math.max(0, Number(viewport.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport.height) || 0);
    const maxWidth = Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, viewportWidth - INSPECTOR_POSITION_MARGIN * 2));
    const maxHeight = Math.max(INSPECTOR_MIN_HEIGHT, viewportHeight - INSPECTOR_POSITION_MARGIN * 2);
    const width = roundedFiniteNumber(size.width);
    const height = roundedFiniteNumber(size.height);
    return {
        width: Math.min(Math.max(width ?? 540, Math.min(INSPECTOR_MIN_WIDTH, maxWidth)), maxWidth),
        height: Math.min(Math.max(height ?? 720, Math.min(INSPECTOR_MIN_HEIGHT, maxHeight)), maxHeight),
    };
}

export function loadInspectorSize(storage = globalThis?.localStorage) {
    try {
        const raw = storage?.getItem?.(INSPECTOR_SIZE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const width = roundedFiniteNumber(parsed?.width);
        const height = roundedFiniteNumber(parsed?.height);
        if (width === null || height === null) return null;
        return { width, height };
    } catch {
        return null;
    }
}

export function saveInspectorSize(size = {}, storage = globalThis?.localStorage) {
    try {
        const width = roundedFiniteNumber(size.width);
        const height = roundedFiniteNumber(size.height);
        if (width === null || height === null) return false;
        storage?.setItem?.(INSPECTOR_SIZE_STORAGE_KEY, JSON.stringify({ width, height }));
        return true;
    } catch {
        return false;
    }
}

function isInspectorFloatingViewport() {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
        return window.matchMedia(`(min-width: ${INSPECTOR_FLOATING_BREAKPOINT + 1}px)`).matches;
    }
    return Number(window.innerWidth || 0) > INSPECTOR_FLOATING_BREAKPOINT;
}

function inspectorViewportSize() {
    const win = typeof window !== 'undefined' ? window : null;
    const doc = typeof document !== 'undefined' ? document.documentElement : null;
    return {
        width: Number(win?.innerWidth || doc?.clientWidth || 0),
        height: Number(win?.innerHeight || doc?.clientHeight || 0),
    };
}

function applyInspectorPosition(inspector, position) {
    if (!inspector || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    inspector.classList.add('is-positioned');
    inspector.style.setProperty('--tt-inspector-x', `${Math.round(position.x)}px`);
    inspector.style.setProperty('--tt-inspector-y', `${Math.round(position.y)}px`);
}

function applyInspectorSize(inspector, size) {
    if (!inspector || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return;
    inspector.style.setProperty('--tt-inspector-width', `${Math.round(size.width)}px`);
    inspector.style.setProperty('--tt-inspector-height', `${Math.round(size.height)}px`);
}

function syncInspectorOpenClass(inspector, open) {
    if (!inspector) return;
    inspector.classList.toggle('is-open', Boolean(open));
    inspector.classList.toggle('is-collapsed', !open);
}

function positiveInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function updateInspectorIssueLimit(action, target, controller, state) {
    const node = target?.closest?.('[data-inspector-issue-limit-key]');
    const limitKey = node?.dataset?.inspectorIssueLimitKey || '';
    if (!limitKey) return false;
    const total = positiveInteger(node.dataset.inspectorIssueTotal, 0);
    const shown = positiveInteger(node.dataset.inspectorIssueShown, INSPECTOR_ISSUE_DEFAULT_LIMIT);
    state.inspectorIssueLimits = state.inspectorIssueLimits && typeof state.inspectorIssueLimits === 'object'
        ? { ...state.inspectorIssueLimits }
        : {};
    if (action === 'collapse-inspector-issue-group') {
        delete state.inspectorIssueLimits[limitKey];
    } else {
        state.inspectorIssueLimits[limitKey] = total
            ? Math.min(total, shown + INSPECTOR_ISSUE_LIMIT_STEP)
            : shown + INSPECTOR_ISSUE_LIMIT_STEP;
    }
    controller.render?.();
    return true;
}

function captureInspectorLocateAnchor(actionNode) {
    const inspectorBody = actionNode?.closest?.('.tt-inspector-body') || null;
    if (!inspectorBody) return {};
    const scrollTop = Number(inspectorBody.scrollTop);
    const bodyRect = typeof inspectorBody.getBoundingClientRect === 'function'
        ? inspectorBody.getBoundingClientRect()
        : null;
    const issueRect = typeof actionNode.getBoundingClientRect === 'function'
        ? actionNode.getBoundingClientRect()
        : null;
    const offsetTop = bodyRect && issueRect
        ? Number(issueRect.top) - Number(bodyRect.top)
        : null;
    return {
        ...(Number.isFinite(scrollTop) ? { inspectorAnchorScrollTop: scrollTop } : {}),
        ...(Number.isFinite(offsetTop) ? { inspectorAnchorOffsetTop: offsetTop } : {}),
    };
}

function bindInspectorFloatingWindow(container, state) {
    const inspector = container.querySelector?.('[data-inspector-floating-window]');
    const drawer = container.querySelector?.('#tt-inspector-drawer');
    const handle = container.querySelector?.('[data-inspector-drag-handle]');
    if (!inspector || !drawer || !handle) return;

    syncInspectorOpenClass(inspector, drawer.open);
    if (state.inspectorSize) {
        const clampedSize = clampInspectorSize(state.inspectorSize, inspectorViewportSize());
        state.inspectorSize = clampedSize;
        applyInspectorSize(inspector, clampedSize);
    }
    if (state.inspectorPosition) {
        const rect = inspector.getBoundingClientRect();
        const clamped = clampInspectorPosition(
            state.inspectorPosition,
            inspectorViewportSize(),
            { width: rect.width, height: rect.height },
        );
        state.inspectorPosition = clamped;
        applyInspectorPosition(inspector, clamped);
    }

    drawer.addEventListener('toggle', event => {
        const open = Boolean(event.target.open);
        state.inspectorOpen = open;
        syncInspectorOpenClass(inspector, open);
    });

    handle.addEventListener('click', event => {
        if (handle.dataset.inspectorSuppressToggle !== 'true') return;
        event.preventDefault();
        event.stopPropagation();
        delete handle.dataset.inspectorSuppressToggle;
    }, true);

    handle.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (!isInspectorFloatingViewport()) return;
        if (event.target?.closest?.('button, input, textarea, select, a')) return;

        const ownerDocument = handle.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!ownerDocument) return;
        const startX = Number(event.clientX || 0);
        const startY = Number(event.clientY || 0);
        const rect = inspector.getBoundingClientRect();
        const offsetX = startX - rect.left;
        const offsetY = startY - rect.top;
        const viewport = inspectorViewportSize();
        const pointerId = event.pointerId;
        let moved = false;
        let pendingFrame = 0;
        let pendingPosition = null;

        const requestFrame = callback => {
            const ownerWindow = ownerDocument.defaultView || (typeof window !== 'undefined' ? window : null);
            if (typeof ownerWindow?.requestAnimationFrame === 'function') {
                return ownerWindow.requestAnimationFrame(callback);
            }
            if (typeof globalThis?.requestAnimationFrame === 'function') {
                return globalThis.requestAnimationFrame(callback);
            }
            callback();
            return 0;
        };

        const cancelFrame = frameId => {
            if (!frameId) return;
            const ownerWindow = ownerDocument.defaultView || (typeof window !== 'undefined' ? window : null);
            if (typeof ownerWindow?.cancelAnimationFrame === 'function') {
                ownerWindow.cancelAnimationFrame(frameId);
            } else if (typeof globalThis?.cancelAnimationFrame === 'function') {
                globalThis.cancelAnimationFrame(frameId);
            }
        };

        const flushPosition = () => {
            if (pendingFrame) {
                cancelFrame(pendingFrame);
                pendingFrame = 0;
            }
            if (!pendingPosition) return;
            applyInspectorPosition(inspector, pendingPosition);
            pendingPosition = null;
        };

        const schedulePosition = position => {
            pendingPosition = position;
            if (pendingFrame) return;
            pendingFrame = requestFrame(() => {
                pendingFrame = 0;
                flushPosition();
            });
        };

        const cleanup = () => {
            cancelFrame(pendingFrame);
            pendingFrame = 0;
            pendingPosition = null;
            ownerDocument.removeEventListener('pointermove', onPointerMove);
            ownerDocument.removeEventListener('pointerup', onPointerUp);
            ownerDocument.removeEventListener('pointercancel', onPointerUp);
            try {
                if (pointerId !== undefined && pointerId !== null && typeof handle.releasePointerCapture === 'function') {
                    handle.releasePointerCapture(pointerId);
                }
            } catch {
                // Pointer capture may already have been released by the browser.
            }
            inspector.classList.remove('is-dragging');
            state.inspectorDragging = false;
        };

        const onPointerMove = moveEvent => {
            const nextX = Number(moveEvent.clientX || 0);
            const nextY = Number(moveEvent.clientY || 0);
            const distance = Math.hypot(nextX - startX, nextY - startY);
            if (!moved && distance < INSPECTOR_DRAG_THRESHOLD) return;
            moved = true;
            moveEvent.preventDefault?.();
            state.inspectorDragging = true;
            inspector.classList.add('is-dragging');
            const clamped = clampInspectorPosition(
                { x: nextX - offsetX, y: nextY - offsetY },
                viewport,
                { width: rect.width, height: rect.height },
            );
            state.inspectorPosition = clamped;
            schedulePosition(clamped);
        };

        const onPointerUp = () => {
            if (moved) flushPosition();
            cleanup();
            if (!moved) return;
            handle.dataset.inspectorSuppressToggle = 'true';
            saveInspectorPosition(state.inspectorPosition);
            setTimeout(() => {
                if (handle.dataset.inspectorSuppressToggle === 'true') {
                    delete handle.dataset.inspectorSuppressToggle;
                }
            }, 0);
        };

        try {
            if (pointerId !== undefined && pointerId !== null && typeof handle.setPointerCapture === 'function') {
                handle.setPointerCapture(pointerId);
            }
        } catch {
            // Pointer capture is an enhancement; document listeners remain the fallback.
        }
        ownerDocument.addEventListener('pointermove', onPointerMove);
        ownerDocument.addEventListener('pointerup', onPointerUp, { once: true });
        ownerDocument.addEventListener('pointercancel', onPointerUp, { once: true });
    });

    const resizeHandle = container.querySelector?.('[data-inspector-resize-handle]');
    resizeHandle?.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (!isInspectorFloatingViewport()) return;
        const ownerDocument = resizeHandle.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!ownerDocument) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        const startX = Number(event.clientX || 0);
        const startY = Number(event.clientY || 0);
        const rect = inspector.getBoundingClientRect();
        const viewport = inspectorViewportSize();
        const pointerId = event.pointerId;
        let resized = false;
        let pendingFrame = 0;
        let pendingSize = null;

        const ownerWindow = ownerDocument.defaultView || (typeof window !== 'undefined' ? window : null);
        const requestFrame = callback => {
            if (typeof ownerWindow?.requestAnimationFrame === 'function') return ownerWindow.requestAnimationFrame(callback);
            callback();
            return 0;
        };
        const cancelFrame = frameId => {
            if (frameId && typeof ownerWindow?.cancelAnimationFrame === 'function') ownerWindow.cancelAnimationFrame(frameId);
        };
        const flushSize = () => {
            if (pendingFrame) {
                cancelFrame(pendingFrame);
                pendingFrame = 0;
            }
            if (!pendingSize) return;
            applyInspectorSize(inspector, pendingSize);
            pendingSize = null;
        };
        const scheduleSize = size => {
            pendingSize = size;
            if (pendingFrame) return;
            pendingFrame = requestFrame(() => {
                pendingFrame = 0;
                flushSize();
            });
        };
        const cleanup = () => {
            cancelFrame(pendingFrame);
            pendingFrame = 0;
            pendingSize = null;
            ownerDocument.removeEventListener('pointermove', onPointerMove);
            ownerDocument.removeEventListener('pointerup', onPointerUp);
            ownerDocument.removeEventListener('pointercancel', onPointerUp);
            try {
                if (pointerId !== undefined && pointerId !== null && typeof resizeHandle.releasePointerCapture === 'function') {
                    resizeHandle.releasePointerCapture(pointerId);
                }
            } catch {
                // Pointer capture may already have been released by the browser.
            }
            inspector.classList.remove('is-resizing');
            state.inspectorResizing = false;
        };
        const onPointerMove = moveEvent => {
            const nextWidth = rect.width + Number(moveEvent.clientX || 0) - startX;
            const nextHeight = rect.height + Number(moveEvent.clientY || 0) - startY;
            const nextSize = clampInspectorSize({ width: nextWidth, height: nextHeight }, viewport);
            resized = resized || Math.abs(nextSize.width - rect.width) >= 1 || Math.abs(nextSize.height - rect.height) >= 1;
            if (!resized) return;
            moveEvent.preventDefault?.();
            state.inspectorResizing = true;
            inspector.classList.add('is-resizing');
            state.inspectorSize = nextSize;
            scheduleSize(nextSize);
        };
        const onPointerUp = () => {
            if (resized) flushSize();
            cleanup();
            if (resized) saveInspectorSize(state.inspectorSize);
        };
        try {
            if (pointerId !== undefined && pointerId !== null && typeof resizeHandle.setPointerCapture === 'function') {
                resizeHandle.setPointerCapture(pointerId);
            }
        } catch {
            // Pointer capture is an enhancement; document listeners remain the fallback.
        }
        ownerDocument.addEventListener('pointermove', onPointerMove);
        ownerDocument.addEventListener('pointerup', onPointerUp, { once: true });
        ownerDocument.addEventListener('pointercancel', onPointerUp, { once: true });
    });
}

function closeConstraintSidebarMenu(container, state, { restoreFocus = false } = {}) {
    if (!state?.constraintDialog?.sidebarMenuOpen) return false;
    state.constraintDialog.sidebarMenuOpen = false;
    container?.querySelector?.('.tt-smart-helper-menu')?.remove?.();
    const trigger = container?.querySelector?.('[data-action="toggle-constraint-sidebar-menu"]');
    trigger?.setAttribute?.('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus?.();
    return true;
}

function closeConstraintFulfillmentFilterMenu(container, state, { restoreFocus = false } = {}) {
    if (!state?.constraintFulfillmentFilterMenuOpen) return false;
    state.constraintFulfillmentFilterMenuOpen = false;
    const menu = container?.querySelector?.('.tt-constraint-fulfillment-status-options');
    const trigger = container?.querySelector?.('[data-action="toggle-constraint-fulfillment-filter-menu"]');
    if (menu) menu.hidden = true;
    trigger?.setAttribute?.('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus?.();
    return true;
}

function fulfillmentRowById(container, rowId) {
    return [...(container?.querySelectorAll?.('.tt-constraint-fulfillment-row') || [])]
        .find(row => String(row.dataset.constraintFulfillmentRow || '') === String(rowId || '')) || null;
}

function rerenderConstraintFulfillmentPreservingScroll(container, controller, anchorId = '') {
    const body = container?.querySelector?.('.tt-inspector-body');
    const bodyRect = body?.getBoundingClientRect?.();
    const anchor = anchorId ? fulfillmentRowById(container, anchorId) : null;
    const anchorRect = anchor?.getBoundingClientRect?.();
    const scrollTop = Number(body?.scrollTop || 0);
    const anchorOffset = anchorRect && bodyRect ? anchorRect.top - bodyRect.top : null;
    controller?.render?.();
    const nextBody = container?.querySelector?.('.tt-inspector-body');
    if (!nextBody) return;
    if (anchorOffset === null) {
        nextBody.scrollTop = scrollTop;
        return;
    }
    const nextAnchor = fulfillmentRowById(container, anchorId);
    const nextBodyRect = nextBody.getBoundingClientRect?.();
    const nextAnchorRect = nextAnchor?.getBoundingClientRect?.();
    if (nextAnchorRect && nextBodyRect) {
        nextBody.scrollTop = Math.max(0, scrollTop + (nextAnchorRect.top - nextBodyRect.top) - anchorOffset);
    } else {
        nextBody.scrollTop = scrollTop;
    }
}

function toggleConstraintFulfillmentRow(container, controller, state, rowId) {
    const id = String(rowId || '');
    if (!id) return;
    state.constraintFulfillmentExpandedRowId = state.constraintFulfillmentExpandedRowId === id ? '' : id;
    closeConstraintFulfillmentFilterMenu(container, state);
    rerenderConstraintFulfillmentPreservingScroll(container, controller, id);
}

function fulfillmentStatusForInteraction(item = {}) {
    if (item.status === 'unmet') return 'violated';
    if (item.status === 'not_applicable') return 'not_evaluable';
    return item.status || 'not_evaluable';
}

function fulfillmentItemVisibleForFilter(item = {}, filter = 'all') {
    const status = fulfillmentStatusForInteraction(item);
    if (filter === 'all') return true;
    if (filter === 'attention') return status === 'violated' || status === 'partial';
    return status === filter;
}

export function handleTimetableEscape(event, container, controller, state) {
    if (event?.key !== 'Escape') return false;

    if (state?.constraintDialog?.sidebarMenuOpen) {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeConstraintSidebarMenu(container, state, { restoreFocus: true });
        return true;
    }

    if (state?.constraintFulfillmentFilterMenuOpen) {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeConstraintFulfillmentFilterMenu(container, state, { restoreFocus: true });
        return true;
    }

    if (state?.constraintDialog?.editingSourceRequirement) {
        event.preventDefault?.();
        event.stopPropagation?.();
        controller?.cancelSourceRequirementEdit?.();
        return true;
    }

    if (state?.constraintDialog?.editingConstraint) {
        event.preventDefault?.();
        event.stopPropagation?.();
        controller?.cancelEditConstraint?.();
        return true;
    }

    // Check if we're in an input field that's being edited
    const target = event.target;
    if (target && (target.matches('input[type="text"], input[type="time"], input[type="number"], textarea, select') || target.isContentEditable)) {
        if (state?.rosterImport?.appendDialog?.open && target.closest?.('#tt-roster-append-dialog')) {
            target.blur();
            event.preventDefault();
            event.stopPropagation();
            controller?.closeRosterAppendDialog?.();
            return true;
        }
        if (state?.rosterImport?.issueEditor && target.closest?.('#tt-roster-issue-editor-dialog')) {
            target.blur();
            event.preventDefault();
            event.stopPropagation();
            controller?.closeRosterIssueEditor?.();
            return true;
        }
        // Allow Escape to blur the input without closing dialogs
        target.blur();
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    event.preventDefault?.();
    event.stopPropagation?.();

    if (!controller || !state) return true;

    if (state.restoreDialog?.open) {
        controller.closeRestoreDialog?.();
        return true;
    }
    if (state.publicationHistoryDialog?.open) {
        controller.closePublicationHistoryDialog?.();
        return true;
    }
    if (state.publishDialog?.open) {
        controller.closePublishDialog?.();
        return true;
    }
    if (state.periodTimeDialog?.open) {
        controller.closePeriodTimeDialog?.();
        return true;
    }
    if (state.dutyDialog?.open) {
        controller.closeDutyAssignmentDialog?.();
        return true;
    }
    if (state.rosterImport?.issueEditor) {
        controller.closeRosterIssueEditor?.();
        return true;
    }
    if (state.rosterImport?.appendDialog?.open) {
        controller.closeRosterAppendDialog?.();
        return true;
    }
    if (state.rosterImport?.open) {
        controller.closeRosterImport?.();
        return true;
    }
    if (state.constraintChat?.open) {
        controller.closeConstraintChat?.();
        return true;
    }
    if (state.constraintDialog?.editingConstraint) {
        controller.cancelEditConstraint?.();
        return true;
    }
    if (state.constraintDialog?.open) {
        controller.closeConstraintDialog?.();
        return true;
    }
    if (state.problemDetailDialog?.open) {
        controller.closeProblemDetails?.();
        return true;
    }
    if (state.rangePopover) {
        controller.closeRangePopover?.();
        return true;
    }

    const openDetails = Array.from(container?.querySelectorAll?.('details.tt-multi-select[open], details.tt-smart-details[open]') || []);
    if (openDetails.length) {
        openDetails.forEach(details => details.removeAttribute('open'));
        return true;
    }

    if (state.smartWorkbench?.open) {
        controller.closeSmartWorkbench?.();
        return true;
    }

    if (state.selectedSlotId || state.inspectorOpen) {
        state.selectedSlotId = '';
        state.inspectorOpen = false;
        controller.render?.();
        return true;
    }

    return true;
}

function sourceEditorDraftValues(clause = {}, key = '') {
    const scope = clause.scope || {};
    const parameters = clause.parameters || {};
    return [...new Set([
        ...(Array.isArray(scope[key]) ? scope[key] : []),
        ...(Array.isArray(parameters[key]) ? parameters[key] : []),
    ].map(String).filter(Boolean))];
}

function deriveSourceEditorClassIds(project = {}, clause = {}) {
    const scopeKind = clause.scope?.kind || clause.parameters?.scopeQualifier || 'unresolved';
    const classes = project.classes || [];
    const knownClassIds = new Set(classes.map(item => String(item.id)));
    const existingClassIds = sourceEditorDraftValues(clause, 'classIds').filter(id => knownClassIds.has(id));
    const gradeNames = new Set(sourceEditorDraftValues(clause, 'gradeNames'));
    const teacherIds = new Set(sourceEditorDraftValues(clause, 'teacherIds'));
    const targetIds = new Set((clause.object?.matchedIds || clause.target?.matchedIds || []).map(String));
    const offeringClassIds = [...new Set((project.lessonPlans || [])
        .filter(plan => (
            (!targetIds.size || targetIds.has(String(plan.subjectId)))
            && (!teacherIds.size || teacherIds.has(String(plan.teacherId)))
        ))
        .map(plan => String(plan.classId))
        .filter(id => knownClassIds.has(id)))];
    if (scopeKind === 'explicit_classes') return existingClassIds;
    if (scopeKind === 'grade_classes') {
        return classes.filter(item => gradeNames.has(String(item.grade))).map(item => String(item.id));
    }
    if (['teacher_covered_classes', 'subject_offering_classes', 'school'].includes(scopeKind)) {
        return offeringClassIds.length ? offeringClassIds : existingClassIds;
    }
    return existingClassIds;
}

function refreshSourceRequirementScopePreview(preview, clauseNode, state = {}) {
    const index = Number.parseInt(clauseNode?.dataset?.sourceClauseIndex, 10);
    const clause = state.constraintDialog?.editingSourceRequirement?.clauses?.[index];
    if (!clause) return;
    const classIds = deriveSourceEditorClassIds(state.project || {}, clause);
    const classesById = new Map((state.project?.classes || []).map(item => [String(item.id), item]));
    const names = classIds.slice(0, 6).map(id => {
        const item = classesById.get(String(id));
        return item ? [item.grade, item.name].filter(Boolean).join('') : id;
    });
    preview.textContent = `当前派生范围：${classIds.length} 个班级${names.length ? ` · ${names.join('、')}` : ''}`;
}

function bindDelegatedInteractions(container) {
    if (container.__ttDelegatedInteractionsBound) return;
    container.__ttDelegatedInteractionsBound = true;

    container.addEventListener('click', event => {
        const controller = container.__ttController;
        const state = container.__ttState;
        if (!controller || !state) return;

        const typePicker = event.target.closest?.('[data-constraint-rule-type-picker]') || null;
        const typeOption = event.target.closest?.('[data-constraint-rule-type-option]') || null;
        const typeTrigger = event.target.closest?.('[data-constraint-rule-type-trigger]') || null;
        const helpToggle = event.target.closest?.('[data-constraint-rule-help-toggle]') || null;
        const openTypePicker = container.querySelector?.('[data-constraint-rule-type-picker].is-open') || null;
        if (openTypePicker && !typePicker && !helpToggle) closeRuleTypePicker(openTypePicker);
        const visibleTypeHelp = container.querySelector?.('[data-constraint-rule-type-help]:not([hidden])') || null;
        if (visibleTypeHelp && !event.target.closest?.('.tt-constraint-rule-type-field')) {
            hideRuleTypeHelp(visibleTypeHelp.closest?.('[data-constraint-rule-type-picker]'));
            visibleTypeHelp.closest?.('.tt-constraint-rule-type-field')
                ?.querySelector?.('[data-constraint-rule-help-toggle]')
                ?.setAttribute('aria-expanded', 'false');
        }

        if (typeOption && typePicker) {
            event.preventDefault?.();
            event.stopPropagation?.();
            commitRuleTypePickerSelection(controller, typePicker, typeOption.dataset.constraintRuleType || '');
            return;
        }
        if (typeTrigger && typePicker) {
            event.preventDefault?.();
            event.stopPropagation?.();
            if (typePicker.classList.contains('is-open')) {
                closeRuleTypePicker(typePicker, { restoreFocus: true });
            } else {
                openRuleTypePicker(typePicker);
            }
            return;
        }
        if (helpToggle) {
            const field = helpToggle.closest?.('.tt-constraint-rule-type-field');
            const picker = field?.querySelector?.('[data-constraint-rule-type-picker]') || null;
            const { input, help } = ruleTypePickerElements(picker);
            event.preventDefault?.();
            event.stopPropagation?.();
            if (!picker || !input || !help) return;
            if (help.hidden) {
                showRuleTypeHelp(picker, input.value || '');
                helpToggle.setAttribute('aria-expanded', 'true');
            } else {
                hideRuleTypeHelp(picker);
                helpToggle.setAttribute('aria-expanded', 'false');
            }
            return;
        }

        // 点击背景遮罩关闭弹窗
        if (event.target.matches('[data-smart-helper-overlay]')) {
            controller.closeSmartHelper();
            return;
        }
        if (event.target.matches('[data-smart-detail-backdrop]')) {
            controller.closeProblemDetails();
            return;
        }
        if (
            state.rangePopover
            && !event.target.closest('[data-range-popover-panel]')
            && !event.target.closest('[data-range-popover-trigger]')
        ) {
            controller.closeRangePopover?.();
            return;
        }
        if (event.target.matches('[data-constraint-chat-overlay]')) {
            controller.closeConstraintChat();
            return;
        }
        if (event.target.matches('[data-constraint-dialog-overlay]')) {
            controller.closeConstraintDialog();
            return;
        }
        if (event.target.matches('[data-constraint-edit-backdrop]')) {
            controller.cancelEditConstraint?.();
            return;
        }
        if (event.target.matches('[data-duty-assignment-overlay]')) {
            controller.closeDutyAssignmentDialog?.();
            return;
        }
        if (event.target.matches('[data-roster-issue-editor-overlay]')) {
            controller.closeRosterIssueEditor?.();
            return;
        }
        if (event.target.matches('[data-roster-append-overlay]')) {
            controller.closeRosterAppendDialog?.();
            return;
        }
        if (event.target.matches('[data-duty-teacher-search]')) {
            controller.openDutyTeacherOptions?.();
        }
        if (
            state.constraintDialog?.sidebarMenuOpen
            && !event.target.closest?.('.tt-smart-helper-entry-shell')
        ) {
            closeConstraintSidebarMenu(container, state);
        }
        if (
            state.constraintFulfillmentFilterMenuOpen
            && !event.target.closest?.('.tt-constraint-fulfillment-status-menu')
        ) {
            closeConstraintFulfillmentFilterMenu(container, state);
        }
        const actionNode = event.target.closest('[data-action]');
        const action = actionNode?.dataset.action || '';

        // 移动端抽屉actions
        if (action === 'open-mobile-drawer') {
            controller.mobileDrawer?.openDrawer('half');
        } else if (action === 'close-mobile-drawer') {
            controller.mobileDrawer?.closeDrawer();
        }
        // 智能助手actions
        else if (action === 'apply-fix') {
            const problemId = event.target.closest('[data-problem-id]')?.dataset.problemId;
            controller.applySingleFix(problemId);
        } else if (action === 'expand-inspector-issue-group' || action === 'collapse-inspector-issue-group') {
            if (updateInspectorIssueLimit(action, event.target, controller, state)) {
                event.preventDefault?.();
                event.stopPropagation?.();
            }
        } else if (action === 'toggle-constraint-fulfillment-filter-menu') {
            state.constraintFulfillmentFilterMenuOpen = !state.constraintFulfillmentFilterMenuOpen;
            controller.render?.();
            if (state.constraintFulfillmentFilterMenuOpen) {
                container.querySelector?.('.tt-constraint-fulfillment-status-options:not([hidden]) [role="menuitemradio"]')?.focus?.();
            }
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'toggle-constraint-fulfillment-row') {
            toggleConstraintFulfillmentRow(
                container,
                controller,
                state,
                actionNode?.dataset.constraintFulfillmentRow || '',
            );
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'filter-constraint-fulfillment') {
            const filter = actionNode?.dataset.constraintFulfillmentFilter || 'attention';
            state.constraintFulfillmentFilter = filter;
            state.constraintFulfillmentFilterMenuOpen = false;
            const expandedId = state.constraintFulfillmentExpandedRowId || '';
            const expandedItem = (state.constraintFulfillment?.items || [])
                .find(item => String(item.id || item.ruleId || '') === String(expandedId));
            if (expandedItem && !fulfillmentItemVisibleForFilter(expandedItem, filter)) {
                state.constraintFulfillmentExpandedRowId = '';
            }
            rerenderConstraintFulfillmentPreservingScroll(container, controller, state.constraintFulfillmentExpandedRowId);
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'open-solver-review') {
            state.inspectorOpen = true;
            state.inspectorDismissed = false;
            controller.render?.();
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'close-inspector') {
            state.inspectorOpen = false;
            state.inspectorDismissed = true;
            state.inspectorDragging = false;
            state.inspectorResizing = false;
            controller.render?.();
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'constraint-fulfillment-suggestion') {
            controller.handleConstraintFulfillmentSuggestion?.(
                actionNode?.dataset.constraintFulfillmentRow || '',
                actionNode?.dataset.constraintFulfillmentSuggestion || '',
            );
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'locate-inspector-issue') {
            const locatePayload = {
                ...(actionNode?.dataset || {}),
                ...captureInspectorLocateAnchor(actionNode),
            };
            if (controller.locateInspectorIssue?.(locatePayload)) {
                event.preventDefault?.();
                event.stopPropagation?.();
            }
        } else if (action === 'apply-all-fixes') {
            controller.applyAllFixes();
        } else if (action === 'view-problem-details') {
            const problemId = event.target.closest('[data-problem-id]')?.dataset.problemId;
            controller.viewProblemDetails(problemId);
        } else if (action === 'close-problem-detail') {
            controller.closeProblemDetails();
        } else if (action === 'confirm-fix') {
            const problemId = event.target.closest('[data-problem-id]')?.dataset.problemId;
            controller.confirmApplyFix(problemId);
        } else if (action === 'close-smart-helper') {
            controller.closeSmartHelper();
        } else if (action === 'rescan-smart-helper') {
            controller.rescanConstraints();
        } else if (action === 'open-ai-chat') {
            controller.openAIChatFromHelper(event.target.closest('[data-problem-id]')?.dataset.problemId || '');
        } else if (action === 'toggle-group') {
            const groupId = event.target.closest('[data-group]')?.dataset.group;
            controller.toggleProblemGroup(groupId);
        } else if (action === 'close-preview') {
            controller.state.fixPreview = null;
            controller.render();
        } else if (action === 'discuss-with-ai') {
            controller.openAIChatFromHelper(event.target.closest('[data-problem-id]')?.dataset.problemId || '');
        }
        // 原有actions
        else if (action === 'submit-rule-clarification') {
            controller.submitClarifyingAnswers();
        } else if (action === 'rule-task-select') {
            controller.selectRuleReviewTask(event.target.closest('[data-rule-task-id]')?.dataset.ruleTaskId || '');
        } else if (action === 'rule-task-explain') {
            controller.explainRuleReviewTask(event.target.closest('[data-rule-task-id]')?.dataset.ruleTaskId || '');
        } else if (action === 'rule-task-preview-fix') {
            controller.previewRuleReviewTaskFix(event.target.closest('[data-rule-task-id]')?.dataset.ruleTaskId || '');
        } else if (action === 'rule-card-edit') {
            controller.editRuleReviewRow(event.target.closest('[data-rule-id]')?.dataset.ruleId || '');
        } else if (action === 'rule-card-ignore') {
            controller.ignoreRuleReviewRow(event.target.closest('[data-rule-id]')?.dataset.ruleId || '');
        } else if (action === 'rule-card-delete') {
            controller.deleteRuleReviewCard(event.target.closest('[data-rule-id]')?.dataset.ruleId || '');
        } else if (action === 'rule-card-effective') {
            controller.markRuleReviewRowEffective(event.target.closest('[data-rule-id]')?.dataset.ruleId || '');
        } else if (action === 'rule-review-toggle-advanced') {
            controller.toggleRuleReviewAdvanced();
        } else if (action === 'diagnose-rules') {
            controller.diagnoseRules();
        } else if (action === 'constraint-chat-start') {
            controller.startConstraintConversation();
        } else if (action === 'constraint-chat-send') {
            controller.sendConstraintChatMessage(container.querySelector('[data-constraint-chat-input]')?.value || '');
        } else if (action === 'constraint-chat-suggest') {
            controller.sendConstraintChatMessage(event.target.closest('[data-constraint-chat-suggest]')?.dataset.constraintChatSuggest || '');
        } else if (action === 'constraint-chat-close') {
            controller.closeConstraintChat();
        }
        // 智能约束弹窗actions
        else if (action === 'toggle-constraint-sidebar-menu') {
            state.constraintDialog = {
                ...(state.constraintDialog || {}),
                sidebarMenuOpen: state.constraintDialog?.sidebarMenuOpen !== true,
            };
            const opening = state.constraintDialog.sidebarMenuOpen;
            controller.render();
            if (opening && typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => container.querySelector?.('.tt-smart-helper-menu [role="menuitem"]')?.focus?.());
            }
        } else if (action === 'reenter-constraint-input') {
            state.constraintDialog = {
                ...(state.constraintDialog || {}),
                sidebarMenuOpen: false,
                inputExpanded: true,
                agentConversationExpanded: true,
            };
            controller.openConstraintDialog();
        } else if (action === 'clear-applied-constraints') {
            closeConstraintSidebarMenu(container, state);
            controller.clearRules();
        } else if (action === 'open-constraint-dialog') {
            controller.openConstraintDialog();
        } else if (action === 'close-constraint-dialog') {
            controller.closeConstraintDialog();
        } else if (action === 'switch-constraint-mode') {
            const mode = event.target.closest('[data-mode]')?.dataset.mode;
            controller.switchConstraintMode(mode);
        } else if (action === 'toggle-constraint-agent-conversation') {
            controller.toggleConstraintAgentConversation();
        } else if (action === 'parse-constraints') {
            controller.parseConstraintsFromDialog();
        } else if (action === 'expand-constraint-input') {
            controller.expandConstraintInput();
        } else if (action === 'reparse-constraint-input') {
            controller.reparseConstraintInput();
        } else if (action === 'rebind-constraint-entities') {
            controller.rebindConstraintEntities();
        } else if (action === 'open-roster-for-constraint-binding') {
            controller.openRosterImport?.('file');
        } else if (action === 'add-manual-constraint') {
            controller.addManualConstraint();
        } else if (action === 'apply-education-soft-template') {
            const templateKey = event.target.closest('[data-education-template]')?.dataset.educationTemplate;
            controller.applyEducationSoftRuleTemplate(templateKey);
        } else if (action === 'filter-requirements') {
            const filter = event.target.closest('[data-requirement-filter]')?.dataset.requirementFilter;
            controller.filterRequirements(filter);
        } else if (action === 'select-requirement') {
            const requirementId = event.target.closest('[data-requirement-id]')?.dataset.requirementId;
            controller.selectRequirement(requirementId);
        } else if (action === 'toggle-technical-details') {
            const requirementId = event.target.closest('[data-requirement-id]')?.dataset.requirementId;
            controller.toggleRequirementTechnicalDetails(requirementId);
        } else if (action === 'toggle-system-group') {
            controller.toggleSystemRequirementGroup();
        } else if (action === 'submit-requirement-clarification') {
            const requirementId = event.target.closest('[data-requirement-id]')?.dataset.requirementId;
            const clarifyValue = event.target.closest('[data-clarify-value]')?.dataset.clarifyValue;
            controller.submitRequirementClarification(requirementId, clarifyValue);
        } else if (action === 'toggle-constraint-apply-item') {
            const applyItemNode = event.target.closest('[data-apply-item-key]');
            controller.toggleConstraintApplyItem(
                applyItemNode?.dataset.applyItemKey,
                applyItemNode?.dataset.requirementId,
            );
        } else if (action === 'delete-constraint') {
            const constraintId = event.target.closest('[data-constraint-id]')?.dataset.constraintId;
            controller.deleteConstraint(constraintId);
        } else if (action === 'clear-all-constraints') {
            controller.clearAllConstraints();
        } else if (action === 'apply-constraints') {
            controller.applyConstraintsFromDialog();
        }
        // 附加时段值班编辑
        else if (action === 'edit-duty-assignment') {
            const node = event.target.closest('[data-time-block-id]');
            controller.openDutyAssignmentDialog?.(node?.dataset.day, node?.dataset.timeBlockId);
        } else if (action === 'select-duty-teacher') {
            event.preventDefault?.();
            event.stopPropagation?.();
            const option = event.target.closest('[data-duty-teacher-option]');
            controller.selectDutyTeacherOption?.(option?.dataset.dutyTeacherOption || '', option);
        } else if (action === 'save-duty-assignment') {
            controller.saveDutyAssignmentDialog?.();
        } else if (action === 'clear-duty-assignment') {
            controller.clearDutyAssignmentDialog?.();
        } else if (action === 'close-duty-assignment') {
            controller.closeDutyAssignmentDialog?.();
        }
        // 约束编辑actions
        else if (action === 'edit-constraint') {
            const constraintId = event.target.closest('[data-constraint-id]')?.dataset.constraintId;
            controller.editConstraint(constraintId);
        } else if (action === 'save-edit-constraint') {
            controller.saveEditedConstraint();
        } else if (action === 'cancel-edit-constraint') {
            controller.cancelEditConstraint();
        } else if (action === 'edit-source-requirement') {
            const sourceId = event.target.closest('[data-source-id]')?.dataset.sourceId;
            controller.editSourceRequirement(sourceId);
        } else if (action === 'save-source-requirement-edit') {
            controller.saveSourceRequirementEdit();
        } else if (action === 'cancel-source-requirement-edit') {
            controller.cancelSourceRequirementEdit();
        }
        // AI 对话actions
        else if (action === 'start-ai-chat') {
            controller.startConstraintAIChat();
        } else if (action === 'send-ai-message') {
            const input = container.querySelector('#tt-ai-chat-input');
            controller.sendConstraintAIMessage(input?.value || '');
        } else if (action === 'close-ai-chat') {
            controller.closeConstraintAIChat();
        } else if (action === 'use-ai-prompt') {
            const prompt = event.target.closest('[data-prompt]')?.dataset.prompt;
            controller.useAISuggestedPrompt(prompt);
        } else if (action === 'constraint-chat-apply-preview') {
            controller.applyConstraintChatPreview();
        } else if (action === 'constraint-chat-dismiss-preview') {
            controller.dismissConstraintChatPreview();
        } else if (action === 'timetable-agent-start') {
            controller.startTimetableAgentSession();
        } else if (action === 'timetable-agent-send') {
            controller.sendTimetableAgentMessage();
        } else if (action === 'timetable-agent-run') {
            controller.runTimetableAgent();
        } else if (action === 'timetable-agent-answer') {
            controller.answerTimetableAgentQuestions();
        } else if (action === 'timetable-agent-approve') {
            controller.approveTimetableAgentAction(event.target.closest('[data-agent-action-id]')?.dataset.agentActionId, true);
        } else if (action === 'timetable-agent-reject') {
            controller.approveTimetableAgentAction(event.target.closest('[data-agent-action-id]')?.dataset.agentActionId, false);
        } else if (action === 'timetable-agent-reset') {
            controller.resetTimetableAgentSession();
        } else if (action === 'timetable-agent-quick') {
            controller.sendTimetableAgentMessage(event.target.closest('[data-agent-prompt]')?.dataset.agentPrompt || '');
        } else if (action === 'constraint-agent-start') {
            controller.startConstraintIntakeAgentSession();
        } else if (action === 'constraint-agent-send') {
            controller.sendConstraintIntakeAgentMessage();
        } else if (action === 'constraint-agent-confirm') {
            controller.confirmConstraintIntakeAgent();
        } else if (action === 'constraint-agent-apply') {
            controller.applyConstraintIntakeAgent();
        } else if (action === 'constraint-agent-solve') {
            controller.solveConstraintIntakeAgent();
        } else if (action === 'generate-period-times') {
            controller.updateSegmentConfigFromForm();
        } else if (action === 'auto-fill-period-times' || action === 'reset-period-time-settings') {
            controller.autoFillPeriodTimes();
        } else {
            const slotNode = event.target.closest('.tt-slot');
            if (slotNode && container.contains(slotNode)) {
                state.selectedSlotId = slotNode.dataset.slotId;
                state.inspectorDismissed = false;
                controller.render();
            }
        }

        if (event.target.closest('[data-segment-template]')) {
            const templateName = event.target.closest('[data-segment-template]').dataset.segmentTemplate;
            controller.applySegmentTemplate(templateName);
        }
        if (event.target.closest('[data-add-segment]')) {
            controller.addPeriodTimeSegment();
        }
        if (event.target.closest('[data-remove-segment]')) {
            const segmentId = event.target.closest('[data-remove-segment]').dataset.removeSegment;
            controller.removePeriodTimeSegment(segmentId);
        }
    });

    container.addEventListener('pointerover', event => {
        const picker = event.target.closest?.('[data-constraint-rule-type-picker].is-open');
        const option = event.target.closest?.('[data-constraint-rule-type-option]');
        if (!picker || !option || isCompactRuleTypePickerViewport()) return;
        setActiveRuleTypeOption(picker, option, { showHelp: true });
    });

    container.addEventListener('change', event => {
        const controller = container.__ttController;
        if (!controller) return;
        if (event.target.matches('[data-source-field], [data-source-rationale-index]')) {
            controller.updateSourceRequirementDraftFromDom?.();
        }
        if (event.target.matches('[data-source-field="scopeKind"]')) {
            const clause = event.target.closest?.('[data-source-clause-index]');
            const visibleFields = new Set({
                explicit_classes: ['classIds'],
                grade_classes: ['gradeNames'],
                teacher_covered_classes: ['teacherIds'],
            }[event.target.value] || []);
            clause?.querySelectorAll?.('[data-source-scope-field]').forEach(field => {
                const visible = visibleFields.has(field.dataset.sourceScopeField || '');
                field.hidden = !visible;
                field.setAttribute('aria-hidden', visible ? 'false' : 'true');
            });
            const preview = clause?.querySelector?.('.tt-source-derived-preview');
            if (preview) refreshSourceRequirementScopePreview(preview, clause, controller.state);
        } else if (event.target.matches('[data-source-field="targetIds"], [data-source-field="classIds"], [data-source-field="teacherIds"], [data-source-field="gradeNames"]')) {
            const clause = event.target.closest?.('[data-source-clause-index]');
            const preview = clause?.querySelector?.('.tt-source-derived-preview');
            if (preview) refreshSourceRequirementScopePreview(preview, clause, controller.state);
        } else if (event.target.matches('[data-segment-field], [data-global-default-field]')) {
            controller.updateSegmentConfigFromForm();
        } else if (event.target.matches('[data-period-time-setting]')) {
            controller.updatePeriodTimeSettingsFromForm();
        } else if (event.target.matches('[data-period-time-gap-after]')) {
            controller.updatePeriodTimeGapFromDom(event.target);
        } else if (event.target.matches('[data-period-time-block-gap-after]')) {
            controller.updatePeriodTimeBlockGapFromDom(event.target);
        } else if (event.target.matches('[data-period-time-block-start], [data-period-time-block-end]')) {
            controller.updatePeriodTimeBlockFromDom(event.target);
        } else if (event.target.matches('[data-period-time-draft-start], [data-period-time-draft-end], [data-period-time-start], [data-period-time-end]')) {
            controller.readPeriodTimesFromDom();
            controller.refreshPeriodTimeGapInputsFromDom();
        } else if (event.target.matches('#tt-constraint-file-input')) {
            controller.handleConstraintFileSelect(event);
        } else if (event.target.matches('[data-rule-field]')) {
            const field = event.target.dataset.ruleField || '';
            controller.updateEditingConstraintDraftFromDom?.({
                rerender: ['targetValue', 'scopeMode', 'scopeClassId', 'restrictTeacher'].includes(field),
            });
        }
    });

    container.addEventListener('input', event => {
        const controller = container.__ttController;
        if (!controller) return;
        if (event.target.matches('[data-source-field], [data-source-rationale-index]')) {
            controller.updateSourceRequirementDraftFromDom?.();
        }
        if (event.target.matches('[data-segment-field], [data-global-default-field]')) {
            controller.updateSegmentConfigFromForm();
        } else if (event.target.matches('[data-period-time-setting]')) {
            controller.updatePeriodTimeSettingsFromForm();
        } else if (event.target.matches('[data-period-time-gap-after]')) {
            controller.updatePeriodTimeGapFromDom(event.target);
        } else if (event.target.matches('[data-period-time-block-gap-after]')) {
            controller.updatePeriodTimeBlockGapFromDom(event.target);
        } else if (event.target.matches('[data-period-time-block-start], [data-period-time-block-end]')) {
            controller.updatePeriodTimeBlockFromDom(event.target);
        } else if (event.target.matches('[data-period-time-draft-start], [data-period-time-draft-end], [data-period-time-start], [data-period-time-end]')) {
            controller.readPeriodTimesFromDom();
            controller.refreshPeriodTimeGapInputsFromDom();
        } else if (event.target.matches('[data-constraint-chat-input]')) {
            controller.updateConstraintChatInput(event.target.value);
            resizeConstraintChatInput(event.target);
        } else if (event.target.matches('#tt-constraint-agent-message')) {
            controller.state.constraintAgent = {
                ...(controller.state.constraintAgent || {}),
                input: event.target.value,
            };
        } else if (event.target.matches('[data-duty-teacher-search]')) {
            controller.filterDutyTeacherOptions?.(event.target.value);
        } else if (event.target.matches('#tt-roster-append-text')) {
            controller.updateRosterAppendText?.(event.target.value);
        } else if (event.target.matches('[data-rule-field]')) {
            controller.updateEditingConstraintDraftFromDom?.();
        }
    });

    container.addEventListener('keydown', event => {
        const controller = container.__ttController;

        if (controller && handleRuleTypePickerKeydown(event, controller)) return;

        const sidebarMenu = event.target.closest?.('.tt-smart-helper-menu');
        if (sidebarMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const items = [...sidebarMenu.querySelectorAll?.('[role="menuitem"]') || []]
                .filter(item => !item.disabled);
            if (items.length) {
                event.preventDefault();
                const currentIndex = Math.max(0, items.indexOf(event.target));
                const nextIndex = event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                        ? items.length - 1
                        : event.key === 'ArrowDown'
                            ? (currentIndex + 1) % items.length
                            : (currentIndex - 1 + items.length) % items.length;
                items[nextIndex]?.focus?.();
                return;
            }
        }

        const fulfillmentMenu = event.target.closest?.('.tt-constraint-fulfillment-status-options');
        if (fulfillmentMenu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const items = [...fulfillmentMenu.querySelectorAll?.('[role="menuitemradio"]') || []]
                .filter(item => !item.disabled);
            if (items.length) {
                event.preventDefault();
                const currentIndex = Math.max(0, items.indexOf(event.target));
                const nextIndex = event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                        ? items.length - 1
                        : event.key === 'ArrowDown'
                            ? (currentIndex + 1) % items.length
                            : (currentIndex - 1 + items.length) % items.length;
                items[nextIndex]?.focus?.();
                return;
            }
        }

        const fulfillmentRowToggle = event.target.closest?.('[data-action="toggle-constraint-fulfillment-row"]');
        if (fulfillmentRowToggle && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.stopPropagation();
            toggleConstraintFulfillmentRow(
                container,
                controller,
                container.__ttState,
                fulfillmentRowToggle.dataset.constraintFulfillmentRow || '',
            );
            return;
        }

        const editModal = event.target.closest?.('.tt-constraint-edit-modal');
        if (editModal && event.key === 'Tab') {
            const focusable = [...editModal.querySelectorAll?.('button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])') || []]
                .filter(node => !node.hidden && node.offsetParent !== null);
            if (focusable.length) {
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && event.target === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && event.target === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        }

        if (event.key === 'Escape' && event.target.matches?.('[data-constraint-rule-help-toggle]')) {
            const picker = event.target.closest?.('.tt-constraint-rule-type-field')
                ?.querySelector?.('[data-constraint-rule-type-picker]');
            const { help } = ruleTypePickerElements(picker);
            if (help && !help.hidden) {
                event.preventDefault();
                event.stopPropagation();
                hideRuleTypeHelp(picker);
                event.target.setAttribute('aria-expanded', 'false');
                return;
            }
        }

        if (controller && event.target.matches('[data-duty-teacher-search]')) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                controller.moveDutyTeacherActive?.(1);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                controller.moveDutyTeacherActive?.(-1);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                controller.confirmDutyTeacherActive?.();
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                controller.closeDutyTeacherOptions?.();
                return;
            }
        }

        // Handle Enter in constraint chat
        if (
            controller
            && event.target.matches('[data-constraint-chat-input]')
            && event.key === 'Enter'
            && !event.shiftKey
        ) {
            event.preventDefault();
            controller.sendConstraintChatMessage(event.target.value);
            return;
        }

        if (
            controller
            && event.target.matches('#tt-constraint-agent-message')
            && event.key === 'Enter'
            && !event.shiftKey
        ) {
            event.preventDefault();
            controller.sendConstraintIntakeAgentMessage(event.target.value);
            return;
        }

        // Only handle Escape key for closing dialogs
        if (event.key === 'Escape') {
            handleTimetableEscape(event, container, controller, container.__ttState);
        }
    });

    container.addEventListener('dragstart', event => {
        const state = container.__ttState;
        const slotNode = event.target.closest('.tt-slot');
        if (!state || !slotNode || !container.contains(slotNode)) return;
        state.dragSlotId = slotNode.dataset.slotId;
        state.dragBlockId = slotNode.dataset.blockId || '';
        event.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragover', event => {
        if (event.target.closest('.tt-cell')) {
            event.preventDefault();
        }
    });

    container.addEventListener('dragenter', event => {
        const cell = event.target.closest('.tt-cell');
        if (cell && container.contains(cell)) cell.classList.add('is-drop-target');
    });

    container.addEventListener('dragleave', event => {
        const cell = event.target.closest('.tt-cell');
        if (cell && container.contains(cell)) cell.classList.remove('is-drop-target');
    });

    container.addEventListener('drop', event => {
        const controller = container.__ttController;
        const state = container.__ttState;
        const cell = event.target.closest('.tt-cell');
        if (!controller || !state || !cell || !container.contains(cell)) return;
        event.preventDefault();
        cell.classList.remove('is-drop-target');
        const blockId = state.dragBlockId;
        if (state.dragSlotId) {
            controller.adjustSlot({
                type: 'move',
                slotId: state.dragSlotId,
                day: Number(cell.dataset.day),
                period: Number(cell.dataset.period),
                blockId,
            });
            state.dragSlotId = '';
            state.dragBlockId = '';
        }
    });
}

export function bindRuleReviewInteractions(root, controller) {
    if (!root || !controller) return;
    root.querySelectorAll('[data-rule-example]').forEach(button => {
        button.addEventListener('click', () => controller.fillRuleExample(button.dataset.ruleExample));
    });
    root.querySelectorAll('[data-saved-rule-delete]').forEach(button => {
        button.addEventListener('click', () => controller.removeSavedRule(button.dataset.savedRuleDelete));
    });
    root.querySelector('#tt-rule-review-cancel')?.addEventListener('click', () => controller.closeRuleReview());
    root.querySelector('#tt-rule-review-cancel-secondary')?.addEventListener('click', () => controller.closeRuleReview());
    root.querySelector('#tt-saved-rule-add')?.addEventListener('click', () => controller.startRuleReviewInput('file'));
    root.querySelectorAll('[data-rule-review-mode]').forEach(button => {
        button.addEventListener('click', () => controller.setRuleReviewMode(button.dataset.ruleReviewMode));
    });
    root.querySelector('#tt-rule-review-file')?.addEventListener('change', event => {
        controller.selectRuleReviewFile(event.target.files?.[0] || null);
    });
    root.querySelector('#tt-rule-review-parse')?.addEventListener('click', () => controller.parseRules());
    root.querySelector('#tt-add-manual-rule-rows')?.addEventListener('click', () => controller.addManualRuleRows());
    root.querySelector('#tt-confirm-rule-review')?.addEventListener('click', () => controller.confirmRuleDraft());
    root.querySelector('#tt-apply-auto-rules')?.addEventListener('click', () => controller.applyAutoAcceptableRules());
    root.querySelector('#tt-add-rule-review-row')?.addEventListener('click', () => controller.addRuleReviewRow());
    root.querySelectorAll('[data-rule-review-field]').forEach(input => {
        input.addEventListener('change', () => controller.updateRuleReviewField());
    });
    root.querySelectorAll('[data-rule-review-delete-row]').forEach(button => {
        button.addEventListener('click', () => controller.deleteRuleReviewRow(button.dataset.ruleReviewDeleteRow));
    });
    root.querySelector('#tt-open-smart-helper')?.addEventListener('click', () => controller.openSmartConstraintHelper());
}

function bindRosterReviewAction(container, selector, action) {
    const button = container.querySelector(selector);
    if (!button) return;
    let activatedByPointer = false;
    button.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        activatedByPointer = true;
        event.preventDefault();
        action();
    });
    button.addEventListener('click', event => {
        if (activatedByPointer) {
            event.preventDefault();
            return;
        }
        action();
    });
}

function bindConstraintRuleScopeControls(container, controller, idPrefix, updateScope) {
    const target = container.querySelector(`#${idPrefix}-target`);
    const scopeClass = container.querySelector(`#${idPrefix}-scope-class`);
    const restrictTeacher = container.querySelector(`#${idPrefix}-scope-limit-teacher`);
    const scopeTeacher = container.querySelector(`#${idPrefix}-scope-teacher`);
    if (!target || !updateScope) return;

    target.addEventListener('change', () => updateScope({
        targetValue: target.value,
        scopeClassId: '',
        restrictTeacher: false,
        scopeTeacherId: '',
    }));
    scopeClass?.addEventListener('change', () => updateScope({
        targetValue: target.value,
        scopeClassId: scopeClass.value,
        restrictTeacher: false,
        scopeTeacherId: '',
    }));
    restrictTeacher?.addEventListener('change', () => updateScope({
        targetValue: target.value,
        scopeClassId: scopeClass?.value || '',
        restrictTeacher: Boolean(restrictTeacher.checked),
        scopeTeacherId: restrictTeacher.checked ? (scopeTeacher?.value || '') : '',
    }));
    scopeTeacher?.addEventListener('change', () => updateScope({
        targetValue: target.value,
        scopeClassId: scopeClass?.value || '',
        restrictTeacher: true,
        scopeTeacherId: scopeTeacher.value,
    }));
}

export function bindGridInteractions(container, controller, state) {
    container.__ttController = controller;
    container.__ttState = state;
    bindDelegatedInteractions(container);
    bindInspectorFloatingWindow(container, state);
    bindRuleTypePickerViewportEvents(container);
    bindConstraintRuleScopeControls(
        container,
        controller,
        'tt-manual-rule',
        scope => controller.updateManualConstraintScope?.(scope),
    );
    bindConstraintRuleScopeControls(
        container,
        controller,
        'tt-edit-constraint',
        scope => controller.updateEditingConstraintScope?.(scope),
    );

    container.querySelectorAll('[data-tt-section-toggle]').forEach(button => {
        button.addEventListener('click', () => controller.toggleWorkflowSection(button.dataset.ttSectionToggle));
    });
    container.querySelector('#tt-save-project')?.addEventListener('click', () => controller.saveProject());
    container.querySelectorAll('[data-active-weekday], [data-active-period]').forEach(input => {
        input.addEventListener('change', () => controller.updateRangeDraftFromForm());
    });
    container.querySelectorAll('[data-range-popover-trigger]').forEach(button => {
        button.addEventListener('click', event => {
            event.preventDefault?.();
            event.stopPropagation?.();
            controller.toggleRangePopover?.(button.dataset.rangePopoverTrigger, button);
        });
    });
    container.querySelectorAll('[data-range-preset]').forEach(button => {
        button.addEventListener('click', () => {
            const [kind, preset] = button.dataset.rangePreset.split(':');
            controller.applyRangePreset(kind, preset);
        });
    });
    container.querySelectorAll('[data-bulk-day], [data-bulk-period]').forEach(input => {
        input.addEventListener('change', () => controller.updateBulkRuleDraftFromForm());
    });
    container.querySelectorAll('[data-bulk-preset]').forEach(button => {
        button.addEventListener('click', () => {
            const [kind, preset] = button.dataset.bulkPreset.split(':');
            controller.applyBulkPreset(kind, preset);
        });
    });
    container.querySelectorAll('[data-range-apply]').forEach(button => {
        button.addEventListener('click', () => {
            button.closest('details')?.removeAttribute('open');
            controller.applyRangeDraft();
        });
    });
    container.querySelector('#tt-open-period-time-dialog')?.addEventListener('click', () => controller.openPeriodTimeDialog());
    container.querySelector('#tt-clear-period-times')?.addEventListener('click', () => controller.clearPeriodTimes());
    container.querySelector('#tt-save-period-times')?.addEventListener('click', () => controller.savePeriodTimes());
    container.querySelector('#tt-cancel-period-times')?.addEventListener('click', () => controller.closePeriodTimeDialog());
    container.querySelector('#tt-cancel-period-times-secondary')?.addEventListener('click', () => controller.closePeriodTimeDialog());
    container.querySelectorAll('[data-tt-popover-close]').forEach(button => {
        button.addEventListener('click', () => button.closest('details')?.removeAttribute('open'));
    });
    container.querySelectorAll('[data-range-popover-close]').forEach(button => {
        button.addEventListener('click', () => controller.closeRangePopover?.());
    });
    container.querySelectorAll('[data-roster-import-trigger]').forEach(button => {
        button.addEventListener('click', () => controller.openRosterImport('file'));
    });
    container.querySelector('#tt-reopen-roster-import')?.addEventListener('click', () => controller.openRosterImport('file'));
    container.querySelector('#tt-edit-roster')?.addEventListener('click', () => controller.openRosterEditor());
    container.querySelector('#tt-fill-roster-sample')?.addEventListener('click', () => controller.fillSample());
    container.querySelectorAll('[data-roster-import-submit]').forEach(button => {
        button.addEventListener('click', () => controller.previewRosterImport(button.dataset.rosterImportSubmit));
    });
    container.querySelector('#tt-resume-roster-review')?.addEventListener('click', () => controller.resumeRosterReview());
    container.querySelector('#tt-start-empty-roster-review')?.addEventListener('click', () => controller.startEmptyRosterReview());
    bindRosterReviewAction(container, '#tt-confirm-roster-import', () => controller.confirmRosterImport());
    bindRosterReviewAction(container, '#tt-back-roster-import', () => controller.returnToRosterImportInput());
    bindRosterReviewAction(container, '#tt-cancel-roster-import', () => controller.closeRosterImport());
    bindRosterReviewAction(container, '#tt-cancel-roster-import-secondary', () => controller.closeRosterImport());
    bindRosterReviewAction(container, '#tt-open-roster-append', () => controller.openRosterAppendDialog());
    bindRosterReviewAction(container, '#tt-close-roster-append', () => controller.closeRosterAppendDialog());
    bindRosterReviewAction(container, '#tt-cancel-roster-append', () => controller.closeRosterAppendDialog());
    bindRosterReviewAction(container, '#tt-submit-roster-append', () => controller.appendRosterReviewRows());
    container.querySelector('#tt-roster-import-file')?.addEventListener('change', event => {
        controller.selectRosterImportFile(event.target.files?.[0] || null);
    });
    container.querySelectorAll('[data-roster-sheet-toggle]').forEach(input => {
        input.addEventListener('change', () => controller.toggleRosterSheet(
            input.dataset.rosterSheetToggle || '',
            Boolean(input.checked),
        ));
    });
    container.querySelectorAll('[data-roster-field]').forEach(input => {
        input.addEventListener('change', () => controller.updateRosterReviewField());
    });
    container.querySelectorAll('[data-roster-delete-row]').forEach(button => {
        button.addEventListener('click', () => controller.deleteRosterReviewRow(button.dataset.rosterDeleteRow));
    });
    container.querySelectorAll('[data-roster-toggle-issues]').forEach(button => {
        button.addEventListener('click', () => controller.toggleRosterIssueList());
    });
    container.querySelectorAll('[data-roster-edit-issue-row]').forEach(button => {
        button.addEventListener('click', () => controller.openRosterIssueEditor(
            button.dataset.rosterEditIssueRow || '',
            button.dataset.rosterEditIssueField || '',
        ));
    });
    container.querySelector('#tt-close-roster-issue-editor')?.addEventListener('click', () => controller.closeRosterIssueEditor());
    container.querySelector('#tt-cancel-roster-issue-editor')?.addEventListener('click', () => controller.closeRosterIssueEditor());
    container.querySelector('#tt-roster-issue-prev')?.addEventListener('click', () => controller.openAdjacentRosterIssue('previous'));
    container.querySelector('#tt-roster-issue-next')?.addEventListener('click', () => controller.openAdjacentRosterIssue('next'));
    container.querySelector('#tt-save-roster-issue-editor')?.addEventListener('click', button => controller.applyRosterIssueEditor({
        advance: button.currentTarget?.dataset?.rosterIssueSaveMode === 'next',
    }));
    container.querySelector('#tt-roster-issue-locate-original')?.addEventListener('click', () => controller.locateRosterIssueFromEditor());
    container.querySelectorAll('[data-roster-issue-quick-fix]').forEach(button => {
        button.addEventListener('click', () => controller.applyRosterIssueQuickFix(button.dataset.rosterIssueQuickFix || ''));
    });
    container.querySelectorAll('[data-roster-jump-row]:not(#tt-roster-issue-locate-original)').forEach(button => {
        button.addEventListener('click', () => controller.locateRosterIssue(
            button.dataset.rosterJumpRow || '',
            button.dataset.rosterJumpField || '',
        ));
    });
    bindRosterReviewAction(container, '#tt-add-roster-review-row', () => controller.addRosterReviewRow());
    container.querySelector('#tt-clear-roster')?.addEventListener('click', () => controller.clearRoster());
    container.querySelector('#tt-save-rules')?.addEventListener('click', () => controller.saveRules());

    // #tt-open-rule-review 已改用 data-action="open-constraint-dialog" 方式，不再需要单独绑定
    container.querySelector('#tt-reparse-rule-review')?.addEventListener('click', () => controller.startRuleReviewInput('file'));
    container.querySelector('#tt-clear-rules')?.addEventListener('click', () => controller.clearRules());
    bindRuleReviewInteractions(container, controller);

    container.querySelectorAll('#tt-run-schedule, [data-run-schedule]').forEach(button => {
        button.addEventListener('click', () => controller.runSchedule());
    });

    container.querySelector('#tt-owner-select')?.addEventListener('change', event => {
        state.selectedOwnerId = event.target.value;
        state.selectedSlotId = '';
        controller.render();
    });

    container.querySelectorAll('[data-view-mode]').forEach(button => {
        button.addEventListener('click', () => {
            state.viewMode = button.dataset.viewMode;
            state.selectedSlotId = '';
            controller.render();
        });
    });

    container.querySelectorAll('[data-remove-lock]').forEach(button => {
        button.addEventListener('click', () => controller.removeLockedSlot(Number(button.dataset.removeLock)));
    });

    container.querySelectorAll('[data-export-week-view]').forEach(button => {
        button.addEventListener('click', () => {
            state.exportWeekView = ['odd', 'even'].includes(button.dataset.exportWeekView)
                ? button.dataset.exportWeekView
                : 'merged';
            controller.render();
        });
    });

    container.querySelectorAll('[data-export-type]').forEach(button => {
        button.addEventListener('click', () => controller.export(button.dataset.exportType, {
            weekView: state.exportWeekView || 'merged',
        }));
    });
    container.querySelectorAll('[data-export-history-type]').forEach(button => {
        button.addEventListener('click', () => controller.export(button.dataset.exportHistoryType, {
            publishedVersion: button.dataset.exportHistoryVersion,
            weekView: state.exportWeekView || 'merged',
        }));
    });
    container.querySelector('#tt-publish-schedule')?.addEventListener('click', () => controller.openPublishDialog());
    container.querySelector('#tt-publish-note')?.addEventListener('input', () => controller.updatePublishNote());
    container.querySelector('#tt-confirm-publish')?.addEventListener('click', () => controller.confirmPublishSchedule());
    container.querySelector('#tt-cancel-publish')?.addEventListener('click', () => controller.closePublishDialog());
    container.querySelector('#tt-cancel-publish-secondary')?.addEventListener('click', () => controller.closePublishDialog());
    container.querySelectorAll('[data-publication-history-version]').forEach(button => {
        button.addEventListener('click', () => controller.openPublicationHistoryDialog(button.dataset.publicationHistoryVersion));
    });
    container.querySelector('#tt-restore-publication-history')?.addEventListener('click', event => {
        controller.openRestoreDialog('history', event.currentTarget.dataset.restorePublicationVersion);
    });
    container.querySelectorAll('[data-restore-published-snapshot]').forEach(button => {
        button.addEventListener('click', () => controller.openRestoreDialog('latest', button.dataset.restorePublishedVersion));
    });
    container.querySelector('#tt-confirm-restore')?.addEventListener('click', () => controller.confirmRestoreSchedule());
    container.querySelector('#tt-cancel-restore')?.addEventListener('click', () => controller.closeRestoreDialog());
    container.querySelector('#tt-cancel-restore-secondary')?.addEventListener('click', () => controller.closeRestoreDialog());
    container.querySelector('#tt-close-publication-history')?.addEventListener('click', () => controller.closePublicationHistoryDialog());
    container.querySelector('#tt-close-publication-history-secondary')?.addEventListener('click', () => controller.closePublicationHistoryDialog());

    container.querySelector('#tt-lock-selected')?.addEventListener('click', () => {
        const slot = state.project?.schedule?.slots?.find(item => item.id === state.selectedSlotId);
        controller.adjustSlot({ type: 'lock', slotId: state.selectedSlotId, locked: !slot?.locked });
    });

    container.querySelector('#tt-clear-selected')?.addEventListener('click', () => {
        controller.adjustSlot({ type: 'clear', slotId: state.selectedSlotId });
    });
}
