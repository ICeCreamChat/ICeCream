import {
    getTimetableEntityMaps,
    normalizeTimetableProject,
    slotKey,
    slotTeacherIds,
} from './timetable-project.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function cleanText(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function className(maps, id = '') {
    const klass = maps.classes.get(id);
    return klass ? `${klass.grade || ''}${klass.name || klass.id}` : id;
}

function entityName(maps, kind, id = '') {
    if (!id) return '';
    if (kind === 'teacher') return maps.teachers.get(id)?.name || id;
    if (kind === 'class') return className(maps, id);
    if (kind === 'subject') return maps.subjects.get(id)?.name || id;
    if (kind === 'room') return id;
    if (kind === 'plan') return maps.plans.get(id)?.id || id;
    return id;
}

function slotLabelFrom(slot = {}) {
    if (!Number.isInteger(Number(slot.day)) || !Number.isInteger(Number(slot.period))) return '';
    return slotKey(slot.day, slot.period);
}

function objectsFromDetails(details = {}) {
    return {
        teachers: [...new Set([...(details.teachers || []), ...(details.teacherIds || [])])].filter(Boolean),
        classes: [...new Set([...(details.classes || []), ...(details.classIds || [])])].filter(Boolean),
        subjects: [...new Set([...(details.subjects || []), ...(details.subjectIds || [])])].filter(Boolean),
        rooms: [...new Set([...(details.rooms || []), ...(details.roomIds || [])])].filter(Boolean),
        plans: [...new Set([...(details.plans || []), ...(details.planIds || [])])].filter(Boolean),
    };
}

function detailsFromSlot(slot = {}, fallback = {}) {
    return objectsFromDetails({
        teacherIds: [
            ...slotTeacherIds(slot),
            fallback.teacherId,
            ...(fallback.teacherIds || []),
        ],
        classIds: [slot.classId, fallback.classId],
        subjectIds: [slot.subjectId, fallback.subjectId],
        roomIds: [slot.roomId, fallback.roomId],
        planIds: [slot.lessonPlanId, fallback.lessonPlanId],
    });
}

function detailsFromLooseItem(item = {}, maps) {
    const plan = item.lessonPlanId ? maps.plans.get(item.lessonPlanId) : null;
    const slot = item.slot || {};
    return detailsFromSlot(slot, {
        teacherId: item.teacherId || plan?.teacherId,
        teacherIds: item.teacherIds || plan?.teacherIds || [],
        classId: item.classId || plan?.classId,
        subjectId: item.subjectId || plan?.subjectId,
        roomId: item.roomId || plan?.roomId,
        lessonPlanId: item.lessonPlanId || plan?.id,
    });
}

function primaryTarget(objects, item = {}, maps) {
    const kind = item.targetKind || (
        objects.teachers[0] ? 'teacher'
            : objects.classes[0] ? 'class'
                : objects.subjects[0] ? 'subject'
                    : objects.rooms[0] ? 'room'
                        : objects.plans[0] ? 'plan'
                            : 'schedule'
    );
    const id = item.targetId || (
        kind === 'teacher' ? objects.teachers[0]
            : kind === 'class' ? objects.classes[0]
                : kind === 'subject' ? objects.subjects[0]
                    : kind === 'room' ? objects.rooms[0]
                        : kind === 'plan' ? objects.plans[0]
                            : ''
    ) || '';
    return {
        targetKind: kind,
        targetId: id,
        targetName: item.targetName || entityName(maps, kind, id) || '课表',
    };
}

function makeItem({
    category,
    source,
    type,
    severity = 'info',
    message,
    slot = '',
    details = {},
    raw = null,
}, maps) {
    const objects = objectsFromDetails(details);
    const target = primaryTarget(objects, raw || {}, maps);
    return {
        id: '',
        category,
        source,
        type: cleanText(type, category),
        severity: ['error', 'warning', 'info'].includes(severity) ? severity : 'info',
        targetKind: target.targetKind,
        targetId: target.targetId,
        targetName: target.targetName,
        message: cleanText(message, cleanText(type, category)),
        slot: cleanText(slot),
        objects,
    };
}

