import {
    getActiveWeekdays,
    getDayPartPeriods,
    getTimetableEntityMaps,
    normalizeTimetableProject,
    slotKey,
    slotTeacherIds,
} from './timetable-project.js';

const STATUS_LABELS = {
    satisfied: '已满足',
    partial: '部分满足',
    unmet: '未满足',
    not_applicable: '未参与',
};

function cleanRuleId(...parts) {
    return parts
        .map(part => String(part ?? '').trim())
        .filter(Boolean)
        .join(':');
}

function className(project, classId) {
    const klass = project.classes.find(item => item.id === classId);
    if (!klass) return classId || '';
    return `${klass.grade || ''}${klass.name || klass.id}`;
}

function entityName(project, kind, id) {
    if (!id) return '';
    if (kind === 'class') return className(project, id);
    const maps = getTimetableEntityMaps(project);
    const pool = kind === 'teacher'
        ? maps.teachers
        : kind === 'subject'
            ? maps.subjects
            : maps.plans;
    return pool.get(id)?.name || id;
}

function slotLabel(slot = {}) {
    return `周${Number(slot.day)}第${Number(slot.period)}节`;
}

function locateFromSlot(project, slot = {}, targetKind = 'class', targetId = '') {
    const kind = targetKind || (slot.teacherId ? 'teacher' : 'class');
    const id = targetId || (kind === 'teacher' ? slot.teacherId : slot.classId);
    return {
        targetKind: kind,
        targetId: id || '',
        targetName: entityName(project, kind, id) || '',
        day: Number(slot.day) || null,
        period: Number(slot.period) || null,
        slotId: slot.id || '',
        slot,
    };
}

function locateExpectedCell(project, rule = {}) {
    const raw = rule.raw || {};
    return {
        targetKind: rule.targetKind || 'class',
        targetId: rule.targetId || raw.classId || '',
        targetName: rule.targetName || entityName(project, rule.targetKind || 'class', rule.targetId || raw.classId),
        day: Number(raw.day) || Number(rule.slots?.[0]?.split?.('-')?.[0]) || null,
        period: Number(raw.period) || Number(rule.slots?.[0]?.split?.('-')?.[1]) || null,
        slotId: '',
        slot: raw.day && raw.period ? { day: Number(raw.day), period: Number(raw.period) } : null,
    };
}

function makeResult(rule, status, evidence, locateTargets = []) {
    return {
        id: rule.id,
        type: rule.type,
        source: rule.source,
        priority: rule.priority,
        targetKind: rule.targetKind,
        targetId: rule.targetId,
        targetName: rule.targetName,
        slots: rule.slots || [],
        title: rule.title || `${rule.targetName || ''}${rule.description ? ` ${rule.description}` : ''}`.trim(),
        description: rule.description,
        status,
        statusLabel: STATUS_LABELS[status] || status,
        evidence,
        locateTargets: locateTargets.filter(Boolean),
    };
}

function pushSlotRules(items, project, { type, source, targetKind, slotMap = {}, priority, description }) {
    Object.entries(slotMap || {}).forEach(([targetId, slots]) => {
        (Array.isArray(slots) ? slots : []).forEach(slot => {
            const normalizedSlot = typeof slot === 'string' ? slot : slotKey(slot?.day, slot?.period);
            items.push({
                id: cleanRuleId(type, targetId, normalizedSlot),
                type,
                source,
                targetKind,
                targetId,
                targetName: entityName(project, targetKind, targetId),
                slots: [normalizedSlot],
                priority,
                description,
                title: `${entityName(project, targetKind, targetId)} ${description} ${normalizedSlot}`,
            });
        });
    });
}

