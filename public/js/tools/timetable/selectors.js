export function dayName(day) {
    return '一二三四五六日'[Number(day) - 1] || String(day);
}

function numberList(values, fallbackMax, min = 1, max = 12) {
    const raw = Array.isArray(values) ? values : [];
    const normalized = raw
        .map(value => Number(value))
        .filter(value => Number.isInteger(value) && value >= min && value <= max);
    const source = normalized.length
        ? normalized
        : Array.from({ length: Math.max(0, Number(fallbackMax) || 0) }, (_, index) => index + 1);
    return [...new Set(source)].sort((left, right) => left - right);
}

export function getActiveWeekdays(project = {}) {
    return numberList(project.activeWeekdays, project.weekdays || 5, 1, 7);
}

function isDefaultNonFormalLabel(label = '') {
    return /早自习|早读|早修|晨读|晚自习|晚修/.test(String(label || ''));
}

function timeBlockKind(segment = {}) {
    return ['teaching', 'duty', 'display'].includes(segment.kind)
        ? segment.kind
        : (isDefaultNonFormalLabel(segment.label) ? 'duty' : 'teaching');
}

function segmentPeriodCount(segment = {}) {
    return Math.max(0, Number.parseInt(segment.periodCount, 10) || 0);
}

export function getTotalPeriods(project = {}) {
    const segmentConfig = project?.periodTimeSegments;
    if (!segmentConfig || !Array.isArray(segmentConfig.segments)) return 0;
    return segmentConfig.segments.reduce((sum, seg) => sum + segmentPeriodCount(seg), 0);
}

export function getTeachingPeriodCount(project = {}) {
    const segmentConfig = project?.periodTimeSegments;
    if (!segmentConfig || !Array.isArray(segmentConfig.segments)) return 0;
    return segmentConfig.segments
        .filter(seg => timeBlockKind(seg) === 'teaching')
        .reduce((sum, seg) => sum + segmentPeriodCount(seg), 0);
}

export function getActivePeriods(project = {}) {
    // 从 periodTimeSegments 派生正式节次；只有 teaching 时段占第 N 节。
    const segmentConfig = project?.periodTimeSegments;

    // 兼容旧数据：如果没有 periodTimeSegments，fallback 到 activePeriods
    if (!segmentConfig || !segmentConfig.segments || segmentConfig.segments.length === 0) {
        return numberList(project.activePeriods, project.periodsPerDay || 7, 1, 12);
    }

    const total = getTeachingPeriodCount(project);
    const allPeriods = Array.from({ length: total }, (_, i) => i + 1);
    const disabledSet = new Set(project.disabledPeriods || []);
    return allPeriods.filter(p => !disabledSet.has(p));
}

export function entityMaps(project = {}) {
    return {
        teachers: new Map((project.teachers || []).map(item => [item.id, item])),
        classes: new Map((project.classes || []).map(item => [item.id, item])),
        subjects: new Map((project.subjects || []).map(item => [item.id, item])),
        plans: new Map((project.lessonPlans || []).map(item => [item.id, item])),
    };
}

export function getOwners(project, viewMode) {
    if (!project) return [];
    if (viewMode === 'teacher') return project.teachers || [];
    if (viewMode === 'master') return [{ id: 'master', name: '全校总表' }];
    return project.classes || [];
}

export function ownerLabel(owner = {}) {
    return owner.grade ? `${owner.grade}${owner.name}` : owner.name || owner.id || '';
}

export function ensureOwnerSelection(state) {
    if (!state.project) return '';
    if (state.viewMode === 'master') return 'master';
    const owners = getOwners(state.project, state.viewMode);
    if (owners.some(owner => owner.id === state.selectedOwnerId)) return state.selectedOwnerId;
    return owners[0]?.id || '';
}

export function getScore(project) {
    return project?.schedule?.score || {};
}

export function totalPlannedLessons(project) {
    return (project?.lessonPlans || []).reduce((sum, plan) => sum + Number(plan.weeklyHours || 0), 0);
}

