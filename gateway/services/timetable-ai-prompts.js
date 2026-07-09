export const AI_REQUIREMENT_PROMPT_VERSION = 'timetable_ai_requirement_extract_v2';

export const TIMETABLE_REQUIREMENT_INTENTS = [
    'teacher_unavailable',
    'class_unavailable',
    'global_unavailable',
    'locked_slot',
    'subject_morning',
    'subject_afternoon',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'avoid_first_period',
    'avoid_last_period',
    'lunch_protection',
    'teaching_group_meeting',
    'first_period_assign',
    'golden_hour_preference',
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
    'block_preference',
    'week_pattern',
    'campus_commute_gap',
    'teaching_group_session',
    'unknown',
];

export const AI_REQUIREMENT_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['requirements'],
    properties: {
        requirements: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: true,
                required: ['intent', 'evidence'],
                properties: {
                    id: { type: 'string' },
                    intent: { type: 'string', enum: TIMETABLE_REQUIREMENT_INTENTS },
                    targetKind: { type: 'string', enum: ['teacher', 'class', 'subject', 'room', 'global', 'teaching_group', 'derived_group', 'unknown'] },
                    targetNames: { type: 'array', items: { type: 'string' } },
                    targetIds: { type: 'array', items: { type: 'string' } },
                    strength: { type: 'string', enum: ['hard', 'soft'] },
                    time: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            slots: { type: 'array', items: { type: 'string' } },
                            days: { type: 'array', items: { type: 'integer' } },
                            periods: { type: 'array', items: { type: 'integer' } },
                            dayPart: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'all_day', ''] },
                        },
                    },
                    params: { type: 'object', additionalProperties: true },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    needsClarification: { type: 'boolean' },
                    clarification: { type: 'object', additionalProperties: true },
                    evidence: { type: 'string' },
                    notes: { type: 'string' },
                },
            },
        },
        unrecognized: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    text: { type: 'string' },
                    reason: { type: 'string' },
                },
            },
        },
        warnings: { type: 'array', items: { type: 'string' } },
    },
};

