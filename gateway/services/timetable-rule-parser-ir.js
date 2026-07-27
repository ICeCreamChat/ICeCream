import {
    getActivePeriods,
    getActiveWeekdays,
    makeTimetableId,
    normalizeWeekPattern,
    slotKey,
} from './timetable-project.js';
import {
    previewTimetableRosterFile,
} from './timetable-import.js';
import {
    extractRequirementsWithAI,
} from './timetable-ai-extractor.js';
import {
    applyClarificationPolicy,
} from './timetable-clarify-policies.js';
import {
    alignAiArtifactsToSources,
} from './timetable-constraints/ai-source-alignment.js';
import {
    createDefaultTimetableCapabilityRegistry,
} from './timetable-constraints/capabilities.js';
import {
    aggregateConstraintIRStatuses,
    normalizeConstraintIR,
} from './timetable-constraints/constraint-ir.js';
import {
    resolveSemanticAiMode,
    sourceNeedsSemanticPlanning,
} from './timetable-constraints/semantic-planning.js';

import {
    TimetableRuleParseError,
    aiDraftRowsFromParsed,
    asList,
    asText,
    callAi,
    constraintsTextFromSheet,
    entityItemsForType,
    findEntity,
    isAllTeachersTarget,
    localTextConstraintsFromInput,
    matchEntityCandidates,
    normalizeAllTeachersTargetRow,
    normalizeConstraintType,
    normalizePriority,
    normalizeRosterFallback,
    normalizedMessageValues,
    normalizedParsedBy,
    normalizedTextValues,
    parseDays,
    parsePeriods,
    prepareSourceInputs,
    projectWithRosterPreview,
    rosterContext,
    rowsFromAiConstraints,
    shouldNormalizeAllTeachersTarget,
    slotsFromConstraint,
    targetTypeFor,
    textFromConstraintRows,
    warningMessagesFromAi,
    weekPatternFromText,
} from './timetable-rule-parser-sources.js';
import {
    INTERNAL_OBJECT_NAMES,
    OBSOLETE_EXECUTABLE_WARNING_PATTERNS,
    actionForRequirement,
    aiLocalAgreementCount,
    aiReviewStatusPayload,
    artifactSourceIdentityConflicts,
    blockPreferenceRequirementsFromText,
    cloneValue,
    complexModelIsEnabled,
    complexRequirementsFromText,
    dedupeRequirements,
    externalRequirementItems,
    generatedTextRequirementSupersedesRow,
    localParseSourceForInput,
    localResultCanSkipAi,
    mergeAiFirstCandidateRows,
    mergeSourceSemanticRationales,
    optimizationRequirementsFromText,
    preciseSemanticRequirementsFromText,
    requirementFromRow,
    requirementWithSourceProvenance,
    resolveSemanticRequirementRelations,
    reviewTimetableParseResult,
    scopeParsedCoursePreferenceRequirements,
    scopeParsedCoursePreferenceRows,
    scopedRowSupersedesGeneratedRequirement,
    stableJson,
    systemRequirementsFromText,
    targetedReviewSourceIds,
    uniqueConstraintMessages,
    unresolvedConstraintRowsForAi,
    withAiReviewUnavailable,
    withSemanticAssistance,
    withValidatedAiFirstResult,
} from './timetable-rule-parser-artifacts.js';
import {
    normalizeTimetableRuleDraftRows,
} from './timetable-rule-parser.js';

const MAX_RULE_FILE_BYTES = 5 * 1024 * 1024;

const PARSER_VERSION = 'timetable_rule_parser_constraint_ir_v11';

const AI_REVIEW_PROMPT_VERSION = 'timetable_ai_review_v4';

const CAPABILITY_VERSION = 'timetable_capability_registry_v6';

const AI_CANDIDATE_VALIDATION_VERSION = 'timetable_ai_candidate_validation_v1';

const DEFAULT_AI_REVIEW_TIMEOUT_MS = 30_000;

const PARSE_CACHE = new Map();

const MAX_PARSE_CACHE_ITEMS = 40;

const TIMETABLE_CAPABILITY_REGISTRY = createDefaultTimetableCapabilityRegistry();

const SUPPORTED_EFFECTIVE_TYPES = new Set([
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'global_unavailable',
    'subject_morning',
    'subject_afternoon',
    'subject_preferred_periods',
    'subject_avoid_periods',
    'subject_daily_limit',
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'teacher_weekly_limit',
    'teacher_max_days_per_week',
    'teacher_mutual_exclusion',
    'subject_spread',
    'course_interval',
    'room_requirement',
    'class_daily_balance',
    'teacher_gap_preference',
    'teacher_load_balance',
    'subject_not_same_day',
    'subject_sequence',
    'advanced_constraint',
]);

const SUGGESTION_ONLY_TYPES = new Set([
    'quality_subject_later',
    'block_protection',
    'class_subject_spread',
]);

const STATUS_LABELS = new Set(['effective', 'ready', 'needs_review', 'suggestion', 'unsupported', 'invalid', 'ignored']);

const SYSTEM_TEACHER_TIME_CONFLICT_PATTERN = /同一.*教师.*同一.*时间.*(只能|一个班|一门课)|教师.*不能.*同.*时间.*(多个|两个|两个班|上课)/;

const SYSTEM_CLASS_TIME_CONFLICT_PATTERN = /同一.*班级.*同一.*时间.*(只能|一门|一节)|班级.*不能.*同.*时间.*(多个|两门|两节)/;

const SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN = /(每个|各个)?.*班级.*(每门|各门)?.*课程.*(周课时|课时).*(排满|不能少排|不能多排|不少排|不多排)|周课时.*(排满|不能少排|不能多排)/;

const DAY_NAME_TO_NUMBER = new Map([
    ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7], ['天', 7],
    ['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
]);

const ENGLISH_DAY_NAME_TO_NUMBER = new Map([
    ['monday', 1], ['mon', 1],
    ['tuesday', 2], ['tue', 2], ['tues', 2],
    ['wednesday', 3], ['wed', 3],
    ['thursday', 4], ['thu', 4], ['thur', 4], ['thurs', 4],
    ['friday', 5], ['fri', 5],
    ['saturday', 6], ['sat', 6],
    ['sunday', 7], ['sun', 7],
]);

const CHINESE_NUMBER_TO_VALUE = new Map([
    ['零', 0], ['〇', 0],
    ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5],
    ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);

const NUMBER_TOKEN_PATTERN = '[0-9一二两三四五六七八九十零〇]{1,4}';

function resolveEntityList(items = [], values = []) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
        const text = asText(value, 160);
        if (!text) continue;
        const match = findEntity(items, { targetId: text, targetName: text });
        if (match && !seen.has(match.id)) {
            seen.add(match.id);
            result.push(match);
        }
    }
    return result;
}

function addSlots(map, id, slots) {
    if (!id || !slots.length) return;
    map[id] = [...new Set([...(map[id] || []), ...slots])].sort();
}

function addMorningSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.morningSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.morningSubjects = current;
}

function addAfternoonSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.afternoonSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.afternoonSubjects = current;
}

function addSubjectPeriodPreference(rules, subjectId, { prefer = [], avoid = [], weight = 20, weekPattern = '' } = {}) {
    if (!subjectId) return;
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    const current = rules.softRules.subjectPreferredPeriods[subjectId] || { prefer: [], avoid: [], weight };
    rules.softRules.subjectPreferredPeriods[subjectId] = {
        prefer: [...new Set([...(current.prefer || []), ...prefer])].sort(),
        avoid: [...new Set([...(current.avoid || []), ...avoid])].sort(),
        weight: Math.max(1, Math.min(100, Number.parseInt(weight ?? current.weight ?? 20, 10) || 20)),
        ...(weekPattern ? { weekPattern: normalizeWeekPattern(weekPattern) } : current.weekPattern ? { weekPattern: current.weekPattern } : {}),
    };
}

function addTeacherLimit(rules, teacherId, { daily, consecutive } = {}) {
    if (!teacherId) return;
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    const current = { ...(rules.softRules.teacherLimits[teacherId] || {}) };
    if (Number.isInteger(daily) && daily > 0) current.daily = Math.min(12, daily);
    if (Number.isInteger(consecutive) && consecutive > 0) current.consecutive = Math.min(12, consecutive);
    if (Object.keys(current).length) rules.softRules.teacherLimits[teacherId] = current;
}

function addSpreadSubject(rules, subjectId) {
    if (!subjectId) return;
    const current = rules.softRules.spreadSubjects || [];
    if (!current.includes(subjectId)) current.push(subjectId);
    rules.softRules.spreadSubjects = current;
}

function addCourseInterval(rules, subjectId, minGapDays = 1) {
    addSpreadSubject(rules, subjectId);
    rules.softRules.spreadSubjectGaps = { ...(rules.softRules.spreadSubjectGaps || {}) };
    const gap = Math.max(1, Math.min(7, Number.parseInt(minGapDays, 10) || 1));
    const current = Number.parseInt(rules.softRules.spreadSubjectGaps[subjectId], 10);
    rules.softRules.spreadSubjectGaps[subjectId] = Number.isInteger(current) ? Math.max(current, gap) : gap;
}

function addGlobalUnavailable(rules, slots = []) {
    rules.hardRules.globalUnavailable = [...new Set([...(rules.hardRules.globalUnavailable || []), ...slots])].sort();
}

