const DEFAULT_SUBJECT_COLORS = [
    '#2563eb',
    '#16a34a',
    '#d97706',
    '#7c3aed',
    '#dc2626',
    '#0891b2',
    '#4f46e5',
    '#65a30d',
];

const DEFAULT_PROJECT = {
    id: 'default',
    schoolName: 'ICeCream 学校',
    term: '2026-2027 第一学期',
    weekdays: 5,
    periodsPerDay: 7,
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
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

export function cleanText(value, max = 80) {
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

export function normalizeIdList(values = []) {
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

function rangeList(max) {
    return Array.from({ length: Math.max(0, max) }, (_, index) => index + 1);
}

function normalizeNumberList(values, fallback, min, max) {
    const raw = Array.isArray(values) ? values : [];
    const normalized = raw
        .map(value => Number.parseInt(value, 10))
        .filter(value => Number.isInteger(value) && value >= min && value <= max);
    const source = normalized.length ? normalized : fallback;
    return [...new Set(source)].sort((left, right) => left - right);
}

export function getActiveWeekdays(project = {}) {
    return normalizeNumberList(project.activeWeekdays, rangeList(intInRange(project.weekdays, DEFAULT_PROJECT.weekdays, 1, 7)), 1, 7);
}

export function getActivePeriods(project = {}) {
    return normalizeNumberList(project.activePeriods, rangeList(intInRange(project.periodsPerDay, DEFAULT_PROJECT.periodsPerDay, 1, 12)), 1, 12);
}

export function isActiveTimetableSlot(project = {}, day, period) {
    return getActiveWeekdays(project).includes(Number(day)) && getActivePeriods(project).includes(Number(period));
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

function normalizeSubjectPreferredPeriods(raw = {}) {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const subjectId = cleanText(key, 80);
        if (!subjectId || !value || typeof value !== 'object') continue;
        const prefer = normalizeSlotList(value.prefer || value.preferred || value.slots);
        const avoid = normalizeSlotList(value.avoid || value.blocked || value.disliked);
        const weight = Math.max(1, Math.min(100, Number.parseInt(value.weight, 10) || 20));
        if (prefer.length || avoid.length) {
            result[subjectId] = { prefer, avoid, weight };
        }
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
            subjectPreferredPeriods: normalizeSubjectPreferredPeriods(softRules.subjectPreferredPeriods),
        },
    };
}

export function normalizeSchedule(raw) {
    if (!raw || !Array.isArray(raw.slots)) return null;
    return {
        id: cleanText(raw.id, 80) || `schedule_${Date.now()}`,
        generatedAt: raw.generatedAt || new Date().toISOString(),
        source: cleanText(raw.source, 80) || null,
        slots: raw.slots.map(slot => {
            const teacherIds = normalizeIdList(slot.teacherIds);
            const teacherId = cleanText(slot.teacherId, 80) || teacherIds[0] || '';
            if (teacherId && !teacherIds.includes(teacherId)) teacherIds.unshift(teacherId);
            return {
                id: cleanText(slot.id, 120),
                day: Number.parseInt(slot.day, 10),
                period: Number.parseInt(slot.period, 10),
                classId: cleanText(slot.classId, 80),
                subjectId: cleanText(slot.subjectId, 80),
                teacherId,
                teacherIds,
                lessonPlanId: cleanText(slot.lessonPlanId, 80),
                roomId: cleanText(slot.roomId, 80) || null,
                blockId: cleanText(slot.blockId, 120) || null,
                blockIndex: Number.isInteger(Number(slot.blockIndex)) ? Number(slot.blockIndex) : 0,
                blockSize: Math.max(1, Number.parseInt(slot.blockSize, 10) || 1),
                locked: Boolean(slot.locked),
            };
        }).filter(slot => slot.id && slot.classId && slot.subjectId && slot.teacherId && Number.isInteger(slot.day) && Number.isInteger(slot.period)),
        lockedSlots: Array.isArray(raw.lockedSlots) ? raw.lockedSlots : [],
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
        unplaced: Array.isArray(raw.unplaced) ? raw.unplaced : [],
        score: raw.score || {},
        solverStats: raw.solverStats || null,
    };
}

export function normalizeTimetableProject(raw = {}) {
    const base = { ...DEFAULT_PROJECT, ...raw };
    const legacyWeekdays = intInRange(base.weekdays, DEFAULT_PROJECT.weekdays, 1, 7);
    const legacyPeriodsPerDay = intInRange(base.periodsPerDay, DEFAULT_PROJECT.periodsPerDay, 1, 12);
    const hasActiveWeekdays = Object.prototype.hasOwnProperty.call(raw, 'activeWeekdays');
    const hasActivePeriods = Object.prototype.hasOwnProperty.call(raw, 'activePeriods');
    const activeWeekdays = normalizeNumberList(hasActiveWeekdays ? raw.activeWeekdays : [], rangeList(legacyWeekdays), 1, 7);
    const activePeriods = normalizeNumberList(hasActivePeriods ? raw.activePeriods : [], rangeList(legacyPeriodsPerDay), 1, 12);
    const teachers = (Array.isArray(base.teachers) ? base.teachers : []).map(normalizeTeacher);
    const classes = (Array.isArray(base.classes) ? base.classes : []).map(normalizeClass);
    const subjects = (Array.isArray(base.subjects) ? base.subjects : []).map(normalizeSubject);
    const lessonPlans = (Array.isArray(base.lessonPlans) ? base.lessonPlans : []).map(normalizeLessonPlan)
        .filter(plan => plan.classId && plan.subjectId && plan.teacherId && plan.weeklyHours > 0);
    return {
        id: cleanText(base.id, 80) || 'default',
        schoolName: cleanText(base.schoolName, 80) || DEFAULT_PROJECT.schoolName,
        term: cleanText(base.term, 80) || DEFAULT_PROJECT.term,
        weekdays: Math.max(...activeWeekdays),
        periodsPerDay: Math.max(...activePeriods),
        activeWeekdays,
        activePeriods,
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
    return normalizeTimetableProject(overrides);
}

export function getTimetableEntityMaps(project) {
    return {
        teachers: new Map(project.teachers.map(item => [item.id, item])),
        classes: new Map(project.classes.map(item => [item.id, item])),
        subjects: new Map(project.subjects.map(item => [item.id, item])),
        plans: new Map(project.lessonPlans.map(item => [item.id, item])),
    };
}

export function slotTeacherIds(slot) {
    const ids = normalizeIdList(slot?.teacherIds);
    if (slot?.teacherId && !ids.includes(slot.teacherId)) ids.unshift(slot.teacherId);
    return ids;
}