function normalizeIssueSeverity(item = {}, fallback = 'warning') {
    if (item.severity === 'error' || item.severity === 'hard') return 'error';
    if (item.severity === 'info') return 'info';
    if (item.type?.endsWith?.('_capacity')) return 'error';
    return fallback;
}

function itemKey(item) {
    return [
        item.category,
        item.source,
        item.type,
        item.severity,
        item.targetKind,
        item.targetId,
        item.slot,
        item.message,
    ].join('|');
}

function addItem(items, seen, item) {
    const key = itemKey(item);
    if (seen.has(key)) return null;
    seen.add(key);
    item.id = `diag_${items.length + 1}`;
    items.push(item);
    return item;
}

function indexItem(byObject, item) {
    const add = (bucket, id) => {
        if (!id) return;
        if (!byObject[bucket][id]) byObject[bucket][id] = [];
        byObject[bucket][id].push(item.id);
    };
    for (const id of item.objects.teachers || []) add('teachers', id);
    for (const id of item.objects.classes || []) add('classes', id);
    for (const id of item.objects.subjects || []) add('subjects', id);
    for (const id of item.objects.rooms || []) add('rooms', id);
    for (const id of item.objects.plans || []) add('plans', id);
    if (item.targetKind === 'teacher') add('teachers', item.targetId);
    if (item.targetKind === 'class') add('classes', item.targetId);
    if (item.targetKind === 'subject') add('subjects', item.targetId);
    if (item.targetKind === 'room') add('rooms', item.targetId);
    if (item.targetKind === 'plan') add('plans', item.targetId);
}

function suggestionMessage(item) {
    if (item.category === 'unplaced') {
        return `检查 ${item.targetName} 的任课、不可排时间和可用节次，必要时放宽限制后重新生成。`;
    }
    if (item.type?.includes?.('capacity')) {
        return `复核 ${item.targetName} 的课时容量，考虑增加节次、减少课时或调整不可排时间。`;
    }
    if (item.category === 'conflict') {
        return `定位 ${item.targetName} 的冲突课节，尝试手动调整、解锁或重新生成课表。`;
    }
    if (item.category === 'publication') {
        return `发布前先处理 ${item.targetName} 的阻断项，再重新检查课表。`;
    }
    if (item.category === 'quality') {
        return `复核 ${item.targetName} 的软规则表现，必要时调整偏好或接受当前结果。`;
    }
    return `复核 ${item.targetName} 的相关数据。`;
}

