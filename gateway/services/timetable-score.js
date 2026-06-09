import {
    getActivePeriods,
    getActiveWeekdays,
    slotTeacherIds,
} from './timetable-project.js';

function isMorningPeriod(activePeriods, period) {
    const morning = new Set(activePeriods.slice(0, Math.max(1, Math.ceil(activePeriods.length / 2))));
    return morning.has(Number(period));
}

function variance(values = []) {
    if (values.length <= 1) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function ratio(hit, total) {
    return total > 0 ? hit / total : 1;
}

/**
 * Evaluate how well the placed slots satisfy the project's SOFT rules.
 * Returns a 0–100 satisfaction score plus a per-dimension breakdown so the UI
 * and the optimization comparison can reason about real quality rather than a
 * flat "no conflicts => 100".
 */
export function evaluateSoftScore(project, slots = []) {
    const activePeriods = getActivePeriods(project);
    const activeWeekdays = getActiveWeekdays(project);
    const softRules = project.rules?.softRules || {};
    const subjectMap = new Map((project.subjects || []).map(subject => [subject.id, subject]));
    const morningSubjects = new Set(softRules.morningSubjects || []);
    const preferred = softRules.subjectPreferredPeriods || {};
    const teacherLimits = softRules.teacherLimits || {};
    const spreadSubjects = new Set(softRules.spreadSubjects || []);
    const balanceTeacherLoad = softRules.balancedTeacherLoad !== false;

    const breakdown = {};
    const dimensions = [];
    const addDimension = (key, weight, value) => {
        const score = Math.max(0, Math.min(1, value));
        breakdown[key] = Math.round(score * 100);
        dimensions.push({ weight, score });
    };

    // 1. Morning subjects / 主科上午命中率
    let morningTotal = 0;
    let morningHit = 0;
    for (const slot of slots) {
        const subject = subjectMap.get(slot.subjectId);
        const isMorningSubject = morningSubjects.has(slot.subjectId)
            || /语文|数学|英语|外语/.test(subject?.name || '');
        if (!isMorningSubject) continue;
        morningTotal += 1;
        if (isMorningPeriod(activePeriods, slot.period)) morningHit += 1;
    }
    if (morningTotal > 0) addDimension('morningSubjects', 3, ratio(morningHit, morningTotal));

    // 2. Subject preferred / avoided periods
    let prefTotal = 0;
    let prefHit = 0;
    for (const slot of slots) {
        const rule = preferred[slot.subjectId];
        if (!rule) continue;
        const key = `${slot.day}-${slot.period}`;
        if ((rule.prefer || []).length) {
            prefTotal += 1;
            if (rule.prefer.includes(key)) prefHit += 1;
        }
        if ((rule.avoid || []).includes(key)) {
            prefTotal += 1; // an avoided placement counts as a miss
        }
    }
    if (prefTotal > 0) addDimension('preferredPeriods', 2, ratio(prefHit, prefTotal));

    // 3. Teacher daily load balance (lower variance => better)
    if (balanceTeacherLoad) {
        const teacherDayCount = new Map();
        for (const slot of slots) {
            for (const teacherId of slotTeacherIds(slot)) {
                const k = `${teacherId}:${slot.day}`;
                teacherDayCount.set(k, (teacherDayCount.get(k) || 0) + 1);
            }
        }
        const teacherTotals = new Map();
        for (const [k, count] of teacherDayCount) {
            const teacherId = k.split(':')[0];
            if (!teacherTotals.has(teacherId)) teacherTotals.set(teacherId, []);
            teacherTotals.get(teacherId).push(count);
        }
        const variances = [];
        for (const counts of teacherTotals.values()) {
            // pad with zero-days so an unevenly clustered teacher is penalised
            while (counts.length < activeWeekdays.length) counts.push(0);
            variances.push(variance(counts));
        }
        if (variances.length) {
            const avgVariance = variances.reduce((sum, value) => sum + value, 0) / variances.length;
            // map variance 0 -> 1.0, variance >= 4 -> 0
            addDimension('teacherBalance', 2, 1 - Math.min(1, avgVariance / 4));
        }
    }

    // 4. Teacher daily / consecutive limits
    if (Object.keys(teacherLimits).length) {
        let limitChecks = 0;
        let limitHits = 0;
        const teacherDaySlots = new Map();
        for (const slot of slots) {
            for (const teacherId of slotTeacherIds(slot)) {
                const k = `${teacherId}:${slot.day}`;
                if (!teacherDaySlots.has(k)) teacherDaySlots.set(k, []);
                teacherDaySlots.get(k).push(Number(slot.period));
            }
        }
        for (const [teacherId, limit] of Object.entries(teacherLimits)) {
            for (const day of activeWeekdays) {
                const periods = (teacherDaySlots.get(`${teacherId}:${day}`) || []).sort((a, b) => a - b);
                if (Number.isInteger(limit.daily)) {
                    limitChecks += 1;
                    if (periods.length <= limit.daily) limitHits += 1;
                }
                if (Number.isInteger(limit.consecutive)) {
                    limitChecks += 1;
                    let maxRun = 0;
                    let run = 0;
                    let prev = null;
                    for (const period of periods) {
                        run = prev !== null && period === prev + 1 ? run + 1 : 1;
                        maxRun = Math.max(maxRun, run);
                        prev = period;
                    }
                    if (maxRun <= limit.consecutive) limitHits += 1;
                }
            }
        }
        if (limitChecks > 0) addDimension('teacherLimits', 2, ratio(limitHits, limitChecks));
    }

    // 5. Same-subject spread (avoid stacking the same subject on one day for a class)
    const classSubjectDay = new Map();
    for (const slot of slots) {
        const k = `${slot.classId}:${slot.subjectId}:${slot.day}`;
        classSubjectDay.set(k, (classSubjectDay.get(k) || 0) + 1);
    }
    let spreadChecks = 0;
    let spreadHits = 0;
    for (const [k, count] of classSubjectDay) {
        const subjectId = k.split(':')[1];
        // block lessons legitimately occupy 2 consecutive periods; >2 same-day is a stack
        const limit = spreadSubjects.has(subjectId) ? 1 : 2;
        spreadChecks += 1;
        if (count <= limit) spreadHits += 1;
    }
    if (spreadChecks > 0) addDimension('subjectSpread', 1, ratio(spreadHits, spreadChecks));

    if (!dimensions.length) {
        return { score: 100, breakdown };
    }
    const totalWeight = dimensions.reduce((sum, dim) => sum + dim.weight, 0);
    const weighted = dimensions.reduce((sum, dim) => sum + dim.weight * dim.score, 0);
    return { score: Math.round((weighted / totalWeight) * 100), breakdown };
}

export function buildTimetableScore(project, slots, unplaced, conflicts) {
    const totalLessons = project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0);
    const placedLessons = slots.length;
    const hardConflicts = conflicts.filter(conflict => conflict.severity === 'hard').length;
    const completeness = totalLessons ? Math.round((placedLessons / totalLessons) * 100) : 0;
    const soft = evaluateSoftScore(project, slots);
    // softScore now reflects real soft-rule satisfaction, but a schedule with
    // hard conflicts or unplaced lessons must never out-rank a clean one.
    const penalty = unplaced.length * 12 + hardConflicts * 20;
    const softScore = Math.max(0, Math.round(soft.score - penalty));
    return {
        hardConflicts,
        softScore,
        softSatisfaction: soft.score,
        softBreakdown: soft.breakdown,
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
