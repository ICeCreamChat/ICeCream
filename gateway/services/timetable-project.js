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
    timetableModelVersion: 'legacy',
    complexModelEnabled: false,
    schoolName: 'ICeCream 学校',
    term: '2026-2027 第一学期',
    weekdays: 5,
    periodsPerDay: 7,
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
    dayPartBoundaries: {
        afternoonStartPeriod: null,
        eveningStartPeriod: null,
    },
    periodTimes: [],
    teachers: [],
    classes: [],
    subjects: [],
    campuses: [],
    rooms: [],
    teachingGroups: [],
    commuteRules: {
        defaultGapPeriods: 1,
        teacherGapPeriods: {},
    },
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

const WEEK_PATTERNS = new Set(['every', 'odd', 'even', 'odd_even']);
const TEACHING_GROUP_MODES = new Set(['combined_class', 'rotation', 'split_class']);
const TIME_BLOCK_KINDS = new Set(['teaching', 'duty', 'display']);
const DUTY_ASSIGNMENT_STATUSES = new Set(['active', 'paused']);

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

export function normalizeSubjectTags(value = []) {
    const raw = Array.isArray(value) ? value : [value];
    const tags = [];
    for (const item of raw) {
        String(item ?? '')
            .split(/[,，、/;；|\s]+/)
            .map(part => cleanText(part, 40))
            .filter(Boolean)
            .forEach(tag => {
                const normalized = /^[a-z0-9_-]+$/i.test(tag) ? tag.toLowerCase() : tag;
                if (!tags.includes(normalized)) tags.push(normalized);
            });
    }
    return tags;
}

export function normalizeSubjectCategory(value = '', fallbackName = '') {
    const explicit = cleanText(value, 40).toLowerCase();
    const text = explicit || cleanText(fallbackName, 80).toLowerCase();
    if (!text) return 'normal';
    if (['main', 'core', 'major'].includes(text) || /main|core|major|chinese|math|english/.test(text)
        || /\u4e3b\u79d1|\u6838\u5fc3|\u8bed\u6587|\u6570\u5b66|\u82f1\u8bed|\u5916\u8bed/.test(text)) {
        return 'main';
    }
    if (['quality', 'elective', 'arts', 'sport', 'pe'].includes(text) || /quality|elective|arts?|sport|music|pe|labor|ict/.test(text)
        || /\u7d20\u8d28|\u827a\u4f53|\u4f53\u80b2|\u97f3\u4e50|\u7f8e\u672f|\u52b3\u52a8|\u4fe1\u606f/.test(text)) {
        return 'quality';
    }
    if (['lab', 'experiment', 'experimental'].includes(text) || /lab|experiment/.test(text)
        || /\u5b9e\u9a8c/.test(text)) {
        return 'lab';
    }
    return ['normal', 'regular', 'other'].includes(text) ? 'normal' : 'normal';
}

function defaultSubjectPriority(category) {
    if (category === 'main') return 95;
    if (category === 'lab') return 60;
    if (category === 'quality') return 35;
    return 50;
}

function intInRange(value, fallback, min, max) {
    const num = Number.parseInt(value, 10);
    if (!Number.isInteger(num)) return fallback;
    return Math.max(min, Math.min(max, num));
}

export function normalizeWeekPattern(value = '', fallback = 'every') {
    const normalized = cleanText(value, 40).toLowerCase()
        .replace(/[-\s]+/g, '_');
    if (WEEK_PATTERNS.has(normalized)) return normalized;
    if (['single', 'odd_week', 'odd_weeks'].includes(normalized)) return 'odd';
    if (['double', 'even_week', 'even_weeks'].includes(normalized)) return 'even';
    if (['both', 'mixed', 'odd_even_week', 'odd_even_weeks'].includes(normalized)) return 'odd_even';
    return WEEK_PATTERNS.has(fallback) ? fallback : 'every';
}

export function isComplexTimetableModel(project = {}) {
    return project?.timetableModelVersion === 'complex_v1' || project?.complexModelEnabled === true;
}

function weekPatternSet(value = 'every') {
    const pattern = normalizeWeekPattern(value, 'every');
    if (pattern === 'odd') return new Set(['odd']);
    if (pattern === 'even') return new Set(['even']);
    return new Set(['odd', 'even']);
}

export function weekPatternsOverlap(left = 'every', right = 'every') {
    const leftSet = weekPatternSet(left);
    const rightSet = weekPatternSet(right);
    return [...leftSet].some(item => rightSet.has(item));
}

function complexModelEnabled(raw = {}) {
    return isComplexTimetableModel(raw);
}

function normalizeCampus(raw = {}, index = 0) {
    const name = cleanText(raw.name || raw.campusName || `校区${index + 1}`, 60);
    return {
        id: cleanText(raw.id, 80) || makeTimetableId('campus', name),
        name,
    };
}

function normalizeRoom(raw = {}, index = 0, enabled = false) {
    const name = cleanText(raw.name || raw.roomName || `教室${index + 1}`, 60);
    return {
        id: cleanText(raw.id, 80) || makeTimetableId('room', name),
        name,
        campusId: enabled ? cleanText(raw.campusId || raw.campus, 80) : '',
        capacity: Math.max(0, Math.min(5000, Number.parseInt(raw.capacity, 10) || 0)),
        tags: normalizeSubjectTags(raw.tags || raw.roomTags || raw.attributes),
    };
}

function normalizeRoomRequirement(raw = {}, enabled = false) {
    if (!enabled || !raw || typeof raw !== 'object') {
        return {
            preferredRoomIds: [],
            allowedRoomIds: [],
            requiredTags: [],
        };
    }
    return {
        preferredRoomIds: normalizeIdList(raw.preferredRoomIds || raw.roomIds || raw.rooms),
        allowedRoomIds: normalizeIdList(raw.allowedRoomIds),
        requiredTags: normalizeSubjectTags(raw.requiredTags || raw.tags),
    };
}

function normalizeTeachingGroup(raw = {}, index = 0) {
    const classIds = normalizeIdList(raw.classIds || raw.classes);
    const subjectIds = normalizeIdList(raw.subjectIds || raw.subjects);
    const name = cleanText(raw.name || raw.groupName || `教学组${index + 1}`, 80);
    const mode = TEACHING_GROUP_MODES.has(cleanText(raw.mode, 40)) ? cleanText(raw.mode, 40) : 'combined_class';
    return {
        id: cleanText(raw.id, 80) || makeTimetableId('tg', `${name}-${classIds.join('-')}-${subjectIds.join('-')}`),
        name,
        mode,
        classIds,
        subjectIds,
        teacherIds: normalizeIdList(raw.teacherIds),
        roomIds: normalizeIdList(raw.roomIds),
    };
}