function setIntLimit(map, id, limit, min = 1, max = 40, preferLower = true) {
    const value = Number.parseInt(limit, 10);
    if (!id || !Number.isInteger(value) || value <= 0) return;
    const clamped = Math.max(min, Math.min(max, value));
    const current = Number.parseInt(map[id], 10);
    if (Number.isInteger(current)) {
        map[id] = preferLower ? Math.min(current, clamped) : Math.max(current, clamped);
    } else {
        map[id] = clamped;
    }
}

function addSubjectDailyLimit(rules, subjectId, limit) {
    rules.hardRules.subjectDailyLimit = { ...(rules.hardRules.subjectDailyLimit || {}) };
    setIntLimit(rules.hardRules.subjectDailyLimit, subjectId, limit, 1, 8, true);
}

function addTeacherWeeklyLimit(rules, teacherId, limit) {
    rules.hardRules.teacherWeeklyLimit = { ...(rules.hardRules.teacherWeeklyLimit || {}) };
    setIntLimit(rules.hardRules.teacherWeeklyLimit, teacherId, limit, 1, 40, true);
}

function addTeacherMaxDaysPerWeek(rules, teacherId, limit) {
    rules.hardRules.teacherMaxDaysPerWeek = { ...(rules.hardRules.teacherMaxDaysPerWeek || {}) };
    setIntLimit(rules.hardRules.teacherMaxDaysPerWeek, teacherId, limit, 1, 7, true);
}

function addTeacherMutualExclusion(rules, teacherIds = []) {
    const ids = normalizedTextValues(120, teacherIds).sort();
    if (ids.length < 2) return;
    const key = ids.join('|');
    const current = rules.hardRules.teacherMutualExclusion || [];
    if (!current.some(group => normalizedTextValues(120, group.teacherIds).sort().join('|') === key)) {
        current.push({ teacherIds: ids });
    }
    rules.hardRules.teacherMutualExclusion = current;
}

function addSubjectNotSameDay(rules, subjectIds = [], classIds = []) {
    const subjects = normalizedTextValues(120, subjectIds).slice(0, 2);
    if (subjects.length < 2) return;
    const classes = normalizedTextValues(120, classIds).sort();
    const key = `${subjects.slice().sort().join('|')}::${classes.join('|')}`;
    const current = rules.hardRules.subjectNotSameDay || [];
    if (!current.some(item => `${normalizedTextValues(120, item.subjectIds).sort().join('|')}::${normalizedTextValues(120, item.classIds).sort().join('|')}` === key)) {
        current.push({ subjectIds: subjects, classIds: classes });
    }
    rules.hardRules.subjectNotSameDay = current;
}

function addRoomRequirement(rules, subjectId, { roomIds = [], requiredTags = [] } = {}) {
    if (!subjectId) return;
    const rooms = [...new Set(roomIds.map(id => asText(id, 120)).filter(Boolean))];
    const tags = [...new Set(requiredTags.map(id => asText(id, 120)).filter(Boolean))];
    if (!rooms.length && !tags.length) return;
    rules.hardRules.roomRequirements = { ...(rules.hardRules.roomRequirements || {}) };
    const current = rules.hardRules.roomRequirements[subjectId] || { roomIds: [], requiredTags: [] };
    rules.hardRules.roomRequirements[subjectId] = {
        roomIds: [...new Set([...(current.roomIds || []), ...rooms])],
        requiredTags: [...new Set([...(current.requiredTags || []), ...tags])],
    };
}

function setClassDailyBalance(rules, { mainSubjectDailyMax = 0 } = {}) {
    const current = rules.softRules.classDailyBalance || {};
    rules.softRules.classDailyBalance = {
        enabled: true,
        mainSubjectDailyMax: Math.max(
            Number.parseInt(current.mainSubjectDailyMax, 10) || 0,
            Math.max(0, Math.min(8, Number.parseInt(mainSubjectDailyMax, 10) || 0)),
        ),
    };
}

function setTeacherLoadBalance(rules, weight = 1) {
    rules.softRules.teacherLoadBalance = {
        enabled: true,
        weight: Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1)),
        explicit: true,
    };
    rules.softRules.balancedTeacherLoad = true;
}

function setTeacherGapWeight(rules, weight = 1) {
    rules.softRules.teacherGapWeight = Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1));
}

function addSubjectSequence(rules, { beforeSubjectId, afterSubjectId, classIds = [], weight = 1 } = {}) {
    if (!beforeSubjectId || !afterSubjectId || beforeSubjectId === afterSubjectId) return;
    const classes = normalizedTextValues(120, classIds).sort();
    const key = `${beforeSubjectId}|${afterSubjectId}|${classes.join('|')}`;
    const current = rules.softRules.subjectSequence || [];
    if (!current.some(item => `${item.beforeSubjectId}|${item.afterSubjectId}|${normalizedTextValues(120, item.classIds).sort().join('|')}` === key)) {
        current.push({
            beforeSubjectId,
            afterSubjectId,
            classIds: classes,
            weight: Math.max(1, Math.min(10, Number.parseInt(weight, 10) || 1)),
        });
    }
    rules.softRules.subjectSequence = current;
}

function ensureComplexModel(project = {}) {
    project.timetableModelVersion = 'complex_v1';
    project.complexModelEnabled = true;
    project.campuses = asList(project.campuses).filter(item => item && typeof item === 'object');
    project.rooms = asList(project.rooms).filter(item => item && typeof item === 'object');
    project.teachingGroups = asList(project.teachingGroups).filter(item => item && typeof item === 'object');
    project.commuteRules = project.commuteRules && typeof project.commuteRules === 'object'
        ? project.commuteRules
        : { defaultGapPeriods: 1, teacherGapPeriods: {} };
    project.rules = project.rules || {};
    project.rules.softRules = project.rules.softRules || {};
}

function ensureRoom(project = {}, room = {}) {
    const name = asText(room.name || room.roomName, 120);
    const id = asText(room.id, 120) || (name ? makeTimetableId('room', name) : '');
    if (!id || !name) return null;
    project.rooms = asList(project.rooms).filter(item => item && typeof item === 'object');
    let existing = project.rooms.find(item => item.id === id || item.name === name);
    if (!existing) {
        existing = {
            id,
            name,
            campusId: asText(room.campusId || room.campus, 120),
            capacity: Number.isInteger(Number(room.capacity)) ? Number(room.capacity) : 0,
            tags: normalizedTextValues(80, room.tags, room.requiredTags),
        };
        project.rooms.push(existing);
    } else {
        existing.id = existing.id || id;
        existing.name = existing.name || name;
        if (room.campusId || room.campus) existing.campusId = asText(room.campusId || room.campus, 120);
        if (Number.isInteger(Number(room.capacity))) existing.capacity = Number(room.capacity);
        const tags = [...new Set([...(existing.tags || []), ...((room.tags || room.requiredTags || []).map(value => asText(value, 80)).filter(Boolean))])];
        existing.tags = tags;
    }
    return existing;
}

function lessonPlanTargetsForAction(project = {}, action = {}) {
    const explicitPlanIds = new Set((action.target?.lessonPlanIds || []).map(value => asText(value, 120)).filter(Boolean));
    const subjectIds = new Set((action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean));
    return (project.lessonPlans || []).filter(plan => (
        explicitPlanIds.has(plan.id)
        || (!explicitPlanIds.size && subjectIds.has(plan.subjectId))
    ));
}

