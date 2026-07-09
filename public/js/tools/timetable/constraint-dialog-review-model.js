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
    'global_unavailable',
    'subject_morning',
    'subject_afternoon',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_daily_limit',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'teacher_weekly_limit',
    'teacher_max_days_per_week',
    'teacher_mutual_exclusion',
    'subject_spread',
    'course_interval',
    'room_requirement',
    'class_daily_balance',
    'teacher_gap_preference',
    'teacher_load_balance',
    'subject_not_same_day',
    'subject_sequence',
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
    if (normalizeKey(row.type) === 'subject_afternoon' && !params.slots) params.dayPart = 'afternoon';
    if (Array.isArray(row.roomIds) && row.roomIds.length) params.roomIds = row.roomIds;
    if (Array.isArray(row.teacherIds) && row.teacherIds.length) params.teacherIds = row.teacherIds;
    if (Array.isArray(row.subjectIds) && row.subjectIds.length) params.subjectIds = row.subjectIds;
    if (Array.isArray(row.classIds) && row.classIds.length) params.classIds = row.classIds;
    if (row.minGapDays !== undefined && row.minGapDays !== null && row.minGapDays !== '') params.minGapDays = row.minGapDays;
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
        parseSource: row.parseSource || '',
        stableKey: row.stableKey || '',
    };
}

function itemOriginFromSource(source = {}, fallback = 'user_input') {
    if (source?.origin) return source.origin;
    if (source?.sourceRow || source?.row) return 'user_input';
    return fallback;
}

function sourceTextKey(value = '') {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[，,。.;；：:、]/g, '')
        .toLowerCase();
}

function requirementSourceText(item = {}) {
    return item.source?.rawText || item.rawText || item.description || '';
}

function draftRowSourceText(row = {}) {
    return row.sourceText || row.rawText || row.description || row.reason || '';
}

function actionSourceText(action = {}) {
    return action.source?.rawText || action.rawText || action.description || action.reason || '';
}

function itemSourceTexts(item = {}) {
    return uniqueValues([
        requirementSourceText(item),
        ...sourceTextsFromParameterBag(item.parameters),
        ...sourceTextsFromParameterBag(item.condition),
        item.reviewEvidence?.quote,
        item.reviewEvidence?.reason,
        ...(item.machineRules || []).flatMap(row => [
            draftRowSourceText(row),
            row.reviewEvidence?.quote,
            row.reviewEvidence?.reason,
        ]),
        ...(item.semanticActions || []).flatMap(action => [
            actionSourceText(action),
            action.reviewEvidence?.quote,
            action.reviewEvidence?.reason,
        ]),
    ]);
}

function isCoveredRedundantMessage(value = '') {
    const text = String(value || '').trim();
    if (!text) return false;
    return /冗余需求|已被[^，。；;\n]{0,80}覆盖|covered\s+by|duplicate\s+requirement/i.test(text);
}

function relatedSourceText(left = {}, right = {}) {
    const leftTexts = itemSourceTexts(left).map(sourceTextKey).filter(Boolean);
    const rightTexts = itemSourceTexts(right).map(sourceTextKey).filter(Boolean);
    return leftTexts.some(leftText => rightTexts.some(rightText => {
        if (leftText === rightText) return true;
        const [shorter, longer] = leftText.length <= rightText.length ? [leftText, rightText] : [rightText, leftText];
        return shorter.length >= 8 && longer.includes(shorter);
    }));
}

function parseLooseChineseNumber(value = '') {
    const text = String(value || '').trim();
    if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (text === '十') return 10;
    if (text.startsWith('十')) return 10 + (digits[text.slice(1)] || 0);
    if (text.includes('十')) {
        const [tens, ones] = text.split('十');
        return (digits[tens] || 1) * 10 + (digits[ones] || 0);
    }
    return digits[text] || null;
}

