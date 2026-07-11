const BASE_RULE_TYPE_LABELS = {
    teacher_unavailable: '教师不可排',
    class_unavailable: '班级不可排',
    locked_slot: '固定课节',
    global_unavailable: '全校不可排',
    subject_morning: '上午优先',
    subject_afternoon: '下午优先',
    subject_preferred_periods: '课程优先节次',
    subject_avoid_periods: '课程避开节次',
    subject_daily_limit: '课程每日上限',
    teacher_daily_limit: '教师每日上限',
    teacher_consecutive_limit: '教师连续上限',
    teacher_weekly_limit: '教师每周上限',
    teacher_max_days_per_week: '教师每周天数上限',
    teacher_mutual_exclusion: '教师互斥',
    subject_spread: '课程分散',
    course_interval: '课程间隔',
    room_requirement: '教室要求',
    class_daily_balance: '班级每日均衡',
    teacher_gap_preference: '教师少空堂',
    block_protection: '连堂块保护',
    teacher_load_balance: '教师负载均衡',
    subject_not_same_day: '课程不同天',
    subject_sequence: '课程顺序',
    forbid: '禁止安排',
    prefer: '优先安排',
    avoid: '尽量避开',
};

export { BASE_RULE_TYPE_LABELS as RULE_TYPE_LABELS };

export const PLANNER_RULE_TYPE_LABELS = {
    ...BASE_RULE_TYPE_LABELS,
    locked_slot: '锁定课节',
    subject_morning: '课程上午优先',
    subject_preferred_periods: '课程偏好节次',
    teacher_consecutive_limit: '教师连堂上限',
    subject_spread: '同科分散',
    teacher_load_balance: '教师负载均衡（仅建议）',
    block_protection: '连堂保护（仅建议）',
    class_daily_balance: '班级每日均衡（仅建议）',
    quality_subject_later: '素质课后置（仅建议）',
    subject_spread_suggestion: '同科分散（仅建议）',
};

export function plannerRuleTypeLabel(type = '') {
    return PLANNER_RULE_TYPE_LABELS[type] || type;
}

export const CONSTRAINT_EXAMPLE_GROUPS = [
    { intent: 'teacher_unavailable', label: '教师不可排', examples: ['张老师周一上午不排课', '王老师周三第3节不能上课'] },
    { intent: 'class_unavailable', label: '班级不可排', examples: ['三(1)班周五下午社团活动，不排常规课', '七年级2班周二第6节班会占用'] },
    { intent: 'global_unavailable', label: '全校不可排', examples: ['每天第1节全校早读不排常规课', '周五下午全校社团活动，不排普通课程'] },
    { intent: 'locked_slot', label: '固定课节', examples: ['七年级1班数学固定在周一第2节', '三(2)班班会固定周五第6节'] },
    { intent: 'subject_morning', label: '上午优先', examples: ['数学尽量安排在上午', '语文和英语优先上午'] },
    { intent: 'subject_afternoon', label: '下午优先', examples: ['体育尽量安排在下午', '音乐美术可以放下午'] },
    { intent: 'subject_preferred_periods', label: '课程优先节次', examples: ['数理化尽量在前四节', '英语最好排第2到第4节'] },
    { intent: 'subject_avoid_periods', label: '课程避开节次', examples: ['体育不要排第一节', '音乐尽量避开上午第1节'] },
    { intent: 'subject_daily_limit', label: '课程每日上限', examples: ['每个班数学每天最多1节', '英语一天不要超过2节'] },
    { intent: 'teacher_daily_limit', label: '教师每日上限', examples: ['每位老师每天最多4节', '张老师一天不要超过5节'] },
    { intent: 'teacher_consecutive_limit', label: '教师连续上限', examples: ['老师连续上课不超过3节', '王老师连堂最多2节'] },
    { intent: 'teacher_weekly_limit', label: '教师每周上限', examples: ['李老师每周最多16节课', '高负载老师每周不要超过18节'] },
    { intent: 'teacher_max_days_per_week', label: '教师每周天数上限', examples: ['张老师每周最多来校4天', '兼职老师一周不超过3天有课'] },
    { intent: 'teacher_mutual_exclusion', label: '教师互斥', examples: ['张老师和王老师不能同一节都有课', '两位跨校老师的课尽量错开'] },
    { intent: 'subject_spread', label: '课程分散', examples: ['数学课要分散一点', '英语不要连着几天都排'] },
    { intent: 'course_interval', label: '课程间隔', examples: ['体育课最好隔天排', '音乐美术之间至少隔一天'] },
    { intent: 'room_requirement', label: '教室要求', examples: ['物理必须去实验室上', '信息技术安排在机房'] },
    { intent: 'class_daily_balance', label: '班级每日均衡', examples: ['班级每天课时尽量均衡', '每天每个班主科不要堆太多'] },
    { intent: 'teacher_gap_preference', label: '教师少空堂', examples: ['老师每天尽量少空堂', '张老师的课尽量集中一点'] },
    { intent: 'block_protection', label: '连堂块保护', examples: ['数学最好两节连上', '实验课连堂块不要拆开'] },
    { intent: 'teacher_load_balance', label: '教师负载均衡', examples: ['教师工作量要均衡', '高负载老师不要一直被压课'] },
    { intent: 'teacher_load_protection', label: '高负载教师保护', examples: ['老师别太密', '别给张老师排太累'] },
    { intent: 'subject_not_same_day', label: '课程不同天', examples: ['语文和数学不要排在同一天', '体育和音乐别放同一天'] },
    { intent: 'subject_sequence', label: '课程顺序', examples: ['先上数学再上物理', '实验课要排在理论课之后'] },
    { intent: 'week_pattern', label: '单双周', examples: ['单双周体育分开排', '这门课只在单周上'] },
    { intent: 'campus_commute_gap', label: '跨校区间隔', examples: ['跨校区老师两节课之间要留出通勤时间', '南北校区连续课之间至少隔一节'] },
    { intent: 'teaching_group_meeting', label: '教研时间', examples: ['数学组周三下午教研，数学课不要排这个时间', '英语组周二第7节集备，相关老师不排课'] },
    { intent: 'golden_hour_preference', label: '黄金时段', examples: ['主科尽量排上午黄金时段', '高年级主科放精力最好的时段'] },
    { intent: 'class_subject_spread', label: '班级课程分散', examples: ['三(1)班语文一周内分散到不同天', '七年级数学不要集中在前两天'] },
    { intent: 'default_block_policy', label: '默认连堂策略', examples: ['未注明默认单节课', '理化实验默认按两节连堂处理'] },
];