function applyComplexModelPatch(project = {}, action = {}) {
    ensureComplexModel(project);
    let changed = false;
    const patch = action.patch || {};
    const targetPlans = lessonPlanTargetsForAction(project, action);

    if (patch.timetableModelVersion === 'complex_v1' || patch.complexModelEnabled === true) {
        changed = true;
    }

    if (patch.weekPattern) {
        const weekPattern = normalizeWeekPattern(patch.weekPattern);
        targetPlans.forEach(plan => {
            plan.weekPattern = weekPattern;
            changed = true;
        });
        const subjectIds = (action.target?.subjectIds || []).map(value => asText(value, 120)).filter(Boolean);
        if (subjectIds.length && (patch.preferredSlots?.length || patch.avoidSlots?.length)) {
            subjectIds.forEach(subjectId => addSubjectPeriodPreference(project.rules, subjectId, {
                prefer: patch.preferredSlots || [],
                avoid: patch.avoidSlots || [],
                weight: patch.weight || 30,
                weekPattern,
            }));
            changed = true;
        }
    }

    if (patch.roomRequirement && typeof patch.roomRequirement === 'object') {
        const roomIds = [...new Set([
            ...(patch.roomRequirement.preferredRoomIds || []),
            ...(patch.roomRequirement.roomIds || []),
        ].map(value => asText(value, 120)).filter(Boolean))];
        const roomName = asText(patch.roomRequirement.roomName || patch.roomRequirement.name, 120);
        if (roomName && !roomIds.length) {
            const room = ensureRoom(project, {
                id: makeTimetableId('room', roomName),
                name: roomName,
                tags: patch.roomRequirement.requiredTags || [],
                campusId: patch.roomRequirement.campusId,
                capacity: patch.roomRequirement.capacity,
            });
            if (room) roomIds.push(room.id);
        } else if (roomName && roomIds.length) {
            ensureRoom(project, {
                id: roomIds[0],
                name: roomName,
                tags: patch.roomRequirement.requiredTags || [],
                campusId: patch.roomRequirement.campusId,
                capacity: patch.roomRequirement.capacity,
            });
        }
        if (roomIds.length || patch.roomRequirement.requiredTags?.length) {
            targetPlans.forEach(plan => {
                plan.roomRequirement = {
                    ...(plan.roomRequirement || {}),
                    preferredRoomIds: [...new Set([...(plan.roomRequirement?.preferredRoomIds || []), ...roomIds])],
                    allowedRoomIds: [...new Set([...(plan.roomRequirement?.allowedRoomIds || []), ...(patch.roomRequirement.allowedRoomIds || [])])],
                    requiredTags: [...new Set([...(plan.roomRequirement?.requiredTags || []), ...(patch.roomRequirement.requiredTags || [])])],
                };
                if (roomIds[0]) {
                    plan.roomId = plan.roomId || roomIds[0];
                    plan.allowedRoomIds = [...new Set([...(plan.allowedRoomIds || []), ...roomIds])];
                }
                changed = true;
            });
        }
    }

    if (patch.teachingGroup && typeof patch.teachingGroup === 'object') {
        const classIds = normalizedTextValues(120, patch.teachingGroup.classIds);
        const subjectIds = normalizedTextValues(120, patch.teachingGroup.subjectIds, action.target?.subjectIds);
        const name = asText(patch.teachingGroup.name, 160)
            || [classIds.join('、'), subjectIds.join('、'), '教学组'].filter(Boolean).join('-');
        if (classIds.length && subjectIds.length) {
            const id = asText(patch.teachingGroup.id, 120) || makeTimetableId('tg', `${name}-${classIds.join('-')}-${subjectIds.join('-')}`);
            let group = (project.teachingGroups || []).find(item => item.id === id || item.name === name);
            if (!group) {
                group = {
                    id,
                    name,
                    mode: ['combined_class', 'rotation', 'split_class'].includes(patch.teachingGroup.mode) ? patch.teachingGroup.mode : 'combined_class',
                    classIds,
                    subjectIds,
                    teacherIds: normalizedTextValues(120, patch.teachingGroup.teacherIds),
                    roomIds: normalizedTextValues(120, patch.teachingGroup.roomIds),
                };
                project.teachingGroups.push(group);
            }
            (project.lessonPlans || [])
                .filter(plan => classIds.includes(plan.classId) && subjectIds.includes(plan.subjectId))
                .forEach(plan => {
                    plan.teachingGroupId = group.id;
                });
            changed = true;
        }
    }

    if (patch.commuteRules && typeof patch.commuteRules === 'object') {
        const defaultGap = Number.parseInt(patch.commuteRules.defaultGapPeriods ?? patch.commuteRules.defaultGap ?? patch.commuteRules.gapPeriods, 10);
        project.commuteRules = project.commuteRules || { defaultGapPeriods: 1, teacherGapPeriods: {} };
        if (Number.isInteger(defaultGap) && defaultGap >= 0) {
            project.commuteRules.defaultGapPeriods = Math.min(12, defaultGap);
            changed = true;
        }
        const teacherGapPeriods = patch.commuteRules.teacherGapPeriods || {};
        project.commuteRules.teacherGapPeriods = project.commuteRules.teacherGapPeriods || {};
        Object.entries(teacherGapPeriods).forEach(([teacherIdRaw, gapRaw]) => {
            const teacherId = asText(teacherIdRaw, 120);
            const gap = Number.parseInt(gapRaw, 10);
            if (teacherId && Number.isInteger(gap) && gap >= 0) {
                project.commuteRules.teacherGapPeriods[teacherId] = Math.min(12, gap);
                changed = true;
            }
        });
    }

    return changed;
}

function parseFirstSlot(slots = []) {
    const [first] = asList(slots);
    const match = String(first || '').match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;
    return {
        day: Number.parseInt(match[1], 10),
        period: Number.parseInt(match[2], 10),
    };
}

function normalizedRequirementQuantifier(quantifier = {}, minOccurrences = undefined) {
    if (quantifier && typeof quantifier === 'object' && Object.keys(quantifier).length) {
        return { ...quantifier };
    }
    const minimum = Number.parseInt(minOccurrences, 10);
    return Number.isInteger(minimum) && minimum > 0
        ? { unit: 'occurrences_per_week', min: minimum }
        : {};
}

function findLockedLessonPlan(project, { classId, subjectId, teacherId }) {
    return (project.lessonPlans || []).find(plan => (
        plan.classId === classId
        && plan.subjectId === subjectId
        && (plan.teacherId === teacherId || asList(plan.teacherIds).includes(teacherId))
    )) || null;
}

function addLockedSlot(rules, locked) {
    if (!locked) return;
    const keyFor = item => [
        item.day,
        item.period,
        item.classId,
        item.subjectId,
        item.teacherId,
        item.lessonPlanId || '',
    ].join('|');
    const existing = new Set((rules.hardRules.lockedSlots || []).map(keyFor));
    if (!existing.has(keyFor(locked))) rules.hardRules.lockedSlots.push(locked);
}

function normalizeDraftRow(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const slots = slotsFromConstraint(row, project);
    const rawText = asText(row.rawText || row.constraintText || row.text || row.description || row.reason || '', 2000);
    const status = STATUS_LABELS.has(row.status) ? row.status : SUPPORTED_EFFECTIVE_TYPES.has(type) ? 'effective' : 'suggestion';
    const idList = values => normalizedTextValues(120, values);
    const numberList = values => [...new Set((Array.isArray(values) ? values : [values])
        .map(value => Number.parseInt(value, 10))
        .filter(Number.isInteger))];
    return {
        id: asText(row.id, 240) || `rule_draft_${index + 1}`,
        machineRuleId: asText(row.machineRuleId || '', 240),
        requirementId: asText(row.requirementId || '', 240),
        clauseId: asText(row.clauseId || '', 300),
        constraintId: asText(row.constraintId || '', 300),
        capabilityId: asText(row.capabilityId || '', 160),
        advancedType: asText(row.advancedType || '', 160),
        intent: asText(row.intent || '', 160),
        sourceId: asText(row.sourceId || '', 300),
        textHash: asText(row.textHash || '', 128),
        origin: asText(row.origin || '', 40),
        parsedBy: normalizedParsedBy(row.parsedBy),
        stableKey: asText(row.stableKey || '', 240),
        parseSource: asText(row.parseSource || row.source || '', 80),
        generatedBy: asText(row.generatedBy || '', 80),
        compilerVersion: Number.parseInt(row.compilerVersion, 10) || undefined,
        constraintIrVersion: Number.parseInt(row.constraintIrVersion, 10) || undefined,
        source: asText(row.source || row.sourceSheet || '', 120),
        sourceSheet: asText(row.sourceSheet || row.sheetName || '', 120),
        sourceRow: Number.parseInt(row.sourceRow, 10) || null,
        lineNumber: Number.parseInt(row.lineNumber, 10) || null,
        rawText,
        normalizationTrace: asList(row.normalizationTrace || row.source?.normalizationTrace)
            .filter(item => item && typeof item === 'object')
            .map(item => ({ ...item })),
        negation: row.negation && typeof row.negation === 'object' ? { ...row.negation } : (row.negation ?? null),
        exceptions: asList(row.exceptions).map(item => item && typeof item === 'object' ? { ...item } : item),
        activity: row.activity && typeof row.activity === 'object' ? { ...row.activity } : (row.activity ?? null),
        type,
        targetType: targetTypeFor(type, row),
        targetId: asText(row.targetId || row.teacherId || row.classId || row.subjectId || '', 120),
        targetName: asText(row.targetName || row.target || row.teacher || row.teacherName || row.class || row.className || row.subject || row.subjectName || '', 200),
        classId: asText(row.classId || '', 120),
        className: asText(row.className || row.class || '', 200),
        subjectId: asText(row.subjectId || '', 120),
        subjectName: asText(row.subjectName || row.subject || '', 200),
        teacherId: asText(row.teacherId || '', 120),
        teacherName: asText(row.teacherName || row.teacher || '', 200),
        teacherIds: idList(row.teacherIds || row.teachers || []),
        subjectIds: idList(row.subjectIds || row.subjects || []),
        classIds: idList(row.classIds || row.classes || []),
        gradeNames: idList(row.gradeNames || row.grades || row.parameters?.gradeNames || []),
        blockPreference: asText(row.blockPreference || row.parameters?.blockPreference || '', 40),
        minOccurrences: Number.parseInt(row.minOccurrences ?? row.parameters?.minOccurrences, 10) || undefined,
        avoidDayParts: idList(row.avoidDayParts || row.parameters?.avoidDayParts || []),
        subjectNames: idList(row.subjectNames || row.parameters?.subjectNames || []),
        activityTypes: idList(row.activityTypes || row.parameters?.activityTypes || []),
        preferredActivityTypes: idList(row.preferredActivityTypes || row.parameters?.preferredActivityTypes || []),
        requiredResourceTypes: idList(row.requiredResourceTypes || row.parameters?.requiredResourceTypes || []),
        sameDay: typeof (row.sameDay ?? row.parameters?.sameDay) === 'boolean'
            ? (row.sameDay ?? row.parameters?.sameDay)
            : undefined,
        roomIds: idList(row.roomIds || row.allowedRoomIds || row.rooms || []),
        roomName: asText(row.roomName || row.room || '', 200),
        requiredTags: idList(row.requiredTags || row.roomTags || []),
        beforeSubjectId: asText(row.beforeSubjectId || row.before || '', 120),
        afterSubjectId: asText(row.afterSubjectId || row.after || row.nextSubjectId || '', 120),
        slots,
        days: parseDays(row.days || row.weekdays || '', project, []),
        periods: parsePeriods(row.periods || row.lessonIndexes || '', project, []),
        boundaryPeriods: numberList(row.boundaryPeriods || row.parameters?.boundaryPeriods || []),
        priority: normalizePriority(row.priority || row.strength, type),
        status: status === 'ready' ? 'effective' : status,
        sourceStatus: STATUS_LABELS.has(row.status) ? row.status : '',
        confidence: row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        description: asText(row.description || row.reason || row.note || '', 500),
        warnings: normalizedMessageValues(200, row.warnings),
        clarifications: normalizedMessageValues(500, row.clarifications, row.questions),
        understandingStatus: asText(row.understandingStatus || '', 40),
        executionStatus: asText(row.executionStatus || '', 40),
        reviewStatus: asText(row.reviewStatus || '', 40),
        support: asText(row.support || '', 20),
        landing: normalizedTextValues(80, row.landing),
        scope: row.scope && typeof row.scope === 'object' ? { ...row.scope } : {},
        relation: row.relation && typeof row.relation === 'object' ? { ...row.relation } : {},
        quantifier: normalizedRequirementQuantifier(row.quantifier, row.minOccurrences ?? row.parameters?.minOccurrences),
        scopeClassId: asText(row.scopeClassId || row.scope?.classIds?.[0] || row.parameters?.classIds?.[0] || '', 120),
        scopeClassName: asText(row.scopeClassName || '', 200),
        scopeTeacherId: asText(row.scopeTeacherId || row.scope?.teacherIds?.[0] || row.parameters?.teacherIds?.[0] || '', 120),
        scopeTeacherName: asText(row.scopeTeacherName || '', 200),
        scopeLabel: asText(row.scopeLabel || '', 400),
        parameters: row.parameters && typeof row.parameters === 'object' ? { ...row.parameters } : {},
        aiReviewStatus: asText(row.aiReviewStatus || '', 40),
        aiReviewIssueCode: asText(row.aiReviewIssueCode || '', 80),
        aiReviewValidationStatus: asText(row.aiReviewValidationStatus || '', 40),
        aiReviewBlocking: row.aiReviewBlocking === true,
        aiReviewValidationEvidence: normalizedMessageValues(500, row.aiReviewValidationEvidence),
        aiReviewWarnings: normalizedMessageValues(240, row.aiReviewWarnings),
        reviewEvidence: row.reviewEvidence && typeof row.reviewEvidence === 'object'
            ? {
                quote: asText(row.reviewEvidence.quote || row.reviewEvidence.text || '', 500),
                reason: asText(row.reviewEvidence.reason || row.reviewEvidence.message || '', 500),
                sourceSheet: asText(row.reviewEvidence.sourceSheet || '', 120),
                sourceRow: Number.parseInt(row.reviewEvidence.sourceRow, 10) || null,
            }
            : null,
        reviewedParseSource: asText(row.reviewedParseSource || '', 80),
        ambiguity: row.ambiguity || null,
        ambiguities: asList(row.ambiguities)
            .filter(item => item && typeof item === 'object')
            .map(item => ({ ...item })),
        weekPattern: asText(row.weekPattern || row.week || '', 60) || weekPatternFromText(rawText),
        weight: Number.parseInt(row.weight, 10) || undefined,
        limit: Number.parseInt(row.limit ?? row.value ?? row.max ?? row.count, 10) || undefined,
        minGapDays: Number.parseInt(row.minGapDays ?? row.gapDays ?? (type === 'course_interval' ? (row.limit ?? row.value) : undefined), 10) || undefined,
    };
}

