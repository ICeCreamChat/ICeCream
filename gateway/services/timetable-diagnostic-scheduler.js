import {
    addUsage,
    canUseSlot,
    createTimetableUsage,
    detectScheduleConflicts,
    removeUsage,
} from './timetable-conflicts.js';
import {
    getActivePeriods,
    getActiveWeekdays,
    getTimetableEntityMaps,
    isActiveTimetableSlot,
    normalizeTimetableProject,
    slotTeacherIds,
} from './timetable-project.js';
import {
    buildTimetableScore,
    buildUnplacedConflicts,
} from './timetable-score.js';
import {
    auditTimetableProject,
    buildTimetableQualityIssues,
} from './timetable-audit.js';
import {
    validateTimetablePublication,
} from './timetable-validation.js';

function attachPublication(project, schedule) {
    schedule.publication = validateTimetablePublication({ ...project, schedule });
    if (project.schedule?.published?.status === 'published') {
        schedule.published = {
            ...project.schedule.published,
            status: 'draft_changed',
        };
    }
    return schedule;
}

function isMorning(project, period) {
    const periods = getActivePeriods(project);
    const morningPeriods = new Set(periods.slice(0, Math.max(1, Math.ceil(periods.length / 2))));
    return morningPeriods.has(Number(period));
}