function savedConstraintItems(project) {
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
        const targetName = [
            entityName(project, 'class', slot.classId),
            entityName(project, 'subject', slot.subjectId),
            entityName(project, 'teacher', slot.teacherId),
        ].filter(Boolean).join(' / ');
        items.push({
            id: cleanRuleId('locked_slot', index),
            type: 'locked_slot',
            source: 'hardRules.lockedSlots',
            targetKind: 'class',
            targetId: slot.classId || '',
            targetName,
            slots: [slotKey(slot.day, slot.period)],
            priority: 'hard',
            description: '锁定课节',
            title: `${targetName} 锁定在 ${slotLabel(slot)}`,
            raw: slot,
        });
    });

    for (const subjectId of soft.morningSubjects || []) {
        items.push({
            id: cleanRuleId('subject_morning', subjectId),
            type: 'subject_morning',
            source: 'softRules.morningSubjects',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            slots: [],
            priority: 'soft',
            description: '课程上午优先',
            title: `${entityName(project, 'subject', subjectId)} 上午优先`,
        });
    }

    for (const [subjectId, preference] of Object.entries(soft.subjectPreferredPeriods || {})) {
        for (const slot of preference.prefer || []) {
            items.push({
                id: cleanRuleId('subject_preferred_periods', subjectId, 'prefer', slot),
                type: 'subject_preferred_periods',
                source: 'softRules.subjectPreferredPeriods.prefer',
                targetKind: 'subject',
                targetId: subjectId,
                targetName: entityName(project, 'subject', subjectId),
                slots: [slot],
                priority: 'soft',
                description: '课程偏好节次',
                title: `${entityName(project, 'subject', subjectId)} 偏好 ${slot}`,
            });
        }
        for (const slot of preference.avoid || []) {
            items.push({
                id: cleanRuleId('subject_avoid_periods', subjectId, 'avoid', slot),
                type: 'subject_avoid_periods',
                source: 'softRules.subjectPreferredPeriods.avoid',
                targetKind: 'subject',
                targetId: subjectId,
                targetName: entityName(project, 'subject', subjectId),
                slots: [slot],
                priority: 'soft',
                description: '课程避开节次',
                title: `${entityName(project, 'subject', subjectId)} 避开 ${slot}`,
            });
        }
    }

    for (const [teacherId, limits] of Object.entries(soft.teacherLimits || {})) {
        if (Number.isInteger(Number(limits.daily))) {
            items.push({
                id: cleanRuleId('teacher_daily_limit', teacherId),
                type: 'teacher_daily_limit',
                source: 'softRules.teacherLimits.daily',
                targetKind: 'teacher',
                targetId: teacherId,
                targetName: entityName(project, 'teacher', teacherId),
                slots: [],
                priority: 'soft',
                limit: Number(limits.daily),
                description: `每天最多 ${Number(limits.daily)} 节`,
                title: `${entityName(project, 'teacher', teacherId)} 每天最多 ${Number(limits.daily)} 节`,
            });
        }
        if (Number.isInteger(Number(limits.consecutive))) {
            items.push({
                id: cleanRuleId('teacher_consecutive_limit', teacherId),
                type: 'teacher_consecutive_limit',
                source: 'softRules.teacherLimits.consecutive',
                targetKind: 'teacher',
                targetId: teacherId,
                targetName: entityName(project, 'teacher', teacherId),
                slots: [],
                priority: 'soft',
                limit: Number(limits.consecutive),
                description: `连续最多 ${Number(limits.consecutive)} 节`,
                title: `${entityName(project, 'teacher', teacherId)} 连续最多 ${Number(limits.consecutive)} 节`,
            });
        }
    }

    for (const subjectId of soft.spreadSubjects || []) {
        items.push({
            id: cleanRuleId('subject_spread', subjectId),
            type: 'subject_spread',
            source: 'softRules.spreadSubjects',
            targetKind: 'subject',
            targetId: subjectId,
            targetName: entityName(project, 'subject', subjectId),
            slots: [],
            priority: 'soft',
            description: '同科分散',
            title: `${entityName(project, 'subject', subjectId)} 分散排布`,
        });
    }

    return items;
}

function slotsForTeacher(slots, teacherId) {
    return slots.filter(slot => slotTeacherIds(slot).includes(teacherId));
}

function slotsByDay(slots = []) {
    const result = new Map();
    for (const slot of slots) {
        const day = Number(slot.day);
        if (!result.has(day)) result.set(day, []);
        result.get(day).push(slot);
    }
    return result;
}

function evaluateTeacherUnavailable(project, rule, slots) {
    const blocked = new Set(rule.slots || []);
    const violations = slotsForTeacher(slots, rule.targetId)
        .filter(slot => blocked.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入教师禁排时段。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入教师禁排时段。`,
        violations.map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateClassUnavailable(project, rule, slots) {
    const blocked = new Set(rule.slots || []);
    const violations = slots
        .filter(slot => slot.classId === rule.targetId && blocked.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入班级禁排时段。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入班级禁排时段。`,
        violations.map(slot => locateFromSlot(project, slot, 'class', rule.targetId)),
    );
}

