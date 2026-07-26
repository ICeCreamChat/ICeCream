const DAY_LABELS = ['', '一', '二', '三', '四', '五', '六', '日'];
const COURSE_SCOPE_RULE_TYPES = new Set([
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_morning',
    'subject_afternoon',
    'subject_spread',
]);

const COURSE_SCOPE_ADVANCED_TYPES = Object.freeze({
    subject_preferred_periods: 'subject.preferred_periods',
    subject_avoid_periods: 'subject.avoid_periods',
    subject_morning: 'subject.preferred_day_part',
    subject_afternoon: 'subject.preferred_day_part',
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

const EDITOR_CATEGORIES = Object.freeze({
    time: '时间',
    teacher: '教师',
    subject: '课程',
    relation: '关系',
    room: '教室',
    optimization: '优化',
});

const field = (name, kind, label, options = {}) => Object.freeze({ name, kind, label, ...options });

function simpleEditorDefinition(definition) {
    const subjectRule = COURSE_SCOPE_RULE_TYPES.has(definition.type);
    const targetKind = definition.targetKind;
    const targetField = ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(definition.type)
        ? field('targetValue', 'entity_or_all', definition.targetLabel, { entityKind: targetKind, required: true })
        : field('targetValue', 'entity', definition.targetLabel, { entityKind: targetKind, required: true });
    const fields = [targetField];
    if (subjectRule) fields.push(field('courseScope', 'course_scope', '适用范围'));
    if (definition.parameterKind === 'slots') fields.push(field('slots', 'slots', definition.parameterLabel, { required: true }));
    if (definition.parameterKind === 'limit') {
        fields.push(field('limit', 'number', definition.parameterLabel, { required: true, range: 'periods' }));
    }
    return Object.freeze({
        ...definition,
        key: definition.type,
        category: targetKind === 'teacher' ? 'teacher' : targetKind === 'subject' ? 'subject' : 'time',
        aliases: Object.freeze([definition.type]),
        intent: definition.type,
        manualAvailable: true,
        fields: Object.freeze(fields),
    });
}

const BASE_EDITOR_DEFINITIONS = CONSTRAINT_RULE_DEFINITIONS.map(simpleEditorDefinition);

const EXTRA_EDITOR_DEFINITIONS = [
    {
        key: 'global_unavailable', type: 'global_unavailable', label: '全校不可排', category: 'time',
        strength: 'hard', intent: 'global_unavailable', aliases: ['global_unavailable', 'school_unavailable'],
        targetKind: 'global', targetLabel: '全校', parameterKind: 'slots', helpText: '所选课节全校不安排常规课程。',
        fields: [field('slots', 'slots', '不可排节次', { required: true })],
    },
    {
        key: 'locked_slot', type: 'locked_slot', label: '锁定课节', category: 'time',
        strength: 'hard', intent: 'locked_slot', aliases: ['locked_slot'], targetKind: 'locked_slot',
        helpText: '将指定班级、课程和教师锁定到唯一课节。',
        fields: [
            field('classId', 'entity', '班级', { entityKind: 'class', required: true }),
            field('subjectId', 'entity', '课程', { entityKind: 'subject', required: true }),
            field('teacherId', 'entity', '教师', { entityKind: 'teacher', required: true }),
            field('slots', 'single_slot', '锁定课节', { required: true }),
            field('roomId', 'entity', '教室', { entityKind: 'room', required: false, complexOnly: true }),
            field('weekPattern', 'enum', '周模式', { complexOnly: true, options: [
                { value: 'every', label: '每周' }, { value: 'odd', label: '单周' }, { value: 'even', label: '双周' },
            ] }),
        ],
    },
    {
        key: 'subject_afternoon', type: 'subject_afternoon', label: '课程下午优先', category: 'subject',
        strength: 'soft', intent: 'preferred_day_part', aliases: ['subject_afternoon'], targetKind: 'subject',
        helpText: '所选课程尽量安排在下午时段。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('courseScope', 'course_scope', '适用范围')],
    },
    {
        key: 'subject_daily_limit', type: 'subject_daily_limit', label: '课程每日上限', category: 'subject',
        strength: 'hard', intent: 'subject_daily_limit', aliases: ['subject_daily_limit'], targetKind: 'subject',
        helpText: '限制同一班级每天安排该课程的最大课节数。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('limit', 'number', '每天最多节数', { required: true, range: 'periods' })],
    },
    {
        key: 'teacher_weekly_limit', type: 'teacher_weekly_limit', label: '教师每周上限', category: 'teacher',
        strength: 'hard', intent: 'teacher_weekly_limit', aliases: ['teacher_weekly_limit'], targetKind: 'teacher',
        helpText: '限制教师每周承担的最大课节数。',
        fields: [field('targetValue', 'entity_or_all', '教师', { entityKind: 'teacher', required: true }), field('limit', 'number', '每周最多节数', { required: true, range: 'weekly' })],
    },
    {
        key: 'teacher_max_days_per_week', type: 'teacher_max_days_per_week', label: '教师每周授课天数', category: 'teacher',
        strength: 'hard', intent: 'teacher_max_days_per_week', aliases: ['teacher_max_days_per_week', 'concentrated_teaching_days'], targetKind: 'teacher',
        helpText: '教师尽量在指定天数内完成每周授课。',
        fields: [field('targetValue', 'entity_or_all', '教师', { entityKind: 'teacher', required: true }), field('limit', 'number', '每周最多授课天数', { required: true, range: 'weekdays' })],
    },
    {
        key: 'teacher_mutual_exclusion', type: 'teacher_mutual_exclusion', label: '教师互斥', category: 'relation',
        strength: 'hard', intent: 'teacher_mutual_exclusion', aliases: ['teacher_mutual_exclusion'], targetKind: 'teacher_group',
        helpText: '指定教师不能在同一课节同时上课。',
        fields: [field('teacherIds', 'entity_multi', '互斥教师', { entityKind: 'teacher', minItems: 2 })],
    },
    {
        key: 'course_interval', type: 'course_interval', label: '课程间隔天数', category: 'subject',
        strength: 'soft', intent: 'course_interval', aliases: ['course_interval', 'minimum_day_gap'], targetKind: 'subject',
        helpText: '同一课程两次授课之间至少间隔指定天数。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('minGapDays', 'number', '最小间隔天数', { required: true, range: 'gapDays' })],
    },
    {
        key: 'room_requirement', type: 'room_requirement', label: '课程教室要求', category: 'room',
        strength: 'hard', intent: 'room_requirement', aliases: ['room_requirement'], targetKind: 'subject',
        helpText: '课程必须使用指定教室或具备指定资源标签。',
        fields: [
            field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }),
            field('roomIds', 'entity_multi', '允许教室', { entityKind: 'room' }),
            field('requiredTags', 'token_multi', '必需标签', { optionSource: 'roomTags' }),
        ],
        validateAny: [['roomIds', 'requiredTags']],
    },
    {
        key: 'class_daily_balance', type: 'class_daily_balance', label: '班级日课量均衡', category: 'optimization',
        strength: 'soft', intent: 'class_daily_balance', aliases: ['class_daily_balance'], targetKind: 'global',
        helpText: '各班每天课量尽量均衡。',
        fields: [field('days', 'weekdays', '适用日期'), field('mainSubjectDailyMax', 'number', '主科每日上限', { range: 'optionalPeriods' })],
    },
    {
        key: 'teacher_gap_preference', type: 'teacher_gap_preference', label: '教师少空堂', category: 'optimization',
        strength: 'soft', intent: 'teacher_gap_preference', aliases: ['teacher_gap_preference'], targetKind: 'global',
        helpText: '全体教师同一天的课程尽量紧凑。',
        fields: [field('weight', 'number', '优化权重', { required: true, range: 'weight' })],
    },
    {
        key: 'teacher_load_balance', type: 'teacher_load_balance', label: '教师负载均衡', category: 'optimization',
        strength: 'soft', intent: 'teacher_load_balance', aliases: ['teacher_load_balance'], targetKind: 'global',
        helpText: '教师课量和时段分布尽量公平。',
        fields: [field('weight', 'number', '优化权重', { required: true, range: 'weight' })],
    },
    {
        key: 'subject_not_same_day', type: 'subject_not_same_day', label: '课程不同天', category: 'relation',
        strength: 'hard', intent: 'subject_not_same_day', aliases: ['subject_not_same_day'], targetKind: 'subject_group',
        helpText: '指定课程不安排在同一天。',
        fields: [field('subjectIds', 'entity_multi', '课程', { entityKind: 'subject', minItems: 2 }), field('classIds', 'entity_multi', '适用班级', { entityKind: 'class' })],
    },
    {
        key: 'subject_sequence', type: 'subject_sequence', label: '课程先后顺序', category: 'relation',
        strength: 'soft', intent: 'subject_sequence', aliases: ['subject_sequence'], targetKind: 'subject_group',
        helpText: '同一天内按指定顺序安排两门课程。',
        fields: [
            field('beforeSubjectId', 'entity', '先上课程', { entityKind: 'subject', required: true }),
            field('afterSubjectId', 'entity', '后上课程', { entityKind: 'subject', required: true }),
            field('classIds', 'entity_multi', '适用班级', { entityKind: 'class' }),
            field('weight', 'number', '优化权重', { required: true, range: 'weight' }),
        ],
        distinctFields: [['beforeSubjectId', 'afterSubjectId']],
    },
    {
        key: 'advanced:teacher.compact_day', type: 'advanced_constraint', advancedType: 'teacher.compact_day',
        label: '教师单日紧凑', category: 'optimization', strength: 'soft', intent: 'teacher_gap_preference', aliases: ['teacher.compact_day'], targetKind: 'teacher',
        helpText: '指定教师同一天多节课尽量紧凑。',
        fields: [field('targetValue', 'entity_or_all', '教师', { entityKind: 'teacher', required: true }), field('days', 'weekdays', '适用日期', { required: true })],
    },
    {
        key: 'advanced:teacher.prep_group_fairness', type: 'advanced_constraint', advancedType: 'teacher.prep_group_fairness',
        label: '备课组公平分布', category: 'optimization', strength: 'soft', intent: 'prep_group_fairness', aliases: ['teacher.prep_group_fairness'], targetKind: 'teacher_group',
        helpText: '同一备课组内教师的课量和时段尽量公平。',
        fields: [
            field('distributionDays', 'weekdays', '分布日期', { required: true }),
            field('avoidFullDayIdle', 'boolean', '避免整天无课'),
            field('maxConsecutiveFullAfternoons', 'number', '连续满课下午上限', { required: true, range: 'weekdays' }),
        ],
    },
    {
        key: 'advanced:subject.preferred_day_part', type: 'advanced_constraint', advancedType: 'subject.preferred_day_part',
        label: '课程时段优先', category: 'subject', strength: 'soft', intent: 'preferred_day_part', aliases: ['subject.preferred_day_part'], targetKind: 'subject',
        helpText: '课程在指定班级中优先安排到上午或下午。',
        fields: [
            field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('courseScope', 'course_scope', '适用范围'),
            field('dayPart', 'enum', '优先时段', { required: true, options: [{ value: 'morning', label: '上午' }, { value: 'afternoon', label: '下午' }] }),
        ],
    },
    {
        key: 'advanced:subject.preferred_periods', type: 'advanced_constraint', advancedType: 'subject.preferred_periods',
        label: '课程优先节次', category: 'subject', strength: 'soft', intent: 'preferred_periods', aliases: ['subject.preferred_periods'], targetKind: 'subject',
        helpText: '课程在指定班级中优先安排到所选节次。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('courseScope', 'course_scope', '适用范围'), field('slots', 'slots', '优先节次', { required: true })],
    },
    {
        key: 'advanced:subject.avoid_periods', type: 'advanced_constraint', advancedType: 'subject.avoid_periods',
        label: '课程避开节次', category: 'subject', strength: 'soft', intent: 'avoid_periods', aliases: ['subject.avoid_periods'], targetKind: 'subject',
        helpText: '课程在指定班级中尽量避开所选节次。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('courseScope', 'course_scope', '适用范围'), field('slots', 'slots', '避开节次', { required: true })],
    },
    {
        key: 'advanced:subject.spread', type: 'advanced_constraint', advancedType: 'subject.spread',
        label: '课程分散安排', category: 'subject', strength: 'soft', intent: 'subject_spread', aliases: ['subject.spread'], targetKind: 'subject',
        helpText: '课程在指定班级中尽量分散到不同日期。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('courseScope', 'course_scope', '适用范围')],
    },
    {
        key: 'advanced:room.preferred', type: 'advanced_constraint', advancedType: 'room.preferred',
        label: '指定活动优先教室', category: 'room', strength: 'soft', intent: 'room_preferred', aliases: ['room.preferred'], targetKind: 'subject',
        helpText: '指定课程活动优先使用所选教室。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('activityTypes', 'token_multi', '活动类型', { optionSource: 'activityTypes', minItems: 1 }), field('preferredRoomIds', 'entity_multi', '优先教室', { entityKind: 'room', minItems: 1 })],
    },
    {
        key: 'advanced:room.required', type: 'advanced_constraint', advancedType: 'room.required',
        label: '指定活动必需教室', category: 'room', strength: 'hard', intent: 'room_requirement', aliases: ['room.required'], targetKind: 'subject',
        helpText: '指定课程活动必须使用所选教室或资源标签。',
        fields: [
            field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('activityTypes', 'token_multi', '活动类型', { optionSource: 'activityTypes', minItems: 1 }),
            field('roomIds', 'entity_multi', '必需教室', { entityKind: 'room' }), field('requiredTags', 'token_multi', '必需标签', { optionSource: 'roomTags' }),
            field('teacherIds', 'entity_multi', '限定教师', { entityKind: 'teacher' }),
        ],
        validateAny: [['roomIds', 'requiredTags']],
    },
    {
        key: 'advanced:room.forbidden_type', type: 'advanced_constraint', advancedType: 'room.forbidden_type',
        label: '指定活动禁用教室类型', category: 'room', strength: 'hard', intent: 'room_forbidden_type', aliases: ['room.forbidden_type'], targetKind: 'subject',
        helpText: '指定课程活动禁止使用具有所选标签的教室。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('activityTypes', 'token_multi', '活动类型', { optionSource: 'activityTypes', minItems: 1 }), field('forbiddenRoomTypes', 'token_multi', '禁用教室类型', { optionSource: 'roomTags', minItems: 1 }), field('teacherIds', 'entity_multi', '限定教师', { entityKind: 'teacher' })],
    },
    {
        key: 'advanced:lesson.consecutive', type: 'advanced_constraint', advancedType: 'lesson.consecutive',
        label: '课程连堂', category: 'subject', strength: 'soft', intent: 'block_preference', aliases: ['lesson.consecutive'], targetKind: 'subject',
        helpText: '指定课程尽量按连堂方式安排。',
        fields: [field('targetValue', 'entity', '课程', { entityKind: 'subject', required: true }), field('gradeNames', 'token_multi', '适用年级', { optionSource: 'grades' }), field('blockSize', 'number', '连堂节数', { required: true, range: 'periods' }), field('days', 'weekdays', '适用日期', { required: true })],
    },
    {
        key: 'advanced:class.daily_balance', type: 'advanced_constraint', advancedType: 'class.daily_balance',
        label: '班级日课量均衡', category: 'optimization', strength: 'soft', intent: 'class_daily_balance', aliases: ['class.daily_balance'], targetKind: 'global',
        helpText: '各班每天课量尽量均衡。',
        fields: [field('days', 'weekdays', '适用日期'), field('mainSubjectDailyMax', 'number', '主科每日上限', { range: 'optionalPeriods' })],
    },
    {
        key: 'advanced:subject.avoid_weekday_concentration', type: 'advanced_constraint', advancedType: 'subject.avoid_weekday_concentration',
        label: '课程避免星期集中', category: 'optimization', strength: 'soft', intent: 'avoid_weekday_concentration', aliases: ['subject.avoid_weekday_concentration'], targetKind: 'subject_group',
        helpText: '指定课程不要集中在少数几个工作日。',
        fields: [field('subjectIds', 'entity_multi', '课程', { entityKind: 'subject', minItems: 2 }), field('days', 'weekdays', '避免集中日期', { required: true })],
    },
    {
        key: 'advanced:schedule.cross_venue_boundary', type: 'advanced_constraint', advancedType: 'schedule.cross_venue_boundary',
        label: '跨场地课节边界', category: 'time', strength: 'hard', intent: 'cross_venue_boundary', aliases: ['schedule.cross_venue_boundary'], targetKind: 'global',
        helpText: '指定相邻课节之间不安排需要跨场地转移的连续课程。',
        fields: [field('boundaryPeriods', 'period_pair', '课节边界', { required: true })],
    },
    {
        key: 'advanced:subject.not_consecutive_with', type: 'advanced_constraint', advancedType: 'subject.not_consecutive_with',
        label: '课程同日不连续', category: 'relation', strength: 'soft', intent: 'subject_not_consecutive_with', aliases: ['subject.not_consecutive_with'], targetKind: 'subject_group',
        helpText: '指定两门课程在同一天内不要连续安排。',
        fields: [field('subjectIds', 'entity_multi', '课程', { entityKind: 'subject', minItems: 2, maxItems: 2 }), field('sameDay', 'boolean', '仅限同一天')],
    },
    {
        key: 'advanced:lesson.activity_scope_period_policy', type: 'advanced_constraint', advancedType: 'lesson.activity_scope_period_policy',
        label: '活动类型课节策略', category: 'optimization', strength: 'soft', intent: 'lesson_activity_scope_period_policy', aliases: ['lesson.activity_scope_period_policy'], targetKind: 'subject_group',
        helpText: '指定学科活动避开目标课节，并优先留给其他活动。',
        fields: [field('subjectIds', 'entity_multi', '课程', { entityKind: 'subject', minItems: 1 }), field('activityTypes', 'token_multi', '避开活动', { optionSource: 'activityTypes', minItems: 1 }), field('preferredActivityTypes', 'token_multi', '优先活动', { optionSource: 'activityTypes', minItems: 1 }), field('slots', 'slots', '目标节次', { required: true })],
    },
    {
        key: 'advanced:lesson.resource_attribute_avoid_periods', type: 'advanced_constraint', advancedType: 'lesson.resource_attribute_avoid_periods',
        label: '资源课程避开节次', category: 'optimization', strength: 'soft', intent: 'lesson_resource_attribute_avoid_periods', aliases: ['lesson.resource_attribute_avoid_periods'], targetKind: 'global',
        helpText: '需要指定资源类型的课程尽量避开目标课节。',
        fields: [field('requiredResourceTypes', 'token_multi', '资源类型', { optionSource: 'resourceTypes', minItems: 1 }), field('slots', 'slots', '避开节次', { required: true })],
    },
].map(item => Object.freeze({
    manualAvailable: false,
    parameterKind: item.parameterKind || 'custom',
    fields: Object.freeze(item.fields || []),
    aliases: Object.freeze(item.aliases || []),
    ...item,
}));

