import {
    getActiveWeekdays,
    getDayPartPeriods,
    getTimetableEntityMaps,
    normalizeTimetableProject,
    slotKey,
    slotTeacherIds,
} from './timetable-project.js';
import { evaluateAdvancedRule } from './timetable-advanced-rules.js';

const STATUS_LABELS = {
    satisfied: '已满足',
    partial: '部分满足',
    violated: '未满足',
    not_evaluable: '暂不可评估',
    unmet: '未满足',
    not_applicable: '未参与',
};

const TYPE_LABELS = {
    teacher_unavailable: '教师不可排',
    class_unavailable: '班级不可排',
    global_unavailable: '全校不可排',
    locked_slot: '锁定课节',
    subject_morning: '课程上午优先',
    subject_afternoon: '课程下午优先',
    subject_preferred_periods: '课程偏好节次',
    subject_avoid_periods: '课程避开节次',
    subject_daily_limit: '课程每日上限',
    teacher_daily_limit: '教师每日上限',
    teacher_consecutive_limit: '教师连续上限',
    teacher_weekly_limit: '教师每周上限',
    teacher_max_days_per_week: '教师每周授课天数',
    teacher_mutual_exclusion: '教师互斥',
    subject_not_same_day: '课程不同天',
    room_requirement: '教室要求',
    subject_spread: '同科分散',
    course_interval: '课程间隔',
    class_daily_subject_balance: '班级每日科目均衡',
    class_daily_balance: '班级每日科目均衡',
    teacher_gap_preference: '教师少空堂',
    teacher_load_balance: '教师负载均衡',
    subject_sequence: '课程顺序',
    'teacher.compact_day': '教师集中授课',
    'teacher.prep_group_fairness': '教师备课组均衡',
    'lesson.consecutive': '连续课节',
    'subject.preferred_day_part': '课程优先时段',
    'subject.preferred_periods': '课程偏好节次',
    'subject.avoid_periods': '课程避开节次',
    'subject.spread': '课程分散安排',
    'subject.avoid_weekday_concentration': '课程避免集中在同一天',
    'subject.not_consecutive_with': '课程不连续安排',
    'schedule.cross_venue_boundary': '跨场地换课限制',
    'lesson.activity_scope_period_policy': '活动类型节次策略',
    'lesson.resource_attribute_avoid_periods': '资源属性避开节次',
    'room.preferred': '优先使用指定教室',
    'room.required': '教室要求',
    'room.forbidden_type': '禁用教室类型',
};

const FULFILLMENT_PRIMITIVES = [
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'subject_morning',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'subject_spread',
    'subject_afternoon',
    'room_requirement',
    'class_daily_subject_balance',
    'teacher_gap_preference',
    'teacher_load_balance',
    'global_unavailable',
    'subject_daily_limit',
    'teacher_weekly_limit',
    'teacher_max_days_per_week',
    'teacher_mutual_exclusion',
    'subject_not_same_day',
    'subject_sequence',
    'course_interval',
];

const PRIMITIVE_ALIASES = {
    class_daily_subject_balance: 'class_daily_balance',
    class_daily_balance: 'class_daily_subject_balance',
};

const EVALUABLE_PRIMITIVES = new Set([
    ...FULFILLMENT_PRIMITIVES,
    'class_daily_balance',
    'advanced_constraint',
]);

const LEGACY_STATUS_TO_V2 = {
    satisfied: 'satisfied',
    partial: 'partial',
    unmet: 'violated',
    violated: 'violated',
    not_applicable: 'not_evaluable',
    not_evaluable: 'not_evaluable',
};

function cleanRuleId(...parts) {
    return parts
        .map(part => String(part ?? '').trim())
        .filter(Boolean)
        .join(':');
}

function className(project, classId) {
    const klass = project.classes.find(item => item.id === classId);
    if (!klass) return classId || '';
    return `${klass.grade || ''}${klass.name || klass.id}`;
}

function entityName(project, kind, id) {
    if (!id) return '';
    if (kind === 'class') return className(project, id);
    const maps = getTimetableEntityMaps(project);
    const pool = kind === 'teacher'
        ? maps.teachers
        : kind === 'subject'
            ? maps.subjects
            : maps.plans;
    return pool.get(id)?.name || id;
}

function scopedCourseRuleLabel(project, rule = {}) {
    const parameters = rule.parameters || {};
    const scope = rule.scope || {};
    const classIds = [...new Set([...(parameters.classIds || []), ...(scope.classIds || [])].filter(Boolean))];
    const teacherIds = [...new Set([...(parameters.teacherIds || []), ...(scope.teacherIds || [])].filter(Boolean))];
    const isCourseRule = rule.target?.kind === 'subject' && [
        'subject.preferred_periods',
        'subject.avoid_periods',
        'subject.preferred_day_part',
        'subject.spread',
    ].includes(rule.type);
    if (!isCourseRule) return '';
    if (!classIds.length) return '历史全校范围';
    const classes = classIds.map(classId => entityName(project, 'class', classId)).filter(Boolean);
    const teachers = teacherIds.map(teacherId => entityName(project, 'teacher', teacherId)).filter(Boolean);
    return [
        ...classes,
        entityName(project, 'subject', rule.target?.matchedIds?.[0]) || rule.target?.name || '',
        teachers.length ? teachers.join('、') : '不限教师',
    ].filter(Boolean).join(' · ');
}

function historicalGlobalCourseScope() {
    return {
        scopeLabel: '历史全校范围',
        legacyCourseGlobal: true,
    };
}

function slotLabel(slot = {}) {
    return `周${Number(slot.day)}第${Number(slot.period)}节`;
}

function locateFromSlot(project, slot = {}, targetKind = 'class', targetId = '') {
    const kind = targetKind || (slot.teacherId ? 'teacher' : 'class');
    const id = targetId || (kind === 'teacher' ? slot.teacherId : slot.classId);
    return {
        targetKind: kind,
        targetId: id || '',
        targetName: entityName(project, kind, id) || '',
        day: Number(slot.day) || null,
        period: Number(slot.period) || null,
        slotId: slot.id || '',
        slot,
    };
}

function locateExpectedCell(project, rule = {}) {
    const raw = rule.raw || {};
    return {
        targetKind: rule.targetKind || 'class',
        targetId: rule.targetId || raw.classId || '',
        targetName: rule.targetName || entityName(project, rule.targetKind || 'class', rule.targetId || raw.classId),
        day: Number(raw.day) || Number(rule.slots?.[0]?.split?.('-')?.[0]) || null,
        period: Number(raw.period) || Number(rule.slots?.[0]?.split?.('-')?.[1]) || null,
        slotId: '',
        slot: raw.day && raw.period ? { day: Number(raw.day), period: Number(raw.period) } : null,
    };
}

