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
    const execution = normalizeStatusKey(item.executionStatus || '');
    const understanding = normalizeStatusKey(item.understandingStatus || '');
    if (execution === 'blocked_by_reference' || understanding === 'invalid_reference') return '已理解，待绑定对象';
    if (execution === 'blocked_by_clarification' || ['ambiguous', 'partially_parsed'].includes(understanding)) return '已理解，待补充';
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
        blocked_by_reference: '已理解，待绑定对象',
        blocked_by_clarification: '已理解，待补充',
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
        blocked_by_reference: '⚠ 待绑定对象',
        blocked_by_clarification: '⚠ 待补充信息',
        understood_not_executable: '○ 已理解，暂不可执行',
        unsupported_by_solver: '○ 求解器暂不支持',
        unsupported: '○ 暂不可执行',
    }[key] || (/[A-Za-z_]/.test(String(applyTo || '')) ? '⚠ 待你确认' : applyTo || '⚠ 待你确认');
}

export function requirementApplyTone(applyTo = '', status = '') {
    const applyKey = normalizeStatusKey(applyTo);
    const statusKey = normalizeStatusKey(status);
    const clarificationKeys = new Set(['needs_clarification', 'needs_review', 'review', 'blocked_by_reference', 'blocked_by_clarification']);
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
    if (statusKey === 'blocked_by_reference' || applyKey === 'blocked_by_reference') return '需求已经理解，但项目中尚未绑定对应教师、班级、学科或教室；确认现有对象后即可重新编译。';
    if (statusKey === 'blocked_by_clarification' || applyKey === 'blocked_by_clarification') return '需求已经理解，但缺少必要参数、作息范围或课程活动属性；补充后即可重新编译。';
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