export const CONSTRAINT_RULE_EDITOR_DEFINITIONS = Object.freeze([
    ...BASE_EDITOR_DEFINITIONS,
    ...EXTRA_EDITOR_DEFINITIONS,
]);

/**
 * Optional, data-driven education preferences. Selecting a template only
 * prepares the existing manual rule form; it never creates or persists a rule
 * until the user chooses an entity and submits that form.
 */
export const EDUCATION_SOFT_RULE_TEMPLATES = Object.freeze([
    Object.freeze({
        key: 'subject_morning',
        label: '课程上午优先',
        description: '为明确选择的课程预选上午优先偏好。',
        type: 'subject_morning',
        icon: 'sunrise',
    }),
    Object.freeze({
        key: 'subject_spread',
        label: '课程分散安排',
        description: '为明确选择的课程预选跨日期分散偏好。',
        type: 'subject_spread',
        icon: 'calendar-range',
    }),
    Object.freeze({
        key: 'subject_avoid_first_period',
        label: '课程避开首节',
        description: '按当前启用星期生成首节软避让时隙。',
        type: 'subject_avoid_periods',
        icon: 'sun-dim',
        slotMode: 'first',
    }),
    Object.freeze({
        key: 'subject_avoid_last_period',
        label: '课程避开末节',
        description: '按当前启用星期生成末节软避让时隙。',
        type: 'subject_avoid_periods',
        icon: 'moon-star',
        slotMode: 'last',
    }),
]);

