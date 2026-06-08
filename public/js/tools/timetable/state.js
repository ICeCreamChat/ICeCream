export function createTimetablePlannerState(overrides = {}) {
    return {
        container: null,
        project: null,
        viewMode: 'class',
        selectedOwnerId: '',
        selectedSlotId: '',
        dragSlotId: '',
        dragBlockId: '',
        loading: false,
        message: '',
        lastFailure: null,
        solverJob: null,
        ruleDraft: null,
        ruleDraftPreview: [],
        ruleWarnings: [],
        workflowOpenSections: null,
        rangeDraft: null,
        bulkRuleDraft: {
            days: [],
            periods: [],
        },
        rosterImport: {
            open: false,
            mode: 'file',
            fileName: '',
            text: '',
        },
        ...overrides,
    };
}

export function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
