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