function parseDayNumber(value = '') {
    return {
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        日: 7,
        天: 7,
    }[String(value || '')] || Number.parseInt(value, 10) || null;
}

function slotsFromText(value = '') {
    const text = String(value || '');
    const slots = [];
    for (const match of text.matchAll(/\b(\d{1,2})-(\d{1,2})\b/g)) {
        slots.push(`${Number.parseInt(match[1], 10)}-${Number.parseInt(match[2], 10)}`);
    }
    const pairPattern = /(?:周|星期|礼拜)([一二三四五六日天1-7])[^，。；;、\n]{0,16}?第?\s*([0-9一二两三四五六七八九十零〇]{1,3})\s*节/g;
    for (const match of text.matchAll(pairPattern)) {
        const day = parseDayNumber(match[1]);
        const period = parseLooseChineseNumber(match[2]);
        if (day && period) slots.push(`${day}-${period}`);
    }
    return uniqueValues(slots);
}

function valueList(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return [value];
}

function slotsFromDayPeriodValues(dayValue, periodValue) {
    const days = valueList(dayValue).map(parseDayNumber).filter(Boolean);
    const periods = valueList(periodValue).map(parseLooseChineseNumber).filter(Boolean);
    if (!days.length || !periods.length) return [];
    return uniqueValues(days.flatMap(day => periods.map(period => `${day}-${period}`)));
}

function slotsFromParameterBag(bag) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return [];
    const slots = [
        ...valueList(bag.slots).flatMap(slotsFromText),
        ...valueList(bag.slot).flatMap(slotsFromText),
        ...valueList(bag.time).flatMap(value => (typeof value === 'object' ? [] : slotsFromText(value))),
        ...valueList(bag.timeText).flatMap(slotsFromText),
        ...valueList(bag.slotText).flatMap(slotsFromText),
        ...valueList(bag.periodText).flatMap(slotsFromText),
        ...valueList(bag.scheduleTime).flatMap(slotsFromText),
        ...valueList(bag.unavailableTime).flatMap(slotsFromText),
        ...valueList(bag.rawText).flatMap(slotsFromText),
        ...valueList(bag.sourceText).flatMap(slotsFromText),
        ...valueList(bag.text).flatMap(slotsFromText),
        ...valueList(bag.description).flatMap(slotsFromText),
        ...valueList(bag.conditionText).flatMap(slotsFromText),
        ...valueList(bag.reason).flatMap(slotsFromText),
        ...slotsFromDayPeriodValues(bag.day ?? bag.weekday ?? bag.weekDay ?? bag.days, bag.period ?? bag.periods),
    ];
    return uniqueValues([
        ...slots,
        ...slotsFromParameterBag(bag.time),
    ]);
}

function sourceTextsFromParameterBag(bag) {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return [];
    return uniqueValues([
        ...valueList(bag.rawText),
        ...valueList(bag.sourceText),
        ...valueList(bag.text),
        ...valueList(bag.description),
        ...valueList(bag.conditionText),
        ...sourceTextsFromParameterBag(bag.time),
    ]);
}

function itemSlots(item = {}) {
    const direct = uniqueValues([
        ...valueList(item.parameters?.slots),
        ...valueList(item.condition?.slots),
        ...slotsFromParameterBag(item.parameters),
        ...slotsFromParameterBag(item.condition),
        ...(item.machineRules || []).flatMap(row => row.slots || row.time?.slots || []),
        ...(item.semanticActions || []).flatMap(action => action.parameters?.slots || action.payload?.slots || []),
    ]);
    if (direct.length) return direct;
    return uniqueValues(itemSourceTexts(item).flatMap(slotsFromText));
}

function rowTargetIds(row = {}) {
    return uniqueValues([
        row.targetId,
        row.teacherId,
        row.classId,
        row.subjectId,
        ...(row.teacherIds || []),
        ...(row.classIds || []),
        ...(row.subjectIds || []),
    ]);
}

