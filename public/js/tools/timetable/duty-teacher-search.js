import { pinyin } from '../../../vendor/pinyin-pro/index.mjs';

function normalizeSearchText(value = '') {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .toLowerCase();
}

function compactSearchText(value = '') {
    return normalizeSearchText(value).replace(/[\s._\-·]+/g, '');
}

function uniqueValues(values = []) {
    const seen = new Set();
    return values
        .map(value => String(value ?? '').trim())
        .filter(value => {
            if (!value || seen.has(value)) return false;
            seen.add(value);
            return true;
        });
}

function pinyinTokens(value = '') {
    const text = String(value || '').trim();
    if (!text) return [];
    let full = '';
    let initials = '';
    try {
        full = pinyin(text, { toneType: 'none' });
        initials = pinyin(text, { pattern: 'initial', toneType: 'none' });
    } catch {
        return [];
    }
    const syllables = full.split(/\s+/).filter(Boolean);
    const firstLetters = syllables.map(item => item[0] || '').join('');
    return uniqueValues([
        full,
        compactSearchText(full),
        initials,
        compactSearchText(initials),
        firstLetters,
    ]);
}

function itemTeacherIds(item = {}) {
    return uniqueValues([
        item.teacherId,
        ...(Array.isArray(item.teacherIds) ? item.teacherIds : []),
    ]);
}

function teacherSubjectDisplayLabels(project = {}, teacher = {}) {
    const subjects = new Map((project.subjects || []).map(item => [item.id, item]));
    return uniqueValues((teacher.subjects || []).map(subjectId => subjects.get(subjectId)?.name));
}

function teacherSubjectSearchLabels(project = {}, teacher = {}) {
    const subjects = new Map((project.subjects || []).map(item => [item.id, item]));
    return uniqueValues((teacher.subjects || []).flatMap(subjectId => [subjectId, subjects.get(subjectId)?.name]));
}

function classTeacherIds(project = {}, classId = '') {
    const ids = new Set();
    (project.lessonPlans || []).forEach(plan => {
        if (plan.classId !== classId) return;
        itemTeacherIds(plan).forEach(id => ids.add(id));
    });
    return ids;
}

function timeToMinutes(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
}

function periodInterval(project = {}, period) {
    const entry = (project.periodTimes || []).find(item => Number(item.period) === Number(period));
    const start = timeToMinutes(entry?.start);
    const end = timeToMinutes(entry?.end);
    if (start === null || end === null || end <= start) return null;
    return { start, end };
}

function segmentInterval(project = {}, segment = {}) {
    const start = timeToMinutes(segment.startTime);
    if (start === null) return null;
    const defaults = project.periodTimeSegments?.globalDefaults || {};
    const periodCount = Math.max(1, Number.parseInt(segment.periodCount, 10) || 1);
    const classMinutes = Math.max(1, Math.min(180, Number.parseInt(segment.classMinutes ?? defaults.classMinutes, 10) || 45));
    const breakMinutes = Math.max(0, Math.min(120, Number.parseInt(segment.breakMinutes ?? defaults.breakMinutes, 10) || 0));
    return {
        start,
        end: start + (periodCount * classMinutes) + Math.max(0, periodCount - 1) * breakMinutes,
    };
}

function intervalsOverlap(left = null, right = null) {
    if (!left || !right) return false;
    return left.start < right.end && right.start < left.end;
}

function teacherUnavailableKeys(project = {}, teacherId = '') {
    const teacher = (project.teachers || []).find(item => item.id === teacherId);
    return new Set([
        ...(teacher?.unavailableSlots || []),
        ...(project.rules?.hardRules?.teacherUnavailable?.[teacherId] || []),
    ]);
}

function dutySegment(project = {}, timeBlockId = '') {
    return (project.periodTimeSegments?.segments || []).find(item => item.id === timeBlockId) || null;
}

function dutyAssignmentConflict(project = {}, { day, classId, timeBlockId, teacherId, interval }) {
    return (project.dutyAssignments || []).find(item => {
        if (!item || item.status === 'paused') return false;
        if (item.teacherId !== teacherId || Number(item.day) !== Number(day)) return false;
        if (item.classId === classId && item.timeBlockId === timeBlockId) return false;
        const otherInterval = segmentInterval(project, dutySegment(project, item.timeBlockId) || {});
        return intervalsOverlap(interval, otherInterval);
    }) || null;
}

