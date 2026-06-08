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

function hasSimpleEdgeColoringShape(project) {
    if ((project.rules?.hardRules?.lockedSlots || []).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.teacherUnavailable || {}).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.classUnavailable || {}).length > 0) return false;
    if ((project.teachers || []).some(teacher => (teacher.unavailableSlots || []).length > 0)) return false;
    if ((project.lessonPlans || []).some(plan => slotTeacherIds(plan).length !== 1)) return false;
    if ((project.lessonPlans || []).some(plan => plan.roomId || (plan.allowedRoomIds || []).length > 0)) return false;
    return true;
}

function addCount(counts, leftId, rightId, amount = 1) {
    if (!counts.has(leftId)) counts.set(leftId, new Map());
    const row = counts.get(leftId);
    row.set(rightId, (row.get(rightId) || 0) + amount);
}

function decrementCount(counts, leftId, rightId) {
    const row = counts.get(leftId);
    if (!row) return;
    const next = (row.get(rightId) || 0) - 1;
    if (next <= 0) {
        row.delete(rightId);
    } else {
        row.set(rightId, next);
    }
}

function buildDegreeDeficits(ids, degree, targetDegree) {
    const deficits = [];
    for (const id of ids) {
        const missing = targetDegree - (degree.get(id) || 0);
        for (let index = 0; index < missing; index++) deficits.push(id);
    }
    return deficits;
}

function findPerfectMatching(leftIds, rightIds, counts) {
    const rightSet = new Set(rightIds);
    const adjacency = new Map(leftIds.map(leftId => {
        const rights = [...(counts.get(leftId) || new Map()).keys()]
            .filter(rightId => rightSet.has(rightId))
            .sort();
        return [leftId, rights];
    }));
    const pairLeft = new Map();
    const pairRight = new Map();
    const distance = new Map();

    function bfs() {
        const queue = [];
        let foundFreeRight = false;
        for (const leftId of leftIds) {
            if (!pairLeft.has(leftId)) {
                distance.set(leftId, 0);
                queue.push(leftId);
            } else {
                distance.set(leftId, Infinity);
            }
        }
        for (let cursor = 0; cursor < queue.length; cursor++) {
            const leftId = queue[cursor];
            for (const rightId of adjacency.get(leftId) || []) {
                const pairedLeft = pairRight.get(rightId);
                if (!pairedLeft) {
                    foundFreeRight = true;
                } else if (distance.get(pairedLeft) === Infinity) {
                    distance.set(pairedLeft, distance.get(leftId) + 1);
                    queue.push(pairedLeft);
                }
            }
        }
        return foundFreeRight;
    }

    function dfs(leftId) {
        for (const rightId of adjacency.get(leftId) || []) {
            const pairedLeft = pairRight.get(rightId);
            if (!pairedLeft || (distance.get(pairedLeft) === distance.get(leftId) + 1 && dfs(pairedLeft))) {
                pairLeft.set(leftId, rightId);
                pairRight.set(rightId, leftId);
                return true;
            }
        }
        distance.set(leftId, Infinity);
        return false;
    }

    while (bfs()) {
        for (const leftId of leftIds) {
            if (!pairLeft.has(leftId)) dfs(leftId);
        }
    }

    if (pairLeft.size !== leftIds.length) return null;
    return pairLeft;
}

function blockSizesForPlan(plan) {
    let remaining = Math.max(0, Number.parseInt(plan.weeklyHours, 10) || 0);
    const sizes = [];
    if (plan.blockPreference === 'double') {
        while (remaining >= 2) {
            sizes.push(2);
            remaining -= 2;
        }
    } else if (plan.blockPreference === 'mixed' && remaining >= 4) {
        sizes.push(2);
        remaining -= 2;
    }
    while (remaining > 0) {
        sizes.push(1);
        remaining -= 1;
    }
    return sizes;
}

function expandSingleTeacherEdgeTasks(project) {
    const tasks = [];
    for (const plan of project.lessonPlans) {
        let sequence = 0;
        let blockNumber = 0;
        for (const blockSize of blockSizesForPlan(plan)) {
            blockNumber += 1;
            for (let blockIndex = 0; blockIndex < blockSize; blockIndex++) {
                sequence += 1;
                tasks.push({
                    id: `${plan.id}_${sequence}`,
                    lessonPlanId: plan.id,
                    classId: plan.classId,
                    subjectId: plan.subjectId,
                    teacherId: plan.teacherId,
                    teacherIds: plan.teacherIds,
                    roomId: plan.roomId || null,
                    blockSize,
                    blockIndex,
                    blockId: blockSize > 1 ? `${plan.id}_block_${blockNumber}` : null,
                    priority: project.subjects.find(subject => subject.id === plan.subjectId)?.priority || 50,
                });
            }
        }
    }
    return tasks;
}