function evidenceSlotFromLocate(target = {}) {
    const slot = target.slot || {};
    const day = Number(target.day ?? slot.day);
    const period = Number(target.period ?? slot.period);
    if (!Number.isFinite(day) || !Number.isFinite(period)) return null;
    return {
        day,
        period,
        classId: target.targetKind === 'class' ? target.targetId || slot.classId || '' : slot.classId || '',
        subjectId: slot.subjectId || '',
        teacherId: target.targetKind === 'teacher' ? target.targetId || slot.teacherId || '' : slot.teacherId || '',
        ...(slot.roomId ? { roomId: slot.roomId } : {}),
        ...(slot.id ? { slotId: slot.id } : {}),
    };
}

function suggestion(kind, label) {
    return { kind, label };
}

function suggestionsForResult(rule = {}, status = '') {
    if (status === 'satisfied') return [];
    if (status === 'not_evaluable') {
        return [
            suggestion('manual', '补齐项目数据或生成课表后再评估'),
        ];
    }

    const isHard = rule.priority === 'hard';
    const slotLike = (rule.slots || []).length > 0 || [
        'teacher_unavailable',
        'class_unavailable',
        'global_unavailable',
        'locked_slot',
        'subject_preferred_periods',
        'subject_avoid_periods',
    ].includes(rule.type);
    const actions = [];
    if (isHard) actions.push(suggestion('relax_to_soft', '改为软约束再重新排课'));
    if (slotLike) actions.push(suggestion('shrink_slots', '缩小或调整约束时段'));
    actions.push(suggestion('delete_rule', isHard ? '确认后删除这条硬约束' : '确认后删除这条偏好'));
    actions.push(suggestion('manual', '人工调整相关课节后重新评估'));
    return actions.slice(0, 3);
}

function makeResult(rule, status, evidence, locateTargets = []) {
    const v2Status = LEGACY_STATUS_TO_V2[status] || status;
    const semanticType = rule.advancedType || rule.capabilityId || rule.advancedRule?.type || rule.primitive || rule.type;
    const normalizedLocateTargets = locateTargets.filter(Boolean);
    const evidenceSlots = normalizedLocateTargets
        .map(evidenceSlotFromLocate)
        .filter(Boolean);
    return {
        id: rule.id,
        ruleId: rule.id,
        type: rule.type,
        primitive: PRIMITIVE_ALIASES[rule.type] || rule.type,
        advancedType: rule.advancedType || rule.advancedRule?.type || (rule.type === 'advanced_constraint' ? rule.primitive : ''),
        capabilityId: rule.capabilityId || rule.advancedRule?.capabilityId || (rule.type === 'advanced_constraint' ? rule.primitive : ''),
        typeLabel: TYPE_LABELS[rule.type] || TYPE_LABELS[semanticType] || rule.description || semanticType || '约束规则',
        source: rule.source,
        origin: rule.source || 'project.rules',
        priority: rule.priority,
        strength: rule.priority === 'hard' ? 'hard' : 'soft',
        targetKind: rule.targetKind,
        targetId: rule.targetId,
        targetName: rule.targetName,
        sourceId: rule.sourceId || rule.advancedRule?.sourceId || '',
        clauseId: rule.clauseId || rule.advancedRule?.clauseId || '',
        scopeLabel: rule.scopeLabel || '',
        legacyCourseGlobal: rule.legacyCourseGlobal === true,
        slots: rule.slots || [],
        title: rule.title || `${rule.targetName || ''}${rule.description ? ` ${rule.description}` : ''}`.trim(),
        description: rule.description,
        rawText: rule.rawText
            || rule.sourceText
            || rule.source?.rawText
            || rule.originalText
            || rule.advancedRule?.rawText
            || rule.advancedRule?.sourceText
            || rule.advancedRule?.source?.rawText
            || rule.advancedRule?.originalText
            || '',
        status: v2Status,
        legacyStatus: status,
        statusLabel: STATUS_LABELS[v2Status] || STATUS_LABELS[status] || status,
        evidence,
        detail: evidence,
        evidenceSlots,
        suggestions: suggestionsForResult(rule, v2Status),
        locateTargets: normalizedLocateTargets,
    };
}

function pushSlotRules(items, project, { type, source, targetKind, slotMap = {}, priority, description }) {
    Object.entries(slotMap || {}).forEach(([targetId, slots]) => {
        (Array.isArray(slots) ? slots : []).forEach(slot => {
            const normalizedSlot = typeof slot === 'string' ? slot : slotKey(slot?.day, slot?.period);
            items.push({
                id: cleanRuleId(type, targetId, normalizedSlot),
                type,
                source,
                targetKind,
                targetId,
                targetName: entityName(project, targetKind, targetId),
                slots: [normalizedSlot],
                priority,
                description,
                title: `${entityName(project, targetKind, targetId)} ${description} ${normalizedSlot}`,
            });
        });
    });
}

