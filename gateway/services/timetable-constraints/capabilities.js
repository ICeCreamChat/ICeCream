import {
    compileRequirementToRows,
} from '../timetable-intent-compiler.js';
import {
    buildClauseId,
} from './source-identity.js';
import {
    compileConstraintIR,
    createConstraintCapabilityRegistry,
    explainConstraintIR,
    registerConstraintCapability,
    resolveConstraintCapability,
} from './capability-registry.js';
import {
    normalizeConstraintIR,
} from './constraint-ir.js';

function text(value = '', max = 1000) {
    return String(value ?? '').trim().slice(0, max);
}

function key(value = '') {
    return text(value, 160)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return [value];
}

function unique(values = [], max = 300) {
    return [...new Set(asArray(values).map(value => text(value, max)).filter(Boolean))];
}

function compactObject(value = {}) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => {
        if (item === undefined || item === null || item === '') return false;
        if (Array.isArray(item)) return item.length > 0;
        return true;
    }));
}

function legacyRowOf(ir = {}) {
    const row = ir.parameters?.legacyRow;
    return row && typeof row === 'object' ? { ...row } : {};
}

function compileLegacyArtifact(ir = {}) {
    const row = legacyRowOf(ir);
    if (!Object.keys(row).length) return { rows: [] };
    return {
        rows: [{
            ...row,
            status: row.status || (ir.executionStatus === 'executable' ? 'effective' : 'suggestion'),
        }],
    };
}

function compileAdvancedConstraint(ir = {}) {
    return [{
        type: 'advanced_constraint',
        intent: ir.intent,
        advancedType: ir.capabilityId,
        targetType: ir.target.kind,
        targetId: ir.target.matchedIds?.[0] || '',
        targetIds: ir.target.matchedIds || [],
        targetName: ir.target.name,
        priority: ir.strength,
        status: 'effective',
        scope: ir.scope || {},
        parameters: ir.parameters || {},
        slots: ir.parameters?.slots || ir.time?.slots || [],
    }];
}

function hasAdvancedScope(ir = {}) {
    const parameters = ir.parameters || {};
    return [
        'activityTypes',
        'avoidDayParts',
        'boundaryPeriods',
        'comparisonScope',
        'forbiddenRoomTypes',
        'gradeNames',
        'minOccurrences',
        'preferredActivityTypes',
        'preferredRoomIds',
        'requiredResourceTypes',
        'scopeQualifier',
        'teacherNames',
    ].some(key => {
        const value = parameters[key];
        return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
    });
}

function compileScopedOrLegacy(ir = {}) {
    return hasAdvancedScope(ir) ? compileAdvancedConstraint(ir) : compileLegacyArtifact(ir);
}

function preferredDayPartCompiler(ir = {}, context = {}) {
    if (hasAdvancedScope(ir)) return compileAdvancedConstraint(ir);
    const legacyRow = legacyRowOf(ir);
    if (Object.keys(legacyRow).length) return compileLegacyArtifact(ir);
    const [subjectId] = unique(ir.target?.matchedIds || []);
    const periods = asArray(ir.parameters?.periods || ir.time?.periods).map(Number).filter(Number.isInteger);
    const project = context.project || context;
    const activePeriods = asArray(project?.activePeriods).map(Number).filter(Number.isInteger);
    const afternoonStartPeriod = Number(project?.dayPartBoundaries?.afternoonStartPeriod || 5);
    const inferredDayPart = periods.length && periods.every(period => period >= afternoonStartPeriod)
        ? 'afternoon'
        : periods.length && periods.every(period => period < afternoonStartPeriod)
            ? 'morning'
            : '';
    const dayPart = text(ir.parameters?.dayPart || ir.time?.dayPart || inferredDayPart, 40).toLowerCase();
    const type = dayPart === 'afternoon' ? 'subject_afternoon' : 'subject_morning';
    const validPeriods = periods.length ? periods : activePeriods;
    return {
        rows: subjectId ? [{
            type,
            targetType: 'subject',
            targetId: subjectId,
            targetName: ir.target?.name || '',
            periods: validPeriods,
            priority: 'soft',
            status: 'effective',
            rawText: ir.evidence?.[0]?.quote || '',
        }] : [],
    };
}