function normalizeCommuteRules(raw = {}, enabled = false) {
    if (!enabled) {
        return {
            defaultGapPeriods: 1,
            teacherGapPeriods: {},
        };
    }
    const defaultGapPeriods = Math.max(0, Math.min(12, Number.parseInt(raw.defaultGapPeriods ?? raw.defaultGap ?? raw.gapPeriods, 10) || 1));
    const teacherGapPeriods = {};
    for (const [key, value] of Object.entries(raw.teacherGapPeriods || raw.teacherGaps || {})) {
        const teacherId = cleanText(key, 80);
        const gap = Number.parseInt(value, 10);
        if (teacherId && Number.isInteger(gap) && gap >= 0) {
            teacherGapPeriods[teacherId] = Math.min(12, gap);
        }
    }
    return { defaultGapPeriods, teacherGapPeriods };
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

export function normalizeTimeBlockKind(value, fallback = 'teaching') {
    const kind = cleanText(value, 20);
    if (TIME_BLOCK_KINDS.has(kind)) return kind;
    return TIME_BLOCK_KINDS.has(fallback) ? fallback : 'teaching';
}

export function getTimeBlockKind(segment = {}) {
    return normalizeTimeBlockKind(segment.kind, 'teaching');
}

function isEarlyStudyLabel(label = '') {
    return /早自习|早读|早修|晨读/.test(cleanText(label, 40));
}

function isEveningStudyLabel(label = '') {
    return /晚自习|晚修/.test(cleanText(label, 40));
}

export function suggestTimeBlockKind(segment = {}) {
    const label = cleanText(segment.label, 40);
    if (isEarlyStudyLabel(label) || isEveningStudyLabel(label)) return 'duty';
    return 'teaching';
}

function segmentPeriodCount(segment = {}) {
    return Math.max(0, Math.min(12, Number.parseInt(segment.periodCount, 10) || 0));
}

export function getTotalPeriodsFromSegments(periodTimeSegments = null) {
    const segments = Array.isArray(periodTimeSegments?.segments) ? periodTimeSegments.segments : [];
    return segments.reduce((sum, segment) => sum + segmentPeriodCount(segment), 0);
}

export function getTeachingPeriodCount(periodTimeSegments = null) {
    const segments = Array.isArray(periodTimeSegments?.segments) ? periodTimeSegments.segments : [];
    return segments
        .filter(segment => getTimeBlockKind(segment) === 'teaching')
        .reduce((sum, segment) => sum + segmentPeriodCount(segment), 0);
}

export function deriveActivePeriodsFromTimeBlocks(periodTimeSegments = null) {
    return rangeList(Math.min(12, getTeachingPeriodCount(periodTimeSegments)));
}

export function getActiveWeekdays(project = {}) {
    return normalizeNumberList(project.activeWeekdays, rangeList(intInRange(project.weekdays, DEFAULT_PROJECT.weekdays, 1, 7)), 1, 7);
}

export function getActivePeriods(project = {}) {
    const segmentPeriods = deriveActivePeriodsFromTimeBlocks(project.periodTimeSegments);
    if (Array.isArray(project.periodTimeSegments?.segments) && project.periodTimeSegments.segments.length) return segmentPeriods;
    return normalizeNumberList(project.activePeriods, rangeList(intInRange(project.periodsPerDay, DEFAULT_PROJECT.periodsPerDay, 1, 12)), 1, 12);
}

export function isActiveTimetableSlot(project = {}, day, period) {
    return getActiveWeekdays(project).includes(Number(day)) && getActivePeriods(project).includes(Number(period));
}

function fallbackAfternoonStartPeriod(activePeriods = []) {
    const splitIndex = Math.ceil(activePeriods.length / 2);
    return splitIndex < activePeriods.length ? activePeriods[splitIndex] : null;
}

export function normalizeDayPartBoundaries(raw, activePeriods = []) {
    const periods = [...new Set((Array.isArray(activePeriods) ? activePeriods : [])
        .map(value => Number.parseInt(value, 10))
        .filter(Number.isInteger))]
        .sort((left, right) => left - right);
    const periodIndex = new Map(periods.map((period, index) => [period, index]));
    const normalizeBoundary = value => {
        const period = Number.parseInt(value, 10);
        if (!Number.isInteger(period) || !periodIndex.has(period)) return null;
        return period;
    };

    let afternoonStartPeriod = normalizeBoundary(raw?.afternoonStartPeriod);
    if (afternoonStartPeriod !== null && periodIndex.get(afternoonStartPeriod) <= 0) {
        afternoonStartPeriod = null;
    }

    let eveningStartPeriod = normalizeBoundary(raw?.eveningStartPeriod);
    if (eveningStartPeriod !== null) {
        const eveningIndex = periodIndex.get(eveningStartPeriod);
        const afternoonIndex = afternoonStartPeriod === null ? -1 : periodIndex.get(afternoonStartPeriod);
        if (eveningIndex <= Math.max(afternoonIndex, 0)) {
            eveningStartPeriod = null;
        }
    }

    return {
        afternoonStartPeriod,
        eveningStartPeriod,
    };
}

export function getDayPartBoundaries(project = {}, periods = null) {
    return normalizeDayPartBoundaries(
        project?.dayPartBoundaries,
        periods || getActivePeriods(project),
    );
}

export function getDayPartPeriods(project = {}, part = 'morning') {
    const activePeriods = getActivePeriods(project);
    if (!activePeriods.length) return [];
    const boundaries = getDayPartBoundaries(project, activePeriods);
    const afternoonStartPeriod = boundaries.afternoonStartPeriod ?? fallbackAfternoonStartPeriod(activePeriods);
    const eveningStartPeriod = boundaries.eveningStartPeriod;

    if (part === 'evening') {
        if (eveningStartPeriod === null) return [];
        return activePeriods.filter(period => period >= eveningStartPeriod);
    }
    if (part === 'afternoon') {
        if (afternoonStartPeriod === null) return [];
        return activePeriods.filter(period => period >= afternoonStartPeriod && (eveningStartPeriod === null || period < eveningStartPeriod));
    }
    if (boundaries.afternoonStartPeriod !== null) {
        return activePeriods.filter(period => period < boundaries.afternoonStartPeriod);
    }
    const splitIndex = Math.ceil(activePeriods.length / 2);
    return activePeriods.slice(0, splitIndex);
}

export function isMorningPeriod(project = {}, period) {
    return getDayPartPeriods(project, 'morning').includes(Number(period));
}

export function isAfternoonPeriod(project = {}, period) {
    return getDayPartPeriods(project, 'afternoon').includes(Number(period));
}

export function isEveningPeriod(project = {}, period) {
    return getDayPartPeriods(project, 'evening').includes(Number(period));
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function timeToMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

function minutesToTime(minutes) {
    const bounded = Math.max(0, Math.min(23 * 60 + 59, Math.round(Number(minutes) || 0)));
    return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}

export function normalizePeriodTimes(raw, activePeriods = []) {
    if (!Array.isArray(raw)) return [];
    const activeSet = new Set(activePeriods);
    return raw
        .filter(item => item && activeSet.has(Number(item.period)))
        .map(item => ({
            period: Number(item.period),
            start: TIME_RE.test(String(item.start || '')) ? String(item.start) : '',
            end: TIME_RE.test(String(item.end || '')) ? String(item.end) : '',
        }))
        .sort((a, b) => a.period - b.period);
}

export function normalizePeriodTimeSegment(raw = {}, index = 0, options = {}) {
    const id = cleanText(raw.id, 40) || `seg-${index + 1}`;
    const label = cleanText(raw.label, 40) || `时段${index + 1}`;
    const startTime = TIME_RE.test(String(raw.startTime || '')) ? String(raw.startTime) : '08:00';
    const periodCount = Math.max(1, Math.min(12, Number.parseInt(raw.periodCount, 10) || 1));
    const classMinutes = raw.classMinutes === null || raw.classMinutes === undefined
        ? null
        : Math.max(1, Math.min(180, Number.parseInt(raw.classMinutes, 10) || 45));
    const breakMinutes = raw.breakMinutes === null || raw.breakMinutes === undefined
        ? null
        : Math.max(0, Math.min(120, Number.parseInt(raw.breakMinutes, 10) || 10));
    const rawKindText = cleanText(raw.kind, 20);
    const rawKind = TIME_BLOCK_KINDS.has(rawKindText) ? rawKindText : '';
    let kind = rawKind || suggestTimeBlockKind({ label });
    return {
        id,
        label,
        startTime,
        periodCount,
        classMinutes,
        breakMinutes,
        kind: normalizeTimeBlockKind(kind, 'teaching'),
    };
}

function splitAdditionalSegmentLabel(label = '', index = 0, total = 1) {
    if (total <= 1) return label || '附加时段';
    return `${label || '附加时段'}${index + 1}`;
}

function splitAdditionalSegmentId(id = '', index = 0) {
    return `${id || 'seg'}__p${index + 1}`;
}

function expandPeriodTimeSegment(segment = {}, globalDefaults = {}) {
    const kind = getTimeBlockKind(segment);
    const periodCount = segmentPeriodCount(segment);
    if (kind === 'teaching' || periodCount <= 1) return [segment];
    const startMinutes = timeToMinutes(segment.startTime);
    const classMinutes = Math.max(1, Math.min(180, Number.parseInt(segment.classMinutes ?? globalDefaults.classMinutes, 10) || 45));
    const breakMinutes = Math.max(0, Math.min(120, Number.parseInt(segment.breakMinutes ?? globalDefaults.breakMinutes, 10) || 0));
    return Array.from({ length: periodCount }, (_, index) => ({
        ...segment,
        id: splitAdditionalSegmentId(segment.id, index),
        label: splitAdditionalSegmentLabel(segment.label, index, periodCount),
        startTime: startMinutes === null ? segment.startTime : minutesToTime(startMinutes + index * (classMinutes + breakMinutes)),
        periodCount: 1,
        classMinutes,
        breakMinutes,
    }));
}

export function normalizePeriodTimeSegments(raw = null, options = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const globalDefaults = {
        classMinutes: Math.max(1, Math.min(180, Number.parseInt(raw.globalDefaults?.classMinutes, 10) || 45)),
        breakMinutes: Math.max(0, Math.min(120, Number.parseInt(raw.globalDefaults?.breakMinutes, 10) || 10)),
    };
    const segments = Array.isArray(raw.segments)
        ? raw.segments
            .map((seg, index) => normalizePeriodTimeSegment(seg, index, options))
            .flatMap(segment => expandPeriodTimeSegment(segment, globalDefaults))
            .slice(0, 10)
        : [];
    if (!segments.length) return null;
    return { globalDefaults, segments };
}

function buildDutyTimeBlockMigration(rawSegments = [], normalizedSegments = [], globalDefaults = {}) {
    const normalizedIds = new Set(normalizedSegments.map(segment => segment.id));
    const migration = new Map();
    rawSegments.forEach((rawSegment, index) => {
        const normalized = normalizePeriodTimeSegment(rawSegment, index);
        const kind = getTimeBlockKind(normalized);
        const periodCount = segmentPeriodCount(normalized);
        if (kind === 'teaching' || periodCount <= 1) return;
        const targets = Array.from({ length: periodCount }, (_, itemIndex) => splitAdditionalSegmentId(normalized.id, itemIndex))
            .filter(id => normalizedIds.has(id));
        if (targets.length > 1) migration.set(normalized.id, targets);
    });
    return migration;
}

function migrateDutyAssignmentsForSplitTimeBlocks(raw = [], rawPeriodTimeSegments = null, normalizedPeriodTimeSegments = null) {
    if (!Array.isArray(raw) || !raw.length) return raw;
    const rawSegments = Array.isArray(rawPeriodTimeSegments?.segments) ? rawPeriodTimeSegments.segments : [];
    const normalizedSegments = Array.isArray(normalizedPeriodTimeSegments?.segments) ? normalizedPeriodTimeSegments.segments : [];
    const migration = buildDutyTimeBlockMigration(rawSegments, normalizedSegments, normalizedPeriodTimeSegments?.globalDefaults || {});
    if (!migration.size) return raw;
    return raw.flatMap(item => {
        const timeBlockId = cleanText(item?.timeBlockId || item?.segmentId, 80);
        const targets = migration.get(timeBlockId);
        if (!targets?.length) return [item];
        return targets.map((targetId, index) => ({
            ...item,
            id: item?.id ? `${item.id}__p${index + 1}` : undefined,
            timeBlockId: targetId,
        }));
    });
}

export function validateDutyAssignments(raw = [], periodTimeSegments = null, options = {}) {
    const errors = [];
    if (!Array.isArray(raw)) {
        return {
            ok: false,
            errors: [{ index: -1, field: 'dutyAssignments', message: '值班安排必须是数组。' }],
        };
    }

    const segments = Array.isArray(periodTimeSegments?.segments) ? periodTimeSegments.segments : [];
    const segmentById = new Map(segments.map(segment => [segment.id, segment]));
    const knownClasses = new Set((options.classes || []).map(item => item.id).filter(Boolean));
    const knownTeachers = new Set((options.teachers || []).map(item => item.id).filter(Boolean));
    const seen = new Set();

    raw.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            errors.push({ index, field: 'dutyAssignments', message: '值班安排格式无效。' });
            return;
        }
        const day = Number.parseInt(item.day ?? item.weekday, 10);
        const classId = cleanText(item.classId, 80);
        const timeBlockId = cleanText(item.timeBlockId || item.segmentId, 80);
        const teacherId = cleanText(item.teacherId, 80);
        if (!Number.isInteger(day) || day < 1 || day > 7) {
            errors.push({ index, field: 'day', message: '值班日期必须是周一到周日。' });
        }
        if (!classId || (knownClasses.size && !knownClasses.has(classId))) {
            errors.push({ index, field: 'classId', message: '值班班级不存在。' });
        }
        if (!teacherId || (knownTeachers.size && !knownTeachers.has(teacherId))) {
            errors.push({ index, field: 'teacherId', message: '值班老师不存在。' });
        }
        const segment = segmentById.get(timeBlockId);
        if (!timeBlockId || !segment || getTimeBlockKind(segment) !== 'duty') {
            errors.push({ index, field: 'timeBlockId', message: '值班时段必须指向已开启值班老师的附加时段，不能使用正式节次、未开启值班或不存在的时段。' });
        }
        const key = `${day}|${classId}|${timeBlockId}`;
        if (classId && timeBlockId && seen.has(key)) {
            errors.push({ index, field: 'dutyAssignments', message: '同一班级同一天同一自习时段只能安排一名值班老师。' });
        }
        if (classId && timeBlockId) seen.add(key);
    });

    return { ok: errors.length === 0, errors };
}