function savedConstraintItems(project) {
    const rules = project.rules || {};
    const hard = rules.hardRules || {};
    const soft = rules.softRules || {};
    const items = [];

    pushSlotRules(items, project, {
        type: 'teacher_unavailable',
        source: 'hardRules.teacherUnavailable',
        targetKind: 'teacher',
        slotMap: hard.teacherUnavailable,
        priority: 'hard',
        description: '教师不可排',
    });
    pushSlotRules(items, project, {
        type: 'class_unavailable',
        source: 'hardRules.classUnavailable',
        targetKind: 'class',
        slotMap: hard.classUnavailable,
        priority: 'hard',
        description: '班级不可排',
    });
    (hard.globalUnavailable || []).forEach(slot => {
        items.push({
            id: cleanRuleId('global_unavailable', slot),
            type: 'global_unavailable',
            source: 'hardRules.globalUnavailable',
            targetKind: 'global',
            targetId: '__global__',
            targetName: '全校',
            slots: [slot],
            priority: 'hard',
            description: '全校不可排',
            title: `全校 ${slot} 不排常规课`,
        });
    });

    (hard.lockedSlots || []).forEach((slot, index) => {
        const targetName = [
            entityName(project, 'class', slot.classId),
            entityName(project, 'subject', slot.subjectId),
            entityName(project, 'teacher', slot.teacherId),
        ].filter(Boolean).join(' / ');
        items.push({
            id: cleanRuleId('locked_slot', index),
            type: 'locked_slot',
            source: 'hardRules.lockedSlots',
            targetKind: 'class',
            targetId: slot.classId || '',
            targetName,
            slots: [slotKey(slot.day, slot.period)],
            priority: 'hard',
            description: '锁定课节',
            title: `${targetName} 锁定在 ${slotLabel(slot)}`,
            raw: slot,
        });
    });

    for (const subjectId of soft.morningSubjects || []) {
        items.push({
            id: cleanRuleId('subject_morning', subjectId),
            type: 'subject_morning',
            source: 'softRules.morningSubjects',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            slots: [],
            priority: 'soft',
            description: '课程上午优先',
            title: `${entityName(project, 'subject', subjectId)} 上午优先`,
            ...historicalGlobalCourseScope(),
        });
    }

    for (const subjectId of soft.afternoonSubjects || []) {
        items.push({
            id: cleanRuleId('subject_afternoon', subjectId),
            type: 'subject_afternoon',
            source: 'softRules.afternoonSubjects',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            slots: [],
            priority: 'soft',
            description: '课程下午优先',
            title: `${entityName(project, 'subject', subjectId)} 下午优先`,
        });
    }

    for (const [subjectId, preference] of Object.entries(soft.subjectPreferredPeriods || {})) {
        for (const slot of preference.prefer || []) {
            items.push({
                id: cleanRuleId('subject_preferred_periods', subjectId, 'prefer', slot),
                type: 'subject_preferred_periods',
                source: 'softRules.subjectPreferredPeriods.prefer',
                targetKind: 'subject',
                targetId: subjectId,
                targetName: entityName(project, 'subject', subjectId),
                slots: [slot],
                priority: 'soft',
                description: '课程偏好节次',
                title: `${entityName(project, 'subject', subjectId)} 偏好 ${slot}`,
                ...historicalGlobalCourseScope(),
            });
        }
        for (const slot of preference.avoid || []) {
            items.push({
                id: cleanRuleId('subject_avoid_periods', subjectId, 'avoid', slot),
                type: 'subject_avoid_periods',
                source: 'softRules.subjectPreferredPeriods.avoid',
                targetKind: 'subject',
                targetId: subjectId,
                targetName: entityName(project, 'subject', subjectId),
                slots: [slot],
                priority: 'soft',
                description: '课程避开节次',
                title: `${entityName(project, 'subject', subjectId)} 避开 ${slot}`,
                ...historicalGlobalCourseScope(),
            });
        }
    }

    for (const [teacherId, limits] of Object.entries(soft.teacherLimits || {})) {
        if (Number.isInteger(Number(limits.daily))) {
            items.push({
                id: cleanRuleId('teacher_daily_limit', teacherId),
                type: 'teacher_daily_limit',
                source: 'softRules.teacherLimits.daily',
                targetKind: 'teacher',
                targetId: teacherId,
                targetName: entityName(project, 'teacher', teacherId),
                slots: [],
                priority: 'soft',
                limit: Number(limits.daily),
                description: `每天最多 ${Number(limits.daily)} 节`,
                title: `${entityName(project, 'teacher', teacherId)} 每天最多 ${Number(limits.daily)} 节`,
            });
        }
        if (Number.isInteger(Number(limits.consecutive))) {
            items.push({
                id: cleanRuleId('teacher_consecutive_limit', teacherId),
                type: 'teacher_consecutive_limit',
                source: 'softRules.teacherLimits.consecutive',
                targetKind: 'teacher',
                targetId: teacherId,
                targetName: entityName(project, 'teacher', teacherId),
                slots: [],
                priority: 'soft',
                limit: Number(limits.consecutive),
                description: `连续最多 ${Number(limits.consecutive)} 节`,
                title: `${entityName(project, 'teacher', teacherId)} 连续最多 ${Number(limits.consecutive)} 节`,
            });
        }
    }

    for (const [subjectId, limit] of Object.entries(hard.subjectDailyLimit || {})) {
        items.push({
            id: cleanRuleId('subject_daily_limit', subjectId),
            type: 'subject_daily_limit',
            source: 'hardRules.subjectDailyLimit',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            slots: [],
            priority: 'hard',
            limit: Number(limit),
            description: `每天最多 ${Number(limit)} 节`,
            title: `${entityName(project, 'subject', subjectId)} 每天最多 ${Number(limit)} 节`,
        });
    }

    for (const [teacherId, limit] of Object.entries(hard.teacherWeeklyLimit || {})) {
        items.push({
            id: cleanRuleId('teacher_weekly_limit', teacherId),
            type: 'teacher_weekly_limit',
            source: 'hardRules.teacherWeeklyLimit',
            targetKind: 'teacher',
            targetId: teacherId,
            targetName: entityName(project, 'teacher', teacherId),
            slots: [],
            priority: 'hard',
            limit: Number(limit),
            description: `每周最多 ${Number(limit)} 节`,
            title: `${entityName(project, 'teacher', teacherId)} 每周最多 ${Number(limit)} 节`,
        });
    }

    for (const [teacherId, limit] of Object.entries(hard.teacherMaxDaysPerWeek || {})) {
        items.push({
            id: cleanRuleId('teacher_max_days_per_week', teacherId),
            type: 'teacher_max_days_per_week',
            source: 'hardRules.teacherMaxDaysPerWeek',
            targetKind: 'teacher',
            targetId: teacherId,
            targetName: entityName(project, 'teacher', teacherId),
            slots: [],
            priority: 'hard',
            limit: Number(limit),
            description: `每周最多 ${Number(limit)} 天`,
            title: `${entityName(project, 'teacher', teacherId)} 每周最多 ${Number(limit)} 天上课`,
        });
    }

    (hard.teacherMutualExclusion || []).forEach((group, index) => {
        const teacherIds = group.teacherIds || [];
        items.push({
            id: cleanRuleId('teacher_mutual_exclusion', index),
            type: 'teacher_mutual_exclusion',
            source: 'hardRules.teacherMutualExclusion',
            targetKind: 'teacher_group',
            targetId: teacherIds.join('|'),
            targetName: teacherIds.map(id => entityName(project, 'teacher', id)).join('、'),
            teacherIds,
            slots: [],
            priority: 'hard',
            description: '教师互斥',
            title: `${teacherIds.map(id => entityName(project, 'teacher', id)).join('、')} 不能同节上课`,
        });
    });

    (hard.subjectNotSameDay || []).forEach((pair, index) => {
        const subjectIds = pair.subjectIds || [];
        const classIds = pair.classIds || [];
        items.push({
            id: cleanRuleId('subject_not_same_day', index),
            type: 'subject_not_same_day',
            source: 'hardRules.subjectNotSameDay',
            targetKind: 'subject',
            targetId: subjectIds.join('|'),
            targetName: subjectIds.map(id => entityName(project, 'subject', id)).join('、'),
            subjectIds,
            classIds,
            slots: [],
            priority: 'hard',
            description: '课程不同天',
            title: `${subjectIds.map(id => entityName(project, 'subject', id)).join('、')} 不排同一天`,
        });
    });

    for (const [subjectId, requirement] of Object.entries(hard.roomRequirements || {})) {
        items.push({
            id: cleanRuleId('room_requirement', subjectId),
            type: 'room_requirement',
            source: 'hardRules.roomRequirements',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            roomIds: requirement.roomIds || [],
            requiredTags: requirement.requiredTags || [],
            slots: [],
            priority: 'hard',
            description: '教室要求',
            title: `${entityName(project, 'subject', subjectId)} 教室要求`,
        });
    }

    for (const subjectId of soft.spreadSubjects || []) {
        items.push({
            id: cleanRuleId('subject_spread', subjectId),
            type: 'subject_spread',
            source: 'softRules.spreadSubjects',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            slots: [],
            priority: 'soft',
            description: '同科分散',
            title: `${entityName(project, 'subject', subjectId)} 分散排布`,
            ...historicalGlobalCourseScope(),
        });
    }

    for (const [subjectId, minGapDays] of Object.entries(soft.spreadSubjectGaps || {})) {
        items.push({
            id: cleanRuleId('course_interval', subjectId),
            type: 'course_interval',
            source: 'softRules.spreadSubjectGaps',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            minGapDays: Number(minGapDays),
            slots: [],
            priority: 'soft',
            description: `至少间隔 ${Number(minGapDays)} 天`,
            title: `${entityName(project, 'subject', subjectId)} 至少间隔 ${Number(minGapDays)} 天`,
        });
    }

    if (soft.classDailyBalance?.enabled) {
        items.push({
            id: 'class_daily_balance',
            type: 'class_daily_balance',
            source: 'softRules.classDailyBalance',
            targetKind: 'global',
            targetId: '__all_classes',
            targetName: '全部班级',
            slots: [],
            priority: 'soft',
            limit: Number(soft.classDailyBalance.mainSubjectDailyMax) || 0,
            description: '班级每日均衡',
            title: '班级每日课时尽量均衡',
        });
    }

    if (Number(soft.teacherGapWeight) > 0) {
        items.push({
            id: 'teacher_gap_preference',
            type: 'teacher_gap_preference',
            source: 'softRules.teacherGapWeight',
            targetKind: 'global',
            targetId: '__all_teachers',
            targetName: '全部教师',
            slots: [],
            priority: 'soft',
            weight: Number(soft.teacherGapWeight),
            description: '教师少空堂',
            title: '教师尽量少空堂',
        });
    }

    if (soft.teacherLoadBalance?.enabled && soft.teacherLoadBalance?.explicit) {
        items.push({
            id: 'teacher_load_balance',
            type: 'teacher_load_balance',
            source: 'softRules.teacherLoadBalance',
            targetKind: 'global',
            targetId: '__all_teachers',
            targetName: '全部教师',
            slots: [],
            priority: 'soft',
            weight: Number(soft.teacherLoadBalance.weight) || 1,
            description: '教师负载均衡',
            title: '教师工作量尽量均衡',
        });
    }

    (soft.subjectSequence || []).forEach((item, index) => {
        items.push({
            id: cleanRuleId('subject_sequence', index),
            type: 'subject_sequence',
            source: 'softRules.subjectSequence',
            targetKind: 'subject',
            targetId: `${item.beforeSubjectId}>${item.afterSubjectId}`,
            targetName: `${entityName(project, 'subject', item.beforeSubjectId)} 先于 ${entityName(project, 'subject', item.afterSubjectId)}`,
            beforeSubjectId: item.beforeSubjectId,
            afterSubjectId: item.afterSubjectId,
            classIds: item.classIds || [],
            slots: [],
            priority: 'soft',
            weight: Number(item.weight) || 1,
            description: '课程顺序',
            title: `${entityName(project, 'subject', item.beforeSubjectId)} 先于 ${entityName(project, 'subject', item.afterSubjectId)}`,
        });
    });

    (rules.advancedRules || []).forEach(rule => {
        const scopeLabel = scopedCourseRuleLabel(project, rule);
        items.push({
            id: rule.id,
            type: 'advanced_constraint',
            primitive: rule.type,
            capabilityId: rule.capabilityId || rule.type,
            advancedType: rule.type,
            sourceId: rule.sourceId || '',
            clauseId: rule.clauseId || '',
            source: 'advancedRules',
            targetKind: rule.target?.kind || 'global',
            targetId: (rule.target?.matchedIds || []).join('|'),
            targetName: rule.target?.name || rule.type,
            slots: rule.parameters?.slots || [],
            priority: rule.strength || 'soft',
            description: scopeLabel || rule.type,
            title: scopeLabel || (rule.target?.name ? `${rule.target.name} ${rule.type}` : rule.type),
            scopeLabel,
            rawText: rule.rawText || rule.sourceText || rule.source?.rawText || rule.originalText || '',
            legacyCourseGlobal: scopeLabel === '历史全校范围',
            advancedRule: rule,
        });
    });

    return items;
}

