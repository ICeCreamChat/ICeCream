import {
    addUsage,
    canUseSlot,
    createTimetableUsage,
    detectScheduleConflicts,
    removeUsage,
} from './timetable-conflicts.js';
import {
    classIdsForPlan,
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
    if (!seed) return 0;
    return seededHash(seed, leftKey) - seededHash(seed, rightKey);
}

function seededUnit(seed, key) {
    return seededHash(seed || 'legacy-default-seed', key) / 0x100000000;
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

function prefersLaterSubject(subject = {}, subjectId = '', afternoonSubjects = new Set()) {
    if (afternoonSubjects.has(subjectId)) return true;
    if (afternoonSubjects.size > 0) return false;
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
    const subjectName = subject?.name || '';
    const morningSubjects = new Set(project.rules.softRules.morningSubjects || []);
    const afternoonSubjects = new Set(project.rules.softRules.afternoonSubjects || []);
    const preferredPeriods = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKey = `${candidate.day}-${candidate.period}`;
    const preferenceWeight = Math.max(1, Math.min(100, Number.parseInt(preferredPeriods?.weight, 10) || 20));
    let score = candidate.day * 0.2 + candidate.period * 0.1;

    if (morningSubjects.has(task.subjectId) || /语文|数学|英语|外语/.test(subjectName)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (afternoonSubjects.has(task.subjectId) || (!afternoonSubjects.size && /体育|美术|音乐|劳动|实验/.test(subjectName))) {
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

    if (isMainSubject(subject, task.subjectId, morningSubjects)) {
        score += isMorning(project, candidate.period) ? -18 : 14;
    }
    if (prefersLaterSubject(subject, task.subjectId, afternoonSubjects)) {
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
    score -= (subject?.priority || 50) / 100;

    return score;
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
        taskCandidateCounts.set(task.id, candidates.length);
        minCandidateCount = Math.min(minCandidateCount, candidates.length);

        const subject = project.subjects.find(item => item.id === task.subjectId);
        const priority = Number(subject?.priority ?? 50);
        const teacherCount = Math.max(1, slotTeacherIds(task).length);
        const workMetric = Math.max(1, task.blockSize || 1)
            + priority / 100
            + (teacherCount - 1) * 0.5
            + (task.roomId || (task.allowedRoomIds || []).length ? 0.35 : 0);
        taskWork.set(task.id, workMetric);
        const contribution = workMetric / Math.max(1, candidates.length);

        bumpCount(classDemand, task.classId, Math.max(1, task.blockSize || 1));
        for (const teacherId of slotTeacherIds(task)) bumpCount(teacherDemand, teacherId, Math.max(1, task.blockSize || 1));
        for (const roomId of roomCandidatesForTask(task, project)) {
            if (roomId) bumpCount(roomDemand, roomId, Math.max(1, task.blockSize || 1));
        }

        for (const candidate of candidates) {
            bumpCount(slotPressure, candidateTieKey(candidate), contribution);
            bumpCount(timePressure, `${candidate.day}-${candidate.period}`, contribution);
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
    const subject = project.subjects.find(item => item.id === task.subjectId);
    const morningSubjects = new Set(softRules.morningSubjects || []);
    const afternoonSubjects = new Set(softRules.afternoonSubjects || []);
    const preferredPeriods = softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const candidateKeys = candidateBlockKeys(task, candidate);
    const checks = [];

    const explicitMorningSubject = morningSubjects.has(task.subjectId)
        || /\b(main|core)\b|主科/.test(subjectProfile(subject, task.subjectId));
    if (explicitMorningSubject) {
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

function shouldEnforceSoft({ seed, mode, task, candidate, check }) {
    if (check.weight < 0) return false;
    if (check.weight >= 100) return true;
    if (mode === 'relaxed_soft' || mode === 'hard_only') return false;
    if (check.code === 'preferred_period' || check.code === 'avoid_period') return true;
    const rollKey = `${task.id}:${candidateTieKey(candidate)}:${check.code}`;
    return seededUnit(seed, rollKey) * 100 < check.weight;
}

function evaluateSoftEnforcement(project, usage, task, candidate, { mode, seed, stats }) {
    if (mode === 'hard_only') return { ok: true, penalty: 0, rejected: 0 };
    const checks = softRuleChecks(project, usage, task, candidate);
    let penalty = 0;
    let rejected = 0;
    for (const check of checks) {
        stats.evaluations += 1;
        if (check.weight >= 100) stats.mandatory += 1;
        const enforced = shouldEnforceSoft({ seed, mode, task, candidate, check });
        if (enforced) {
            stats.enforced += 1;
            rejected += 1;
        } else {
            stats.skipped += 1;
            penalty += Math.max(1, check.weight) / 5;
        }
    }
    if (rejected) stats.rejected += 1;
    return { ok: rejected === 0, penalty, rejected };
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
    let cursor = seededUnit(seed, `${taskId}:${passName}:weighted-choice`) * total;
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
        let blockIndex = placedBlockCountForPlan(plan, alreadyPlaced);
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
    const afternoonSubjects = new Set(project.rules.softRules.afternoonSubjects || []);
    const preferred = project.rules.softRules.subjectPreferredPeriods?.[task.subjectId] || null;
    const key = `${day}-${period}`;
    const morning = isMorning(project, period);
    let affinity = 0;

    if (isMainSubject(subject, task.subjectId, morningSubjects)) {
        affinity += morning ? 18 : -14;
    }
    if (prefersLaterSubject(subject, task.subjectId, afternoonSubjects)) {
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

function taskFromSlotGroup(group = []) {
    const first = group[0] || {};
    return {
        id: slotGroupKey(first) || first.id,
        lessonPlanId: first.lessonPlanId || null,
        classId: first.classId || null,
        subjectId: first.subjectId || null,
        teacherId: first.teacherId || null,
        teacherIds: slotTeacherIds(first),
        roomId: first.roomId || null,
        allowedRoomIds: first.roomId ? [first.roomId] : [],
        roomRequirement: first.roomRequirement || { preferredRoomIds: [], allowedRoomIds: [], requiredTags: [] },
        weekPattern: first.weekPattern || 'every',
        campusId: first.campusId || '',
        teachingGroupId: first.teachingGroupId || '',
        teachingGroupName: first.teachingGroupName || '',
        classIds: slotClassIds(first),
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
    const task = taskFromSlotGroup(group);
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
                ...taskFromSlotGroup(currentGroup),
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
            const blockerTask = taskFromSlotGroup(latestGroup);
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
        const blockSize = plan ? nextLockedBlockSizeForPlan(plan, placedHours) : 1;
        const blockNumber = plan ? placedBlockCountForPlan(plan, placedHours) + 1 : 1;
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

    // Edge-coloring (when the project shape is simple) yields a globally feasible,
    // soft-rule-aware assignment far more reliably than greedy, so try it first and
    // fall back to the greedy constructor + local repair otherwise.
    const edgeColored = buildFastEdgeColoredSchedule(project, { seed });
    if (edgeColored?.success) return edgeColored;

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
    tasks.sort((left, right) => taskPreferenceRank(project, left) - taskPreferenceRank(project, right)
        || taskDifficulty(project, usage, left, pressureContext) - taskDifficulty(project, usage, right, pressureContext)
        || seededCompare(seed, left.id, right.id)
        || left.id.localeCompare(right.id));

    let pendingTasks = [...tasks];
    for (const pass of constructionPasses) {
        if (!pendingTasks.length) break;
        const nextPending = [];
        for (const task of pendingTasks) {
            pass.attempts += 1;
            strategyStats.constructorAttempts += 1;
            const candidates = getCandidateBlocks(project, usage, task);
            pass.candidateChecks += candidates.length;
            strategyStats.candidateChecks += candidates.length;
            const scored = candidates
                .map(candidate => {
                    const soft = evaluateSoftEnforcement(project, usage, task, candidate, { mode: pass.name, seed, stats: softEnforcement });
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
    strategyStats.finalUnplacedCount = cleanUnplaced.length;
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
            unplacedLessons: cleanUnplaced.length,
            hardConflicts: conflicts.filter(conflict => conflict.severity === 'hard').length,
            softScore: null,
            localImproveMs: localImprovement.stats.localImproveMs,
            solveMs: strategyStats.solveMs,
            accepted: !(conflicts.some(conflict => conflict.severity === 'hard') || cleanUnplaced.length),
            reason: hasPreflightBlocking ? 'preflight_blocking_issues' : null,
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