const EDUCATION_SOFT_RULE_TEMPLATE_BY_KEY = new Map(
    EDUCATION_SOFT_RULE_TEMPLATES.map(template => [template.key, template]),
);

export function getEducationSoftRuleTemplate(templateKey = '', project = {}) {
    const template = EDUCATION_SOFT_RULE_TEMPLATE_BY_KEY.get(String(templateKey || '').trim());
    if (!template) return null;

    const weekdays = activeWeekdays(project);
    const periods = activePeriods(project);
    const targetPeriod = template.slotMode === 'last' ? periods.at(-1) : periods[0];
    const slots = template.slotMode && Number.isInteger(targetPeriod)
        ? weekdays.map(day => `${day}-${targetPeriod}`)
        : [];

    return {
        ...template,
        formValues: {
            type: template.type,
            targetValue: '',
            slots,
            limit: '',
            scopeClassId: '',
            scopeTeacherId: '',
            restrictTeacher: false,
        },
    };
}

const EDITOR_DEFINITION_BY_KEY = new Map(CONSTRAINT_RULE_EDITOR_DEFINITIONS.map(item => [item.key, item]));
const EDITOR_KEY_BY_ALIAS = new Map();
CONSTRAINT_RULE_EDITOR_DEFINITIONS.forEach(item => {
    [item.key, item.type, item.advancedType, item.intent, ...(item.aliases || [])].filter(Boolean).forEach(alias => {
        const normalized = normalizeRuleType(alias).replace(/^advanced_/, 'advanced:');
        if (!EDITOR_KEY_BY_ALIAS.has(normalized)) EDITOR_KEY_BY_ALIAS.set(normalized, item.key);
    });
});

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
        room: valueList(project.rooms),
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
    return entity.name || entity.label || entity.id || (kind === 'room' ? '教室' : '对象');
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