function splitGroupedTargetText(value = '') {
    const text = asText(value, 600);
    if (!/[,，、;；|\r\n]/.test(text)) return [];
    return [...new Set(text
        .split(/\s*[,，、;；|\r\n]+\s*/)
        .map(item => asText(item, 160))
        .filter(Boolean))];
}

function expandGroupedEntityTarget(row = {}, index = 0, project = {}) {
    const type = normalizeConstraintType(row.type || row.ruleType);
    const targetType = targetTypeFor(type, row);
    if (!['teacher', 'class', 'subject'].includes(targetType)) return [row];

    const specificId = targetType === 'teacher'
        ? row.teacherId
        : targetType === 'class'
            ? row.classId
            : row.subjectId;
    if (row.targetId || specificId) return [row];

    const targetText = row.targetName
        || row.target
        || (targetType === 'teacher' ? row.teacherName || row.teacher : '')
        || (targetType === 'class' ? row.className || row.class : '')
        || (targetType === 'subject' ? row.subjectName || row.subject : '');
    const parts = splitGroupedTargetText(targetText);
    if (parts.length < 2) return [row];

    const hadGroupedAmbiguity = Boolean(row.ambiguity)
        || asList(row.ambiguities).length > 0
        || asList(row.warnings).some(warning => /多个候选|不会自动猜测/.test(String(warning || '')));
    const baseId = asText(row.id, 120) || `rule_draft_${index + 1}`;

    return parts.map((part, partIndex) => {
        const match = matchEntityCandidates(project, part, targetType);
        const exact = match.candidates.length === 1 && match.candidates[0].confidence >= 0.96
            ? match.candidates[0]
            : null;
        const next = {
            ...row,
            id: `${baseId}__${partIndex + 1}`,
            targetType,
            targetId: exact?.id || '',
            targetName: exact?.label || part,
            ambiguity: null,
            ambiguities: [],
            warnings: (row.warnings || []).filter(warning => !/多个候选|不会自动猜测/.test(String(warning || ''))),
            status: hadGroupedAmbiguity && row.status === 'needs_review' ? 'effective' : row.status,
        };

        if (targetType === 'teacher') {
            next.teacherId = exact?.id || '';
            next.teacherName = exact?.label || part;
        } else if (targetType === 'class') {
            next.classId = exact?.id || '';
            next.className = exact?.label || part;
        } else if (targetType === 'subject') {
            next.subjectId = exact?.id || '';
            next.subjectName = exact?.label || part;
        }
        return next;
    });
}

function validateTimeExpression(row = {}, project = {}) {
    const activeDays = new Set(getActiveWeekdays(project));
    const activePeriods = new Set(getActivePeriods(project));
    const invalidSlots = [];
    const slots = (row.slots || []).filter(slot => {
        const match = String(slot || '').match(/^(\d{1,2})-(\d{1,2})$/);
        if (!match) {
            invalidSlots.push(String(slot || ''));
            return false;
        }
        const day = Number.parseInt(match[1], 10);
        const period = Number.parseInt(match[2], 10);
        const valid = activeDays.has(day) && activePeriods.has(period);
        if (!valid) invalidSlots.push(slotKey(day, period));
        return true;
    });
    return {
        slots,
        invalidSlots,
        warnings: invalidSlots.length
            ? [`节次 ${invalidSlots.join('、')} 不在当前排课范围内。`]
            : [],
    };
}

function statusWithConfidence(row = {}, confidence = null) {
    if (row.status === 'ignored') return 'ignored';
    const value = row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence))
        ? Number(row.confidence)
        : confidence;
    if (Number.isFinite(value) && value < 0.85 && row.status === 'effective') return 'needs_review';
    return row.status === 'ready' ? 'effective' : row.status;
}

function rowNeedsSlots(type) {
    return ['teacher_unavailable', 'class_unavailable', 'locked_slot', 'global_unavailable', 'subject_preferred_periods', 'subject_avoid_periods'].includes(type);
}

function applySingleTarget(row, project, targetType) {
    const items = entityItemsForType(project, targetType);
    // 如果 targetId 已明确指向一个有效实体(如追问回填后),直接采用,无需模糊匹配
    if (row.targetId) {
        const directMatch = items.find(item => item.id === row.targetId);
        if (directMatch) {
            const label = directMatch.label || directMatch.name || row.targetName || row.targetId;
            const confidence = Math.max(
                row.confidence !== null && row.confidence !== undefined && Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.9,
                0.9,
            );
            return {
                ...row,
                targetType,
                targetId: directMatch.id,
                targetName: label,
                confidence,
                warnings: [...asList(row.warnings)],
                status: statusWithConfidence({ ...row, confidence }, confidence),
            };
        }
    }
    const match = matchEntityCandidates(project, row.targetName || row.targetId, targetType, { targetId: row.targetId });
    const warnings = [...asList(row.warnings)];
    const next = { ...row, targetType };

    if (match.candidates.length === 1 && (match.candidates[0].confidence || 0) >= 0.96) {
        const [candidate] = match.candidates;
        next.targetId = candidate.id;
        next.targetName = candidate.label;
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Math.min(Number(next.confidence), candidate.confidence || 1)
            : candidate.confidence || 0.9;
        return { ...next, warnings, status: statusWithConfidence(next, candidate.confidence || 0.9) };
    }

    if (match.candidates.length >= 1) {
        const ambiguity = {
            field: 'target',
            targetType,
            targetText: match.targetText || row.targetName || row.targetId || '',
            candidates: match.candidates,
        };
        warnings.push(match.candidates.length > 1
            ? `${ambiguity.targetText || '规则对象'} 存在多个候选，请确认后再生效。`
            : `${ambiguity.targetText || '规则对象'} 只有低置信候选，请确认后再生效。`);
        return {
            ...next,
            status: 'needs_review',
            confidence: Math.min(
                next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.7,
                match.confidence || 0.7,
            ),
            ambiguity,
            ambiguities: [...(next.ambiguities || []), ambiguity],
            warnings,
        };
    }

    warnings.push(`${row.targetName || row.targetId || '规则对象'} 在当前项目中没有匹配对象。`);
    return {
        ...next,
        status: 'needs_review',
        confidence: Math.min(
            next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.55,
            0.55,
        ),
        warnings,
    };
}

