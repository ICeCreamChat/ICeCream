import { createDefaultTimetableProject } from '../../gateway/services/timetable-scheduler.js';

function mulberry32(seed) {
    let state = (Number(seed) >>> 0) || 1;
    return () => {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function range(count, start = 1) {
    return Array.from({ length: count }, (_, index) => index + start);
}

/**
 * Build a small, name-agnostic timetable model for solver tests.
 * Options intentionally vary the shape instead of encoding a school fixture.
 */
export function createSyntheticTimetableProject({
    seed = 1,
    weekdays = 4,
    periodsPerDay = 5,
    classCount = 3,
    subjectCount = 3,
    teacherCount = classCount * 2,
    includeBlocks = true,
    includeRooms = false,
    includeLocks = false,
} = {}) {
    const random = mulberry32(seed);
    const activeWeekdays = range(Math.max(1, weekdays));
    const activePeriods = range(Math.max(2, periodsPerDay));
    const classes = range(Math.max(1, classCount)).map(index => ({
        id: `class_${index}`,
        grade: `grade_${1 + (index % 3)}`,
        name: `group_${index}`,
    }));
    const subjects = range(Math.max(1, subjectCount)).map(index => ({
        id: `subject_${index}`,
        name: `Course ${index}`,
        category: 'normal',
        priority: 50,
    }));
    const teachers = range(Math.max(1, teacherCount)).map(index => ({
        id: `teacher_${index}`,
        name: `Instructor ${index}`,
        subjects: [],
        unavailableSlots: [],
    }));
    const lessonPlans = [];
    let planIndex = 0;
    classes.forEach((klass, classIndex) => {
        const planCount = Math.min(subjects.length, 2 + (classIndex % Math.max(1, subjects.length - 1)));
        for (let offset = 0; offset < planCount; offset += 1) {
            const subject = subjects[(classIndex + offset + Math.floor(random() * subjects.length)) % subjects.length];
            const teacher = teachers[(classIndex * 2 + offset) % teachers.length];
            if (!teacher.subjects.includes(subject.id)) teacher.subjects.push(subject.id);
            const canBlock = includeBlocks && periodsPerDay >= 3 && offset === 0;
            lessonPlans.push({
                id: `plan_${++planIndex}`,
                classId: klass.id,
                subjectId: subject.id,
                teacherId: teacher.id,
                teacherIds: [teacher.id],
                weeklyHours: canBlock ? 2 : 1 + ((classIndex + offset) % 2),
                blockPreference: canBlock ? 'double' : 'single',
            });
        }
    });

    const rooms = includeRooms
        ? [{ id: 'room_shared', name: 'Resource 1', tags: [] }]
        : [];
    const rules = {
        hardRules: {
            lockedSlots: [],
            teacherUnavailable: {},
            classUnavailable: {},
            globalUnavailable: [],
            roomRequirements: includeRooms ? { [subjects[0].id]: { roomIds: ['room_shared'] } } : {},
        },
        softRules: {},
    };
    if (includeLocks && lessonPlans.length) {
        const plan = lessonPlans[0];
        rules.hardRules.lockedSlots.push({
            id: 'fixed_1',
            day: activeWeekdays[0],
            period: activePeriods[0],
            lessonPlanId: plan.id,
            classId: plan.classId,
            subjectId: plan.subjectId,
            teacherId: plan.teacherId,
        });
    }

    return createDefaultTimetableProject({
        id: `synthetic_${seed}`,
        version: seed,
        schoolName: 'Synthetic Scheduling Project',
        weekdays: activeWeekdays.length,
        periodsPerDay: activePeriods.length,
        activeWeekdays,
        activePeriods,
        classes,
        subjects,
        teachers,
        rooms,
        lessonPlans,
        rules,
        schedule: null,
    });
}

export function makeSyntheticInfeasibleProject(options = {}) {
    const project = createSyntheticTimetableProject({
        weekdays: 1,
        periodsPerDay: 2,
        classCount: 1,
        subjectCount: 1,
        teacherCount: 1,
        includeBlocks: true,
        ...options,
    });
    const plan = project.lessonPlans[0];
    project.rules.hardRules.classUnavailable[plan.classId] = project.activeWeekdays.flatMap(day =>
        project.activePeriods.map(period => `${day}-${period}`),
    );
    return project;
}
