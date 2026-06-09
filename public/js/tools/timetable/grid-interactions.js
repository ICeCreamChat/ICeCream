export function bindGridInteractions(container, controller, state) {
    container.querySelectorAll('[data-tt-section-toggle]').forEach(button => {
        button.addEventListener('click', () => controller.toggleWorkflowSection(button.dataset.ttSectionToggle));
    });
    container.querySelector('#tt-save-project')?.addEventListener('click', () => controller.saveProject());
    container.querySelectorAll('[data-active-weekday], [data-active-period]').forEach(input => {
        input.addEventListener('change', () => controller.updateRangeDraftFromForm());
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
    container.querySelectorAll('[data-tt-popover-close]').forEach(button => {
        button.addEventListener('click', () => button.closest('details')?.removeAttribute('open'));
    });
    container.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            container.querySelectorAll('details.tt-multi-select[open]').forEach(details => details.removeAttribute('open'));
        }
    });
    container.querySelectorAll('[data-roster-import-trigger]').forEach(button => {
        button.addEventListener('click', () => controller.openRosterImport('file'));
    });
    container.querySelector('#tt-reopen-roster-import')?.addEventListener('click', () => controller.openRosterImport('file'));
    container.querySelector('#tt-edit-roster')?.addEventListener('click', () => controller.openRosterEditor());
    container.querySelector('#tt-fill-roster-sample')?.addEventListener('click', () => controller.fillSample());
    container.querySelector('#tt-preview-roster-import')?.addEventListener('click', () => controller.previewRosterImport());
    container.querySelector('#tt-start-empty-roster-review')?.addEventListener('click', () => controller.startEmptyRosterReview());
    container.querySelector('#tt-confirm-roster-import')?.addEventListener('click', () => controller.confirmRosterImport());
    container.querySelector('#tt-cancel-roster-import')?.addEventListener('click', () => controller.closeRosterImport());
    container.querySelector('#tt-cancel-roster-import-secondary')?.addEventListener('click', () => controller.closeRosterImport());
    container.querySelector('#tt-roster-import-file')?.addEventListener('change', event => {
        controller.selectRosterImportFile(event.target.files?.[0] || null);
    });
    container.querySelectorAll('[data-roster-import-mode]').forEach(button => {
        button.addEventListener('click', () => controller.setRosterImportMode(button.dataset.rosterImportMode));
    });
    container.querySelectorAll('[data-roster-field]').forEach(input => {
        input.addEventListener('change', () => controller.updateRosterReviewField());
    });
    container.querySelectorAll('[data-roster-delete-row]').forEach(button => {
        button.addEventListener('click', () => controller.deleteRosterReviewRow(button.dataset.rosterDeleteRow));
    });
    container.querySelector('#tt-add-roster-review-row')?.addEventListener('click', () => controller.addRosterReviewRow());
    container.querySelector('#tt-append-roster-rows')?.addEventListener('click', () => controller.appendRosterReviewRows());
    container.querySelector('#tt-clear-roster')?.addEventListener('click', () => controller.clearRoster());
    container.querySelector('#tt-save-rules')?.addEventListener('click', () => controller.saveRules());
    container.querySelector('#tt-open-rule-review')?.addEventListener('click', () => controller.openRuleReview('file'));
    container.querySelector('#tt-reparse-rule-review')?.addEventListener('click', () => controller.startRuleReviewInput('file'));
    container.querySelector('#tt-rule-review-cancel')?.addEventListener('click', () => controller.closeRuleReview());
    container.querySelector('#tt-rule-review-cancel-secondary')?.addEventListener('click', () => controller.closeRuleReview());
    container.querySelectorAll('[data-rule-review-mode]').forEach(button => {
        button.addEventListener('click', () => controller.setRuleReviewMode(button.dataset.ruleReviewMode));
    });
    container.querySelector('#tt-rule-review-file')?.addEventListener('change', event => {
        controller.selectRuleReviewFile(event.target.files?.[0] || null);
    });
    container.querySelector('#tt-rule-review-parse')?.addEventListener('click', () => controller.parseRules());
    container.querySelectorAll('[data-rule-example]').forEach(button => {
        button.addEventListener('click', () => controller.fillRuleExample(button.dataset.ruleExample));
    });
    container.querySelector('#tt-add-manual-rule-rows')?.addEventListener('click', () => controller.addManualRuleRows());
    container.querySelector('#tt-confirm-rule-review')?.addEventListener('click', () => controller.confirmRuleDraft());
    container.querySelector('#tt-add-rule-review-row')?.addEventListener('click', () => controller.addRuleReviewRow());
    container.querySelectorAll('[data-rule-review-field]').forEach(input => {
        input.addEventListener('change', () => controller.updateRuleReviewField());
    });
    container.querySelectorAll('[data-rule-review-delete-row]').forEach(button => {
        button.addEventListener('click', () => controller.deleteRuleReviewRow(button.dataset.ruleReviewDeleteRow));
    });
    container.querySelector('#tt-clear-rules')?.addEventListener('click', () => controller.clearRules());
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

    container.querySelectorAll('[data-export-type]').forEach(button => {
        button.addEventListener('click', () => controller.export(button.dataset.exportType));
    });

    container.querySelectorAll('.tt-slot').forEach(slotNode => {
        slotNode.addEventListener('click', () => {
            state.selectedSlotId = slotNode.dataset.slotId;
            controller.render();
        });
        slotNode.addEventListener('dragstart', event => {
            state.dragSlotId = slotNode.dataset.slotId;
            state.dragBlockId = slotNode.dataset.blockId || '';
            event.dataTransfer.effectAllowed = 'move';
        });
    });

    container.querySelectorAll('.tt-cell').forEach(cell => {
        cell.addEventListener('dragover', event => event.preventDefault());
        cell.addEventListener('dragenter', () => cell.classList.add('is-drop-target'));
        cell.addEventListener('dragleave', () => cell.classList.remove('is-drop-target'));
        cell.addEventListener('drop', event => {
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
    });

    container.querySelector('#tt-lock-selected')?.addEventListener('click', () => {
        const slot = state.project?.schedule?.slots?.find(item => item.id === state.selectedSlotId);
        controller.adjustSlot({ type: 'lock', slotId: state.selectedSlotId, locked: !slot?.locked });
    });

    container.querySelector('#tt-clear-selected')?.addEventListener('click', () => {
        controller.adjustSlot({ type: 'clear', slotId: state.selectedSlotId });
    });
}