function matchLockedField(project, row, field, targetType, text, id = '') {
    const match = matchEntityCandidates(project, text || id, targetType, { targetId: id });
    if (match.candidates.length === 1) return { field, targetType, match: match.candidates[0] };
    return {
        field,
        targetType,
        targetText: match.targetText || text || id || '',
        candidates: match.candidates,
    };
}

function classifyDraftRow(row = {}, project = {}) {
    let next = { ...row, warnings: [...asList(row.warnings)] };
    const type = next.type;
    const time = validateTimeExpression(next, project);
    next = { ...next, slots: time.slots.length ? time.slots : next.slots, warnings: [...next.warnings, ...time.warnings] };

    if (next.status === 'ignored') return next;
    if (shouldNormalizeAllTeachersTarget(next, type)) {
        next = normalizeAllTeachersTargetRow(next);
    }
    if (!SUPPORTED_EFFECTIVE_TYPES.has(type)) {
        const status = SUGGESTION_ONLY_TYPES.has(type) ? 'suggestion' : 'unsupported';
        return {
            ...next,
            status,
            priority: normalizePriority(next.priority, type),
            warnings: status === 'unsupported'
                ? [...next.warnings, '当前版本只能预览这类建议，暂不会写入排课规则。']
                : next.warnings,
        };
    }
    if (next.status === 'suggestion') {
        next.status = 'effective';
    }

    if (time.invalidSlots.length) {
        next.status = 'invalid';
    }
    if (rowNeedsSlots(type) && !(next.slots || []).length) {
        next.status = 'needs_review';
        next.warnings.push('缺少明确节次，请补充后再生效。');
    }

    if (type === 'locked_slot') {
        const fields = [
            matchLockedField(project, next, 'teacher', 'teacher', next.teacherName || '', next.teacherId || ''),
            matchLockedField(project, next, 'class', 'class', next.className || next.targetName || '', next.classId || ''),
            matchLockedField(project, next, 'subject', 'subject', next.subjectName || '', next.subjectId || ''),
        ];
        const ambiguities = fields.filter(item => item.candidates && item.candidates.length !== 1);
        const matched = Object.fromEntries(fields.filter(item => item.match).map(item => [item.field, item.match]));

        if (ambiguities.length) {
            ambiguities.forEach(item => {
                next.warnings.push(`${item.targetText || item.field} ${item.candidates.length ? '存在多个候选' : '没有匹配对象'}，请确认。`);
            });
            return {
                ...next,
                targetType: 'locked_slot',
                status: 'needs_review',
                confidence: Math.min(
                    next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.65,
                    0.75,
                ),
                ambiguities,
                ambiguity: ambiguities[0] || null,
            };
        }

        next.teacherId = matched.teacher.id;
        next.teacherName = matched.teacher.label;
        next.classId = matched.class.id;
        next.className = matched.class.label;
        next.subjectId = matched.subject.id;
        next.subjectName = matched.subject.label;
        next.targetType = 'locked_slot';
        next.targetId = `${next.classId}:${next.subjectId}:${next.teacherId}`;
        next.targetName = `${next.className} / ${next.subjectName} / ${next.teacherName}`;
        next.priority = 'hard';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence)) ? Number(next.confidence) : 0.9;
        next.status = statusWithConfidence(next, 0.9);
        return next;
    }

    if ((type === 'teacher_daily_limit' || type === 'teacher_consecutive_limit' || type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week') && isAllTeachersTarget(next)) {
        next.targetType = 'all_teachers';
        next.targetId = '__all_teachers';
        next.targetName = '全部教师';
        next.priority = type === 'teacher_weekly_limit' || type === 'teacher_max_days_per_week' ? 'hard' : 'soft';
        next.confidence = next.confidence !== null && next.confidence !== undefined && Number.isFinite(Number(next.confidence))
            ? Number(next.confidence)
            : 0.9;
        next.status = statusWithConfidence(next, next.confidence);
    }

    const targetType = targetTypeFor(type, next);
    if (['teacher', 'class', 'subject'].includes(targetType)) {
        next = applySingleTarget(next, project, targetType);
    }

    if (['teacher_daily_limit', 'teacher_consecutive_limit', 'teacher_weekly_limit', 'teacher_max_days_per_week', 'subject_daily_limit'].includes(type)
        && (!Number.isInteger(Number(next.limit)) || Number(next.limit) <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的节数上限。');
    }
    if (type === 'course_interval' && (!Number.isInteger(Number(next.minGapDays)) || Number(next.minGapDays) <= 0)) {
        next.status = 'needs_review';
        next.warnings.push('缺少有效的间隔天数。');
    }
    if (type === 'room_requirement') {
        if (!(project.rooms || []).length) {
            next.status = 'needs_review';
            next.warnings.push('项目还没录入教室，先去基础数据添加教室后才能应用教室要求。');
        }
        if (!((next.roomIds || []).length || (next.requiredTags || []).length || next.roomName)) {
            next.status = 'needs_review';
            next.warnings.push('缺少教室、场地或教室标签。');
        }
    }
    if (type === 'teacher_mutual_exclusion' && normalizedTextValues(120, next.teacherIds).length < 2) {
        next.status = 'needs_review';
        next.warnings.push('教师互斥至少需要两位教师。');
    }
    if (type === 'subject_not_same_day' && normalizedTextValues(120, next.subjectIds).length < 2) {
        next.status = 'needs_review';
        next.warnings.push('课程不同天至少需要两门课程。');
    }
    if (type === 'subject_sequence' && !(next.beforeSubjectId && next.afterSubjectId)) {
        next.status = 'needs_review';
        next.warnings.push('课程顺序需要明确先上和后上的课程。');
    }

    if (next.confidence === null || next.confidence === undefined || !Number.isFinite(Number(next.confidence))) {
        next.confidence = next.status === 'effective' ? 0.9 : next.status === 'needs_review' ? 0.65 : 0.5;
    }
    next.status = statusWithConfidence(next, Number(next.confidence));
    if (next.weekPattern) {
        if (complexModelIsEnabled(project)) {
            next.status = next.status === 'invalid' ? 'invalid' : 'effective';
            next.confidence = Math.max(Number(next.confidence) || 0.9, 0.9);
        } else {
            next.status = 'needs_review';
            if (!next.warnings.some(warning => /单双周|不会自动生效/.test(warning))) {
                next.warnings.push('当前规则模型暂不支持单双周，不会自动生效。');
            }
            next.confidence = Math.min(Number(next.confidence) || 0.65, 0.68);
        }
    }
    return next;
}

function previewFromRow(row = {}) {
    return {
        id: row.id,
        stableKey: row.stableKey || '',
        parseSource: row.parseSource || row.source || '',
        type: row.type,
        targetId: row.targetId || '',
        targetName: row.targetName || '',
        slots: row.slots || [],
        priority: row.priority || 'hard',
        description: row.description || row.rawText || '',
        status: row.status === 'effective' ? 'ready' : row.status,
        effective: row.status === 'effective',
        confidence: row.confidence,
    };
}

function emptyRulesFrom(project) {
    const rules = cloneValue(project.rules);
    rules.advancedRules = [...(rules.advancedRules || [])];
    rules.hardRules = rules.hardRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
    rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
    rules.hardRules.globalUnavailable = [...(rules.hardRules.globalUnavailable || [])];
    rules.hardRules.subjectDailyLimit = { ...(rules.hardRules.subjectDailyLimit || {}) };
    rules.hardRules.teacherWeeklyLimit = { ...(rules.hardRules.teacherWeeklyLimit || {}) };
    rules.hardRules.teacherMaxDaysPerWeek = { ...(rules.hardRules.teacherMaxDaysPerWeek || {}) };
    rules.hardRules.teacherMutualExclusion = [...(rules.hardRules.teacherMutualExclusion || [])];
    rules.hardRules.subjectNotSameDay = [...(rules.hardRules.subjectNotSameDay || [])];
    rules.hardRules.roomRequirements = { ...(rules.hardRules.roomRequirements || {}) };
    rules.softRules = rules.softRules || {};
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];
    rules.softRules.afternoonSubjects = [...(rules.softRules.afternoonSubjects || [])];
    rules.softRules.subjectPreferredPeriods = { ...(rules.softRules.subjectPreferredPeriods || {}) };
    rules.softRules.teacherLimits = { ...(rules.softRules.teacherLimits || {}) };
    rules.softRules.spreadSubjects = [...(rules.softRules.spreadSubjects || [])];
    rules.softRules.spreadSubjectGaps = { ...(rules.softRules.spreadSubjectGaps || {}) };
    rules.softRules.subjectDailySoftLimit = { ...(rules.softRules.subjectDailySoftLimit || {}) };
    rules.softRules.subjectSequence = [...(rules.softRules.subjectSequence || [])];
    rules.softRules.teacherGapWeight = Number.parseInt(rules.softRules.teacherGapWeight, 10) || 0;
    rules.softRules.classDailyBalance = { ...(rules.softRules.classDailyBalance || {}) };
    rules.softRules.teacherLoadBalance = { ...(rules.softRules.teacherLoadBalance || {}) };
    return rules;
}

function previewRows(rows = []) {
    return rows.map(previewFromRow);
}

