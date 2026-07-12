const ENTITY_KINDS = ['teachers', 'classes', 'subjects', 'lessonPlans'];

function list(value) {
    return Array.isArray(value) ? value : [];
}

export function assessConstraintParseReadiness(project = {}) {
    const missing = ENTITY_KINDS.filter(key => list(project[key]).length === 0);
    const teacherIds = new Set(list(project.teachers).map(item => item?.id).filter(Boolean));
    const classIds = new Set(list(project.classes).map(item => item?.id).filter(Boolean));
    const subjectIds = new Set(list(project.subjects).map(item => item?.id).filter(Boolean));
    const invalidLessonPlans = list(project.lessonPlans)
        .filter(plan => {
            const planTeacherIds = list(plan?.teacherIds?.length ? plan.teacherIds : [plan?.teacherId]).filter(Boolean);
            return !plan?.id
                || !classIds.has(plan.classId)
                || !subjectIds.has(plan.subjectId)
                || planTeacherIds.length === 0
                || !planTeacherIds.every(id => teacherIds.has(id));
        })
        .map(plan => plan?.id || '')
        .filter(Boolean);
    const ready = missing.length === 0 && invalidLessonPlans.length === 0;
    return {
        ready,
        reason: ready ? '' : 'roster_required',
        missing,
        invalidLessonPlans,
        counts: Object.fromEntries(ENTITY_KINDS.map(key => [key, list(project[key]).length])),
        rosterImport: {
            previewEndpoint: '/api/tools/timetable/roster/preview',
            importEndpoint: '/api/tools/timetable/roster/import',
        },
    };
}

export function createRosterRequiredError(readiness) {
    const error = new Error('请先导入完整任课数据，再解析智能约束。');
    error.reason = 'roster_required';
    error.status = 409;
    error.readiness = readiness;
    return error;
}
