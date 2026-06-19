/**
 * 水晶 cloneSeed 样本（Phase 3 crystal-mapping 测试用）。
 * 覆盖：合法 schema、selectedClassIds、courses、classCourseSections、合班、
 * presets status 1/2/3、hardForbids + 软上下限、PaiOpt 五开关、触发 review 的不明规则。
 */

export function crystalCloneSeedSample() {
    return {
        schema: 'icecream-scheduler-clone-seed',
        schemaVersion: 1,
        selectedClassIds: ['1', '2', '3'],
        keJie: {
            classGroups: [
                { id: '1', name: '高一(1)班' },
                { id: '2', name: '高一(2)班' },
                { id: '3', name: '高一(3)班' },
            ],
        },
        courses: [
            { id: '10', name: '语文' },
            { id: '11', name: '数学' },
            { id: '12', name: '物理实验', lianpai: 1, roomid: '101' }, // M-5：连堂 + 固定实验室
        ],
        rooms: [
            { id: '100', name: '普通教室1', roomsize: 50 },
            { id: '101', name: '物理实验室', roomsize: 40 },
        ],
        classCourseSections: [
            { classId: '1', courseId: '10', teacherId: '20', jieshu: 4 },
            { classId: '1', courseId: '11', teacherId: '21', jieshu: 5 },
            { classId: '2', courseId: '10', teacherId: '20', jieshu: 4 },
            { classId: '3', courseId: '12', teacherId: '22', jieshu: 2 },
            // 坏行：缺课时 → dropped
            { classId: '2', courseId: '11', teacherId: '21' },
        ],
        relationGroups: [
            // 合班：高一(1)(2) 一起上物理实验
            { classIds: ['1', '2'], courseId: '12', teacherId: '22', jieshu: 2 },
        ],
        presets: {
            course: [
                { id: 'pc1', classId: '1', courseId: '10', status: 1, day: 1, period: 1 }, // 弱偏好 → soft
                { id: 'pc2', classId: '0', courseId: '11', status: 3, day: 2, period: 7 }, // 全班硬禁 → review(appliesToAllClasses)
                { id: 'pc3', classId: '1', courseId: '10', status: 3, day: 3, period: 5 }, // M-2：课程@具体班级硬禁 → review（不再 class_unavailable）
            ],
            teacher: [
                { id: 'pt1', teacherId: '20', status: 2, day: 1, period: 2 }, // 强偏好 → soft
                { id: 'pt2', teacherId: '21', status: 3, day: 3, period: 1 }, // 硬禁 → teacher_unavailable
            ],
        },
        constraints: {
            hardForbids: [
                { optId: 'hf1', target: 'teacher', teacherId: '22', day: 5, period: 6 }, // → teacher_unavailable
                { optId: 'hf2', target: 'classCourse', classId: '3', day: 4, period: 8 }, // M-2：课程@班级硬禁 → review（不再 class_unavailable）
            ],
            periodRules: [
                { optId: 'pr1', target: 'teacher', teacherId: '20', limit: { mode: 'max', value: 3 }, time: { period: 1 } }, // soft
                { optId: 'pr2', target: 'classCourse', classId: '1', courseId: '10', limit: { mode: 'min', value: 1 }, time: { segment: 'morning' } }, // soft
                { optId: 'pr3', target: 'teacher', teacherId: '21', limit: { mode: 'unknownmode' }, time: {} }, // → review
            ],
            dayRules: [],
            // C-1：三个关系数组，V2 无对应 type，应逐条进 review
            teacherMutualExclusion: [
                { teacherA: '20', teacherB: '21' }, // 教师互斥（teaman/teawife）
            ],
            courseXorPairs: [
                { courseA: '10', courseB: '11' }, // 课程互斥（KemuXorBd）
            ],
            courseNearPairs: [
                { courseA: '11', courseB: '12' }, // 课程临近偏好（KemuNearBd）
            ],
        },
        options: {
            schedulingStrength: { item: 'schedulingStrength', value: 2, mode: 'normal', workLimit: 2000 },
            sameGradeProgress: { item: 'sameGradeProgress', value: 1, mode: 'pressure' },
            teacherDaySegment: { item: 'teacherDaySegment', value: 3, mode: 'any' },
            sameCourseAdjacency: { item: 'sameCourseAdjacency', value: 3, mode: 'prefer-adjacent' },
            teacherNoonBoundary: { item: 'teacherNoonBoundary', value: 2, mode: 'avoid' },
        },
        consistency: { warnings: [{ message: '样本：room 100 容量未在 golden 中验证' }] },
    };
}
