export function bindGridInteractions(container, controller, state) {
    container.querySelector('#tt-save-project')?.addEventListener('click', () => controller.saveProject());
    container.querySelector('#tt-fill-sample')?.addEventListener('click', () => controller.fillSample());
    container.querySelector('#tt-import-roster')?.addEventListener('click', () => controller.importRoster());
    container.querySelector('#tt-clear-roster')?.addEventListener('click', () => controller.clearRoster());
    container.querySelector('#tt-save-rules')?.addEventListener('click', () => controller.saveRules());
    container.querySelector('#tt-parse-rules')?.addEventListener('click', () => controller.parseRules());
    container.querySelector('#tt-confirm-rule-draft')?.addEventListener('click', () => controller.confirmRuleDraft());
    container.querySelector('#tt-add-bulk-rule')?.addEventListener('click', () => controller.addBulkRule());
    container.querySelector('#tt-clear-rules')?.addEventListener('click', () => controller.clearRules());
    container.querySelector('#tt-add-lock')?.addEventListener('click', () => controller.addLockedSlot());
    container.querySelector('#tt-run-schedule')?.addEventListener('click', () => controller.runSchedule());

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
