import {
    addUsage,
    canUseSlot,
    createTimetableUsage,
    detectScheduleConflicts,
} from './timetable-conflicts.js';
import {
    getTimetableEntityMaps,
    normalizeTimetableProject,
    slotTeacherIds,
} from './timetable-project.js';
import {
    buildTimetableScore,
    buildUnplacedConflicts,
} from './timetable-score.js';

function isMorning(project, period) {
    return period <= Math.max(1, Math.ceil(project.periodsPerDay / 2));
}

function blockFits(project, usage, task, day, period) {
    for (let offset = 0; offset < task.blockSize; offset++) {
        const check = canUseSlot(project, usage, {
            ...task,
            day,
            period: period + offset,
        });
        if (!check.ok) return check;
    }
    return { ok: true };
}

function getCandidateBlocks(project, usage, task) {
    const candidates = [];
    for (let day = 1; day <= project.weekdays; day++) {
        for (let period = 1; period <= project.periodsPerDay - task.blockSize + 1; period++) {
            const check = blockFits(project, usage, task, day, period);
            if (check.ok) candidates.push({ day, period });
        }
    }
    return candidates;
}

function getExistingAdjacentPenalty(slots, task, day, period, blockSize) {
    let penalty = 0;
    for (const slot of slots) {
        if (slot.classId !== task.classId || slot.subjectId !== task.subjectId || slot.day !== day) continue;
        if (Math.abs(slot.period - period) <= blockSize) penalty += 12;
    }
    return penalty;
}

