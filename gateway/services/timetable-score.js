export function buildTimetableScore(project, slots, unplaced, conflicts) {
    const totalLessons = project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0);
    const placedLessons = slots.length;
    const hardConflicts = conflicts.filter(conflict => conflict.severity === 'hard').length;
    const completeness = totalLessons ? Math.round((placedLessons / totalLessons) * 100) : 0;
    const softScore = Math.max(0, 100 - unplaced.length * 12 - hardConflicts * 20);
    return {
        hardConflicts,
        softScore,
        placedLessons,
        totalLessons,
        unplacedLessons: unplaced.length,
        completeness,
    };
}

export function buildUnplacedConflicts(unplaced = []) {
    return unplaced.map(item => ({
        type: 'unplaced',
        severity: 'hard',
        message: item.reason,
        lessonPlanId: item.lessonPlanId,
        classId: item.classId,
        subjectId: item.subjectId,
        teacherId: item.teacherId,
    }));
}
