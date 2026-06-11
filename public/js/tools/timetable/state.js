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
        solvePhaseText: '',
        message: '',
        lastFailure: null,
        solverJob: null,
        // 智能约束 — 卡片入口与复核弹窗状态
        ruleInput: {
            text: '',
            fileName: '',
            loading: false,
        },
        pendingRules: [],          // 智能解析后待确认的卡片
        expandedRuleId: null,      // 展开编辑中的卡片 id
        // 保留旧字段以兼容 inspector 审计面板（后续统一清理）
        ruleDraft: null,
        ruleDraftPreview: [],
        ruleWarnings: [],
        ruleFileName: '',
        ruleDraftInputType: '',
        ruleContextStats: null,
        ruleUnsupportedItems: [],
        // legacy ruleReview for backward compat with tests that check state shape
        ruleReview: {
            open: false,
            step: 'input',
            mode: 'file',
            fileName: '',
            text: '',
            draftRows: [],
            inputType: '',
            contextStats: null,
            warnings: [],
            unsupportedItems: [],
            hasBlockingIssues: false,
            loading: false,
            phase: '',
            phaseText: '',
            phaseTone: '',
        },
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
        publishDialog: {
            open: false,
            note: '',
            loading: false,
        },
        restoreDialog: {
            open: false,
            mode: '',
            version: null,
            targetLabel: '',
            summary: null,
            loading: false,
        },
        publicationHistoryDialog: {
            open: false,
            version: null,
        },
        ...overrides,
    };
}

export function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}