export function getRosterStats(project = {}) {
    const lessonPlans = project.lessonPlans || [];
    const fixedRooms = new Set();
    for (const plan of lessonPlans) {
        if (plan.roomId) fixedRooms.add(plan.roomId);
        for (const roomId of plan.allowedRoomIds || []) {
            if (roomId) fixedRooms.add(roomId);
        }
    }
    const totalLessons = totalPlannedLessons(project);
    const blockLessons = lessonPlans.reduce((sum, plan) => {
        const hours = Number(plan.weeklyHours || 0);
        if (plan.blockPreference === 'double') return sum + hours;
        if (plan.blockPreference === 'mixed') return sum + Math.min(2, hours);
        return sum;
    }, 0);
    const knownClasses = new Set((project.classes || []).map(item => item.id));
    const knownSubjects = new Set((project.subjects || []).map(item => item.id));
    const knownTeachers = new Set((project.teachers || []).map(item => item.id));
    const issueCount = lessonPlans.filter(plan => {
        const teacherIds = Array.isArray(plan.teacherIds) && plan.teacherIds.length
            ? plan.teacherIds
            : [plan.teacherId].filter(Boolean);
        return !knownClasses.has(plan.classId)
            || !knownSubjects.has(plan.subjectId)
            || !teacherIds.length
            || teacherIds.some(teacherId => !knownTeachers.has(teacherId));
    }).length;
    return {
        classCount: (project.classes || []).length,
        teacherCount: (project.teachers || []).length,
        subjectCount: (project.subjects || []).length,
        planCount: lessonPlans.length,
        totalLessons,
        blockLessons,
        fixedRoomCount: fixedRooms.size,
        issueCount,
    };
}

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function encodeRulePart(value = '') {
    return encodeURIComponent(String(value ?? ''));
}

function decodeRulePart(value = '') {
    return decodeURIComponent(String(value ?? ''));
}

function ruleId(type, ...parts) {
    return [type, ...parts.map(encodeRulePart)].join('|');
}

function ruleTargetName(project, kind, id) {
    const maps = entityMaps(project);
    if (kind === 'teacher') return maps.teachers.get(id)?.name || id;
    if (kind === 'class') return ownerLabel(maps.classes.get(id) || { id });
    if (kind === 'subject') return maps.subjects.get(id)?.name || id;
    return id || '';
}

function pushSlotRules(items, project, { type, source, targetKind, slotMap = {}, priority = 'hard', description = '' }) {
    for (const [targetId, slots] of Object.entries(slotMap || {})) {
        for (const slot of slots || []) {
            items.push({
                id: ruleId(type, targetId, slot),
                type,
                label: type,
                targetName: ruleTargetName(project, targetKind, targetId),
                targetId,
                slots: [slot],
                priority,
                description,
                source,
            });
        }
    }
}

