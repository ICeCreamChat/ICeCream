/**
 * timetable-v2 测试 fixtures：构造小样本项目。
 * 基础样本：2 班 / 3 教师 / 5 天 6 节；扩展含连堂、单双周、合班、固定课。
 */

/** 2 班 3 教师 6 节的基础合法项目。 */
export function baseProject() {
    return {
        id: 'p_base',
        name: '测试学校',
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [
            { id: 'c1', name: '一班', grade: '一年级' },
            { id: 'c2', name: '二班', grade: '一年级' },
        ],
        teachers: [
            { id: 't1', name: '张老师', subjects: ['s_math'] },
            { id: 't2', name: '李老师', subjects: ['s_chinese'] },
            { id: 't3', name: '王老师', subjects: ['s_pe'] },
        ],
        subjects: [
            { id: 's_math', name: '数学', category: 'main', priority: 95, tags: ['考试科目'], color: '#2563eb' },
            { id: 's_chinese', name: '语文', category: 'main', priority: 90, tags: [] },
            { id: 's_pe', name: '体育', category: 'quality', priority: 35, tags: [] },
        ],
        rooms: [
            { id: 'r1', name: '101', capacity: 50 },
            { id: 'r2', name: '操场', type: 'sport' },
        ],
        activityPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 's_math', teacherId: 't1', weeklyHours: 2, blockPreference: 'single' },
            { id: 'lp2', classId: 'c1', subjectId: 's_chinese', teacherId: 't2', weeklyHours: 2, blockPreference: 'single' },
            { id: 'lp3', classId: 'c2', subjectId: 's_math', teacherId: 't1', weeklyHours: 2, blockPreference: 'single' },
        ],
        constraints: [],
    };
}

/** 含连堂（double）的计划。 */
export function doubleBlockPlan() {
    return {
        id: 'lp_dbl', classId: 'c1', subjectId: 's_math', teacherId: 't1',
        weeklyHours: 3, blockPreference: 'double',
    };
}

/** 含合班 + 多教师的计划。 */
export function comboPlan() {
    return {
        id: 'lp_combo', classIds: ['c1', 'c2'], subjectId: 's_pe',
        teacherIds: ['t3', 't1'], weeklyHours: 1, blockPreference: 'single',
        allowedRoomIds: ['r2'],
    };
}

/** 含单双周的计划。 */
export function oddEvenPlan() {
    return {
        id: 'lp_oe', classId: 'c1', subjectId: 's_pe', teacherId: 't3',
        weeklyHours: 1, blockPreference: 'single', weekPattern: 'oddeven',
    };
}

// ---- Phase 2 求解器样本 ----

/** 适度规模的可解项目：2 班 3 教师 6 节，含连堂，总课时未超容量。 */
export function solvableProject() {
    return {
        id: 'p_solve',
        calendar: { weekdays: 5, periodsPerDay: 6 },
        classes: [{ id: 'c1' }, { id: 'c2' }],
        teachers: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        subjects: [
            { id: 's_m', name: '数学', category: 'main', priority: 95 },
            { id: 's_c', name: '语文', category: 'main', priority: 90 },
            { id: 's_p', name: '体育', category: 'quality', priority: 35 },
        ],
        rooms: [{ id: 'r1' }],
        activityPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 's_m', teacherId: 't1', weeklyHours: 4, blockPreference: 'single' },
            { id: 'lp2', classId: 'c1', subjectId: 's_c', teacherId: 't2', weeklyHours: 3, blockPreference: 'double' },
            { id: 'lp3', classId: 'c2', subjectId: 's_m', teacherId: 't1', weeklyHours: 4, blockPreference: 'single' },
            { id: 'lp4', classId: 'c2', subjectId: 's_p', teacherId: 't3', weeklyHours: 2, blockPreference: 'single' },
        ],
        constraints: [],
    };
}

/** 含教师不可用 + 固定课的可解项目。 */
export function projectWithUnavailableAndLocked() {
    const p = solvableProject();
    p.constraints = [
        { type: 'teacher_unavailable', target: { teacherId: 't1' }, params: { slots: ['1-1', '1-2', '2-1'] } },
        { type: 'fixed_locked', target: { activityId: 'lp4#0' }, params: { slot: '3-5' } },
    ];
    return p;
}

/** 不可解项目：教师 t1 几乎全时段不可用，但要排 8 节课。 */
export function unsolvableProject() {
    const cal = { weekdays: 5, periodsPerDay: 6 };
    // 让 t1 只剩 1 个可用时段，却要排 8 节
    const slots = [];
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= 6; p++) if (!(d === 5 && p === 6)) slots.push(`${d}-${p}`);
    return {
        id: 'p_unsolve',
        calendar: cal,
        classes: [{ id: 'c1' }],
        teachers: [{ id: 't1' }],
        subjects: [{ id: 's_m', name: '数学', category: 'main', priority: 95 }],
        rooms: [],
        activityPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's_m', teacherId: 't1', weeklyHours: 8, blockPreference: 'single' }],
        constraints: [{ type: 'teacher_unavailable', target: { teacherId: 't1' }, params: { slots } }],
    };
}

/** 含主科上午软约束的项目（验证软约束 pressure 生效）。 */
export function projectWithSoftConstraints() {
    const p = solvableProject();
    p.constraints = [
        { type: 'morning_subjects', weight: 60, params: { subjectIds: ['s_m', 's_c'], morningPeriods: 3 } },
        { type: 'spread_subjects', weight: 40, params: { subjectIds: ['s_m'] } },
    ];
    return p;
}

/** 性能基线：30 班 / 60 教师 / 约 800 lesson cells。 */
export function benchmarkProject() {
    const classes = Array.from({ length: 30 }, (_, i) => ({ id: `c${i + 1}` }));
    const teachers = Array.from({ length: 60 }, (_, i) => ({ id: `t${i + 1}` }));
    const subjects = [
        { id: 's_m', name: '数学', category: 'main', priority: 95 },
        { id: 's_c', name: '语文', category: 'main', priority: 90 },
        { id: 's_e', name: '英语', category: 'main', priority: 88 },
        { id: 's_p', name: '体育', category: 'quality', priority: 35 },
        { id: 's_a', name: '艺术', category: 'quality', priority: 30 },
    ];
    // 每班 5 科，周课时合计约 27 节 → 30 班 ≈ 810 cells
    const hoursBySubject = { s_m: 7, s_c: 7, s_e: 6, s_p: 4, s_a: 3 };
    const activityPlans = [];
    let lp = 0;
    classes.forEach((c, ci) => {
        subjects.forEach((s, si) => {
            // 教师轮转分配，避免单教师过载
            const teacher = teachers[(ci * subjects.length + si) % teachers.length];
            activityPlans.push({
                id: `lp${++lp}`, classId: c.id, subjectId: s.id, teacherId: teacher.id,
                weeklyHours: hoursBySubject[s.id], blockPreference: si < 3 ? 'single' : 'single',
            });
        });
    });
    return {
        id: 'p_bench',
        calendar: { weekdays: 5, periodsPerDay: 8 }, // 40 时段/周
        classes, teachers, subjects, rooms: [],
        activityPlans, constraints: [],
    };
}