function buildSuggestions(items = []) {
    const seen = new Set();
    const suggestions = [];
    for (const item of items) {
        if (item.severity === 'info') continue;
        const key = `${item.category}:${item.type}:${item.targetKind}:${item.targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({
            id: `sug_${suggestions.length + 1}`,
            kind: item.category,
            targetDiagnostics: [item.id],
            targetKind: item.targetKind,
            targetId: item.targetId,
            targetName: item.targetName,
            message: suggestionMessage(item),
            confidence: item.severity === 'error' ? 'medium' : 'low',
            applied: false,
        });
    }
    return suggestions;
}

function collectAuditItems(project, maps, add) {
    const audit = project.schedule?.audit || null;
    if (!audit) return;
    for (const item of audit.blockingIssues || []) {
        add(makeItem({
            category: 'audit',
            source: 'schedule.audit.blockingIssues',
            type: item.type,
            severity: 'error',
            message: item.message,
            details: detailsFromLooseItem(item, maps),
            raw: item,
        }, maps));
    }
    for (const item of audit.warnings || []) {
        add(makeItem({
            category: 'audit',
            source: 'schedule.audit.warnings',
            type: item.type,
            severity: normalizeIssueSeverity(item, 'warning'),
            message: item.message,
            details: detailsFromLooseItem(item, maps),
            raw: item,
        }, maps));
    }
}

function collectUnplacedItems(project, maps, add) {
    for (const item of project.schedule?.unplaced || []) {
        add(makeItem({
            category: 'unplaced',
            source: 'schedule.unplaced',
            type: 'unplaced',
            severity: 'error',
            message: item.reason || '有课程未排入课表。',
            details: detailsFromLooseItem(item, maps),
            raw: item,
        }, maps));
    }
}

function collectConflictItems(project, maps, add) {
    for (const item of project.schedule?.conflicts || []) {
        if (item.type === 'unplaced') continue;
        const slot = item.slot || {};
        add(makeItem({
            category: 'conflict',
            source: 'schedule.conflicts',
            type: item.type,
            severity: normalizeIssueSeverity(item, 'error'),
            message: item.message || item.reason,
            slot: slotLabelFrom(slot),
            details: detailsFromLooseItem(item, maps),
            raw: item,
        }, maps));
    }
}

function collectQualityItems(project, maps, add) {
    for (const item of project.schedule?.qualityIssues || []) {
        const slot = item.slot || {};
        add(makeItem({
            category: 'quality',
            source: 'schedule.qualityIssues',
            type: item.type,
            severity: normalizeIssueSeverity(item, 'warning'),
            message: item.message,
            slot: slotLabelFrom(slot),
            details: detailsFromLooseItem(item, maps),
            raw: item,
        }, maps));
    }
}

function collectPublicationItems(project, maps, add, publication) {
    const sourcePublication = publication || project.schedule?.publication || null;
    if (!sourcePublication) return;
    const reviewItems = Array.isArray(sourcePublication.reviewItems)
        ? sourcePublication.reviewItems
        : [];
    for (const item of reviewItems) {
        add(makeItem({
            category: 'publication',
            source: 'schedule.publication.reviewItems',
            type: item.type,
            severity: normalizeIssueSeverity(item, 'warning'),
            message: item.message,
            slot: item.slot || '',
            details: detailsFromLooseItem(item, maps),
            raw: item,
        }, maps));
    }
}

export function buildTimetableDiagnostics(input = {}, options = {}) {
    const project = normalizeTimetableProject(input);
    const maps = getTimetableEntityMaps(project);
    const items = [];
    const seen = new Set();
    const add = item => addItem(items, seen, item);

    collectAuditItems(project, maps, add);
    collectUnplacedItems(project, maps, add);
    collectConflictItems(project, maps, add);
    collectQualityItems(project, maps, add);
    collectPublicationItems(project, maps, add, options.publication);

    items.sort((left, right) => (
        (SEVERITY_ORDER[left.severity] ?? 3) - (SEVERITY_ORDER[right.severity] ?? 3)
        || left.category.localeCompare(right.category)
        || left.targetName.localeCompare(right.targetName, 'zh-Hans-CN')
        || left.type.localeCompare(right.type)
    ));
    items.forEach((item, index) => { item.id = `diag_${index + 1}`; });

    const byObject = { teachers: {}, classes: {}, subjects: {}, rooms: {}, plans: {} };
    for (const item of items) indexItem(byObject, item);

    const summary = { error: 0, warning: 0, info: 0, total: items.length, suggestions: 0 };
    for (const item of items) {
        summary[item.severity] = (summary[item.severity] || 0) + 1;
    }

    const suggestions = buildSuggestions(items);
    summary.suggestions = suggestions.length;

    return {
        diagnosticsVersion: 1,
        items,
        summary,
        byObject,
        suggestions,
    };
}

export function attachTimetableDiagnostics(project = {}, schedule = project.schedule, options = {}) {
    if (!schedule) return schedule;
    schedule.diagnostics = buildTimetableDiagnostics({ ...project, schedule }, options);
    return schedule;
}