function itemTargetIds(item = {}) {
    return uniqueValues([
        item.targetId,
        item.object?.id,
        ...(item.object?.matchedIds || []),
        ...(item.parameters?.teacherIds || []),
        ...(item.parameters?.classIds || []),
        ...(item.parameters?.subjectIds || []),
        ...(item.machineRules || []).flatMap(rowTargetIds),
    ]);
}

function normalizeEntityName(value = '') {
    return String(value || '').replace(/老师|教师|同学|班级|课程/g, '').replace(/\s+/g, '').toLowerCase();
}

function rowTargetNames(row = {}) {
    return uniqueValues([
        row.targetName,
        row.teacherName,
        row.teacher,
        row.className,
        row.class,
        row.subjectName,
        row.subject,
    ]).map(normalizeEntityName).filter(Boolean);
}

function itemTargetNames(item = {}) {
    return uniqueValues([
        item.targetName,
        item.target,
        item.object?.name,
        ...(item.parameters?.teacherNames || []),
        ...(item.parameters?.classNames || []),
        ...(item.parameters?.subjectNames || []),
        ...(item.machineRules || []).flatMap(rowTargetNames),
    ]).map(normalizeEntityName).filter(Boolean);
}

function sameRequirementTarget(left = {}, right = {}) {
    const leftIds = itemTargetIds(left);
    const rightIds = itemTargetIds(right);
    if (leftIds.length && rightIds.some(id => leftIds.includes(id))) return true;
    const leftNames = itemTargetNames(left);
    const rightNames = itemTargetNames(right);
    if (leftNames.length && rightNames.some(name => leftNames.includes(name))) return true;
    const leftSource = itemSourceTexts(left).map(normalizeEntityName).join('');
    return Boolean(leftSource && rightNames.some(name => name && leftSource.includes(name)));
}

function compatibleRequirementSlots(left = {}, right = {}) {
    const leftSlots = itemSlots(left);
    const rightSlots = itemSlots(right);
    if (!leftSlots.length || !rightSlots.length) return false;
    const rightSet = new Set(rightSlots);
    return leftSlots.some(slot => rightSet.has(slot));
}

const INTERMEDIATE_REQUIREMENT_INTENTS = new Set([
    'schedule_request',
    'unavailable_periods',
    'unknown',
    'requirement',
]);

const SHELL_PARAMETER_META_KEYS = new Set([
    'applyto',
    'channel',
    'confidence',
    'destination',
    'intent',
    'object',
    'objectid',
    'objectids',
    'objectkind',
    'objectname',
    'origin',
    'parsesource',
    'reason',
    'rule',
    'ruletype',
    'scope',
    'source',
    'status',
    'target',
    'targetid',
    'targetids',
    'targetname',
    'targettype',
    'teacher',
    'teacherid',
    'teacherids',
    'teachername',
    'teachernames',
    'type',
]);

const SHELL_PARAMETER_PLACEHOLDERS = new Set([
    '-',
    '—',
    '–',
    '/',
    'n/a',
    'na',
    'none',
    'null',
    'unknown',
    'user_input',
    'review',
    'needs_review',
    'rule',
    'rules',
    'constraint',
    'constraint_rule',
    'teacher_unavailable',
    'schedule_request',
    '排课规则',
    '规则',
    '需复核',
    '我的输入',
    '未知',
    '无',
    '暂无',
    '无参数',
    '未填写',
    '未指定',
    '不确定',
]);

function parameterKey(value = '') {
    return normalizeKey(value).replace(/_/g, '');
}

function isShellPlaceholderParameterValue(value = '') {
    const text = String(value || '').trim();
    if (!text) return true;
    return SHELL_PARAMETER_PLACEHOLDERS.has(text)
        || SHELL_PARAMETER_PLACEHOLDERS.has(normalizeKey(text));
}

function isShellMetaParameterKey(key = '') {
    return SHELL_PARAMETER_META_KEYS.has(parameterKey(key));
}