export const QUICK_CONSTRAINT_EXAMPLES = CONSTRAINT_EXAMPLE_GROUPS
    .flatMap(group => group.examples.slice(0, 1))
    .slice(0, 8);

export function normalizeStatusKey(value = '') {
    return String(value || '').trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

export function requirementIntentLabel(intent = '') {
    const key = normalizeStatusKey(intent);
    const label = {
        preferred_periods: '优先节次',
        subject_preferred_periods: '优先节次',
        subject_prefer_periods: '优先节次',
        subject_preferred_slots: '优先节次',
        preferred_day_part: '优先时段',
        subject_morning: '上午优先',
        subject_afternoon: '下午优先',
        morning_subject: '上午优先',
        morning_preference: '上午优先',
        morning: '上午时段',
        afternoon_subject: '下午优先',
        afternoon_preference: '下午优先',
        afternoon: '下午时段',
        period_preference: '优先节次',
        avoid_periods: '避开节次',
        subject_avoid_periods: '避开节次',
        subject_avoid_slots: '避开节次',
        unavailable_periods: '不可排时间',
        teacher_unavailable: '教师不可排',
        class_unavailable: '班级不可排',
        global_unavailable: '全校不可排',
        locked_slot: '固定课节',
        subject_daily_limit: '课程每日上限',
        teacher_daily_limit: '每日课时上限',
        teacher_consecutive_limit: '连续课时上限',
        teacher_weekly_limit: '每周课时上限',
        teacher_max_days_per_week: '每周授课天数上限',
        teacher_mutual_exclusion: '教师互斥',
        subject_spread: '课程分散',
        course_interval: '课程间隔',
        course_spread: '课程分散',
        spread: '课程分散',
        room_requirement: '教室要求',
        block_preference: '连堂设置',
        block_protection: '连堂块保护',
        default_block_policy: '默认课时块策略',
        block_integrity: '连堂块保护',
        teacher_gap_preference: '教师少空堂',
        teacher_load_balance: '教师负载均衡',
        teacher_load_protection: '高负载教师保护',
        teacher_time_conflict: '教师时间冲突',
        class_time_conflict: '班级时间冲突',
        class_daily_balance: '班级每日均衡',
        class_subject_spread: '班级课程分散',
        quality_subject_later: '素质课时段建议',
        subject_not_same_day: '课程不同天',
        subject_sequence: '课程顺序',
        forbid: '禁止安排',
        prefer: '优先安排',
        avoid: '尽量避开',
    }[key];
    if (label) return label;
    return /[A-Za-z_]/.test(String(intent || '')) ? '排课需求' : intent || '排课需求';
}

export function requirementStatusLabel(item = {}) {
    const key = normalizeStatusKey(item.status || '');
    return {
        handled: '已处理',
        ignored: '已处理',
        applied: '已应用',
        suggestion: '建议',
        parsed: '已理解',
        understood: '已理解',
        compiled: '可执行',
        executable: '可执行',
        actionable: '可应用',
        ready: '可应用',
        effective: '可应用',
        needs_clarification: '待补充',
        needs_review: '需复核',
        review: '需复核',
        candidate: '待确认',
        pending: '待确认',
        partially_parsed: '部分理解',
        partially_supported: '部分支持',
        partially_actionable: '部分可执行',
        partially_executable: '部分可执行',
        understood_not_executable: '已理解，暂不可执行',
        unsupported_by_solver: '已理解，但当前求解器暂不支持',
        unsupported: '已理解，暂不支持',
        invalid: '需修正',
    }[key] || '待确认';
}

export function requirementApplyLabel(applyTo = '') {
    const key = normalizeStatusKey(applyTo);
    return {
        rule: '→ 排课规则',
        rules: '→ 排课规则',
        constraint: '→ 排课规则',
        constraint_rule: '→ 排课规则',
        lesson_plan: '→ 任课计划',
        lesson_plans: '→ 任课计划',
        lessonplan: '→ 任课计划',
        optimization: '→ 优化目标',
        optimize: '→ 优化目标',
        solver_policy: '✓ 系统内置',
        system_policy: '✓ 系统内置',
        model_extension: '→ 复杂模型',
        complex_model: '→ 复杂模型',
        handled: '✓ 系统内置',
        review: '⚠ 待你确认',
        needs_review: '⚠ 待你确认',
        needs_clarification: '⚠ 待补充',
        partially_supported: '⚠ 部分可执行',
        partially_actionable: '⚠ 部分可执行',
        partially_executable: '⚠ 部分可执行',
        understood_not_executable: '○ 已理解，暂不可执行',
        unsupported_by_solver: '○ 求解器暂不支持',
        unsupported: '○ 暂不可执行',
    }[key] || (/[A-Za-z_]/.test(String(applyTo || '')) ? '⚠ 待你确认' : applyTo || '⚠ 待你确认');
}

export function requirementApplyTone(applyTo = '', status = '') {
    const applyKey = normalizeStatusKey(applyTo);
    const statusKey = normalizeStatusKey(status);
    const clarificationKeys = new Set(['needs_clarification', 'needs_review', 'review']);
    const partialKeys = new Set(['partially_supported', 'partially_actionable', 'partially_executable']);
    const understoodButUnavailableKeys = new Set(['unsupported', 'unsupported_by_solver', 'understood_not_executable']);
    if (clarificationKeys.has(statusKey) || clarificationKeys.has(applyKey)) return 'warning';
    if (partialKeys.has(statusKey) || partialKeys.has(applyKey)) return 'warning';
    if (understoodButUnavailableKeys.has(statusKey) || understoodButUnavailableKeys.has(applyKey)) return 'warning';
    if (applyKey === 'optimization' || applyKey === 'optimize') return 'info';
    if (applyKey === 'solver_policy' || applyKey === 'system_policy' || applyKey === 'handled' || statusKey === 'handled') return 'muted';
    if (applyKey === 'model_extension' || applyKey === 'complex_model') return 'complex';
    if (['rule', 'rules', 'constraint', 'constraint_rule', 'lesson_plan', 'lesson_plans', 'lessonplan'].includes(applyKey)) return 'success';
    return 'warning';
}

export function requirementApplyExplanation(applyTo = '', status = '') {
    const applyKey = normalizeStatusKey(applyTo);
    const statusKey = normalizeStatusKey(status);
    if (statusKey === 'unsupported_by_solver' || applyKey === 'unsupported_by_solver') return '已经理解这条需求，但当前求解器暂不能自动执行；请保留为人工调课参考或等待能力扩展。';
    if (statusKey === 'understood_not_executable' || applyKey === 'understood_not_executable') return '已经理解这条需求，但暂未生成可自动执行的机器规则。';
    if (['partially_supported', 'partially_actionable', 'partially_executable'].includes(statusKey)
        || ['partially_supported', 'partially_actionable', 'partially_executable'].includes(applyKey)) {
        return '这条需求已经理解，其中一部分可自动执行，其余部分仍需复核或等待求解器能力扩展。';
    }
    if (statusKey === 'unsupported' || applyKey === 'unsupported') return '已经理解这条需求，但当前版本暂不能自动实现，可作为人工调课参考。';
    if (statusKey === 'needs_clarification' || applyKey === 'needs_clarification') return '已经识别到需求意图，但缺少必要信息，请补充后再应用。';
    if (statusKey === 'needs_review' || statusKey === 'review' || applyKey === 'review' || applyKey === 'needs_review') return '信息不全或没匹配到对象，补充后才能应用。';
    if (applyKey === 'lesson_plan' || applyKey === 'lesson_plans' || applyKey === 'lessonplan') return '应用后更新任课计划，例如连堂设置或课程安排参数。';
    if (applyKey === 'optimization' || applyKey === 'optimize') return '应用后写入优化目标，排课时会尽量满足。';
    if (applyKey === 'solver_policy' || applyKey === 'system_policy' || applyKey === 'handled') return '排课引擎本来就会保证这一点，无需应用。';
    if (applyKey === 'model_extension' || applyKey === 'complex_model') return '应用后写入复杂排课模型字段，仅在对应模型启用时生效。';
    return '应用后写入项目规则，下次排课必须或尽量遵守。';
}
export function semanticActionStatusLabel(action = {}) {
    const key = normalizeStatusKey(action.status || 'ready');
    return {
        ready: '可应用',
        actionable: '可应用',
        effective: '可应用',
        handled: '已处理',
        needs_review: '需复核',
        review: '需复核',
        skipped: '已跳过',
    }[key] || '待确认';
}
