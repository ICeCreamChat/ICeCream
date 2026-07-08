import {
    getActivePeriods,
    getActiveWeekdays,
    getTimetableEntityMaps,
    isActiveTimetableSlot,
    normalizeTimetableProject,
    slotKey,
    slotTeacherIds,
} from './timetable-project.js';
import {
    detectScheduleConflicts,
} from './timetable-conflicts.js';
import {
    auditTimetableProject,
} from './timetable-audit.js';
import {
    publishedHistoryEntry,
    PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE,
    verifyPublishedSnapshotFingerprint,
} from './timetable-publication.js';

function result(ok, reason, message, details = {}) {
    return { ok, reason, message, details };
}

const LEGACY_NON_ACTIONABLE_REVIEW_TYPES = new Set(['class_load', 'subject_spread', 'morning_subject_late']);

function hasExplicitTeacherConsecutiveLimit(project = {}, item = {}) {
    const teacherId = item.teacherId || (item.targetKind === 'teacher' ? item.targetId : '') || '';
    const limit = project.rules?.softRules?.teacherLimits?.[teacherId]?.consecutive;
    return teacherId
        && limit !== undefined
        && limit !== null
        && limit !== ''
        && Number.isInteger(Number(limit));
}

export function isActionablePublicationIssue(item = {}, project = {}) {
    if (item.type === 'teacher_consecutive') {
        return hasExplicitTeacherConsecutiveLimit(project, item);
    }
    return !LEGACY_NON_ACTIONABLE_REVIEW_TYPES.has(item.type);
}

export function validateTimetableProjectForSolve(input = {}) {
    const project = normalizeTimetableProject(input);
    const maps = getTimetableEntityMaps(project);

    if (!project.lessonPlans.length) {
        return result(false, 'missing_lesson_plans', '请先导入任课数据，再生成课表。');
    }
    if (!project.classes.length) {
        return result(false, 'missing_classes', '任课数据里没有班级。');
    }
    if (!project.teachers.length) {
        return result(false, 'missing_teachers', '任课数据里没有教师。');
    }
    if (!project.subjects.length) {
        return result(false, 'missing_subjects', '任课数据里没有课程。');
    }

    const invalidPlans = project.lessonPlans.filter(plan => (
        !maps.classes.has(plan.classId)
        || !maps.subjects.has(plan.subjectId)
        || !slotTeacherIds(plan).every(teacherId => maps.teachers.has(teacherId))
    ));
    if (invalidPlans.length) {
        return result(false, 'invalid_lesson_plan_refs', '任课数据引用了不存在的班级、课程或教师。', {
            lessonPlanIds: invalidPlans.map(plan => plan.id),
        });
    }

    const totalLessons = project.lessonPlans.reduce((sum, plan) => sum + plan.weeklyHours, 0);
    const classCapacity = getActiveWeekdays(project).length * getActivePeriods(project).length * project.classes.length;
    if (totalLessons > classCapacity) {
        return result(false, 'insufficient_slots', '总课时超过当前作息容量，请增加天数/节次或减少课时。', {
            totalLessons,
            classCapacity,
        });
    }

    return result(true, 'ready', '排课数据已就绪。', {
        totalLessons,
    });
}

function publicationIssue(type, message, extra = {}) {
    return { type, message, ...extra };
}

function countHardConflicts(conflicts = []) {
    return conflicts.filter(conflict => conflict.severity === 'hard' || !conflict.severity).length;
}

function publishedEntriesForReview(published = null) {
    const entries = [];
    const currentEntry = publishedHistoryEntry(published);
    if (currentEntry) {
        entries.push({ entry: currentEntry, targetName: '发布快照' });
    }
    const history = Array.isArray(published?.history) ? published.history : [];
    for (const item of history) {
        if (!item?.snapshot) continue;
        const version = Number.parseInt(item.version, 10);
        entries.push({
            entry: item,
            targetName: Number.isInteger(version) ? `发布历史 V${version}` : '发布历史',
        });
    }
    return entries;
}

function entityName(maps, kind, id) {
    if (!id) return '';
    if (kind === 'class') {
        const item = maps.classes.get(id);
        return item ? `${item.grade || ''}${item.name || item.id}` : id;
    }
    if (kind === 'teacher') return maps.teachers.get(id)?.name || id;
    if (kind === 'subject') return maps.subjects.get(id)?.name || id;
    return id;
}

function reviewItem(type, message, extra = {}) {
    return {
        type,
        severity: extra.severity || 'warning',
        targetKind: extra.targetKind || 'general',
        targetId: extra.targetId || '',
        targetName: extra.targetName || '',
        message,
        ...extra,
    };
}