function evaluateLockedSlot(project, rule, slots) {
    const expected = rule.raw || {};
    const expectedKey = slotKey(expected.day, expected.period);
    const match = slots.find(slot => (
        slotKey(slot.day, slot.period) === expectedKey
        && slot.classId === expected.classId
        && slot.subjectId === expected.subjectId
        && (!expected.teacherId || slotTeacherIds(slot).includes(expected.teacherId))
        && (!expected.lessonPlanId || slot.lessonPlanId === expected.lessonPlanId)
    ));
    if (match) {
        return makeResult(rule, 'satisfied', `锁定课节仍在 ${slotLabel(expected)}。`, [
            locateFromSlot(project, match, 'class', expected.classId),
        ]);
    }
    const related = slots.filter(slot => (
        slot.classId === expected.classId
        && slot.subjectId === expected.subjectId
        && (!expected.teacherId || slotTeacherIds(slot).includes(expected.teacherId))
    ));
    return makeResult(
        rule,
        'unmet',
        `锁定课节未保持在 ${slotLabel(expected)}。`,
        related.length
            ? related.map(slot => locateFromSlot(project, slot, 'class', expected.classId))
            : [locateExpectedCell(project, rule)],
    );
}

function evaluateSubjectMorning(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const morning = new Set(getDayPartPeriods(project, 'morning'));
    const matched = subjectSlots.filter(slot => morning.has(Number(slot.period)));
    const evidence = `${matched.length}/${subjectSlots.length} 节在上午。`;
    if (matched.length === subjectSlots.length) return makeResult(rule, 'satisfied', evidence);
    if (matched.length > 0) {
        return makeResult(
            rule,
            'partial',
            evidence,
            subjectSlots.filter(slot => !morning.has(Number(slot.period))).map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
        );
    }
    return makeResult(
        rule,
        'unmet',
        evidence,
        subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
    );
}