function cloneProject(project = {}) {
    return JSON.parse(JSON.stringify(project || {}));
}

function removeValue(values = [], value) {
    return (Array.isArray(values) ? values : []).filter(item => String(item) !== String(value));
}

function deleteIndexed(items = [], ruleId = '', prefix = '') {
    const index = Number(String(ruleId).slice(prefix.length));
    if (!Number.isInteger(index) || index < 0) return items;
    return (Array.isArray(items) ? items : []).filter((_, itemIndex) => itemIndex !== index);
}

function removeSlotRule(map = {}, targetId = '', slot = '') {
    const next = { ...(map || {}) };
    next[targetId] = removeValue(next[targetId], slot);
    if (!next[targetId]?.length) delete next[targetId];
    return next;
}

function removeSubjectPeriodRule(preferences = {}, subjectId = '', kind = '', slot = '') {
    const next = { ...(preferences || {}) };
    const current = { ...(next[subjectId] || {}) };
    current[kind] = removeValue(current[kind], slot);
    if (!current.prefer?.length && !current.avoid?.length) delete next[subjectId];
    else next[subjectId] = current;
    return next;
}

function deleteRuleFromProject(project = {}, rule = {}) {
    const nextProject = cloneProject(project);
    const rules = nextProject.rules || {};
    const hard = { ...(rules.hardRules || {}) };
    const soft = { ...(rules.softRules || {}) };
    const firstSlot = rule.slots?.[0] || '';

    switch (rule.type) {
        case 'teacher_unavailable':
            hard.teacherUnavailable = removeSlotRule(hard.teacherUnavailable, rule.targetId, firstSlot);
            break;
        case 'class_unavailable':
            hard.classUnavailable = removeSlotRule(hard.classUnavailable, rule.targetId, firstSlot);
            break;
        case 'global_unavailable':
            hard.globalUnavailable = removeValue(hard.globalUnavailable, firstSlot);
            break;
        case 'locked_slot':
            hard.lockedSlots = deleteIndexed(hard.lockedSlots, rule.id, 'locked_slot:');
            break;
        case 'subject_morning':
            soft.morningSubjects = removeValue(soft.morningSubjects, rule.targetId);
            break;
        case 'subject_afternoon':
            soft.afternoonSubjects = removeValue(soft.afternoonSubjects, rule.targetId);
            break;
        case 'subject_preferred_periods':
            soft.subjectPreferredPeriods = removeSubjectPeriodRule(soft.subjectPreferredPeriods, rule.targetId, 'prefer', firstSlot);
            break;
        case 'subject_avoid_periods':
            soft.subjectPreferredPeriods = removeSubjectPeriodRule(soft.subjectPreferredPeriods, rule.targetId, 'avoid', firstSlot);
            break;
        case 'teacher_daily_limit': {
            const limits = { ...(soft.teacherLimits || {}) };
            if (limits[rule.targetId]) {
                delete limits[rule.targetId].daily;
                if (!Object.keys(limits[rule.targetId]).length) delete limits[rule.targetId];
            }
            soft.teacherLimits = limits;
            break;
        }
        case 'teacher_consecutive_limit': {
            const limits = { ...(soft.teacherLimits || {}) };
            if (limits[rule.targetId]) {
                delete limits[rule.targetId].consecutive;
                if (!Object.keys(limits[rule.targetId]).length) delete limits[rule.targetId];
            }
            soft.teacherLimits = limits;
            break;
        }
        case 'subject_spread':
            soft.spreadSubjects = removeValue(soft.spreadSubjects, rule.targetId);
            break;
        case 'course_interval': {
            const gaps = { ...(soft.spreadSubjectGaps || {}) };
            delete gaps[rule.targetId];
            soft.spreadSubjectGaps = gaps;
            break;
        }
        case 'subject_daily_limit':
            hard.subjectDailyLimit = { ...(hard.subjectDailyLimit || {}) };
            delete hard.subjectDailyLimit[rule.targetId];
            break;
        case 'teacher_weekly_limit':
            hard.teacherWeeklyLimit = { ...(hard.teacherWeeklyLimit || {}) };
            delete hard.teacherWeeklyLimit[rule.targetId];
            break;
        case 'teacher_max_days_per_week':
            hard.teacherMaxDaysPerWeek = { ...(hard.teacherMaxDaysPerWeek || {}) };
            delete hard.teacherMaxDaysPerWeek[rule.targetId];
            break;
        case 'teacher_mutual_exclusion':
            hard.teacherMutualExclusion = deleteIndexed(hard.teacherMutualExclusion, rule.id, 'teacher_mutual_exclusion:');
            break;
        case 'subject_not_same_day':
            hard.subjectNotSameDay = deleteIndexed(hard.subjectNotSameDay, rule.id, 'subject_not_same_day:');
            break;
        case 'room_requirement':
            hard.roomRequirements = { ...(hard.roomRequirements || {}) };
            delete hard.roomRequirements[rule.targetId];
            break;
        case 'class_daily_balance':
            soft.classDailyBalance = { ...(soft.classDailyBalance || {}), enabled: false, explicit: false };
            break;
        case 'teacher_gap_preference':
            soft.teacherGapWeight = 0;
            break;
        case 'teacher_load_balance':
            soft.teacherLoadBalance = { ...(soft.teacherLoadBalance || {}), enabled: false, explicit: false };
            break;
        case 'subject_sequence':
            soft.subjectSequence = deleteIndexed(soft.subjectSequence, rule.id, 'subject_sequence:');
            break;
        case 'advanced_constraint':
            rules.advancedRules = (rules.advancedRules || []).filter(item => item.id !== rule.id);
            break;
        default: {
            const error = new Error('当前约束类型暂不支持自动删除。');
            error.reason = 'unsupported_fulfillment_action';
            error.status = 400;
            throw error;
        }
    }

    nextProject.rules = { ...rules, hardRules: hard, softRules: soft };
    return normalizeTimetableProject(nextProject);
}