function candidateScore(project, usage, slots, task, candidate) {
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const subjectName = subject?.name || '';
    const morningSubjects = new Set(project.rules.softRules.morningSubjects || []);
    let score = candidate.day * 0.2 + candidate.period * 0.1;

    if (morningSubjects.has(task.subjectId) || /语文|数学|英语|外语/.test(subjectName)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (/体育|美术|音乐|劳动|实验/.test(subjectName)) {
        score += isMorning(project, candidate.period) ? 8 : -8;
    }

    score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 16;
    for (const teacherId of slotTeacherIds(task)) {
        score += (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) * 2;
    }
    score += getExistingAdjacentPenalty(slots, task, candidate.day, candidate.period, task.blockSize);
    score -= (subject?.priority || 50) / 100;

    return score;
}

function expandLessonPlanTasks(project, placedCountByPlan) {
    const tasks = [];
    for (const plan of project.lessonPlans) {
        let remaining = Math.max(0, plan.weeklyHours - (placedCountByPlan.get(plan.id) || 0));
        let blockIndex = 0;
        const addTask = blockSize => {
            blockIndex += 1;
            tasks.push({
                id: `${plan.id}_${blockIndex}`,
                lessonPlanId: plan.id,
                classId: plan.classId,
                subjectId: plan.subjectId,
                teacherId: plan.teacherId,
                teacherIds: plan.teacherIds,
                roomId: plan.roomId || null,
                blockSize,
                blockId: blockSize > 1 ? `${plan.id}_block_${blockIndex}` : null,
            });
            remaining -= blockSize;
        };

        if (plan.blockPreference === 'double') {
            while (remaining >= 2) addTask(2);
        } else if (plan.blockPreference === 'mixed' && remaining >= 4) {
            addTask(2);
        }
        while (remaining > 0) addTask(1);
    }
    return tasks;
}

function taskDifficulty(project, usage, task) {
    const candidates = getCandidateBlocks(project, usage, task).length;
    const subject = project.subjects.find(item => item.id === task.subjectId);
    return candidates * 100 - task.blockSize * 10 - (subject?.priority || 50);
}

function makeSlot(task, day, period, index = 0, locked = false) {
    return {
        id: `${locked ? 'locked' : 'slot'}_${task.lessonPlanId || task.id}_${task.classId}_${day}_${period}_${index}`,
        day,
        period,
        classId: task.classId,
        subjectId: task.subjectId,
        teacherId: task.teacherId,
        teacherIds: slotTeacherIds(task),
        lessonPlanId: task.lessonPlanId || null,
        roomId: task.roomId || null,
        blockId: task.blockId || null,
        blockIndex: index,
        blockSize: Math.max(1, task.blockSize || 1),
        locked,
    };
}

function seedLockedSlots(project, usage, maps) {
    const slots = [];
    const conflicts = [];
    const placedCountByPlan = new Map();

    for (const locked of project.rules.hardRules.lockedSlots || []) {
        const plan = locked.lessonPlanId ? maps.plans.get(locked.lessonPlanId) : null;
        const task = {
            id: locked.id,
            lessonPlanId: locked.lessonPlanId || plan?.id || null,
            classId: locked.classId,
            subjectId: locked.subjectId,
            teacherId: locked.teacherId,
            teacherIds: plan?.teacherIds || [locked.teacherId],
            roomId: locked.roomId || plan?.roomId || null,
            blockSize: 1,
        };
        const check = canUseSlot(project, usage, { ...task, day: locked.day, period: locked.period });
        if (!check.ok) {
            conflicts.push({
                type: 'locked-conflict',
                severity: 'hard',
                message: `锁定课节无法放置：${check.reason}`,
                slot: locked,
            });
            continue;
        }
        const slot = makeSlot(task, locked.day, locked.period, 0, true);
        slots.push(slot);
        addUsage(usage, slot);
        if (task.lessonPlanId) placedCountByPlan.set(task.lessonPlanId, (placedCountByPlan.get(task.lessonPlanId) || 0) + 1);
    }
    return { slots, conflicts, placedCountByPlan };
}

export function runTimetableScheduler(input = {}) {
    const project = normalizeTimetableProject(input);
    const maps = getTimetableEntityMaps(project);
    const usage = createTimetableUsage();
    const seeded = seedLockedSlots(project, usage, maps);
    const slots = [...seeded.slots];
    const unplaced = [];
    const conflicts = [...seeded.conflicts];

    const invalidPlans = project.lessonPlans.filter(plan => (
        !maps.classes.has(plan.classId)
        || !maps.subjects.has(plan.subjectId)
        || !slotTeacherIds(plan).every(teacherId => maps.teachers.has(teacherId))
    ));
    for (const plan of invalidPlans) {
        unplaced.push({
            lessonPlanId: plan.id,
            classId: plan.classId,
            subjectId: plan.subjectId,
            teacherId: plan.teacherId,
            reason: '任课信息引用了不存在的班级、课程或教师',
        });
    }

    const validPlanIds = new Set(project.lessonPlans.filter(plan => !invalidPlans.includes(plan)).map(plan => plan.id));
    const tasks = expandLessonPlanTasks(
        { ...project, lessonPlans: project.lessonPlans.filter(plan => validPlanIds.has(plan.id)) },
        seeded.placedCountByPlan,
    );
    tasks.sort((left, right) => taskDifficulty(project, usage, left) - taskDifficulty(project, usage, right) || left.id.localeCompare(right.id));

    for (const task of tasks) {
        const candidates = getCandidateBlocks(project, usage, task)
            .map(candidate => ({ ...candidate, score: candidateScore(project, usage, slots, task, candidate) }))
            .sort((left, right) => left.score - right.score || left.day - right.day || left.period - right.period);

        if (!candidates.length) {
            unplaced.push({
                taskId: task.id,
                lessonPlanId: task.lessonPlanId,
                classId: task.classId,
                subjectId: task.subjectId,
                teacherId: task.teacherId,
                reason: '没有可用节次：教师或班级被占用/不可排',
            });
            continue;
        }

        const best = candidates[0];
        for (let offset = 0; offset < task.blockSize; offset++) {
            const slot = makeSlot(task, best.day, best.period + offset, offset, false);
            slots.push(slot);
            addUsage(usage, slot);
        }
    }

    conflicts.push(...buildUnplacedConflicts(unplaced));
    conflicts.push(...detectScheduleConflicts(project, slots));

    const schedule = {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'diagnostic_local',
        slots: slots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: slots.filter(slot => slot.locked),
        conflicts,
        unplaced,
        score: buildTimetableScore(project, slots, unplaced, conflicts),
        solverStats: {
            solverUsed: false,
            note: 'diagnostic local scheduler',
        },
    };

    return {
        success: schedule.score.hardConflicts === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}