function evaluateSubjectPreferred(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const preferred = new Set(rule.slots || []);
    const matched = subjectSlots.filter(slot => preferred.has(slotKey(slot.day, slot.period)));
    const evidence = `${matched.length}/${subjectSlots.length} 节命中偏好节次。`;
    if (matched.length === subjectSlots.length) return makeResult(rule, 'satisfied', evidence, matched.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
    if (matched.length > 0) return makeResult(rule, 'partial', evidence, matched.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
    return makeResult(rule, 'unmet', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateSubjectAvoid(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    const avoided = new Set(rule.slots || []);
    const violations = subjectSlots.filter(slot => avoided.has(slotKey(slot.day, slot.period)));
    if (!violations.length) return makeResult(rule, 'satisfied', '没有课程排入避开节次。');
    return makeResult(
        rule,
        'unmet',
        `${violations.length} 节排入避开节次。`,
        violations.map(slot => locateFromSlot(project, slot, 'class', slot.classId)),
    );
}

function evaluateTeacherDaily(project, rule, slots) {
    const teacherSlots = slotsForTeacher(slots, rule.targetId);
    if (!teacherSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该教师课节。');
    const limit = Number(rule.limit);
    const overSlots = [];
    const overDays = [];
    for (const [day, daySlots] of slotsByDay(teacherSlots)) {
        if (daySlots.length > limit) {
            overDays.push(`周${day} ${daySlots.length}节`);
            overSlots.push(...daySlots);
        }
    }
    if (!overSlots.length) return makeResult(rule, 'satisfied', `每天均未超过 ${limit} 节。`);
    return makeResult(
        rule,
        'unmet',
        `${overDays.join('、')}，超过每天最多 ${limit} 节。`,
        overSlots.map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateTeacherConsecutive(project, rule, slots) {
    const teacherSlots = slotsForTeacher(slots, rule.targetId);
    if (!teacherSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该教师课节。');
    const limit = Number(rule.limit);
    const violatingSlots = [];
    const runs = [];
    for (const [day, daySlots] of slotsByDay(teacherSlots)) {
        const sorted = [...daySlots].sort((left, right) => Number(left.period) - Number(right.period));
        let current = [];
        for (const slot of sorted) {
            const previous = current.at(-1);
            if (previous && Number(slot.period) === Number(previous.period) + 1) current.push(slot);
            else {
                if (current.length > limit) {
                    runs.push(`周${day} 连续${current.length}节`);
                    violatingSlots.push(...current);
                }
                current = [slot];
            }
        }
        if (current.length > limit) {
            runs.push(`周${day} 连续${current.length}节`);
            violatingSlots.push(...current);
        }
    }
    if (!violatingSlots.length) return makeResult(rule, 'satisfied', `连续课均未超过 ${limit} 节。`);
    return makeResult(
        rule,
        'unmet',
        `${runs.join('、')}，超过连续最多 ${limit} 节。`,
        violatingSlots.map(slot => locateFromSlot(project, slot, 'teacher', rule.targetId)),
    );
}

function evaluateSubjectSpread(project, rule, slots) {
    const subjectSlots = slots.filter(slot => slot.subjectId === rule.targetId);
    if (!subjectSlots.length) return makeResult(rule, 'not_applicable', '当前课表没有该课程课节。');
    if (subjectSlots.length <= 1) return makeResult(rule, 'satisfied', '该课程只有 1 节课，不需要分散。');
    const grouped = slotsByDay(subjectSlots);
    const activeDayCount = Math.max(1, getActiveWeekdays(project).length);
    const distinctDays = grouped.size;
    const maxPerDay = Math.max(...Array.from(grouped.values()).map(daySlots => daySlots.length));
    const evidence = `${subjectSlots.length} 节分布在 ${distinctDays}/${Math.min(subjectSlots.length, activeDayCount)} 天，单日最多 ${maxPerDay} 节。`;
    if (maxPerDay <= 1) return makeResult(rule, 'satisfied', evidence);
    if (distinctDays > 1) return makeResult(rule, 'partial', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
    return makeResult(rule, 'unmet', evidence, subjectSlots.map(slot => locateFromSlot(project, slot, 'class', slot.classId)));
}

function evaluateRule(project, rule, slots, evaluated) {
    if (!evaluated) return makeResult(rule, 'not_applicable', '当前还没有生成课表。');
    switch (rule.type) {
        case 'teacher_unavailable':
            return evaluateTeacherUnavailable(project, rule, slots);
        case 'class_unavailable':
            return evaluateClassUnavailable(project, rule, slots);
        case 'locked_slot':
            return evaluateLockedSlot(project, rule, slots);
        case 'subject_morning':
            return evaluateSubjectMorning(project, rule, slots);
        case 'subject_preferred_periods':
            return evaluateSubjectPreferred(project, rule, slots);
        case 'subject_avoid_periods':
            return evaluateSubjectAvoid(project, rule, slots);
        case 'teacher_daily_limit':
            return evaluateTeacherDaily(project, rule, slots);
        case 'teacher_consecutive_limit':
            return evaluateTeacherConsecutive(project, rule, slots);
        case 'subject_spread':
            return evaluateSubjectSpread(project, rule, slots);
        default:
            return makeResult(rule, 'not_applicable', '当前版本暂不支持评估该约束。');
    }
}

function summarize(items = []) {
    return items.reduce((summary, item) => {
        summary.total += 1;
        if (item.status === 'satisfied') summary.satisfied += 1;
        else if (item.status === 'partial') summary.partial += 1;
        else if (item.status === 'unmet') summary.unmet += 1;
        else summary.notApplicable += 1;
        return summary;
    }, { total: 0, satisfied: 0, partial: 0, unmet: 0, notApplicable: 0 });
}

export function evaluateTimetableConstraintFulfillment(input = {}) {
    const project = normalizeTimetableProject(input || {});
    const rules = savedConstraintItems(project);
    const slots = Array.isArray(project.schedule?.slots) ? project.schedule.slots : [];
    const evaluated = Boolean(project.schedule && (project.schedule.id || project.schedule.source || slots.length || project.schedule.score));
    const items = rules.map(rule => evaluateRule(project, rule, slots, evaluated));
    return {
        evaluated,
        summary: summarize(items),
        items,
    };
}
