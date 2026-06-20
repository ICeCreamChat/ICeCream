/**
 * timetable-v2 / api / mock / solution.sample.js
 *
 * 契约同形桩：字段对齐 Phase 2 solve() 返回（placements/unplaced/hardConflicts/softScore/stats）。
 * 网格只读这些字段渲染。纯静态，不含求解计算。
 */

// placements: [{ activityId, day, period, roomId, duration, weekPattern }]
export const sampleSolution = {
    placements: [
        { activityId: 'a1#0', subjectId: 's1', classIds: ['c1'], teacherIds: ['t1'], day: 1, period: 1, roomId: null, duration: 1, weekPattern: 'all' },
        { activityId: 'a1#1', subjectId: 's1', classIds: ['c1'], teacherIds: ['t1'], day: 2, period: 1, roomId: null, duration: 1, weekPattern: 'all' },
        { activityId: 'a1#2', subjectId: 's1', classIds: ['c1'], teacherIds: ['t1'], day: 3, period: 1, roomId: null, duration: 1, weekPattern: 'all' },
        { activityId: 'a1#3', subjectId: 's1', classIds: ['c1'], teacherIds: ['t1'], day: 4, period: 1, roomId: null, duration: 1, weekPattern: 'all' },
        { activityId: 'a1#4', subjectId: 's1', classIds: ['c1'], teacherIds: ['t1'], day: 5, period: 1, roomId: null, duration: 1, weekPattern: 'all' },
        { activityId: 'a2#0', subjectId: 's2', classIds: ['c1'], teacherIds: ['t2'], day: 1, period: 2, roomId: null, duration: 2, weekPattern: 'all' },
        { activityId: 'a2#1', subjectId: 's2', classIds: ['c1'], teacherIds: ['t2'], day: 2, period: 2, roomId: null, duration: 2, weekPattern: 'all' },
        { activityId: 'a3#0', subjectId: 's3', classIds: ['c2'], teacherIds: ['t3'], day: 1, period: 4, roomId: 'r1', duration: 1, weekPattern: 'all' },
        { activityId: 'a3#1', subjectId: 's3', classIds: ['c2'], teacherIds: ['t3'], day: 3, period: 4, roomId: 'r1', duration: 1, weekPattern: 'all' },
    ],
    unplaced: [],
    hardConflicts: [],
    softScore: 12.5,
    stats: { seed: 1, total: 9, placed: 9, unplaced: 0, improveAccepted: 3 },
};