function singleTargetValidation(kindLabel) {
    return (ir, context = {}) => {
        const matchedIds = unique(ir.target?.matchedIds || []);
        if (matchedIds.length === 1) return { valid: true };
        if (matchedIds.length > 1) {
            return {
                valid: false,
                errors: [{ code: 'ambiguous_target', message: `${kindLabel}目标匹配到多个实体。`, path: 'target.matchedIds' }],
                clarifications: [`${kindLabel}存在多个候选或重名，请选择唯一${kindLabel}。`],
            };
        }
        if (context.deferEntityValidation === true && text(ir.target?.name, 240)) {
            return {
                valid: true,
                warnings: [`暂未绑定唯一${kindLabel}实体，已保留为待复核规则。`],
                clarifications: [`请确认${kindLabel}名称，并先在项目基础数据中录入或绑定该${kindLabel}。`],
            };
        }
        return {
            valid: false,
            errors: [{ code: 'missing_target', message: `缺少可绑定的${kindLabel}。`, path: 'target.matchedIds' }],
            clarifications: [`请确认${kindLabel}名称，并先在项目基础数据中录入或绑定该${kindLabel}。`],
        };
    };
}

function teacherUnavailableCompiler(ir = {}) {
    const [teacherId] = ir.target.matchedIds;
    const slots = unique(ir.parameters?.slots || ir.time?.slots || []);
    const legacyRow = legacyRowOf(ir);
    return {
        rows: [{
            ...legacyRow,
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: teacherId,
            targetName: ir.target.name,
            slots,
            priority: 'hard',
            status: teacherId && slots.length ? 'effective' : 'needs_review',
            rawText: ir.evidence?.[0]?.quote || legacyRow.rawText || '',
            warnings: unique([
                ...asArray(legacyRow.warnings),
                ...(!teacherId ? [`暂未绑定唯一教师实体“${ir.target.name || '未命名教师'}”。`] : []),
            ], 500),
        }],
    };
}