function normalizePublicationIssueEntries(items = []) {
    const seen = new Set();
    return items.filter(item => {
        if (!item || item.type === 'quality_review') return false;
        const key = [item.severity, item.type, item.targetKind, item.targetId, item.message, item.slot || ''].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((left, right) => {
        const severityOrder = { error: 0, warning: 1, info: 2 };
        return (severityOrder[left.severity] ?? 3) - (severityOrder[right.severity] ?? 3)
            || left.type.localeCompare(right.type)
            || left.targetName.localeCompare(right.targetName, 'zh-Hans-CN');
    });
}

function buildPublicationIssueEntries({ project, maps, blockingIssues, warnings, detectedConflicts, unplaced, audit, qualityIssues }) {
    const items = [];
    for (const issue of blockingIssues) {
        if (issue.type === 'incomplete_schedule') {
            const byClass = new Map();
            for (const item of unplaced || []) {
                const classId = item.classId || maps.plans.get(item.lessonPlanId)?.classId || '';
                byClass.set(classId, (byClass.get(classId) || 0) + 1);
            }
            if (!byClass.size && issue.missingCount) byClass.set('', issue.missingCount);
            for (const [classId, count] of byClass) {
                const targetName = classId ? entityName(maps, 'class', classId) : '课表';
                items.push(reviewItem('incomplete_schedule', `${targetName} 还有 ${count} 节未排。`, {
                    severity: 'error',
                    targetKind: classId ? 'class' : 'schedule',
                    targetId: classId,
                    targetName,
                    count,
                }));
            }
            continue;
        }
        items.push(reviewItem(issue.type, issue.message || issue.type, {
            severity: 'error',
            count: issue.count || issue.missingCount || 0,
        }));
    }

    for (const conflict of detectedConflicts || []) {
        const slot = conflict.slot || {};
        const targetKind = conflict.teacherId || slot.teacherId ? 'teacher' : conflict.classId || slot.classId ? 'class' : conflict.roomId || slot.roomId ? 'room' : 'schedule';
        const targetId = conflict.teacherId || slot.teacherId || conflict.classId || slot.classId || conflict.roomId || slot.roomId || '';
        const targetName = targetKind === 'teacher'
            ? entityName(maps, 'teacher', targetId)
            : targetKind === 'class'
                ? entityName(maps, 'class', targetId)
                : targetId || '课表';
        items.push(reviewItem(conflict.type || 'hard_conflict', conflict.message || '存在硬冲突。', {
            severity: 'error',
            targetKind,
            targetId,
            targetName,
            slot: slot.day && slot.period ? slotKey(slot.day, slot.period) : '',
        }));
    }

    const auditWarnings = [
        ...(audit?.warnings || []),
        ...(audit?.blockingIssues || []).filter(item => item.type !== 'invalid_lesson_plan_refs'),
    ].filter(item => isActionablePublicationIssue(item, project));
    for (const item of auditWarnings) {
        const targetKind = item.teacherId ? 'teacher' : item.classId ? 'class' : item.roomId || item.rooms ? 'room' : 'schedule';
        const targetId = item.teacherId || item.classId || item.roomId || '';
        const targetName = item.name || (targetKind === 'teacher'
            ? entityName(maps, 'teacher', targetId)
            : targetKind === 'class'
                ? entityName(maps, 'class', targetId)
                : item.roomId || (item.rooms || []).join(' / ') || '课表');
        items.push(reviewItem(item.type, item.message || item.type, {
            severity: item.type?.endsWith('_capacity') ? 'error' : 'warning',
            targetKind,
            targetId,
            targetName,
            utilization: item.utilization,
        }));
    }

    for (const issue of (qualityIssues || []).filter(item => isActionablePublicationIssue(item, project))) {
        const targetKind = issue.teacherId ? 'teacher' : issue.classId ? 'class' : issue.subjectId ? 'subject' : 'schedule';
        const targetId = issue.teacherId || issue.classId || issue.subjectId || '';
        const targetName = targetKind === 'teacher'
            ? entityName(maps, 'teacher', targetId)
            : targetKind === 'class'
                ? entityName(maps, 'class', targetId)
                : targetKind === 'subject'
                    ? entityName(maps, 'subject', targetId)
                    : '课表';
        items.push(reviewItem(issue.type, issue.message || issue.type, {
            severity: issue.severity === 'info' ? 'info' : 'warning',
            targetKind,
            targetId,
            targetName,
            slot: issue.slot?.day && issue.slot?.period ? slotKey(issue.slot.day, issue.slot.period) : '',
        }));
    }

    for (const warning of warnings || []) {
        if (warning.type === 'quality_review') continue;
        const { type, message, ...extra } = warning;
        items.push(reviewItem(type, message || type, {
            ...extra,
            severity: 'warning',
        }));
    }

    return normalizePublicationIssueEntries(items);
}

function buildPublicationReviewItems(context = {}) {
    return buildPublicationIssueEntries(context);
}

export function validateTimetablePublication(input = {}) {
    const project = normalizeTimetableProject(input);
    const schedule = project.schedule;
    const maps = getTimetableEntityMaps(project);
    const slots = schedule?.slots || [];
    const unplaced = schedule?.unplaced || [];
    const totalLessons = project.lessonPlans.reduce((sum, plan) => sum + Number(plan.weeklyHours || 0), 0);
    const blockingIssues = [];
    const warnings = [];
    const audit = auditTimetableProject(project);

    if (!project.lessonPlans.length) {
        blockingIssues.push(publicationIssue('missing_lesson_plans', '请先导入任课数据。'));
    }
    if (!schedule) {
        blockingIssues.push(publicationIssue('missing_schedule', '请先生成课表。'));
    }

    const invalidSlots = slots.filter(slot => (
        !maps.classes.has(slot.classId)
        || !maps.subjects.has(slot.subjectId)
        || !maps.plans.has(slot.lessonPlanId)
        || !slotTeacherIds(slot).every(teacherId => maps.teachers.has(teacherId))
    ));
    if (invalidSlots.length) {
        blockingIssues.push(publicationIssue('invalid_schedule_refs', '课表里存在无效的班级、课程、教师或任课引用。', {
            count: invalidSlots.length,
            slotIds: invalidSlots.slice(0, 8).map(slot => slot.id),
        }));
    }

    const inactiveSlots = slots.filter(slot => !isActiveTimetableSlot(project, slot.day, slot.period));
    if (inactiveSlots.length) {
        blockingIssues.push(publicationIssue('inactive_slot', '课表里存在不在当前作息范围内的课节。', {
            count: inactiveSlots.length,
            slots: inactiveSlots.slice(0, 8).map(slot => slotKey(slot.day, slot.period)),
        }));
    }

    const detectedConflicts = schedule ? detectScheduleConflicts(project, slots) : [];
    const hardConflicts = countHardConflicts(detectedConflicts);
    if (hardConflicts > 0) {
        blockingIssues.push(publicationIssue('hard_conflicts', '课表仍存在教师、班级、教室或不可排时间冲突。', {
            count: hardConflicts,
            conflicts: detectedConflicts.slice(0, 8),
        }));
    }

    const placedLessons = slots.length;
    const unplacedLessons = Math.max(0, totalLessons - placedLessons, unplaced.length);
    if (unplacedLessons > 0) {
        blockingIssues.push(publicationIssue('incomplete_schedule', '还有课时未排入课表。', {
            missingCount: unplacedLessons,
            unplaced: unplaced.slice(0, 8),
        }));
    }

    const qualityIssues = (schedule?.qualityIssues || []).filter(item => isActionablePublicationIssue(item, project));
    if (qualityIssues.length) {
        warnings.push(publicationIssue('quality_review', '存在软规则或质量建议，发布前建议复核。', {
            count: qualityIssues.length,
        }));
    }
    if (schedule?.source === 'manual_adjusted') {
        warnings.push(publicationIssue('manual_adjusted', '课表包含手动调整，发布前建议复核锁定课节。'));
    }
    if (
        (schedule?.source === 'published_history_restored'
            || schedule?.solverStats?.phase === 'published_history_restore'
            || schedule?.solverStats?.restoredPublishedDraft)
        && schedule?.published?.status !== 'published'
    ) {
        warnings.push(publicationIssue('restored_published_draft', '当前草稿来自恢复发布版，重新发布前建议教务复核。', {
            targetName: '恢复发布版',
        }));
    }

    if (schedule?.published?.status === 'published' && !publishedHistoryEntry(schedule?.published)) {
        warnings.push(publicationIssue(
            'published_snapshot_backfill_needed',
            '\u5f53\u524d\u5df2\u53d1\u5e03\u7248\u672c\u7f3a\u5c11\u53d1\u5e03\u5feb\u7167\uff0c\u7cfb\u7edf\u4f1a\u5728\u5bfc\u51fa\u3001\u6062\u590d\u6216\u91cd\u65b0\u53d1\u5e03\u524d\u81ea\u52a8\u8865\u4fee\u3002',
            {
                targetName: '\u53d1\u5e03\u5feb\u7167',
            },
        ));
    }

    for (const item of publishedEntriesForReview(schedule?.published)) {
        const fingerprint = verifyPublishedSnapshotFingerprint(item.entry);
        if (!fingerprint.ok) {
            warnings.push(publicationIssue(fingerprint.reason, PUBLICATION_FINGERPRINT_MISMATCH_MESSAGE, {
                targetName: item.targetName,
                fingerprint: {
                    expected: fingerprint.expected || '',
                    actual: fingerprint.actual || '',
                },
            }));
        }
    }

    const summary = {
        totalLessons,
        placedLessons,
        unplacedLessons,
        hardConflicts,
        conflictCount: detectedConflicts.length,
        blockingCount: blockingIssues.length,
        warningCount: warnings.length,
        completeness: totalLessons ? Math.round((Math.min(placedLessons, totalLessons) / totalLessons) * 100) : 0,
    };
    const ok = blockingIssues.length === 0;
    const issueEntries = buildPublicationIssueEntries({
        project,
        maps,
        blockingIssues,
        warnings,
        detectedConflicts,
        unplaced,
        audit,
        qualityIssues,
    });
    const reviewItems = issueEntries;

    return {
        ok,
        reason: ok ? 'ready' : 'publication_blocked',
        message: ok ? '课表已通过发布前校验。' : '课表未通过发布前校验，暂不能发布。',
        blockingIssues,
        warnings,
        issueEntries,
        reviewItems,
        summary,
    };
}