export function getSavedRuleItems(project = {}) {
    project = project || {};
    const rules = project.rules || {};
    const hard = rules.hardRules || {};
    const soft = rules.softRules || {};
    const items = [];

    pushSlotRules(items, project, {
        type: 'teacher_unavailable',
        source: 'hardRules.teacherUnavailable',
        targetKind: 'teacher',
        slotMap: hard.teacherUnavailable,
        priority: 'hard',
        description: '教师不可排',
    });
    pushSlotRules(items, project, {
        type: 'class_unavailable',
        source: 'hardRules.classUnavailable',
        targetKind: 'class',
        slotMap: hard.classUnavailable,
        priority: 'hard',
        description: '班级不可排',
    });

    (hard.lockedSlots || []).forEach((slot, index) => {
        const className = ruleTargetName(project, 'class', slot.classId);
        const subjectName = ruleTargetName(project, 'subject', slot.subjectId);
        const teacherName = ruleTargetName(project, 'teacher', slot.teacherId);
        items.push({
            id: ruleId('locked_slot', index),
            type: 'locked_slot',
            label: 'locked_slot',
            targetName: [className, subjectName, teacherName].filter(Boolean).join(' / '),
            targetId: slot.id || `${slot.classId}:${slot.subjectId}:${slot.teacherId}`,
            slots: [`${slot.day}-${slot.period}`],
            priority: 'hard',
            description: '锁定课节',
            source: 'hardRules.lockedSlots',
        });
    });

    for (const subjectId of soft.morningSubjects || []) {
        items.push({
            id: ruleId('subject_morning', subjectId),
            type: 'subject_morning',
            label: 'subject_morning',
            targetName: ruleTargetName(project, 'subject', subjectId),
            targetId: subjectId,
            slots: [],
            priority: 'soft',
            description: '课程上午优先',
            source: 'softRules.morningSubjects',
        });
    }

    for (const [subjectId, preference] of Object.entries(soft.subjectPreferredPeriods || {})) {
        for (const slot of preference.prefer || []) {
            items.push({
                id: ruleId('subject_preferred_periods', subjectId, 'prefer', slot),
                type: 'subject_preferred_periods',
                label: 'subject_preferred_periods',
                targetName: ruleTargetName(project, 'subject', subjectId),
                targetId: subjectId,
                slots: [slot],
                priority: 'soft',
                description: '课程偏好节次',
                source: 'softRules.subjectPreferredPeriods.prefer',
            });
        }
        for (const slot of preference.avoid || []) {
            items.push({
                id: ruleId('subject_avoid_periods', subjectId, 'avoid', slot),
                type: 'subject_avoid_periods',
                label: 'subject_avoid_periods',
                targetName: ruleTargetName(project, 'subject', subjectId),
                targetId: subjectId,
                slots: [slot],
                priority: 'soft',
                description: '课程避开节次',
                source: 'softRules.subjectPreferredPeriods.avoid',
            });
        }
    }

    for (const [teacherId, limits] of Object.entries(soft.teacherLimits || {})) {
        if (Number.isInteger(Number(limits.daily))) {
            items.push({
                id: ruleId('teacher_daily_limit', teacherId),
                type: 'teacher_daily_limit',
                label: 'teacher_daily_limit',
                targetName: ruleTargetName(project, 'teacher', teacherId),
                targetId: teacherId,
                slots: [],
                priority: 'soft',
                description: `每天最多 ${limits.daily} 节`,
                source: 'softRules.teacherLimits.daily',
            });
        }
        if (Number.isInteger(Number(limits.consecutive))) {
            items.push({
                id: ruleId('teacher_consecutive_limit', teacherId),
                type: 'teacher_consecutive_limit',
                label: 'teacher_consecutive_limit',
                targetName: ruleTargetName(project, 'teacher', teacherId),
                targetId: teacherId,
                slots: [],
                priority: 'soft',
                description: `连续最多 ${limits.consecutive} 节`,
                source: 'softRules.teacherLimits.consecutive',
            });
        }
    }

    for (const subjectId of soft.spreadSubjects || []) {
        items.push({
            id: ruleId('subject_spread', subjectId),
            type: 'subject_spread',
            label: 'subject_spread',
            targetName: ruleTargetName(project, 'subject', subjectId),
            targetId: subjectId,
            slots: [],
            priority: 'soft',
            description: '同科分散',
            source: 'softRules.spreadSubjects',
        });
    }

    return items;
}

function removeFromSlotMap(map = {}, targetId, slot) {
    const next = { ...(map || {}) };
    next[targetId] = (next[targetId] || []).filter(item => item !== slot);
    if (!next[targetId].length) delete next[targetId];
    return next;
}

function removeFromSubjectPreference(subjectPreferredPeriods = {}, subjectId, bucket, slot) {
    const next = cloneValue(subjectPreferredPeriods || {});
    const current = next[subjectId] || { prefer: [], avoid: [], weight: 20 };
    current[bucket] = (current[bucket] || []).filter(item => item !== slot);
    current.prefer = current.prefer || [];
    current.avoid = current.avoid || [];
    if (!current.prefer.length && !current.avoid.length) {
        delete next[subjectId];
    } else {
        next[subjectId] = current;
    }
    return next;
}