function editorKeyFromCandidate(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (EDITOR_DEFINITION_BY_KEY.has(raw)) return raw;
    return EDITOR_KEY_BY_ALIAS.get(normalizeRuleType(raw)) || '';
}

export function resolveConstraintRuleEditorKey(constraint = {}) {
    if (typeof constraint === 'string') return editorKeyFromCandidate(constraint);
    const explicit = editorKeyFromCandidate(constraint.formKey || constraint.formType || '');
    if (explicit) return explicit;
    if (normalizeRuleType(constraint.type) === 'advanced_constraint') {
        const advanced = String(constraint.advancedType || constraint.capabilityId || '').trim();
        const advancedKey = editorKeyFromCandidate(advanced ? `advanced:${advanced}` : '')
            || editorKeyFromCandidate(advanced);
        if (advancedKey) return advancedKey;
    }
    const machineType = editorKeyFromCandidate(constraint.type || '');
    if (machineType && normalizeRuleType(constraint.type) !== 'advanced_constraint') return machineType;
    return editorKeyFromCandidate(constraint.intent || constraint.capabilityId || '');
}

export function getConstraintRuleEditorDefinition(constraint = {}) {
    const key = resolveConstraintRuleEditorKey(constraint);
    return key ? EDITOR_DEFINITION_BY_KEY.get(key) || null : null;
}

export function getConstraintRuleEditorCategories() {
    return { ...EDITOR_CATEGORIES };
}

export function getConstraintRuleEditorEntityOptions(project = {}, kind = '') {
    return entityCollection(project, kind).map(entity => ({
        kind,
        id: String(entity.id || ''),
        name: entityLabel(kind, entity),
    })).filter(entity => entity.id);
}

