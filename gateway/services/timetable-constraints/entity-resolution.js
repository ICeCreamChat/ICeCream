import {
    timetableActivityTypeKey,
    timetableResourceTypeKey,
} from '../../../shared/timetable/lesson-metadata.js';

const KINDS = ['teacher', 'class', 'subject', 'room'];
const COLLECTIONS = {
    teacher: 'teachers',
    class: 'classes',
    subject: 'subjects',
    room: 'rooms',
};

function list(value) {
    return Array.isArray(value) ? value : [];
}

function text(value) {
    return String(value ?? '').trim();
}

function normalizedName(value, kind = '') {
    let valueText = text(value).replace(/[\s·•・_\-—（）()【】\[\]]+/g, '').toLowerCase();
    if (kind === 'teacher') valueText = valueText.replace(/(?:老师|教师)$/u, '');
    if (kind === 'class') valueText = valueText.replace(/班$/u, '');
    return valueText;
}

function candidate(item = {}, kind = '', confidence = 1) {
    return {
        id: item.id,
        label: item.name || item.id,
        name: item.name || item.id,
        kind,
        confidence,
    };
}

function resolveMention(project = {}, kind = '', sourceName = '', { allowMany = false } = {}) {
    const items = list(project[COLLECTIONS[kind]]).filter(item => item?.id);
    const query = text(sourceName);
    const normalizedQuery = normalizedName(query, kind);
    const aliasMap = project.constraintEntityAliases?.[kind] || {};
    const aliasId = Object.entries(aliasMap).find(([alias]) => normalizedName(alias, kind) === normalizedQuery)?.[1];
    if (aliasId) {
        const item = items.find(value => value.id === aliasId);
        if (item) return { status: 'matched', matchedIds: [item.id], candidates: [candidate(item, kind)] };
    }
    const exact = items.filter(item => (
        item.id === query
        || item.name === query
        || (kind === 'class' && item.grade === query)
        || normalizedName(item.name || item.id, kind) === normalizedQuery
        || (kind === 'class' && normalizedName(item.grade, kind) === normalizedQuery)
    ));
    if (allowMany && exact.length) {
        return { status: 'matched', matchedIds: exact.map(item => item.id), candidates: exact.map(item => candidate(item, kind)) };
    }
    if (exact.length === 1) return { status: 'matched', matchedIds: [exact[0].id], candidates: [candidate(exact[0], kind)] };
    if (exact.length > 1) return { status: 'ambiguous', matchedIds: [], candidates: exact.map(item => candidate(item, kind)) };
    if (!normalizedQuery) return { status: 'missing', matchedIds: [], candidates: [] };
    const fuzzy = items.filter(item => {
        const itemName = normalizedName(item.name || item.id, kind);
        return itemName && (itemName.includes(normalizedQuery) || normalizedQuery.includes(itemName));
    });
    if (fuzzy.length === 1) return { status: 'matched', matchedIds: [fuzzy[0].id], candidates: [candidate(fuzzy[0], kind, 0.82)] };
    return {
        status: fuzzy.length > 1 ? 'ambiguous' : 'missing',
        matchedIds: [],
        candidates: fuzzy.map(item => candidate(item, kind, 0.72)),
    };
}

function referencesFromIR(ir = {}) {
    const references = [];
    const add = (kind, values, allowMany = false, role = '') => list(values).forEach(value => {
        const sourceName = text(value);
        if (sourceName) references.push({ kind, sourceName, allowMany, role });
    });
    const targetKind = ir.target?.kind === 'subject_group' ? 'subject'
        : ir.target?.kind === 'class_group' || ir.target?.kind === 'grade' ? 'class'
            : ir.target?.kind;
    if (ir.target?.kind === 'grade') {
        add('class', [ir.target?.name], true, 'target');
    } else if (KINDS.includes(targetKind)) {
        const targetValues = list(ir.target?.matchedIds).length ? ir.target.matchedIds : [ir.target?.name];
        add(targetKind, targetValues, ['subject_group', 'class_group'].includes(ir.target?.kind), 'target');
    }
    add('teacher', [...list(ir.parameters?.teacherIds), ...list(ir.parameters?.teacherNames), ...list(ir.scope?.teacherNames)], false, 'teacherScope');
    add('subject', [...list(ir.parameters?.subjectIds), ...list(ir.parameters?.subjectNames)], false, 'subjectScope');
    add('class', [...list(ir.parameters?.classIds), ...list(ir.parameters?.classNames)], false, 'classScope');
    add('room', [
        ...list(ir.parameters?.preferredRoomIds),
        ...list(ir.parameters?.roomIds),
        ...list(ir.parameters?.roomRequirement?.roomIds),
    ], false, 'roomScope');
    return [...new Map(references.map(reference => [`${reference.kind}:${reference.sourceName}:${reference.role}`, reference])).values()];
}

function matchedIdsForRole(references = [], role = '') {
    return [...new Set(references.filter(reference => reference.role === role).flatMap(reference => list(reference.matchedIds)))];
}

