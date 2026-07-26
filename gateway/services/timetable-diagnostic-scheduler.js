import {
    addUsage,
    canUseSlot,
    createTimetableUsage,
    detectScheduleConflicts,
    removeUsage,
} from './timetable-conflicts.js';
import {
    classIdsForPlan,
    getDayPartPeriods,
    getActivePeriods,
    getActiveWeekdays,
    getTimetableEntityMaps,
    isComplexTimetableModel,
    isActiveTimetableSlot,
    isMorningPeriod,
    normalizeTimetableProject,
    slotClassIds,
    slotTeacherIds,
    teachingGroupForPlan,
    weekPatternForSlot,
    weekPatternsOverlap,
} from './timetable-project.js';
import {
    advancedBlockPreference,
    advancedCandidatePenalty,
} from './timetable-advanced-rules.js';
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
import {
    attachTimetableDiagnostics,
} from './timetable-diagnostics.js';

const DEFAULT_TIMETABLE_TIE_BREAK_SEED = 'timetable-generic-v1';

function attachPublication(project, schedule) {
    schedule.publication = validateTimetablePublication({ ...project, schedule });
    attachTimetableDiagnostics(project, schedule, { publication: schedule.publication });
    if (project.schedule?.published?.status === 'published') {
        schedule.published = {
            ...project.schedule.published,
            status: 'draft_changed',
        };
    }
    return schedule;
}

function normalizeSolveSeed(seed) {
    if (seed === undefined || seed === null || seed === '') return null;
    if (typeof seed === 'number' && Number.isFinite(seed)) return String(seed);
    const text = String(seed).trim();
    return text ? text.slice(0, 120) : null;
}