function slotsForTeacher(slots, teacherId) {
    return slots.filter(slot => slotTeacherIds(slot).includes(teacherId));
}

function slotsByDay(slots = []) {
    const result = new Map();
    for (const slot of slots) {
        const day = Number(slot.day);
        if (!result.has(day)) result.set(day, []);
        result.get(day).push(slot);
    }
    return result;
}

function evaluateTeacherUnavailable(project, rule, slots) {
    const blocked = new Set(rule.slots || []);
    const violations = slotsForTeacher(slots, rule.targetId)
        .filter(slot => blocked.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入教师禁排时段。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入教师禁排时段。`,
        violations.map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateClassUnavailable(project, rule, slots) {
    const blocked = new Set(rule.slots || []);
    const violations = slots
        .filter(slot => slot.classId === rule.targetId && blocked.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入班级禁排时段。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入班级禁排时段。`,
        violations.map(slot => locateFromSlot(project, slot, 'class', rule.targetId)),
    );
}

function evaluateGlobalUnavailable(project, rule, slots) {
    const blocked = new Set(rule.slots || []);
    const violations = slots.filter(slot => blocked.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入全校不可排时段。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入全校不可排时段。`,
        violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
    );
}

function evaluateLockedSlot(project, rule, slots) {
    const expected = rule.raw || {};
    const expectedKey = slotKey(expected.day, expected.period);
    const match = slots.find(slot => (
        slotKey(slot.day, slot.period) === expectedKey
        && slot.classId === expected.classId
        && slot.subjectId === expected.subjectId
        && (!expected.teacherId || slotTeacherIds(slot).includes(expected.teacherId))
        && (!expected.lessonPlanId || slot.lessonPlanId === expected.lessonPlanId)
    ));
    if (match) {
        return makeResult(rule, 'satisfied', `锁定课节仍在 ${slotLabel(expected)}。`, [
            locateFromSlot(project, match, 'class', expected.classId),
        ]);
    }
    const related = slots.filter(slot => (
        slot.classId === expected.classId
        && slot.subjectId === expected.subjectId
        && (!expected.teacherId || slotTeacherIds(slot).includes(expected.teacherId))
    ));
    return makeResult(
        rule,
        'unmet',
        `锁定课节未保持在 ${slotLabel(expected)}。`,
        related.length
            ? related.map(slot => locateFromSlot(project, slot, 'class', expected.classId))
            : [locateExpectedCell(project, rule)],
    );
}

function evaluateSubjectMorning(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const morning = new Set(getDayPartPeriods(project, 'morning'));
    const matched = subjectSlots.filter(slot => morning.has(Number(slot.period)));
    const evidence = `${matched.length}/${subjectSlots.length} 节在上午。`;
    if (matched.length === subjectSlots.length) return makeResult(rule, 'satisfied', evidence);
    if (matched.length > 0) {
        return makeResult(
            rule,
            'partial',
            evidence,
            subjectSlots.filter(slot => !morning.has(Number(slot.period))).map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
        );
    }
    return makeResult(
        rule,
        'unmet',
        evidence,
        subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
    );
}

function evaluateSubjectAfternoon(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const morning = new Set(getDayPartPeriods(project, 'morning'));
    const matched = subjectSlots.filter(slot => !morning.has(Number(slot.period)));
    const evidence = `${matched.length}/${subjectSlots.length} 节在下午或非上午时段。`;
    if (matched.length === subjectSlots.length) return makeResult(rule, 'satisfied', evidence);
    if (matched.length > 0) {
        return makeResult(
            rule,
            'partial',
            evidence,
            subjectSlots.filter(slot => morning.has(Number(slot.period))).map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
        );
    }
    return makeResult(rule, 'unmet', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateSubjectPreferred(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const preferred = new Set(rule.slots || []);
    const matched = subjectSlots.filter(slot => preferred.has(slotKey(slot.day, slot.period)));
    const evidence = `${matched.length}/${subjectSlots.length} 节命中偏好节次。`;
    if (matched.length === subjectSlots.length) return makeResult(rule, 'satisfied', evidence, matched.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
    if (matched.length > 0) return makeResult(rule, 'partial', evidence, matched.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
    return makeResult(rule, 'unmet', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateSubjectAvoid(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const avoided = new Set(rule.slots || []);
    const violations = subjectSlots.filter(slot => avoided.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入避开节次。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入避开节次。`,
        violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
    );
}

