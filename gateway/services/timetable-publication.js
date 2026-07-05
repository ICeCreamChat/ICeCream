import crypto from 'node:crypto';

export const PUBLICATION_FINGERPRINT_MISMATCH = 'publication_fingerprint_mismatch';
export const PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE = '发布快照校验失败，请重新发布后再导出或恢复。';

export function nextPublishVersion(schedule = {}) {
    return Math.max(0, Number.parseInt(schedule?.published?.version, 10) || 0) + 1;
}

export function fingerprintPayload(value) {
    if (Array.isArray(value)) return value.map(fingerprintPayload);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value)
        .filter(key => key !== 'fingerprint')
        .sort()
        .reduce((payload, key) => {
            const next = fingerprintPayload(value[key]);
            if (next !== undefined) payload[key] = next;
            return payload;
        }, {});
}

export function publicationFingerprint(snapshot = {}) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(fingerprintPayload(snapshot)))
        .digest('hex');
}

export function publishedHistoryEntry(published = null) {
    if (!published?.snapshot) return null;
    return {
        version: Number.parseInt(published.version, 10) || 1,
        publishedAt: published.publishedAt || null,
        scheduleId: published.scheduleId || published.snapshot?.scheduleId || null,
        note: published.note || '',
        fingerprint: published.fingerprint || published.snapshot?.fingerprint || '',
        snapshot: published.snapshot,
    };
}

export function publicationEntryWithVerifiedFingerprint(entry = null) {
    const snapshot = entry?.snapshot || null;
    if (!snapshot || typeof snapshot !== 'object') return entry;
    const verification = verifyPublishedSnapshotFingerprint(entry);
    if (!verification.ok) return null;
    const fingerprint = String(entry?.fingerprint || snapshot.fingerprint || verification.actual || '').trim();
    if (!fingerprint) return entry;
    return {
        ...entry,
        fingerprint,
        snapshot: {
            ...snapshot,
            fingerprint,
        },
    };
}

export function nextPublishedHistory(published = null, limit = 10) {
    const history = Array.isArray(published?.history)
        ? published.history.map(publicationEntryWithVerifiedFingerprint).filter(Boolean)
        : [];
    const currentEntry = publicationEntryWithVerifiedFingerprint(publishedHistoryEntry(published));
    if (
        currentEntry
        && !history.some(item => Number(item.version) === currentEntry.version)
    ) {
        history.push(currentEntry);
    }
    return history
        .sort((left, right) => Number(left.version || 0) - Number(right.version || 0))
        .slice(-limit);
}

function complexModelEnabled(project = {}) {
    return project?.timetableModelVersion === 'complex_v1' || project?.complexModelEnabled === true;
}

function legacyTeacherSnapshot(item = {}) {
    return {
        id: item.id,
        name: item.name,
        subjects: Array.isArray(item.subjects) ? [...item.subjects] : [],
        unavailableSlots: Array.isArray(item.unavailableSlots) ? [...item.unavailableSlots] : [],
    };
}

function legacyClassSnapshot(item = {}) {
    return {
        id: item.id,
        grade: item.grade,
        name: item.name,
    };
}

function legacyLessonPlanSnapshot(item = {}) {
    return {
        id: item.id,
        classId: item.classId,
        subjectId: item.subjectId,
        teacherId: item.teacherId,
        teacherIds: Array.isArray(item.teacherIds) ? [...item.teacherIds] : [],
        weeklyHours: item.weeklyHours,
        blockPreference: item.blockPreference || 'single',
        roomId: item.roomId || null,
        allowedRoomIds: Array.isArray(item.allowedRoomIds) ? [...item.allowedRoomIds] : [],
        className: item.className || '',
        subjectName: item.subjectName || '',
        teacherName: item.teacherName || '',
    };
}

