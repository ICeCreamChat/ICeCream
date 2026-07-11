const NUMBER_TOKEN_PATTERN = '[0-9一二两三四五六七八九十零〇]{1,4}';

const MARKET_LANGUAGE_RULES = [
    [/週/g, '周', 'traditional_week'], [/禮拜/g, '礼拜', 'traditional_weekday'],
    [/笫/g, '第', 'ordinal_typo'], [/節/g, '节', 'traditional_period'],
    [/堂課/g, '堂课', 'traditional_lesson'], [/沒/g, '没', 'traditional_negation'],
    [/課/g, '课', 'traditional_course'], [/老師/g, '老师', 'traditional_teacher'],
    [/教師/g, '教师', 'traditional_teacher_title'], [/[儘盡]/g, '尽', 'traditional_preference'],
    [/優先/g, '优先', 'traditional_priority'], [/張/g, '张', 'traditional_surname'],
    [/無法/g, '无法', 'traditional_unavailable'], [/數學/g, '数学', 'traditional_math'],
    [/英語/g, '英语', 'traditional_english'], [/實驗室/g, '实验室', 'traditional_lab'],
    [/實驗/g, '实验', 'traditional_experiment'], [/必須/g, '必须', 'traditional_required'],
    [/同壹天/g, '同一天', 'financial_numeral_day'], [/壹周/g, '一周', 'financial_numeral_week'],
    [/周叁/g, '周三', 'homophone_weekday'], [/第[—–－-]节/g, '第一节', 'dash_ordinal_one'],
    [/体肓(?=课|学科|$)/g, '体育', 'bounded_pe_typo'], [/物里(?=实验|课|学科|$)/g, '物理', 'bounded_physics_typo'],
    [/头一堂(?:课)?/g, '第一节', 'first_lesson_alias'], [/收尾那节/g, '最后一节', 'last_period_alias'],
    [/黄金段/g, '黄金时段', 'golden_period_alias'], [/大连堂/g, '连排两节', 'school_block_alias'],
    [/音体美信/g, '音乐、体育、美术、信息技术', 'school_subject_group_alias'],
    [/物化生/g, '物理、化学、生物', 'school_science_group_alias'],
    [/集备/g, '集体备课', 'school_collective_planning_alias'],
    [/塞课/g, '排课', 'colloquial_schedule_alias'], [/往(上午|下午)搁/g, '排在$1', 'colloquial_place_alias'],
    [/压在/g, '排在', 'colloquial_place_alias'], [/摊开点排/g, '分散排', 'colloquial_spread_alias'],
    [/别扎堆/g, '尽量分散', 'colloquial_spread_alias'],
];

export function normalizeTimetableMarketTextWithTrace(value = '') {
    const rawText = String(value ?? '');
    let shadow = rawText.normalize('NFKC');
    const trace = [];
    if (shadow !== rawText) trace.push({ rule: 'unicode_nfkc', from: rawText, to: shadow });
    for (const [pattern, replacement, rule] of MARKET_LANGUAGE_RULES) {
        const before = shadow;
        shadow = shadow.replace(pattern, replacement);
        if (shadow !== before) trace.push({ rule, from: before, to: shadow });
    }
    const lessonAliasPattern = new RegExp(`(第?\\s*${NUMBER_TOKEN_PATTERN}\\s*)堂(?:课)?`, 'g');
    const beforeLessonAlias = shadow;
    shadow = shadow.replace(lessonAliasPattern, '$1节');
    if (shadow !== beforeLessonAlias) trace.push({ rule: 'lesson_counter_alias', from: beforeLessonAlias, to: shadow });
    return { text: shadow, trace };
}

export function normalizeTimetableMarketText(value = '') {
    return normalizeTimetableMarketTextWithTrace(value).text;
}
