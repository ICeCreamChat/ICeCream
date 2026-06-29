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

function snapshotProjectContext(project = {}) {
    return {
        schoolName: project.schoolName || '',
        term: project.term || '',
        weekdays: Number(project.weekdays || 0),
        periodsPerDay: Number(project.periodsPerDay || 0),
        activeWeekdays: Array.isArray(project.activeWeekdays) ? [...project.activeWeekdays] : [],
        activePeriods: Array.isArray(project.activePeriods) ? [...project.activePeriods] : [],
        periodTimes: Array.isArray(project.periodTimes) ? project.periodTimes.map(item => ({ ...item })) : [],
        teachers: Array.isArray(project.teachers) ? project.teachers.map(item => ({ ...item })) : [],
        classes: Array.isArray(project.classes) ? project.classes.map(item => ({ ...item })) : [],
        subjects: Array.isArray(project.subjects) ? project.subjects.map(item => ({ ...item })) : [],
        lessonPlans: Array.isArray(project.lessonPlans) ? project.lessonPlans.map(item => ({ ...item })) : [],
        rules: project.rules ? JSON.parse(JSON.stringify(project.rules)) : null,
    };
}

export function buildPublishedSnapshot(schedule = {}, publication = {}, project = {}) {
    const snapshot = {
        scheduleId: schedule.id || null,
        generatedAt: schedule.generatedAt || null,
        source: schedule.source || null,
        slotCount: (schedule.slots || []).length,
        score: schedule.score || {},
        publicationSummary: publication.summary || {},
        projectContext: snapshotProjectContext(project),
        slots: (schedule.slots || []).map(slot => ({
            id: slot.id,
            day: slot.day,
            period: slot.period,
            classId: slot.classId,
            subjectId: slot.subjectId,
            teacherId: slot.teacherId,
            teacherIds: slot.teacherIds || [],
            lessonPlanId: slot.lessonPlanId,
            roomId: slot.roomId || null,
            blockId: slot.blockId || null,
            blockIndex: slot.blockIndex || 0,
            blockSize: slot.blockSize || 1,
            locked: Boolean(slot.locked),
            manuallyAdjusted: Boolean(slot.manuallyAdjusted),
        })),
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
