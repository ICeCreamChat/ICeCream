const DAY_LABELS = ['', '一', '二', '三', '四', '五', '六', '日'];

export const CONSTRAINT_RULE_DEFINITIONS = Object.freeze([
    Object.freeze({
        type: 'teacher_unavailable',
        label: '教师不可排',
        targetKind: 'teacher',
        targetLabel: '教师',
        parameterKind: 'slots',
        strength: 'hard',
        parameterLabel: '不可排节次',
    }),
    Object.freeze({
        type: 'class_unavailable',
        label: '班级不可排',
        targetKind: 'class',
        targetLabel: '班级',
        parameterKind: 'slots',
        strength: 'hard',
        parameterLabel: '不可排节次',
    }),
    Object.freeze({
        type: 'subject_preferred_periods',
        label: '课程优先节次',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'slots',
        strength: 'soft',
        parameterLabel: '优先节次',
    }),
    Object.freeze({
        type: 'subject_avoid_periods',
        label: '课程避开节次',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'slots',
        strength: 'soft',
        parameterLabel: '避开节次',
    }),
    Object.freeze({
        type: 'subject_morning',
        label: '课程上午优先',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'none',
        strength: 'soft',
        parameterLabel: '',
    }),
    Object.freeze({
        type: 'subject_spread',
        label: '课程分散安排',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'none',
        strength: 'soft',
        parameterLabel: '',
    }),
    Object.freeze({
        type: 'teacher_daily_limit',
        label: '教师每日上限',
        targetKind: 'teacher',
        targetLabel: '教师',
        parameterKind: 'limit',
        strength: 'soft',
        parameterLabel: '每天最多节数',
    }),
    Object.freeze({
        type: 'teacher_consecutive_limit',
        label: '教师连续上限',
        targetKind: 'teacher',
        targetLabel: '教师',
        parameterKind: 'limit',
        strength: 'soft',
        parameterLabel: '连续最多节数',
    }),
]);

const DEFINITION_BY_TYPE = new Map(CONSTRAINT_RULE_DEFINITIONS.map(item => [item.type, item]));

