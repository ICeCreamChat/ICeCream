import {
    addUsage,
    canUseSlot,
    createTimetableUsage,
    detectScheduleConflicts,
} from './timetable-conflicts.js';
import {
    cleanText,
    normalizeSchedule,
    normalizeTimetableProject,
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
    const usage = createTimetableUsage();
    for (const slot of slots) {
        if (!excludedIds.has(slot.id)) addUsage(usage, slot);
    }
    return usage;
}

function refreshSchedule(project, schedule) {
    const unplaced = schedule.unplaced || [];
    const conflicts = [
        ...buildUnplacedConflicts(unplaced),
        ...detectScheduleConflicts(project, schedule.slots),
    ];
    schedule.conflicts = conflicts;
    schedule.lockedSlots = schedule.slots.filter(slot => slot.locked);
    schedule.audit = auditTimetableProject(project);
    schedule.qualityIssues = buildTimetableQualityIssues(project, schedule.slots);
    schedule.score = buildTimetableScore(project, schedule.slots, unplaced, conflicts);
    schedule.publication = validateTimetablePublication({ ...project, schedule });
    if (schedule.published?.status === 'published') {
        schedule.published = {
            ...schedule.published,
            status: 'draft_changed',
        };
    }
    return schedule;
}

function buildManualAdjustmentSolverStats(schedule) {
    const conflicts = Array.isArray(schedule.conflicts) ? schedule.conflicts : [];
    const unplaced = Array.isArray(schedule.unplaced) ? schedule.unplaced : [];
    const hasHardConflicts = conflicts.some(conflict => conflict?.severity === 'hard');
    const restoredPublishedDraft = schedule?.source === 'published_history_restored'
        || schedule?.solverStats?.phase === 'published_history_restore'
        || Boolean(schedule?.solverStats?.restoredPublishedDraft);
    return {
        solverUsed: false,
        phase: 'manual_adjustment',
        status: hasHardConflicts || unplaced.length ? 'needs_review' : 'accepted',
        accepted: !(hasHardConflicts || unplaced.length),
        reason: hasHardConflicts
            ? 'manual_adjustment_conflicts'
            : unplaced.length
                ? 'manual_adjustment_unplaced'
                : null,
        lessonCount: Number(schedule.score?.totalLessons || 0),
        ...(restoredPublishedDraft ? {
            restoredPublishedDraft: true,
            restoredVersion: schedule?.solverStats?.restoredVersion ?? null,
            restoredScheduleId: schedule?.solverStats?.restoredScheduleId ?? null,
        } : {}),
    };
}

export function applyScheduleAdjustment(input = {}, adjustment = {}) {
    const project = normalizeTimetableProject(input);
    const schedule = normalizeSchedule(project.schedule) || { slots: [], conflicts: [], unplaced: [], score: {} };
    const slotId = cleanText(adjustment.slotId, 120);
    const index = schedule.slots.findIndex(slot => slot.id === slotId);
    if (index < 0) throw new Error('没有找到要调整的课节');

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
                ? { ...slot, locked: adjustment.locked !== false, manuallyAdjusted: true }
                : slot
        ));
    } else if (adjustment.type === 'move') {
        if (blockSlots.some(slot => slot.locked)) throw new Error('锁定课节不能移动');
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
                manuallyAdjusted: true,
            };
            const check = canUseSlot(project, usage, next);
            if (!check.ok) throw new Error(check.reason);
            addUsage(usage, next);
            nextSlots.set(slot.id, next);
        });
        schedule.slots = schedule.slots.map(slot => nextSlots.get(slot.id) || slot);
    } else {
        throw new Error('未知的课表调整类型');
    }

    schedule.source = 'manual_adjusted';
    refreshSchedule(project, schedule);
    schedule.solverStats = buildManualAdjustmentSolverStats(schedule);

    return {
        success: schedule.conflicts.length === 0 && schedule.unplaced.length === 0,
        project: { ...project, schedule },
        schedule,
    };
}
