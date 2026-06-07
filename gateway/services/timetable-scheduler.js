const DEFAULT_SUBJECT_COLORS = [
    '#14b8a6',
    '#60a5fa',
    '#f59e0b',
    '#f97316',
    '#a78bfa',
    '#22c55e',
    '#ef4444',
    '#06b6d4',
];

const DEFAULT_PROJECT = {
    id: 'default',
    schoolName: 'ICeCream 学校',
    term: '2026-2027 第一学期',
    weekdays: 5,
    periodsPerDay: 7,
    teachers: [],
    classes: [],
    subjects: [],
    lessonPlans: [],
    rules: {
        hardRules: {
            lockedSlots: [],
            teacherUnavailable: {},
            classUnavailable: {},
        },
        softRules: {
            morningSubjects: [],
            balancedTeacherLoad: true,
        },
    },
    schedule: null,
};

function cleanText(value, max = 80) {
    return String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value ?? '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function makeTimetableId(prefix, value) {
    const text = cleanText(value, 80);
    const ascii = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `${prefix}_${ascii || stableHash(text)}`;
}

export function slotKey(day, period) {
    return `${Number(day)}-${Number(period)}`;
}

function normalizeSlotKey(value) {
    if (typeof value === 'string') {
        const match = value.match(/^(\d{1,2})-(\d{1,2})$/);
        if (match) return `${Number(match[1])}-${Number(match[2])}`;
    }
    if (value && Number.isInteger(Number(value.day)) && Number.isInteger(Number(value.period))) {
        return slotKey(value.day, value.period);
    }
    return null;
}

function normalizeSlotList(values = []) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const key = normalizeSlotKey(value);
        if (key && !seen.has(key)) {
            seen.add(key);
            result.push(key);
        }
    }
    return result;
}

function normalizeIdList(values = []) {
    const raw = Array.isArray(values) ? values : [values];
    const result = [];
    for (const value of raw) {
        const id = cleanText(value, 80);
        if (id && !result.includes(id)) result.push(id);
    }
    return result;
}

