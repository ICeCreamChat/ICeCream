import {
    getTimetableEntityMaps,
    normalizeTimetableProject,
    slotTeacherIds,
} from './timetable-project.js';

function result(ok, reason, message, details = {}) {
    return { ok, reason, message, details };
}

export function validateTimetableProjectForSolve(input = {}) {
    const project = normalizeTimetableProject(input);
    const maps = getTimetableEntityMaps(project);

    if (!project.lessonPlans.length) {
        return result(false, 'missing_lesson_plans', '请先导入任课数据，再生成课表。');
    }
    if (!project.classes.length) {
        return result(false, 'missing_classes', '任课数据里没有班级。');
    }
    if (!project.teachers.length) {
        return result(false, 'missing_teachers', '任课数据里没有教师。');
    }
    if (!project.subjects.length) {
        return result(false, 'missing_subjects', '任课数据里没有课程。');
    }

    const invalidPlans = project.lessonPlans.filter(plan => (
        !maps.classes.has(plan.classId)
        || !maps.subjects.has(plan.subjectId)
        || !slotTeacherIds(plan).every(teacherId => maps.teachers.has(teacherId))
    ));
    if (invalidPlans.length) {
        return result(false, 'invalid_lesson_plan_refs', '任课数据引用了不存在的班级、课程或教师。', {
            lessonPlanIds: invalidPlans.map(plan => plan.id),
        });
    }

    const totalLessons = project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0);
    const classCapacity = project.weekdays * project.periodsPerDay * project.classes.length;
    if (totalLessons > classCapacity) {
        return result(false, 'insufficient_slots', '总课时超过当前作息容量，请增加天数/节次或减少课时。', {
            totalLessons,
            classCapacity,
        });
    }

    return result(true, 'ready', '排课数据已就绪。', {
        totalLessons,
    });
}