const CAPABILITY_DEFINITIONS = [
    {
        id: 'teacher.unavailable',
        intents: ['unavailable_periods', 'teacher_unavailable'],
        aliases: ['teacher_no_class', 'teacher_not_available', '教师不可用', '教师禁排'],
        rowTypes: ['teacher_unavailable'],
        objectTypes: ['teacher'],
        requiredParameters: ['slots'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_unavailable'],
        fulfillmentEvaluable: true,
        validate: singleTargetValidation('教师'),
        compile: teacherUnavailableCompiler,
        explain: ir => `${ir.target.name || '指定教师'}在${(ir.parameters.slots || []).join('、') || '指定时段'}不可排课。`,
    },
    {
        id: 'teacher.avoid_periods',
        intents: ['teacher_avoid_periods'],
        aliases: ['teacher_period_preference', 'teacher_avoid_first_period', 'teacher_avoid_last_period', '教师时段偏好'],
        rowTypes: [],
        objectTypes: ['teacher', 'teacher_group', 'derived_group'],
        requiredParameters: ['slots'],
        defaultStrength: 'soft',
        landing: ['clarification', 'optimization'],
        solverSupport: 'none',
        machineRuleTypes: [],
        fulfillmentEvaluable: false,
        explain: ir => `${ir.target.name || '指定教师或教师角色组'}尽量避开${(ir.parameters.slots || []).join('、') || '指定课节'}；当前保留为复核偏好，不降义为硬禁排。`,
    },
    {
        id: 'class.fixed_activity',
        intents: ['class_unavailable', 'class_fixed_activity'],
        aliases: ['fixed_class_activity', '班级固定活动', '班会固定时段'],
        rowTypes: ['class_unavailable'],
        objectTypes: ['class'],
        requiredParameters: ['slots'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['class_unavailable'],
        fulfillmentEvaluable: true,
        validate: singleTargetValidation('班级'),
        compile: compileLegacyArtifact,
        explain: ir => `${ir.target.name || '指定班级'}在指定时段安排固定活动，不排普通课程。`,
    },
    {
        id: 'school.unavailable',
        intents: ['global_unavailable', 'school_unavailable'],
        aliases: ['all_school_unavailable', '全校占用'],
        rowTypes: ['global_unavailable'],
        objectTypes: ['global'],
        requiredParameters: ['slots'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['global_unavailable'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '指定时段为全校统一活动，不安排普通课程。',
    },
    {
        id: 'lesson.locked_slot',
        intents: ['locked_slot'],
        aliases: ['fixed_lesson_slot'],
        rowTypes: ['locked_slot'],
        objectTypes: ['lesson_slot'],
        requiredParameters: ['slots'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['locked_slot'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '指定课程固定在指定课节。',
    },
    {
        id: 'teacher.daily_lesson_limit',
        intents: ['teacher_daily_limit'],
        aliases: ['teacher_daily_max', '教师日课量上限'],
        rowTypes: ['teacher_daily_limit'],
        objectTypes: ['teacher', 'teacher_group'],
        requiredParameters: ['limit'],
        defaultStrength: 'soft',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_daily_limit'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: ir => `${ir.target.name || '教师'}每天最多安排 ${ir.parameters.limit || '?'} 节课。`,
    },
    {
        id: 'teacher.consecutive_lesson_limit',
        intents: ['teacher_consecutive_limit'],
        aliases: ['teacher_consecutive_max', '教师连课上限'],
        rowTypes: ['teacher_consecutive_limit'],
        objectTypes: ['teacher', 'teacher_group'],
        requiredParameters: ['limit'],
        defaultStrength: 'soft',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_consecutive_limit'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: ir => `${ir.target.name || '教师'}连续上课不超过 ${ir.parameters.limit || '?'} 节。`,
    },
    {
        id: 'teacher.weekly_lesson_limit',
        intents: ['teacher_weekly_limit'],
        aliases: ['teacher_weekly_max', '教师周课时'],
        rowTypes: ['teacher_weekly_limit'],
        objectTypes: ['teacher', 'teacher_group'],
        requiredParameters: ['limit'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_weekly_limit'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: ir => `${ir.target.name || '教师'}周课时上限为 ${ir.parameters.limit || '?'} 节。`,
    },
    {
        id: 'teacher.max_teaching_days',
        intents: ['teacher_max_days_per_week', 'concentrated_teaching_days'],
        aliases: ['teacher_concentrated_days', '集中授课天数'],
        rowTypes: ['teacher_max_days_per_week'],
        objectTypes: ['teacher', 'teacher_group'],
        requiredParameters: ['limit'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_max_days_per_week'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: ir => `${ir.target.name || '教师'}尽量在每周 ${ir.parameters.limit || '?'} 天内完成授课。`,
    },
    {
        id: 'teacher.compact_day',
        intents: ['teacher_gap_preference'],
        aliases: ['teacher_compact_schedule', '教师空堂紧凑'],
        rowTypes: ['teacher_gap_preference'],
        objectTypes: ['teacher', 'teacher_group', 'global'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '同一天多节课尽量紧凑，减少长空堂。',
    },
    {
        id: 'teacher.mutual_exclusion',
        intents: ['teacher_mutual_exclusion'],
        aliases: ['teachers_not_simultaneous'],
        rowTypes: ['teacher_mutual_exclusion'],
        objectTypes: ['global', 'teacher_group'],
        requiredParameters: ['teacherIds'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_mutual_exclusion'],
        fulfillmentEvaluable: true,
        compile: compileScopedOrLegacy,
        explain: () => '指定教师不能在同一课节同时上课。',
    },
    {
        id: 'subject.preferred_day_part',
        intents: ['preferred_day_part'],
        aliases: ['subject_morning', 'subject_afternoon', '学科时段偏好'],
        rowTypes: ['subject_morning', 'subject_afternoon'],
        objectTypes: ['subject'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['rule', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_morning', 'subject_afternoon'],
        fulfillmentEvaluable: true,
        compile: preferredDayPartCompiler,
        explain: ir => `${ir.target.name || '课程'}优先安排到指定日内时段。`,
    },
    {
        id: 'subject.preferred_periods',
        intents: ['preferred_periods'],
        aliases: ['subject_preferred_periods'],
        rowTypes: ['subject_preferred_periods'],
        objectTypes: ['subject'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_preferred_periods'],
        fulfillmentEvaluable: true,
        compile: compileScopedOrLegacy,
        explain: ir => `${ir.target.name || '课程'}优先安排在指定课节。`,
    },
    {
        id: 'subject.avoid_periods',
        intents: ['avoid_periods'],
        aliases: ['subject_avoid_periods'],
        rowTypes: ['subject_avoid_periods'],
        objectTypes: ['subject'],
        requiredParameters: ['slots'],
        defaultStrength: 'soft',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_avoid_periods'],
        fulfillmentEvaluable: true,
        compile: compileScopedOrLegacy,
        explain: ir => `${ir.target.name || '课程'}尽量避开指定课节。`,
    },
    {
        id: 'class.subject_daily_limit',
        intents: ['subject_daily_limit'],
        aliases: ['subject_daily_max', '班级单科日上限'],
        rowTypes: ['subject_daily_limit'],
        objectTypes: ['subject'],
        requiredParameters: ['limit'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_daily_limit'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: ir => `同一班级每天${ir.target.name || '该课程'}不超过 ${ir.parameters.limit || '?'} 节。`,
    },
    {
        id: 'subject.spread',
        intents: ['subject_spread'],
        aliases: ['course_spread'],
        rowTypes: ['subject_spread'],
        objectTypes: ['subject'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_spread'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '课程课时尽量均匀分布到一周。',
    },
    {
        id: 'subject.minimum_day_gap',
        intents: ['course_interval', 'minimum_day_gap'],
        aliases: ['subject_day_gap', '课程隔天分布'],
        rowTypes: ['course_interval'],
        objectTypes: ['subject'],
        requiredParameters: ['minGapDays'],
        defaultStrength: 'soft',
        landing: ['rule', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['course_interval'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: ir => `${ir.target.name || '课程'}两次课之间至少间隔 ${ir.parameters.minGapDays || '?'} 天。`,
    },
    {
        id: 'subject.not_same_day',
        intents: ['subject_not_same_day'],
        aliases: ['subjects_separate_days'],
        rowTypes: ['subject_not_same_day'],
        objectTypes: ['global', 'subject_group'],
        requiredParameters: ['subjectIds'],
        defaultStrength: 'hard',
        landing: ['rule'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_not_same_day'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '指定课程不安排在同一天。',
    },
    {
        id: 'subject.sequence',
        intents: ['subject_sequence'],
        aliases: ['subject_order'],
        rowTypes: ['subject_sequence'],
        objectTypes: ['global', 'subject_group'],
        requiredParameters: ['beforeSubjectId', 'afterSubjectId'],
        defaultStrength: 'soft',
        landing: ['rule', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['subject_sequence'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '指定课程按先后顺序安排。',
    },
    {
        id: 'room.preferred',
        intents: ['room_preferred'],
        aliases: ['preferred_room', '实验室优先'],
        rowTypes: [],
        objectTypes: ['subject'],
        requiredParameters: ['preferredRoomIds', 'activityTypes'],
        defaultStrength: 'soft',
        landing: ['clarification', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: ir => `${ir.target.name || '课程'}的指定活动优先使用目标教室、实验室或场地。`,
    },
    {
        id: 'room.forbidden_type',
        intents: ['room_forbidden_type'],
        aliases: ['forbidden_room_type', '禁用普通教室'],
        rowTypes: [],
        objectTypes: ['subject'],
        requiredParameters: ['forbiddenRoomTypes', 'activityTypes'],
        defaultStrength: 'hard',
        landing: ['clarification', 'solver_policy'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: ir => `${ir.target.name || '课程'}的指定活动禁止使用目标教室类型。`,
    },
    {
        id: 'room.required',
        intents: ['room_requirement'],
        aliases: ['required_room', '实验室机房要求'],
        rowTypes: ['room_requirement'],
        objectTypes: ['subject'],
        requiredParameters: ['roomRequirement'],
        defaultStrength: 'hard',
        landing: ['rule', 'lesson_plan'],
        solverSupport: 'full',
        machineRuleTypes: ['room_requirement'],
        fulfillmentEvaluable: true,
        compile: compileScopedOrLegacy,
        explain: ir => `${ir.target.name || '课程'}必须使用指定教室、实验室或机房。`,
    },
    {
        id: 'lesson.consecutive',
        intents: ['block_integrity', 'block_preference'],
        aliases: ['block_protection', '实验连堂'],
        rowTypes: ['block_protection'],
        objectTypes: ['global', 'subject', 'subject_group'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['solver_policy', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '相关实验或实践课尽量连续安排，避免拆散。',
    },
    {
        id: 'class.subject_spread',
        intents: ['class_subject_spread'],
        aliases: ['班级学科分散'],
        rowTypes: ['class_subject_spread'],
        objectTypes: ['global', 'class'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['class_subject_spread'],
        fulfillmentEvaluable: false,
        compile: compileLegacyArtifact,
        explain: () => '班级课程尽量均匀分布，避免过度集中。',
    },
    {
        id: 'subject.later_preference',
        intents: ['quality_subject_later'],
        aliases: ['考试学科后段避让'],
        rowTypes: ['quality_subject_later'],
        objectTypes: ['global', 'subject', 'subject_group'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['quality_subject_later'],
        fulfillmentEvaluable: false,
        compile: compileLegacyArtifact,
        explain: () => '特定年级后段课节尽量避开考试学科。',
    },
    {
        id: 'teacher.load_balance',
        intents: ['teacher_load_balance'],
        aliases: ['teacher_fairness', '教师负载均衡'],
        rowTypes: ['teacher_load_balance'],
        objectTypes: ['global', 'teacher_group'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['teacher_load_balance'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '教师课量和时段分布尽量公平、均衡。',
    },
    {
        id: 'class.daily_balance',
        intents: ['class_daily_balance'],
        aliases: ['class_load_balance', '班级日课量均衡'],
        rowTypes: ['class_daily_balance'],
        objectTypes: ['global', 'class_group'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['class_daily_balance'],
        fulfillmentEvaluable: true,
        compile: compileLegacyArtifact,
        explain: () => '每个班每天课量尽量均衡。',
    },
    {
        id: 'subject.avoid_weekday_concentration',
        intents: ['avoid_weekday_concentration'],
        aliases: ['不要挤在周末前', '学科星期集中避让'],
        rowTypes: [],
        objectTypes: ['subject', 'subject_group'],
        requiredParameters: ['days'],
        defaultStrength: 'soft',
        landing: ['optimization', 'clarification'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '指定课程不要集中挤在少数几个工作日。',
    },
    {
        id: 'schedule.cross_venue_boundary',
        intents: ['cross_venue_boundary'],
        aliases: ['跨场地连续关系'],
        rowTypes: [],
        objectTypes: ['global', 'class_group'],
        requiredParameters: ['boundaryPeriods'],
        defaultStrength: 'hard',
        landing: ['clarification', 'solver_policy'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '指定课节边界不安排需要跨场地转移的连续课程。',
    },
    {
        id: 'subject.not_consecutive_with',
        intents: ['subject_not_consecutive_with'],
        aliases: ['subjects_not_consecutive', '同日不连续'],
        rowTypes: [],
        objectTypes: ['subject_group'],
        requiredParameters: ['subjectNames', 'sameDay'],
        defaultStrength: 'soft',
        landing: ['clarification', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: ir => `${(ir.parameters.subjectNames || []).join('、') || '指定课程'}同一天内不要连续安排。`,
    },
    {
        id: 'lesson.activity_scope_period_policy',
        intents: ['lesson_activity_scope_period_policy'],
        aliases: ['activity_scope_period_policy', '活动类型课节策略'],
        rowTypes: [],
        objectTypes: ['subject_group', 'global'],
        requiredParameters: ['subjectNames', 'activityTypes', 'preferredActivityTypes', 'periods'],
        defaultStrength: 'soft',
        landing: ['clarification', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '指定学科的特定教学活动应避开目标课节，并优先留给指定活动类型。',
    },
    {
        id: 'lesson.resource_attribute_avoid_periods',
        intents: ['lesson_resource_attribute_avoid_periods'],
        aliases: ['resource_attribute_avoid_periods', '资源属性课节避让'],
        rowTypes: [],
        objectTypes: ['global'],
        requiredParameters: ['requiredResourceTypes', 'periods'],
        defaultStrength: 'soft',
        landing: ['clarification', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '需要指定资源类型的课程应避开目标课节。',
    },
    {
        id: 'teacher.prep_group_fairness',
        intents: ['prep_group_fairness'],
        aliases: ['备课组公平'],
        rowTypes: [],
        objectTypes: ['teacher_group', 'global'],
        requiredParameters: [],
        defaultStrength: 'soft',
        landing: ['clarification', 'optimization'],
        solverSupport: 'full',
        machineRuleTypes: ['advanced_constraint'],
        fulfillmentEvaluable: true,
        compile: compileAdvancedConstraint,
        explain: () => '同一备课组内教师课量和时段应公平分布。',
    },
];

const UPGRADED_CAPABILITY_IDS = new Set([
    'teacher.compact_day',
    'subject.preferred_day_part',
    'subject.preferred_periods',
    'subject.avoid_periods',
    'room.preferred',
    'room.forbidden_type',
    'room.required',
    'lesson.consecutive',
    'class.daily_balance',
    'subject.avoid_weekday_concentration',
    'schedule.cross_venue_boundary',
    'subject.not_consecutive_with',
    'lesson.activity_scope_period_policy',
    'lesson.resource_attribute_avoid_periods',
    'teacher.prep_group_fairness',
]);

export function createDefaultTimetableCapabilityRegistry(options = {}) {
    const registry = createConstraintCapabilityRegistry([], {
        version: 1,
        legacyCompiler: options.legacyCompiler || compileRequirementToRows,
    });
    CAPABILITY_DEFINITIONS.forEach(definition => registerConstraintCapability(registry, definition));
    return registry;
}

function objectFromArtifact(artifact = {}) {
    if (artifact.object && typeof artifact.object === 'object') {
        const objectKind = key(artifact.object.kind || artifact.object.type || 'global');
        const kind = objectKind === 'all_teachers' || objectKind === '__all_teachers'
            ? 'teacher_group'
            : objectKind === 'all_classes'
                ? 'class_group'
                : objectKind === 'subject_set'
                    ? 'subject_group'
                    : objectKind;
        return {
            ...artifact.object,
            kind,
            matchedIds: unique(artifact.object.matchedIds || artifact.object.ids || artifact.object.id),
        };
    }
    const rawTargetType = key(artifact.targetType || (
        artifact.type === 'teacher_unavailable' ? 'teacher'
            : artifact.type === 'class_unavailable' ? 'class'
                : artifact.type?.startsWith('subject_') || artifact.type === 'room_requirement' || artifact.type === 'course_interval' ? 'subject'
                    : 'global'
    ));
    const targetType = rawTargetType === 'all_teachers' || rawTargetType === '__all_teachers'
        ? 'teacher_group'
        : rawTargetType === 'all_classes'
            ? 'class_group'
            : rawTargetType === 'subject_set'
                ? 'subject_group'
                : rawTargetType;
    const matchedIds = unique([
        ...asArray(artifact.matchedIds),
        ...(['subject_group', 'subject_set'].includes(targetType)
            ? [...asArray(artifact.subjectIds), ...asArray(artifact.subjectNames)]
            : []),
        artifact.targetId,
        artifact.teacherId,
        artifact.classId,
        artifact.subjectId,
    ]);
    return {
        kind: targetType || 'global',
        name: text(artifact.targetName || artifact.target || artifact.teacherName || artifact.className || artifact.subjectName || '', 240),
        matchedIds,
        scope: ['global', 'teacher_group', 'derived_group', 'class_group', 'subject_group'].includes(targetType) ? 'group' : 'explicit',
        candidates: artifact.candidates || artifact.ambiguity?.candidates || artifact.ambiguities || [],
    };
}

function parametersFromArtifact(artifact = {}) {
    const existing = artifact.parameters && typeof artifact.parameters === 'object' ? artifact.parameters : {};
    const roomRequirement = compactObject({
        roomIds: unique(artifact.roomIds || existing.roomIds),
        requiredTags: unique(artifact.requiredTags || existing.requiredTags),
        roomName: text(artifact.roomName || existing.roomName || '', 160),
    });
    return compactObject({
        ...existing,
        slots: unique(artifact.slots || artifact.condition?.slots || existing.slots),
        days: asArray(artifact.days || existing.days).map(Number).filter(Number.isInteger),
        periods: asArray(artifact.periods || existing.periods).map(Number).filter(Number.isInteger),
        boundaryPeriods: asArray(artifact.boundaryPeriods || existing.boundaryPeriods).map(Number).filter(Number.isInteger),
        limit: Number.isFinite(Number(artifact.limit ?? existing.limit)) ? Number(artifact.limit ?? existing.limit) : undefined,
        minGapDays: Number.isFinite(Number(artifact.minGapDays ?? existing.minGapDays)) ? Number(artifact.minGapDays ?? existing.minGapDays) : undefined,
        weight: Number.isFinite(Number(artifact.weight ?? existing.weight)) ? Number(artifact.weight ?? existing.weight) : undefined,
        weekPattern: text(artifact.weekPattern || existing.weekPattern || '', 80),
        teacherIds: unique(artifact.teacherIds || existing.teacherIds),
        classIds: unique(artifact.classIds || existing.classIds),
        gradeNames: unique(artifact.gradeNames || existing.gradeNames),
        blockPreference: text(artifact.blockPreference || existing.blockPreference || '', 40),
        minOccurrences: Number.isFinite(Number(artifact.minOccurrences ?? existing.minOccurrences))
            ? Number(artifact.minOccurrences ?? existing.minOccurrences)
            : undefined,
        avoidDayParts: unique(artifact.avoidDayParts || existing.avoidDayParts),
        subjectNames: unique(artifact.subjectNames || existing.subjectNames),
        activityTypes: unique(artifact.activityTypes || existing.activityTypes),
        preferredActivityTypes: unique(artifact.preferredActivityTypes || existing.preferredActivityTypes),
        requiredResourceTypes: unique(artifact.requiredResourceTypes || existing.requiredResourceTypes),
        sameDay: typeof (artifact.sameDay ?? existing.sameDay) === 'boolean'
            ? (artifact.sameDay ?? existing.sameDay)
            : undefined,
        subjectIds: unique(artifact.subjectIds || existing.subjectIds),
        beforeSubjectId: text(artifact.beforeSubjectId || existing.beforeSubjectId || '', 160),
        afterSubjectId: text(artifact.afterSubjectId || existing.afterSubjectId || '', 160),
        roomRequirement: Object.keys(roomRequirement).length ? roomRequirement : undefined,
        legacyRow: artifact.type ? { ...artifact } : existing.legacyRow,
    });
}

function understandingFromArtifact(artifact = {}, capability = null, target = {}) {
    if (artifact.understandingStatus) return artifact.understandingStatus;
    const status = key(artifact.status || '');
    if (artifact.intent === 'unrecognized' || artifact.type === 'unrecognized') return 'unrecognized';
    if (!capability && (artifact.intent || artifact.type)) return 'parsed';
    if (target.candidates?.length > 1 || target.matchedIds?.length > 1 && ['teacher', 'class', 'subject'].includes(target.kind)) return 'ambiguous';
    if (['invalid', 'needs_review'].includes(status) && ['teacher', 'class', 'subject'].includes(target.kind) && !target.matchedIds?.length) {
        return 'invalid_reference';
    }
    if (status === 'needs_review' || status === 'invalid') return 'partially_parsed';
    return capability ? 'parsed' : 'unrecognized';
}

function executionFromArtifact(artifact = {}, capability = null, understandingStatus = '') {
    const explicitExecution = key(artifact.executionStatus || '');
    if (['conflicted', 'disabled'].includes(explicitExecution)) return explicitExecution;
    if (!capability || capability.solverSupport === 'none') return 'unsupported_by_solver';
    if (understandingStatus === 'invalid_reference') return 'blocked_by_reference';
    if (understandingStatus === 'ambiguous') {
        return artifact.target?.candidates?.length > 1 || artifact.object?.candidates?.length > 1
            ? 'blocked_by_reference'
            : 'blocked_by_clarification';
    }
    if (understandingStatus !== 'parsed') return 'blocked_by_clarification';
    if (
        artifact.needsClarification === true
        || (
            explicitExecution === 'unsupported_by_solver'
            && UPGRADED_CAPABILITY_IDS.has(capability.id)
            && asArray(artifact.clarifications).length > 0
        )
    ) return 'blocked_by_clarification';
    if (explicitExecution === 'unsupported_by_solver' && !UPGRADED_CAPABILITY_IDS.has(capability.id)) return explicitExecution;
    if (capability.solverSupport === 'partial') return 'partially_executable';
    const status = key(artifact.status || '');
    if (['effective', 'ready', 'actionable', 'handled', 'suggestion', 'partially_actionable'].includes(status)) return 'executable';
    return 'executable';
}

function clarificationForTarget(target = {}, understandingStatus = '') {
    if (understandingStatus === 'ambiguous') return [`${target.name || '目标实体'}匹配到多个候选，请选择唯一对象。`];
    if (understandingStatus === 'invalid_reference') return [`未在当前项目中找到“${target.name || '目标实体'}”，请补录或绑定后再应用。`];
    return [];
}

function resolveArtifactCapability(registry, artifact = {}) {
    const explicit = resolveConstraintCapability(registry, artifact.capabilityId || artifact.capability || artifact.type || artifact.rowType || '');
    if (explicit) return explicit;
    const intent = key(artifact.intent || '');
    const objectKind = key(artifact.object?.kind || artifact.targetType || '');
    if (intent === 'unavailable_periods') {
        if (objectKind === 'class') return resolveConstraintCapability(registry, 'class.fixed_activity');
        if (objectKind === 'global') return resolveConstraintCapability(registry, 'school.unavailable');
        return resolveConstraintCapability(registry, 'teacher.unavailable');
    }
    return resolveConstraintCapability(registry, intent);
}

export function legacyArtifactToConstraintIR(artifact = {}, options = {}) {
    const registry = options.registry || createDefaultTimetableCapabilityRegistry(options);
    const capability = resolveArtifactCapability(registry, artifact);
    const rawCapability = key(artifact.capabilityId || artifact.intent || artifact.type || 'unrecognized');
    const capabilityId = capability?.id || `legacy.${rawCapability || 'unrecognized'}`;
    const sourceId = text(artifact.sourceId || artifact.source?.sourceId || options.sourceId || '', 300);
    const target = objectFromArtifact(artifact);
    const parameters = parametersFromArtifact(artifact);
    const { legacyRow, ...semanticParameters } = parameters;
    void legacyRow;
    const clauseCandidate = {
        capabilityId,
        intent: artifact.intent || artifact.type || rawCapability,
        target,
        condition: artifact.condition || { slots: parameters.slots || [] },
        parameters: semanticParameters,
        strength: artifact.strength || artifact.priority || capability?.defaultStrength || 'soft',
        applyTo: artifact.applyTo || asArray(artifact.landing)[0] || capability?.landing?.[0] || 'review',
    };
    const explicitClauseId = text(artifact.clauseId || '', 300);
    const clauseId = explicitClauseId && (!sourceId || explicitClauseId.startsWith(`${sourceId}:clause:`))
        ? explicitClauseId
        : (sourceId ? buildClauseId(sourceId, clauseCandidate) : '')
            || text(artifact.requirementId || artifact.id || '', 300);
    const understandingStatus = understandingFromArtifact(artifact, capability, target);
    const executionStatus = executionFromArtifact(artifact, capability, understandingStatus);
    const capabilityWarnings = [];
    const artifactSupport = key(artifact.support || '');
    const effectiveSupport = artifactSupport === 'none' && UPGRADED_CAPABILITY_IDS.has(capability?.id)
        ? capability.solverSupport
        : artifactSupport || capability?.solverSupport || 'none';
    if (effectiveSupport === 'partial') capabilityWarnings.push('当前求解器只能部分或近似执行这条能力，需在审核台确认。');
    if (effectiveSupport === 'none') capabilityWarnings.push('需求语义已保留，但当前求解器不支持自动执行。');
    if (!capability && understandingStatus === 'parsed') capabilityWarnings.push('需求语义已识别，但能力尚未注册，当前不生成机器规则。');
    const ir = normalizeConstraintIR({
        constraintId: clauseId,
        clauseId,
        sourceId,
        textHash: artifact.textHash || artifact.source?.textHash || options.textHash || '',
        origin: artifact.origin || artifact.source?.origin || options.origin || 'unknown',
        parsedBy: [...asArray(options.parsedBy), ...asArray(artifact.source?.parsedBy), ...asArray(artifact.parsedBy)],
        capabilityId,
        intent: artifact.intent || artifact.type || rawCapability,
        target,
        scope: artifact.scope || {},
        time: artifact.time || compactObject({
            slots: parameters.slots,
            days: parameters.days,
            periods: parameters.periods,
            weekPattern: parameters.weekPattern,
        }),
        relation: artifact.relation || compactObject({
            beforeSubjectId: parameters.beforeSubjectId,
            afterSubjectId: parameters.afterSubjectId,
            subjectIds: parameters.subjectIds,
        }),
        normalizationTrace: artifact.normalizationTrace || artifact.legacyClause?.normalizationTrace || artifact.source?.normalizationTrace || [],
        negation: artifact.negation || artifact.legacyClause?.negation || null,
        exceptions: artifact.exceptions || artifact.legacyClause?.exceptions || [],
        activity: artifact.activity || artifact.legacyClause?.activity || null,
        parameters,
        strength: artifact.strength || artifact.priority || capability?.defaultStrength || 'soft',
        understandingStatus,
        executionStatus,
        support: effectiveSupport,
        landing: asArray(artifact.landing).length
            ? asArray(artifact.landing)
            : asArray(capability?.landing).length
                ? asArray(capability.landing)
                : artifact.applyTo || ['review'],
        machineRuleIds: artifact.machineRuleIds || (artifact.machineRuleId ? [artifact.machineRuleId] : []),
        aiReviewStatus: artifact.aiReviewStatus || '',
        aiReviewIssueCode: artifact.aiReviewIssueCode || '',
        aiReviewValidationStatus: artifact.aiReviewValidationStatus || '',
        aiReviewBlocking: artifact.aiReviewBlocking === true,
        aiReviewValidationEvidence: asArray(artifact.aiReviewValidationEvidence),
        aiReviewWarnings: asArray(artifact.aiReviewWarnings),
        warnings: [...asArray(artifact.warnings), ...capabilityWarnings],
        clarifications: [
            ...asArray(artifact.clarifications),
            ...asArray(artifact.questions),
            ...clarificationForTarget(target, understandingStatus),
        ],
        evidence: artifact.evidence || (artifact.rawText || artifact.source?.rawText ? [{ quote: artifact.rawText || artifact.source?.rawText }] : []),
        confidence: artifact.confidence,
        enabled: artifact.enabled !== false,
    });
    return {
        ...ir,
        explanation: explainConstraintIR(registry, ir, options),
    };
}

export function compileLegacyArtifactThroughCapabilities(artifact = {}, options = {}) {
    const registry = options.registry || createDefaultTimetableCapabilityRegistry(options);
    const ir = legacyArtifactToConstraintIR(artifact, { ...options, registry });
    return compileConstraintIR(registry, ir, options);
}

export function listDefaultTimetableCapabilities() {
    return CAPABILITY_DEFINITIONS.map(definition => ({ ...definition }));
}