function withResolvedIds(ir = {}, references = []) {
    const parameters = { ...(ir.parameters || {}) };
    const targetIds = matchedIdsForRole(references, 'target');
    const teacherIds = matchedIdsForRole(references, 'teacherScope');
    const subjectIds = matchedIdsForRole(references, 'subjectScope');
    const classIds = matchedIdsForRole(references, 'classScope');
    const roomIds = matchedIdsForRole(references, 'roomScope');
    if (teacherIds.length) parameters.teacherIds = teacherIds;
    if (subjectIds.length) parameters.subjectIds = subjectIds;
    if (classIds.length) parameters.classIds = classIds;
    if (roomIds.length) {
        parameters.roomIds = roomIds;
        if (parameters.preferredRoomIds) parameters.preferredRoomIds = roomIds;
        if (parameters.roomRequirement) parameters.roomRequirement = { ...parameters.roomRequirement, roomIds };
    }
    return {
        ...ir,
        target: targetIds.length ? { ...ir.target, matchedIds: targetIds } : ir.target,
        parameters,
    };
}

export function resolveConstraintIRReferences(ir = {}, project = {}) {
    const references = referencesFromIR(ir).map(reference => ({
        ...reference,
        ...resolveMention(project, reference.kind, reference.sourceName, reference),
    }));
    const resolvedIR = withResolvedIds(ir, references);
    const unresolved = references.filter(reference => reference.status !== 'matched');
    if (!unresolved.length || ir.executionStatus === 'unsupported_by_solver') {
        const rebound = !unresolved.length && ir.executionStatus === 'blocked_by_reference'
            ? {
                ...resolvedIR,
                understandingStatus: 'parsed',
                executionStatus: 'executable',
                clarifications: list(resolvedIR.clarifications).filter(message => !/未在当前项目中找到/.test(message)),
            }
            : resolvedIR;
        return { ...rebound, entityReferences: references, referenceIssues: unresolved };
    }
    const ambiguous = unresolved.some(reference => reference.status === 'ambiguous');
    const details = unresolved.map(reference => `“${reference.sourceName}”`).join('、');
    return {
        ...resolvedIR,
        understandingStatus: ambiguous ? 'ambiguous' : 'invalid_reference',
        executionStatus: 'blocked_by_reference',
        machineRuleIds: [],
        entityReferences: references,
        referenceIssues: unresolved,
        clarifications: [...new Set([
            ...list(ir.clarifications),
            `${details}尚未绑定到当前项目中的唯一实体，请选择现有对象后重新编译。`,
        ])],
    };
}

function configuredPeriods(project = {}) {
    const direct = list(project.activePeriods).map(Number).filter(Number.isInteger);
    const fromTimes = list(project.periodTimes).map(item => Number(item?.period)).filter(Number.isInteger);
    const fromSlots = list(project.periods).map(item => Number(item?.period ?? item)).filter(Number.isInteger);
    const count = Number(project.periodsPerDay);
    if (direct.length || fromTimes.length || fromSlots.length) return new Set([...direct, ...fromTimes, ...fromSlots]);
    if (Number.isInteger(count) && count > 0) return new Set(Array.from({ length: count }, (_, index) => index + 1));
    return new Set();
}

function relevantLessonPlans(ir = {}, project = {}) {
    const targetIds = new Set(list(ir.target?.matchedIds));
    const teacherIds = new Set(list(ir.parameters?.teacherIds));
    const subjectIds = new Set(list(ir.parameters?.subjectIds));
    const classIds = new Set(list(ir.parameters?.classIds));
    const grades = new Set(list(ir.parameters?.gradeNames));
    const classes = new Map(list(project.classes).map(item => [item.id, item]));
    return list(project.lessonPlans).filter(plan => {
        if (ir.target?.kind === 'subject' && targetIds.size && !targetIds.has(plan.subjectId)) return false;
        if (ir.target?.kind === 'teacher' && targetIds.size && !targetIds.has(plan.teacherId) && !list(plan.teacherIds).some(id => targetIds.has(id))) return false;
        if (teacherIds.size && !teacherIds.has(plan.teacherId) && !list(plan.teacherIds).some(id => teacherIds.has(id))) return false;
        if (subjectIds.size && !subjectIds.has(plan.subjectId)) return false;
        if (classIds.size && !classIds.has(plan.classId)) return false;
        if (grades.size && !grades.has(classes.get(plan.classId)?.grade)) return false;
        return true;
    });
}