function seededHash(seed, value) {
    let hash = 2166136261;
    const text = `${seed}:${value}`;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function seededCompare(seed, leftKey, rightKey) {
    const effectiveSeed = seed || DEFAULT_TIMETABLE_TIE_BREAK_SEED;
    return seededHash(effectiveSeed, leftKey) - seededHash(effectiveSeed, rightKey);
}

function candidateTieKey(candidate = {}) {
    return `${candidate.day}-${candidate.period}:${candidate.roomId || ''}`;
}

function scheduleSeedPatch(seed) {
    return seed ? { seed } : {};
}

function bumpCount(map, key, amount = 1) {
    map.set(key, (map.get(key) || 0) + amount);
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const value = Number.parseInt(process.env[name], 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function repairConfig(taskCount = 0) {
    const maxDepth = intEnv('TIMETABLE_REPAIR_MAX_DEPTH', 14, { min: 1, max: 50 });
    const multiplier = intEnv('TIMETABLE_REPAIR_MAX_CALLS_MULTIPLIER', 2, { min: 1, max: 20 });
    return {
        maxDepth,
        shallowLimit: Math.min(maxDepth, 5),
        maxCalls: intEnv('TIMETABLE_REPAIR_MAX_CALLS', Math.max(1, multiplier * Math.max(1, taskCount)), { min: 1 }),
        stepBudget: intEnv('TIMETABLE_REPAIR_STEP_BUDGET', 900, { min: 1 }),
        maxBlockers: intEnv('TIMETABLE_REPAIR_MAX_BLOCKERS', 3, { min: 1, max: 12 }),
    };
}

function isMorning(project, period) {
    return isMorningPeriod(project, period);
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

function roomCandidatesForTask(task = {}, project = null) {
    const requirement = task.roomRequirement || {};
    let rooms = [];
    if (Array.isArray(requirement.preferredRoomIds) && requirement.preferredRoomIds.length) {
        rooms = [...requirement.preferredRoomIds];
    } else if (Array.isArray(requirement.allowedRoomIds) && requirement.allowedRoomIds.length) {
        rooms = [...requirement.allowedRoomIds];
    } else if (Array.isArray(task.allowedRoomIds) && task.allowedRoomIds.length) {
        rooms = [...task.allowedRoomIds];
    } else {
        rooms = [task.roomId].filter(Boolean);
    }
    const requiredTags = Array.isArray(requirement.requiredTags) ? requirement.requiredTags.filter(Boolean) : [];
    if (!rooms.length && project && requiredTags.length) {
        rooms = (project.rooms || [])
            .filter(room => requiredTags.every(tag => (room.tags || []).includes(tag)))
            .map(room => room.id);
    }
    const hasExplicitRoomConstraint = Boolean(
        task.roomId
        || (task.allowedRoomIds || []).length
        || (requirement.preferredRoomIds || []).length
        || (requirement.allowedRoomIds || []).length
        || requiredTags.length,
    );
    if (!rooms.length && hasExplicitRoomConstraint) return [];
    return rooms.length ? rooms : [null];
}

function getCandidateBlocks(project, usage, task) {
    const candidates = [];
    for (const day of getActiveWeekdays(project)) {
        for (const period of getActivePeriods(project)) {
            if (!hasConsecutiveActivePeriods(project, period, task.blockSize)) continue;
            for (const roomId of roomCandidatesForTask(task, project)) {
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

function courseIntervalPenalty(project, slots, task, day) {
    const gap = Number.parseInt(project.rules?.softRules?.spreadSubjectGaps?.[task.subjectId], 10) || 0;
    if (gap <= 1) return 0;
    let penalty = 0;
    for (const slot of slots) {
        if (slot.classId !== task.classId || slot.subjectId !== task.subjectId) continue;
        const dayDistance = Math.abs(Number(slot.day) - Number(day));
        if (dayDistance < gap) penalty += (gap - dayDistance) * 12;
    }
    return penalty;
}

function candidateScore(project, usage, slots, task, candidate) {
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const morningSubjects = new Set(project.rules.softRules.morningSubjects || []);
    const afternoonSubjects = new Set(project.rules.softRules.afternoonSubjects || []);
    const preferredPeriods = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKey = `${candidate.day}-${candidate.period}`;
    const preferenceWeight = Math.max(1, Math.min(100, Number.parseInt(preferredPeriods?.weight, 10) || 20));
    let score = candidate.day * 0.2 + candidate.period * 0.1;

    if (morningSubjects.has(task.subjectId)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (afternoonSubjects.has(task.subjectId)) {
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
    if (preferredPeriods?.prefer?.includes(candidateKey)) score -= preferenceWeight * 2;
    if (preferredPeriods?.avoid?.includes(candidateKey)) score += preferenceWeight * 2;
    score += getExistingAdjacentPenalty(slots, task, candidate.day, candidate.period, task.blockSize);
    score += courseIntervalPenalty(project, slots, task, candidate.day);
    score += advancedCandidatePenalty(project, slots, { ...task, ...candidate });
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

function teacherGapPreferenceScore(slots, teacherId, day, period, blockSize) {
    let penalty = 0;
    for (const slot of slots) {
        if (slot.day !== day || !slotTeacherIds(slot).includes(teacherId)) continue;
        const distance = Math.abs(Number(slot.period) - Number(period));
        if (distance === 0) continue;
        penalty += distance <= blockSize ? -4 : Math.min(18, (distance - 1) * 4);
    }
    return penalty;
}

function reservedPreferredSlotPenalty(project, task, candidateKey) {
    const preferredRules = project.rules?.softRules?.subjectPreferredPeriods || {};
    let penalty = 0;
    for (const [subjectId, rule] of Object.entries(preferredRules)) {
        if (subjectId === task.subjectId) continue;
        if ((rule.prefer || []).includes(candidateKey)) {
            const weight = Math.max(1, Math.min(100, Number.parseInt(rule.weight, 10) || 20));
            penalty += weight * 2;
        }
    }
    return penalty;
}

function candidateScoreV2(project, usage, slots, task, candidate) {
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const morningSubjects = new Set(project.rules.softRules.morningSubjects || []);
    const afternoonSubjects = new Set(project.rules.softRules.afternoonSubjects || []);
    const preferredPeriods = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKey = `${candidate.day}-${candidate.period}`;
    const preferenceWeight = Math.max(1, Math.min(100, Number.parseInt(preferredPeriods?.weight, 10) || 20));
    const teacherGapWeight = Number.parseInt(project.rules.softRules.teacherGapWeight, 10) || 0;
    let score = candidate.day * 0.2 + candidate.period * 0.1;

    if (morningSubjects.has(task.subjectId)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (afternoonSubjects.has(task.subjectId)) {
        score += isMorning(project, candidate.period) ? 8 : -8;
    }

    score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 16;
    if ((project.rules.softRules.spreadSubjects || []).includes(task.subjectId)) {
        score += (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) * 20;
    }
    for (const teacherId of slotTeacherIds(task)) {
        score += (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) * 2;
        score += teacherGapWeight > 0
            ? teacherGapPreferenceScore(slots, teacherId, candidate.day, candidate.period, task.blockSize) * teacherGapWeight
            : teacherAdjacentPenalty(slots, teacherId, candidate.day, candidate.period, task.blockSize);
        const limit = project.rules.softRules.teacherLimits?.[teacherId]?.daily;
        if (Number.isInteger(limit) && (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) >= limit) {
            score += 60;
        }
    }
    if (preferredPeriods?.prefer?.includes(candidateKey)) score -= preferenceWeight * 2;
    if (preferredPeriods?.avoid?.includes(candidateKey)) score += preferenceWeight * 2;
    score += reservedPreferredSlotPenalty(project, task, candidateKey);
    score += getExistingAdjacentPenalty(slots, task, candidate.day, candidate.period, task.blockSize);
    score += courseIntervalPenalty(project, slots, task, candidate.day);
    score += advancedCandidatePenalty(project, slots, { ...task, ...candidate });
    score -= (subject?.priority || 50) / 100;

    return score;
}

function candidateTimeWindowCount(candidates = []) {
    return new Set(candidates.map(candidate => `${candidate.day}-${candidate.period}`)).size;
}

function buildCandidatePressureContext(project, usage, tasks = []) {
    const taskCandidateCounts = new Map();
    const slotPressure = new Map();
    const timePressure = new Map();
    const classDemand = new Map();
    const teacherDemand = new Map();
    const roomDemand = new Map();
    const taskWork = new Map();
    let minCandidateCount = Infinity;

    for (const task of tasks) {
        const candidates = getCandidateBlocks(project, usage, task);
        const candidatesByTime = new Map();
        for (const candidate of candidates) {
            const timeKey = `${candidate.day}-${candidate.period}`;
            if (!candidatesByTime.has(timeKey)) candidatesByTime.set(timeKey, []);
            candidatesByTime.get(timeKey).push(candidate);
        }
        const timeWindowCount = candidateTimeWindowCount(candidates);
        taskCandidateCounts.set(task.id, timeWindowCount);
        minCandidateCount = Math.min(minCandidateCount, timeWindowCount);

        const subject = project.subjects.find(item => item.id === task.subjectId);
        const priority = Number(subject?.priority ?? 50);
        const teacherCount = Math.max(1, slotTeacherIds(task).length);
        const workMetric = Math.max(1, task.blockSize || 1)
            + priority / 100
            + (teacherCount - 1) * 0.5
            + (task.roomId || (task.allowedRoomIds || []).length ? 0.35 : 0);
        taskWork.set(task.id, workMetric);
        const contribution = workMetric / Math.max(1, timeWindowCount);

        bumpCount(classDemand, task.classId, Math.max(1, task.blockSize || 1));
        for (const teacherId of slotTeacherIds(task)) bumpCount(teacherDemand, teacherId, Math.max(1, task.blockSize || 1));
        for (const roomId of roomCandidatesForTask(task, project)) {
            if (roomId) bumpCount(roomDemand, roomId, Math.max(1, task.blockSize || 1));
        }

        for (const [timeKey, timeCandidates] of candidatesByTime) {
            bumpCount(timePressure, timeKey, contribution);
            const placementContribution = contribution / Math.max(1, timeCandidates.length);
            for (const candidate of timeCandidates) {
                bumpCount(slotPressure, candidateTieKey(candidate), placementContribution);
            }
        }
    }

    const maxSlotPressure = Math.max(0, ...slotPressure.values());
    const maxTimePressure = Math.max(0, ...timePressure.values());
    const maxResourceDemand = Math.max(0, ...classDemand.values(), ...teacherDemand.values(), ...roomDemand.values());

    return {
        taskCandidateCounts,
        slotPressure,
        timePressure,
        classDemand,
        teacherDemand,
        roomDemand,
        taskWork,
        stats: {
            taskCount: tasks.length,
            minCandidateCount: Number.isFinite(minCandidateCount) ? minCandidateCount : 0,
            maxSlotPressure,
            maxTimePressure,
            maxNormalizedSlotPressure: maxSlotPressure ? 1 : 0,
            maxResourceDemand,
        },
    };
}

function candidatePressureScore(pressureContext, task = {}, candidate = {}) {
    if (!pressureContext) return 0;
    const slot = pressureContext.slotPressure.get(candidateTieKey(candidate)) || 0;
    const time = pressureContext.timePressure.get(`${candidate.day}-${candidate.period}`) || 0;
    const slotNorm = pressureContext.stats?.maxSlotPressure ? slot / pressureContext.stats.maxSlotPressure : 0;
    const timeNorm = pressureContext.stats?.maxTimePressure ? time / pressureContext.stats.maxTimePressure : 0;
    const classDemand = pressureContext.classDemand.get(task.classId) || 0;
    const teacherDemand = slotTeacherIds(task).reduce((sum, teacherId) => sum + (pressureContext.teacherDemand.get(teacherId) || 0), 0);
    const roomDemand = candidate.roomId ? (pressureContext.roomDemand.get(candidate.roomId) || 0) : 0;
    const resourceDemand = classDemand + teacherDemand * 0.65 + roomDemand * 0.8;
    const resourceNorm = pressureContext.stats?.maxResourceDemand ? resourceDemand / pressureContext.stats.maxResourceDemand : 0;
    const scarcity = 1 / Math.max(1, pressureContext.taskCandidateCounts.get(task.id) || 1);
    const workMetric = pressureContext.taskWork.get(task.id) || 1;
    return slotNorm * 16
        + timeNorm * 6
        + resourceNorm * 10
        + scarcity * workMetric * 4;
}

function strategyCandidateScore(project, usage, slots, task, candidate, pressureContext, extraPenalty = 0) {
    return candidateScoreV2(project, usage, slots, task, candidate)
        + candidatePressureScore(pressureContext, task, candidate)
        + extraPenalty;
}

function candidateBlockKeys(task, candidate) {
    return Array.from({ length: Math.max(1, task.blockSize || 1) }, (_, offset) => `${candidate.day}-${candidate.period + offset}`);
}

function softRuleChecks(project, usage, task, candidate) {
    const softRules = project.rules?.softRules || {};
    const morningSubjects = new Set(softRules.morningSubjects || []);
    const afternoonSubjects = new Set(softRules.afternoonSubjects || []);
    const preferredPeriods = softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKeys = candidateBlockKeys(task, candidate);
    const checks = [];

    if (morningSubjects.has(task.subjectId)) {
        checks.push({
            code: 'morning_subject',
            weight: 80,
            violated: candidateKeys.some(key => !isMorning(project, Number(key.split('-')[1]))),
        });
    }

    if (afternoonSubjects.has(task.subjectId)) {
        checks.push({
            code: 'afternoon_subject',
            weight: 80,
            violated: candidateKeys.some(key => isMorning(project, Number(key.split('-')[1]))),
        });
    }

    if ((softRules.spreadSubjects || []).includes(task.subjectId)) {
        checks.push({
            code: 'subject_spread',
            weight: 70,
            violated: (usage.classSubjectDay.get(`${task.classId}:${task.subjectId}:${candidate.day}`) || 0) > 0,
        });
    }

    const minGapDays = Number.parseInt(softRules.spreadSubjectGaps?.[task.subjectId], 10) || 0;
    if (minGapDays > 1) {
        checks.push({
            code: 'course_interval',
            weight: 75,
            violated: (usage.entries || []).some(slot => (
                slot.classId === task.classId
                && slot.subjectId === task.subjectId
                && Math.abs(Number(slot.day) - Number(candidate.day)) < minGapDays
            )),
        });
    }

    for (const teacherId of slotTeacherIds(task)) {
        const limit = softRules.teacherLimits?.[teacherId]?.daily;
        if (Number.isInteger(Number(limit))) {
            checks.push({
                code: `teacher_daily:${teacherId}`,
                weight: 90,
                violated: (usage.teacherDay.get(`${teacherId}:${candidate.day}`) || 0) >= Number(limit),
            });
        }
    }

    if (preferredPeriods) {
        const weight = Math.max(-1, Math.min(100, Number.parseInt(preferredPeriods.weight, 10) || 20));
        if ((preferredPeriods.prefer || []).length) {
            checks.push({
                code: 'preferred_period',
                weight,
                violated: !candidateKeys.some(key => preferredPeriods.prefer.includes(key)),
            });
        }
        if ((preferredPeriods.avoid || []).length) {
            checks.push({
                code: 'avoid_period',
                weight,
                violated: candidateKeys.some(key => preferredPeriods.avoid.includes(key)),
            });
        }
    }

    return checks.filter(check => check.violated);
}

function evaluateSoftEnforcement(project, usage, task, candidate, { stats }) {
    const checks = softRuleChecks(project, usage, task, candidate);
    for (const check of checks) {
        stats.evaluations += 1;
        // Soft rules are scoring signals only; they never remove an otherwise
        // valid candidate from the hard scheduling domain.
        stats.skipped += 1;
    }
    return { ok: true, penalty: 0, rejected: 0 };
}

function chooseWeightedCandidate(candidates, seed, taskId, passName) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    if (candidates[1].score - candidates[0].score >= 8) return candidates[0];
    const limited = candidates.slice(0, Math.min(8, candidates.length));
    const minScore = Math.min(...limited.map(candidate => candidate.score));
    const weighted = limited.map(candidate => ({
        candidate,
        weight: 1 / (1 + Math.max(0, candidate.score - minScore)),
    }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let cursor = (seededHash(seed || DEFAULT_TIMETABLE_TIE_BREAK_SEED, `${taskId}:${passName}:weighted-choice`) / 0x100000000) * total;
    for (const item of weighted) {
        cursor -= item.weight;
        if (cursor <= 0) return item.candidate;
    }
    return weighted[weighted.length - 1].candidate;
}

function buildRoomCampusMap(project = {}) {
    return new Map((project.rooms || []).map(room => [room.id, room.campusId || '']));
}

function roomRequirementForSubject(project = {}, subjectId = '') {
    const rule = project.rules?.hardRules?.roomRequirements?.[subjectId] || {};
    const roomIds = [...new Set(rule.roomIds || [])];
    const requiredTags = [...new Set(rule.requiredTags || [])];
    if (requiredTags.length) {
        for (const room of project.rooms || []) {
            const tags = new Set(room.tags || []);
            if (requiredTags.every(tag => tags.has(tag)) && room.id && !roomIds.includes(room.id)) {
                roomIds.push(room.id);
            }
        }
    }
    return { roomIds, requiredTags };
}

function taskMetadataForPlan(project = {}, plan = null, overrides = {}) {
    const roomCampus = overrides.roomCampus || buildRoomCampusMap(project);
    const classId = overrides.classId || plan?.classId || null;
    const teacherId = overrides.teacherId || plan?.teacherId || null;
    const teacherIds = slotTeacherIds({
        teacherId,
        teacherIds: overrides.teacherIds || plan?.teacherIds || [],
    });
    const roomId = Object.prototype.hasOwnProperty.call(overrides, 'roomId')
        ? overrides.roomId
        : plan?.roomId || null;
    const teachingGroupId = overrides.teachingGroupId || plan?.teachingGroupId || '';
    const planLike = {
        ...(plan || {}),
        classId,
        classIds: overrides.classIds || plan?.classIds || [],
        teachingGroupId,
    };
    const teachingGroup = teachingGroupForPlan(project, planLike);
    const campusId = overrides.campusId
        || plan?.campusId
        || (roomId ? roomCampus.get(roomId) : '')
        || project.classes?.find(item => item.id === classId)?.campusId
        || project.teachers?.find(item => item.id === teacherId)?.campusId
        || '';
    const ruleRoomRequirement = roomRequirementForSubject(project, plan?.subjectId || '');
    const allowedRoomIds = [...new Set([
        ...(plan?.allowedRoomIds || []),
        ...ruleRoomRequirement.roomIds,
    ].filter(Boolean))];
    const planRequirement = plan?.roomRequirement || { preferredRoomIds: [], allowedRoomIds: [], requiredTags: [] };
    return {
        teacherIds,
        roomId,
        allowedRoomIds,
        roomRequirement: {
            preferredRoomIds: planRequirement.preferredRoomIds || [],
            allowedRoomIds: [...new Set([...(planRequirement.allowedRoomIds || []), ...ruleRoomRequirement.roomIds])],
            requiredTags: [...new Set([...(planRequirement.requiredTags || []), ...ruleRoomRequirement.requiredTags])],
        },
        weekPattern: overrides.weekPattern || plan?.weekPattern || 'every',
        campusId,
        roomCampus,
        teachingGroupId,
        teachingGroupName: teachingGroup?.name || '',
        classIds: classIdsForPlan(project, planLike),
    };
}

function expandLessonPlanTasks(project, placedCountByPlan) {
    const tasks = [];
    const roomCampus = buildRoomCampusMap(project);
    for (const plan of project.lessonPlans) {
        const metadata = taskMetadataForPlan(project, plan, { roomCampus });
        const alreadyPlaced = placedCountByPlan.get(plan.id) || 0;
        let remaining = Math.max(0, plan.weeklyHours - alreadyPlaced);
        let blockIndex = placedBlockCountForPlan(plan, alreadyPlaced, project);
        const addTask = blockSize => {
            blockIndex += 1;
            tasks.push({
                id: `${plan.id}_${blockIndex}`,
                lessonPlanId: plan.id,
                classId: plan.classId,
                subjectId: plan.subjectId,
                teacherId: plan.teacherId,
                teacherIds: metadata.teacherIds,
                roomId: metadata.roomId,
                allowedRoomIds: metadata.allowedRoomIds,
                roomRequirement: metadata.roomRequirement,
                weekPattern: metadata.weekPattern,
                campusId: metadata.campusId,
                roomCampus: metadata.roomCampus,
                teachingGroupId: metadata.teachingGroupId,
                teachingGroupName: metadata.teachingGroupName,
                classIds: metadata.classIds,
                blockSize,
                blockId: blockSize > 1 ? `${plan.id}_block_${blockIndex}` : null,
            });
            remaining -= blockSize;
        };

        const blockPreference = advancedBlockPreference(project, plan);
        if (blockPreference === 'double') {
            while (remaining >= 2) addTask(2);
        } else if (blockPreference === 'mixed' && remaining >= 4) {
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

function occupiedKeysForCandidate(task = {}, candidate = {}) {
    return Array.from({ length: Math.max(1, Number(task.blockSize) || 1) }, (_, offset) => (
        `${candidate.day}-${Number(candidate.period) + offset}`
    ));
}

/**
 * A SchedulingUnit is the hard-domain view of a single lesson or an entire
 * consecutive block. It is intentionally independent of display labels.
 */
export function buildSchedulingUnits(input = {}) {
    const project = normalizeTimetableProject(input);
    const tasks = expandLessonPlanTasks(project, new Map());
    const emptyUsage = createTimetableUsage();
    return tasks.map(task => {
        const candidates = getCandidateBlocks(project, emptyUsage, task)
            .map(candidate => ({
                ...candidate,
                occupiedKeys: occupiedKeysForCandidate(task, candidate),
            }));
        return {
            id: task.id,
            lessonPlanId: task.lessonPlanId,
            classIds: [...new Set(task.classIds || [task.classId].filter(Boolean))],
            teacherIds: [...new Set(slotTeacherIds(task))],
            blockId: task.blockId || null,
            blockSize: Math.max(1, Number(task.blockSize) || 1),
            allowedRoomIds: roomCandidatesForTask(task, project).filter(Boolean),
            candidates,
        };
    });
}

function feasibilityIssue(code, message, unit = {}, extra = {}) {
    return {
        code,
        severity: 'hard',
        message,
        lessonPlanId: unit.lessonPlanId || null,
        taskId: unit.id || null,
        classIds: unit.classIds || [],
        teacherIds: unit.teacherIds || [],
        blockSize: unit.blockSize || 1,
        suggestion: extra.suggestion || '检查相关硬约束或增加可用时段、教师、班级或教室容量。',
        ...extra,
    };
}

function capacityIssuesForUnits(units = []) {
    const resources = new Map();
    const register = (kind, id, unit) => {
        if (!id) return;
        const key = `${kind}:${id}`;
        if (!resources.has(key)) resources.set(key, { kind, id, units: [] });
        resources.get(key).units.push(unit);
    };
    for (const unit of units) {
        unit.classIds.forEach(id => register('class', id, unit));
        unit.teacherIds.forEach(id => register('teacher', id, unit));
        if (unit.allowedRoomIds.length === 1) register('room', unit.allowedRoomIds[0], unit);
    }
    const issues = [];
    for (const resource of resources.values()) {
        const demand = resource.units.reduce((sum, unit) => sum + unit.blockSize, 0);
        const available = new Set(resource.units.flatMap(unit => unit.candidates.flatMap(candidate => candidate.occupiedKeys))).size;
        if (demand <= available) continue;
        issues.push({
            code: 'resource_capacity_exceeded',
            severity: 'hard',
            resourceKind: resource.kind,
            resourceId: resource.id,
            demand,
            available,
            message: `${resource.kind} ${resource.id} 需要 ${demand} 个课时，但显式规则下最多只有 ${available} 个可用时隙。`,
            suggestion: '放宽该资源的不可排或固定安排，或增加可用时段/可替代资源。',
        });
    }
    return issues;
}

function lockedRuleMatchesPlan(rule = {}, plan = {}) {
    if (rule.lessonPlanId) return rule.lessonPlanId === plan.id;
    return rule.classId === plan.classId
        && rule.subjectId === plan.subjectId
        && (!rule.teacherId || slotTeacherIds(plan).includes(rule.teacherId));
}

function lockedSlotIssues(project = {}, units = []) {
    const rules = project.rules?.hardRules?.lockedSlots || [];
    const issues = [];
    const occupied = new Map();
    const seenPlanSlots = new Set();
    for (const rule of rules) {
        const day = Number(rule.day);
        const period = Number(rule.period);
        const key = `${day}-${period}`;
        const plan = (project.lessonPlans || []).find(item => lockedRuleMatchesPlan(rule, item));
        if (!plan) {
            issues.push({
                code: 'fixed_slot_unmatched',
                severity: 'hard',
                slot: key,
                message: `固定课 ${key} 找不到匹配的任课计划。`,
                suggestion: '检查固定课的班级、课程、教师或任课计划 ID。',
            });
            continue;
        }
        if (!isActiveTimetableSlot(project, day, period)) {
            issues.push({
                code: 'fixed_slot_unavailable',
                lessonPlanId: plan.id,
                slot: key,
                message: `任课计划 ${plan.id} 被固定到未启用的时隙 ${key}。`,
                suggestion: '启用该星期/节次，或把固定课移到有效时隙。',
            });
        }
        const unit = units.find(item => item.lessonPlanId === plan.id);
        const sameSlotKey = `${plan.id}|${key}`;
        if (seenPlanSlots.has(sameSlotKey)) continue;
        seenPlanSlots.add(sameSlotKey);

        const existing = occupied.get(key) || [];
        for (const other of existing) {
            const sameClass = other.classId && other.classId === plan.classId;
            const sameTeacher = other.teacherId && other.teacherId === plan.teacherId;
            const sameRoom = rule.roomId && other.roomId && rule.roomId === other.roomId;
            if (sameClass || sameTeacher || sameRoom) {
                issues.push({
                    code: 'fixed_slot_conflict',
                    slot: key,
                    lessonPlanId: plan.id,
                    conflictsWith: other.lessonPlanId,
                    message: `固定课 ${key} 同时占用了冲突的班级、教师或教室资源。`,
                    suggestion: '移动其中一条固定课，或取消其中一条固定安排。',
                });
            }
        }
        if (!occupied.has(key)) occupied.set(key, []);
        occupied.get(key).push({
            lessonPlanId: plan.id,
            classId: plan.classId,
            teacherId: plan.teacherId,
            roomId: rule.roomId || null,
            unitId: unit?.id || null,
        });
    }
    return issues;
}

export function analyzeTimetableFeasibility(input = {}) {
    const project = normalizeTimetableProject(input);
    const units = buildSchedulingUnits(project);
    const issues = [];
    for (const unit of units) {
        if (unit.candidates.length) continue;
        issues.push(feasibilityIssue(
            'candidate_domain_empty',
            `任课计划 ${unit.lessonPlanId} 的 ${unit.blockSize} 节排课单元没有满足硬约束的候选时段。`,
            unit,
            { suggestion: '检查不可排、固定课、连续课长度及教室范围；至少保留一个完整可用时段。' },
        ));
    }
    issues.push(...lockedSlotIssues(project, units));

    const teacherDemand = new Map();
    for (const unit of units) {
        for (const teacherId of unit.teacherIds) {
            teacherDemand.set(teacherId, (teacherDemand.get(teacherId) || 0) + unit.blockSize);
        }
    }
    for (const [teacherId, demand] of teacherDemand) {
        const limit = Number.parseInt(project.rules?.hardRules?.teacherWeeklyLimit?.[teacherId], 10);
        if (!Number.isInteger(limit) || limit <= 0 || demand <= limit) continue;
        issues.push({
            code: 'teacher_weekly_limit_exceeded',
            severity: 'hard',
            teacherId,
            demand,
            limit,
            message: `教师 ${teacherId} 有 ${demand} 节任课需求，超过显式每周上限 ${limit}。`,
            suggestion: '提高该教师周课时上限、调整任课分配，或减少对应课时。',
        });
    }
    // Capacity is a proof only for the simple, empty-schedule model. Existing
    // protected placements and alternate-week teaching groups require the full
    // constraint model; treating this coarse count as a proof there would reject
    // otherwise feasible projects before repair or Timefold can run.
    if (!isComplexTimetableModel(project) && !(project.schedule?.slots || []).length) {
        issues.push(...capacityIssuesForUnits(units));
    }

    const candidateCounts = units.map(unit => unit.candidates.length);
    return {
        status: issues.length ? 'input_infeasible' : 'feasible',
        issues,
        units,
        candidateDomainStats: {
            unitCount: units.length,
            emptyUnitCount: candidateCounts.filter(count => count === 0).length,
            minCandidateCount: candidateCounts.length ? Math.min(...candidateCounts) : 0,
            maxCandidateCount: candidateCounts.length ? Math.max(...candidateCounts) : 0,
        },
    };
}

function infeasibleSchedule(project, audit, feasibility, startedAt, seed) {
    const unplaced = feasibility.units.map(unit => ({
        taskId: unit.id,
        lessonPlanId: unit.lessonPlanId,
        classIds: unit.classIds,
        teacherIds: unit.teacherIds,
        blockSize: unit.blockSize,
        lessonHours: unit.blockSize,
        reason: '输入硬约束不存在可行候选域或资源容量不足',
        reasonCode: 'input_infeasible',
    }));
    const conflicts = [
        ...feasibility.issues.map(issue => ({
            type: issue.code,
            severity: 'hard',
            message: issue.message,
            issue,
        })),
        ...buildUnplacedConflicts(unplaced),
    ];
    const schedule = {
        id: `schedule_preflight_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        source: 'preflight_rejected',
        slots: [],
        lockedSlots: [],
        conflicts,
        unplaced,
        audit,
        qualityIssues: [],
        score: buildTimetableScore(project, [], unplaced, conflicts),
        solverStats: {
            solverUsed: false,
            phase: 'feasibility_preflight',
            status: 'failed',
            strategy: 'data_derived_domain',
            ...scheduleSeedPatch(seed),
            lessonCount: project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0),
            placedLessons: 0,
            unplacedLessons: unplaced.reduce((sum, item) => sum + item.lessonHours, 0),
            hardConflicts: feasibility.issues.length,
            accepted: false,
            reason: 'input_infeasible',
            solveMs: Date.now() - startedAt,
            feasibility: {
                status: feasibility.status,
                issues: feasibility.issues,
                candidateDomainStats: feasibility.candidateDomainStats,
            },
        },
    };
    attachPublication(project, schedule);
    return { success: false, project: { ...project, schedule }, schedule };
}

function taskDifficulty(project, usage, task, pressureContext = null) {
    const candidates = pressureContext?.taskCandidateCounts?.get(task.id) ?? getCandidateBlocks(project, usage, task).length;
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const priority = Number(subject?.priority ?? 50);
    const teacherCount = Math.max(1, slotTeacherIds(task).length);
    const roomConstrained = task.roomId
        || (Array.isArray(task.allowedRoomIds) && task.allowedRoomIds.length)
        || (Array.isArray(task.roomRequirement?.preferredRoomIds) && task.roomRequirement.preferredRoomIds.length)
        || (Array.isArray(task.roomRequirement?.allowedRoomIds) && task.roomRequirement.allowedRoomIds.length)
        || (Array.isArray(task.roomRequirement?.requiredTags) && task.roomRequirement.requiredTags.length)
        ? 1
        : 0;
    const preferredPeriods = project.rules?.softRules?.subjectPreferredPeriods?.[task.subjectId] || null;
    const preferenceWeight = preferredPeriods ? Math.max(1, Math.min(100, Number.parseInt(preferredPeriods.weight, 10) || 20)) : 0;
    const classDemand = pressureContext?.classDemand?.get(task.classId) || 0;
    const teacherDemand = slotTeacherIds(task).reduce((sum, teacherId) => sum + (pressureContext?.teacherDemand?.get(teacherId) || 0), 0);
    const roomDemand = roomCandidatesForTask(task, project)
        .filter(Boolean)
        .reduce((sum, roomId) => sum + (pressureContext?.roomDemand?.get(roomId) || 0), 0);
    return candidates * 100
        - Math.max(1, task.blockSize || 1) * 18
        - priority
        - (teacherCount - 1) * 16
        - roomConstrained * 14
        - Math.min(220, preferenceWeight * 4)
        - Math.min(40, classDemand + teacherDemand * 0.5 + roomDemand * 0.5);
}

function taskPreferenceRank(project, task) {
    return project.rules?.softRules?.subjectPreferredPeriods?.[task.subjectId] ? 0 : 1;
}

function taskResourcePressure(project, pressureContext, task) {
    const classDemand = pressureContext?.classDemand?.get(task.classId) || 0;
    const teacherDemand = slotTeacherIds(task)
        .reduce((sum, teacherId) => sum + (pressureContext?.teacherDemand?.get(teacherId) || 0), 0);
    const roomDemand = roomCandidatesForTask(task, project)
        .filter(Boolean)
        .reduce((sum, roomId) => sum + (pressureContext?.roomDemand?.get(roomId) || 0), 0);
    return classDemand + teacherDemand + roomDemand;
}

function makeSlot(task, day, period, index = 0, locked = false, roomId = undefined) {
    const finalRoomId = roomId === undefined ? task.roomId || null : roomId;
    return {
        id: `${locked ? 'locked' : 'slot'}_${task.lessonPlanId || task.id}_${task.classId}_${day}_${period}_${index}`,
        day,
        period,
        classId: task.classId,
        subjectId: task.subjectId,
        teacherId: task.teacherId,
        teacherIds: slotTeacherIds(task),
        lessonPlanId: task.lessonPlanId || null,
        roomId: finalRoomId,
        weekPattern: task.weekPattern || 'every',
        campusId: (finalRoomId && task.roomCampus?.get?.(finalRoomId)) || task.campusId || '',
        teachingGroupId: task.teachingGroupId || '',
        classIds: task.classIds || [task.classId].filter(Boolean),
        blockId: task.blockId || null,
        blockIndex: index,
        blockSize: Math.max(1, task.blockSize || 1),
        locked,
    };
}

function hasSimpleEdgeColoringShape(project) {
    if (isComplexTimetableModel(project)) return false;
    if ((project.rules?.hardRules?.lockedSlots || []).length > 0) return false;
    if ((project.schedule?.slots || []).some(slot => slot.locked || slot.manuallyAdjusted)) return false;
    if (Object.keys(project.rules?.hardRules?.teacherUnavailable || {}).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.classUnavailable || {}).length > 0) return false;
    if ((project.rules?.hardRules?.globalUnavailable || []).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.subjectDailyLimit || {}).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.teacherWeeklyLimit || {}).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.teacherMaxDaysPerWeek || {}).length > 0) return false;
    if ((project.rules?.hardRules?.teacherMutualExclusion || []).length > 0) return false;
    if ((project.rules?.hardRules?.subjectNotSameDay || []).length > 0) return false;
    if (Object.keys(project.rules?.hardRules?.roomRequirements || {}).length > 0) return false;
    if ((project.teachers || []).some(teacher => (teacher.unavailableSlots || []).length > 0)) return false;
    if ((project.lessonPlans || []).some(plan => slotTeacherIds(plan).length !== 1)) return false;
    if ((project.lessonPlans || []).some(plan => plan.roomId || (plan.allowedRoomIds || []).length > 0)) return false;
    const classIds = new Set((project.classes || []).map(item => item.id));
    const subjectIds = new Set((project.subjects || []).map(item => item.id));
    const teacherIds = new Set((project.teachers || []).map(item => item.id));
    if ((project.lessonPlans || []).some(plan => (
        !classIds.has(plan.classId)
        || !subjectIds.has(plan.subjectId)
        || !teacherIds.has(plan.teacherId)
    ))) return false;
    // Edge-coloring assigns each lesson an independent colour (time slot); it cannot
    // keep the two halves of a 连堂/double block adjacent, so defer block plans to greedy.
    if ((project.lessonPlans || []).some(plan => plan.blockPreference !== 'single')) return false;
    return true;
}

function simpleEdgeFeasibility(project) {
    const activeWeekdays = getActiveWeekdays(project);
    const activePeriods = getActivePeriods(project);
    const periodCount = activeWeekdays.length * activePeriods.length;
    const classDemand = new Map();
    const teacherDemand = new Map();
    let unitCount = 0;
    for (const plan of project.lessonPlans || []) {
        const hours = Math.max(0, Number.parseInt(plan.weeklyHours, 10) || 0);
        unitCount += hours;
        classDemand.set(plan.classId, (classDemand.get(plan.classId) || 0) + hours);
        teacherDemand.set(plan.teacherId, (teacherDemand.get(plan.teacherId) || 0) + hours);
    }
    const issues = [];
    for (const [classId, demand] of classDemand) {
        if (demand > periodCount) {
            issues.push({
                code: 'class_capacity_overload',
                severity: 'hard',
                classId,
                demand,
                capacity: periodCount,
                message: `班级 ${classId} 的课时需求 ${demand} 超过可用时段容量 ${periodCount}。`,
                suggestion: '增加可用工作日或节次，或减少该班级的周课时。',
            });
        }
    }
    for (const [teacherId, demand] of teacherDemand) {
        if (demand > periodCount) {
            issues.push({
                code: 'teacher_capacity_overload',
                severity: 'hard',
                teacherId,
                demand,
                capacity: periodCount,
                message: `教师 ${teacherId} 的课时需求 ${demand} 超过可用时段容量 ${periodCount}。`,
                suggestion: '增加可用工作日或节次，或调整任课分配。',
            });
        }
    }
    return {
        status: issues.length ? 'input_infeasible' : 'feasible',
        issues,
        units: issues.length ? buildSchedulingUnits(project) : [],
        candidateDomainStats: {
            unitCount,
            emptyUnitCount: issues.length ? 0 : 0,
            minCandidateCount: unitCount ? periodCount : 0,
            maxCandidateCount: unitCount ? periodCount : 0,
        },
    };
}

// Soft-rule affinity of placing a task at (day, period). Higher = more desirable.
// Mirrors candidateScore's soft signals but as a positive "goodness" used to
// assign edge-coloring colours to concrete time slots.
function taskSlotAffinity(project, task, day, period, context = null) {
    const affinityContext = context || {
        subjectById: new Map((project.subjects || []).map(subject => [subject.id, subject])),
        morningSubjects: new Set(project.rules.softRules.morningSubjects || []),
        afternoonSubjects: new Set(project.rules.softRules.afternoonSubjects || []),
        preferred: project.rules.softRules.subjectPreferredPeriods || {},
        morningPeriods: new Set(getDayPartPeriods(project, 'morning')),
    };
    const subject = affinityContext.subjectById.get(task.subjectId);
    const morningSubjects = affinityContext.morningSubjects;
    const afternoonSubjects = affinityContext.afternoonSubjects;
    const preferred = affinityContext.preferred?.[task.subjectId] || null;
    const key = `${day}-${period}`;
    const morning = affinityContext.morningPeriods.has(Number(period));
    let affinity = 0;

    if (morningSubjects.has(task.subjectId)) {
        affinity += morning ? 18 : -14;
    }
    if (afternoonSubjects.has(task.subjectId)) {
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
function assignColorsToSlots(project, colorGroups, timetableSlots, seed = null) {
    const colorCount = colorGroups.length;
    const affinityContext = {
        subjectById: new Map((project.subjects || []).map(subject => [subject.id, subject])),
        morningSubjects: new Set(project.rules.softRules.morningSubjects || []),
        afternoonSubjects: new Set(project.rules.softRules.afternoonSubjects || []),
        preferred: project.rules.softRules.subjectPreferredPeriods || {},
        morningPeriods: new Set(getDayPartPeriods(project, 'morning')),
    };
    const groupScore = (group, slot) => group.reduce(
        (sum, entry) => sum + taskSlotAffinity(project, entry.task, slot.day, slot.period, affinityContext),
        0,
    );
    const pairs = [];
    for (let color = 0; color < colorCount; color++) {
        for (let slotIndex = 0; slotIndex < timetableSlots.length; slotIndex++) {
            pairs.push({ color, slotIndex, score: groupScore(colorGroups[color], timetableSlots[slotIndex]) });
        }
    }
    pairs.sort((left, right) => right.score - left.score
        || seededCompare(seed, `${left.color}:${left.slotIndex}`, `${right.color}:${right.slotIndex}`)
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

function blockSizesForPlan(plan, project = null) {
    let remaining = Math.max(0, Number.parseInt(plan.weeklyHours, 10) || 0);
    const sizes = [];
    const blockPreference = project ? advancedBlockPreference(project, plan) : plan.blockPreference;
    if (blockPreference === 'double') {
        while (remaining >= 2) {
            sizes.push(2);
            remaining -= 2;
        }
    } else if (blockPreference === 'mixed' && remaining >= 4) {
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

function placedBlockCountForPlan(plan, placedHours = 0, project = null) {
    let consumed = 0;
    let count = 0;
    for (const size of blockSizesForPlan(plan, project)) {
        if (consumed + size > placedHours) break;
        consumed += size;
        count += 1;
    }
    return count;
}

function nextLockedBlockSizeForPlan(plan, placedHours = 0, project = null) {
    let consumed = 0;
    for (const size of blockSizesForPlan(plan, project)) {
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
        for (const blockSize of blockSizesForPlan(plan, project)) {
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

function buildFastEdgeColoredSchedule(project, options = {}) {
    if (!hasSimpleEdgeColoringShape(project)) return null;
    const startedAt = Date.now();
    const seed = normalizeSolveSeed(options.seed);
    const audit = auditTimetableProject(project);

    const timetableSlots = getActiveSlotPairs(project);
    const periodCount = timetableSlots.length;
    const realClassIds = project.classes.map(item => item.id).sort();
    const realTeacherIds = project.teachers.map(item => item.id).sort();
    const tasks = expandSingleTeacherEdgeTasks(project);
    const pressureContext = buildCandidatePressureContext(project, createTimetableUsage(), tasks);
    const config = repairConfig(tasks.length);
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
    const colorToSlotIndex = assignColorsToSlots(project, colorGroups, timetableSlots, seed);
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
            strategyVersion: 'legacy_enhanced_v2',
            ...scheduleSeedPatch(seed),
            lessonCount: tasks.length,
            placedLessons: slots.length,
            unplacedLessons: unplaced.length,
            hardConflicts: conflicts.filter(conflict => conflict.severity === 'hard').length,
            softScore: null,
            localImproveMs: 0,
            solveMs: Date.now() - startedAt,
            accepted: true,
            reason: null,
            constructionPasses: [{
                name: 'edge_coloring',
                attempts: tasks.length,
                candidateChecks: tasks.length * Math.max(1, periodCount),
                softRejected: 0,
                placed: slots.length,
                unplaced: unplaced.length,
            }],
            pressureStats: pressureContext.stats,
            softEnforcement: {
                evaluations: 0,
                mandatory: 0,
                enforced: 0,
                skipped: 0,
                rejected: 0,
            },
            repairStats: {
                strategy: 'recursive_bounded_repair',
                attempts: 0,
                repaired: 0,
                relocatedBlockers: 0,
                rollbacks: 0,
                recursiveCalls: 0,
                tabuHits: 0,
                steps: 0,
                budget: config.stepBudget,
                maxDepth: config.maxDepth,
                maxCalls: config.maxCalls,
                shallowLimit: config.shallowLimit,
                maxBlockers: config.maxBlockers,
                bestSnapshotUsed: false,
                failures: {},
            },
            bestSnapshotStats: summarizeBestSnapshot('local_improvement', project, slots, unplaced, conflicts),
        },
    };
    schedule.solverStats.softScore = schedule.score.softScore;
    attachPublication(project, schedule);

    return {
        success: schedule.score.hardConflicts === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}

function cloneUsage(usage) {
    return {
        teacher: new Set(usage.teacher),
        class: new Set(usage.class),
        room: new Set(usage.room),
        entries: [...(usage.entries || [])],
        classSubjectDay: new Map(usage.classSubjectDay),
        teacherDay: new Map(usage.teacherDay),
    };
}

function restoreUsage(target, snapshot) {
    target.teacher = new Set(snapshot.teacher);
    target.class = new Set(snapshot.class);
    target.room = new Set(snapshot.room);
    target.entries = [...(snapshot.entries || [])];
    target.classSubjectDay = new Map(snapshot.classSubjectDay);
    target.teacherDay = new Map(snapshot.teacherDay);
}

function blockKeysForPlacement(task, day, period) {
    return Array.from({ length: Math.max(1, task.blockSize || 1) }, (_, offset) => `${day}-${period + offset}`);
}

function slotRelativeIndex(slot, fallback = 0) {
    return Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : fallback;
}

function slotsForGroup(slots, groupKey) {
    return slots
        .filter(slot => slotGroupKey(slot) === groupKey)
        .sort((left, right) => slotRelativeIndex(left) - slotRelativeIndex(right)
            || left.period - right.period
            || left.id.localeCompare(right.id));
}

function isProtectedGroup(group = []) {
    return group.some(slot => slot.locked || slot.manuallyAdjusted);
}

function taskFromSlotGroup(group = [], project = null) {
    const first = group[0] || {};
    const plan = project?.lessonPlans?.find(item => item.id === first.lessonPlanId) || null;
    const metadata = plan ? taskMetadataForPlan(project, plan) : null;
    return {
        id: slotGroupKey(first) || first.id,
        lessonPlanId: first.lessonPlanId || null,
        classId: first.classId || metadata?.classId || null,
        subjectId: first.subjectId || plan?.subjectId || null,
        teacherId: first.teacherId || metadata?.teacherId || null,
        teacherIds: slotTeacherIds(first).length ? slotTeacherIds(first) : (metadata?.teacherIds || []),
        roomId: metadata?.roomId || first.roomId || null,
        allowedRoomIds: metadata?.allowedRoomIds || (first.roomId ? [first.roomId] : []),
        roomRequirement: metadata?.roomRequirement || first.roomRequirement || { preferredRoomIds: [], allowedRoomIds: [], requiredTags: [] },
        weekPattern: first.weekPattern || metadata?.weekPattern || 'every',
        campusId: first.campusId || metadata?.campusId || '',
        teachingGroupId: first.teachingGroupId || metadata?.teachingGroupId || '',
        teachingGroupName: first.teachingGroupName || metadata?.teachingGroupName || '',
        classIds: slotClassIds(first).length ? slotClassIds(first) : (metadata?.classIds || []),
        blockId: first.blockId || null,
        blockSize: Math.max(1, group.length || first.blockSize || 1),
    };
}

function describeBlockingGroups(groups = []) {
    return groups.map(group => {
        const first = group[0] || {};
        return {
            slotId: first.id,
            groupId: slotGroupKey(first),
            lessonPlanId: first.lessonPlanId,
            classId: first.classId,
            subjectId: first.subjectId,
            teacherId: first.teacherId,
            day: first.day,
            period: first.period,
            periods: group.map(slot => slot.period),
            protected: isProtectedGroup(group),
        };
    });
}

function groupHasHardAlternative(project, group = [], forbiddenKeys = new Set()) {
    const task = taskFromSlotGroup(group, project);
    const emptyUsage = createTimetableUsage();
    for (const day of getActiveWeekdays(project)) {
        for (const period of getActivePeriods(project)) {
            if (!hasConsecutiveActivePeriods(project, period, task.blockSize)) continue;
            const blockKeys = blockKeysForPlacement(task, day, period);
            if (blockKeys.some(key => forbiddenKeys.has(key))) continue;
            for (const roomId of roomCandidatesForTask(task, project)) {
                const target = { ...task, roomId, day, period };
                if (blockFits(project, emptyUsage, target, day, period).ok) return true;
            }
        }
    }
    return false;
}

function blockerMobilityPenalty(project, blockers = [], forbiddenKeys = new Set()) {
    return blockers.reduce((sum, group) => {
        if (isProtectedGroup(group)) return sum + 8000;
        return sum + (groupHasHardAlternative(project, group, forbiddenKeys) ? 0 : 4000);
    }, 0);
}

function findBlockingGroups(project, slots, task, day, period, excludedGroupKeys = new Set()) {
    const taskTeachers = slotTeacherIds(task);
    const taskClasses = slotClassIds(task);
    const taskWeekPattern = weekPatternForSlot(project, task);
    const targetPeriods = new Set(
        Array.from({ length: Math.max(1, task.blockSize || 1) }, (_, offset) => period + offset),
    );
    const groups = new Map();

    for (const slot of slots) {
        const groupKey = slotGroupKey(slot);
        if (excludedGroupKeys.has(groupKey)) continue;
        if (slot.day !== day || !targetPeriods.has(slot.period)) continue;
        if (!weekPatternsOverlap(weekPatternForSlot(project, slot), taskWeekPattern)) continue;
        const conflicts = slotClassIds(slot).some(classId => taskClasses.includes(classId))
            || slotTeacherIds(slot).some(id => taskTeachers.includes(id))
            || (slot.roomId && task.roomId && slot.roomId === task.roomId);
        if (!conflicts) continue;
        if (!groups.has(groupKey)) groups.set(groupKey, slotsForGroup(slots, groupKey));
    }

    return [...groups.values()].sort((left, right) => {
        const leftFirst = left[0] || {};
        const rightFirst = right[0] || {};
        return String(leftFirst.id || '').localeCompare(String(rightFirst.id || ''));
    });
}

function repairFailureReason(code, detail = '') {
    const labels = {
        no_task: '缺少可修复任务',
        block_size: '连堂换位修复失败',
        no_candidate: '没有可尝试的目标节次',
        too_many_blockers: '目标节次阻塞课程过多',
        task_still_blocked: '移开阻塞课程后目标仍不可用',
        blocker_unmovable: '阻塞课程无法在预算内挪开',
        budget_exhausted: '换位修复预算已用完',
        max_depth: '换位递归深度已达上限',
        protected_blocker: '目标位置包含锁定或手动保护课程',
        tabu: '换位路径触发防循环规则',
    };
    const text = labels[code] || code;
    return detail ? `${text}：${detail}` : text;
}

function candidateListForRepair(project, usage, task, slots, pressureContext, forbiddenKeys = new Set(), excludedGroupKeys = new Set()) {
    const candidates = [];
    for (const day of getActiveWeekdays(project)) {
        for (const period of getActivePeriods(project)) {
            if (!hasConsecutiveActivePeriods(project, period, task.blockSize)) continue;
            const blockKeys = blockKeysForPlacement(task, day, period);
            if (blockKeys.some(key => forbiddenKeys.has(key))) continue;
            for (const roomId of roomCandidatesForTask(task, project)) {
                const target = { ...task, roomId, day, period };
                const check = blockFits(project, usage, target, day, period);
                const blockers = check.ok ? [] : findBlockingGroups(project, slots, target, day, period, excludedGroupKeys);
                const hardUnavailablePenalty = !check.ok && !blockers.length && !excludedGroupKeys.size ? 10000 : 0;
                const candidateForbiddenKeys = new Set([...forbiddenKeys, ...blockKeys]);
                const score = strategyCandidateScore(project, usage, slots, task, { day, period, roomId }, pressureContext)
                    + hardUnavailablePenalty
                    + blockerMobilityPenalty(project, blockers, candidateForbiddenKeys)
                    + blockers.length * 40
                    + blockers.reduce((sum, group) => sum + group.length, 0) * 12;
                candidates.push({ day, period, roomId, check, blockers, score });
            }
        }
    }
    return candidates.sort((left, right) => left.score - right.score
        || left.blockers.length - right.blockers.length
        || left.day - right.day
        || left.period - right.period
        || String(left.roomId || '').localeCompare(String(right.roomId || '')));
}

function removeGroupUsage(usage, group = []) {
    for (const slot of group) removeUsage(usage, slot);
}

function addGroupUsage(usage, group = []) {
    for (const slot of group) addUsage(usage, slot);
}

function addTaskPlacement(slots, usage, task, day, period, roomId) {
    for (let offset = 0; offset < Math.max(1, task.blockSize || 1); offset += 1) {
        const slot = makeSlot(task, day, period + offset, offset, false, roomId);
        slots.push(slot);
        addUsage(usage, slot);
    }
}

function moveExistingGroup(slots, usage, groupKey, day, period, roomId) {
    const group = slotsForGroup(slots, groupKey);
    const moved = new Map();
    for (const [index, slot] of group.entries()) {
        const relative = slotRelativeIndex(slot, index);
        const next = {
            ...slot,
            day,
            period: period + relative,
            roomId: roomId === undefined ? slot.roomId || null : roomId,
        };
        moved.set(slot.id, next);
        addUsage(usage, next);
    }
    for (const [index, slot] of slots.entries()) {
        if (moved.has(slot.id)) slots[index] = moved.get(slot.id);
    }
    return moved.size;
}

function resourceKeysForTask(project, task = {}) {
    const keys = new Set();
    for (const classId of slotClassIds(task)) {
        if (classId) keys.add(`class:${classId}`);
    }
    for (const teacherId of slotTeacherIds(task)) {
        if (teacherId) keys.add(`teacher:${teacherId}`);
    }
    for (const roomId of roomCandidatesForTask(task, project)) {
        if (roomId) keys.add(`room:${roomId}`);
    }
    return keys;
}

export function buildConflictComponent(project, slots, targetTask, maxGroups) {
    const groups = new Map();
    const targetKeys = resourceKeysForTask(project, targetTask);
    const preferredKeys = [...targetKeys].filter(key => key.startsWith('room:'));
    const componentKeys = preferredKeys.length
        ? new Set(preferredKeys)
        : new Set([...targetKeys].filter(key => key.startsWith('teacher:')));
    if (!componentKeys.size) {
        for (const key of targetKeys) componentKeys.add(key);
    }
    const grouped = new Map();
    for (const slot of slots) {
        const groupKey = slotGroupKey(slot);
        if (!grouped.has(groupKey)) grouped.set(groupKey, []);
        grouped.get(groupKey).push(slot);
    }
    for (const [groupKey, group] of grouped) {
        if (isProtectedGroup(group)) continue;
        const groupTask = taskFromSlotGroup(group, project);
        const groupKeys = resourceKeysForTask(project, groupTask);
        if (![...groupKeys].some(key => componentKeys.has(key))) continue;
        groups.set(groupKey, group);
        if (groups.size > maxGroups) return null;
    }
    return [...groups.values()];
}

function appendExistingGroupAt(slots, usage, group, task, candidate) {
    const roomId = candidate.roomId === undefined ? group[0]?.roomId || null : candidate.roomId;
    for (const [index, slot] of group.entries()) {
        const relative = Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : index;
        const next = {
            ...slot,
            day: candidate.day,
            period: candidate.period + relative,
            roomId,
        };
        slots.push(next);
        addUsage(usage, next);
    }
}

function repairUnplacedByComponent(project, slots, usage, entry) {
    const targetTask = entry?.task;
    if (!targetTask) return { ok: false, reasonCode: 'no_task' };
    const maxGroups = intEnv('TIMETABLE_COMPONENT_REPAIR_MAX_GROUPS', 12, { min: 1, max: 256 });
    const maxNodes = intEnv('TIMETABLE_COMPONENT_REPAIR_MAX_NODES', 4000, { min: 1, max: 50000 });
    const component = buildConflictComponent(project, slots, targetTask, maxGroups);
    if (!component) return { ok: false, reasonCode: 'component_too_large' };

    const removedIds = new Set(component.flatMap(group => group.map(slot => slot.id)));
    const baseSlots = slots.filter(slot => !removedIds.has(slot.id));
    const baseUsage = buildUsageExcluding(slots, removedIds);
    const entities = [
        { task: targetTask, group: null },
        ...component.map(group => ({ task: taskFromSlotGroup(group, project), group })),
    ];
    let nodes = 0;
    const search = (remaining, workingSlots, workingUsage) => {
        if (!remaining.length) return true;
        if (++nodes > maxNodes) return false;

        let selectedIndex = -1;
        let selectedCandidates = null;
        for (let index = 0; index < remaining.length; index += 1) {
            const entity = remaining[index];
            const candidates = candidateListForRepair(project, workingUsage, entity.task, workingSlots)
                .filter(candidate => candidate.check?.ok && !(candidate.blockers || []).length)
                .slice(0, 24);
            if (selectedCandidates === null || candidates.length < selectedCandidates.length) {
                selectedIndex = index;
                selectedCandidates = candidates;
                if (!candidates.length) break;
            }
        }
        if (selectedIndex < 0 || !selectedCandidates?.length) return false;

        const [entity] = remaining.splice(selectedIndex, 1);
        for (const candidate of selectedCandidates) {
            const slotSnapshot = workingSlots.slice();
            const usageSnapshot = cloneUsage(workingUsage);
            if (entity.group) appendExistingGroupAt(workingSlots, workingUsage, entity.group, entity.task, candidate);
            else addTaskPlacement(workingSlots, workingUsage, entity.task, candidate.day, candidate.period, candidate.roomId);
            if (search(remaining, workingSlots, workingUsage)) {
                remaining.splice(selectedIndex, 0, entity);
                return true;
            }
            workingSlots.splice(0, workingSlots.length, ...slotSnapshot);
            restoreUsage(workingUsage, usageSnapshot);
        }
        remaining.splice(selectedIndex, 0, entity);
        return false;
    };

    const workingSlots = baseSlots.slice();
    const workingUsage = cloneUsage(baseUsage);
    const ok = search(entities.slice(), workingSlots, workingUsage);
    if (!ok) return { ok: false, reasonCode: nodes > maxNodes ? 'component_budget_exhausted' : 'component_no_solution', nodes, componentSize: component.length };
    slots.splice(0, slots.length, ...workingSlots);
    restoreUsage(usage, workingUsage);
    return { ok: true, nodes, componentSize: component.length };
}

// Bounded local repair: for each unplaced single lesson, try to free a target
// slot by moving a small number of blockers. Failed branches restore both slots
// and usage before trying the next candidate.
function repairUnplaced(project, usage, slots, unplaced, pressureContext = null, taskCount = 0) {
    const config = repairConfig(taskCount || unplaced.length);
    let steps = 0;
    const stats = {
        strategy: 'recursive_bounded_repair',
        attempts: 0,
        repaired: 0,
        relocatedBlockers: 0,
        rollbacks: 0,
        recursiveCalls: 0,
        tabuHits: 0,
        steps: 0,
        budget: config.stepBudget,
        maxDepth: config.maxDepth,
        maxCalls: config.maxCalls,
        shallowLimit: config.shallowLimit,
        maxBlockers: config.maxBlockers,
        componentAttempts: 0,
        componentRepaired: 0,
        componentNodes: 0,
        componentFailures: {},
        bestSnapshotUsed: false,
        failures: {},
    };
    const tabu = new Map();

    const recordFailure = (entry, code, detail = '') => {
        stats.failures[code] = (stats.failures[code] || 0) + 1;
        entry.repairStatus = 'failed';
        entry.repairReasonCode = code;
        entry.repairReason = repairFailureReason(code, detail);
        entry.blocking = {
            reasonCode: code,
            reason: entry.repairReason,
            blockerCount: entry.blocking?.blockerCount ?? 0,
            blockers: entry.blocking?.blockers || [],
        };
    };

    const restoreBranch = (slotSnapshot, usageSnapshot) => {
        slots.splice(0, slots.length, ...slotSnapshot);
        restoreUsage(usage, usageSnapshot);
    };

    const placeEntityAt = (entity, candidate, depth, pathKeys = new Set(), forbiddenKeys = new Set(), excludedGroupKeys = new Set()) => {
        stats.recursiveCalls += 1;
        steps += 1;
        if (depth > config.maxDepth) return { ok: false, code: 'max_depth' };
        if (steps > config.stepBudget || stats.recursiveCalls > config.maxCalls) {
            return { ok: false, code: 'budget_exhausted' };
        }

        const baseTask = entity.task;
        const task = { ...baseTask, roomId: candidate.roomId === undefined ? baseTask.roomId || null : candidate.roomId };
        const blockKeys = blockKeysForPlacement(task, candidate.day, candidate.period);
        if (blockKeys.some(key => forbiddenKeys.has(key))) {
            stats.tabuHits += 1;
            return { ok: false, code: 'tabu' };
        }

        const entityKey = entity.groupKey || task.id || task.lessonPlanId || `${task.classId}:${task.subjectId}`;
        const moveKey = `${entityKey}:${blockKeys.join(',')}`;
        if (pathKeys.has(moveKey) || (tabu.get(moveKey) || 0) >= config.shallowLimit) {
            stats.tabuHits += 1;
            return { ok: false, code: 'tabu' };
        }
        tabu.set(moveKey, (tabu.get(moveKey) || 0) + 1);

        const slotSnapshot = slots.slice();
        const usageSnapshot = cloneUsage(usage);
        const activeExcluded = new Set(excludedGroupKeys);
        let currentGroup = [];
        let effectiveTask = task;
        if (entity.groupKey) {
            currentGroup = slotsForGroup(slots, entity.groupKey);
            if (!currentGroup.length) {
                stats.rollbacks += 1;
                return { ok: false, code: 'blocker_unmovable', detail: entity.groupKey };
            }
            effectiveTask = {
                ...taskFromSlotGroup(currentGroup, project),
                roomId: candidate.roomId === undefined ? currentGroup[0]?.roomId || null : candidate.roomId,
            };
            activeExcluded.add(entity.groupKey);
            removeGroupUsage(usage, currentGroup);
        }

        const failBranch = (code, detail = '', blockers = []) => {
            stats.rollbacks += 1;
            restoreBranch(slotSnapshot, usageSnapshot);
            return { ok: false, code, detail, blockers };
        };

        const blockers = findBlockingGroups(project, slots, effectiveTask, candidate.day, candidate.period, activeExcluded);
        if (blockers.length > config.maxBlockers) {
            return failBranch('too_many_blockers', `${blockers.length} 个 blocker`, blockers);
        }
        if (blockers.some(isProtectedGroup)) {
            return failBranch('protected_blocker', '', blockers);
        }

        const childForbidden = new Set([...forbiddenKeys, ...blockKeys]);
        const childPath = new Set(pathKeys);
        childPath.add(moveKey);
        for (const blockerGroup of blockers) {
            const latestGroup = slotsForGroup(slots, slotGroupKey(blockerGroup[0]));
            const blockerTask = taskFromSlotGroup(latestGroup, project);
            const blockerKey = slotGroupKey(latestGroup[0]);
            const childCandidates = candidateListForRepair(
                project,
                usage,
                blockerTask,
                slots,
                pressureContext,
                childForbidden,
                new Set([...activeExcluded, blockerKey]),
            );
            let moved = false;
            let lastFailure = null;
            for (const childCandidate of childCandidates) {
                const result = placeEntityAt(
                    { task: blockerTask, groupKey: blockerKey },
                    childCandidate,
                    depth + 1,
                    childPath,
                    childForbidden,
                    activeExcluded,
                );
                if (result.ok) {
                    moved = true;
                    break;
                }
                lastFailure = result;
            }
            if (!moved) {
                return failBranch(lastFailure?.code || 'blocker_unmovable', lastFailure?.detail || blockerTask.lessonPlanId || blockerKey, blockers);
            }
        }

        const fit = blockFits(project, usage, effectiveTask, candidate.day, candidate.period);
        if (!fit.ok) return failBranch('task_still_blocked', fit.reason, blockers);

        if (entity.groupKey) {
            moveExistingGroup(slots, usage, entity.groupKey, candidate.day, candidate.period, effectiveTask.roomId);
            stats.relocatedBlockers += 1;
        } else {
            addTaskPlacement(slots, usage, effectiveTask, candidate.day, candidate.period, effectiveTask.roomId);
        }
        return { ok: true, blockers };
    };

    for (let u = 0; u < unplaced.length && steps < config.stepBudget; u++) {
        const entry = unplaced[u];
        const task = entry.task;
        if (!task) {
            recordFailure(entry, 'no_task');
            continue;
        }

        let repaired = false;
        const candidates = candidateListForRepair(project, usage, task, slots, pressureContext);
        if (!candidates.length) {
            recordFailure(entry, 'no_candidate');
            continue;
        }

        for (const candidate of candidates) {
            stats.attempts += 1;
            const blockers = candidate.blockers || [];
            entry.blocking = {
                reasonCode: blockers.length > config.maxBlockers ? 'too_many_blockers' : 'blocked_by_lessons',
                reason: blockers.length
                    ? `${blockers.length} 组已排课程占用了候选位置`
                    : candidate.check.reason,
                blockerCount: blockers.length,
                blockers: describeBlockingGroups(blockers),
            };
            const result = placeEntityAt({ task }, candidate, 0);
            if (result.ok) {
                stats.repaired += 1;
                entry.repairStatus = 'repaired';
                entry.repairReasonCode = null;
                entry.repairReason = null;
                entry.blocking = {
                    ...entry.blocking,
                    resolvedBy: 'recursive_bounded_repair',
                    relocatedBlockers: stats.relocatedBlockers,
                };
                repaired = true;
                break;
            }
            entry.blocking = {
                ...entry.blocking,
                ...(result.blockers?.length ? {
                    blockerCount: result.blockers.length,
                    blockers: describeBlockingGroups(result.blockers),
                } : {}),
            };
            recordFailure(entry, result.code || 'blocker_unmovable', result.detail || '');
            if (result.code === 'budget_exhausted') break;
        }
        if (repaired) {
            unplaced.splice(u, 1);
            u -= 1;
        }
    }

    // When a single blocker chain cycles, rebuild its connected class/teacher/
    // room component with bounded MRV backtracking instead of retrying the same
    // recursive branch in a different order.
    for (let index = unplaced.length - 1; index >= 0; index -= 1) {
        const entry = unplaced[index];
        stats.componentAttempts += 1;
        const result = repairUnplacedByComponent(project, slots, usage, entry);
        stats.componentNodes += result.nodes || 0;
        if (!result.ok) {
            stats.componentFailures[result.reasonCode || 'unknown'] =
                (stats.componentFailures[result.reasonCode || 'unknown'] || 0) + 1;
        }
        if (!result.ok) continue;
        stats.componentRepaired += 1;
        entry.repairStatus = 'repaired_by_component';
        entry.repairReasonCode = null;
        entry.repairReason = null;
        unplaced.splice(index, 1);
    }
    stats.steps = steps;
    return stats;
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
        if (slot.locked || slot.manuallyAdjusted) continue;
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
    if (budget <= 0 || unplaced.length) {
        return {
            slots,
            stats: {
                strategy: 'soft_score_local_improvement',
                localImproveMs: 0,
                improved: false,
                rounds: 0,
                movesAccepted: 0,
                candidatesAccepted: 0,
                rejectedHardConflicts: 0,
                budgetMs: budget,
            },
        };
    }
    let currentSlots = slots;
    let currentIssues = buildTimetableQualityIssues(project, currentSlots);
    const originalValue = scheduleScoreValue(project, currentSlots, unplaced);
    let currentValue = originalValue;
    let movesAccepted = 0;
    let rounds = 0;
    let rejectedHardConflicts = 0;

    while (Date.now() - startedAt < budget && movesAccepted < 20 && currentIssues.length) {
        rounds += 1;
        const affectedIds = new Set(currentIssues.map(item => item.slot?.id).filter(Boolean));
        const groups = unlockedGroups(currentSlots, affectedIds);
        if (!groups.length) break;
        const moved = tryImproveByMove(project, currentSlots, unplaced, groups);
        const next = moved.improved ? moved : tryImproveBySwap(project, currentSlots, unplaced, groups);
        if (!next.improved || next.value <= currentValue) break;
        const conflicts = detectScheduleConflicts(project, next.slots);
        if (conflicts.some(conflict => conflict.severity === 'hard')) {
            rejectedHardConflicts += 1;
            break;
        }
        currentSlots = next.slots;
        currentValue = next.value;
        movesAccepted += 1;
        currentIssues = buildTimetableQualityIssues(project, currentSlots);
    }

    return {
        slots: currentSlots,
        stats: {
            strategy: 'soft_score_local_improvement',
            localImproveMs: Date.now() - startedAt,
            improved: currentValue > originalValue,
            rounds,
            movesAccepted,
            candidatesAccepted: movesAccepted,
            rejectedHardConflicts,
            originalValue,
            finalValue: currentValue,
            delta: currentValue - originalValue,
            remainingQualityIssues: currentIssues.length,
            budgetMs: budget,
            auditWarnings: audit?.warnings?.length || 0,
        },
    };
}

function snapshotRank(project, slots, unplaced, baseConflicts = []) {
    const cleanUnplaced = unplaced.map(({ task, ...rest }) => rest);
    const conflicts = [
        ...baseConflicts,
        ...buildUnplacedConflicts(cleanUnplaced),
        ...detectScheduleConflicts(project, slots),
    ];
    const score = buildTimetableScore(project, slots, cleanUnplaced, conflicts);
    return {
        placedLessons: slots.length,
        unplacedLessons: cleanUnplaced.length,
        hardConflicts: conflicts.filter(conflict => conflict.severity === 'hard').length,
        softScore: score.softScore,
        softSatisfaction: score.softSatisfaction,
        rank: slots.length * 10000
            - cleanUnplaced.length * 5000
            - conflicts.filter(conflict => conflict.severity === 'hard').length * 100000
            + Number(score.softScore || 0),
    };
}

function summarizeBestSnapshot(stage, project, slots, unplaced, baseConflicts = []) {
    const ranked = snapshotRank(project, slots, unplaced, baseConflicts);
    return {
        stage,
        placedLessons: ranked.placedLessons,
        unplacedLessons: ranked.unplacedLessons,
        hardConflicts: ranked.hardConflicts,
        softScore: ranked.softScore,
        softSatisfaction: ranked.softSatisfaction,
    };
}

function seedLockedSlots(project, usage, maps) {
    const slots = [];
    const conflicts = [];
    const placedCountByPlan = new Map();
    const seededKeys = new Set();
    const consumedLockedCells = new Set();
    const roomCampus = buildRoomCampusMap(project);
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
        const blockSize = plan ? nextLockedBlockSizeForPlan(plan, placedHours, project) : 1;
        const blockNumber = plan ? placedBlockCountForPlan(plan, placedHours, project) + 1 : 1;
        const lessonPlanId = locked.lessonPlanId || plan?.id || null;
        const classId = locked.classId || plan?.classId || null;
        const teacherId = locked.teacherId || plan?.teacherId || null;
        const roomId = locked.roomId || plan?.roomId || null;
        const metadata = taskMetadataForPlan(project, plan, {
            roomCampus,
            classId,
            teacherId,
            roomId,
            teacherIds: plan ? slotTeacherIds(plan) : [teacherId].filter(Boolean),
            weekPattern: plan?.weekPattern || locked.weekPattern || 'every',
            campusId: locked.campusId || plan?.campusId || '',
            teachingGroupId: plan?.teachingGroupId || locked.teachingGroupId || '',
        });
        const task = {
            id: locked.id,
            lessonPlanId,
            classId,
            subjectId: locked.subjectId || plan?.subjectId || null,
            teacherId,
            teacherIds: metadata.teacherIds,
            roomId: metadata.roomId,
            allowedRoomIds: metadata.allowedRoomIds,
            roomRequirement: metadata.roomRequirement,
            weekPattern: metadata.weekPattern,
            campusId: metadata.campusId,
            roomCampus: metadata.roomCampus,
            teachingGroupId: metadata.teachingGroupId,
            teachingGroupName: metadata.teachingGroupName,
            classIds: metadata.classIds,
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

function seedProtectedCurrentSlots(project, usage, maps, seededState) {
    const slots = [...(seededState?.slots || [])];
    const conflicts = [...(seededState?.conflicts || [])];
    const placedCountByPlan = new Map(seededState?.placedCountByPlan || []);
    const seededKeys = new Set(slots.map(slot => `${slot.lessonPlanId || ''}:${slot.classId}:${slot.day}-${slot.period}`));
    const roomCampus = buildRoomCampusMap(project);
    const seededRuleCells = new Set(
        slots
            .filter(slot => slot.locked)
            .map(slot => `${slot.lessonPlanId || ''}:${slot.classId}:${slot.day}-${slot.period}`),
    );
    const scheduleSlots = (project.schedule?.slots || [])
        .filter(slot => slot.lessonPlanId && (slot.locked || slot.manuallyAdjusted))
        .sort((left, right) => left.day - right.day || left.period - right.period || (left.blockIndex || 0) - (right.blockIndex || 0));

    for (const existing of scheduleSlots) {
        const plan = maps.plans.get(existing.lessonPlanId);
        if (!plan) continue;
        const key = `${existing.lessonPlanId}:${existing.classId}:${existing.day}-${existing.period}`;
        if (seededRuleCells.has(key) || seededKeys.has(key)) continue;
        if (!isActiveTimetableSlot(project, existing.day, existing.period)) continue;

        const roomId = existing.roomId || plan.roomId || null;
        const teacherId = existing.teacherId || plan.teacherId || null;
        const metadata = taskMetadataForPlan(project, plan, {
            roomCampus,
            classId: existing.classId || plan.classId,
            teacherId,
            roomId,
            teacherIds: slotTeacherIds(existing).length ? slotTeacherIds(existing) : slotTeacherIds(plan),
            weekPattern: plan.weekPattern || existing.weekPattern || 'every',
            campusId: existing.campusId || plan.campusId || '',
            teachingGroupId: plan.teachingGroupId || existing.teachingGroupId || '',
            classIds: existing.classIds,
        });
        const slot = {
            ...existing,
            teacherId,
            teacherIds: metadata.teacherIds,
            roomId: metadata.roomId,
            weekPattern: metadata.weekPattern,
            campusId: metadata.campusId,
            teachingGroupId: metadata.teachingGroupId,
            teachingGroupName: metadata.teachingGroupName,
            classIds: metadata.classIds,
            locked: Boolean(existing.locked),
            manuallyAdjusted: Boolean(existing.manuallyAdjusted),
        };
        const check = canUseSlot(project, usage, slot);
        if (!check.ok) {
            conflicts.push({
                type: 'protected-slot-conflict',
                severity: 'hard',
                message: `Protected lesson cannot be kept: ${check.reason}`,
                slot,
            });
            continue;
        }
        slots.push(slot);
        addUsage(usage, slot);
        seededKeys.add(key);
        placedCountByPlan.set(slot.lessonPlanId, (placedCountByPlan.get(slot.lessonPlanId) || 0) + 1);
    }

    return { slots, conflicts, placedCountByPlan };
}

export function runTimetableScheduler(input = {}, options = {}) {
    const startedAt = Date.now();
    const project = normalizeTimetableProject(input);
    const seed = normalizeSolveSeed(options.seed);
    const audit = auditTimetableProject(project);
    const feasibility = hasSimpleEdgeColoringShape(project)
        ? simpleEdgeFeasibility(project)
        : analyzeTimetableFeasibility(project);
    if (feasibility.status === 'input_infeasible') {
        return infeasibleSchedule(project, audit, feasibility, startedAt, seed);
    }

    // Edge-coloring (when the project shape is simple) yields a globally feasible,
    // soft-rule-aware assignment far more reliably than greedy, so try it first and
    // fall back to the greedy constructor + local repair otherwise.
    const edgeColored = buildFastEdgeColoredSchedule(project, { seed });
    if (edgeColored?.success) {
        edgeColored.schedule.solverStats.feasibility = {
            status: feasibility.status,
            issues: feasibility.issues,
            candidateDomainStats: feasibility.candidateDomainStats,
        };
        return edgeColored;
    }

    const maps = getTimetableEntityMaps(project);
    const usage = createTimetableUsage();
    const seededLocked = seedLockedSlots(project, usage, maps);
    const seeded = seedProtectedCurrentSlots(project, usage, maps, seededLocked);
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
            lessonHours: Math.max(1, Number.parseInt(plan.weeklyHours, 10) || 1),
            reason: '任课信息引用了不存在的班级、课程或教师',
        });
    }

    const validPlanIds = new Set(project.lessonPlans.filter(plan => !invalidPlans.includes(plan)).map(plan => plan.id));
    const tasks = expandLessonPlanTasks(
        { ...project, lessonPlans: project.lessonPlans.filter(plan => validPlanIds.has(plan.id)) },
        seeded.placedCountByPlan,
    );
    const pressureContext = buildCandidatePressureContext(project, usage, tasks);
    const constructionPasses = [
        { name: 'strict_soft', attempts: 0, candidateChecks: 0, softRejected: 0, placed: 0, unplaced: 0 },
        { name: 'relaxed_soft', attempts: 0, candidateChecks: 0, softRejected: 0, placed: 0, unplaced: 0 },
        { name: 'hard_only', attempts: 0, candidateChecks: 0, softRejected: 0, placed: 0, unplaced: 0 },
    ];
    const softEnforcement = {
        evaluations: 0,
        mandatory: 0,
        enforced: 0,
        skipped: 0,
        rejected: 0,
    };
    const strategyStats = {
        phase: 'legacy_strategy_enhancement_v2',
        ordering: 'difficulty_pressure',
        candidateScoring: 'soft_rules_pressure_weighted',
        repair: 'recursive_bounded_repair',
        localImprovement: 'soft_score_local_improvement',
        taskCount: tasks.length,
        initialPlacedCount: slots.length,
        initialUnplacedCount: unplaced.length,
        constructorAttempts: 0,
        constructorPlaced: 0,
        constructorUnplaced: 0,
        candidateChecks: 0,
        constructionPasses,
        softEnforcement,
        pressure: pressureContext.stats,
        pressureStats: pressureContext.stats,
    };
    let bestSnapshotStats = summarizeBestSnapshot('seeded', project, slots, unplaced, conflicts);
    const rememberSnapshot = stage => {
        const next = summarizeBestSnapshot(stage, project, slots, unplaced, conflicts);
        const currentRank = snapshotRank(project, slots, unplaced, conflicts).rank;
        const bestRank = bestSnapshotStats.rank ?? (
            bestSnapshotStats.placedLessons * 10000
            - bestSnapshotStats.unplacedLessons * 5000
            - bestSnapshotStats.hardConflicts * 100000
            + Number(bestSnapshotStats.softScore || 0)
        );
        if (currentRank >= bestRank) bestSnapshotStats = { ...next, rank: currentRank };
    };
    // Most-constrained-first: tasks with fewer candidates, stronger shared
    // resource pressure and larger blocks are placed earliest.
    tasks.sort((left, right) => (pressureContext.taskCandidateCounts.get(left.id) || 0)
        - (pressureContext.taskCandidateCounts.get(right.id) || 0)
        || taskResourcePressure(project, pressureContext, right)
            - taskResourcePressure(project, pressureContext, left)
        || taskDifficulty(project, usage, left, pressureContext) - taskDifficulty(project, usage, right, pressureContext)
        || taskPreferenceRank(project, left) - taskPreferenceRank(project, right)
        || seededCompare(seed, left.id, right.id)
        || left.id.localeCompare(right.id));

    let pendingTasks = [...tasks];
    const constructionReorderInterval = intEnv(
        'TIMETABLE_CONSTRUCTION_REORDER_INTERVAL',
        256,
        { min: 1, max: 256 },
    );
    const constructionReorderWindow = intEnv(
        'TIMETABLE_CONSTRUCTION_REORDER_WINDOW',
        16,
        { min: 1, max: 512 },
    );
    strategyStats.constructionReorderInterval = constructionReorderInterval;
    strategyStats.constructionReorderWindow = constructionReorderWindow;
    for (const pass of constructionPasses) {
        if (!pendingTasks.length) break;
        const passPending = [...pendingTasks];
        const nextPending = [];
        let placementsSinceReorder = constructionReorderInterval;
        let hasRanked = false;
        while (passPending.length) {
            if (placementsSinceReorder >= constructionReorderInterval || !hasRanked) {
                const rankCount = Math.min(constructionReorderWindow, passPending.length);
                const ranked = passPending.slice(0, rankCount).map((task, index) => {
                    const candidates = getCandidateBlocks(project, usage, task);
                    return {
                        task,
                        index,
                        windowCount: candidateTimeWindowCount(candidates),
                    };
                }).sort((left, right) => left.windowCount - right.windowCount
                    || taskResourcePressure(project, pressureContext, right.task)
                        - taskResourcePressure(project, pressureContext, left.task)
                    || taskDifficulty(project, usage, left.task, pressureContext)
                        - taskDifficulty(project, usage, right.task, pressureContext)
                    || taskPreferenceRank(project, left.task) - taskPreferenceRank(project, right.task)
                    || seededCompare(seed, left.task.id, right.task.id)
                    || left.task.id.localeCompare(right.task.id)
                    || left.index - right.index);
                passPending.splice(0, rankCount, ...ranked.map(item => item.task));
                placementsSinceReorder = 0;
                hasRanked = true;
            }
            const task = passPending.shift();
            const candidates = getCandidateBlocks(project, usage, task);
            pass.attempts += 1;
            strategyStats.constructorAttempts += 1;
            pass.candidateChecks += candidates.length;
            strategyStats.candidateChecks += candidates.length;
            const scored = candidates
                .map(candidate => {
                    const soft = evaluateSoftEnforcement(project, usage, task, candidate, { stats: softEnforcement });
                    if (!soft.ok) {
                        pass.softRejected += 1;
                        return null;
                    }
                    return {
                        ...candidate,
                        score: strategyCandidateScore(project, usage, slots, task, candidate, pressureContext, soft.penalty),
                    };
                })
                .filter(Boolean)
                .sort((left, right) => left.score - right.score
                    || seededCompare(seed, `${pass.name}:${candidateTieKey(left)}`, `${pass.name}:${candidateTieKey(right)}`)
                    || left.day - right.day
                    || left.period - right.period
                    || String(left.roomId || '').localeCompare(String(right.roomId || '')));

            if (!scored.length) {
                pass.unplaced += 1;
                nextPending.push(task);
                continue;
            }

            const best = chooseWeightedCandidate(scored, seed, task.id, pass.name);
            for (let offset = 0; offset < task.blockSize; offset++) {
                const slot = makeSlot(task, best.day, best.period + offset, offset, false, best.roomId);
                slots.push(slot);
                addUsage(usage, slot);
            }
            pass.placed += task.blockSize;
            strategyStats.constructorPlaced += task.blockSize;
            placementsSinceReorder += task.blockSize;
        }
        pendingTasks = nextPending;
        rememberSnapshot('constructor');
    }

    for (const task of pendingTasks) {
        strategyStats.constructorUnplaced += 1;
        unplaced.push({
            taskId: task.id,
            lessonPlanId: task.lessonPlanId,
            classId: task.classId,
            subjectId: task.subjectId,
            teacherId: task.teacherId,
            blockSize: Math.max(1, Number.parseInt(task.blockSize, 10) || 1),
            lessonHours: Math.max(1, Number.parseInt(task.blockSize, 10) || 1),
            reason: '没有可用节次：教师或班级被占用/不可排',
            reasonCode: 'no_candidate_after_constructor',
            task,
        });
    }

    strategyStats.afterConstructorUnplacedCount = unplaced.length;
    rememberSnapshot('constructor');
    // Local repair: try to rescue unplaced tasks by relocating bounded blockers.
    const repairStats = repairUnplaced(project, usage, slots, unplaced, pressureContext, tasks.length);
    strategyStats.repairStats = repairStats;
    strategyStats.afterRepairUnplacedCount = unplaced.length;
    rememberSnapshot('repair');
    const localImprovement = improveScheduleLocally(project, slots, unplaced, audit);
    const finalSlots = localImprovement.slots;

    // unplaced entries carry a transient `task` ref for repair; strip it before output.
    const cleanUnplaced = unplaced.map(({ task, ...rest }) => rest);
    conflicts.push(...buildUnplacedConflicts(cleanUnplaced));
    conflicts.push(...detectScheduleConflicts(project, finalSlots));
    const qualityIssues = buildTimetableQualityIssues(project, finalSlots);
    const hasPreflightBlocking = audit.blockingIssues.length > 0;

    const scheduleScore = buildTimetableScore(project, finalSlots, cleanUnplaced, conflicts);
    strategyStats.finalPlacedCount = finalSlots.length;
    strategyStats.finalUnplacedCount = scheduleScore.unplacedLessons;
    strategyStats.finalHardConflicts = conflicts.filter(conflict => conflict.severity === 'hard').length;
    strategyStats.finalSoftScore = scheduleScore.softScore;
    strategyStats.finalSoftSatisfaction = scheduleScore.softSatisfaction;
    strategyStats.localImprovementStats = localImprovement.stats;
    strategyStats.solveMs = Date.now() - startedAt;
    bestSnapshotStats = summarizeBestSnapshot('local_improvement', project, finalSlots, unplaced, conflicts);
    strategyStats.bestSnapshotStats = bestSnapshotStats;

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
        score: scheduleScore,
        solverStats: {
            solverUsed: false,
            phase: 'fast_construct',
            status: conflicts.some(conflict => conflict.severity === 'hard') || cleanUnplaced.length ? 'failed' : 'accepted',
            strategy: 'greedy_constraints',
            strategyVersion: 'legacy_enhanced_v2',
            ...scheduleSeedPatch(seed),
            lessonCount: project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0),
            placedLessons: finalSlots.length,
            unplacedLessons: scheduleScore.unplacedLessons,
            hardConflicts: conflicts.filter(conflict => conflict.severity === 'hard').length,
            softScore: null,
            localImproveMs: localImprovement.stats.localImproveMs,
            solveMs: strategyStats.solveMs,
            accepted: !(conflicts.some(conflict => conflict.severity === 'hard') || cleanUnplaced.length),
            reason: hasPreflightBlocking ? 'preflight_blocking_issues' : null,
            feasibility: {
                status: feasibility.status,
                issues: feasibility.issues,
                candidateDomainStats: feasibility.candidateDomainStats,
            },
            strategyStats,
            constructionPasses,
            pressureStats: pressureContext.stats,
            softEnforcement,
            bestSnapshotStats,
            repairStats,
            localImprovement: localImprovement.stats,
        },
    };
    schedule.solverStats.softScore = schedule.score.softScore;
    attachPublication(project, schedule);

    return {
        success: schedule.score.hardConflicts === 0 && cleanUnplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}