function parameterValueHasMeaning(key = '', value) {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.some(entry => parameterValueHasMeaning(key, entry));
    if (typeof value === 'object') {
        return Object.entries(value).some(([childKey, childValue]) => parameterValueHasMeaning(childKey || key, childValue));
    }
    if (isShellPlaceholderParameterValue(value)) return false;
    if (isShellMetaParameterKey(key)) return false;
    return true;
}

function hasMeaningfulParameters(item = {}) {
    const entries = [
        ...Object.entries(item.parameters || {}),
        ...Object.entries(item.condition || {}),
    ];
    return entries.some(([key, value]) => parameterValueHasMeaning(key, value));
}

function hasUserTraceText(item = {}) {
    return uniqueValues([
        requirementSourceText(item),
        item.reviewEvidence?.quote,
    ]).some(value => !isCoveredRedundantMessage(value) && Boolean(sourceTextKey(value)));
}

function hasClarificationSignal(item = {}) {
    const clarificationText = item.clarification?.question || item.clarification?.message || '';
    const hasClarification = Boolean(item.clarification) && !isCoveredRedundantMessage(clarificationText);
    const hasHistory = (Array.isArray(item.clarificationHistory) ? item.clarificationHistory : [])
        .some(entry => !isCoveredRedundantMessage(entry?.question || entry?.message || entry));
    const hasWarnings = (Array.isArray(item.warnings) ? item.warnings : [])
        .some(warning => !isCoveredRedundantMessage(warning));
    return hasClarification || hasHistory || hasWarnings;
}

function isIntermediateRequirement(item = {}) {
    const intent = normalizeKey(item.intent || item.type || '');
    if ((item.origin || '') === 'system_supplement') return false;
    if (requirementHasLanding(item)) return false;
    return INTERMEDIATE_REQUIREMENT_INTENTS.has(intent)
        || normalizeKey(item.applyTo || '') === 'review'
        || REVIEW_STATUSES.has(normalizeKey(item.status || ''));
}

function isEmptyIntermediateShell(item = {}) {
    if (!isIntermediateRequirement(item)) return false;
    const intent = normalizeKey(item.intent || item.type || '');
    if (!['schedule_request', 'unknown', 'requirement'].includes(intent)) return false;
    return !hasMeaningfulParameters(item)
        && !itemSlots(item).length
        && !hasUserTraceText(item)
        && !hasClarificationSignal(item);
}

function semanticallyMatchesLandingItem(support = {}, landing = {}) {
    const rule = executableMachineRule(landing);
    if (!rule || !isDraftRowActionable(rule)) return false;
    if (!sameRequirementTarget(support, landing)) return false;
    return compatibleRequirementSlots(support, landing) || relatedSourceText(support, landing);
}

function canMergeSupportWithAllLandingItems(support = {}, landingItems = []) {
    if (landingItems.length <= 1) return landingItems.length === 1;
    const rules = landingItems.map(executableMachineRule).filter(Boolean);
    if (rules.length !== landingItems.length) return false;
    const type = normalizeKey(rules[0].type || rules[0].intent || '');
    if (!type || rules.some(rule => normalizeKey(rule.type || rule.intent || '') !== type)) return false;
    const firstSlots = itemSlots(landingItems[0]).sort().join('|');
    if (!firstSlots || landingItems.some(item => itemSlots(item).sort().join('|') !== firstSlots)) return false;
    const supportIds = itemTargetIds(support);
    if (!supportIds.length) return false;
    return landingItems.every(item => itemTargetIds(item).some(id => supportIds.includes(id)));
}

function addSourceOwner(sourceOwners, sourceText = '', ownerId = '') {
    const key = sourceTextKey(sourceText);
    if (!key || !ownerId) return;
    if (!sourceOwners.has(key)) sourceOwners.set(key, []);
    sourceOwners.get(key).push(ownerId);
}