export function normalizeDutyAssignments(raw = [], periodTimeSegments = null, options = {}) {
    if (!Array.isArray(raw)) return [];
    const dutyBlockIds = new Set((periodTimeSegments?.segments || [])
        .filter(segment => getTimeBlockKind(segment) === 'duty')
        .map(segment => segment.id));
    if (!dutyBlockIds.size) return [];

    const knownClasses = new Set((options.classes || []).map(item => item.id).filter(Boolean));
    const knownTeachers = new Set((options.teachers || []).map(item => item.id).filter(Boolean));
    const seen = new Set();
    const assignments = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const day = Number.parseInt(item.day ?? item.weekday, 10);
        const classId = cleanText(item.classId, 80);
        const timeBlockId = cleanText(item.timeBlockId || item.segmentId, 80);
        const teacherId = cleanText(item.teacherId, 80);
        if (!Number.isInteger(day) || day < 1 || day > 7) continue;
        if (!classId || !timeBlockId || !teacherId) continue;
        if (!dutyBlockIds.has(timeBlockId)) continue;
        if (knownClasses.size && !knownClasses.has(classId)) continue;
        if (knownTeachers.size && !knownTeachers.has(teacherId)) continue;
        const key = `${day}|${classId}|${timeBlockId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const normalized = {
            id: cleanText(item.id, 120) || makeTimetableId('duty', `${key}|${teacherId}`),
            day,
            classId,
            timeBlockId,
            teacherId,
            source: cleanText(item.source, 40) || 'manual',
            status: DUTY_ASSIGNMENT_STATUSES.has(item.status) ? item.status : 'active',
        };
        const sourceSheet = cleanText(item.sourceSheet, 80);
        const rawText = cleanText(item.rawText, 300);
        const parseSource = cleanText(item.parseSource, 40);
        const sourceRow = Number.parseInt(item.sourceRow, 10);
        if (sourceSheet) normalized.sourceSheet = sourceSheet;
        if (Number.isInteger(sourceRow) && sourceRow > 0) normalized.sourceRow = sourceRow;
        if (rawText) normalized.rawText = rawText;
        if (parseSource) normalized.parseSource = parseSource;
        assignments.push(normalized);
    }

    return assignments;
}

export function generateDefaultPeriodTimes(activePeriods = [], options = {}) {
    const {
        startHour = 8,
        startMinute = 0,
        durationMinutes = 40,
        breakMinutes = 10,
        lunchMinutes = 60,
        lunchAfterPeriod = 4,
    } = options;
    let minutes = startHour * 60 + startMinute;
    return activePeriods.map(period => {
        if (period > lunchAfterPeriod && period === activePeriods.find(p => p > lunchAfterPeriod)) {
            // First afternoon period: add lunch break
            const lastMorning = activePeriods.filter(p => p <= lunchAfterPeriod).pop();
            if (lastMorning) {
                const morningEnd = startHour * 60 + startMinute
                    + activePeriods.filter(p => p <= lunchAfterPeriod).length * durationMinutes
                    + (activePeriods.filter(p => p <= lunchAfterPeriod).length - 1) * breakMinutes;
                minutes = morningEnd + lunchMinutes;
            }
        }
        const start = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        minutes += durationMinutes;
        const end = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        minutes += breakMinutes;
        return { period, start, end };
    });
}

function normalizeTeacher(raw = {}, index = 0, enabled = false) {
    const name = cleanText(raw.name || raw.teacherName || `教师${index + 1}`, 40);
    const id = cleanText(raw.id, 60) || makeTimetableId('t', name);
    return {
        id,
        name,
        subjects: Array.isArray(raw.subjects) ? raw.subjects.map(value => cleanText(value, 60)).filter(Boolean) : [],
        unavailableSlots: normalizeSlotList(raw.unavailableSlots),
        campusId: enabled ? cleanText(raw.campusId || raw.campus, 80) : '',
    };
}

function normalizeClass(raw = {}, index = 0, enabled = false) {
    const grade = cleanText(raw.grade || '默认年级', 40);
    const name = cleanText(raw.name || raw.className || `班级${index + 1}`, 40);
    const id = cleanText(raw.id, 60) || makeTimetableId('c', `${grade}-${name}`);
    return {
        id,
        grade,
        name,
        campusId: enabled ? cleanText(raw.campusId || raw.campus, 80) : '',
    };
}

function normalizeSubject(raw = {}, index = 0) {
    const name = cleanText(raw.name || raw.subjectName || `课程${index + 1}`, 40);
    const id = cleanText(raw.id, 60) || makeTimetableId('s', name);
    const category = normalizeSubjectCategory(raw.category || raw.subjectCategory || raw.type || raw.subjectType, name);
    const tags = normalizeSubjectTags(raw.tags || raw.subjectTags);
    return {
        id,
        name,
        category,
        tags,
        priority: intInRange(raw.priority, defaultSubjectPriority(category), 1, 100),
        color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : DEFAULT_SUBJECT_COLORS[index % DEFAULT_SUBJECT_COLORS.length],
    };
}

function normalizeLessonPlan(raw = {}, index = 0, enabled = false) {
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
        weekPattern: normalizeWeekPattern(enabled ? raw.weekPattern : '', 'every'),
        campusId: enabled ? cleanText(raw.campusId || raw.campus, 80) : '',
        teachingGroupId: enabled ? cleanText(raw.teachingGroupId || raw.groupId, 80) : '',
        roomRequirement: normalizeRoomRequirement(raw.roomRequirement, enabled),
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

function normalizeSubjectPreferredPeriods(raw = {}, enabled = false) {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const subjectId = cleanText(key, 80);
        if (!subjectId || !value || typeof value !== 'object') continue;
        const prefer = normalizeSlotList(value.prefer || value.preferred || value.slots);
        const avoid = normalizeSlotList(value.avoid || value.blocked || value.disliked);
        const weight = Math.max(1, Math.min(100, Number.parseInt(value.weight, 10) || 20));
        if (prefer.length || avoid.length) {
            result[subjectId] = {
                prefer,
                avoid,
                weight,
                ...(enabled && value.weekPattern ? { weekPattern: normalizeWeekPattern(value.weekPattern) } : {}),
            };
        }
    }
    return result;
}

// 教师每日/连续节次上限：{ teacherId: { daily?: n, consecutive?: n } }
function normalizeTeacherLimits(raw = {}) {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const teacherId = cleanText(key, 80);
        if (!teacherId || !value || typeof value !== 'object') continue;
        const daily = Number.parseInt(value.daily ?? value.dailyLimit ?? value.maxPerDay, 10);
        const consecutive = Number.parseInt(value.consecutive ?? value.consecutiveLimit ?? value.maxConsecutive, 10);
        const entry = {};
        if (Number.isInteger(daily) && daily > 0) entry.daily = Math.min(12, daily);
        if (Number.isInteger(consecutive) && consecutive > 0) entry.consecutive = Math.min(12, consecutive);
        if (Object.keys(entry).length) result[teacherId] = entry;
    }
    return result;
}

// 需要在一周内分散开（避免同天扎堆）的课程 id 列表
function normalizeSpreadSubjects(values = []) {
    return Array.isArray(values)
        ? [...new Set(values.map(value => cleanText(value, 80)).filter(Boolean))]
        : [];
}

function normalizeIntMap(raw = {}, min = 1, max = 12) {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const id = cleanText(key, 80);
        const intValue = Number.parseInt(value, 10);
        if (!id || !Number.isInteger(intValue)) continue;
        result[id] = Math.max(min, Math.min(max, intValue));
    }
    return result;
}

function normalizeIdGroupList(values = []) {
    return (Array.isArray(values) ? values : [])
        .map(item => {
            const teacherIds = normalizeIdList(item?.teacherIds || item?.teachers || item);
            return teacherIds.length >= 2 ? { teacherIds } : null;
        })
        .filter(Boolean);
}

function normalizeSubjectPairList(values = []) {
    return (Array.isArray(values) ? values : [])
        .map(item => {
            const subjectIds = normalizeIdList(item?.subjectIds || item?.subjects || item);
            const classIds = normalizeIdList(item?.classIds || item?.classes || []);
            return subjectIds.length >= 2 ? { subjectIds: subjectIds.slice(0, 2), classIds } : null;
        })
        .filter(Boolean);
}

function normalizeRoomRequirements(raw = {}) {
    const result = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const subjectId = cleanText(key, 80);
        if (!subjectId || !value) continue;
        const roomIds = normalizeIdList(value.roomIds || value.allowedRoomIds || value.rooms || value);
        const requiredTags = normalizeIdList(value.requiredTags || value.tags || []);
        if (roomIds.length || requiredTags.length) {
            result[subjectId] = {
                roomIds,
                ...(requiredTags.length ? { requiredTags } : {}),
            };
        }
    }
    return result;
}

function normalizeSequenceList(values = []) {
    return (Array.isArray(values) ? values : [])
        .map(item => {
            const beforeSubjectId = cleanText(item?.beforeSubjectId || item?.before || item?.subjectId, 80);
            const afterSubjectId = cleanText(item?.afterSubjectId || item?.after || item?.nextSubjectId, 80);
            const classIds = normalizeIdList(item?.classIds || item?.classes || []);
            const weight = intInRange(item?.weight, 1, 1, 10);
            return beforeSubjectId && afterSubjectId && beforeSubjectId !== afterSubjectId
                ? { beforeSubjectId, afterSubjectId, classIds, weight }
                : null;
        })
        .filter(Boolean);
}

function normalizeClassDailyBalance(raw = {}) {
    return {
        enabled: Boolean(raw?.enabled),
        mainSubjectDailyMax: intInRange(raw?.mainSubjectDailyMax, 0, 0, 8),
    };
}

function normalizeTeacherLoadBalance(raw = null, legacyBalanced = true) {
    const hasExplicitRule = raw && typeof raw === 'object' && Object.keys(raw).length > 0;
    if (hasExplicitRule) {
        return {
            enabled: raw.enabled !== false,
            weight: intInRange(raw.weight, 1, 1, 10),
            explicit: raw.explicit !== false,
        };
    }
    return {
        enabled: legacyBalanced !== false,
        weight: 1,
        explicit: false,
    };
}

function normalizeLockedSlots(values = [], enabled = false) {
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
            ...(enabled ? {
                weekPattern: normalizeWeekPattern(item.weekPattern, 'every'),
                campusId: cleanText(item.campusId || item.campus, 80),
                teachingGroupId: cleanText(item.teachingGroupId || item.groupId, 80),
            } : {}),
        }))
        .filter(item => Number.isInteger(item.day) && Number.isInteger(item.period) && item.classId && item.subjectId && item.teacherId);
}

function normalizeRules(raw = {}, enabled = false) {
    const hardRules = raw.hardRules || {};
    const softRules = raw.softRules || {};
    return {
        hardRules: {
            lockedSlots: normalizeLockedSlots(hardRules.lockedSlots, enabled),
            teacherUnavailable: normalizeRuleMap(hardRules.teacherUnavailable),
            classUnavailable: normalizeRuleMap(hardRules.classUnavailable),
            globalUnavailable: normalizeSlotList(hardRules.globalUnavailable),
            subjectDailyLimit: normalizeIntMap(hardRules.subjectDailyLimit, 1, 8),
            teacherWeeklyLimit: normalizeIntMap(hardRules.teacherWeeklyLimit, 1, 40),
            teacherMaxDaysPerWeek: normalizeIntMap(hardRules.teacherMaxDaysPerWeek, 1, 7),
            teacherMutualExclusion: normalizeIdGroupList(hardRules.teacherMutualExclusion),
            subjectNotSameDay: normalizeSubjectPairList(hardRules.subjectNotSameDay),
            roomRequirements: normalizeRoomRequirements(hardRules.roomRequirements),
        },
        softRules: {
            morningSubjects: Array.isArray(softRules.morningSubjects)
                ? softRules.morningSubjects.map(value => cleanText(value, 80)).filter(Boolean)
                : [],
            balancedTeacherLoad: softRules.balancedTeacherLoad !== false,
            subjectPreferredPeriods: normalizeSubjectPreferredPeriods(softRules.subjectPreferredPeriods, enabled),
            teacherLimits: normalizeTeacherLimits(softRules.teacherLimits),
            spreadSubjects: normalizeSpreadSubjects(softRules.spreadSubjects),
            spreadSubjectGaps: normalizeIntMap(softRules.spreadSubjectGaps || softRules.spreadMinGapDays, 1, 7),
            afternoonSubjects: normalizeIdList(softRules.afternoonSubjects),
            subjectDailySoftLimit: normalizeIntMap(softRules.subjectDailySoftLimit, 1, 8),
            subjectSequence: normalizeSequenceList(softRules.subjectSequence),
            teacherGapWeight: intInRange(softRules.teacherGapWeight, 0, 0, 10),
            classDailyBalance: normalizeClassDailyBalance(softRules.classDailyBalance),
            teacherLoadBalance: normalizeTeacherLoadBalance(softRules.teacherLoadBalance, softRules.balancedTeacherLoad),
        },
    };
}

function normalizePublishedSnapshotTeacher(raw = {}, index = 0, enabled = false) {
    if (enabled) return normalizeTeacher(raw, index, true);
    const name = cleanText(raw.name || raw.teacherName || `教师${index + 1}`, 40);
    return {
        id: cleanText(raw.id, 60) || makeTimetableId('t', name),
        name,
        subjects: Array.isArray(raw.subjects) ? raw.subjects.map(value => cleanText(value, 60)).filter(Boolean) : [],
        unavailableSlots: normalizeSlotList(raw.unavailableSlots),
    };
}

function normalizePublishedSnapshotClass(raw = {}, index = 0, enabled = false) {
    if (enabled) return normalizeClass(raw, index, true);
    const grade = cleanText(raw.grade || '默认年级', 40);
    const name = cleanText(raw.name || raw.className || `班级${index + 1}`, 40);
    return {
        id: cleanText(raw.id, 60) || makeTimetableId('c', `${grade}-${name}`),
        grade,
        name,
    };
}

function normalizePublishedSnapshotLessonPlan(raw = {}, index = 0, enabled = false) {
    if (enabled) return normalizeLessonPlan(raw, index, true);
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

function normalizePublishedSnapshot(rawSnapshot, fallback = {}, enabled = false) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') return null;
    const fingerprint = cleanText(rawSnapshot.fingerprint || fallback.fingerprint, 80);
    return {
        scheduleId: cleanText(rawSnapshot.scheduleId, 80) || cleanText(fallback.scheduleId, 80) || cleanText(fallback.id, 80) || null,
        generatedAt: rawSnapshot.generatedAt || fallback.generatedAt || null,
        source: cleanText(rawSnapshot.source, 80) || cleanText(fallback.source, 80) || null,
        slotCount: Math.max(0, Number.parseInt(rawSnapshot.slotCount, 10) || 0),
        ...(fingerprint ? { fingerprint } : {}),
        score: rawSnapshot.score && typeof rawSnapshot.score === 'object' ? rawSnapshot.score : {},
        publicationSummary: rawSnapshot.publicationSummary && typeof rawSnapshot.publicationSummary === 'object'
            ? rawSnapshot.publicationSummary
            : {},
        projectContext: rawSnapshot.projectContext && typeof rawSnapshot.projectContext === 'object'
            ? {
                schoolName: cleanText(rawSnapshot.projectContext.schoolName, 80),
                term: cleanText(rawSnapshot.projectContext.term, 80),
                weekdays: intInRange(rawSnapshot.projectContext.weekdays, DEFAULT_PROJECT.weekdays, 1, 7),
                periodsPerDay: intInRange(rawSnapshot.projectContext.periodsPerDay, DEFAULT_PROJECT.periodsPerDay, 1, 12),
                activeWeekdays: normalizeNumberList(rawSnapshot.projectContext.activeWeekdays, [], 1, 7),
                activePeriods: normalizeNumberList(rawSnapshot.projectContext.activePeriods, [], 1, 12),
                ...(Object.prototype.hasOwnProperty.call(rawSnapshot.projectContext, 'dayPartBoundaries')
                    ? {
                        dayPartBoundaries: normalizeDayPartBoundaries(
                            rawSnapshot.projectContext.dayPartBoundaries,
                            normalizeNumberList(rawSnapshot.projectContext.activePeriods, [], 1, 12),
                        ),
                    }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(rawSnapshot.projectContext, 'periodTimes')
                    ? {
                        periodTimes: normalizePeriodTimes(
                            rawSnapshot.projectContext.periodTimes,
                            normalizeNumberList(rawSnapshot.projectContext.activePeriods, [], 1, 12),
                        ),
                    }
                    : {}),
                ...(enabled ? {
                    timetableModelVersion: 'complex_v1',
                    complexModelEnabled: true,
                    campuses: Array.isArray(rawSnapshot.projectContext.campuses)
                        ? rawSnapshot.projectContext.campuses.map(normalizeCampus)
                        : [],
                    rooms: Array.isArray(rawSnapshot.projectContext.rooms)
                        ? rawSnapshot.projectContext.rooms.map((room, index) => normalizeRoom(room, index, true))
                        : [],
                    teachingGroups: Array.isArray(rawSnapshot.projectContext.teachingGroups)
                        ? rawSnapshot.projectContext.teachingGroups.map(normalizeTeachingGroup)
                        : [],
                    commuteRules: normalizeCommuteRules(rawSnapshot.projectContext.commuteRules, true),
                } : {}),
                teachers: Array.isArray(rawSnapshot.projectContext.teachers)
                    ? rawSnapshot.projectContext.teachers.map((teacher, index) => normalizePublishedSnapshotTeacher(teacher, index, enabled))
                    : [],
                classes: Array.isArray(rawSnapshot.projectContext.classes)
                    ? rawSnapshot.projectContext.classes.map((klass, index) => normalizePublishedSnapshotClass(klass, index, enabled))
                    : [],
                subjects: Array.isArray(rawSnapshot.projectContext.subjects)
                    ? rawSnapshot.projectContext.subjects.map(normalizeSubject)
                    : [],
                lessonPlans: Array.isArray(rawSnapshot.projectContext.lessonPlans)
                    ? rawSnapshot.projectContext.lessonPlans.map((plan, index) => normalizePublishedSnapshotLessonPlan(plan, index, enabled))
                        .filter(plan => plan.classId && plan.subjectId && plan.teacherId && plan.weeklyHours > 0)
                    : [],
                rules: normalizeRules(rawSnapshot.projectContext.rules || {}, enabled),
            }
            : null,
        slots: Array.isArray(rawSnapshot.slots)
            ? rawSnapshot.slots.map(slot => ({
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
                manuallyAdjusted: Boolean(slot.manuallyAdjusted),
                ...(enabled ? {
                    weekPattern: normalizeWeekPattern(slot.weekPattern, 'every'),
                    campusId: cleanText(slot.campusId || slot.campus, 80),
                    teachingGroupId: cleanText(slot.teachingGroupId || slot.groupId, 80),
                    classIds: normalizeIdList([slot.classId, ...(slot.classIds || [])]),
                } : {}),
            })).filter(slot => slot.id && Number.isInteger(slot.day) && Number.isInteger(slot.period))
            : [],
    };
}

function normalizePublishedHistory(values = [], fallback = {}) {
    return (Array.isArray(values) ? values : [])
        .map(item => {
            if (!item || typeof item !== 'object') return null;
            const snapshot = normalizePublishedSnapshot(item.snapshot, {
                ...fallback,
                scheduleId: item.scheduleId,
            }, complexModelEnabled(item.snapshot?.projectContext || fallback));
            if (!snapshot) return null;
            return {
                version: Math.max(1, Number.parseInt(item.version, 10) || 1),
                publishedAt: item.publishedAt || null,
                scheduleId: cleanText(item.scheduleId, 80) || snapshot.scheduleId || null,
                note: cleanText(item.note, 200),
                fingerprint: cleanText(item.fingerprint || snapshot.fingerprint, 80),
                snapshot,
            };
        })
        .filter(Boolean)
        .sort((left, right) => Number(left.version || 0) - Number(right.version || 0));
}

function normalizePublicationState(raw = null) {
    if (!raw || typeof raw !== 'object') return null;
    const blockingIssues = Array.isArray(raw.blockingIssues) ? raw.blockingIssues : [];
    const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
    const legacyPublicationIssues = [...blockingIssues, ...warnings]
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            ...item,
            severity: item.severity || (blockingIssues.includes(item) ? 'error' : 'warning'),
        }));
    const issueEntries = Array.isArray(raw.issueEntries)
        ? raw.issueEntries
        : Array.isArray(raw.reviewItems)
            ? raw.reviewItems
            : legacyPublicationIssues;
    const reviewItems = Array.isArray(raw.reviewItems)
        ? raw.reviewItems
        : issueEntries;
    return {
        ...raw,
        blockingIssues,
        warnings,
        issueEntries,
        reviewItems,
        summary: raw.summary && typeof raw.summary === 'object' ? raw.summary : {},
    };
}

export function publicationIssueEntries(publication = null) {
    if (!publication || typeof publication !== 'object') return [];
    const normalized = normalizePublicationState(publication);
    const preferredEntries = Array.isArray(publication.issueEntries) && publication.issueEntries.length
        ? normalized.issueEntries
        : Array.isArray(publication.reviewItems) && publication.reviewItems.length
            ? normalized.reviewItems
            : [
                ...(normalized.blockingIssues || []).map(item => ({ ...item, severity: item?.severity || 'error' })),
                ...(normalized.warnings || []).map(item => ({ ...item, severity: item?.severity || 'warning' })),
            ];
    const combined = [...preferredEntries];
    const seen = new Set();
    return combined.filter(item => {
        if (!item || typeof item !== 'object') return false;
        const slot = item.slot?.day && item.slot?.period ? `${item.slot.day}-${item.slot.period}` : (item.slot || '');
        const key = [
            item.type || '',
            item.severity || '',
            item.targetKind || '',
            item.targetId || '',
            item.targetName || '',
            slot,
            item.message || '',
        ].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function normalizeSchedule(raw, enabled = false) {
    if (!raw || !Array.isArray(raw.slots)) return null;
    const snapshot = normalizePublishedSnapshot(raw.published?.snapshot, {
        scheduleId: raw.published?.scheduleId,
        id: raw.id,
        generatedAt: raw.generatedAt,
        source: raw.source,
    }, enabled);
    const history = normalizePublishedHistory(raw.published?.history, {
        id: raw.id,
        generatedAt: raw.generatedAt,
        source: raw.source,
        timetableModelVersion: enabled ? 'complex_v1' : 'legacy',
        complexModelEnabled: enabled,
    });
    const published = raw.published && typeof raw.published === 'object'
        ? {
            status: ['published', 'draft_changed'].includes(raw.published.status) ? raw.published.status : 'published',
            version: Math.max(1, Number.parseInt(raw.published.version, 10) || 1),
            publishedAt: raw.published.publishedAt || null,
            scheduleId: cleanText(raw.published.scheduleId, 80) || cleanText(raw.id, 80) || null,
            note: cleanText(raw.published.note, 200),
            fingerprint: cleanText(raw.published.fingerprint || snapshot?.fingerprint, 80),
            ...(snapshot ? { snapshot } : {}),
            ...(history.length ? { history } : {}),
        }
        : null;
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
                manuallyAdjusted: Boolean(slot.manuallyAdjusted),
                ...(enabled ? {
                    weekPattern: normalizeWeekPattern(slot.weekPattern, 'every'),
                    campusId: cleanText(slot.campusId || slot.campus, 80),
                    teachingGroupId: cleanText(slot.teachingGroupId || slot.groupId, 80),
                    classIds: normalizeIdList([slot.classId, ...(slot.classIds || [])]),
                } : {}),
            };
        }).filter(slot => slot.id && slot.classId && slot.subjectId && slot.teacherId && Number.isInteger(slot.day) && Number.isInteger(slot.period)),
        lockedSlots: Array.isArray(raw.lockedSlots) ? raw.lockedSlots : [],
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
        unplaced: Array.isArray(raw.unplaced) ? raw.unplaced : [],
        audit: raw.audit || null,
        qualityIssues: Array.isArray(raw.qualityIssues) ? raw.qualityIssues : [],
        publication: normalizePublicationState(raw.publication),
        diagnostics: raw.diagnostics && typeof raw.diagnostics === 'object' ? raw.diagnostics : null,
        published,
        score: raw.score || {},
        solverStats: raw.solverStats || null,
    };
}

export function normalizeTimetableProject(raw = {}) {
    const base = { ...DEFAULT_PROJECT, ...raw };
    const enabled = complexModelEnabled(base);
    const legacyWeekdays = intInRange(base.weekdays, DEFAULT_PROJECT.weekdays, 1, 7);
    const legacyPeriodsPerDay = intInRange(base.periodsPerDay, DEFAULT_PROJECT.periodsPerDay, 1, 12);
    const hasActiveWeekdays = Object.prototype.hasOwnProperty.call(raw, 'activeWeekdays');
    const hasActivePeriods = Object.prototype.hasOwnProperty.call(raw, 'activePeriods');
    const dutyAssignmentTimeBlockIds = new Set((Array.isArray(base.dutyAssignments) ? base.dutyAssignments : [])
        .map(item => cleanText(item?.timeBlockId || item?.segmentId, 80))
        .filter(Boolean));
    const periodTimeSegments = normalizePeriodTimeSegments(base.periodTimeSegments, { dutyAssignmentTimeBlockIds });
    const segmentActivePeriods = deriveActivePeriodsFromTimeBlocks(periodTimeSegments);
    const activeWeekdays = normalizeNumberList(hasActiveWeekdays ? raw.activeWeekdays : [], rangeList(legacyWeekdays), 1, 7);
    const activePeriods = periodTimeSegments
        ? segmentActivePeriods
        : normalizeNumberList(hasActivePeriods ? raw.activePeriods : [], rangeList(legacyPeriodsPerDay), 1, 12);
    const teachers = (Array.isArray(base.teachers) ? base.teachers : [])
        .map((teacher, index) => normalizeTeacher(teacher, index, enabled));
    const classes = (Array.isArray(base.classes) ? base.classes : [])
        .map((klass, index) => normalizeClass(klass, index, enabled));
    const subjects = (Array.isArray(base.subjects) ? base.subjects : []).map(normalizeSubject);
    const lessonPlans = (Array.isArray(base.lessonPlans) ? base.lessonPlans : [])
        .map((plan, index) => normalizeLessonPlan(plan, index, enabled))
        .filter(plan => plan.classId && plan.subjectId && plan.teacherId && plan.weeklyHours > 0);
    const migratedDutyAssignments = migrateDutyAssignmentsForSplitTimeBlocks(base.dutyAssignments, base.periodTimeSegments, periodTimeSegments);
    const normalized = {
        id: cleanText(base.id, 80) || 'default',
        timetableModelVersion: enabled ? 'complex_v1' : 'legacy',
        complexModelEnabled: enabled,
        schoolName: cleanText(base.schoolName, 80) || DEFAULT_PROJECT.schoolName,
        term: cleanText(base.term, 80) || DEFAULT_PROJECT.term,
        weekdays: Math.max(...activeWeekdays),
        periodsPerDay: activePeriods.length ? Math.max(...activePeriods) : 0,
        activeWeekdays,
        activePeriods,
        dayPartBoundaries: normalizeDayPartBoundaries(base.dayPartBoundaries, activePeriods),
        periodTimes: normalizePeriodTimes(base.periodTimes, activePeriods),
        teachers,
        classes,
        subjects,
        campuses: enabled && Array.isArray(base.campuses)
            ? base.campuses.map(normalizeCampus)
            : [],
        rooms: Array.isArray(base.rooms)
            ? base.rooms.map((room, index) => normalizeRoom(room, index, enabled))
            : [],
        teachingGroups: enabled && Array.isArray(base.teachingGroups)
            ? base.teachingGroups.map(normalizeTeachingGroup)
            : [],
        commuteRules: normalizeCommuteRules(base.commuteRules, enabled),
        lessonPlans,
        dutyAssignments: normalizeDutyAssignments(migratedDutyAssignments, periodTimeSegments, { classes, teachers }),
        rules: normalizeRules(base.rules, enabled),
        schedule: normalizeSchedule(base.schedule, enabled),
        version: base.version || Date.now(),
        updatedAt: base.updatedAt || new Date().toISOString(),
    };
    if (periodTimeSegments) {
        normalized.periodTimeSegments = periodTimeSegments;
    }
    return normalized;
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
        rooms: new Map((project.rooms || []).map(item => [item.id, item])),
        campuses: new Map((project.campuses || []).map(item => [item.id, item])),
        teachingGroups: new Map((project.teachingGroups || []).map(item => [item.id, item])),
    };
}

export function slotTeacherIds(slot) {
    const ids = normalizeIdList(slot?.teacherIds);
    if (slot?.teacherId && !ids.includes(slot.teacherId)) ids.unshift(slot.teacherId);
    return ids;
}

export function teachingGroupForPlan(project = {}, plan = {}) {
    const groupId = cleanText(plan.teachingGroupId || plan.groupId, 80);
    if (!groupId) return null;
    return (project.teachingGroups || []).find(item => item.id === groupId) || null;
}

export function classIdsForPlan(project = {}, plan = {}) {
    const ids = normalizeIdList([plan.classId, ...(plan.classIds || [])]);
    const group = teachingGroupForPlan(project, plan);
    for (const id of normalizeIdList(group?.classIds || [])) {
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

export function slotClassIds(slot = {}) {
    return normalizeIdList([slot.classId, ...(slot.classIds || [])]);
}

export function weekPatternForSlot(project = {}, slot = {}) {
    if (slot.weekPattern) return normalizeWeekPattern(slot.weekPattern, 'every');
    const plan = (project.lessonPlans || []).find(item => item.id === slot.lessonPlanId);
    return normalizeWeekPattern(plan?.weekPattern, 'every');
}

export function campusIdForSlot(project = {}, slot = {}) {
    if (slot.campusId) return cleanText(slot.campusId, 80);
    const plan = (project.lessonPlans || []).find(item => item.id === slot.lessonPlanId);
    if (plan?.campusId) return plan.campusId;
    const room = (project.rooms || []).find(item => item.id === slot.roomId);
    if (room?.campusId) return room.campusId;
    const klass = (project.classes || []).find(item => item.id === slot.classId);
    if (klass?.campusId) return klass.campusId;
    const teacher = (project.teachers || []).find(item => item.id === slot.teacherId);
    return teacher?.campusId || '';
}
