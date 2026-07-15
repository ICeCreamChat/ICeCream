const DAY_LABELS = ['', '一', '二', '三', '四', '五', '六', '日'];
const COURSE_SCOPE_RULE_TYPES = new Set([
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_morning',
    'subject_spread',
]);

const COURSE_SCOPE_ADVANCED_TYPES = Object.freeze({
    subject_preferred_periods: 'subject.preferred_periods',
    subject_avoid_periods: 'subject.avoid_periods',
    subject_morning: 'subject.preferred_day_part',
    subject_spread: 'subject.spread',
});
const CLASS_NAME_COLLATOR = new Intl.Collator('zh-CN', {
    numeric: true,
    sensitivity: 'base',
});
const CHINESE_NUMBER_DIGITS = Object.freeze({
    '零': 0,
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
});

export const CONSTRAINT_RULE_DEFINITIONS = Object.freeze([
    Object.freeze({
        type: 'teacher_unavailable',
        label: '教师不可排',
        targetKind: 'teacher',
        targetLabel: '教师',
        parameterKind: 'slots',
        strength: 'hard',
        parameterLabel: '不可排节次',
        helpText: '所选教师在勾选节次不得安排课程。',
    }),
    Object.freeze({
        type: 'class_unavailable',
        label: '班级不可排',
        targetKind: 'class',
        targetLabel: '班级',
        parameterKind: 'slots',
        strength: 'hard',
        parameterLabel: '不可排节次',
        helpText: '所选班级在勾选节次不得安排任何课程。',
    }),
    Object.freeze({
        type: 'subject_preferred_periods',
        label: '课程优先节次',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'slots',
        strength: 'soft',
        parameterLabel: '优先节次',
        helpText: '所选课程尽量安排在勾选节次。',
    }),
    Object.freeze({
        type: 'subject_avoid_periods',
        label: '课程避开节次',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'slots',
        strength: 'soft',
        parameterLabel: '避开节次',
        helpText: '所选课程尽量避开勾选节次。',
    }),
    Object.freeze({
        type: 'subject_morning',
        label: '课程上午优先',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'none',
        strength: 'soft',
        parameterLabel: '',
        helpText: '所选课程尽量安排在上午时段。',
    }),
    Object.freeze({
        type: 'subject_spread',
        label: '课程分散安排',
        targetKind: 'subject',
        targetLabel: '课程',
        parameterKind: 'none',
        strength: 'soft',
        parameterLabel: '',
        helpText: '所选课程尽量分布到不同日期。',
    }),
    Object.freeze({
        type: 'teacher_daily_limit',
        label: '教师每日上限',
        targetKind: 'teacher',
        targetLabel: '教师',
        parameterKind: 'limit',
        strength: 'soft',
        parameterLabel: '每天最多节数',
        helpText: '限制所选教师每天承担的最大课节数。',
    }),
    Object.freeze({
        type: 'teacher_consecutive_limit',
        label: '教师连续上限',
        targetKind: 'teacher',
        targetLabel: '教师',
        parameterKind: 'limit',
        strength: 'soft',
        parameterLabel: '连续最多节数',
        helpText: '限制所选教师连续上课的最大课节数。',
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

function lessonPlanTeacherIds(plan = {}) {
    return [...new Set([
        ...valueList(plan.teacherIds),
        plan.teacherId,
    ].map(value => String(value || '').trim()).filter(Boolean))];
}

function entityLabel(kind, entity = {}) {
    if (kind === 'class') {
        return [entity.grade, entity.name].filter(Boolean).join(' ') || entity.name || entity.id || '班级';
    }
    return entity.name || entity.label || entity.id || '对象';
}

function parseChineseInteger(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const tenIndex = normalized.indexOf('十');
    if (tenIndex >= 0) {
        const tens = tenIndex === 0 ? 1 : CHINESE_NUMBER_DIGITS[normalized[tenIndex - 1]];
        const ones = tenIndex === normalized.length - 1 ? 0 : CHINESE_NUMBER_DIGITS[normalized[tenIndex + 1]];
        return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : null;
    }
    return normalized.length === 1 && Number.isInteger(CHINESE_NUMBER_DIGITS[normalized])
        ? CHINESE_NUMBER_DIGITS[normalized]
        : null;
}

function classGradeNumber(entity = {}) {
    const grade = String(entity.grade || '').trim();
    const name = String(entity.name || '').trim();
    const combined = `${grade} ${name}`;
    const gGrade = combined.match(/(?:^|[^a-z0-9])g\s*(\d{1,2})(?=[^0-9]|$)/i);
    if (gGrade) return Number.parseInt(gGrade[1], 10);
    const numericGrade = combined.match(/(\d{1,2})\s*年级/);
    if (numericGrade) return Number.parseInt(numericGrade[1], 10);
    const chineseGrade = combined.match(/([一二三四五六七八九十两]+)\s*年级/);
    if (chineseGrade) return parseChineseInteger(chineseGrade[1]);
    const juniorGrade = combined.match(/初([一二三])/);
    if (juniorGrade) return 6 + parseChineseInteger(juniorGrade[1]);
    const seniorGrade = combined.match(/高([一二三])/);
    if (seniorGrade) return 9 + parseChineseInteger(seniorGrade[1]);
    return null;
}

function classSequenceNumber(entity = {}) {
    const name = String(entity.name || '').trim();
    const gClass = name.match(/(?:^|[^a-z0-9])g\s*\d{1,2}\s*[-－—_/]\s*(\d{1,3})/i);
    if (gClass) return Number.parseInt(gClass[1], 10);
    const numericClass = name.match(/(\d{1,3})\s*班(?:\s|$)/);
    if (numericClass) return Number.parseInt(numericClass[1], 10);
    const chineseClass = name.match(/([一二三四五六七八九十两]+)\s*班(?:\s|$)/);
    return chineseClass ? parseChineseInteger(chineseClass[1]) : null;
}

function compareClassEntities(left = {}, right = {}) {
    const leftGrade = classGradeNumber(left);
    const rightGrade = classGradeNumber(right);
    if (leftGrade !== null && rightGrade !== null && leftGrade !== rightGrade) {
        return leftGrade - rightGrade;
    }
    if ((leftGrade === null) !== (rightGrade === null)) return leftGrade === null ? 1 : -1;

    const leftSequence = classSequenceNumber(left);
    const rightSequence = classSequenceNumber(right);
    if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
    }
    if ((leftSequence === null) !== (rightSequence === null) && leftGrade !== null) {
        return leftSequence === null ? 1 : -1;
    }
    return CLASS_NAME_COLLATOR.compare(entityLabel('class', left), entityLabel('class', right));
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

function firstScopeId(value) {
    return String(valueList(value)[0] || '').trim();
}

function courseScopePlans(project = {}, subjectId = '', classId = '', teacherId = '') {
    const normalizedSubjectId = String(subjectId || '').trim();
    const normalizedClassId = String(classId || '').trim();
    const normalizedTeacherId = String(teacherId || '').trim();
    return valueList(project.lessonPlans).filter(plan => (
        (!normalizedSubjectId || String(plan.subjectId || '') === normalizedSubjectId)
        && (!normalizedClassId || String(plan.classId || '') === normalizedClassId)
        && (!normalizedTeacherId || lessonPlanTeacherIds(plan).includes(normalizedTeacherId))
    ));
}

function courseScopeValue(form = {}, project = {}) {
    const subjectId = resolveTargetId(form, 'subject');
    const classId = String(form.scopeClassId || form.classId || '').trim();
    const restrictTeacher = form.restrictTeacher === true
        || form.limitToTeacher === true
        || String(form.restrictTeacher || form.limitToTeacher || '') === 'true';
    const teacherId = restrictTeacher
        ? String(form.scopeTeacherId || form.teacherId || '').trim()
        : '';
    const klass = entityCollection(project, 'class').find(item => String(item.id || '') === classId) || null;
    const teacher = entityCollection(project, 'teacher').find(item => String(item.id || '') === teacherId) || null;
    const subject = entityCollection(project, 'subject').find(item => String(item.id || '') === subjectId) || null;
    const plans = courseScopePlans(project, subjectId, classId, teacherId);
    return {
        subjectId,
        classId,
        teacherId,
        restrictTeacher,
        subject,
        klass,
        teacher,
        plans,
        label: [
            klass ? entityLabel('class', klass) : '',
            subject ? entityLabel('subject', subject) : '',
            teacher ? entityLabel('teacher', teacher) : (classId ? '不限教师' : ''),
        ].filter(Boolean).join(' · '),
    };
}

function morningSlots(project = {}) {
    const range = getConstraintRuleRange(project);
    const afternoonStart = Math.max(1, Number(project.dayPartBoundaries?.afternoonStartPeriod) || 5);
    const periods = range.periods.filter(period => period < afternoonStart);
    return range.weekdays.flatMap(day => periods.map(period => `${day}-${period}`));
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

export function isCourseScopeRule(type = '') {
    return COURSE_SCOPE_RULE_TYPES.has(normalizeRuleType(type));
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

export function getConstraintRuleScopeClassOptions(project = {}, type = '', subjectId = '') {
    if (!isCourseScopeRule(type) || !subjectId) return [];
    const classesById = new Map(entityCollection(project, 'class').map(item => [String(item.id || ''), item]));
    return [...new Set(courseScopePlans(project, subjectId).map(plan => String(plan.classId || '')).filter(Boolean))]
        .map(id => classesById.get(id))
        .filter(Boolean)
        .sort(compareClassEntities)
        .map(item => ({ id: String(item.id), name: entityLabel('class', item) }));
}

export function getConstraintRuleScopeTeacherOptions(project = {}, type = '', subjectId = '', classId = '') {
    if (!isCourseScopeRule(type) || !subjectId || !classId) return [];
    const teachersById = new Map(entityCollection(project, 'teacher').map(item => [String(item.id || ''), item]));
    return [...new Set(courseScopePlans(project, subjectId, classId)
        .flatMap(plan => lessonPlanTeacherIds(plan)))]
        .map(id => teachersById.get(id))
        .filter(Boolean)
        .map(item => ({ id: String(item.id), name: entityLabel('teacher', item) }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
}

export function formatConstraintSlot(slot = '') {
    const match = String(slot || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return String(slot || '');
    const day = Number.parseInt(match[1], 10);
    const period = Number.parseInt(match[2], 10);
    return `周${DAY_LABELS[day] || day}第${period}节`;
}

export function getConstraintRuleFormValue(constraint = {}) {
    const definition = getConstraintRuleDefinition(constraint.formType || constraint.intent || constraint.type);
    const targetKind = constraint.targetType || constraint.target?.type || constraint.target?.kind || definition?.targetKind || '';
    const targetId = constraint.targetId || constraint.target?.id || '';
    const scope = constraint.scope || {};
    const parameters = constraint.parameters || {};
    const scopeClassId = firstScopeId(constraint.scopeClassId || scope.classIds || parameters.classIds);
    const scopeTeacherId = firstScopeId(constraint.scopeTeacherId || scope.teacherIds || parameters.teacherIds);
    return {
        type: definition?.type || '',
        targetKind,
        targetId: String(targetId || ''),
        targetValue: targetKind && targetId ? `${targetKind}:${targetId}` : '',
        slots: normalizeSlots([
            ...valueList(constraint.slots),
            ...valueList(constraint.time?.slots),
            ...valueList(parameters.slots),
        ]),
        limit: constraint.limit ?? constraint.value ?? '',
        scopeClassId,
        scopeTeacherId,
        restrictTeacher: Boolean(scopeTeacherId),
        legacyCourseGlobal: Boolean(
            definition && isCourseScopeRule(definition.type) && !scopeClassId
        ),
    };
}

export function validateConstraintRuleForm(form = {}, project = {}) {
    const definition = getConstraintRuleDefinition(form.type);
    const errors = {};
    if (!definition) {
        errors.type = '请选择具体规则类型';
        return { valid: false, errors, definition: null, target: null, slots: [], limit: null, scope: null };
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
    const scope = isCourseScopeRule(definition.type) ? courseScopeValue(form, project) : null;
    if (scope) {
        if (!scope.classId || !scope.klass) {
            errors.scopeClass = '请选择该课程适用的班级';
        } else if (scope.restrictTeacher && (!scope.teacherId || !scope.teacher)) {
            errors.scopeTeacher = '请选择需要限定的任课教师';
        } else if (!scope.plans.length) {
            errors.scopeTeacher = scope.restrictTeacher
                ? '该课程、班级和教师没有匹配的任课安排'
                : '该课程和班级没有匹配的任课安排';
        }
    }
    return {
        valid: Object.keys(errors).length === 0,
        errors,
        definition,
        target,
        slots: definition.parameterKind === 'slots' ? slots : [],
        limit,
        range,
        scope,
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
    const { definition, target, slots, limit, scope } = validation;
    const scopedCourseRule = isCourseScopeRule(definition.type);
    const id = String(existing.id || options.id || createArtifactId());
    const sourceId = existing.sourceId || existing.source?.sourceId || `manual:source:${id}`;
    const clauseId = existing.clauseId || `${sourceId}:clause:1`;
    const machineRuleId = existing.machineRuleId || `${sourceId}:rule:1`;
    const requirementId = existing.requirementId || `${sourceId}:requirement:1`;
    const parameters = {
        ...(definition.parameterKind === 'slots' ? { slots } : {}),
        ...(definition.parameterKind === 'limit' ? { limit } : {}),
        ...(definition.type === 'subject_morning' ? { dayPart: 'morning' } : {}),
        ...(scopedCourseRule ? {
            classIds: [scope.classId],
            ...(scope.teacherId ? { teacherIds: [scope.teacherId] } : {}),
            ...(definition.type === 'subject_morning' ? { slots: morningSlots(project) } : {}),
        } : {}),
    };
    const summary = summarizeConstraintRule(definition.type, scopedCourseRule ? scope.label : target.name, parameters);
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
        type: scopedCourseRule ? 'advanced_constraint' : definition.type,
        intent: definition.type,
        ...(scopedCourseRule ? { advancedType: COURSE_SCOPE_ADVANCED_TYPES[definition.type] } : {}),
        typeLabel: definition.label,
        targetType: target.kind,
        targetId: target.id,
        targetName: target.name,
        target: { type: target.kind, id: target.id, name: target.name },
        ...(scopedCourseRule ? {
            parameters,
            scope: {
                classIds: [scope.classId],
                ...(scope.teacherId ? { teacherIds: [scope.teacherId] } : {}),
            },
            scopeClassId: scope.classId,
            scopeClassName: entityLabel('class', scope.klass),
            scopeTeacherId: scope.teacherId,
            scopeTeacherName: scope.teacher ? entityLabel('teacher', scope.teacher) : '',
            scopeLabel: scope.label,
        } : {}),
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
        condition: definition.parameterKind === 'slots' ? { slots: parameters.slots || slots } : {},
        parameters,
        ...(scopedCourseRule ? { scope: draftRow.scope } : {}),
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