function requirementStatusScore(status = '') {
    const key = normalizeKey(status || '');
    if (['actionable', 'ready', 'effective'].includes(key)) return 20;
    if (REVIEW_STATUSES.has(key)) return 8;
    if (HANDLED_STATUSES.has(key)) return 2;
    return 0;
}

function ownerScoreForDraftRow(owner = {}, row = {}) {
    const ownerIntent = normalizeKey(owner.intent || owner.type || '');
    const rowType = normalizeKey(row.type || row.intent || '');
    const ownerApplyTo = normalizeKey(owner.applyTo || '');
    let score = requirementStatusScore(owner.status);
    if (ownerIntent && rowType && ownerIntent === rowType) score += 80;
    else if (ownerIntent && rowType && (ownerIntent.includes(rowType) || rowType.includes(ownerIntent))) score += 28;
    if (['rule', 'rules', 'constraint', 'constraint_rule'].includes(ownerApplyTo)) score += 24;
    if (Array.isArray(owner.parameters?.slots) && Array.isArray(row.slots)) {
        const ownerSlots = new Set(owner.parameters.slots.map(String));
        if (row.slots.some(slot => ownerSlots.has(String(slot)))) score += 12;
    }
    return score;
}

function ownerScoreForAction(owner = {}, action = {}) {
    const ownerIntent = normalizeKey(owner.intent || owner.type || '');
    const actionKind = normalizeKey(action.kind || action.type || '');
    const ownerApplyTo = normalizeKey(owner.applyTo || '');
    let score = requirementStatusScore(owner.status);
    if (ownerIntent && actionKind && ownerIntent === actionKind) score += 70;
    if (ownerApplyTo && ownerApplyTo === actionApplyTo(action)) score += 24;
    return score;
}

function bestSourceOwnerId(ownerIds = [], byId, scorer) {
    let bestId = '';
    let bestScore = Number.NEGATIVE_INFINITY;
    ownerIds.forEach(ownerId => {
        const owner = byId.get(ownerId);
        if (!owner) return;
        const score = scorer(owner);
        if (score > bestScore) {
            bestScore = score;
            bestId = ownerId;
        }
    });
    return bestId;
}

function mergeUniqueArrays(...groups) {
    const seen = new Set();
    const merged = [];
    groups.flat().forEach(item => {
        if (!item) return;
        const key = typeof item === 'object'
            ? item.id || item.stableKey || JSON.stringify({
                intent: item.intent || item.type || item.kind,
                rawText: requirementSourceText(item) || draftRowSourceText(item) || actionSourceText(item),
                applyTo: item.applyTo,
                targetId: item.targetId || item.target?.id || item.target?.teacherId || item.target?.lessonPlanId,
                slots: item.slots || item.parameters?.slots,
            })
            : String(item);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(item);
    });
    return merged;
}

function requirementSupportSnapshot(item = {}) {
    return {
        id: item.id || '',
        object: item.object || null,
        intent: item.intent || item.type || '',
        condition: item.condition || null,
        parameters: item.parameters || {},
        status: item.status || '',
        applyTo: item.applyTo || '',
        origin: item.origin || '',
        confidence: item.confidence,
        source: item.source || {},
        warnings: item.warnings || [],
    };
}

function executableMachineRule(item = {}) {
    return (item.machineRules || []).find(row => isDraftRowActionable(row))
        || (item.machineRules || [])[0]
        || null;
}

function promoteRequirementDisplay(item = {}) {
    const rule = executableMachineRule(item);
    if (!rule) return sanitizeCoveredRedundantSignals(item);
    const parameters = draftRowParameters(rule);
    return sanitizeCoveredRedundantSignals({
        ...item,
        object: draftRowObject(rule),
        intent: rule.intent || rule.type || item.intent,
        parameters: Object.keys(parameters).length ? parameters : (item.parameters || {}),
        strength: rule.priority || rule.strength || item.strength || '',
        status: draftRowStatus(rule),
        applyTo: draftRowApplyTo(rule),
        confidence: rule.confidence ?? item.confidence,
        warnings: mergeUniqueArrays(item.warnings || [], rule.warnings || []),
        displayFromMachineRule: true,
    });
}