function sourceFromRow(row = {}) {
    return {
        rawText: row.rawText || row.description || '',
        source: row.source || '',
        sourceId: row.sourceId || '',
        textHash: row.textHash || '',
        origin: row.origin || 'unknown',
        parsedBy: row.parsedBy || [],
        sourceSheet: row.sourceSheet || '',
        sourceRow: row.sourceRow || null,
        lineNumber: row.lineNumber || null,
        parseSource: row.parseSource || row.source || '',
        stableKey: row.stableKey || '',
    };
}

function buildRequirementSemantics(project = {}, rows = [], {
    originalText = '',
    semanticRequirements = [],
    sourceRequirements = [],
} = {}) {
    const sources = asList(sourceRequirements).filter(item => item && typeof item === 'object');
    const systemText = asText(originalText, 100000)
        || sources.map(item => item.source?.rawText || item.rawText || '').filter(Boolean).join('\\n');
    const systemRequirements = systemRequirementsFromText(systemText);
    const generatedTextRequirements = sources.length
        ? sources.flatMap(sourceRequirement => {
            const sourceText = sourceRequirement.source?.rawText || sourceRequirement.rawText || '';
            const generated = sourceRequirement.semanticAuthoritative === true ? [] : [
                ...blockPreferenceRequirementsFromText(project, sourceText),
                ...optimizationRequirementsFromText(project, sourceText),
                ...complexRequirementsFromText(project, sourceText),
                ...(sourceNeedsSemanticPlanning({ rawText: sourceText })
                    ? preciseSemanticRequirementsFromText(project, sourceText)
                    : []),
            ];
            return generated.map(requirement => requirementWithSourceProvenance(requirement, sourceRequirement, sources.length > 1));
        })
        : [
            ...blockPreferenceRequirementsFromText(project, originalText),
            ...optimizationRequirementsFromText(project, originalText),
            ...complexRequirementsFromText(project, originalText),
            ...(sourceNeedsSemanticPlanning({ rawText: originalText })
                ? preciseSemanticRequirementsFromText(project, originalText)
                : []),
        ];
    const externalRequirements = externalRequirementItems(semanticRequirements);
    const externalIds = new Set(externalRequirements
        .flatMap(item => [item.id, item.requirementId, item.clauseId, item.constraintId])
        .filter(Boolean));
    const scopedRows = scopeParsedCoursePreferenceRows(project, rows);
    const textRequirements = generatedTextRequirements.filter(requirement => !scopedRows.some(
        row => scopedRowSupersedesGeneratedRequirement(row, requirement, project),
    ));
    const rowRequirements = scopedRows.filter(row => row && typeof row === 'object')
        .filter(row => !row.requirementId || !externalIds.has(row.requirementId))
        .filter(row => {
            const supersedingRequirements = [...externalRequirements, ...textRequirements]
                .filter(requirement => generatedTextRequirementSupersedesRow(requirement, row, project));
            return supersedingRequirements.length !== 1;
        })
        .map((row, index) => requirementFromRow(row, index, project));
    const requirementItems = resolveSemanticRequirementRelations(scopeParsedCoursePreferenceRequirements(project, dedupeRequirements([
        ...externalRequirements,
        ...systemRequirements,
        ...textRequirements,
        ...rowRequirements,
    ]).map(item => (item.status === 'needs_review' ? applyClarificationPolicy(project, item) : item))));
    const semanticActions = requirementItems
        .map((requirement, index) => actionForRequirement(project, requirement, index))
        .filter(Boolean);
    return { requirementItems, semanticActions, rows: scopedRows };
}

function parseConstraintsWithLocalFallback({ project, text, inputType, contextStats = null, constraintRows = [], sourceRequirements = [], error = null }) {
    const localSource = localParseSourceForInput(inputType);
    const constraints = localTextConstraintsFromInput(project, text, constraintRows, {
        preferStructuredRows: inputType === 'xlsx_constraints',
        sourceRequirements,
    });
    if (!constraints.length) {
        const semanticOnly = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [],
            source: localSource,
            inputType,
            contextStats,
            originalText: text,
            sourceRequirements,
            initialWarnings: error ? [`智能解析不可用，已仅提取明确需求：${error.reason || error.message}`] : [],
        });
        if ((semanticOnly.requirementItems || []).length) return semanticOnly;
        if (error) throw error;
        throw new TimetableRuleParseError('需要配置智能解析服务才能解析这类约束。', 'ai_not_configured', 503);
    }
    return normalizeTimetableRuleDraftRows({
        project,
        draftRows: rowsFromAiConstraints(constraints, { source: localSource }).rows,
        source: localSource,
        inputType,
        contextStats,
        originalText: text,
        sourceRequirements,
        initialWarnings: error ? [`智能解析不可用，已仅提取明确规则：${error.reason || error.message}`] : [],
    });
}

function hasConfiguredAi(env = {}) {
    return Boolean(String(env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '').trim());
}

function shouldUseLocalFirst(inputType = '') {
    return ['text', 'txt', 'csv_text', 'xlsx_constraints'].includes(inputType);
}

function shouldUseAiExtraction(inputType = '', env = {}) {
    if (!['text', 'txt', 'csv_text', 'xlsx_constraints'].includes(inputType)) return false;
    return resolveSemanticAiMode(env) !== 'off';
}