function intInRange(value, fallback, min, max) {
    const num = Number.parseInt(value, 10);
    if (!Number.isInteger(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

function normalizeTeacher(raw = {}, index = 0) {
    const name = cleanText(raw.name || raw.teacherName || `教师${index + 1}`, 40);
    const id = cleanText(raw.id, 60) || makeTimetableId('t', name);
    return {
        id,
        name,
        subjects: Array.isArray(raw.subjects) ? raw.subjects.map(value => cleanText(value, 60)).filter(Boolean) : [],
        unavailableSlots: normalizeSlotList(raw.unavailableSlots),
    };
}

function normalizeClass(raw = {}, index = 0) {
    const grade = cleanText(raw.grade || '默认年级', 40);
    const name = cleanText(raw.name || raw.className || `班级${index + 1}`, 40);
    const id = cleanText(raw.id, 60) || makeTimetableId('c', `${grade}-${name}`);
    return { id, grade, name };
}

function normalizeSubject(raw = {}, index = 0) {
    const name = cleanText(raw.name || raw.subjectName || `课程${index + 1}`, 40);
    const id = cleanText(raw.id, 60) || makeTimetableId('s', name);
    return {
        id,
        name,
        priority: intInRange(raw.priority, 50, 1, 100),
        color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : DEFAULT_SUBJECT_COLORS[index % DEFAULT_SUBJECT_COLORS.length],
    };
}

function normalizeLessonPlan(raw = {}, index = 0) {
    const weeklyHours = Math.max(0, Math.min(60, Number.parseInt(raw.weeklyHours ?? raw.hours, 10) || 0));
    const blockPreference = ['single', 'double', 'mixed'].includes(raw.blockPreference) ? raw.blockPreference : 'single';
    const teacherIds = normalizeIdList(raw.teacherIds);
    const teacherId = cleanText(raw.teacherId, 80) || teacherIds[0] || '';
    if (teacherId && !teacherIds.includes(teacherId)) teacherIds.unshift(teacherId);
    const allowedRoomIds = normalizeIdList(raw.allowedRoomIds);
    const roomId = cleanText(raw.roomId, 80) || allowedRoomIds[0] || null;
    if (roomId && !allowedRoomIds.includes(roomId)) allowedRoomIds.unshift(roomId);
    return {
        id: cleanText(raw.id, 80) || `lp_${index + 1}`,
        classId: cleanText(raw.classId, 80),
        subjectId: cleanText(raw.subjectId, 80),
        teacherId,
        teacherIds,
        weeklyHours,
        blockPreference,
        roomId,
        allowedRoomIds,
        className: cleanText(raw.className, 80),
        subjectName: cleanText(raw.subjectName, 80),
        teacherName: cleanText(raw.teacherName, 80),
    };
}

function normalizeRuleMap(raw = {}) {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const id = cleanText(key, 80);
        if (id) result[id] = normalizeSlotList(value);
    }
    return result;
}

function normalizeLockedSlots(values = []) {
    return (Array.isArray(values) ? values : [])
        .map((item, index) => ({
            id: cleanText(item.id, 80) || `locked_${index + 1}`,
            day: Number.parseInt(item.day, 10),
            period: Number.parseInt(item.period, 10),
            classId: cleanText(item.classId, 80),
            subjectId: cleanText(item.subjectId, 80),
            teacherId: cleanText(item.teacherId, 80),
            lessonPlanId: cleanText(item.lessonPlanId, 80) || null,
            roomId: cleanText(item.roomId, 80) || null,
        }))
        .filter(item => Number.isInteger(item.day) && Number.isInteger(item.period) && item.classId && item.subjectId && item.teacherId);
}

function normalizeRules(raw = {}) {
    const hardRules = raw.hardRules || {};
    const softRules = raw.softRules || {};
    return {
        hardRules: {
            lockedSlots: normalizeLockedSlots(hardRules.lockedSlots),
            teacherUnavailable: normalizeRuleMap(hardRules.teacherUnavailable),
            classUnavailable: normalizeRuleMap(hardRules.classUnavailable),
        },
        softRules: {
            morningSubjects: Array.isArray(softRules.morningSubjects)
                ? softRules.morningSubjects.map(value => cleanText(value, 80)).filter(Boolean)
                : [],
            balancedTeacherLoad: softRules.balancedTeacherLoad !== false,
            subjectPreferredPeriods: softRules.subjectPreferredPeriods || {},
        },
    };
}

function normalizeSchedule(raw) {
    if (!raw || !Array.isArray(raw.slots)) return null;
    return {
        id: cleanText(raw.id, 80) || `schedule_${Date.now()}`,
        generatedAt: raw.generatedAt || new Date().toISOString(),
        source: cleanText(raw.source, 80) || null,
        slots: raw.slots.map(slot => ({
            id: cleanText(slot.id, 120),
            day: Number.parseInt(slot.day, 10),
            period: Number.parseInt(slot.period, 10),
            classId: cleanText(slot.classId, 80),
            subjectId: cleanText(slot.subjectId, 80),
            teacherId: cleanText(slot.teacherId, 80),
            teacherIds: normalizeIdList(slot.teacherIds),
            lessonPlanId: cleanText(slot.lessonPlanId, 80),
            roomId: cleanText(slot.roomId, 80) || null,
            blockId: cleanText(slot.blockId, 120) || null,
            blockIndex: Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : 0,
            blockSize: Math.max(1, Number.parseInt(slot.blockSize, 10) || 1),
            locked: Boolean(slot.locked),
        })).filter(slot => slot.id && slot.classId && slot.subjectId && slot.teacherId && Number.isInteger(slot.day) && Number.isInteger(slot.period)),
        lockedSlots: Array.isArray(raw.lockedSlots) ? raw.lockedSlots : [],
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
        unplaced: Array.isArray(raw.unplaced) ? raw.unplaced : [],
        score: raw.score || {},
        solverStats: raw.solverStats || null,
    };
}

export function normalizeTimetableProject(raw = {}) {
    const base = { ...DEFAULT_PROJECT, ...raw };
    const teachers = (Array.isArray(base.teachers) ? base.teachers : []).map(normalizeTeacher);
    const classes = (Array.isArray(base.classes) ? base.classes : []).map(normalizeClass);
    const subjects = (Array.isArray(base.subjects) ? base.subjects : []).map(normalizeSubject);
    const lessonPlans = (Array.isArray(base.lessonPlans) ? base.lessonPlans : []).map(normalizeLessonPlan)
        .filter(plan => plan.classId && plan.subjectId && plan.teacherId && plan.weeklyHours > 0);
    return {
        id: cleanText(base.id, 80) || 'default',
        schoolName: cleanText(base.schoolName, 80) || DEFAULT_PROJECT.schoolName,
        term: cleanText(base.term, 80) || DEFAULT_PROJECT.term,
        weekdays: intInRange(base.weekdays, DEFAULT_PROJECT.weekdays, 1, 7),
        periodsPerDay: intInRange(base.periodsPerDay, DEFAULT_PROJECT.periodsPerDay, 1, 12),
        teachers,
        classes,
        subjects,
        lessonPlans,
        rules: normalizeRules(base.rules),
        schedule: normalizeSchedule(base.schedule),
        updatedAt: base.updatedAt || new Date().toISOString(),
    };
}

export function createDefaultTimetableProject(overrides = {}) {
    return normalizeTimetableProject({ ...DEFAULT_PROJECT, ...overrides });
}

function getEntityMaps(project) {
    return {
        teachers: new Map(project.teachers.map(item => [item.id, item])),
        classes: new Map(project.classes.map(item => [item.id, item])),
        subjects: new Map(project.subjects.map(item => [item.id, item])),
        plans: new Map(project.lessonPlans.map(item => [item.id, item])),
    };
}

function createUsage() {
    return {
        teacher: new Set(),
        class: new Set(),
        room: new Set(),
        classSubjectDay: new Map(),
        teacherDay: new Map(),
    };
}

function slotTeacherIds(slot) {
    const ids = normalizeIdList(slot?.teacherIds);
    if (slot?.teacherId && !ids.includes(slot.teacherId)) ids.unshift(slot.teacherId);
    return ids;
}

function addUsage(usage, slot) {
    const key = slotKey(slot.day, slot.period);
    for (const teacherId of slotTeacherIds(slot)) usage.teacher.add(`${teacherId}:${key}`);
    usage.class.add(`${slot.classId}:${key}`);
    if (slot.roomId) usage.room.add(`${slot.roomId}:${key}`);
    const csd = `${slot.classId}:${slot.subjectId}:${slot.day}`;
    usage.classSubjectDay.set(csd, (usage.classSubjectDay.get(csd) || 0) + 1);
    for (const teacherId of slotTeacherIds(slot)) {
        const td = `${teacherId}:${slot.day}`;
        usage.teacherDay.set(td, (usage.teacherDay.get(td) || 0) + 1);
    }
}

function removeUsage(usage, slot) {
    const key = slotKey(slot.day, slot.period);
    for (const teacherId of slotTeacherIds(slot)) usage.teacher.delete(`${teacherId}:${key}`);
    usage.class.delete(`${slot.classId}:${key}`);
    if (slot.roomId) usage.room.delete(`${slot.roomId}:${key}`);
    const csd = `${slot.classId}:${slot.subjectId}:${slot.day}`;
    usage.classSubjectDay.set(csd, Math.max(0, (usage.classSubjectDay.get(csd) || 0) - 1));
    for (const teacherId of slotTeacherIds(slot)) {
        const td = `${teacherId}:${slot.day}`;
        usage.teacherDay.set(td, Math.max(0, (usage.teacherDay.get(td) || 0) - 1));
    }
}

function teacherUnavailable(project, teacherId) {
    const teacher = project.teachers.find(item => item.id === teacherId);
    return new Set([
        ...(teacher?.unavailableSlots || []),
        ...(project.rules.hardRules.teacherUnavailable?.[teacherId] || []),
    ]);
}

function classUnavailable(project, classId) {
    return new Set(project.rules.hardRules.classUnavailable?.[classId] || []);
}

function isMorning(project, period) {
    return period <= Math.max(1, Math.ceil(project.periodsPerDay / 2));
}

function canUseSlot(project, usage, slot, options = {}) {
    const key = slotKey(slot.day, slot.period);
    const teacherIds = slotTeacherIds(slot);
    if (slot.day < 1 || slot.day > project.weekdays || slot.period < 1 || slot.period > project.periodsPerDay) {
        return { ok: false, reason: '节次超出当前作息范围' };
    }
    if (teacherIds.some(teacherId => teacherUnavailable(project, teacherId).has(key))) {
        return { ok: false, reason: '教师不可排时间' };
    }
    if (classUnavailable(project, slot.classId).has(key)) {
        return { ok: false, reason: '班级不可排时间' };
    }
    if (!options.ignoreTeacher && teacherIds.some(teacherId => usage.teacher.has(`${teacherId}:${key}`))) {
        return { ok: false, reason: '教师同节已有课程' };
    }
    if (!options.ignoreClass && usage.class.has(`${slot.classId}:${key}`)) {
        return { ok: false, reason: '班级同节已有课程' };
    }
    if (slot.roomId && !options.ignoreRoom && usage.room.has(`${slot.roomId}:${key}`)) {
        return { ok: false, reason: '教室同节已被占用' };
    }
    return { ok: true };
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

function detectScheduleConflictsLegacy(project, slots = []) {
    const conflicts = [];
    const teacher = new Map();
    const klass = new Map();
    const room = new Map();

    for (const slot of slots) {
        const key = slotKey(slot.day, slot.period);
        const teacherKey = `${slot.teacherId}:${key}`;
        const classKey = `${slot.classId}:${key}`;
        const roomKey = slot.roomId ? `${slot.roomId}:${key}` : null;

        if (teacher.has(teacherKey)) {
            conflicts.push({ type: 'teacher-conflict', severity: 'hard', slot, message: '教师同节冲突' });
        }
        if (klass.has(classKey)) {
            conflicts.push({ type: 'class-conflict', severity: 'hard', slot, message: '班级同节冲突' });
        }
        if (roomKey && room.has(roomKey)) {
            conflicts.push({ type: 'room-conflict', severity: 'hard', slot, message: '教室同节冲突' });
        }

        teacher.set(teacherKey, slot);
        klass.set(classKey, slot);
        if (roomKey) room.set(roomKey, slot);

        const check = canUseSlot(project, createUsage(), slot, { ignoreTeacher: true, ignoreClass: true, ignoreRoom: true });
        if (!check.ok) {
            conflicts.push({ type: 'availability-conflict', severity: 'hard', slot, message: check.reason });
        }
    }

    return conflicts;
}

export function detectScheduleConflicts(project, slots = []) {
    const conflicts = [];
    const teacher = new Map();
    const klass = new Map();
    const room = new Map();

    for (const slot of slots) {
        const key = slotKey(slot.day, slot.period);
        const classKey = `${slot.classId}:${key}`;
        const roomKey = slot.roomId ? `${slot.roomId}:${key}` : null;

        for (const teacherId of slotTeacherIds(slot)) {
            const teacherKey = `${teacherId}:${key}`;
            if (teacher.has(teacherKey)) {
                conflicts.push({ type: 'teacher-conflict', severity: 'hard', slot, message: '教师同节冲突' });
            }
            teacher.set(teacherKey, slot);
        }
        if (klass.has(classKey)) {
            conflicts.push({ type: 'class-conflict', severity: 'hard', slot, message: '班级同节冲突' });
        }
        if (roomKey && room.has(roomKey)) {
            conflicts.push({ type: 'room-conflict', severity: 'hard', slot, message: '教室同节冲突' });
        }

        klass.set(classKey, slot);
        if (roomKey) room.set(roomKey, slot);

        const check = canUseSlot(project, createUsage(), slot, { ignoreTeacher: true, ignoreClass: true, ignoreRoom: true });
        if (!check.ok) {
            conflicts.push({ type: 'availability-conflict', severity: 'hard', slot, message: check.reason });
        }
    }

    return conflicts;
}

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

function buildUnplacedConflicts(unplaced = []) {
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

export function runTimetableScheduler(input = {}) {
    const project = normalizeTimetableProject(input);
    const maps = getEntityMaps(project);
    const usage = createUsage();
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
    tasks.sort((a, b) => taskDifficulty(project, usage, a) - taskDifficulty(project, usage, b) || a.id.localeCompare(b.id));

    for (const task of tasks) {
        const candidates = getCandidateBlocks(project, usage, task)
            .map(candidate => ({ ...candidate, score: candidateScore(project, usage, slots, task, candidate) }))
            .sort((a, b) => a.score - b.score || a.day - b.day || a.period - b.period);

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

    const detected = detectScheduleConflicts(project, slots);
    conflicts.push(...detected);

    const schedule = {
        id: `schedule_${Date.now()}`,
        generatedAt: new Date().toISOString(),
        slots: slots.sort((a, b) => a.day - b.day || a.period - b.period || a.classId.localeCompare(b.classId)),
        lockedSlots: slots.filter(slot => slot.locked),
        conflicts,
        unplaced,
        score: buildTimetableScore(project, slots, unplaced, conflicts),
    };

    return {
        success: schedule.score.hardConflicts === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}

function rebuildUsage(slots, excludeSlotId = null) {
    const usage = createUsage();
    for (const slot of slots) {
        if (slot.id !== excludeSlotId) addUsage(usage, slot);
    }
    return usage;
}

function blockSlotIndexes(schedule, slot) {
    if (!slot?.blockId || slot.blockSize <= 1) {
        const index = schedule.slots.findIndex(item => item.id === slot?.id);
        return index < 0 ? [] : [index];
    }
    return schedule.slots
        .map((item, index) => (item.blockId === slot.blockId ? index : -1))
        .filter(index => index >= 0)
        .sort((left, right) => (schedule.slots[left].blockIndex || 0) - (schedule.slots[right].blockIndex || 0));
}

function rebuildUsageExcludingIds(slots, excludedIds = new Set()) {
    const usage = createUsage();
    for (const slot of slots) {
        if (!excludedIds.has(slot.id)) addUsage(usage, slot);
    }
    return usage;
}

function applyScheduleAdjustmentLegacy(input = {}, adjustment = {}) {
    const project = normalizeTimetableProject(input);
    const schedule = normalizeSchedule(project.schedule) || { slots: [], conflicts: [], unplaced: [], score: {} };
    const slotId = cleanText(adjustment.slotId, 120);
    const index = schedule.slots.findIndex(slot => slot.id === slotId);
    if (index < 0) throw new Error('没有找到要调整的课节');

    if (adjustment.type === 'clear') {
        schedule.slots.splice(index, 1);
    } else if (adjustment.type === 'lock') {
        schedule.slots[index] = { ...schedule.slots[index], locked: adjustment.locked !== false };
    } else if (adjustment.type === 'move') {
        if (schedule.slots[index].locked) throw new Error('锁定课节不能移动');
        const next = {
            ...schedule.slots[index],
            day: Number.parseInt(adjustment.day, 10),
            period: Number.parseInt(adjustment.period, 10),
        };
        const usage = rebuildUsage(schedule.slots, slotId);
        const check = canUseSlot(project, usage, next);
        if (!check.ok) throw new Error(check.reason);
        schedule.slots[index] = next;
    } else {
        throw new Error('未知的课表调整类型');
    }

    const unplaced = schedule.unplaced || [];
    const conflicts = [
        ...buildUnplacedConflicts(unplaced),
        ...detectScheduleConflicts(project, schedule.slots),
    ];
    schedule.conflicts = conflicts;
    schedule.lockedSlots = schedule.slots.filter(slot => slot.locked);
    schedule.score = buildTimetableScore(project, schedule.slots, unplaced, conflicts);

    return {
        success: conflicts.length === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}

export function applyScheduleAdjustment(input = {}, adjustment = {}) {
    const project = normalizeTimetableProject(input);
    const schedule = normalizeSchedule(project.schedule) || { slots: [], conflicts: [], unplaced: [], score: {} };
    const slotId = cleanText(adjustment.slotId, 120);
    const index = schedule.slots.findIndex(slot => slot.id === slotId);
    if (index < 0) throw new Error('No timetable slot was found for adjustment');

    const selectedSlot = schedule.slots[index];
    const blockIndexes = blockSlotIndexes(schedule, selectedSlot);
    const blockSlots = blockIndexes
        .map(slotIndex => schedule.slots[slotIndex])
        .sort((left, right) => (left.blockIndex || 0) - (right.blockIndex || 0));
    const blockSlotIds = new Set(blockSlots.map(slot => slot.id));

    if (adjustment.type === 'clear') {
        schedule.slots = schedule.slots.filter(slot => !blockSlotIds.has(slot.id));
    } else if (adjustment.type === 'lock') {
        schedule.slots = schedule.slots.map(slot => (
            blockSlotIds.has(slot.id)
                ? { ...slot, locked: adjustment.locked !== false }
                : slot
        ));
    } else if (adjustment.type === 'move') {
        if (blockSlots.some(slot => slot.locked)) throw new Error('Locked timetable slots cannot be moved');
        const day = Number.parseInt(adjustment.day, 10);
        const period = Number.parseInt(adjustment.period, 10);
        const selectedBlockIndex = Number.isInteger(Number(selectedSlot.blockIndex))
            ? Number(selectedSlot.blockIndex)
            : blockSlots.findIndex(slot => slot.id === selectedSlot.id);
        const startPeriod = period - Math.max(0, selectedBlockIndex);
        const usage = rebuildUsageExcludingIds(schedule.slots, blockSlotIds);
        const nextSlots = new Map();

        blockSlots.forEach((slot, orderIndex) => {
            const relativeIndex = Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : orderIndex;
            const next = {
                ...slot,
                day,
                period: startPeriod + relativeIndex,
            };
            const check = canUseSlot(project, usage, next);
            if (!check.ok) throw new Error(check.reason);
            addUsage(usage, next);
            nextSlots.set(slot.id, next);
        });
        schedule.slots = schedule.slots.map(slot => nextSlots.get(slot.id) || slot);
    } else {
        throw new Error('Unknown timetable adjustment type');
    }

    const unplaced = schedule.unplaced || [];
    const conflicts = [
        ...buildUnplacedConflicts(unplaced),
        ...detectScheduleConflicts(project, schedule.slots),
    ];
    schedule.conflicts = conflicts;
    schedule.lockedSlots = schedule.slots.filter(slot => slot.locked);
    schedule.score = buildTimetableScore(project, schedule.slots, unplaced, conflicts);

    return {
        success: conflicts.length === 0 && unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}