function requirementHasLanding(item = {}) {
    return Boolean((item.machineRules || []).length || (item.semanticActions || []).length);
}

function isCoveredRedundantClarification(clarification = null) {
    if (!clarification || typeof clarification !== 'object') return false;
    return isCoveredRedundantMessage(clarification.question || clarification.message || clarification.reason || '');
}

function isCoveredRedundantSupport(entry = {}) {
    return [
        entry.source?.rawText,
        entry.rawText,
        entry.description,
        ...(Array.isArray(entry.warnings) ? entry.warnings : []),
    ].some(isCoveredRedundantMessage);
}

function sanitizeCoveredRedundantSignals(item = {}) {
    if (!requirementHasLanding(item)) return item;
    const warnings = (Array.isArray(item.warnings) ? item.warnings : [])
        .filter(warning => !isCoveredRedundantMessage(warning));
    const supportingRequirements = (Array.isArray(item.supportingRequirements) ? item.supportingRequirements : [])
        .filter(entry => !isCoveredRedundantSupport(entry));
    const next = {
        ...item,
        warnings,
        supportingRequirements,
    };
    if (isCoveredRedundantClarification(item.clarification)) {
        next.clarification = null;
    }
    return next;
}

function coalescingKeysForItem(item = {}) {
    if ((item.origin || '') === 'system_supplement') return [];
    const keys = [];
    const sourceKey = sourceTextKey(requirementSourceText(item));
    if (sourceKey) keys.push(`source:${sourceKey}`);
    collectRequirementRowIds(item).forEach(rowId => keys.push(`row:${rowId}`));
    (item.machineRules || []).forEach(row => keys.push(`rule:${draftRowApplyItemKey(row)}`));
    (item.semanticActions || []).forEach(action => keys.push(`action:${semanticActionApplyItemKey(action)}`));
    return keys.filter(Boolean);
}

function choosePrimaryRequirementItem(group = []) {
    let best = group[0] || null;
    let bestScore = Number.NEGATIVE_INFINITY;
    group.forEach(item => {
        const rule = executableMachineRule(item);
        const applyTo = normalizeKey(item.applyTo || '');
        let score = requirementStatusScore(item.status);
        if (rule && isDraftRowActionable(rule)) score += 120;
        else if (rule) score += 90;
        if ((item.semanticActions || []).some(action => isSemanticActionApplicable(action))) score += 70;
        if (['rule', 'lesson_plan', 'optimization'].includes(applyTo)) score += 26;
        if (item.derivedFromDraft || item.derivedFromAction) score += 8;
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    });
    return best || group[0] || {};
}

function mergeRequirementGroup(group = []) {
    if (group.length === 1) return promoteRequirementDisplay(group[0]);
    const primary = choosePrimaryRequirementItem(group);
    const machineRules = mergeUniqueArrays(...group.map(item => item.machineRules || []));
    const semanticActions = mergeUniqueArrays(...group.map(item => item.semanticActions || []));
    const supportingRequirements = mergeUniqueArrays(
        ...group.map(item => item.supportingRequirements || []),
        group
            .filter(item => !(item.derivedFromDraft || item.derivedFromAction))
            .map(item => requirementSupportSnapshot(item))
    );
    const merged = {
        ...primary,
        machineRules,
        semanticActions,
        warnings: mergeUniqueArrays(...group.map(item => item.warnings || [])),
        supportingRequirements,
    };
    return promoteRequirementDisplay(merged);
}

