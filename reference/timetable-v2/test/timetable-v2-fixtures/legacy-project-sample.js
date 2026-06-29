/**
 * 旧 ICeCream 项目导入器测试样本（Phase 3）。
 *
 * 覆盖：各 blockPreference 枚举（含非法值）、各 subject category、完整 hardRules/softRules、
 * schedule.slots 含一个连堂块（blockId + blockSize=2 的两 slot）+ 单格、
 * schedule.published 含 history[]（嵌套 snapshot.projectContext + slots）+ 一条损坏历史。
 *
 * 注意：schedule.slots 的已排格刻意设计为互不冲突（不同班级/教师/时间），
 * 以便 locked reference 门禁（detectHardConflicts 应为零）成立。
 */

export function legacyProjectSample() {
    return {
        id: 'legacy_demo',
        schoolName: '示例小学',
        term: '2026 秋',
        weekdays: 5,
        periodsPerDay: 6,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6],
        periodTimes: [
            { period: 1, start: '08:00', end: '08:40' },
            { period: 2, start: '08:50', end: '09:30' },
        ],

        classes: [
            { id: 'c1', grade: '一年级', name: '一班' },
            { id: 'c2', grade: '一年级', name: '二班' },
        ],

        teachers: [
            { id: 't1', name: '张老师', subjects: ['s_math'], unavailableSlots: [] },
            { id: 't2', name: '李老师', subjects: ['s_sci'], unavailableSlots: ['5-4'] },
            { id: 't3', name: '王老师', subjects: ['s_pe'], unavailableSlots: [] },
        ],

        subjects: [
            { id: 's_math', name: '数学', category: 'main', priority: 95, tags: ['考试'], color: '#2563eb' },
            { id: 's_pe', name: '体育', category: 'quality', priority: 35, tags: [] },
            { id: 's_sci', name: '科学实验', category: 'lab', priority: 60, tags: [] },
            { id: 's_other', name: '班会', category: 'normal', priority: 50, tags: [] },
            // 非枚举 category → 降级为 normal
            { id: 's_weird', name: '神秘课', category: 'mystery', priority: 40, tags: [] },
        ],

        lessonPlans: [
            // single + roomId
            { id: 'lp1', classId: 'c1', subjectId: 's_math', teacherId: 't1', weeklyHours: 2, blockPreference: 'single', roomId: 'r1' },
            // double + allowedRoomIds
            { id: 'lp2', classId: 'c1', subjectId: 's_pe', teacherId: 't3', weeklyHours: 2, blockPreference: 'double', allowedRoomIds: ['r2'] },
            // mixed
            { id: 'lp3', classId: 'c2', subjectId: 's_sci', teacherId: 't2', weeklyHours: 3, blockPreference: 'mixed' },
            // 非枚举 blockPreference → 降级 single
            { id: 'lp4', classId: 'c1', subjectId: 's_other', teacherId: 't1', weeklyHours: 1, blockPreference: 'quad' },
            // 多教师：teacherId + teacherIds[] 合并去重
            { id: 'lp_multi', classId: 'c2', subjectId: 's_math', teacherId: 't1', teacherIds: ['t1', 't2'], weeklyHours: 1, blockPreference: 'single' },
        ],

        rules: {
            hardRules: {
                lockedSlots: [
                    { id: 'lock1', day: 4, period: 1, classId: 'c1', subjectId: 's_math', teacherId: 't1', lessonPlanId: 'lp1', roomId: 'r1' },
                    // 悬空 fixed_locked：lessonPlanId 指向不存在的计划 → dropped，不发约束
                    { id: 'lock_ghost', day: 4, period: 3, classId: 'c1', subjectId: 's_math', teacherId: 't1', lessonPlanId: 'lp_ghost' },
                ],
                teacherUnavailable: { t1: ['5-6'] },
                classUnavailable: { c2: ['5-5'] },
            },
            softRules: {
                morningSubjects: ['s_math'],
                subjectPreferredPeriods: { s_sci: { prefer: ['1-5'], avoid: ['1-1'], weight: 30 } },
                teacherLimits: { t1: { daily: 4, consecutive: 2 } },
                spreadSubjects: ['s_math'],
                balancedTeacherLoad: true,
            },
        },

        schedule: {
            id: 'sched_demo',
            generatedAt: '2026-06-01T00:00:00.000Z',
            source: 'manual',
            slots: [
                // 连堂块：blockId b1, blockSize 2, day1 period1-2, c1/s_math/t1
                { id: 'slot_b1_0', day: 1, period: 1, classId: 'c1', subjectId: 's_math', teacherId: 't1', roomId: 'r1', blockId: 'b1', blockIndex: 0, blockSize: 2, locked: true },
                { id: 'slot_b1_1', day: 1, period: 2, classId: 'c1', subjectId: 's_math', teacherId: 't1', roomId: 'r1', blockId: 'b1', blockIndex: 1, blockSize: 2, locked: true },
                // 单格：c1/s_pe/t3 day2 period1（blockId 空）
                { id: 'slot_s1', day: 2, period: 1, classId: 'c1', subjectId: 's_pe', teacherId: 't3', roomId: 'r2', blockId: null, blockIndex: 0, blockSize: 1, locked: true },
                // 单格：c2/s_sci/t2 day3 period1
                { id: 'slot_s2', day: 3, period: 1, classId: 'c2', subjectId: 's_sci', teacherId: 't2', blockId: '', blockIndex: 0, blockSize: 1 },
                // blockSize=3 连堂块：blockId b2, day5 period1-3, c2/s_sci/t2（V2 durationPattern 无法表达 3 节连堂 → 降级，逐节独立锁定）
                { id: 'slot_b2_0', day: 5, period: 1, classId: 'c2', subjectId: 's_sci', teacherId: 't2', roomId: 'r2', blockId: 'b2', blockIndex: 0, blockSize: 3, locked: true },
                { id: 'slot_b2_1', day: 5, period: 2, classId: 'c2', subjectId: 's_sci', teacherId: 't2', roomId: 'r2', blockId: 'b2', blockIndex: 1, blockSize: 3, locked: true },
                { id: 'slot_b2_2', day: 5, period: 3, classId: 'c2', subjectId: 's_sci', teacherId: 't2', roomId: 'r2', blockId: 'b2', blockIndex: 2, blockSize: 3, locked: true },
            ],
            published: {
                status: 'published',
                version: 2,
                publishedAt: '2026-05-20T08:00:00.000Z',
                scheduleId: 'sched_demo',
                note: '正式发布 v2',
                fingerprint: 'fp_v2',
                snapshot: {
                    scheduleId: 'sched_demo',
                    generatedAt: '2026-05-20T08:00:00.000Z',
                    slots: [{ id: 'snap_v2_1', day: 1, period: 1, classId: 'c1', subjectId: 's_math', teacherId: 't1' }],
                },
                history: [
                    {
                        version: 1,
                        publishedAt: '2026-05-01T08:00:00.000Z',
                        scheduleId: 'sched_demo',
                        note: '首版',
                        fingerprint: 'fp_v1',
                        snapshot: {
                            scheduleId: 'sched_demo',
                            projectContext: {
                                schoolName: '示例小学',
                                term: '2026 秋',
                                weekdays: 5,
                                periodsPerDay: 6,
                                activeWeekdays: [1, 2, 3, 4, 5],
                                activePeriods: [1, 2, 3, 4, 5, 6],
                                teachers: [{ id: 't1', name: '张老师' }],
                                classes: [{ id: 'c1', grade: '一年级', name: '一班' }],
                                subjects: [{ id: 's_math', name: '数学', category: 'main', priority: 95 }],
                                lessonPlans: [{ id: 'lp1', classId: 'c1', subjectId: 's_math', teacherId: 't1', weeklyHours: 2 }],
                            },
                            slots: [{ id: 'snap_v1_1', day: 1, period: 2, classId: 'c1', subjectId: 's_math', teacherId: 't1' }],
                        },
                    },
                    // 损坏历史：缺 snapshot → degraded
                    { version: 0, note: '损坏快照' },
                ],
            },
        },
    };
}
