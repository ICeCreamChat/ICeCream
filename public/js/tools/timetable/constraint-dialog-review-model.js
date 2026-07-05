const REVIEW_STATUSES = new Set(['needs_review', 'review', 'candidate', 'pending', 'unsupported', 'invalid']);
const HANDLED_STATUSES = new Set(['handled', 'ignored']);
const NON_APPLICABLE_RULE_STATUSES = new Set([
    ...REVIEW_STATUSES,
    ...HANDLED_STATUSES,
    'suggestion',
]);

const BACKEND_RULE_TYPES = new Set([
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'subject_morning',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'subject_spread',
]);

const LEGACY_MANUAL_RULE_TYPES = new Set(['forbid', 'prefer', 'avoid']);
const ACTIONABLE_RULE_TYPES = new Set([...BACKEND_RULE_TYPES, ...LEGACY_MANUAL_RULE_TYPES]);

function normalizeKey(value = '') {
    return String(value || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function uniqueValues(values = []) {
    return [...new Set(values.filter(value => value !== undefined && value !== null && String(value) !== '').map(String))];
}

function collectRequirementRowIds(item = {}) {
    return uniqueValues([
        item.rowId,
        item.ruleId,
        item.draftRowId,
        item.source?.rowId,
        item.source?.draftRowId,
        ...(item.rowIds || []),
        ...(item.draftRowIds || []),
        ...(item.source?.rowIds || []),
    ]);
}

function collectActionRowIds(action = {}) {
    const target = action.target || {};
    return uniqueValues([
        action.rowId,
        action.draftRowId,
        target.rowId,
        target.draftRowId,
        ...(action.rowIds || []),
        ...(action.draftRowIds || []),
        ...(target.rowIds || []),
        ...(target.draftRowIds || []),
    ]);
}

function addRowOwner(rowOwners, rowId, requirementId) {
    if (!rowId || !requirementId) return;
    if (!rowOwners.has(rowId)) rowOwners.set(rowId, new Set());
    rowOwners.get(rowId).add(requirementId);
}

function draftRequirementId(row = {}, index = 0) {
    return `draft_req_${row.id || index + 1}`;
}

function semanticRequirementId(action = {}, index = 0) {
    return `semantic_req_${action.id || index + 1}`;
}

function draftRowStatus(row = {}) {
    const status = normalizeKey(row.status || 'effective');
    if (HANDLED_STATUSES.has(status)) return 'handled';
    if (REVIEW_STATUSES.has(status) || status === 'suggestion') return 'needs_review';
    return 'actionable';
}

function draftRowApplyTo(row = {}) {
    const status = normalizeKey(row.status || '');
    const type = normalizeKey(row.type || row.intent || '');
    if (HANDLED_STATUSES.has(status)) return 'handled';
    if (REVIEW_STATUSES.has(status) || status === 'suggestion') return 'review';
    if (ACTIONABLE_RULE_TYPES.has(type)) return 'rule';
    if (type.includes('load') || type.includes('balance') || type.includes('spread')) return 'optimization';
    return 'review';
}

function draftRowParameters(row = {}) {
    const params = {};
    if (Array.isArray(row.slots) && row.slots.length) params.slots = row.slots;
    if (Array.isArray(row.time?.slots) && row.time.slots.length) params.slots = row.time.slots;
    if (row.limit !== undefined && row.limit !== null && row.limit !== '') params.limit = row.limit;
    else if (row.value !== undefined && row.value !== null && row.value !== '') params.limit = row.value;
    if (row.weekPattern) params.weekPattern = row.weekPattern;
    if (normalizeKey(row.type) === 'subject_morning' && !params.slots) params.dayPart = 'morning';
    return params;
}

function draftRowObject(row = {}) {
    return {
        kind: row.targetType || row.target?.type || 'global',
        name: row.target?.name || row.targetName || '全局',
        matchedIds: row.targetId ? [row.targetId] : [],
        scope: row.targetId ? 'explicit' : 'derived',
    };
}

function draftRowSource(row = {}) {
    return {
        rawText: row.sourceText || row.rawText || row.description || '',
        sourceSheet: row.sourceSheet || row.source || '',
        sourceRow: row.sourceRow || '',
    };
}

function createDraftRequirementItem(row = {}, index = 0) {
    return {
        id: draftRequirementId(row, index),
        object: draftRowObject(row),
        intent: row.intent || row.type || 'rule',
        condition: row.condition || null,
        parameters: draftRowParameters(row),
        strength: row.priority || row.strength || '',
        status: draftRowStatus(row),
        applyTo: draftRowApplyTo(row),
        confidence: row.confidence,
        source: draftRowSource(row),
        warnings: row.warnings || [],
        machineRules: [row],
        semanticActions: [],
        derivedFromDraft: true,
    };
}

function actionApplyTo(action = {}) {
    const kind = normalizeKey(action.kind || action.type || '');
    if (kind === 'lesson_plan_patch') return 'lesson_plan';
    if (kind === 'soft_rules_patch' || kind === 'optimization_patch') return 'optimization';
    if (kind === 'rules_patch' || kind === 'rule_patch') return 'rule';
    if (kind === 'handled_notice') return 'handled';
    return action.applyTo || 'review';
}

function actionStatus(action = {}) {
    const kind = normalizeKey(action.kind || action.type || '');
    const status = normalizeKey(action.status || 'ready');
    if (kind === 'handled_notice' || HANDLED_STATUSES.has(status)) return 'handled';
    if (isSemanticActionApplicable(action)) return 'actionable';
    return 'needs_review';
}

function createSemanticRequirementItem(action = {}, index = 0) {
    return {
        id: semanticRequirementId(action, index),
        object: action.object || { kind: 'global', name: action.target?.name || action.targetName || '全局', matchedIds: [], scope: 'derived' },
        intent: action.intent || action.kind || action.type || 'requirement',
        parameters: action.parameters || action.payload || {},
        strength: action.strength || '',
        status: actionStatus(action),
        applyTo: actionApplyTo(action),
        confidence: action.confidence,
        source: action.source || {},
        warnings: action.warnings || [],
        machineRules: [],
        semanticActions: [action],
        derivedFromAction: true,
    };
}

export function getRequirementGroupKey(item = {}) {
    const status = normalizeKey(item.status || '');
    const applyTo = normalizeKey(item.applyTo || '');
    if (status === 'handled' || status === 'ignored' || applyTo === 'handled') return 'handled';
    if (REVIEW_STATUSES.has(status) || applyTo === 'review' || applyTo === 'needs_review') return 'review';
    if (applyTo === 'lesson_plan' || applyTo === 'lesson_plans' || applyTo === 'lessonplan') return 'lesson_plan';
    if (applyTo === 'optimization' || applyTo === 'optimize') return 'optimization';
    if (applyTo === 'rule' || applyTo === 'rules' || applyTo === 'constraint' || applyTo === 'constraint_rule') return 'rule';
    return status === 'actionable' || status === 'ready' || status === 'effective' ? 'review' : 'handled';
}

export function filterUnifiedRequirementItems(items = [], filter = 'all') {
    if (!filter || filter === 'all') return items;
    return items.filter(item => getRequirementGroupKey(item) === filter);
}

export function buildUnifiedRequirementItems(review = {}) {
    const draftRows = review.draftRows || [];
    const semanticActions = review.semanticActions || [];
    const items = (review.requirementItems || []).map((item, index) => ({
        ...item,
        id: item.id || `requirement_${index + 1}`,
        machineRules: [],
        semanticActions: [],
    }));
    const byId = new Map(items.map(item => [item.id, item]));
    const rowOwners = new Map();
    const attachedActionIds = new Set();

    items.forEach(item => {
        collectRequirementRowIds(item).forEach(rowId => addRowOwner(rowOwners, rowId, item.id));
    });

    semanticActions.forEach(action => {
        const owner = action.requirementId ? byId.get(action.requirementId) : null;
        if (owner) {
            owner.semanticActions.push(action);
            attachedActionIds.add(action.id);
            collectActionRowIds(action).forEach(rowId => addRowOwner(rowOwners, rowId, owner.id));
        }
    });

    draftRows.forEach((row, index) => {
        const ownerIds = new Set();
        if (row.requirementId && byId.has(row.requirementId)) ownerIds.add(row.requirementId);
        (rowOwners.get(String(row.id || '')) || []).forEach(ownerId => ownerIds.add(ownerId));

        if (!ownerIds.size) {
            const item = createDraftRequirementItem(row, index);
            items.push(item);
            byId.set(item.id, item);
            return;
        }

        ownerIds.forEach(ownerId => {
            const owner = byId.get(ownerId);
            if (owner) owner.machineRules.push(row);
        });
    });

    semanticActions.forEach((action, index) => {
        if (action.id && attachedActionIds.has(action.id)) return;
        if (action.requirementId && byId.has(action.requirementId)) return;
        const item = createSemanticRequirementItem(action, index);
        items.push(item);
        byId.set(item.id, item);
    });

    return items;
}

export function getDefaultRequirementId(items = [], filter = 'all') {
    const visibleItems = filterUnifiedRequirementItems(items, filter);
    const selected = visibleItems.find(item => normalizeKey(item.status) === 'needs_review')
        || visibleItems.find(item => normalizeKey(item.status) === 'actionable')
        || visibleItems[0]
        || null;
    return selected?.id || '';
}

export function isDraftRowActionable(row = {}) {
    const type = normalizeKey(row.type || row.intent || '');
    const status = normalizeKey(row.status || 'effective');
    return ACTIONABLE_RULE_TYPES.has(type) && !NON_APPLICABLE_RULE_STATUSES.has(status);
}

export function isSemanticActionApplicable(action = {}) {
    const kind = normalizeKey(action.kind || action.type || '');
    const status = normalizeKey(action.status || 'ready');
    return !['handled_notice', 'rules_patch', 'rule_patch'].includes(kind)
        && ['ready', 'actionable', 'effective'].includes(status);
}

function fallbackKey(prefix, item = {}) {
    return `${prefix}:${item.id || item.rowId || item.actionId || item.requirementId || ''}`;
}

export function draftRowApplyItemKey(row = {}) {
    return fallbackKey('rule', row);
}

export function semanticActionApplyItemKey(action = {}) {
    return fallbackKey('action', action);
}

function excludedApplyItemKeySet(review = {}) {
    return new Set((review.excludedApplyItemKeys || []).map(String).filter(Boolean));
}

export function isApplyItemExcluded(review = {}, key = '') {
    return excludedApplyItemKeySet(review).has(String(key || ''));
}

function requirementItemIsActionable(item = {}, review = {}) {
    return (item.machineRules || []).some(row => (
        isDraftRowActionable(row)
        && !isApplyItemExcluded(review, draftRowApplyItemKey(row))
    ))
        || (item.semanticActions || []).some(action => (
            isSemanticActionApplicable(action)
            && !isApplyItemExcluded(review, semanticActionApplyItemKey(action))
        ));
}

export function getActionableRequirementItems(review = {}, filter = 'all') {
    return filterUnifiedRequirementItems(buildUnifiedRequirementItems(review), filter)
        .filter(item => requirementItemIsActionable(item, review));
}

export function getActionableDraftRows(review = {}, filter = 'all') {
    const rows = [];
    const seen = new Set();
    getActionableRequirementItems(review, filter).forEach(item => {
        (item.machineRules || []).forEach(row => {
            const key = draftRowApplyItemKey(row);
            if (seen.has(key) || isApplyItemExcluded(review, key) || !isDraftRowActionable(row)) return;
            seen.add(key);
            rows.push(row);
        });
    });
    return rows;
}

export function getBackendRuleRows(review = {}, filter = 'all') {
    return getActionableDraftRows(review, filter).filter(row => BACKEND_RULE_TYPES.has(normalizeKey(row.type || row.intent || '')));
}

export function getApplicableSemanticActions(review = {}, filter = 'all') {
    const actions = [];
    const seen = new Set();
    getActionableRequirementItems(review, filter).forEach(item => {
        (item.semanticActions || []).forEach(action => {
            const key = semanticActionApplyItemKey(action);
            if (seen.has(key) || isApplyItemExcluded(review, key) || !isSemanticActionApplicable(action)) return;
            seen.add(key);
            actions.push(action);
        });
    });
    return actions;
}

export function getActionableRequirementCount(review = {}, filter = 'all') {
    return getActionableRequirementItems(review, filter).length;
}
