import {
    normalizeStatusKey,
    requirementApplyExplanation,
    requirementApplyLabel,
    requirementApplyTone,
    requirementIntentLabel,
    requirementStatusLabel,
} from './constraint-status-dict.js';

const REVIEW_STATUSES = new Set([
    'needs_review',
    'needs_clarification',
    'review',
    'candidate',
    'pending',
    'partially_supported',
    'partially_actionable',
    'understood_not_executable',
    'unsupported',
    'invalid',
]);
const HANDLED_STATUSES = new Set(['handled', 'ignored']);
const INTERNAL_OBJECT_NAMES = new Set([
    'unsupported',
    'need_review',
    'needs_review',
    'unknown',
    'requirement',
    'schedule_request',
]);
const NON_APPLICABLE_RULE_STATUSES = new Set([
    ...REVIEW_STATUSES,
    ...HANDLED_STATUSES,
    'suggestion',
]);

const BACKEND_RULE_TYPES = new Set([
    'advanced_constraint',
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

const ACTIONABLE_RULE_TYPES = BACKEND_RULE_TYPES;

function normalizeKey(value = '') {
    return String(value || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function validDisplayObject(object = null) {
    if (!object || typeof object !== 'object') return false;
    const name = normalizeKey(object.name || object.label || '');
    return Boolean(name && !INTERNAL_OBJECT_NAMES.has(name));
}

function safeDisplayObject(object = null, fallback = null) {
    if (validDisplayObject(object)) return object;
    if (validDisplayObject(fallback)) return fallback;
    return { kind: 'global', name: '全局排课范围', matchedIds: [], scope: 'derived' };
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
        ...valueList(item.rowIds),
        ...valueList(item.draftRowIds),
        ...valueList(item.source?.rowIds),
    ]);
}

function collectActionRowIds(action = {}) {
    const target = action.target || {};
    return uniqueValues([
        action.rowId,
        action.draftRowId,
        target.rowId,
        target.draftRowId,
        ...valueList(action.rowIds),
        ...valueList(action.draftRowIds),
        ...valueList(target.rowIds),
        ...valueList(target.draftRowIds),
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
    if (valueList(row.slots).length) params.slots = valueList(row.slots);
    if (valueList(row.time?.slots).length) params.slots = valueList(row.time?.slots);
    if (row.limit !== undefined && row.limit !== null && row.limit !== '') params.limit = row.limit;
    else if (row.value !== undefined && row.value !== null && row.value !== '') params.limit = row.value;
    if (row.weekPattern) params.weekPattern = row.weekPattern;
    if (normalizeKey(row.type) === 'subject_morning' && !params.slots) params.dayPart = 'morning';
    if (normalizeKey(row.type) === 'subject_afternoon' && !params.slots) params.dayPart = 'afternoon';
    if (valueList(row.roomIds).length) params.roomIds = valueList(row.roomIds);
    if (valueList(row.teacherIds).length) params.teacherIds = valueList(row.teacherIds);
    if (valueList(row.subjectIds).length) params.subjectIds = valueList(row.subjectIds);
    if (valueList(row.classIds).length) params.classIds = valueList(row.classIds);
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

function itemOriginFromSource(source = {}, fallback = 'unknown') {
    const origin = String(source?.origin || '').trim();
    return origin || fallback || 'unknown';
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
        ...valueList(item.machineRules).flatMap(row => [
            draftRowSourceText(row),
            row.reviewEvidence?.quote,
            row.reviewEvidence?.reason,
        ]),
        ...valueList(item.semanticActions).flatMap(action => [
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
        ...valueList(item.machineRules).flatMap(row => valueList(row.slots || row.time?.slots)),
        ...valueList(item.semanticActions).flatMap(action => valueList(action.parameters?.slots || action.payload?.slots)),
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
        ...valueList(row.teacherIds),
        ...valueList(row.classIds),
        ...valueList(row.subjectIds),
    ]);
}

function itemTargetIds(item = {}) {
    return uniqueValues([
        item.targetId,
        item.object?.id,
        ...valueList(item.object?.matchedIds),
        ...valueList(item.parameters?.teacherIds),
        ...valueList(item.parameters?.classIds),
        ...valueList(item.parameters?.subjectIds),
        ...valueList(item.machineRules).flatMap(rowTargetIds),
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
        ...valueList(item.parameters?.teacherNames),
        ...valueList(item.parameters?.classNames),
        ...valueList(item.parameters?.subjectNames),
        ...valueList(item.machineRules).flatMap(rowTargetNames),
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
    const hasHistory = valueList(item.clarificationHistory)
        .some(entry => !isCoveredRedundantMessage(entry?.question || entry?.message || entry));
    const hasWarnings = valueList(item.warnings)
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
    const ownerSlots = new Set(valueList(owner.parameters?.slots).map(String));
    if (ownerSlots.size && valueList(row.slots).some(slot => ownerSlots.has(String(slot)))) {
        score += 12;
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
    const machineRules = valueList(item.machineRules);
    return machineRules.find(row => isDraftRowActionable(row))
        || machineRules[0]
        || null;
}

function promoteRequirementDisplay(item = {}) {
    const rule = executableMachineRule(item);
    if (!rule) return sanitizeCoveredRedundantSignals(item);
    const parameters = draftRowParameters(rule);
    const canonicalSource = Boolean(item.sourceRequirement?.applicationTarget || item.applicationTarget);
    return sanitizeCoveredRedundantSignals({
        ...item,
        object: safeDisplayObject(draftRowObject(rule), item.object),
        intent: rule.type || rule.intent || item.intent,
        parameters: Object.keys(parameters).length ? parameters : (item.parameters || {}),
        strength: rule.priority || rule.strength || item.strength || '',
        status: canonicalSource ? item.status : draftRowStatus(rule),
        applyTo: canonicalSource ? item.applicationTarget : draftRowApplyTo(rule),
        confidence: rule.confidence ?? item.confidence,
        warnings: mergeUniqueArrays(item.warnings || [], rule.warnings || []),
        displayFromMachineRule: !canonicalSource,
    });
}

function requirementHasLanding(item = {}) {
    return Boolean(valueList(item.machineRules).length || valueList(item.semanticActions).length);
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
        ...valueList(entry.warnings),
    ].some(isCoveredRedundantMessage);
}

function sanitizeCoveredRedundantSignals(item = {}) {
    if (!requirementHasLanding(item)) return item;
    const warnings = valueList(item.warnings)
        .filter(warning => !isCoveredRedundantMessage(warning));
    const supportingRequirements = valueList(item.supportingRequirements)
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
    valueList(item.machineRules).forEach(row => keys.push(`rule:${draftRowApplyItemKey(row)}`));
    valueList(item.semanticActions).forEach(action => keys.push(`action:${semanticActionApplyItemKey(action)}`));
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
        object: safeDisplayObject(draftRowObject(row)),
        intent: row.intent || row.type || 'rule',
        condition: row.condition || null,
        parameters: draftRowParameters(row),
        strength: row.priority || row.strength || '',
        status: draftRowStatus(row),
        applyTo: draftRowApplyTo(row),
        origin: row.origin || itemOriginFromSource(row.source),
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
        origin: action.origin || itemOriginFromSource(action.source),
        confidence: action.confidence,
        source: action.source || {},
        warnings: action.warnings || [],
        machineRules: [],
        semanticActions: [action],
        derivedFromAction: true,
    };
}

export function getRequirementGroupKey(item = {}) {
    const status = normalizeKey(item.status || item.reviewStatus || '');
    if (HANDLED_STATUSES.has(status)) return 'handled';
    const applicationTarget = normalizeKey(item.applicationTarget || item.sourceRequirement?.applicationTarget || '');
    const executionStatus = normalizeKey(item.executionStatus || item.sourceRequirement?.executionStatus || '');
    const requiresHumanReview = item.requiresHumanReview ?? item.sourceRequirement?.requiresHumanReview;
    if (applicationTarget) {
        if (requiresHumanReview === true) return 'review';
        if (['conflicted', 'blocked_by_reference', 'blocked_by_clarification', 'partially_executable', 'unsupported_by_solver'].includes(executionStatus)) {
            return 'review';
        }
        if (applicationTarget === 'handled') return 'handled';
        if (applicationTarget === 'lesson_plan') return 'lesson_plan';
        if (applicationTarget === 'optimization') return 'optimization';
        if (applicationTarget === 'rule') return 'rule';
        return 'review';
    }
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

function artifactIdentityValues(item = {}, fields = []) {
    return uniqueValues(fields.flatMap(field => {
        const value = field.split('.').reduce((current, key) => current?.[key], item);
        return valueList(value);
    }));
}

function addIdentityOwner(index, identity, sourceId) {
    if (!identity || !sourceId) return;
    if (!index.has(identity)) index.set(identity, new Set());
    index.get(identity).add(sourceId);
}

function createSourceIdentityIndexes(sourceRequirements = [], requirementItems = [], constraintIRs = []) {
    const indexes = {
        sourceIds: new Set(sourceRequirements.map(item => item.sourceId).filter(Boolean)),
        requirements: new Map(),
        clauses: new Map(),
        machineRules: new Map(),
        rows: new Map(),
    };
    const registerArtifact = (sourceId, artifact = {}) => {
        artifactIdentityValues(artifact, ['id', 'requirementId']).forEach(identity => {
            addIdentityOwner(indexes.requirements, identity, sourceId);
        });
        artifactIdentityValues(artifact, ['clauseId', 'constraintId', 'source.clauseId']).forEach(identity => {
            addIdentityOwner(indexes.clauses, identity, sourceId);
        });
        artifactIdentityValues(artifact, ['machineRuleId', 'machineRuleIds']).forEach(identity => {
            addIdentityOwner(indexes.machineRules, identity, sourceId);
        });
        artifactIdentityValues(artifact, ['rowId', 'draftRowId']).forEach(identity => {
            addIdentityOwner(indexes.rows, identity, sourceId);
        });
    };

    sourceRequirements.forEach(sourceRequirement => {
        const sourceId = sourceRequirement.sourceId;
        if (!sourceId) return;
        valueList(sourceRequirement.machineRuleIds).forEach(identity => {
            addIdentityOwner(indexes.machineRules, identity, sourceId);
        });
        valueList(sourceRequirement.clauses).forEach(clause => registerArtifact(sourceId, clause));
    });
    [...constraintIRs, ...requirementItems].forEach(artifact => {
        const sourceId = artifact.sourceId || artifact.source?.sourceId || '';
        if (!indexes.sourceIds.has(sourceId)) return;
        registerArtifact(sourceId, artifact);
    });
    return indexes;
}

function uniqueIndexedOwner(index, identities = []) {
    const owners = new Set();
    identities.forEach(identity => {
        (index.get(identity) || []).forEach(sourceId => owners.add(sourceId));
    });
    return owners;
}

function sourceIdForArtifact(artifact = {}, indexes) {
    const explicitSourceId = artifact.sourceId || artifact.source?.sourceId || '';
    if (indexes.sourceIds.has(explicitSourceId)) return explicitSourceId;

    const owners = new Set();
    const groups = [
        [indexes.requirements, artifactIdentityValues(artifact, ['requirementId', 'target.requirementId', 'id'])],
        [indexes.clauses, artifactIdentityValues(artifact, ['clauseId', 'constraintId', 'source.clauseId', 'target.clauseId'])],
        [indexes.machineRules, artifactIdentityValues(artifact, ['machineRuleId', 'target.machineRuleId', 'id'])],
        [indexes.rows, artifactIdentityValues(artifact, ['rowId', 'draftRowId', 'target.rowId', 'target.draftRowId', 'id'])],
    ];
    groups.forEach(([index, identities]) => {
        uniqueIndexedOwner(index, identities).forEach(sourceId => owners.add(sourceId));
    });
    return owners.size === 1 ? [...owners][0] : '';
}

function clauseIdentity(clause = {}, index = 0) {
    return clause.clauseId
        || clause.constraintId
        || clause.requirementId
        || clause.id
        || `clause_${index + 1}`;
}

function mergeClauseArtifacts(...groups) {
    const order = [];
    const byId = new Map();
    groups.flat().filter(Boolean).forEach((clause, index) => {
        const identity = clauseIdentity(clause, index);
        if (!byId.has(identity)) {
            order.push(identity);
            byId.set(identity, { ...clause });
            return;
        }
        const current = byId.get(identity);
        byId.set(identity, {
            ...current,
            ...clause,
            source: {
                ...(current.source && typeof current.source === 'object' ? current.source : {}),
                ...(clause.source && typeof clause.source === 'object' ? clause.source : {}),
            },
            warnings: mergeUniqueArrays(current.warnings || [], clause.warnings || []),
            clarifications: mergeUniqueArrays(current.clarifications || [], clause.clarifications || []),
            parsedBy: mergeUniqueArrays(current.parsedBy || [], clause.parsedBy || []),
            machineRuleIds: mergeUniqueArrays(current.machineRuleIds || [], clause.machineRuleIds || []),
            evidence: mergeUniqueArrays(current.evidence || [], clause.evidence || []),
        });
    });
    return order.map(identity => byId.get(identity));
}

function clauseDisplayObject(clause = {}) {
    if (validDisplayObject(clause.object)) return clause.object;
    const target = clause.target || {};
    return safeDisplayObject({
        kind: target.kind || target.type || 'global',
        name: target.name || '全局',
        matchedIds: target.matchedIds || (target.id ? [target.id] : []),
        scope: target.scope || (target.id ? 'explicit' : 'derived'),
    });
}

function sourceCardDisplayObject(primary = {}, clauses = []) {
    if (validDisplayObject(primary.object) || validDisplayObject(primary.target)) {
        return clauseDisplayObject(primary);
    }
    const concrete = clauses.find(clause => validDisplayObject(clause.object) || validDisplayObject(clause.target));
    return concrete ? clauseDisplayObject(concrete) : safeDisplayObject(null);
}

function sourceRequirementSource(sourceRequirement = {}) {
    const source = sourceRequirement.source || {};
    const sourceId = sourceRequirement.sourceId || source.sourceId || '';
    const origin = sourceRequirement.origin || source.origin || 'unknown';
    const parsedBy = mergeUniqueArrays(sourceRequirement.parsedBy || [], source.parsedBy || []);
    return {
        ...source,
        sourceId,
        rawText: source.rawText || sourceRequirement.rawText || '',
        textHash: source.textHash || sourceRequirement.textHash || '',
        origin,
        parsedBy,
        sourceSheet: source.sourceSheet || source.sheetName || '',
        sourceRow: source.sourceRow || source.rowNumber || null,
        sheetName: source.sheetName || source.sourceSheet || '',
        rowNumber: source.rowNumber || source.sourceRow || null,
    };
}

function reviewStatusPriority(item = {}) {
    const status = normalizeKey(item.reviewStatus || item.status || '');
    if (status === 'needs_clarification') return 5;
    if (status === 'needs_review' || status === 'invalid') return 4;
    if (status === 'unsupported' || status === 'partially_supported') return 3;
    if (status === 'candidate' || status === 'pending') return 2;
    return 1;
}

function primaryArtifactScore(item = {}) {
    const intent = normalizeKey(item.intent || item.type || item.capabilityId || '');
    const target = item.object || item.target || {};
    let score = reviewStatusPriority(item) * 5;
    if (INTERMEDIATE_REQUIREMENT_INTENTS.has(intent)) score -= 200;
    if (item.capabilityId && !String(item.capabilityId).startsWith('legacy.schedule_request')) score += 80;
    if (intent && !['schedule_request', 'unknown', 'requirement'].includes(intent)) score += 60;
    if (target.name && !['全局', '全校', '排课需求'].includes(target.name)) score += 30;
    if (hasMeaningfulParameters(item) || itemSlots(item).length) score += 25;
    if (item.clauseId || item.constraintId) score += 10;
    return score;
}

function primaryRequirementArtifact(legacyRequirements = [], clauses = []) {
    return [...legacyRequirements, ...clauses]
        .filter(Boolean)
        .sort((left, right) => primaryArtifactScore(right) - primaryArtifactScore(left))[0]
        || null;
}

function buildSourceRequirementCard(sourceRequirement = {}, context = {}) {
    const {
        constraintIRs = [],
        legacyRequirements = [],
        machineRules = [],
        semanticActions = [],
    } = context;
    const sourceId = sourceRequirement.sourceId;
    const clauses = mergeClauseArtifacts(sourceRequirement.clauses || [], constraintIRs, legacyRequirements);
    const primary = primaryRequirementArtifact(legacyRequirements, clauses) || {};
    const requirementIds = uniqueValues([
        ...legacyRequirements.flatMap(item => [item.requirementId, item.id]),
        ...clauses.flatMap(item => [item.requirementId, item.id]),
    ]);
    const clauseIds = uniqueValues(clauses.flatMap(item => [item.clauseId, item.constraintId]));
    const machineRuleIds = uniqueValues([
        ...valueList(sourceRequirement.machineRuleIds),
        ...clauses.flatMap(item => valueList(item.machineRuleIds)),
        ...machineRules.flatMap(item => [item.machineRuleId]),
    ]);
    const source = sourceRequirementSource(sourceRequirement);
    const origin = sourceRequirement.origin || source.origin || 'unknown';
    const parsedBy = mergeUniqueArrays(
        sourceRequirement.parsedBy || [],
        source.parsedBy || [],
        clauses.flatMap(item => item.parsedBy || []),
        machineRules.flatMap(item => item.parsedBy || []),
        semanticActions.flatMap(item => item.parsedBy || []),
    );
    const primaryRequirementId = primary.requirementId || primary.id || requirementIds[0] || '';
    const card = {
        ...primary,
        id: sourceId,
        sourceId,
        sourceRequirement,
        primaryRequirementId,
        requirementIds,
        clauseIds,
        machineRuleIds,
        clauses,
        constraintIRs: clauses,
        machineRules,
        semanticActions,
        object: sourceCardDisplayObject(primary, clauses),
        intent: primary.intent || primary.capabilityId || 'requirement',
        condition: primary.condition || primary.scope || null,
        parameters: primary.parameters || {},
        strength: primary.strength || '',
        status: sourceRequirement.status
            || sourceRequirement.reviewStatus
            || primary.reviewStatus
            || primary.status
            || 'pending',
        understandingStatus: sourceRequirement.understandingStatus || primary.understandingStatus || '',
        executionStatus: sourceRequirement.executionStatus || primary.executionStatus || '',
        reviewStatus: sourceRequirement.reviewStatus || primary.reviewStatus || '',
        support: sourceRequirement.support || primary.support || '',
        applicationTarget: sourceRequirement.applicationTarget || '',
        requiresHumanReview: sourceRequirement.requiresHumanReview,
        reviewReasons: valueList(sourceRequirement.reviewReasons),
        applyTo: sourceRequirement.applicationTarget || primary.applyTo || primary.landing?.[0] || 'review',
        origin,
        parsedBy,
        confidence: sourceRequirement.confidence ?? primary.confidence,
        source,
        rawText: source.rawText,
        textHash: source.textHash,
        warnings: mergeUniqueArrays(
            sourceRequirement.warnings || [],
            clauses.flatMap(item => item.warnings || []),
            machineRules.flatMap(item => item.warnings || []),
            semanticActions.flatMap(item => item.warnings || []),
        ),
        questions: mergeUniqueArrays(sourceRequirement.questions || [], clauses.flatMap(item => item.clarifications || [])),
        enabled: sourceRequirement.enabled !== false,
        supportingRequirements: clauses.slice(1).map(requirementSupportSnapshot),
    };
    return promoteRequirementDisplay(card);
}

function buildSystemSupplementItems(review = {}) {
    const draftRows = valueList(review.draftRows).filter(item => item && typeof item === 'object');
    const legacyRequirements = valueList(review.requirementItems)
        .filter(item => item && typeof item === 'object')
        .filter(item => (item.origin || item.source?.origin || '') === 'system_supplement');
    const supplements = valueList(review.systemSupplements).filter(item => item && typeof item === 'object');
    const consumedLegacyIds = new Set();
    const cards = supplements.map((supplement, index) => {
        const requirement = supplement.requirement && typeof supplement.requirement === 'object'
            ? supplement.requirement
            : {};
        const sourceText = requirementSourceText(requirement) || supplement.reason || supplement.description || '';
        const matchingLegacy = legacyRequirements.filter(item => {
            const sameIdentity = [supplement.supplementId, requirement.id, requirement.requirementId]
                .filter(Boolean)
                .includes(item.supplementId || item.id || item.requirementId);
            const sameText = sourceTextKey(sourceText)
                && sourceTextKey(sourceText) === sourceTextKey(requirementSourceText(item));
            if (!sameIdentity && !sameText) return false;
            if (item.id) consumedLegacyIds.add(item.id);
            return true;
        });
        const machineRuleIds = uniqueValues([
            ...valueList(supplement.machineRuleIds),
            ...valueList(requirement.machineRuleIds),
            ...matchingLegacy.flatMap(item => valueList(item.machineRuleIds)),
        ]);
        const machineRules = draftRows.filter(row => machineRuleIds.includes(row.machineRuleId));
        const mergedRequirement = mergeClauseArtifacts(requirement, matchingLegacy)[0] || requirement;
        const id = supplement.supplementId || mergedRequirement.supplementId || mergedRequirement.id || `system_supplement_${index + 1}`;
        return promoteRequirementDisplay({
            ...mergedRequirement,
            id,
            sourceId: '',
            supplementId: id,
            primaryRequirementId: mergedRequirement.requirementId || mergedRequirement.id || '',
            requirementIds: uniqueValues(matchingLegacy.flatMap(item => [item.requirementId, item.id])),
            clauseIds: uniqueValues(matchingLegacy.flatMap(item => [item.clauseId, item.constraintId])),
            clauses: mergedRequirement && Object.keys(mergedRequirement).length ? [mergedRequirement] : [],
            constraintIRs: [],
            machineRuleIds,
            machineRules,
            semanticActions: [],
            origin: 'system_supplement',
            parsedBy: mergeUniqueArrays(supplement.parsedBy || [], mergedRequirement.parsedBy || []),
            status: mergedRequirement.status || 'handled',
            applyTo: mergedRequirement.applyTo || 'handled',
            source: {
                ...(mergedRequirement.source || {}),
                rawText: sourceText,
                origin: 'system_supplement',
            },
            warnings: mergeUniqueArrays(mergedRequirement.warnings || [], supplement.warnings || []),
            systemReason: supplement.reason || '',
        });
    });

    legacyRequirements.forEach((item, index) => {
        if (item.id && consumedLegacyIds.has(item.id)) return;
        cards.push(promoteRequirementDisplay({
            ...item,
            id: item.supplementId || item.id || `legacy_system_supplement_${index + 1}`,
            sourceId: '',
            supplementId: item.supplementId || '',
            primaryRequirementId: item.requirementId || item.id || '',
            requirementIds: uniqueValues([item.requirementId, item.id]),
            clauseIds: uniqueValues([item.clauseId, item.constraintId]),
            clauses: [item],
            constraintIRs: [],
            machineRules: draftRows.filter(row => valueList(item.machineRuleIds).includes(row.machineRuleId)),
            semanticActions: [],
            origin: 'system_supplement',
            parsedBy: item.parsedBy || [],
        }));
    });
    return cards;
}

function buildSourceUnifiedRequirementItems(review = {}) {
    const sourceRequirements = valueList(review.sourceRequirements).filter(item => item && typeof item === 'object');
    const requirementItems = valueList(review.requirementItems).filter(item => item && typeof item === 'object');
    const constraintIRs = valueList(review.constraintIRs).filter(item => item && typeof item === 'object');
    const draftRows = valueList(review.draftRows).filter(item => item && typeof item === 'object');
    const semanticActions = valueList(review.semanticActions).filter(item => item && typeof item === 'object');
    const indexes = createSourceIdentityIndexes(sourceRequirements, requirementItems, constraintIRs);
    const artifactsBySource = new Map(sourceRequirements.map(item => [item.sourceId, {
        constraintIRs: [],
        legacyRequirements: [],
        machineRules: [],
        semanticActions: [],
    }]));

    const attach = (artifact, collection) => {
        if ((artifact.origin || artifact.source?.origin || '') === 'system_supplement') return;
        const sourceId = sourceIdForArtifact(artifact, indexes);
        const owner = artifactsBySource.get(sourceId);
        if (owner) owner[collection].push(artifact);
    };
    constraintIRs.forEach(item => attach(item, 'constraintIRs'));
    requirementItems.forEach(item => attach(item, 'legacyRequirements'));
    draftRows.forEach(item => attach(item, 'machineRules'));
    semanticActions.forEach(item => attach(item, 'semanticActions'));

    return [
        ...sourceRequirements.map(sourceRequirement => buildSourceRequirementCard(
            sourceRequirement,
            artifactsBySource.get(sourceRequirement.sourceId) || {},
        )),
        ...buildSystemSupplementItems(review),
    ];
}

function buildLegacyUnifiedRequirementItems(review = {}) {
    const draftRows = valueList(review.draftRows).filter(item => item && typeof item === 'object');
    const semanticActions = valueList(review.semanticActions).filter(item => item && typeof item === 'object');
    const items = valueList(review.requirementItems).filter(item => item && typeof item === 'object').map((item, index) => ({
        ...item,
        id: item.id || `requirement_${index + 1}`,
        origin: item.origin || itemOriginFromSource(item.source),
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

export function buildUnifiedRequirementItems(review = {}) {
    if (Object.prototype.hasOwnProperty.call(review, 'sourceRequirements')) {
        return buildSourceUnifiedRequirementItems(review);
    }
    return buildLegacyUnifiedRequirementItems(review);
}

function reviewItemObjectLabel(item = {}) {
    const machineRule = valueList(item.machineRules).find(rule => rule && typeof rule === 'object');
    return machineRule?.targetName
        || machineRule?.target?.name
        || item.object?.name
        || item.targetName
        || '全局排课范围';
}

function reviewItemRawText(item = {}) {
    const displayRule = item.displayFromMachineRule ? executableMachineRule(item) : null;
    if (displayRule) {
        const ruleText = draftRowSourceText(displayRule);
        if (ruleText) return ruleText;
    }
    return item.source?.rawText
        || item.rawText
        || item.sourceRequirement?.rawText
        || item.sourceRequirement?.source?.rawText
        || '';
}

function reviewItemSourceLabel(item = {}) {
    const displayRule = item.displayFromMachineRule ? executableMachineRule(item) : null;
    const source = displayRule ? draftRowSource(displayRule) : (item.source || item.sourceRequirement?.source || {});
    const origin = item.origin || source.origin || 'unknown';
    const originLabel = origin === 'system_supplement'
        ? '系统补充'
        : origin === 'manual'
            ? '手动添加'
            : origin === 'user_input'
                ? '我的输入'
                : '来源未知';
    const sheet = source.sourceSheet || source.sheet || '';
    const row = source.sourceRow || source.row || source.lineNumber || '';
    const location = sheet && row
        ? `${sheet} 第 ${row} 行`
        : row
            ? `第 ${row} 行`
            : sheet;
    return [originLabel, location].filter(Boolean).join(' · ');
}

function reviewItemStatusTone(item = {}) {
    const status = normalizeStatusKey(item.status || item.reviewStatus || item.executionStatus || '');
    if (['handled', 'ignored', 'applied'].includes(status)) return 'handled';
    if (['needs_clarification', 'needs_review', 'review', 'invalid'].includes(status)) return 'review';
    if (['candidate', 'pending', 'partially_parsed', 'partially_supported', 'partially_actionable', 'partially_executable', 'understood_not_executable', 'unsupported_by_solver', 'unsupported'].includes(status)) {
        return 'warning';
    }
    if (valueList(item.warnings).length) return 'warning';
    return 'actionable';
}

function reviewItemAttentionItems(item = {}) {
    const values = [
        ...valueList(item.reviewReasons),
        ...valueList(item.warnings),
        ...valueList(item.questions),
        item.clarification?.question,
        item.modelSupport?.supported === false ? item.modelSupport?.message : '',
    ].map(value => {
        if (typeof value === 'string') return value.trim();
        if (!value || typeof value !== 'object') return '';
        return String(value.message || value.question || value.reason || value.label || '').trim();
    }).filter(Boolean);
    return [...new Set(values)];
}

function requirementReviewBucket(item = {}) {
    const group = getRequirementGroupKey(item);
    const status = normalizeStatusKey(item.status || item.reviewStatus || item.executionStatus || '');
    const isHandled = item.origin === 'system_supplement'
        || group === 'handled'
        || ['solver_policy', 'system_policy', 'handled'].includes(normalizeStatusKey(item.applyTo || item.applicationTarget || ''));
    if (isHandled) return 'handled';
    if (group === 'review'
        || item.requiresHumanReview === true
        || REVIEW_STATUSES.has(status)
        || valueList(item.conflicts).length
        || item.hasConflict === true) {
        return 'attention';
    }
    return 'applicable';
}

/**
 * Converts parser artifacts into the compact, user-facing review structure.
 * The original item is retained so existing edit/apply actions keep their identities.
 */
export function buildRequirementReviewViewModel(review = {}, state = {}) {
    const dialog = state.constraintDialog || state || {};
    const activeFilter = dialog.requirementFilter || 'all';
    const expansionState = dialog.technicalDetailsExpandedById || {};
    const allItems = buildUnifiedRequirementItems(review).map(item => {
        const bucket = requirementReviewBucket(item);
        const expandTechnicalByDefault = bucket === 'attention';
        const hasExplicitExpansion = Object.prototype.hasOwnProperty.call(expansionState, item.id);
        return {
            id: item.id || '',
            bucket,
            statusLabel: requirementStatusLabel(item),
            statusTone: reviewItemStatusTone(item),
            title: requirementIntentLabel(item.intent),
            objectLabel: reviewItemObjectLabel(item),
            destinationLabel: requirementApplyLabel(item.applyTo || item.applicationTarget || ''),
            destinationTone: requirementApplyTone(item.applyTo || item.applicationTarget || '', item.status || item.executionStatus || ''),
            destinationExplanation: requirementApplyExplanation(item.applyTo || item.applicationTarget || '', item.status || item.executionStatus || ''),
            sourceLabel: reviewItemSourceLabel(item),
            rawText: reviewItemRawText(item),
            attentionItems: reviewItemAttentionItems(item),
            technicalDetails: {
                warnings: valueList(item.warnings),
                clauses: valueList(item.clauses),
                machineRules: valueList(item.machineRules),
                semanticActions: valueList(item.semanticActions),
                parsedBy: valueList(item.parsedBy),
                aiReviewStatus: item.aiReviewStatus || item.aiReviewValidationStatus || '',
                modelSupport: item.modelSupport || null,
            },
            isSystemSupplement: item.origin === 'system_supplement',
            isActionable: requirementItemIsActionable(item, review),
            expandTechnicalByDefault,
            technicalDetailsExpanded: hasExplicitExpansion
                ? expansionState[item.id] === true
                : expandTechnicalByDefault,
            item,
        };
    });
    const visibleItems = activeFilter === 'all'
        ? allItems
        : allItems.filter(viewItem => getRequirementGroupKey(viewItem.item) === activeFilter);
    const selectableItems = dialog.systemGroupCollapsed === false
        ? visibleItems
        : visibleItems.filter(viewItem => !viewItem.isSystemSupplement);
    const groups = {
        attention: visibleItems.filter(item => item.bucket === 'attention'),
        applicable: visibleItems.filter(item => item.bucket === 'applicable'),
        handled: visibleItems.filter(item => item.bucket === 'handled'),
    };
    const selectedItem = selectableItems.find(item => item.id && item.id === dialog.selectedRequirementId)
        || selectableItems.find(item => item.bucket === 'attention')
        || selectableItems.find(item => item.bucket === 'applicable')
        || selectableItems[0]
        || null;
    return {
        items: allItems,
        visibleItems,
        groups,
        counts: {
            attention: groups.attention.length,
            applicable: groups.applicable.length,
            handled: groups.handled.length,
        },
        selectedId: selectedItem?.id || '',
        selectedItem,
    };
}

export function getDefaultRequirementId(items = [], filter = 'all') {
    const visibleItems = filterUnifiedRequirementItems(items, filter);
    const selected = visibleItems.find(item => requirementReviewBucket(item) === 'attention')
        || visibleItems.find(item => requirementReviewBucket(item) === 'applicable')
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
    return new Set(valueList(review.excludedApplyItemKeys).map(String).filter(Boolean));
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

export function buildConstraintApplyPlan(review = {}, filter = 'all') {
    const backendRuleRows = getBackendRuleRows(review, filter);
    const semanticActions = getApplicableSemanticActions(review, filter);
    const ruleKeys = new Set(backendRuleRows.map(draftRowApplyItemKey));
    const actionKeys = new Set(semanticActions.map(semanticActionApplyItemKey));
    const requirementItems = getActionableRequirementItems(review, filter).filter(item => (
        valueList(item.machineRules).some(row => ruleKeys.has(draftRowApplyItemKey(row)))
        || valueList(item.semanticActions).some(action => actionKeys.has(semanticActionApplyItemKey(action)))
    ));
    const hardRuleCount = backendRuleRows.filter(row => (
        normalizeKey(row.priority || row.strength || '') === 'hard'
    )).length;
    const lessonPlanActionCount = semanticActions.filter(action => (
        normalizeKey(action.kind || action.type || '') === 'lesson_plan_patch'
    )).length;

    return {
        filter,
        requirementItems,
        requirementIds: requirementItems.map(item => item.id).filter(Boolean),
        requirementCount: requirementItems.length,
        backendRuleRows,
        semanticActions,
        hardRuleCount,
        softRuleCount: backendRuleRows.length - hardRuleCount,
        lessonPlanActionCount,
        semanticActionCount: semanticActions.length,
        effectCount: backendRuleRows.length + semanticActions.length,
    };
}

export function getActionableRequirementCount(review = {}, filter = 'all') {
    return buildConstraintApplyPlan(review, filter).requirementCount;
}