function coalesceUnifiedRequirementItems(items = []) {
    const parent = new Map();
    const keyOwner = new Map();
    const itemIds = items.map((item, index) => item.id || `item_${index + 1}`);
    const find = id => {
        const current = parent.get(id) || id;
        if (current === id) return id;
        const root = find(current);
        parent.set(id, root);
        return root;
    };
    const union = (left, right) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };

    itemIds.forEach(id => parent.set(id, id));
    items.forEach((item, index) => {
        const id = itemIds[index];
        coalescingKeysForItem(item).forEach(key => {
            if (keyOwner.has(key)) union(id, keyOwner.get(key));
            else keyOwner.set(key, id);
        });
    });

    items.forEach((item, index) => {
        if (!isIntermediateRequirement(item)) return;
        const id = itemIds[index];
        const landingIndexes = items
            .map((candidate, candidateIndex) => (
                candidateIndex !== index && requirementHasLanding(candidate) && semanticallyMatchesLandingItem(item, candidate)
                    ? candidateIndex
                    : -1
            ))
            .filter(candidateIndex => candidateIndex >= 0);
        if (!landingIndexes.length) return;
        const landingItems = landingIndexes.map(candidateIndex => items[candidateIndex]);
        if (!canMergeSupportWithAllLandingItems(item, landingItems)) return;
        landingIndexes.forEach(candidateIndex => union(id, itemIds[candidateIndex]));
    });

    const grouped = new Map();
    items.forEach((item, index) => {
        const root = find(itemIds[index]);
        if (!grouped.has(root)) grouped.set(root, []);
        grouped.get(root).push(item);
    });

    const coalesced = [];
    grouped.forEach(group => {
        if (group.length > 1 && group.some(requirementHasLanding)) {
            coalesced.push(mergeRequirementGroup(group));
            return;
        }
        group.forEach(item => coalesced.push(promoteRequirementDisplay(item)));
    });
    if (!coalesced.some(requirementHasLanding)) return coalesced;
    return coalesced.filter(item => !isEmptyIntermediateShell(item));
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
        origin: row.origin || itemOriginFromSource(row.source, 'user_input'),
        confidence: row.confidence,
        source: draftRowSource(row),
        warnings: row.warnings || [],
        aiReviewStatus: row.aiReviewStatus || '',
        aiReviewWarnings: row.aiReviewWarnings || [],
        reviewEvidence: row.reviewEvidence || null,
        reviewedParseSource: row.reviewedParseSource || '',
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
        origin: action.origin || itemOriginFromSource(action.source, 'user_input'),
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
        origin: item.origin || itemOriginFromSource(item.source, 'user_input'),
        machineRules: [],
        semanticActions: [],
    }));
    const byId = new Map(items.map(item => [item.id, item]));
    const rowOwners = new Map();
    const sourceOwners = new Map();
    const attachedActionIds = new Set();

    items.forEach(item => {
        collectRequirementRowIds(item).forEach(rowId => addRowOwner(rowOwners, rowId, item.id));
        if ((item.origin || '') !== 'system_supplement') addSourceOwner(sourceOwners, requirementSourceText(item), item.id);
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
            const sourceOwnerId = bestSourceOwnerId(
                sourceOwners.get(sourceTextKey(draftRowSourceText(row))) || [],
                byId,
                owner => ownerScoreForDraftRow(owner, row)
            );
            if (sourceOwnerId) ownerIds.add(sourceOwnerId);
        }

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
        const sourceOwnerId = bestSourceOwnerId(
            sourceOwners.get(sourceTextKey(actionSourceText(action))) || [],
            byId,
            owner => ownerScoreForAction(owner, action)
        );
        if (sourceOwnerId) {
            const owner = byId.get(sourceOwnerId);
            if (owner) {
                owner.semanticActions.push(action);
                attachedActionIds.add(action.id);
                return;
            }
        }
        const item = createSemanticRequirementItem(action, index);
        items.push(item);
        byId.set(item.id, item);
    });

    return coalesceUnifiedRequirementItems(items);
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