function subjectProfile(subject = {}, subjectId = '') {
    return [subject.category, subject.type, ...(subject.tags || []), subjectId, subject.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function isMainSubject(subject = {}, subjectId = '', morningSubjects = new Set()) {
    if (morningSubjects.has(subjectId)) return true;
    return /\b(main|core|chinese|math|english|language)\b|语文|数学|英语|外语|主科/.test(subjectProfile(subject, subjectId));
}

function prefersLaterSubject(subject = {}, subjectId = '') {
    return /\b(pe|sport|physical|music|art|labor|lab|experiment)\b|体育|美术|音乐|劳动|实验|信息/.test(subjectProfile(subject, subjectId));
}

function getActiveSlotPairs(project) {
    const slots = [];
    for (const day of getActiveWeekdays(project)) {
        for (const period of getActivePeriods(project)) {
            slots.push({ day, period });
        }
    }
    return slots;
}

function hasConsecutiveActivePeriods(project, startPeriod, blockSize) {
    const activePeriods = new Set(getActivePeriods(project));
    for (let offset = 0; offset < blockSize; offset++) {
        if (!activePeriods.has(startPeriod + offset)) return false;
    }
    return true;
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

function roomCandidatesForTask(task = {}) {
    const rooms = Array.isArray(task.allowedRoomIds) && task.allowedRoomIds.length
        ? task.allowedRoomIds
        : [task.roomId].filter(Boolean);
    return rooms.length ? rooms : [null];
}

function getCandidateBlocks(project, usage, task) {
    const candidates = [];
    for (const day of getActiveWeekdays(project)) {
        for (const period of getActivePeriods(project)) {
            if (!hasConsecutiveActivePeriods(project, period, task.blockSize)) continue;
            for (const roomId of roomCandidatesForTask(task)) {
                const check = blockFits(project, usage, { ...task, roomId }, day, period);
                if (check.ok) candidates.push({ day, period, roomId });
            }
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
    const preferredPeriods = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKey = `${candidate.day}-${candidate.period}`;
    const preferenceWeight = Math.max(1, Math.min(100, Number.parseInt(preferredPeriods?.weight, 10) || 20));
    let score = candidate.day * 0.2 + candidate.period * 0.1;

    if (morningSubjects.has(task.subjectId) || /语文|数学|英语|外语/.test(subjectName)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (/体育|美术|音乐|劳动|实验/.test(subjectName)) {
        score += isMorning(project, candidate.period) ? 8 : -8;
    }

    score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 16;
    // spread subjects: penalise any same-day repeat harder
    if ((project.rules.softRules.spreadSubjects || []).includes(task.subjectId)) {
        score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 20;
    }
    for (const teacherId of slotTeacherIds(task)) {
        score += (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) * 2;
        // teacher daily limit: steep penalty once the limit would be exceeded
        const limit = project.rules.softRules.teacherLimits?.[teacherId]?.daily;
        if (Number.isInteger(limit) && (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) >= limit) {
            score += 60;
        }
    }
    if (preferredPeriods?.prefer?.includes(candidateKey)) score -= preferenceWeight;
    if (preferredPeriods?.avoid?.includes(candidateKey)) score += preferenceWeight;
    score += getExistingAdjacentPenalty(slots, task, candidate.day, candidate.period, task.blockSize);
    score -= (subject?.priority || 50) / 100;

    return score;
}

function teacherAdjacentPenalty(slots, teacherId, day, period, blockSize) {
    let penalty = 0;
    for (const slot of slots) {
        if (slot.day !== day || !slotTeacherIds(slot).includes(teacherId)) continue;
        if (Math.abs(Number(slot.period) - Number(period)) <= blockSize) penalty += 6;
    }
    return penalty;
}

function candidateScoreV2(project, usage, slots, task, candidate) {
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const morningSubjects = new Set(project.rules.softRules.morningSubjects || []);
    const preferredPeriods = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKey = `${candidate.day}-${candidate.period}`;
    const preferenceWeight = Math.max(1, Math.min(100, Number.parseInt(preferredPeriods?.weight, 10) || 20));
    let score = candidate.day * 0.2 + candidate.period * 0.1;

    if (isMainSubject(subject, task.subjectId, morningSubjects)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (prefersLaterSubject(subject, task.subjectId)) {
        score += isMorning(project, candidate.period) ? 8 : -8;
    }

    score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 16;
    if ((project.rules.softRules.spreadSubjects || []).includes(task.subjectId)) {
        score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 20;
    }
    for (const teacherId of slotTeacherIds(task)) {
        score += (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) * 2;
        score += teacherAdjacentPenalty(slots, teacherId, candidate.day, candidate.period, task.blockSize);
        const limit = project.rules.softRules.teacherLimits?.[teacherId]?.daily;
        if (Number.isInteger(limit) && (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) >= limit) {
            score += 60;
        }
    }
    if (preferredPeriods?.prefer?.includes(candidateKey)) score -= preferenceWeight;
    if (preferredPeriods?.avoid?.includes(candidateKey)) score += preferenceWeight;
    score += getExistingAdjacentPenalty(slots, task, candidate.day, candidate.period, task.blockSize);
    score -= (subject?.priority || 50) / 100;

    return score;
}

function expandLessonPlanTasks(project, placedCountByPlan) {
    const tasks = [];
    for (const plan of project.lessonPlans) {
        const alreadyPlaced = placedCountByPlan.get(plan.id) || 0;
        let remaining = Math.max(0, plan.weeklyHours - alreadyPlaced);
        let blockIndex = placedBlockCountForPlan(plan, alreadyPlaced);
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
                allowedRoomIds: plan.allowedRoomIds || [],
                blockSize,
                blockId: blockSize > 1 ? `${plan.id}_block_${blockIndex}` : null,
            });
            remaining -= blockSize;
        };

        if (plan.blockPreference === 'double') {
            while (remaining >= 2) addTask(2);
        } else if (plan.blockPreference === 'mixed' && remaining >= 4) {
            // genuinely "mixed": pack doubles but always keep a couple of single
            // periods (2 when even, 1 when odd), e.g. 6h -> 2+2+1+1, 5h -> 2+2+1.
            const singles = remaining % 2 === 0 ? 2 : 1;
            let doubleBudget = remaining - singles;
            while (doubleBudget >= 2) {
                addTask(2);
                doubleBudget -= 2;
            }
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

function makeSlot(task, day, period, index = 0, locked = false, roomId = undefined) {
    return {
        id: `${locked ? 'locked' : 'slot'}_${task.lessonPlanId || task.id}_${task.classId}_${day}_${period}_${index}`,
        day,
        period,
        classId: task.classId,
        subjectId: task.subjectId,
        teacherId: task.teacherId,
        teacherIds: slotTeacherIds(task),
        lessonPlanId: task.lessonPlanId || null,
        roomId: roomId === undefined ? task.roomId || null : roomId,
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
    // Edge-coloring assigns each lesson an independent colour (time slot); it cannot
    // keep the two halves of a 连堂/double block adjacent, so defer block plans to greedy.
    if ((project.lessonPlans || []).some(plan => plan.blockPreference !== 'single')) return false;
    return true;
}

// Soft-rule affinity of placing a task at (day, period). Higher = more desirable.
// Mirrors candidateScore's soft signals but as a positive "goodness" used to
// assign edge-coloring colours to concrete time slots.
function taskSlotAffinity(project, task, day, period) {
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const morningSubjects = new Set(project.rules.softRules.morningSubjects || []);
    const preferred = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const key = `${day}-${period}`;
    const morning = isMorning(project, period);
    let affinity = 0;

    if (isMainSubject(subject, task.subjectId, morningSubjects)) {
        affinity += morning ? 18 : -14;
    }
    if (prefersLaterSubject(subject, task.subjectId)) {
        affinity += morning ? -8 : 8;
    }
    if (preferred?.prefer?.includes(key)) affinity += Math.max(1, Math.min(100, preferred.weight || 20));
    if (preferred?.avoid?.includes(key)) affinity -= Math.max(1, Math.min(100, preferred.weight || 20));
    affinity += (subject?.priority || 50) / 100;
    // mild bias toward earlier in the week / day to break ties deterministically
    affinity -= day * 0.2 + period * 0.1;
    return affinity;
}

// Greedily assign each colour group to a distinct time slot to maximise total
// soft affinity. periodCount is small (≤ 84) so an O(n²) greedy is plenty fast
// and deterministic.
function assignColorsToSlots(project, colorGroups, timetableSlots) {
    const colorCount = colorGroups.length;
    const groupScore = (group, slot) => group.reduce(
        (sum, entry) => sum + taskSlotAffinity(project, entry.task, slot.day, slot.period),
        0,
    );
    const pairs = [];
    for (let color = 0; color < colorCount; color++) {
        for (let slotIndex = 0; slotIndex < timetableSlots.length; slotIndex++) {
            pairs.push({ color, slotIndex, score: groupScore(colorGroups[color], timetableSlots[slotIndex]) });
        }
    }
    pairs.sort((left, right) => right.score - left.score
        || left.color - right.color
        || left.slotIndex - right.slotIndex);

    const colorToSlot = new Array(colorCount).fill(-1);
    const slotTaken = new Array(timetableSlots.length).fill(false);
    let assigned = 0;
    for (const pair of pairs) {
        if (assigned === colorCount) break;
        if (colorToSlot[pair.color] !== -1 || slotTaken[pair.slotIndex]) continue;
        colorToSlot[pair.color] = pair.slotIndex;
        slotTaken[pair.slotIndex] = true;
        assigned += 1;
    }
    return colorToSlot;
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
        // keep a couple of single periods alongside the doubles, e.g. 6h -> 2+2+1+1
        const singles = remaining % 2 === 0 ? 2 : 1;
        let doubleBudget = remaining - singles;
        while (doubleBudget >= 2) {
            sizes.push(2);
            doubleBudget -= 2;
            remaining -= 2;
        }
    }
    while (remaining > 0) {
        sizes.push(1);
        remaining -= 1;
    }
    return sizes;
}

function placedBlockCountForPlan(plan, placedHours = 0) {
    let consumed = 0;
    let count = 0;
    for (const size of blockSizesForPlan(plan)) {
        if (consumed + size > placedHours) break;
        consumed += size;
        count += 1;
    }
    return count;
}

function nextLockedBlockSizeForPlan(plan, placedHours = 0) {
    let consumed = 0;
    for (const size of blockSizesForPlan(plan)) {
        if (placedHours < consumed + size) return size;
        consumed += size;
    }
    return 1;
}

function planForLockedRule(project, maps, locked) {
    if (locked.lessonPlanId) return maps.plans.get(locked.lessonPlanId) || null;
    return project.lessonPlans.find(item => item.classId === locked.classId
        && item.subjectId === locked.subjectId
        && slotTeacherIds(item).includes(locked.teacherId)) || null;
}

function lockedRuleTargetKey(locked, plan) {
    return plan?.id || locked.lessonPlanId || [
        locked.classId || '',
        locked.subjectId || '',
        locked.teacherId || '',
    ].join(':');
}

function lockedRuleCellKey(locked, plan) {
    return `${lockedRuleTargetKey(locked, plan)}:${Number(locked.day)}-${Number(locked.period)}`;
}

function lockedBlockStartPeriod(project, locked, blockSize) {
    const day = Number(locked.day);
    const period = Number(locked.period);
    for (let start = period; start >= period - blockSize + 1; start -= 1) {
        let fits = true;
        for (let offset = 0; offset < blockSize; offset += 1) {
            if (!isActiveTimetableSlot(project, day, start + offset)) {
                fits = false;
                break;
            }
        }
        if (fits) return start;
    }
    return period;
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
            allowedRoomIds: plan.allowedRoomIds || [],
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
    const audit = auditTimetableProject(project);

    const timetableSlots = getActiveSlotPairs(project);
    const periodCount = timetableSlots.length;
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

    const colorGroups = [];
    for (let color = 0; color < periodCount; color++) {
        const matching = findPerfectMatching(leftIds, rightIds, counts);
        if (!matching) return null;

        const group = [];
        for (const leftId of leftIds) {
            const rightId = matching.get(leftId);
            decrementCount(counts, leftId, rightId);
            const bucket = buckets.get(`${leftId}:${rightId}`);
            const task = bucket?.shift();
            if (task) group.push({ leftId, rightId, task });
        }
        colorGroups.push(group);
    }

    // Map each colour (a conflict-free group of lessons) onto the time slot that
    // best satisfies the soft rules, instead of the arbitrary natural order.
    const colorToSlotIndex = assignColorsToSlots(project, colorGroups, timetableSlots);
    const slots = [];
    colorGroups.forEach((group, color) => {
        const slotIndex = colorToSlotIndex[color];
        const { day, period } = timetableSlots[slotIndex >= 0 ? slotIndex : color];
        for (const entry of group) {
            slots.push(makeSlot(entry.task, day, period, entry.task.blockIndex || 0, false));
        }
    });

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

    const qualityIssues = buildTimetableQualityIssues(project, slots);
    const schedule = {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'fast_constructed',
        slots: slots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: [],
        conflicts,
        unplaced,
        audit,
        qualityIssues,
        score: buildTimetableScore(project, slots, unplaced, conflicts),
        solverStats: {
            solverUsed: false,
            phase: 'fast_construct',
            status: conflicts.some(conflict => conflict.severity === 'hard') || unplaced.length ? 'failed' : 'accepted',
            strategy: 'bipartite_edge_coloring',
            lessonCount: tasks.length,
            localImproveMs: 0,
            accepted: true,
            reason: null,
        },
    };
    attachPublication(project, schedule);

    return {
        success: schedule.score.hardConflicts === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}

// Single-step local repair: for each unplaced task, look for an already-placed
// (non-locked, single) slot that, if moved elsewhere, frees a slot the unplaced
// task can occupy. Bounded by a step budget so large rosters stay fast and the
// procedure stays fully deterministic.
function repairUnplaced(project, usage, slots, unplaced) {
    const STEP_BUDGET = 400;
    let steps = 0;

    for (let u = 0; u < unplaced.length && steps < STEP_BUDGET; u++) {
        const entry = unplaced[u];
        const task = entry.task;
        if (!task || task.blockSize > 1) continue; // only repair single-period lessons

        let repaired = false;
        const activeWeekdays = getActiveWeekdays(project);
        const activePeriods = getActivePeriods(project);

        for (const day of activeWeekdays) {
            if (repaired) break;
            for (const period of activePeriods) {
                steps += 1;
                if (steps >= STEP_BUDGET) break;
                const target = { ...task, day, period };
                const check = canUseSlot(project, usage, target);
                if (check.ok) {
                    // a slot opened up on its own (shouldn't usually happen) — just take it
                    const slot = makeSlot(task, day, period, 0, false);
                    slots.push(slot);
                    addUsage(usage, slot);
                    repaired = true;
                    break;
                }
                // find the blocking slot(s) occupying (day, period) for this class/teacher
                const blockers = slots.filter(slot => !slot.locked
                    && slot.blockSize <= 1
                    && slot.day === day && slot.period === period
                    && (slot.classId === task.classId
                        || slotTeacherIds(slot).some(id => slotTeacherIds(task).includes(id))));
                if (blockers.length !== 1) continue; // multi-blocker swaps are out of scope

                const blocker = blockers[0];
                // tentatively remove the blocker, see if BOTH can be placed
                removeUsage(usage, blocker);
                const taskFits = canUseSlot(project, usage, target).ok;
                let moved = null;
                if (taskFits) {
                    for (const d2 of activeWeekdays) {
                        for (const p2 of activePeriods) {
                            if (d2 === day && p2 === period) continue;
                            const relocated = { ...blocker, day: d2, period: p2 };
                            if (canUseSlot(project, usage, relocated).ok) {
                                moved = relocated;
                                break;
                            }
                        }
                        if (moved) break;
                    }
                }
                if (taskFits && moved) {
                    // commit: relocate blocker, place the previously-unplaced task
                    const blockerIndex = slots.indexOf(blocker);
                    slots[blockerIndex] = { ...moved, id: blocker.id };
                    addUsage(usage, slots[blockerIndex]);
                    const slot = makeSlot(task, day, period, 0, false);
                    slots.push(slot);
                    addUsage(usage, slot);
                    repaired = true;
                    break;
                }
                // revert
                addUsage(usage, blocker);
            }
        }
        if (repaired) {
            unplaced.splice(u, 1);
            u -= 1;
        }
    }
}

function localImproveBudgetMs(env = process.env) {
    const value = Number.parseInt(env.TIMETABLE_LOCAL_IMPROVE_MS, 10);
    return Number.isFinite(value) && value >= 0 ? value : 3000;
}

function slotGroupKey(slot) {
    return slot.blockId || slot.id;
}

function unlockedGroups(slots = [], affectedIds = new Set()) {
    const groups = new Map();
    for (const slot of slots) {
        if (slot.locked) continue;
        if (affectedIds.size && !affectedIds.has(slot.id)) continue;
        const key = slotGroupKey(slot);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(slot);
    }
    return [...groups.values()]
        .map(group => group.sort((left, right) => (left.blockIndex || 0) - (right.blockIndex || 0)))
        .sort((left, right) => left[0].id.localeCompare(right[0].id));
}

function buildUsageExcluding(slots, excludedIds = new Set()) {
    const usage = createTimetableUsage();
    for (const slot of slots) {
        if (!excludedIds.has(slot.id)) addUsage(usage, slot);
    }
    return usage;
}

function moveGroupSlots(project, slots, group, day, period) {
    const groupIds = new Set(group.map(slot => slot.id));
    const usage = buildUsageExcluding(slots, groupIds);
    const moved = new Map();
    for (const [index, slot] of group.entries()) {
        const relative = Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : index;
        const next = { ...slot, day, period: period + relative };
        const check = canUseSlot(project, usage, next);
        if (!check.ok) return null;
        addUsage(usage, next);
        moved.set(slot.id, next);
    }
    return slots.map(slot => moved.get(slot.id) || slot);
}

function swapGroupSlots(project, slots, left, right) {
    const excluded = new Set([...left, ...right].map(slot => slot.id));
    const usage = buildUsageExcluding(slots, excluded);
    const moved = new Map();
    const place = (group, day, period) => {
        for (const [index, slot] of group.entries()) {
            const relative = Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : index;
            const next = { ...slot, day, period: period + relative };
            const check = canUseSlot(project, usage, next);
            if (!check.ok) return false;
            addUsage(usage, next);
            moved.set(slot.id, next);
        }
        return true;
    };
    if (!place(left, right[0].day, right[0].period)) return null;
    if (!place(right, left[0].day, left[0].period)) return null;
    return slots.map(slot => moved.get(slot.id) || slot);
}

function scheduleScoreValue(project, slots, unplaced = []) {
    const conflicts = [
        ...buildUnplacedConflicts(unplaced),
        ...detectScheduleConflicts(project, slots),
    ];
    if (conflicts.some(conflict => conflict.severity === 'hard') || unplaced.length) return -1000000;
    const score = buildTimetableScore(project, slots, unplaced, conflicts);
    return Number(score.softScore || 0) + Number(score.softSatisfaction || 0) / 100;
}

function tryImproveByMove(project, slots, unplaced, groups) {
    let bestSlots = slots;
    let bestValue = scheduleScoreValue(project, bestSlots, unplaced);
    for (const group of groups) {
        const blockSize = group.length;
        for (const day of getActiveWeekdays(project)) {
            for (const period of getActivePeriods(project)) {
                if (!hasConsecutiveActivePeriods(project, period, blockSize)) continue;
                const moved = moveGroupSlots(project, bestSlots, group, day, period);
                if (!moved) continue;
                const value = scheduleScoreValue(project, moved, unplaced);
                if (value > bestValue) {
                    return { improved: true, slots: moved, value };
                }
            }
        }
    }
    return { improved: false, slots: bestSlots, value: bestValue };
}

function tryImproveBySwap(project, slots, unplaced, groups) {
    let bestValue = scheduleScoreValue(project, slots, unplaced);
    const limited = groups.slice(0, 80);
    for (let leftIndex = 0; leftIndex < limited.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < limited.length; rightIndex += 1) {
            const left = limited[leftIndex];
            const right = limited[rightIndex];
            if (left.length !== right.length) continue;
            const swapped = swapGroupSlots(project, slots, left, right);
            if (!swapped) continue;
            const value = scheduleScoreValue(project, swapped, unplaced);
            if (value > bestValue) return { improved: true, slots: swapped, value };
        }
    }
    return { improved: false, slots, value: bestValue };
}

function improveScheduleLocally(project, slots, unplaced, audit) {
    const startedAt = Date.now();
    const budget = localImproveBudgetMs();
    if (budget <= 0 || unplaced.length) return { slots, stats: { localImproveMs: 0, improved: false } };
    let currentSlots = slots;
    let currentIssues = buildTimetableQualityIssues(project, currentSlots);
    const originalValue = scheduleScoreValue(project, currentSlots, unplaced);
    let currentValue = originalValue;
    let movesAccepted = 0;

    while (Date.now() - startedAt < budget && movesAccepted < 20 && currentIssues.length) {
        const affectedIds = new Set(currentIssues.map(item => item.slot?.id).filter(Boolean));
        const groups = unlockedGroups(currentSlots, affectedIds);
        if (!groups.length) break;
        const moved = tryImproveByMove(project, currentSlots, unplaced, groups);
        const next = moved.improved ? moved : tryImproveBySwap(project, currentSlots, unplaced, groups);
        if (!next.improved || next.value <= currentValue) break;
        currentSlots = next.slots;
        currentValue = next.value;
        movesAccepted += 1;
        currentIssues = buildTimetableQualityIssues(project, currentSlots);
    }

    return {
        slots: currentSlots,
        stats: {
            localImproveMs: Date.now() - startedAt,
            improved: currentValue > originalValue,
            movesAccepted,
            auditWarnings: audit?.warnings?.length || 0,
        },
    };
}

function seedLockedSlots(project, usage, maps) {
    const slots = [];
    const conflicts = [];
    const placedCountByPlan = new Map();
    const seededKeys = new Set();
    const consumedLockedCells = new Set();
    const lockedRules = (project.rules?.hardRules?.lockedSlots || [])
        .map(locked => {
            const plan = planForLockedRule(project, maps, locked);
            return {
                locked,
                plan,
                targetKey: lockedRuleTargetKey(locked, plan),
            };
        })
        .sort((left, right) => left.targetKey.localeCompare(right.targetKey)
            || Number(left.locked.day) - Number(right.locked.day)
            || Number(left.locked.period) - Number(right.locked.period));

    for (const { locked, plan } of lockedRules) {
        const lockedCellKey = lockedRuleCellKey(locked, plan);
        if (consumedLockedCells.has(lockedCellKey)) continue;
        const placedHours = plan ? (placedCountByPlan.get(plan.id) || 0) : 0;
        const blockSize = plan ? nextLockedBlockSizeForPlan(plan, placedHours) : 1;
        const blockNumber = plan ? placedBlockCountForPlan(plan, placedHours) + 1 : 1;
        const lessonPlanId = locked.lessonPlanId || plan?.id || null;
        const task = {
            id: locked.id,
            lessonPlanId,
            classId: locked.classId || plan?.classId || null,
            subjectId: locked.subjectId || plan?.subjectId || null,
            teacherId: locked.teacherId || plan?.teacherId || null,
            teacherIds: plan ? slotTeacherIds(plan) : [locked.teacherId].filter(Boolean),
            roomId: locked.roomId || plan?.roomId || null,
            blockSize,
            blockId: blockSize > 1 ? `${lessonPlanId || locked.id}_block_${blockNumber}` : null,
        };
        const proposed = [];
        let failed = null;
        const startPeriod = lockedBlockStartPeriod(project, locked, blockSize);

        for (let offset = 0; offset < blockSize; offset += 1) {
            const day = Number(locked.day);
            const period = startPeriod + offset;
            if (!isActiveTimetableSlot(project, day, period)) {
                failed = { reason: 'locked block is outside active timetable range', day, period };
                break;
            }
            const key = `${task.lessonPlanId || task.id}:${task.classId}:${day}-${period}`;
            if (seededKeys.has(key)) {
                failed = { reason: 'duplicate locked slot', day, period };
                break;
            }
            const check = canUseSlot(project, usage, { ...task, day, period });
            if (!check.ok) {
                failed = { reason: check.reason, day, period };
                break;
            }
            proposed.push({ day, period, offset, key });
        }

        if (failed) {
            conflicts.push({
                type: 'locked-conflict',
                severity: 'hard',
                message: `Locked lesson cannot be placed: ${failed.reason}`,
                slot: { ...locked, day: failed.day, period: failed.period },
            });
            continue;
        }

        for (const item of proposed) {
            const slot = makeSlot(task, item.day, item.period, item.offset, true);
            slots.push(slot);
            addUsage(usage, slot);
            seededKeys.add(item.key);
            consumedLockedCells.add(`${lockedRuleTargetKey(locked, plan)}:${item.day}-${item.period}`);
            if (task.lessonPlanId) {
                placedCountByPlan.set(task.lessonPlanId, (placedCountByPlan.get(task.lessonPlanId) || 0) + 1);
            }
        }
    }

    return { slots, conflicts, placedCountByPlan };
}

export function runTimetableScheduler(input = {}) {
    const project = normalizeTimetableProject(input);
    const audit = auditTimetableProject(project);

    // Edge-coloring (when the project shape is simple) yields a globally feasible,
    // soft-rule-aware assignment far more reliably than greedy, so try it first and
    // fall back to the greedy constructor + local repair otherwise.
    const edgeColored = buildFastEdgeColoredSchedule(project);
    if (edgeColored?.success) return edgeColored;

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
    // Most-constrained-first: tasks with the fewest candidate slots (and larger
    // blocks / higher priority) are placed earliest so they don't get crowded out.
    tasks.sort((left, right) => taskDifficulty(project, usage, left) - taskDifficulty(project, usage, right) || left.id.localeCompare(right.id));

    for (const task of tasks) {
        const scored = getCandidateBlocks(project, usage, task)
            .map(candidate => ({ ...candidate, score: candidateScoreV2(project, usage, slots, task, candidate) }))
            .sort((left, right) => left.score - right.score || left.day - right.day || left.period - right.period);

        if (!scored.length) {
            unplaced.push({
                taskId: task.id,
                lessonPlanId: task.lessonPlanId,
                classId: task.classId,
                subjectId: task.subjectId,
                teacherId: task.teacherId,
                reason: '没有可用节次：教师或班级被占用/不可排',
                task,
            });
            continue;
        }

        const best = scored[0];
        for (let offset = 0; offset < task.blockSize; offset++) {
            const slot = makeSlot(task, best.day, best.period + offset, offset, false, best.roomId);
            slots.push(slot);
            addUsage(usage, slot);
        }
    }

    // Local repair: try to rescue unplaced tasks by relocating one blocking slot.
    repairUnplaced(project, usage, slots, unplaced);
    const localImprovement = improveScheduleLocally(project, slots, unplaced, audit);
    const finalSlots = localImprovement.slots;

    // unplaced entries carry a transient `task` ref for repair; strip it before output.
    const cleanUnplaced = unplaced.map(({ task, ...rest }) => rest);
    conflicts.push(...buildUnplacedConflicts(cleanUnplaced));
    conflicts.push(...detectScheduleConflicts(project, finalSlots));
    const qualityIssues = buildTimetableQualityIssues(project, finalSlots);
    const hasPreflightBlocking = audit.blockingIssues.length > 0;

    const schedule = {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'fast_constructed',
        slots: finalSlots.sort((left, right) => left.day - right.day || left.period - right.period || left.classId.localeCompare(right.classId)),
        lockedSlots: finalSlots.filter(slot => slot.locked),
        conflicts,
        unplaced: cleanUnplaced,
        audit,
        qualityIssues,
        score: buildTimetableScore(project, finalSlots, cleanUnplaced, conflicts),
        solverStats: {
            solverUsed: false,
            phase: 'fast_construct',
            status: conflicts.some(conflict => conflict.severity === 'hard') || cleanUnplaced.length ? 'failed' : 'accepted',
            strategy: 'greedy_constraints',
            lessonCount: project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0),
            localImproveMs: localImprovement.stats.localImproveMs,
            accepted: !(conflicts.some(conflict => conflict.severity === 'hard') || cleanUnplaced.length),
            reason: hasPreflightBlocking ? 'preflight_blocking_issues' : null,
            localImprovement: localImprovement.stats,
        },
    };
    attachPublication(project, schedule);

    return {
        success: schedule.score.hardConflicts === 0 && cleanUnplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}