export function removeSavedRuleById(project = {}, id = '') {
    const rules = cloneValue(project.rules || { hardRules: {}, softRules: {} });
    rules.hardRules = rules.hardRules || {};
    rules.softRules = rules.softRules || {};
    const [type, ...encodedParts] = String(id).split('|');
    const parts = encodedParts.map(decodeRulePart);

    if (type === 'teacher_unavailable') {
        rules.hardRules.teacherUnavailable = removeFromSlotMap(rules.hardRules.teacherUnavailable, parts[0], parts[1]);
    } else if (type === 'class_unavailable') {
        rules.hardRules.classUnavailable = removeFromSlotMap(rules.hardRules.classUnavailable, parts[0], parts[1]);
    } else if (type === 'locked_slot') {
        const index = Number.parseInt(parts[0], 10);
        rules.hardRules.lockedSlots = (rules.hardRules.lockedSlots || []).filter((_, itemIndex) => itemIndex !== index);
    } else if (type === 'subject_morning') {
        rules.softRules.morningSubjects = (rules.softRules.morningSubjects || []).filter(item => item !== parts[0]);
    } else if (type === 'subject_preferred_periods') {
        rules.softRules.subjectPreferredPeriods = removeFromSubjectPreference(rules.softRules.subjectPreferredPeriods, parts[0], 'prefer', parts[2]);
    } else if (type === 'subject_avoid_periods') {
        rules.softRules.subjectPreferredPeriods = removeFromSubjectPreference(rules.softRules.subjectPreferredPeriods, parts[0], 'avoid', parts[2]);
    } else if (type === 'teacher_daily_limit') {
        const current = { ...(rules.softRules.teacherLimits?.[parts[0]] || {}) };
        delete current.daily;
        rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
        if (Object.keys(current).length) rules.softRules.teacherLimits[parts[0]] = current;
        else delete rules.softRules.teacherLimits[parts[0]];
    } else if (type === 'teacher_consecutive_limit') {
        const current = { ...(rules.softRules.teacherLimits?.[parts[0]] || {}) };
        delete current.consecutive;
        rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
        if (Object.keys(current).length) rules.softRules.teacherLimits[parts[0]] = current;
        else delete rules.softRules.teacherLimits[parts[0]];
    } else if (type === 'subject_spread') {
        rules.softRules.spreadSubjects = (rules.softRules.spreadSubjects || []).filter(item => item !== parts[0]);
    }

    return rules;
}

export function getRuleSummary(project = {}) {
    const items = getSavedRuleItems(project);
    const count = type => items.filter(item => item.type === type).length;
    const teacherUnavailable = count('teacher_unavailable');
    const classUnavailable = count('class_unavailable');
    const lockedSlots = count('locked_slot');
    const morningSubjects = count('subject_morning');
    const subjectPreferredPeriods = count('subject_preferred_periods');
    const subjectAvoidPeriods = count('subject_avoid_periods');
    const teacherDailyLimits = count('teacher_daily_limit');
    const teacherConsecutiveLimits = count('teacher_consecutive_limit');
    const spreadSubjects = count('subject_spread');
    return {
        teacherUnavailable,
        classUnavailable,
        lockedSlots,
        morningSubjects,
        subjectPreferredPeriods,
        subjectAvoidPeriods,
        teacherDailyLimits,
        teacherConsecutiveLimits,
        spreadSubjects,
        total: items.length,
    };
}

function normalizedTeacherKey(slot = {}) {
    const ids = Array.isArray(slot.teacherIds) && slot.teacherIds.length
        ? slot.teacherIds
        : [slot.teacherId].filter(Boolean);
    return [...new Set(ids.map(item => String(item || '').trim()).filter(Boolean))].sort().join(',');
}

function slotSemanticKey(slot = {}) {
    return [
        slot.lessonPlanId || '',
        slot.classId || '',
        slot.subjectId || '',
        normalizedTeacherKey(slot),
        slot.blockId || '',
        Number(slot.blockIndex || 0),
        Number(slot.blockSize || 1),
    ].map(value => String(value ?? '')).join('|');
}

function popMatchingSlot(queueMap, key, usedIds) {
    const queue = queueMap.get(key) || [];
    while (queue.length) {
        const candidate = queue.shift();
        if (!usedIds.has(candidate.__diffId)) return candidate;
    }
    return null;
}

function diffSlotContent(before = {}, after = {}) {
    const contentChanged = before.lessonPlanId !== after.lessonPlanId
        || before.classId !== after.classId
        || before.subjectId !== after.subjectId
        || normalizedTeacherKey(before) !== normalizedTeacherKey(after)
        || Number(before.blockIndex || 0) !== Number(after.blockIndex || 0)
        || Number(before.blockSize || 1) !== Number(after.blockSize || 1);
    const roomChanged = (before.roomId || '') !== (after.roomId || '');
    const moved = Number(before.day) !== Number(after.day)
        || Number(before.period) !== Number(after.period);
    return { moved, roomChanged, contentChanged };
}