export function assessConstraintIRExecutionReadiness(ir = {}, project = {}) {
    const readinessMessagePattern = /项目作息尚未配置|任课计划尚未标注/;
    const legacyPeriodMessagePattern = /节次\s+\d+-\d+\s+不在当前排课范围内/;
    const previousReadinessMessages = list(ir.clarifications).filter(message => readinessMessagePattern.test(message));
    const previousPeriodWarnings = list(ir.warnings).filter(message => legacyPeriodMessagePattern.test(message));
    const canReassess = ['executable', 'partially_executable'].includes(ir.executionStatus)
        || (
            ir.executionStatus === 'blocked_by_clarification'
            && (previousReadinessMessages.length > 0 || previousPeriodWarnings.length > 0)
        );
    if (!canReassess) return ir;
    const periods = new Set([
        ...list(ir.parameters?.periods).map(Number),
        ...list(ir.time?.periods).map(Number),
        ...list(ir.parameters?.boundaryPeriods).map(Number),
        ...list(ir.parameters?.slots).map(slot => Number(String(slot).split('-')[1])),
    ].filter(Number.isInteger));
    const activePeriods = configuredPeriods(project);
    const missingPeriods = [...periods].filter(period => !activePeriods.has(period));
    const requestedActivities = list(ir.parameters?.activityTypes);
    const requestedResources = list(ir.parameters?.requiredResourceTypes);
    const plans = relevantLessonPlans(ir, project);
    const activityKeys = new Set(requestedActivities.map(timetableActivityTypeKey));
    const resourceKeys = new Set(requestedResources.map(timetableResourceTypeKey));
    const hasActivityMetadata = !requestedActivities.length || plans.some(plan => (
        list(plan.activityTypes).some(value => activityKeys.has(timetableActivityTypeKey(value)))
    ));
    const hasResourceMetadata = !requestedResources.length || plans.some(plan => (
        list(plan.requiredResourceTypes).some(value => resourceKeys.has(timetableResourceTypeKey(value)))
    ));
    if (!missingPeriods.length) {
        if (!previousReadinessMessages.length && !previousPeriodWarnings.length) return ir;
        return {
            ...ir,
            understandingStatus: 'parsed',
            executionStatus: 'executable',
            parameters: {
                ...(ir.parameters || {}),
                ...(!hasActivityMetadata || !hasResourceMetadata ? { selectorCurrentlyUnmatched: true } : {}),
            },
            clarifications: list(ir.clarifications).filter(message => !readinessMessagePattern.test(message)),
            warnings: list(ir.warnings).filter(message => !legacyPeriodMessagePattern.test(message)),
        };
    }
    const clarifications = list(ir.clarifications).filter(message => !readinessMessagePattern.test(message));
    if (missingPeriods.length) clarifications.push(`项目作息尚未配置第${missingPeriods.join('、')}节，请补充作息后重新编译。`);
    return {
        ...ir,
        executionStatus: 'blocked_by_clarification',
        machineRuleIds: [],
        clarifications: [...new Set(clarifications)],
    };
}

function entityStatus(ir = {}) {
    if (ir.understandingStatus === 'ambiguous') return 'ambiguous';
    if (ir.understandingStatus === 'invalid_reference') return 'missing';
    return list(ir.target?.matchedIds).length ? 'matched' : '';
}

export function buildEntityResolution(result = {}) {
    const byKey = new Map();
    for (const ir of list(result.constraintIRs)) {
        const primary = {
            kind: text(ir.target?.kind),
            sourceName: text(ir.target?.name),
            status: entityStatus(ir),
            candidates: list(ir.target?.candidates),
            matchedIds: list(ir.target?.matchedIds),
        };
        const values = [primary, ...list(ir.entityReferences)];
        for (const value of values) {
            const { kind, sourceName, status } = value;
            if (!KINDS.includes(kind) || !sourceName || !status) continue;
            const key = `${kind}:${sourceName}`;
            const current = byKey.get(key) || { kind, sourceName, sourceIds: [], status, candidates: [], matchedIds: [] };
            current.sourceIds = [...new Set([...current.sourceIds, ir.sourceId].filter(Boolean))];
            current.candidates = [...new Map([
                ...current.candidates,
                ...list(value.candidates),
            ].filter(item => item?.id).map(item => [item.id, item])).values()];
            current.matchedIds = [...new Set([...current.matchedIds, ...list(value.matchedIds)])];
            if (status !== 'matched') current.status = status;
            byKey.set(key, current);
        }
    }
    const entries = [...byKey.values()];
    const byKind = Object.fromEntries(KINDS.map(kind => {
        const values = entries.filter(item => item.kind === kind);
        return [kind, {
            mentioned: values.length,
            matched: values.filter(item => item.status === 'matched').length,
            ambiguous: values.filter(item => item.status === 'ambiguous').length,
            missing: values.filter(item => item.status === 'missing').length,
        }];
    }));
    const summary = Object.values(byKind).reduce((total, value) => ({
        mentioned: total.mentioned + value.mentioned,
        matched: total.matched + value.matched,
        ambiguous: total.ambiguous + value.ambiguous,
        missing: total.missing + value.missing,
    }), { mentioned: 0, matched: 0, ambiguous: 0, missing: 0 });
    return {
        summary,
        byKind,
        unresolved: entries.filter(item => item.status !== 'matched'),
    };
}