const FEW_SHOTS = [
    { text: '张老师周一上午不排课', intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['张老师'], time: { days: [1], dayPart: 'morning' }, strength: 'hard' },
    { text: '三(2)班周五下午社团活动不排常规课', intent: 'class_unavailable', targetKind: 'class', targetNames: ['三(2)班'], time: { days: [5], dayPart: 'afternoon' }, strength: 'hard' },
    { text: '周一第1节全校升旗', intent: 'global_unavailable', targetKind: 'global', targetNames: ['全校'], time: { slots: ['1-1'] }, strength: 'hard' },
    { text: '数学尽量排上午', intent: 'subject_morning', targetKind: 'subject', targetNames: ['数学'], strength: 'soft' },
    { text: '主科尽量排上午黄金时段', intent: 'golden_hour_preference', targetKind: 'subject', targetNames: ['主科'], strength: 'soft' },
    { text: '体育尽量排下午', intent: 'subject_afternoon', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' },
    { text: '音乐不要排第一节', intent: 'avoid_first_period', targetKind: 'subject', targetNames: ['音乐'], strength: 'soft' },
    { text: '美术避开放学前最后一节', intent: 'avoid_last_period', targetKind: 'subject', targetNames: ['美术'], strength: 'soft' },
    { text: '英语优先第2到第4节', intent: 'subject_preferred_periods', targetKind: 'subject', targetNames: ['英语'], time: { periods: [2, 3, 4] }, strength: 'soft' },
    { text: '语文早读排第1节', intent: 'first_period_assign', targetKind: 'subject', targetNames: ['语文'], time: { periods: [1] }, strength: 'hard' },
    { text: '午休前后一节尽量保护', intent: 'lunch_protection', targetKind: 'global', targetNames: ['午休'], strength: 'soft' },
    { text: '每位老师每天最多4节', intent: 'teacher_daily_limit', targetKind: 'teacher', targetNames: ['全部教师'], params: { limit: 4 }, strength: 'soft' },
    { text: '全部教师周一第1节都不要排课', intent: 'teacher_unavailable', targetKind: 'teacher', targetNames: ['全部教师'], time: { slots: ['1-1'] }, strength: 'hard' },
    { text: '王老师每周最多16节', intent: 'teacher_weekly_limit', targetKind: 'teacher', targetNames: ['王老师'], params: { limit: 16 }, strength: 'hard' },
    { text: '数学组周三下午教研', intent: 'teaching_group_meeting', targetKind: 'teaching_group', targetNames: ['数学组'], time: { days: [3], dayPart: 'afternoon' }, strength: 'hard' },
    { text: '物理必须去实验室上', intent: 'room_requirement', targetKind: 'subject', targetNames: ['物理'], params: { roomNames: ['实验室'] }, strength: 'hard' },
    { text: '语文和数学不要排同一天', intent: 'subject_not_same_day', targetKind: 'subject', targetNames: ['语文', '数学'], strength: 'hard' },
    { text: '作文课最好两节连上', intent: 'block_preference', targetKind: 'subject', targetNames: ['作文'], params: { blockSize: 2 }, strength: 'soft' },
    { text: '单双周体育分开排', intent: 'week_pattern', targetKind: 'subject', targetNames: ['体育'], strength: 'soft' },
    { text: '跨校区老师两节课之间要留出通勤时间', intent: 'campus_commute_gap', targetKind: 'teacher', targetNames: ['跨校区老师'], strength: 'hard' },
    { text: '一班二班合班上音乐', intent: 'teaching_group_session', targetKind: 'class', targetNames: ['一班', '二班'], params: { subjectNames: ['音乐'] }, strength: 'hard' },
];

function compactEntity(item = {}) {
    return {
        id: item.id || '',
        name: item.name || [item.grade, item.name].filter(Boolean).join('') || '',
        aliases: item.aliases || [],
        subjects: item.subjects || [],
        tags: item.tags || [],
    };
}

function projectSnapshot(project = {}) {
    return {
        activeWeekdays: project.activeWeekdays || [],
        activePeriods: project.activePeriods || [],
        dayPartBoundaries: project.dayPartBoundaries || {},
        teachers: (project.teachers || []).map(compactEntity),
        classes: (project.classes || []).map(item => ({
            id: item.id || '',
            name: item.name || '',
            grade: item.grade || '',
            label: [item.grade, item.name].filter(Boolean).join(''),
            aliases: item.aliases || [],
        })),
        subjects: (project.subjects || []).map(compactEntity),
        rooms: (project.rooms || []).map(compactEntity),
        lessonPlans: (project.lessonPlans || []).map(plan => ({
            id: plan.id || '',
            classId: plan.classId || '',
            subjectId: plan.subjectId || '',
            teacherId: plan.teacherId || '',
            teacherIds: plan.teacherIds || [],
            weeklyHours: plan.weeklyHours,
        })),
    };
}

export function buildAiRequirementExtractionMessages({ project = {}, text = '', contextStats = null } = {}) {
    return [
        {
            role: 'system',
            content: [
                '你是教务排课约束抽取器，只把自然语言转成 JSON，不写解释。',
                `版本：${AI_REQUIREMENT_PROMPT_VERSION}`,
                '必须只输出一个 JSON 对象，形如 {"requirements":[],"unrecognized":[],"warnings":[]}。',
                'requirements[].intent 必须来自给定 intent 目录；不确定对象、时间、参数时设置 needsClarification=true 并降低 confidence。',
                '不得编造教师、班级、课程、教室 id；可以输出用户原文里的名称，后续由本地系统白名单匹配。',
                '硬约束用于“必须、不能、不可、不排、固定”；软约束用于“尽量、优先、少、均衡”。',
                '时间槽统一用 "天-节"，周一=1；也尽量同步给出 time.days/time.periods；如果只知道上午/下午，用 time.dayPart 和 days/periods 表达。',
                '优先输出用户语义 intent，不要提前编译成底层规则：第一节/最后一节避开用 avoid_first_period/avoid_last_period；早读/首节固定用 first_period_assign；主科黄金时段/前四节用 golden_hour_preference；午休边界用 lunch_protection；全部教师不排课用 teacher_unavailable，只有全校活动/升旗/大扫除才用 global_unavailable。',
                `Intent 目录：${TIMETABLE_REQUIREMENT_INTENTS.join(', ')}`,
                `JSON Schema：${JSON.stringify(AI_REQUIREMENT_JSON_SCHEMA)}`,
                `Few-shot：${JSON.stringify(FEW_SHOTS)}`,
            ].join('\n'),
        },
        {
            role: 'user',
            content: JSON.stringify({
                text,
                contextStats,
                project: projectSnapshot(project),
            }),
        },
    ];
}
