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
        ruleFileName: '',
        ruleDraftInputType: '',
        ruleContextStats: null,
        ruleUnsupportedItems: [],
        workflowOpenSections: null,
        rangeDraft: null,
        bulkRuleDraft: {
            days: [],
            periods: [],
        },
        rosterImport: {
            open: false,
            step: 'input',
            mode: 'file',
            fileName: '',
            text: '',
            draftRows: [],
            stats: null,
            warnings: [],
            issues: [],
            hasBlockingIssues: false,
        },
        ...overrides,
    };
}

export function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