export function getPublishedScheduleDiff(project = {}) {
    const currentSlots = (project.schedule?.slots || []).map((slot, index) => ({
        ...slot,
        __diffId: `current:${slot.id || index}`,
    }));
    const snapshotSlots = (project.schedule?.published?.snapshot?.slots || []).map((slot, index) => ({
        ...slot,
        __diffId: `snapshot:${slot.id || index}`,
    }));
    if (!snapshotSlots.length) {
        return {
            hasSnapshot: false,
            total: 0,
            moved: 0,
            changed: 0,
            added: 0,
            removed: 0,
            items: [],
        };
    }

    const currentById = new Map(currentSlots.filter(slot => slot.id).map(slot => [slot.id, slot]));
    const exactMatchCount = snapshotSlots
        .filter(slot => slot.id && currentById.has(slot.id))
        .length;
    const allowSemanticFallback = exactMatchCount === 0;
    const currentBySemantic = new Map();
    currentSlots.forEach(slot => {
        const key = slotSemanticKey(slot);
        if (!currentBySemantic.has(key)) currentBySemantic.set(key, []);
        currentBySemantic.get(key).push(slot);
    });

    const usedCurrentIds = new Set();
    const items = [];
    snapshotSlots.forEach(before => {
        let after = before.id ? currentById.get(before.id) : null;
        if (after && usedCurrentIds.has(after.__diffId)) after = null;
        if (!after && allowSemanticFallback) after = popMatchingSlot(currentBySemantic, slotSemanticKey(before), usedCurrentIds);
        if (!after) {
            items.push({ type: 'removed', beforeSlot: before, afterSlot: null });
            return;
        }
        usedCurrentIds.add(after.__diffId);
        const changes = diffSlotContent(before, after);
        if (changes.moved || changes.roomChanged || changes.contentChanged) {
            items.push({
                type: changes.moved ? 'moved' : 'changed',
                beforeSlot: before,
                afterSlot: after,
                changes,
            });
        }
    });

    currentSlots.forEach(after => {
        if (!usedCurrentIds.has(after.__diffId)) {
            items.push({ type: 'added', beforeSlot: null, afterSlot: after });
        }
    });

    return {
        hasSnapshot: true,
        total: items.length,
        moved: items.filter(item => item.type === 'moved').length,
        changed: items.filter(item => item.type === 'changed').length,
        added: items.filter(item => item.type === 'added').length,
        removed: items.filter(item => item.type === 'removed').length,
        items,
    };
}

export function isPublishedDraftChanged(project = {}) {
    const published = project.schedule?.published || null;
    if (!published) return false;
    if (published.status === 'draft_changed') return true;
    if (published.status !== 'published') return false;
    const diff = getPublishedScheduleDiff(project);
    return Boolean(diff.hasSnapshot && diff.total > 0);
}

export function getPreparedness(project) {
    if (!project) return { ready: false, message: '正在读取排课项目。' };
    if (!(project.lessonPlans || []).length) return { ready: false, message: '请先导入任课数据。' };
    if (!(project.teachers || []).length) return { ready: false, message: '任课数据里没有教师。' };
    if (!(project.classes || []).length) return { ready: false, message: '任课数据里没有班级。' };
    if (!(project.subjects || []).length) return { ready: false, message: '任课数据里没有课程。' };
    return { ready: true, message: '数据已就绪。' };
}

function slotTeachers(slot = {}) {
    const ids = Array.isArray(slot.teacherIds) ? [...slot.teacherIds] : [];
    if (slot.teacherId && !ids.includes(slot.teacherId)) ids.unshift(slot.teacherId);
    return ids;
}

export function getVisibleSlots(project, viewMode, ownerId) {
    const slots = project?.schedule?.slots || [];
    if (viewMode === 'teacher') {
        return slots.filter(slot => slotTeachers(slot).includes(ownerId));
    }
    if (viewMode === 'master') return slots;
    return slots.filter(slot => slot.classId === ownerId);
}

export function getSlotsAt(project, viewMode, ownerId, day, period) {
    return getVisibleSlots(project, viewMode, ownerId)
        .filter(slot => slot.day === day && slot.period === period);
}

export function getSlotById(project, slotId) {
    return (project?.schedule?.slots || []).find(slot => slot.id === slotId) || null;
}