function snapshotProjectContext(project = {}) {
    const complex = complexModelEnabled(project);
    return {
        schoolName: project.schoolName || '',
        term: project.term || '',
        weekdays: Number(project.weekdays || 0),
        periodsPerDay: Number(project.periodsPerDay || 0),
        activeWeekdays: Array.isArray(project.activeWeekdays) ? [...project.activeWeekdays] : [],
        activePeriods: Array.isArray(project.activePeriods) ? [...project.activePeriods] : [],
        dayPartBoundaries: project.dayPartBoundaries ? { ...project.dayPartBoundaries } : { afternoonStartPeriod: null, eveningStartPeriod: null },
        periodTimes: Array.isArray(project.periodTimes) ? project.periodTimes.map(item => ({ ...item })) : [],
        ...(complex ? {
            timetableModelVersion: 'complex_v1',
            complexModelEnabled: true,
            campuses: Array.isArray(project.campuses) ? project.campuses.map(item => ({ ...item })) : [],
            rooms: Array.isArray(project.rooms) ? project.rooms.map(item => ({ ...item })) : [],
            teachingGroups: Array.isArray(project.teachingGroups) ? project.teachingGroups.map(item => ({ ...item })) : [],
            commuteRules: project.commuteRules ? JSON.parse(JSON.stringify(project.commuteRules)) : { defaultGapPeriods: 1, teacherGapPeriods: {} },
        } : {}),
        teachers: Array.isArray(project.teachers)
            ? project.teachers.map(item => (complex ? { ...item } : legacyTeacherSnapshot(item)))
            : [],
        classes: Array.isArray(project.classes)
            ? project.classes.map(item => (complex ? { ...item } : legacyClassSnapshot(item)))
            : [],
        subjects: Array.isArray(project.subjects) ? project.subjects.map(item => ({ ...item })) : [],
        lessonPlans: Array.isArray(project.lessonPlans)
            ? project.lessonPlans.map(item => (complex ? { ...item } : legacyLessonPlanSnapshot(item)))
            : [],
        rules: project.rules ? JSON.parse(JSON.stringify(project.rules)) : null,
    };
}

function publishedSlotSnapshot(slot = {}, complex = false) {
    return {
        id: slot.id,
        day: slot.day,
        period: slot.period,
        classId: slot.classId,
        subjectId: slot.subjectId,
        teacherId: slot.teacherId,
        teacherIds: Array.isArray(slot.teacherIds) ? [...slot.teacherIds] : [],
        lessonPlanId: slot.lessonPlanId,
        roomId: slot.roomId || null,
        blockId: slot.blockId || null,
        blockIndex: slot.blockIndex || 0,
        blockSize: slot.blockSize || 1,
        locked: Boolean(slot.locked),
        manuallyAdjusted: Boolean(slot.manuallyAdjusted),
        ...(complex ? {
            weekPattern: slot.weekPattern || 'every',
            campusId: slot.campusId || '',
            teachingGroupId: slot.teachingGroupId || '',
            classIds: Array.isArray(slot.classIds) ? [...slot.classIds] : [slot.classId].filter(Boolean),
        } : {}),
    };
}

export function buildPublishedSnapshot(schedule = {}, publication = {}, project = {}) {
    const complex = complexModelEnabled(project);
    const snapshot = {
        scheduleId: schedule.id || null,
        generatedAt: schedule.generatedAt || null,
        source: schedule.source || null,
        slotCount: (schedule.slots || []).length,
        score: schedule.score || {},
        publicationSummary: publication.summary || {},
        projectContext: snapshotProjectContext(project),
        slots: (schedule.slots || []).map(slot => publishedSlotSnapshot(slot, complex)),
    };
    return {
        ...snapshot,
        fingerprint: publicationFingerprint(snapshot),
    };
}

export function findPublishedHistoryEntry(published = null, version = null) {
    const requested = Number.parseInt(version, 10);
    if (!Number.isInteger(requested)) return null;
    const history = Array.isArray(published?.history) ? published.history : [];
    return history.find(item => Number.parseInt(item.version, 10) === requested) || null;
}

export function resolvePublishedRestoreEntry(published = null, version = null) {
    if (version !== undefined && version !== null && String(version).trim() !== '') {
        return findPublishedHistoryEntry(published, version);
    }
    return publishedHistoryEntry(published);
}

export function verifyPublishedSnapshotFingerprint(entry = null) {
    const snapshot = entry?.snapshot || null;
    if (!snapshot || typeof snapshot !== 'object') {
        return { ok: true, expected: '', actual: '' };
    }
    const expected = String(entry?.fingerprint || snapshot.fingerprint || '').trim();
    if (!expected) {
        return { ok: true, expected: '', actual: publicationFingerprint(snapshot) };
    }
    const actual = publicationFingerprint(snapshot);
    if (expected.toLowerCase() === actual) {
        return { ok: true, expected, actual };
    }
    return {
        ok: false,
        reason: PUBLICATION_FINGERPRINT_MISMATCH,
        message: PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE,
        expected,
        actual,
    };
}