function buildFastEdgeColoredSchedule(project) {
    if (!hasSimpleEdgeColoringShape(project)) return null;

    const periodCount = project.weekdays * project.periodsPerDay;
    const realClassIds = project.classes.map(item => item.id).sort();
    const realTeacherIds = project.teachers.map(item => item.id).sort();
    const tasks = expandSingleTeacherEdgeTasks(project);
    const minimumSideSize = Math.ceil(tasks.length / Math.max(1, periodCount));
    const sideSize = Math.max(realClassIds.length, realTeacherIds.length, minimumSideSize);
    const leftIds = [...realClassIds];
    const rightIds = [...realTeacherIds];
    while (leftIds.length < sideSize) leftIds.push(`__dummy_class_${leftIds.length + 1}`);
    while (rightIds.length < sideSize) rightIds.push(`__dummy_teacher_${rightIds.length + 1}`);

    const realClasses = new Set(realClassIds);
    const realTeachers = new Set(realTeacherIds);
    const counts = new Map();
    const leftDegree = new Map(leftIds.map(id => [id, 0]));
    const rightDegree = new Map(rightIds.map(id => [id, 0]));
    const buckets = new Map();

    for (const task of tasks) {
        const leftId = task.classId;
        const rightId = task.teacherId;
        if (!realClasses.has(leftId) || !realTeachers.has(rightId)) continue;
        const bucketKey = `${leftId}:${rightId}`;
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
        buckets.get(bucketKey).push(task);
        addCount(counts, leftId, rightId);
        leftDegree.set(leftId, (leftDegree.get(leftId) || 0) + 1);
        rightDegree.set(rightId, (rightDegree.get(rightId) || 0) + 1);
    }

    if ([...leftDegree.values()].some(value => value > periodCount)) return null;
    if ([...rightDegree.values()].some(value => value > periodCount)) return null;

    for (const bucket of buckets.values()) {
        bucket.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    }

    const leftDeficits = buildDegreeDeficits(leftIds, leftDegree, periodCount);
    const rightDeficits = buildDegreeDeficits(rightIds, rightDegree, periodCount);
    if (leftDeficits.length !== rightDeficits.length) return null;
    for (let index = 0; index < leftDeficits.length; index++) {
        addCount(counts, leftDeficits[index], rightDeficits[index]);
    }

    const slots = [];
    for (let color = 0; color < periodCount; color++) {
        const matching = findPerfectMatching(leftIds, rightIds, counts);
        if (!matching) return null;
        const day = Math.floor(color / project.periodsPerDay) + 1;
        const period = (color % project.periodsPerDay) + 1;

        for (const leftId of leftIds) {
            const rightId = matching.get(leftId);
            decrementCount(counts, leftId, rightId);
            const bucket = buckets.get(`${leftId}:${rightId}`);
            const task = bucket?.shift();
            if (task) {
                slots.push(makeSlot(task, day, period, task.blockIndex || 0, false));
            }
        }
    }

    const unplaced = [];
    for (const bucket of buckets.values()) {
        for (const task of bucket) {
            unplaced.push({
                taskId: task.id,
                lessonPlanId: task.lessonPlanId,
                classId: task.classId,
                subjectId: task.subjectId,
                teacherId: task.teacherId,
                reason: 'No conflict-free slot remained after fast construction',
            });
        }
    }
    const conflicts = [
        ...buildUnplacedConflicts(unplaced),
        ...detectScheduleConflicts(project, slots),
    ];

    const schedule = {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'fast_constructed',
        slots: slots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: [],
        conflicts,
        unplaced,
        score: buildTimetableScore(project, slots, unplaced, conflicts),
        solverStats: {
            solverUsed: false,
            phase: 'fast_construct',
            status: conflicts.some(conflict => conflict.severity === 'hard') || unplaced.length ? 'failed' : 'accepted',
            strategy: 'bipartite_edge_coloring',
            lessonCount: tasks.length,
        },
    };

    return {
        success: schedule.score.hardConflicts === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
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
        source: 'fast_constructed',
        slots: slots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: slots.filter(slot => slot.locked),
        conflicts,
        unplaced,
        score: buildTimetableScore(project, slots, unplaced, conflicts),
        solverStats: {
            solverUsed: false,
            phase: 'fast_construct',
            status: conflicts.some(conflict => conflict.severity === 'hard') || unplaced.length ? 'failed' : 'accepted',
            strategy: 'greedy_constraints',
            lessonCount: project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0),
        },
    };

    if (schedule.score.hardConflicts > 0 || unplaced.length > 0) {
        const edgeColored = buildFastEdgeColoredSchedule(project);
        if (edgeColored?.success) return edgeColored;
    }

    return {
        success: schedule.score.hardConflicts === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}