async function parseAiOrLocal({ project, text, inputType, contextStats = null, constraintRows = [], fileName = '', env, fetchImpl }) {
    const preparedSources = prepareSourceInputs({ text, inputType, constraintRows, fileName, origin: 'user_input' });
    const sourceRequirements = preparedSources.sourceRequirements;
    constraintRows = preparedSources.sourceRows;
    const aiExtractWarnings = [];
    const semanticAiMode = resolveSemanticAiMode(env);
    const aiExtractionEnabled = shouldUseAiExtraction(inputType, env);
    let routedLocalConstraints = null;
    let routedLocalConversion = null;
    let routedLocalBaselineResult = null;
    if (aiExtractionEnabled && semanticAiMode === 'targeted') {
        routedLocalConstraints = localTextConstraintsFromInput(project, text, constraintRows, {
            preferStructuredRows: inputType === 'xlsx_constraints',
        });
        routedLocalConversion = rowsFromAiConstraints(routedLocalConstraints, {
            source: localParseSourceForInput(inputType),
            project,
        });
        routedLocalBaselineResult = normalizeTimetableRuleDraftRows({
            project,
            draftRows: routedLocalConversion.rows,
            source: localParseSourceForInput(inputType),
            inputType,
            contextStats,
            originalText: text,
            sourceRequirements,
        });
    }
    const routedSourceById = new Map(asList(routedLocalBaselineResult?.sourceRequirements)
        .map(source => [source.sourceId, source]));
    const semanticTargetSources = semanticAiMode === 'all'
        ? sourceRequirements
        : sourceRequirements.filter(source => {
            const localSource = routedSourceById.get(source.sourceId);
            return sourceNeedsSemanticPlanning({
                rawText: source.source?.rawText || source.rawText || '',
                understandingStatus: localSource?.understandingStatus || 'unrecognized',
                executionStatus: localSource?.executionStatus || 'unsupported_by_solver',
            });
        });
    const semanticTargetSourceIds = semanticTargetSources.map(source => source.sourceId);
    if (aiExtractionEnabled && semanticTargetSources.length) {
        try {
            const localConstraints = routedLocalConstraints || localTextConstraintsFromInput(project, text, constraintRows, {
                preferStructuredRows: inputType === 'xlsx_constraints',
            });
            const localConversion = routedLocalConversion || rowsFromAiConstraints(localConstraints, {
                source: localParseSourceForInput(inputType),
                project,
            });
            const localBaselineResult = routedLocalBaselineResult || normalizeTimetableRuleDraftRows({
                project,
                draftRows: localConversion.rows,
                source: localParseSourceForInput(inputType),
                inputType,
                contextStats,
                originalText: text,
                sourceRequirements,
            });
            const extracted = await extractRequirementsWithAI({
                project,
                text: semanticTargetSources.map(source => source.source?.rawText || '').filter(Boolean).join('\n'),
                contextStats,
                sourceRequirements: semanticTargetSources,
                env,
                fetchImpl,
            });
            const enrichedSourceRequirements = mergeSourceSemanticRationales(sourceRequirements, extracted.sourceRationales);
            const reviewSourceIds = targetedReviewSourceIds(
                semanticTargetSources,
                extracted.draftRows,
                localConversion.rows,
            );
            const normalized = normalizeTimetableRuleDraftRows({
                project,
                draftRows: mergeAiFirstCandidateRows(extracted.draftRows, localConversion.rows),
                source: 'ai_extract',
                inputType,
                contextStats: {
                    ...(contextStats || {}),
                    aiExtractModel: extracted.model || '',
                    aiExtractPromptVersion: extracted.promptVersion || '',
                    aiExtractRequirementCount: extracted.rawRequirements?.length || 0,
                },
                originalText: text,
                semanticRequirements: extracted.semanticRequirements,
                sourceRequirements: enrichedSourceRequirements,
                initialWarnings: [...asList(extracted.warningItems), ...asList(extracted.warnings)],
                rejected: extracted.rejected || [],
            });
            const aiFirstResult = withSemanticAssistance({
                ...normalized,
                parseSource: 'ai_extract',
                aiAssistance: {
                    mode: 'ai_first',
                    acceptedCount: normalized.constraintIRs?.filter(item => item.executionStatus === 'executable').length || 0,
                    correctedCount: 0,
                    advisoryCount: 0,
                    blockingCount: normalized.sourceRequirements?.filter(item => item.requiresHumanReview).length || 0,
                },
                aiReview: aiReviewStatusPayload({
                    status: 'skipped',
                    reason: 'ai_extract',
                    model: extracted.model || '',
                    warnings: [],
                }),
            }, {
                mode: semanticAiMode,
                sourceIds: semanticTargetSourceIds,
                status: 'completed',
                model: extracted.model || '',
            });
            const formalBaselineResult = withSemanticAssistance({
                ...localBaselineResult,
                sourceRequirements: mergeSourceSemanticRationales(localBaselineResult.sourceRequirements, extracted.sourceRationales),
                parseSource: 'ai_extract',
                aiAssistance: {
                    mode: 'ai_first',
                    acceptedCount: aiLocalAgreementCount(extracted.draftRows, localConversion.rows),
                    correctedCount: 0,
                    advisoryCount: 0,
                    blockingCount: 0,
                },
                aiReview: aiReviewStatusPayload({
                    status: 'skipped',
                    reason: 'ai_local_agreement',
                    model: extracted.model || '',
                    warnings: [],
                }),
            }, {
                mode: semanticAiMode,
                sourceIds: semanticTargetSourceIds,
                status: 'completed',
                model: extracted.model || '',
            });
            if (reviewSourceIds.length) {
                const reviewed = await reviewTimetableParseResult({
                    project,
                    text,
                    inputType,
                    contextStats: {
                        ...(contextStats || {}),
                        targetedReviewSourceIds: reviewSourceIds,
                        targetedReviewReason: 'ai_local_disagreement_or_missing_candidate',
                    },
                    constraintRows,
                    result: formalBaselineResult,
                    diagnosticResult: aiFirstResult,
                    applicationResult: formalBaselineResult,
                    env,
                    fetchImpl,
                });
                if (reviewed.aiReview?.status !== 'reviewed') {
                    return withAiReviewUnavailable(
                        localBaselineResult,
                        reviewed.aiReview?.reason || 'ai_review_failed',
                        reviewed.aiReview?.warnings?.[0] || '定向 AI 复审未完成，已丢弃未验证候选并返回本地识别结果。',
                    );
                }
                return withValidatedAiFirstResult({
                    result: reviewed,
                    diagnosticResult: aiFirstResult,
                    localBaselineResult,
                    targetedSourceIds: reviewSourceIds,
                });
            }
            return withValidatedAiFirstResult({
                result: formalBaselineResult,
                diagnosticResult: aiFirstResult,
                localBaselineResult,
                targetedSourceIds: [],
            });
        } catch (error) {
            const reason = error?.reason || 'ai_extract_failed';
            const message = error?.message || reason;
            aiExtractWarnings.push(`AI-first 抽取失败，已降级到本地识别：${message}`);
        }
    }
    let localConstraints = [];
    let localResult = null;
    if (shouldUseLocalFirst(inputType)) {
        const localSource = localParseSourceForInput(inputType);
        localConstraints = localTextConstraintsFromInput(project, text, constraintRows, {
            preferStructuredRows: inputType === 'xlsx_constraints',
        });
        if (localConstraints.length) {
            localResult = normalizeTimetableRuleDraftRows({
                project,
                draftRows: rowsFromAiConstraints(localConstraints, { source: localSource }).rows,
                source: localSource,
                inputType,
                contextStats,
                originalText: text,
                sourceRequirements,
                initialWarnings: [...aiExtractWarnings, ...(hasConfiguredAi(env) ? [] : ['智能解析不可用，已仅提取明确规则：ai_not_configured'])],
            });
            if (aiExtractWarnings.length) {
                return withSemanticAssistance(
                    withAiReviewUnavailable(localResult, 'ai_extract_failed', aiExtractWarnings[0]),
                    {
                        mode: semanticAiMode,
                        sourceIds: semanticTargetSourceIds,
                        status: 'degraded',
                        reason: 'ai_extract_failed',
                    },
                );
            }
            if (semanticAiMode === 'targeted' && !semanticTargetSources.length) {
                return withSemanticAssistance(localResult, {
                    mode: semanticAiMode,
                    sourceIds: [],
                    status: 'skipped',
                    reason: 'simple_sources',
                });
            }
            if (!hasConfiguredAi(env)) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
            }
            if (localResultCanSkipAi(text, localResult, inputType, constraintRows)) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
            }
        } else if (!hasConfiguredAi(env)) {
            const semanticOnly = normalizeTimetableRuleDraftRows({
                project,
                draftRows: [],
                source: localSource,
                inputType,
                contextStats,
                originalText: text,
                sourceRequirements,
                initialWarnings: [...aiExtractWarnings, '智能解析不可用，已仅提取明确需求：ai_not_configured'],
            });
            if ((semanticOnly.requirementItems || []).length) {
                return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: semanticOnly, env, fetchImpl });
            }
        }
    }
    try {
        const aiConstraintRows = inputType === 'xlsx_constraints' && localResult
            ? unresolvedConstraintRowsForAi(constraintRows, localResult)
            : constraintRows;
        if (inputType === 'xlsx_constraints' && localResult && !aiConstraintRows.length) {
            return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: localResult, env, fetchImpl });
        }
        const aiText = inputType === 'xlsx_constraints'
            ? textFromConstraintRows(aiConstraintRows) || text
            : text;
        const parsed = await callAi({
            project,
            text: aiText,
            inputType,
            contextStats,
            constraintRows: aiConstraintRows,
            env,
            fetchImpl,
        });
        const constraints = aiDraftRowsFromParsed(parsed);
        const aiSource = inputType === 'xlsx_constraints' ? 'ai_supplement' : 'ai';
        const localSource = localParseSourceForInput(inputType);
        const warnings = [
            ...warningMessagesFromAi(parsed.warnings),
            ...warningMessagesFromAi(parsed.missingInfo),
            ...warningMessagesFromAi(parsed.conflicts),
        ];
        const aiRequirements = alignAiArtifactsToSources(
            parsed.requirementItems || [],
            sourceRequirements,
            {
                artifactKind: 'requirement',
                parsedBy: 'ai',
                allowLegacyEvidence: true,
            }
        );
        const localConversion = rowsFromAiConstraints(localConstraints, {
            source: localSource,
            project,
        });
        const aiConversion = rowsFromAiConstraints(constraints, {
            source: aiSource,
            sourceRequirements,
            semanticRequirements: aiRequirements.artifacts,
            project,
        });
        const normalized = normalizeTimetableRuleDraftRows({
            project,
            draftRows: [
                ...(inputType === 'xlsx_constraints' && localConstraints.length
                    ? localConversion.rows
                    : []),
                ...aiConversion.rows,
            ],
            source: inputType === 'xlsx_constraints' && localConstraints.length ? 'mixed_xlsx' : aiSource,
            inputType,
            contextStats,
            originalText: text,
            semanticRequirements: aiRequirements.artifacts,
            sourceRequirements,
            initialWarnings: [
                ...aiExtractWarnings,
                ...warnings,
                ...aiConversion.warningItems,
                ...aiRequirements.warnings,
            ],
            rejected: [
                ...aiConversion.rejected,
                ...aiRequirements.rejected,
            ],
        });
        return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: normalized, env, fetchImpl });
    } catch (error) {
        if (error instanceof TimetableRuleParseError && ['ai_not_configured', 'missing_fetch'].includes(error.reason)) {
            const fallback = parseConstraintsWithLocalFallback({ project, text, inputType, contextStats, constraintRows, sourceRequirements, error });
            return reviewTimetableParseResult({ project, text, inputType, contextStats, constraintRows, result: fallback, env, fetchImpl });
        }
        throw error;
    }
}

async function parseRosterWorkbookRules({ file, project, env, fetchImpl }) {
    const preview = previewTimetableRosterFile(file, { project });
    const contextStats = rosterContext(preview);
    const rosterProject = projectWithRosterPreview(project, preview);
    void env;
    void fetchImpl;
    return normalizeRosterFallback({
        project: rosterProject,
        preview,
        contextStats,
    });
}

async function parseConstraintWorkbookRules({ classified, file, project, env, fetchImpl }) {
    const extracted = constraintsTextFromSheet(classified);
    const contextStats = {
        rowCount: extracted.rows.length,
        sheetName: classified.sheet.name,
    };
    return parseAiOrLocal({
        project,
        text: extracted.text,
        inputType: 'xlsx_constraints',
        contextStats,
        constraintRows: extracted.rows,
        fileName: file?.filename || '',
        env,
        fetchImpl,
    });
}

function uploadText(file = {}) {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length <= 0) {
        throw new TimetableRuleParseError('上传的约束文件为空。', 'empty_file', 400);
    }
    if (file.buffer.length > MAX_RULE_FILE_BYTES) {
        throw new TimetableRuleParseError('约束文件不能超过 5MB。', 'file_too_large', 413);
    }
    return file.buffer.toString('utf8');
}

function requirementMatchesCompiledRow(requirement = {}, row = {}) {
    if (!requirement || requirement.origin === 'system_supplement') return false;
    if (artifactSourceIdentityConflicts(requirement, row)) return false;
    const ids = [requirement.id, requirement.requirementId, requirement.clauseId].filter(Boolean);
    if (row.requirementId && ids.includes(row.requirementId)) return true;
    if (row.clauseId && ids.includes(row.clauseId)) return true;
    return Boolean(requirement.rowId && requirement.rowId === row.id);
}