function lessonConflict(project = {}, { day, teacherId, interval }) {
    return (project.schedule?.slots || []).find(slot => (
        Number(slot.day) === Number(day)
        && itemTeacherIds(slot).includes(teacherId)
        && intervalsOverlap(interval, periodInterval(project, slot.period))
    )) || null;
}

function unavailableConflict(project = {}, { day, timeBlockId, teacherId, interval }) {
    const blocked = teacherUnavailableKeys(project, teacherId);
    if (!blocked.size) return false;
    if (blocked.has(`${Number(day)}-${timeBlockId}`)) return true;
    return (project.periodTimes || []).some(item => (
        blocked.has(`${Number(day)}-${Number(item.period)}`)
        && intervalsOverlap(interval, periodInterval(project, item.period))
    ));
}

function teacherConflictReason(project = {}, context = {}) {
    if (!context.teacherId || !context.interval) return '';
    if (dutyAssignmentConflict(project, context)) return '该时段已在其他班值班';
    if (lessonConflict(project, context)) return '该时段已有正式课';
    if (unavailableConflict(project, context)) return '教师不可排';
    return '';
}

function teacherSearchText(project = {}, teacher = {}) {
    const subjectLabels = teacherSubjectSearchLabels(project, teacher);
    const tokens = uniqueValues([
        teacher.id,
        teacher.name,
        ...subjectLabels,
        ...pinyinTokens(teacher.name || ''),
    ]);
    return uniqueValues([
        ...tokens,
        ...tokens.map(compactSearchText),
    ]).join(' ');
}

function teacherMatchRank(option = {}, query = '') {
    const normalized = normalizeSearchText(query);
    const compact = compactSearchText(query);
    if (!normalized && !compact) return 0;
    const tokens = String(option.searchText || '').split(/\s+/).filter(Boolean);
    if (tokens.some(token => normalizeSearchText(token) === normalized || compactSearchText(token) === compact)) return 0;
    if (tokens.some(token => normalizeSearchText(token).startsWith(normalized) || compactSearchText(token).startsWith(compact))) return 1;
    if (tokens.some(token => normalizeSearchText(token).includes(normalized) || compactSearchText(token).includes(compact))) return 2;
    return 99;
}

function matchesQuery(option = {}, query = '') {
    return teacherMatchRank(option, query) < 99;
}

export function dutyTeacherSearchQuery(value = '') {
    return compactSearchText(value);
}

export function buildDutyTeacherSearchModel(project = {}, {
    day = null,
    classId = '',
    timeBlockId = '',
    teacherId = '',
    query = '',
} = {}) {
    const recommendedTeacherIds = classTeacherIds(project, classId);
    const selectedTeacherId = String(teacherId || '');
    const interval = segmentInterval(project, dutySegment(project, timeBlockId) || {});
    const options = (project.teachers || []).map((teacher, index) => {
        const id = teacher.id || '';
        const label = teacher.name || id || '未命名老师';
        const subjectLabels = teacherSubjectDisplayLabels(project, teacher);
        const conflictReason = teacherConflictReason(project, {
            day,
            classId,
            timeBlockId,
            teacherId: id,
            interval,
        });
        const selected = id === selectedTeacherId;
        const recommended = recommendedTeacherIds.has(id);
        return {
            id,
            label,
            meta: subjectLabels.join(' / '),
            searchText: teacherSearchText(project, teacher),
            selected,
            recommended,
            conflictReason,
            disabled: Boolean(conflictReason && !selected),
            originalIndex: index,
        };
    });
    const visibleOptions = options
        .filter(option => matchesQuery(option, query))
        .sort((left, right) => {
            const leftRank = teacherMatchRank(left, query);
            const rightRank = teacherMatchRank(right, query);
            if (leftRank !== rightRank) return leftRank - rightRank;
            if (left.selected !== right.selected) return left.selected ? -1 : 1;
            if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
            if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
            return left.originalIndex - right.originalIndex;
        });
    return {
        options,
        visibleOptions,
        selectedTeacher: options.find(option => option.selected) || null,
        hasQuery: Boolean(compactSearchText(query)),
    };
}