export function getSlotBlock(project, slotId) {
    const slot = getSlotById(project, slotId);
    if (!slot) return [];
    if (!slot.blockId || slot.blockSize <= 1) return [slot];
    return (project.schedule?.slots || [])
        .filter(item => item.blockId === slot.blockId)
        .sort((left, right) => (left.blockIndex || 0) - (right.blockIndex || 0));
}

export function getConflictSummary(schedule = {}) {
    const conflicts = Array.isArray(schedule.conflicts) ? schedule.conflicts : [];
    const counts = {};
    for (const conflict of conflicts) {
        const type = conflict.type || 'other';
        counts[type] = (counts[type] || 0) + 1;
    }
    return {
        total: conflicts.length,
        hardCount: conflicts.filter(conflict => conflict.severity === 'hard' || !conflict.severity).length,
        counts,
        items: Object.entries(counts).map(([type, count]) => ({ type, count, label: conflictLabel(type) })),
    };
}

export function conflictLabel(type) {
    return ({
        'teacher-conflict': '教师冲突',
        'class-conflict': '班级冲突',
        'room-conflict': '教室冲突',
        'availability-conflict': '不可排时间',
        'locked-conflict': '锁定冲突',
        unplaced: '未排课时',
    })[type] || '其他冲突';
}

export function slotHasConflict(project, slot) {
    return (project?.schedule?.conflicts || []).some(conflict => (
        conflict.slot?.id === slot.id
        || (conflict.classId === slot.classId && conflict.teacherId === slot.teacherId && conflict.day === slot.day && conflict.period === slot.period)
    ));
}

export function getSlotDetails(project, slotId) {
    const slot = getSlotById(project, slotId);
    if (!slot) return null;
    const maps = entityMaps(project);
    const klass = maps.classes.get(slot.classId);
    const subject = maps.subjects.get(slot.subjectId);
    const teacherNames = slotTeachers(slot)
        .map(teacherId => maps.teachers.get(teacherId)?.name || teacherId)
        .join('、');
    const blockSlots = getSlotBlock(project, slot.id);
    return {
        slot,
        subject,
        klass,
        teacherNames,
        plan: maps.plans.get(slot.lessonPlanId),
        blockSlots,
        timeLabel: `周${dayName(slot.day)} 第${slot.period}节`,
        classLabel: klass ? `${klass.grade}${klass.name}` : slot.classId,
        blockLabel: slot.blockId ? `连堂 ${Number(slot.blockIndex || 0) + 1}/${slot.blockSize}` : '单节',
        hasConflict: slotHasConflict(project, slot),
    };
}

export function getSolveStatus(project, lastFailure = null) {
    const score = getScore(project);
    const summary = getConflictSummary(project?.schedule || {});
    const source = project?.schedule?.source;
    const publicationDraftChanged = isPublishedDraftChanged(project);
    const publishedStatus = project?.schedule?.published?.status;
    const restoredPublishedDraft = publishedStatus !== 'published' && (
        source === 'published_history_restored'
        || project?.schedule?.solverStats?.phase === 'published_history_restore'
        || Boolean(project?.schedule?.solverStats?.restoredPublishedDraft)
    );
    return {
        source,
        sourceLabel: restoredPublishedDraft
            ? '恢复发布版'
            : publicationDraftChanged
            ? '草稿已变化'
            : source === 'timefold_solver'
            ? 'Timefold'
            : source === 'fast_constructed'
                ? '快速课表'
                : source === 'manual_adjusted'
                    ? '\u624b\u52a8\u8c03\u6574'
                    : source === 'published' || source === 'published_snapshot' || source === 'published_history_snapshot'
                        ? '已发布'
                    : source === 'published_history_restored'
                        ? '恢复发布版'
                    : source === 'diagnostic_local'
                    ? '本地诊断'
                    : '未生成',
        placed: score.placedLessons ?? 0,
        total: score.totalLessons ?? totalPlannedLessons(project),
        completeness: score.completeness == null ? '-' : `${score.completeness}%`,
        unplaced: score.unplacedLessons ?? 0,
        conflicts: summary.total,
        hardConflicts: score.hardConflicts ?? summary.hardCount,
        oldScheduleKept: Boolean(lastFailure),
    };
}