function evaluateSubjectDailyLimit(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const limit = Number(rule.limit);
    const grouped = new Map();
    for (const slot of subjectSlots) {
        const key = `${slot.classId}:${slot.day}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(slot);
    }
    const violations = [...grouped.values()].filter(daySlots => daySlots.length > limit).flat();
    if (!violations.length) return makeResult(rule, 'satisfied', `各班每天该课程均未超过 ${limit} 节。`);
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节所在日期超过每日 ${limit} 节。`,
        violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
    );
}

function evaluateTeacherDaily(project, rule, slots) {
    const teacherSlots = slotsForTeacher(slots, rule.targetId);
    if (!teacherSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该教师课节。');
    const limit = Number(rule.limit);
    const overSlots = [];
    const overDays = [];
    for (const [day, daySlots] of slotsByDay(teacherSlots)) {
        if (daySlots.length > limit) {
            overDays.push(`周${day} ${daySlots.length}节`);
            overSlots.push(...daySlots);
        }
    }
    if (!overSlots.length) return makeResult(rule, 'satisfied', `每天均未超过 ${limit} 节。`);
    return makeResult(
        rule,
        'unmet',
        `${overDays.join('、')}，超过每天最多 ${limit} 节。`,
        overSlots.map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateTeacherWeekly(project, rule, slots) {
    const teacherSlots = slotsForTeacher(slots, rule.targetId);
    if (!teacherSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该教师课节。');
    const limit = Number(rule.limit);
    if (teacherSlots.length <= limit) return makeResult(rule, 'satisfied', `每周 ${teacherSlots.length}/${limit} 节。`);
    return makeResult(
        rule,
        'unmet',
        `每周 ${teacherSlots.length} 节，超过上限 ${limit} 节。`,
        teacherSlots.slice(limit).map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateTeacherMaxDays(project, rule, slots) {
    const teacherSlots = slotsForTeacher(slots, rule.targetId);
    if (!teacherSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该教师课节。');
    const limit = Number(rule.limit);
    const days = new Set(teacherSlots.map(slot => Number(slot.day)));
    if (days.size <= limit) return makeResult(rule, 'satisfied', `每周上课 ${days.size}/${limit} 天。`);
    return makeResult(
        rule,
        'unmet',
        `每周上课 ${days.size} 天，超过上限 ${limit} 天。`,
        teacherSlots.filter(slot => days.has(Number(slot.day))).map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateTeacherConsecutive(project, rule, slots) {
    const teacherSlots = slotsForTeacher(slots, rule.targetId);
    if (!teacherSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该教师课节。');
    const limit = Number(rule.limit);
    const violatingSlots = [];
    const runs = [];
    for (const [day, daySlots] of slotsByDay(teacherSlots)) {
        const sorted = [...daySlots].sort((left, right) => Number(left.period) - Number(right.period));
        let current = [];
        for (const slot of sorted) {
            const previous = current.at(-1);
            if (previous && Number(slot.period) === Number(previous.period) + 1) current.push(slot);
            else {
                if (current.length > limit) {
                    runs.push(`周${day} 连续${current.length}节`);
                    violatingSlots.push(...current);
                }
                current = [slot];
            }
        }
        if (current.length > limit) {
            runs.push(`周${day} 连续${current.length}节`);
            violatingSlots.push(...current);
        }
    }
    if (!violatingSlots.length) return makeResult(rule, 'satisfied', `连续课均未超过 ${limit} 节。`);
    return makeResult(
        rule,
        'unmet',
        `${runs.join('、')}，超过连续最多 ${limit} 节。`,
        violatingSlots.map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateTeacherMutualExclusion(project, rule, slots) {
    const teacherIds = new Set(rule.teacherIds || []);
    if (teacherIds.size < 2) return makeResult(rule, 'not_applicable', '互斥教师不足两位。');
    const bySlot = new Map();
    for (const slot of slots) {
        const matched = slotTeacherIds(slot).filter(teacherId => teacherIds.has(teacherId));
        if (!matched.length) continue;
        const key = slotKey(slot.day, slot.period);
        if (!bySlot.has(key)) bySlot.set(key, []);
        bySlot.get(key).push(slot);
    }
    const violations = [...bySlot.values()].filter(items => new Set(items.flatMap(slot => slotTeacherIds(slot)).filter(id => teacherIds.has(id))).size >= 2).flat();
    if (!violations.length) return makeResult(rule, 'satisfied', '互斥教师没有同节上课。');
    return makeResult(rule, 'unmet', `${violations.length} 节涉及互斥教师同节上课。`, violations.map(slot => locateFromSlot(project, slot, 'teacher', slot.teacherId)));
}

function evaluateSubjectNotSameDay(project, rule, slots) {
    const subjectIds = rule.subjectIds || [];
    if (subjectIds.length < 2) return makeResult(rule, 'not_applicable', '课程配对不足。');
    const classScope = new Set(rule.classIds || []);
    const violations = [];
    const byClassDay = new Map();
    for (const slot of slots) {
        if (!subjectIds.includes(slot.subjectId)) continue;
        if (classScope.size && !classScope.has(slot.classId)) continue;
        const key = `${slot.classId}:${slot.day}`;
        if (!byClassDay.has(key)) byClassDay.set(key, []);
        byClassDay.get(key).push(slot);
    }
    for (const items of byClassDay.values()) {
        if (new Set(items.map(slot => slot.subjectId)).size >= 2) violations.push(...items);
    }
    if (!violations.length) return makeResult(rule, 'satisfied', '配对课程没有排在同一天。');
    return makeResult(rule, 'unmet', `${violations.length} 节涉及配对课程同日。`, violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateRoomRequirement(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const allowed = new Set(rule.roomIds || []);
    const requiredTags = new Set(rule.requiredTags || []);
    const roomMap = new Map((project.rooms || []).map(room => [room.id, room]));
    const hasRequirement = allowed.size || requiredTags.size;
    if (!hasRequirement) return makeResult(rule, 'not_applicable', '没有可评估的教室或标签要求。');
    const violations = subjectSlots.filter(slot => {
        if (!slot.roomId) return true;
        if (allowed.size && allowed.has(slot.roomId)) return false;
        if (requiredTags.size) {
            const roomTags = new Set(roomMap.get(slot.roomId)?.tags || []);
            return ![...requiredTags].every(tag => roomTags.has(tag));
        }
        return allowed.size > 0;
    });
    if (!violations.length) return makeResult(rule, 'satisfied', '课程均安排在符合要求的教室。');
    return makeResult(rule, 'unmet', `${violations.length} 节未安排到符合要求的教室。`, violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateSubjectSpread(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    if (subjectSlots.length <= 1) return makeResult(rule, 'satisfied', '该课程只有 1 节课，不需要分散。');
    const grouped = slotsByDay(subjectSlots);
    const activeDayCount = Math.max(1, getActiveWeekdays(project).length);
    const distinctDays = grouped.size;
    const maxPerDay = Math.max(...Array.from(grouped.values()).map(daySlots => daySlots.length));
    const evidence = `${subjectSlots.length} 节分布在 ${distinctDays}/${Math.min(subjectSlots.length, activeDayCount)} 天，单日最多 ${maxPerDay} 节。`;
    if (maxPerDay <= 1) return makeResult(rule, 'satisfied', evidence);
    if (distinctDays > 1) return makeResult(rule, 'partial', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
    return makeResult(rule, 'unmet', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateCourseInterval(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (subjectSlots.length <= 1) return makeResult(rule, 'not_applicable', '该课程课节不足 2 节，不需要评估间隔。');
    const minGapDays = Number(rule.minGapDays) || 1;
    const violations = [];
    const byClass = new Map();
    for (const slot of subjectSlots) {
        if (!byClass.has(slot.classId)) byClass.set(slot.classId, []);
        byClass.get(slot.classId).push(slot);
    }
    for (const classSlots of byClass.values()) {
        const sorted = [...classSlots].sort((left, right) => Number(left.day) - Number(right.day));
        for (let index = 1; index < sorted.length; index += 1) {
            if (Math.abs(Number(sorted[index].day) - Number(sorted[index - 1].day)) < minGapDays) {
                violations.push(sorted[index - 1], sorted[index]);
            }
        }
    }
    if (!violations.length) return makeResult(rule, 'satisfied', `同班同课至少间隔 ${minGapDays} 天。`);
    return makeResult(rule, 'unmet', `${violations.length} 节间隔小于 ${minGapDays} 天。`, violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateClassDailyBalance(project, rule, slots) {
    if (!slots.length) return makeResult(rule, 'not_applicable', '当前课表没有课节。');
    const byClass = new Map();
    for (const slot of slots) {
        if (!byClass.has(slot.classId)) byClass.set(slot.classId, new Map());
        const dayMap = byClass.get(slot.classId);
        dayMap.set(Number(slot.day), (dayMap.get(Number(slot.day)) || 0) + 1);
    }
    let worstDelta = 0;
    for (const dayMap of byClass.values()) {
        const counts = getActiveWeekdays(project).map(day => dayMap.get(day) || 0);
        worstDelta = Math.max(worstDelta, Math.max(...counts) - Math.min(...counts));
    }
    if (worstDelta <= 1) return makeResult(rule, 'satisfied', '各班每日课时差距不超过 1 节。');
    if (worstDelta <= 2) return makeResult(rule, 'partial', `最大日课时差为 ${worstDelta} 节。`);
    return makeResult(rule, 'unmet', `最大日课时差为 ${worstDelta} 节。`);
}

function evaluateTeacherGapPreference(project, rule, slots) {
    const teacherDay = new Map();
    for (const slot of slots) {
        for (const teacherId of slotTeacherIds(slot)) {
            const key = `${teacherId}:${slot.day}`;
            if (!teacherDay.has(key)) teacherDay.set(key, []);
            teacherDay.get(key).push(Number(slot.period));
        }
    }
    let checks = 0;
    let adjacent = 0;
    for (const periods of teacherDay.values()) {
        const sorted = [...periods].sort((left, right) => left - right);
        for (let index = 1; index < sorted.length; index += 1) {
            checks += 1;
            if (sorted[index] - sorted[index - 1] <= 1) adjacent += 1;
        }
    }
    if (!checks) return makeResult(rule, 'not_applicable', '没有可评估的教师同日多节课。');
    const ratio = adjacent / checks;
    if (ratio >= 0.75) return makeResult(rule, 'satisfied', `相邻或连续比例 ${Math.round(ratio * 100)}%。`);
    if (ratio >= 0.45) return makeResult(rule, 'partial', `相邻或连续比例 ${Math.round(ratio * 100)}%。`);
    return makeResult(rule, 'unmet', `相邻或连续比例 ${Math.round(ratio * 100)}%。`);
}

function evaluateTeacherLoadBalance(project, rule, slots) {
    const activeDays = getActiveWeekdays(project);
    const teacherDay = new Map();
    for (const slot of slots) {
        for (const teacherId of slotTeacherIds(slot)) {
            if (!teacherDay.has(teacherId)) teacherDay.set(teacherId, new Map());
            const dayMap = teacherDay.get(teacherId);
            dayMap.set(Number(slot.day), (dayMap.get(Number(slot.day)) || 0) + 1);
        }
    }
    let worstDelta = 0;
    for (const dayMap of teacherDay.values()) {
        const counts = activeDays.map(day => dayMap.get(day) || 0);
        worstDelta = Math.max(worstDelta, Math.max(...counts) - Math.min(...counts));
    }
    if (!teacherDay.size) return makeResult(rule, 'not_applicable', '当前课表没有教师课节。');
    if (worstDelta <= 1) return makeResult(rule, 'satisfied', '教师每日负载差距不超过 1 节。');
    if (worstDelta <= 2) return makeResult(rule, 'partial', `最大教师日负载差为 ${worstDelta} 节。`);
    return makeResult(rule, 'unmet', `最大教师日负载差为 ${worstDelta} 节。`);
}

function evaluateSubjectSequence(project, rule, slots) {
    const classScope = new Set(rule.classIds || []);
    const violations = [];
    for (const [day, daySlots] of slotsByDay(slots)) {
        const byClass = new Map();
        for (const slot of daySlots) {
            if (classScope.size && !classScope.has(slot.classId)) continue;
            if (!byClass.has(slot.classId)) byClass.set(slot.classId, []);
            byClass.get(slot.classId).push(slot);
        }
        for (const classSlots of byClass.values()) {
            const before = classSlots.filter(slot => slot.subjectId === rule.beforeSubjectId);
            const after = classSlots.filter(slot => slot.subjectId === rule.afterSubjectId);
            for (const left of before) {
                for (const right of after) {
                    if (Number(left.period) > Number(right.period)) violations.push(left, right);
                }
            }
        }
    }
    if (!violations.length) return makeResult(rule, 'satisfied', '课程顺序未发现违反。');
    return makeResult(rule, 'unmet', `${violations.length} 节涉及顺序违反。`, violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateRule(project, rule, slots, evaluated) {
    if (!evaluated) return makeResult(rule, 'not_applicable', '当前还没有生成课表。');
    if (!EVALUABLE_PRIMITIVES.has(rule.type)) {
        return makeResult(rule, 'not_applicable', '当前版本暂不支持评估该约束。');
    }
    switch (rule.type) {
        case 'advanced_constraint': {
            const advanced = evaluateAdvancedRule(project, rule.advancedRule || {}, slots);
            return makeResult(
                rule,
                advanced.status === 'violated' ? 'unmet' : advanced.status === 'satisfied' ? 'satisfied' : 'not_evaluable',
                advanced.detail,
                (advanced.evidence || []).map(slot => locateFromSlot(project, slot, rule.targetKind, rule.targetId)),
            );
        }
        case 'teacher_unavailable':
            return evaluateTeacherUnavailable(project, rule, slots);
        case 'class_unavailable':
            return evaluateClassUnavailable(project, rule, slots);
        case 'global_unavailable':
            return evaluateGlobalUnavailable(project, rule, slots);
        case 'locked_slot':
            return evaluateLockedSlot(project, rule, slots);
        case 'subject_morning':
            return evaluateSubjectMorning(project, rule, slots);
        case 'subject_afternoon':
            return evaluateSubjectAfternoon(project, rule, slots);
        case 'subject_preferred_periods':
            return evaluateSubjectPreferred(project, rule, slots);
        case 'subject_avoid_periods':
            return evaluateSubjectAvoid(project, rule, slots);
        case 'subject_daily_limit':
            return evaluateSubjectDailyLimit(project, rule, slots);
        case 'teacher_daily_limit':
            return evaluateTeacherDaily(project, rule, slots);
        case 'teacher_consecutive_limit':
            return evaluateTeacherConsecutive(project, rule, slots);
        case 'teacher_weekly_limit':
            return evaluateTeacherWeekly(project, rule, slots);
        case 'teacher_max_days_per_week':
            return evaluateTeacherMaxDays(project, rule, slots);
        case 'teacher_mutual_exclusion':
            return evaluateTeacherMutualExclusion(project, rule, slots);
        case 'subject_not_same_day':
            return evaluateSubjectNotSameDay(project, rule, slots);
        case 'room_requirement':
            return evaluateRoomRequirement(project, rule, slots);
        case 'subject_spread':
            return evaluateSubjectSpread(project, rule, slots);
        case 'course_interval':
            return evaluateCourseInterval(project, rule, slots);
        case 'class_daily_subject_balance':
        case 'class_daily_balance':
            return evaluateClassDailyBalance(project, rule, slots);
        case 'teacher_gap_preference':
            return evaluateTeacherGapPreference(project, rule, slots);
        case 'teacher_load_balance':
            return evaluateTeacherLoadBalance(project, rule, slots);
        case 'subject_sequence':
            return evaluateSubjectSequence(project, rule, slots);
        default:
            return makeResult(rule, 'not_applicable', '当前版本暂不支持评估该约束。');
    }
}

function summarize(items = []) {
    return items.reduce((summary, item) => {
        summary.total += 1;
        if (item.status === 'satisfied') summary.satisfied += 1;
        else if (item.status === 'partial') {
            summary.partial += 1;
            summary.partiallySatisfied += 1;
        } else if (item.status === 'violated') {
            summary.unmet += 1;
            summary.violated += 1;
        } else {
            summary.notApplicable += 1;
            summary.notEvaluable += 1;
        }
        return summary;
    }, {
        total: 0,
        satisfied: 0,
        partiallySatisfied: 0,
        violated: 0,
        notEvaluable: 0,
        partial: 0,
        unmet: 0,
        notApplicable: 0,
    });
}

export function evaluateTimetableConstraintFulfillment(input = {}) {
    const project = normalizeTimetableProject(input || {});
    const rules = savedConstraintItems(project);
    const slots = Array.isArray(project.schedule?.slots) ? project.schedule.slots : [];
    const evaluated = Boolean(project.schedule && (project.schedule.id || project.schedule.source || slots.length || project.schedule.score));
    const items = rules.map(rule => evaluateRule(project, rule, slots, evaluated));
    return {
        evaluated,
        version: 2,
        coverage: {
            primitiveCount: FULFILLMENT_PRIMITIVES.length,
            primitives: FULFILLMENT_PRIMITIVES,
            primitiveAliases: PRIMITIVE_ALIASES,
        },
        summary: summarize(items),
        items,
    };
}

export function applyTimetableConstraintFulfillmentAction(input = {}, action = {}) {
    const project = normalizeTimetableProject(input || {});
    const kind = String(action.kind || '').trim();
    const ruleId = String(action.ruleId || action.id || '').trim();
    if (!ruleId) {
        const error = new Error('缺少要处理的约束。');
        error.reason = 'missing_fulfillment_rule_id';
        error.status = 400;
        throw error;
    }
    const rule = savedConstraintItems(project).find(item => item.id === ruleId);
    if (!rule) {
        const error = new Error('没有找到要处理的约束。');
        error.reason = 'fulfillment_rule_not_found';
        error.status = 404;
        throw error;
    }
    if (kind !== 'delete_rule') {
        const error = new Error('当前建议动作需要人工处理，尚不能自动执行。');
        error.reason = 'manual_fulfillment_action';
        error.status = 400;
        throw error;
    }
    const nextProject = deleteRuleFromProject(project, rule);
    return {
        project: nextProject,
        action: {
            kind,
            ruleId,
            type: rule.type,
            strength: rule.priority === 'hard' ? 'hard' : 'soft',
            label: rule.title || TYPE_LABELS[rule.type] || rule.type,
        },
        fulfillment: evaluateTimetableConstraintFulfillment(nextProject),
    };
}