function requirementForCompiledRow(requirements = [], row = {}) {
    const matches = requirements.filter(requirement => requirementMatchesCompiledRow(requirement, row));
    return matches.length === 1 ? matches[0] : null;
}

function mergeConstraintIR(left = {}, right = {}) {
    const preferred = left.parameters?.legacyRow ? left : right.parameters?.legacyRow ? right : left;
    const aggregate = aggregateConstraintIRStatuses([left, right]);
    return normalizeConstraintIR({
        ...preferred,
        ...aggregate,
        parameters: {
            ...(left.parameters || {}),
            ...(right.parameters || {}),
            ...(preferred.parameters || {}),
            legacyRow: preferred.parameters?.legacyRow
                || left.parameters?.legacyRow
                || right.parameters?.legacyRow,
        },
        warnings: uniqueConstraintMessages([...asList(left.warnings), ...asList(right.warnings)]),
        clarifications: uniqueConstraintMessages([...asList(left.clarifications), ...asList(right.clarifications)]),
        machineRuleIds: ['executable', 'partially_executable'].includes(aggregate.executionStatus)
            ? uniqueConstraintMessages([...asList(left.machineRuleIds), ...asList(right.machineRuleIds)])
            : [],
        parsedBy: normalizedParsedBy(left.parsedBy || [], right.parsedBy || []),
        legacyClause: preferred.legacyClause || left.legacyClause || right.legacyClause || null,
    });
}

function compactCapabilityIRs(irs = [], rows = []) {
    const removedClauseIds = new Set();
    const clauseIdRemap = new Map();
    const semanticallyUnique = [];
    const semanticIndexes = new Map();
    const semanticKey = ir => {
        const { legacyRow, selectorCurrentlyUnmatched, ...parameters } = ir.parameters || {};
        void legacyRow;
        void selectorCurrentlyUnmatched;
        const time = { ...(ir.time || {}) };
        if (asList(time.slots).length) {
            delete time.days;
            delete time.periods;
        }
        delete parameters.slots;
        delete parameters.days;
        delete parameters.periods;
        delete parameters.weekPattern;
        if ([
            'subject.preferred_day_part',
            'subject.preferred_periods',
            'subject.avoid_periods',
            'subject.spread',
        ].includes(ir.capabilityId)) {
            delete parameters.classIds;
            delete parameters.teacherIds;
            delete parameters.gradeNames;
        }
        return stableJson({
            sourceId: ir.sourceId,
            capabilityId: ir.capabilityId,
            target: ir.target,
            scope: ir.scope,
            time,
            relation: ir.relation,
            parameters,
            strength: ir.strength,
        });
    };
    for (const ir of irs) {
        const key = semanticKey(ir);
        const existingIndex = semanticIndexes.get(key);
        if (existingIndex === undefined) {
            semanticIndexes.set(key, semanticallyUnique.length);
            semanticallyUnique.push(ir);
            continue;
        }
        const existing = semanticallyUnique[existingIndex];
        removedClauseIds.add(ir.clauseId);
        clauseIdRemap.set(ir.clauseId, existing.clauseId);
        const merged = mergeConstraintIR(existing, ir);
        semanticallyUnique[existingIndex] = normalizeConstraintIR({
            ...merged,
            constraintId: existing.constraintId,
            clauseId: existing.clauseId,
            machineRuleIds: merged.machineRuleIds,
            aiReviewStatus: ir.aiReviewStatus || existing.aiReviewStatus || '',
            aiReviewIssueCode: ir.aiReviewIssueCode || existing.aiReviewIssueCode || '',
            aiReviewValidationStatus: ir.aiReviewValidationStatus || existing.aiReviewValidationStatus || '',
            aiReviewBlocking: ir.aiReviewBlocking === true || existing.aiReviewBlocking === true,
            aiReviewValidationEvidence: uniqueConstraintMessages([
                ...asList(existing.aiReviewValidationEvidence),
                ...asList(ir.aiReviewValidationEvidence),
            ]),
            aiReviewWarnings: uniqueConstraintMessages([
                ...asList(existing.aiReviewWarnings),
                ...asList(ir.aiReviewWarnings),
            ]),
        });
    }
    const resolvedSemanticIRs = semanticallyUnique.map(ir => {
        let parentClauseId = ir.relation?.parentClauseId || '';
        const visited = new Set();
        while (parentClauseId && clauseIdRemap.has(parentClauseId) && !visited.has(parentClauseId)) {
            visited.add(parentClauseId);
            parentClauseId = clauseIdRemap.get(parentClauseId);
        }
        if (!parentClauseId || parentClauseId === ir.relation?.parentClauseId) return ir;
        return normalizeConstraintIR({
            ...ir,
            relation: {
                ...(ir.relation || {}),
                parentClauseId,
            },
        });
    });
    const kept = [];
    const sourcesWithSpecializedRoomRules = new Set(resolvedSemanticIRs
        .filter(ir => ['room.preferred', 'room.forbidden_type'].includes(ir.capabilityId))
        .map(ir => ir.sourceId));
    const specificity = ir => {
        const parameters = ir.parameters || {};
        return [
            ...(parameters.roomIds || []),
            ...(parameters.roomRequirement?.roomIds || []),
            ...(parameters.activityTypes || []),
            ...(parameters.teacherNames || []),
            ...(parameters.requiredTags || []),
        ].length;
    };
    for (const ir of resolvedSemanticIRs) {
        if (
            ir.capabilityId === 'room.required'
            && sourcesWithSpecializedRoomRules.has(ir.sourceId)
            && !(ir.parameters?.roomIds || []).length
            && !(ir.parameters?.roomRequirement?.roomIds || []).length
            && !(ir.parameters?.activityTypes || []).length
        ) {
            removedClauseIds.add(ir.clauseId);
            continue;
        }
        if (ir.capabilityId !== 'room.required') {
            kept.push(ir);
            continue;
        }
        const duplicateIndex = kept.findIndex(existing => (
            existing.capabilityId === ir.capabilityId
            && existing.sourceId === ir.sourceId
            && existing.target?.kind === ir.target?.kind
            && existing.target?.name === ir.target?.name
        ));
        if (duplicateIndex < 0) {
            kept.push(ir);
            continue;
        }
        const existing = kept[duplicateIndex];
        if (specificity(ir) > specificity(existing)) {
            removedClauseIds.add(existing.clauseId);
            kept[duplicateIndex] = ir;
        } else {
            removedClauseIds.add(ir.clauseId);
        }
    }
    return {
        constraintIRs: kept,
        rows: rows.filter(row => !removedClauseIds.has(row.clauseId)),
    };
}

function warningsForConstraintExecution(warnings = [], ir = {}) {
    const values = asList(warnings);
    if (ir.executionStatus !== 'executable' || ir.support !== 'full') return values;
    return values.filter(warning => (
        !OBSOLETE_EXECUTABLE_WARNING_PATTERNS.some(pattern => pattern.test(String(warning || '')))
    ));
}

function usableSemanticObject(object = null) {
    if (!object || typeof object !== 'object') return false;
    const name = asText(object.name || object.label || '', 120).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return Boolean(name && !INTERNAL_OBJECT_NAMES.has(name));
}

export {
    AI_CANDIDATE_VALIDATION_VERSION,
    AI_REVIEW_PROMPT_VERSION,
    CAPABILITY_VERSION,
    CHINESE_NUMBER_TO_VALUE,
    DAY_NAME_TO_NUMBER,
    DEFAULT_AI_REVIEW_TIMEOUT_MS,
    ENGLISH_DAY_NAME_TO_NUMBER,
    MAX_PARSE_CACHE_ITEMS,
    MAX_RULE_FILE_BYTES,
    NUMBER_TOKEN_PATTERN,
    PARSER_VERSION,
    PARSE_CACHE,
    STATUS_LABELS,
    SUGGESTION_ONLY_TYPES,
    SUPPORTED_EFFECTIVE_TYPES,
    SYSTEM_CLASS_TIME_CONFLICT_PATTERN,
    SYSTEM_LESSON_HOURS_COMPLETENESS_PATTERN,
    SYSTEM_TEACHER_TIME_CONFLICT_PATTERN,
    TIMETABLE_CAPABILITY_REGISTRY,
    addAfternoonSubject,
    addCourseInterval,
    addGlobalUnavailable,
    addLockedSlot,
    addMorningSubject,
    addRoomRequirement,
    addSlots,
    addSpreadSubject,
    addSubjectDailyLimit,
    addSubjectNotSameDay,
    addSubjectPeriodPreference,
    addSubjectSequence,
    addTeacherLimit,
    addTeacherMaxDaysPerWeek,
    addTeacherMutualExclusion,
    addTeacherWeeklyLimit,
    applyComplexModelPatch,
    buildRequirementSemantics,
    classifyDraftRow,
    compactCapabilityIRs,
    emptyRulesFrom,
    expandGroupedEntityTarget,
    findLockedLessonPlan,
    hasConfiguredAi,
    mergeConstraintIR,
    normalizeDraftRow,
    normalizedRequirementQuantifier,
    parseAiOrLocal,
    parseConstraintWorkbookRules,
    parseFirstSlot,
    parseRosterWorkbookRules,
    previewFromRow,
    previewRows,
    requirementForCompiledRow,
    resolveEntityList,
    rowNeedsSlots,
    setClassDailyBalance,
    setTeacherGapWeight,
    setTeacherLoadBalance,
    shouldUseAiExtraction,
    sourceFromRow,
    uploadText,
    usableSemanticObject,
    warningsForConstraintExecution,
};