function valueList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function normalizeRuleType(value = '') {
    return String(value || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function uniquePositiveIntegers(values = []) {
    return [...new Set(valueList(values)
        .map(Number)
        .filter(value => Number.isInteger(value) && value > 0))];
}

function entityCollection(project = {}, kind = '') {
    return {
        teacher: valueList(project.teachers),
        class: valueList(project.classes),
        subject: valueList(project.subjects),
    }[kind] || [];
}

function entityLabel(kind, entity = {}) {
    if (kind === 'class') {
        return [entity.grade, entity.name].filter(Boolean).join(' ') || entity.name || entity.id || '班级';
    }
    return entity.name || entity.label || entity.id || '对象';
}

function activeWeekdays(project = {}) {
    const configured = uniquePositiveIntegers(project.activeWeekdays);
    if (configured.length) return configured;
    return Array.from({ length: Math.max(1, Number(project.weekdays) || 5) }, (_, index) => index + 1);
}

function activePeriods(project = {}) {
    const configured = uniquePositiveIntegers(project.activePeriods);
    if (configured.length) return configured;
    return Array.from({ length: Math.max(1, Number(project.periodsPerDay) || 7) }, (_, index) => index + 1);
}

function normalizeSlots(slots = []) {
    return [...new Set(valueList(slots).map(value => String(value || '').trim()).filter(Boolean))];
}

function resolveTargetId(form = {}, expectedKind = '') {
    const direct = String(form.targetId || '').trim();
    if (direct) return direct.includes(':') ? direct.split(':').slice(1).join(':') : direct;
    const value = String(form.targetValue || '').trim();
    if (!value) return '';
    const separator = value.indexOf(':');
    if (separator < 0) return value;
    const kind = value.slice(0, separator);
    return kind === expectedKind ? value.slice(separator + 1) : '';
}

function createArtifactId() {
    return `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getConstraintRuleDefinition(type = '') {
    return DEFINITION_BY_TYPE.get(normalizeRuleType(type)) || null;
}

export function getConstraintRuleRange(project = {}) {
    return {
        weekdays: activeWeekdays(project),
        periods: activePeriods(project),
    };
}

export function getConstraintRuleTargetOptions(project = {}, type = '') {
    const definition = getConstraintRuleDefinition(type);
    if (!definition) return [];
    return entityCollection(project, definition.targetKind).map(entity => ({
        kind: definition.targetKind,
        id: String(entity.id || ''),
        name: entityLabel(definition.targetKind, entity),
    })).filter(entity => entity.id);
}

export function formatConstraintSlot(slot = '') {
    const match = String(slot || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return String(slot || '');
    const day = Number.parseInt(match[1], 10);
    const period = Number.parseInt(match[2], 10);
    return `周${DAY_LABELS[day] || day}第${period}节`;
}

export function getConstraintRuleFormValue(constraint = {}) {
    const definition = getConstraintRuleDefinition(constraint.type || constraint.intent);
    const targetKind = constraint.targetType || constraint.target?.type || constraint.target?.kind || definition?.targetKind || '';
    const targetId = constraint.targetId || constraint.target?.id || '';
    return {
        type: definition?.type || '',
        targetKind,
        targetId: String(targetId || ''),
        targetValue: targetKind && targetId ? `${targetKind}:${targetId}` : '',
        slots: normalizeSlots([
            ...valueList(constraint.slots),
            ...valueList(constraint.time?.slots),
        ]),
        limit: constraint.limit ?? constraint.value ?? '',
    };
}

export function validateConstraintRuleForm(form = {}, project = {}) {
    const definition = getConstraintRuleDefinition(form.type);
    const errors = {};
    if (!definition) {
        errors.type = '请选择具体规则类型';
        return { valid: false, errors, definition: null, target: null, slots: [], limit: null };
    }

    const targetId = resolveTargetId(form, definition.targetKind);
    const targetEntity = entityCollection(project, definition.targetKind)
        .find(entity => String(entity.id || '') === targetId);
    if (!targetEntity) errors.target = `请选择项目中的${definition.targetLabel}`;

    const range = getConstraintRuleRange(project);
    const allowedSlots = new Set(range.weekdays.flatMap(day => range.periods.map(period => `${day}-${period}`)));
    const slots = normalizeSlots(form.slots);
    if (definition.parameterKind === 'slots') {
        if (!slots.length) {
            errors.slots = `请至少选择一个${definition.parameterLabel}`;
        } else if (slots.some(slot => !allowedSlots.has(slot))) {
            errors.slots = '所选节次超出当前排课范围';
        }
    }

    const parsedLimit = Number(form.limit);
    const maxLimit = range.periods.length;
    let limit = null;
    if (definition.parameterKind === 'limit') {
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
            errors.limit = `请输入 1 到 ${maxLimit} 之间的整数`;
        } else {
            limit = parsedLimit;
        }
    }

    const target = targetEntity ? {
        kind: definition.targetKind,
        id: targetId,
        name: entityLabel(definition.targetKind, targetEntity),
    } : null;
    return {
        valid: Object.keys(errors).length === 0,
        errors,
        definition,
        target,
        slots: definition.parameterKind === 'slots' ? slots : [],
        limit,
        range,
    };
}

export function summarizeConstraintRule(type = '', targetName = '', parameters = {}) {
    const slots = normalizeSlots(parameters.slots);
    const slotText = slots.map(formatConstraintSlot).join('、');
    const limit = Number(parameters.limit);
    return {
        teacher_unavailable: `${targetName} 不可排：${slotText}`,
        class_unavailable: `${targetName} 不可排：${slotText}`,
        subject_preferred_periods: `${targetName} 优先安排：${slotText}`,
        subject_avoid_periods: `${targetName} 尽量避开：${slotText}`,
        subject_morning: `${targetName} 上午优先`,
        subject_spread: `${targetName} 一周内分散安排`,
        teacher_daily_limit: `${targetName} 每天最多 ${limit} 节`,
        teacher_consecutive_limit: `${targetName} 连续最多 ${limit} 节`,
    }[normalizeRuleType(type)] || `${targetName} 约束规则`;
}

export function compileConstraintRuleArtifacts(form = {}, project = {}, options = {}) {
    const validation = validateConstraintRuleForm(form, project);
    if (!validation.valid) return { ok: false, ...validation };

    const existing = options.existing || {};
    const { definition, target, slots, limit } = validation;
    const id = String(existing.id || options.id || createArtifactId());
    const sourceId = existing.sourceId || existing.source?.sourceId || `manual:source:${id}`;
    const clauseId = existing.clauseId || `${sourceId}:clause:1`;
    const machineRuleId = existing.machineRuleId || `${sourceId}:rule:1`;
    const requirementId = existing.requirementId || `${sourceId}:requirement:1`;
    const parameters = {
        ...(definition.parameterKind === 'slots' ? { slots } : {}),
        ...(definition.parameterKind === 'limit' ? { limit } : {}),
        ...(definition.type === 'subject_morning' ? { dayPart: 'morning' } : {}),
    };
    const summary = summarizeConstraintRule(definition.type, target.name, parameters);
    const sourceText = existing.sourceText || existing.rawText || summary;
    const origin = existing.origin || existing.source?.origin || 'manual';
    const parsedBy = valueList(existing.parsedBy || existing.source?.parsedBy || ['manual']);
    const source = {
        ...(existing.source && typeof existing.source === 'object' ? existing.source : {}),
        sourceId,
        rawText: sourceText,
        origin,
        parsedBy,
    };
    const draftRow = {
        ...existing,
        id,
        type: definition.type,
        typeLabel: definition.label,
        targetType: target.kind,
        targetId: target.id,
        targetName: target.name,
        target: { type: target.kind, id: target.id, name: target.name },
        priority: definition.strength,
        strength: definition.strength,
        status: 'effective',
        reviewStatus: 'actionable',
        executionStatus: 'executable',
        description: summary,
        understanding: summary,
        sourceText,
        rawText: existing.rawText || sourceText,
        origin,
        parsedBy,
        confidence: 1,
        confidenceTone: 'high',
        confidenceLabel: '高',
        sourceId,
        clauseId,
        machineRuleId,
        requirementId,
        source,
        warnings: [],
    };
    delete draftRow.time;
    delete draftRow.timeLabel;
    delete draftRow.originalId;
    delete draftRow.formType;
    delete draftRow.formErrors;
    delete draftRow.limit;
    delete draftRow.value;
    delete draftRow.slots;
    if (definition.parameterKind === 'slots') draftRow.slots = slots;
    if (definition.parameterKind === 'limit') draftRow.limit = limit;

    const requirementItem = {
        id: requirementId,
        requirementId,
        sourceId,
        clauseId,
        machineRuleIds: [machineRuleId],
        rowId: id,
        object: {
            kind: target.kind,
            name: target.name,
            matchedIds: [target.id],
            scope: 'explicit',
        },
        intent: definition.type,
        condition: definition.parameterKind === 'slots' ? { slots } : {},
        parameters,
        strength: definition.strength,
        status: 'actionable',
        reviewStatus: 'actionable',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        applyTo: 'rule',
        applicationTarget: 'rule',
        requiresHumanReview: false,
        origin,
        parsedBy,
        confidence: 1,
        source,
        warnings: [],
    };
    const sourceRequirement = {
        sourceId,
        rawText: sourceText,
        origin,
        parsedBy,
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        reviewStatus: 'actionable',
        status: 'actionable',
        applicationTarget: 'rule',
        requiresHumanReview: false,
        confidence: 1,
        clauses: [requirementItem],
        machineRuleIds: [machineRuleId],
        source,
        warnings: [],
    };

    return {
        ok: true,
        errors: {},
        definition,
        target,
        draftRow,
        requirementItem,
        sourceRequirement,
        constraintIR: { ...requirementItem },
    };
}
