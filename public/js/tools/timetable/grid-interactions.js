function resizeConstraintChatInput(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}

export const INSPECTOR_POSITION_STORAGE_KEY = 'timetable.inspector.position.v1';
const INSPECTOR_FLOATING_BREAKPOINT = 980;
const INSPECTOR_POSITION_MARGIN = 12;
const INSPECTOR_DRAG_THRESHOLD = 4;
const INSPECTOR_ISSUE_DEFAULT_LIMIT = 5;
const INSPECTOR_ISSUE_LIMIT_STEP = 20;

function roundedFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : null;
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
        let moved = false;

        const cleanup = () => {
            ownerDocument.removeEventListener('pointermove', onPointerMove);
            ownerDocument.removeEventListener('pointerup', onPointerUp);
            ownerDocument.removeEventListener('pointercancel', onPointerUp);
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
                inspectorViewportSize(),
                { width: rect.width, height: rect.height },
            );
            state.inspectorPosition = clamped;
            applyInspectorPosition(inspector, clamped);
        };

        const onPointerUp = () => {
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

        ownerDocument.addEventListener('pointermove', onPointerMove);
        ownerDocument.addEventListener('pointerup', onPointerUp, { once: true });
        ownerDocument.addEventListener('pointercancel', onPointerUp, { once: true });
    });
}

export function handleTimetableEscape(event, container, controller, state) {
    if (event?.key !== 'Escape') return false;

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

function bindDelegatedInteractions(container) {
    if (container.__ttDelegatedInteractionsBound) return;
    container.__ttDelegatedInteractionsBound = true;

    container.addEventListener('click', event => {
        const controller = container.__ttController;
        const state = container.__ttState;
        if (!controller || !state) return;

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
        } else if (action === 'filter-constraint-fulfillment') {
            const filter = actionNode?.dataset.constraintFulfillmentFilter || 'attention';
            state.constraintFulfillmentFilter = filter;
            controller.render?.();
            event.preventDefault?.();
            event.stopPropagation?.();
        } else if (action === 'rerun-constraint-fulfillment') {
            controller.runSchedule?.();
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
        else if (action === 'open-constraint-dialog') {
            controller.openConstraintDialog();
        } else if (action === 'close-constraint-dialog') {
            controller.closeConstraintDialog();
        } else if (action === 'switch-constraint-mode') {
            const mode = event.target.closest('[data-mode]')?.dataset.mode;
            controller.switchConstraintMode(mode);
        } else if (action === 'parse-constraints') {
            controller.parseConstraintsFromDialog();
        } else if (action === 'rebind-constraint-entities') {
            controller.rebindConstraintEntities();
        } else if (action === 'open-roster-for-constraint-binding') {
            controller.openRosterImport?.('file');
        } else if (action === 'add-manual-constraint') {
            controller.addManualConstraint();
        } else if (action === 'filter-requirements') {
            const filter = event.target.closest('[data-requirement-filter]')?.dataset.requirementFilter;
            controller.filterRequirements(filter);
        } else if (action === 'select-requirement') {
            const requirementId = event.target.closest('[data-requirement-id]')?.dataset.requirementId;
            controller.selectRequirement(requirementId);
        } else if (action === 'toggle-system-group') {
            controller.toggleSystemRequirementGroup();
        } else if (action === 'submit-requirement-clarification') {
            const requirementId = event.target.closest('[data-requirement-id]')?.dataset.requirementId;
            const clarifyValue = event.target.closest('[data-clarify-value]')?.dataset.clarifyValue;
            controller.submitRequirementClarification(requirementId, clarifyValue);
        } else if (action === 'toggle-constraint-apply-item') {
            const applyItemKey = event.target.closest('[data-apply-item-key]')?.dataset.applyItemKey;
            controller.toggleConstraintApplyItem(applyItemKey);
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

    container.addEventListener('change', event => {
        const controller = container.__ttController;
        if (!controller) return;
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
        } else if (event.target.matches('#tt-constraint-file-input')) {
            controller.handleConstraintFileSelect(event);
        } else if (event.target.matches('#tt-manual-rule-type')) {
            controller.updateManualConstraintType?.(event.target.value);
        } else if (event.target.matches('#tt-edit-constraint-type')) {
            controller.updateEditingConstraintType?.(event.target.value);
        }
    });

    container.addEventListener('input', event => {
        const controller = container.__ttController;
        if (!controller) return;
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
        }
    });

    container.addEventListener('keydown', event => {
        const controller = container.__ttController;

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

export function bindGridInteractions(container, controller, state) {
    container.__ttController = controller;
    container.__ttState = state;
    bindDelegatedInteractions(container);
    bindInspectorFloatingWindow(container, state);

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