export function getConstraintRuleEditorTokenOptions(project = {}, source = '', currentValues = []) {
    const values = [];
    if (source === 'activityTypes') {
        values.push(...valueList(project.lessonPlans).flatMap(plan => valueList(plan.activityTypes)));
    } else if (source === 'resourceTypes') {
        values.push(...valueList(project.lessonPlans).flatMap(plan => valueList(plan.requiredResourceTypes)));
    } else if (source === 'roomTags') {
        values.push(...valueList(project.rooms).flatMap(room => valueList(room.tags)));
    } else if (source === 'grades') {
        values.push(...valueList(project.classes).map(klass => klass.grade));
    }
    values.push(...valueList(currentValues));
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
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
    const editorDefinition = getConstraintRuleEditorDefinition(constraint);
    const definition = getConstraintRuleDefinition(editorDefinition?.manualAvailable ? editorDefinition.type : constraint.type)
        || editorDefinition;
    const targetKind = constraint.targetType || constraint.target?.type || constraint.target?.kind || definition?.targetKind || '';
    const targetId = constraint.targetId || constraint.target?.id || '';
    const scope = constraint.scope || {};
    const parameters = constraint.parameters || {};
    const scopeClassId = firstScopeId(constraint.scopeClassId || scope.classIds || parameters.classIds);
    const scopeTeacherId = firstScopeId(constraint.scopeTeacherId || scope.teacherIds || parameters.teacherIds);
    const formKey = editorDefinition?.key || '';
    const allTeachers = ['all_teachers', 'global', 'teacher_group'].includes(String(targetKind || '').toLowerCase())
        && (targetId === '__all_teachers' || /all|global|group/i.test(String(targetKind || '')));
    const result = {
        formKey,
        type: editorDefinition?.manualAvailable ? editorDefinition.type : (editorDefinition?.type || ''),
        targetKind,
        targetId: String(targetId || ''),
        targetValue: allTeachers
            ? 'all_teachers:__all_teachers'
            : (targetKind && targetId ? `${targetKind}:${targetId}` : ''),
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

    const valueFor = name => {
        if (name === 'targetValue') return result.targetValue;
        if (name === 'courseScope') return undefined;
        if (name === 'slots') return result.slots;
        if (name === 'limit') return result.limit;
        if (name === 'dayPart') {
            const dayPartIntent = String(constraint.intent || parameters.legacyRow?.intent || '').toLowerCase();
            if (constraint.type === 'subject_morning' || dayPartIntent === 'subject_morning') return 'morning';
            if (constraint.type === 'subject_afternoon' || dayPartIntent === 'subject_afternoon') return 'afternoon';
        }
        if (name === 'classId') return constraint.classId || parameters.classId || '';
        if (name === 'subjectId') return constraint.subjectId || parameters.subjectId || '';
        if (name === 'teacherId') return constraint.teacherId || parameters.teacherId || '';
        if (name === 'roomId') return constraint.roomId || parameters.roomId || '';
        if (name === 'weekPattern') return constraint.weekPattern || parameters.weekPattern || 'every';
        if (name === 'beforeSubjectId') return constraint.beforeSubjectId || parameters.beforeSubjectId || valueList(constraint.subjectIds || parameters.subjectIds)[0] || '';
        if (name === 'afterSubjectId') return constraint.afterSubjectId || parameters.afterSubjectId || valueList(constraint.subjectIds || parameters.subjectIds)[1] || '';
        if (name === 'preferredRoomIds') return valueList(parameters.preferredRoomIds || constraint.preferredRoomIds || parameters.roomIds || constraint.roomIds);
        if (name === 'blockSize') return constraint.blockSize ?? parameters.blockSize ?? 2;
        if (name === 'sameDay') return constraint.sameDay ?? parameters.sameDay ?? true;
        if (name === 'weight') return constraint.weight ?? parameters.weight ?? 1;
        if (name === 'mainSubjectDailyMax') return constraint.mainSubjectDailyMax ?? parameters.mainSubjectDailyMax ?? '';
        if (name === 'avoidFullDayIdle') return constraint.avoidFullDayIdle ?? parameters.avoidFullDayIdle ?? true;
        if (name === 'maxConsecutiveFullAfternoons') return constraint.maxConsecutiveFullAfternoons ?? parameters.maxConsecutiveFullAfternoons ?? 1;
        if (name === 'minGapDays') return constraint.minGapDays ?? parameters.minGapDays ?? constraint.limit ?? '';
        return constraint[name] ?? parameters[name] ?? scope[name] ?? (['days', 'distributionDays'].includes(name) ? getConstraintRuleRange({ ...constraint, ...parameters }).weekdays : undefined);
    };
    (editorDefinition?.fields || []).forEach(editorField => {
        if (['targetValue', 'slots', 'limit', 'courseScope'].includes(editorField.name)) return;
        const value = valueFor(editorField.name);
        if (value !== undefined) result[editorField.name] = Array.isArray(value) ? [...value] : value;
    });
    if ((editorDefinition?.fields || []).some(item => item.kind === 'course_scope')) {
        result.scopeMode = scopeClassId ? 'class' : 'school';
        result.legacyCourseGlobal = !scopeClassId;
    }
    return result;
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

function editorFieldValue(form = {}, name = '') {
    const value = form[name];
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return value;
}

function editorNumberRange(fieldDefinition = {}, project = {}) {
    const weekdays = getConstraintRuleRange(project).weekdays.length;
    const periods = getConstraintRuleRange(project).periods.length;
    return {
        periods: [1, periods],
        optionalPeriods: [0, periods],
        weekly: [1, weekdays * periods],
        weekdays: [1, weekdays],
        gapDays: [1, Math.max(1, weekdays - 1)],
        weight: [1, 10],
    }[fieldDefinition.range] || [1, Number.MAX_SAFE_INTEGER];
}

function editorEntityId(value = '', expectedKind = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const separator = raw.indexOf(':');
    if (separator < 0) return raw;
    const kind = raw.slice(0, separator);
    return !expectedKind || kind === expectedKind ? raw.slice(separator + 1) : '';
}

export function validateConstraintRuleEditorForm(form = {}, project = {}) {
    const definition = getConstraintRuleEditorDefinition(form.formKey || form.type || '');
    const errors = {};
    if (!definition) return { valid: false, definition: null, errors: { type: '请选择具体规则类型' } };
    const range = getConstraintRuleRange(project);
    const allowedSlots = new Set(range.weekdays.flatMap(day => range.periods.map(period => `${day}-${period}`)));

    for (const editorField of definition.fields || []) {
        if (editorField.complexOnly && !(project.complexModelEnabled || project.timetableModelVersion === 'complex_v1')) continue;
        const value = editorFieldValue(form, editorField.name);
        if (editorField.kind === 'entity' || editorField.kind === 'entity_or_all') {
            const raw = String(value || '').trim();
            const allTeachers = editorField.kind === 'entity_or_all' && raw === 'all_teachers:__all_teachers';
            const id = allTeachers ? '__all_teachers' : editorEntityId(raw, editorField.entityKind);
            if (editorField.required && !id) errors[editorField.name] = `请选择项目中的${editorField.label}`;
            if (id && !allTeachers && !entityCollection(project, editorField.entityKind).some(item => String(item.id || '') === id)) {
                errors[editorField.name] = `所选${editorField.label}已不在当前项目中`;
            }
        } else if (['entity_multi', 'token_multi'].includes(editorField.kind)) {
            const values = valueList(value).map(String).filter(Boolean);
            if (editorField.minItems && values.length < editorField.minItems) errors[editorField.name] = `请至少选择 ${editorField.minItems} 项${editorField.label}`;
            if (editorField.maxItems && values.length > editorField.maxItems) errors[editorField.name] = `最多选择 ${editorField.maxItems} 项${editorField.label}`;
        } else if (editorField.kind === 'slots' || editorField.kind === 'single_slot') {
            const slots = normalizeSlots(value);
            if (editorField.required && !slots.length) errors[editorField.name] = `请至少选择一个${editorField.label}`;
            if (editorField.kind === 'single_slot' && slots.length !== 1) errors[editorField.name] = '锁定课节必须且只能选择一个节次';
            if (slots.some(slot => !allowedSlots.has(slot))) errors[editorField.name] = '所选节次超出当前排课范围';
        } else if (editorField.kind === 'number') {
            if ((value === '' || value === undefined || value === null) && !editorField.required) continue;
            const number = Number(value);
            const [min, max] = editorNumberRange(editorField, project);
            if (!Number.isInteger(number) || number < min || number > max) errors[editorField.name] = `请输入 ${min} 到 ${max} 之间的整数`;
        } else if (editorField.kind === 'weekdays') {
            const days = valueList(value).map(Number);
            if (editorField.required && !days.length) errors[editorField.name] = `请至少选择一个${editorField.label}`;
            if (days.some(day => !range.weekdays.includes(day))) errors[editorField.name] = '所选日期超出当前排课范围';
        } else if (editorField.kind === 'period_pair') {
            const periods = valueList(value).map(Number).sort((left, right) => left - right);
            if (periods.length !== 2 || periods[1] - periods[0] !== 1 || periods.some(period => !range.periods.includes(period))) {
                errors[editorField.name] = '请选择两个相邻且有效的课节';
            }
        } else if (editorField.kind === 'enum' && editorField.required) {
            const allowed = new Set((editorField.options || []).map(item => item.value));
            if (!allowed.has(value)) errors[editorField.name] = `请选择${editorField.label}`;
        } else if (editorField.kind === 'course_scope') {
            const scopeMode = form.scopeMode || (form.scopeClassId ? 'class' : 'school');
            if (scopeMode === 'class') {
                const subjectId = editorEntityId(form.targetValue || form.targetId, 'subject');
                const scope = courseScopeValue(form, project);
                if (!scope.classId || !scope.klass) errors.scopeClassId = '请选择该课程适用的班级';
                else if (scope.restrictTeacher && (!scope.teacherId || !scope.teacher)) errors.scopeTeacherId = '请选择需要限定的任课教师';
                else if (subjectId && !scope.plans.length) errors.scopeClassId = '该课程与班级没有匹配的任课安排';
            }
        }
    }
    for (const group of definition.validateAny || []) {
        if (!group.some(name => valueList(form[name]).filter(Boolean).length)) {
            errors[group[0]] = '请至少完成一项教室或资源要求';
        }
    }
    for (const [left, right] of definition.distinctFields || []) {
        if (form[left] && form[left] === form[right]) errors[right] = '请选择两个不同的课程';
    }
    return { valid: Object.keys(errors).length === 0, definition, errors, range };
}

const EDITOR_OWNED_FIELDS = new Set([
    'target', 'targetType', 'targetId', 'targetName', 'slots', 'days', 'periods', 'limit', 'value', 'weight',
    'classId', 'subjectId', 'teacherId', 'roomId', 'weekPattern', 'teacherIds', 'teacherNames', 'subjectIds',
    'subjectNames', 'classIds', 'roomIds', 'preferredRoomIds', 'requiredTags', 'forbiddenRoomTypes', 'activityTypes',
    'preferredActivityTypes', 'requiredResourceTypes', 'gradeNames', 'boundaryPeriods', 'distributionDays', 'dayPart',
    'blockSize', 'blockPreference', 'sameDay', 'beforeSubjectId', 'afterSubjectId', 'minGapDays',
    'mainSubjectDailyMax', 'avoidFullDayIdle', 'maxConsecutiveFullAfternoons', 'scopeClassId', 'scopeClassName',
    'scopeTeacherId', 'scopeTeacherName', 'scopeLabel',
]);

function editorEntity(project = {}, kind = '', value = '') {
    const id = editorEntityId(value, kind);
    return entityCollection(project, kind).find(item => String(item.id || '') === id) || null;
}

function editorArray(form = {}, name = '') {
    return [...new Set(valueList(form[name]).map(value => String(value || '').trim()).filter(Boolean))];
}

function dayPartSlots(project = {}, dayPart = 'morning') {
    const range = getConstraintRuleRange(project);
    const afternoonStart = Math.max(1, Number(project.dayPartBoundaries?.afternoonStartPeriod) || 5);
    const eveningStart = Math.max(afternoonStart + 1, Number(project.dayPartBoundaries?.eveningStartPeriod) || Number.MAX_SAFE_INTEGER);
    const periods = dayPart === 'afternoon'
        ? range.periods.filter(period => period >= afternoonStart && period < eveningStart)
        : range.periods.filter(period => period < afternoonStart);
    return range.weekdays.flatMap(day => periods.map(period => `${day}-${period}`));
}

function displayNames(project = {}, kind = '', ids = []) {
    const byId = new Map(entityCollection(project, kind).map(item => [String(item.id || ''), entityLabel(kind, item)]));
    return ids.map(id => byId.get(String(id)) || String(id));
}

export function summarizeConstraintRuleForm(form = {}, project = {}) {
    const definition = getConstraintRuleEditorDefinition(form.formKey || form.type || '');
    if (!definition) return '未知规则';
    let targetName = '';
    const targetField = (definition.fields || []).find(item => item.name === 'targetValue');
    if (targetField) {
        targetName = form.targetValue === 'all_teachers:__all_teachers'
            ? '全部教师'
            : entityLabel(targetField.entityKind, editorEntity(project, targetField.entityKind, form.targetValue) || {});
    } else if (editorArray(form, 'subjectIds').length) {
        targetName = displayNames(project, 'subject', editorArray(form, 'subjectIds')).join('、');
    } else if (editorArray(form, 'teacherIds').length) {
        targetName = displayNames(project, 'teacher', editorArray(form, 'teacherIds')).join('、');
    } else if (definition.targetKind === 'global') {
        targetName = '全校';
    }
    const detail = normalizeSlots(form.slots).map(formatConstraintSlot).join('、')
        || (form.limit ? `${form.limit}` : '')
        || (form.minGapDays ? `间隔 ${form.minGapDays} 天` : '');
    return [definition.label, targetName, detail, definition.strength === 'hard' ? '硬约束' : '软约束']
        .filter(Boolean).join(' ｜ ');
}

function compileConstraintRuleEditorArtifacts(form = {}, project = {}, options = {}) {
    const validation = validateConstraintRuleEditorForm(form, project);
    if (!validation.valid) return { ok: false, ...validation };
    const { definition } = validation;
    const existing = options.existing || {};
    const id = String(existing.id || options.id || createArtifactId());
    const sourceId = existing.sourceId || existing.source?.sourceId || `manual:source:${id}`;
    const clauseId = existing.clauseId || `${sourceId}:clause:1`;
    const machineRuleId = existing.machineRuleId || `${sourceId}:rule:1`;
    const requirementId = existing.requirementId || `${sourceId}:requirement:1`;
    const next = { ...existing };
    EDITOR_OWNED_FIELDS.forEach(name => delete next[name]);
    const parameters = { ...(existing.parameters || {}) };
    EDITOR_OWNED_FIELDS.forEach(name => delete parameters[name]);
    delete parameters.roomRequirement;
    const scope = { ...(existing.scope || {}) };
    ['classIds', 'teacherIds', 'activityTypes', 'teacherNames', 'qualifier'].forEach(name => delete scope[name]);

    const targetField = (definition.fields || []).find(item => item.name === 'targetValue');
    let targetKind = definition.targetKind || 'global';
    let targetId = '';
    let targetName = '';
    if (targetField) {
        if (form.targetValue === 'all_teachers:__all_teachers') {
            targetKind = 'all_teachers';
            targetId = '__all_teachers';
            targetName = '全部教师';
        } else {
            const entity = editorEntity(project, targetField.entityKind, form.targetValue);
            targetKind = targetField.entityKind;
            targetId = String(entity.id);
            targetName = entityLabel(targetKind, entity);
        }
    }

    for (const editorField of definition.fields || []) {
        const name = editorField.name;
        if (name === 'targetValue' || name === 'courseScope') continue;
        if (editorField.complexOnly && !(project.complexModelEnabled || project.timetableModelVersion === 'complex_v1')) continue;
        if (['entity_multi', 'token_multi', 'weekdays', 'period_pair'].includes(editorField.kind)) {
            const values = editorField.kind === 'weekdays' || editorField.kind === 'period_pair'
                ? valueList(form[name]).map(Number).filter(Number.isInteger)
                : editorArray(form, name);
            if (values.length) {
                next[name] = values;
                parameters[name] = values;
            }
        } else if (editorField.kind === 'slots' || editorField.kind === 'single_slot') {
            const slots = normalizeSlots(form[name]);
            const days = [...new Set(slots.map(slot => Number(slot.split('-')[0])))];
            const periods = [...new Set(slots.map(slot => Number(slot.split('-')[1])))];
            next.slots = slots;
            next.days = days;
            next.periods = periods;
            parameters.slots = slots;
            parameters.days = days;
            parameters.periods = periods;
        } else if (editorField.kind === 'number') {
            if (form[name] !== '' && form[name] !== undefined && form[name] !== null) {
                const number = Number(form[name]);
                next[name] = number;
                parameters[name] = number;
            }
        } else if (editorField.kind === 'boolean') {
            next[name] = Boolean(form[name]);
            parameters[name] = Boolean(form[name]);
        } else if (editorField.kind === 'enum' || editorField.kind === 'entity') {
            const raw = String(form[name] || '').trim();
            const value = editorField.kind === 'entity' ? editorEntityId(raw, editorField.entityKind) : raw;
            if (value) {
                next[name] = value;
                parameters[name] = value;
            }
        }
    }

    const hasCourseScope = (definition.fields || []).some(item => item.kind === 'course_scope');
    if (hasCourseScope && (form.scopeMode || (form.scopeClassId ? 'class' : 'school')) === 'class') {
        const courseScope = courseScopeValue(form, project);
        parameters.classIds = [courseScope.classId];
        if (courseScope.teacherId) parameters.teacherIds = [courseScope.teacherId];
        scope.classIds = [courseScope.classId];
        if (courseScope.teacherId) scope.teacherIds = [courseScope.teacherId];
        next.scopeClassId = courseScope.classId;
        next.scopeClassName = entityLabel('class', courseScope.klass);
        next.scopeTeacherId = courseScope.teacherId;
        next.scopeTeacherName = courseScope.teacher ? entityLabel('teacher', courseScope.teacher) : '';
        next.scopeLabel = courseScope.label;
    }

    if (definition.key === 'subject_morning' || definition.key === 'subject_afternoon' || definition.advancedType === 'subject.preferred_day_part') {
        const dayPart = form.dayPart || (definition.key === 'subject_afternoon' ? 'afternoon' : 'morning');
        const slots = dayPartSlots(project, dayPart);
        parameters.dayPart = dayPart;
        parameters.slots = slots;
        next.slots = slots;
    }
    if (definition.advancedType === 'lesson.consecutive') {
        parameters.blockPreference = 'double';
        next.blockPreference = 'double';
    }
    if (definition.advancedType === 'teacher.prep_group_fairness') {
        parameters.comparisonScope = 'preparation_group';
        parameters.fairnessMode = 'within_group';
        scope.qualifier = 'preparation_group';
    }
    if (definition.advancedType?.startsWith('room.')) {
        if (parameters.activityTypes?.length) scope.activityTypes = parameters.activityTypes;
        if (parameters.teacherIds?.length) {
            parameters.teacherNames = displayNames(project, 'teacher', parameters.teacherIds);
            scope.teacherNames = parameters.teacherNames;
            scope.qualifier = 'teacher_activity';
            parameters.scopeQualifier = 'teacher_activity';
        } else {
            scope.qualifier = 'activity';
            parameters.scopeQualifier = 'activity';
        }
    }
    if (definition.key === 'room_requirement' || definition.advancedType === 'room.required') {
        const roomIds = parameters.roomIds || [];
        const requiredTags = parameters.requiredTags || [];
        parameters.roomRequirement = { roomIds, requiredTags };
        if (definition.advancedType === 'room.required') parameters.roomName = displayNames(project, 'room', roomIds)[0] || '';
    }
    if (definition.advancedType === 'room.preferred') {
        parameters.roomIds = parameters.preferredRoomIds || [];
    }
    if (parameters.subjectIds?.length) {
        parameters.subjectNames = displayNames(project, 'subject', parameters.subjectIds);
        if (!targetId) {
            targetKind = 'subject_group';
            targetId = parameters.subjectIds[0];
            targetName = parameters.subjectNames.join('、');
        }
    }
    if (parameters.teacherIds?.length && definition.type === 'teacher_mutual_exclusion') {
        targetKind = 'global';
        targetId = parameters.teacherIds.join('|');
        targetName = displayNames(project, 'teacher', parameters.teacherIds).join('、');
    }
    if (definition.type === 'subject_sequence') {
        const before = editorEntity(project, 'subject', form.beforeSubjectId);
        const after = editorEntity(project, 'subject', form.afterSubjectId);
        targetKind = 'global';
        targetId = `${before.id}>${after.id}`;
        targetName = `${entityLabel('subject', before)} 先于 ${entityLabel('subject', after)}`;
    }
    if (definition.type === 'locked_slot') {
        targetKind = 'locked_slot';
        targetId = [next.classId, next.subjectId, next.teacherId, next.slots?.[0]].filter(Boolean).join('|');
        targetName = [
            entityLabel('class', editorEntity(project, 'class', next.classId) || {}),
            entityLabel('subject', editorEntity(project, 'subject', next.subjectId) || {}),
            entityLabel('teacher', editorEntity(project, 'teacher', next.teacherId) || {}),
        ].filter(Boolean).join(' · ');
    }
    if (!targetField && !targetId && !parameters.subjectIds?.length) {
        targetKind = definition.targetKind || 'global';
        targetId = targetKind === 'teacher_group' ? '__teacher_group' : '__global';
        targetName = targetKind === 'teacher_group' ? '教师组' : '全校';
    }

    const scopedAdvancedType = !definition.advancedType && hasCourseScope && form.scopeMode === 'class'
        ? COURSE_SCOPE_ADVANCED_TYPES[definition.type]
        : '';
    const advancedType = definition.advancedType || scopedAdvancedType;
    const machineType = advancedType ? 'advanced_constraint' : definition.type;
    const summary = summarizeConstraintRuleForm({ ...form, formKey: definition.key }, project);
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
    Object.assign(next, {
        id,
        type: machineType,
        ...(advancedType ? { advancedType, capabilityId: advancedType } : {}),
        intent: definition.intent || definition.type,
        typeLabel: definition.label,
        targetType: targetKind,
        targetId,
        targetName,
        target: { type: targetKind, kind: targetKind, id: targetId, name: targetName },
        parameters,
        scope,
        priority: definition.strength,
        strength: definition.strength,
        status: 'effective',
        reviewStatus: 'understood',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        description: summary,
        understanding: summary,
        sourceText,
        rawText: existing.rawText || sourceText,
        origin,
        parsedBy,
        sourceId,
        clauseId,
        machineRuleId,
        requirementId,
        source,
        warnings: [],
    });
    if (!advancedType) {
        delete next.advancedType;
        if (next.capabilityId === existing.advancedType) delete next.capabilityId;
    }
    delete next.originalId;
    delete next.formKey;
    delete next.formType;
    delete next.formValues;
    delete next.formErrors;

    const matchedIds = targetKind === 'subject_group'
        ? parameters.subjectIds || []
        : targetKind === 'teacher_group'
            ? parameters.teacherIds || []
            : targetId && !targetId.startsWith('__') ? [targetId] : [];
    const requirementItem = {
        id: requirementId,
        requirementId,
        sourceId,
        clauseId,
        capabilityId: advancedType || definition.key,
        machineRuleIds: [machineRuleId],
        rowId: id,
        object: { kind: targetKind, name: targetName, matchedIds, scope: matchedIds.length ? 'explicit' : 'derived' },
        intent: definition.intent || definition.type,
        condition: next.slots?.length ? { slots: next.slots } : {},
        parameters,
        ...(Object.keys(scope).length ? { scope } : {}),
        strength: definition.strength,
        status: 'actionable',
        reviewStatus: 'understood',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        applyTo: 'rule',
        applicationTarget: 'rule',
        requiresHumanReview: false,
        origin,
        parsedBy,
        confidence: existing.confidence ?? 1,
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
        reviewStatus: 'understood',
        status: 'actionable',
        applicationTarget: 'rule',
        requiresHumanReview: false,
        confidence: existing.confidence ?? 1,
        clauses: [requirementItem],
        machineRuleIds: [machineRuleId],
        source,
        warnings: [],
    };
    return {
        ok: true,
        errors: {},
        definition,
        draftRow: next,
        requirementItem,
        sourceRequirement,
        constraintIR: { ...requirementItem },
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
    if (form.formKey || (!getConstraintRuleDefinition(form.type) && getConstraintRuleEditorDefinition(form.type))) {
        return compileConstraintRuleEditorArtifacts(form, project, options);
    }
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
