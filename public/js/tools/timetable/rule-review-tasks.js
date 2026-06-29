const TASK_ORDER = [
    'confirm_subject_names',
    'confirm_teacher_names',
    'confirm_class_names',
    'fix_slot_range',
    'handle_conflicts',
    'scan_recommendations',
    'ready_to_apply',
    'review_rules',
    'unsupported_items',
];

const TASK_META = {
    confirm_subject_names: {
        type: 'clarifying_questions',
        title: '确认课程名称',
        icon: 'book-open',
        tone: 'warning',
        description: '系统不确定原文里的课程词，对应项目里的哪一门课。',
    },
    confirm_teacher_names: {
        type: 'clarifying_questions',
        title: '确认教师名称',
        icon: 'user-round-check',
        tone: 'warning',
        description: '系统不确定原文里的老师，对应项目里的哪一位教师。',
    },
    confirm_class_names: {
        type: 'clarifying_questions',
        title: '确认班级名称',
        icon: 'users-round',
        tone: 'warning',
        description: '系统不确定原文里的班级，对应项目里的哪个班。',
    },
    confirm_names: {
        type: 'clarifying_questions',
        title: '确认名称',
        icon: 'circle-help',
        tone: 'warning',
        description: '系统不确定原文里的对象，对应项目里的哪一项。',
    },
    fix_slot_range: {
        type: 'out_of_range_slots',
        title: '修正节次范围',
        icon: 'calendar-x',
        tone: 'danger',
        description: '有些节次不在当前排课范围内，需要删除或改成可用节次。',
    },
    handle_conflicts: {
        type: 'conflicts',
        title: '处理冲突风险',
        icon: 'triangle-alert',
        tone: 'danger',
        description: '这些约束可能互相打架，建议先处理再确认生效。',
    },
    scan_recommendations: {
        type: 'scan_findings',
        title: '处理智能检查建议',
        icon: 'stethoscope',
        tone: 'review',
        description: '智能检查发现了负载、分布或合理性问题，可以逐项查看和生成修正。',
    },
    ready_to_apply: {
        type: 'ready_to_apply',
        title: '核对可生效约束',
        icon: 'badge-check',
        tone: 'success',
        description: '这些约束已经能写入项目，确认前再看一眼。',
    },
    review_rules: {
        type: 'need_review',
        title: '确认草稿约束',
        icon: 'edit-3',
        tone: 'review',
        description: '这些约束能理解，但还需要你确认对象、节次或强弱。',
    },
    unsupported_items: {
        type: 'unsupported',
        title: '查看暂不支持建议',
        icon: 'lightbulb',
        tone: 'muted',
        description: '当前版本只把这些内容作为建议展示，不会写入排课规则。',
    },
};

function uniqueValues(items = [], limit = 80) {
    const values = [];
    const seen = new Set();
    for (const item of items) {
        const value = String(item || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
        if (values.length >= limit) break;
    }
    return values;
}

function taskTypeFromTarget(targetType = '', text = '') {
    const normalized = String(targetType || '').toLowerCase();
    if (['subject', 'course', 'lesson'].includes(normalized) || /课程|科目|学科/.test(text)) return 'confirm_subject_names';
    if (['teacher', 'staff'].includes(normalized) || /老师|教师/.test(text)) return 'confirm_teacher_names';
    if (['class', 'grade'].includes(normalized) || /班级|年级|全班|全部班/.test(text)) return 'confirm_class_names';
    return 'confirm_names';
}

function extractTargetText(question = {}) {
    const explicit = question.targetText || question.targetName || question.name || '';
    if (explicit) return String(explicit);
    const text = String(question.question || question.message || question.reason || '');
    const match = text.match(/你说的(.+?)(?:是哪个|是哪|指的是|对应)/);
    if (match?.[1]) return match[1].replace(/[，,。？?]/g, '').trim();
    return text.slice(0, 80);
}

function normalizeOptions(options = []) {
    const seen = new Set();
    return (Array.isArray(options) ? options : [])
        .map(option => ({
            label: String(option?.label || option?.name || option?.value || '').trim(),
            value: String(option?.value || option?.id || '').trim(),
        }))
        .filter(option => {
            if (!option.label || !option.value || seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
        });
}

function createTask(id) {
    const meta = TASK_META[id] || TASK_META.confirm_names;
    return {
        id,
        ...meta,
        items: [],
        relatedRuleIds: [],
        examples: [],
    };
}

function addItem(tasks, taskId, item) {
    if (!tasks.has(taskId)) tasks.set(taskId, createTask(taskId));
    const task = tasks.get(taskId);
    task.items.push(item);
    task.relatedRuleIds = uniqueValues([
        ...task.relatedRuleIds,
        ...(item.relatedRuleIds || []),
        item.ruleId,
    ]);
    task.examples = uniqueValues([
        ...task.examples,
        item.targetText,
        item.message,
        item.rawText,
        item.description,
    ], 6);
}

function itemMessage(item = {}) {
    return String(item.message || item.reason || item.question || item.description || item.rawText || item || '');
}

function rowHasOutOfRange(row = {}) {
    return (row.warnings || []).some(warning => /不在当前排课范围内/.test(warning));
}

export function ruleTaskIdForScanProblem(problem = {}) {
    const value = `${problem.id || ''} ${problem.type || ''} ${problem.title || ''}`.toLowerCase();
    if (/missing_slots|缺少节次|具体时间/.test(value)) return 'fix_slot_range';
    if (/time_conflicts|conflict|冲突/.test(value)) return 'handle_conflicts';
    return 'scan_recommendations';
}

function scanRelatedRuleIds(problem = {}) {
    return uniqueValues([
        ...(problem.relatedRuleIds || []),
        ...(problem.constraints || []).map(item => item?.id),
        ...(problem.conflicts || []).flatMap(item => (item?.constraints || []).map(row => row?.id)),
    ], 40);
}

export function buildRuleReviewTasks(dialog = {}, scan = null) {
    const tasks = new Map();
    const rows = dialog.draftRows || [];
    const questions = dialog.clarifyingQuestions || [];
    const missingInfo = dialog.missingInfo || [];
    const conflicts = dialog.conflicts || [];
    const unsupported = dialog.unsupportedItems || [];
    const autoRows = dialog.autoAcceptable?.length
        ? dialog.autoAcceptable
        : rows.filter(row => row.status === 'effective');
    const reviewRows = dialog.needReview?.length
        ? dialog.needReview
        : rows.filter(row => ['needs_review', 'invalid'].includes(row.status));

    questions.forEach(question => {
        const message = itemMessage(question);
        const taskId = taskTypeFromTarget(question.targetType, message);
        addItem(tasks, taskId, {
            kind: 'question',
            questionId: question.id,
            targetType: question.targetType || '',
            targetText: extractTargetText(question),
            reason: question.reason || '存在多个可能对象，系统不会自动猜测。',
            options: normalizeOptions(question.options),
            relatedRuleIds: question.relatedRuleIds || [],
            message,
        });
    });

    missingInfo.forEach(item => {
        const message = itemMessage(item);
        if (/不在当前排课范围内|节次/.test(message)) {
            addItem(tasks, 'fix_slot_range', {
                kind: 'slot_range',
                message,
                relatedRuleIds: item.relatedRuleIds || [],
            });
            return;
        }
        const taskId = taskTypeFromTarget(item.targetType, message);
        addItem(tasks, taskId, {
            kind: 'missing',
            targetType: item.targetType || '',
            targetText: extractTargetText(item),
            reason: item.reason || '当前项目里没有匹配对象，系统不会自动猜测。',
            options: normalizeOptions(item.options),
            relatedRuleIds: item.relatedRuleIds || [],
            message,
        });
    });

    rows.filter(rowHasOutOfRange).forEach(row => {
        addItem(tasks, 'fix_slot_range', {
            kind: 'slot_range',
            ruleId: row.id,
            message: (row.warnings || []).filter(warning => /不在当前排课范围内/.test(warning)).join('；'),
            rawText: row.rawText || row.description,
            relatedRuleIds: [row.id],
        });
    });

    conflicts.forEach(conflict => {
        addItem(tasks, 'handle_conflicts', {
            kind: 'conflict',
            message: conflict.message || '',
            suggestion: conflict.suggestion || '',
            level: conflict.level || 'warning',
            relatedRuleIds: conflict.relatedRuleIds || [],
        });
    });

    if (autoRows.length) {
        autoRows.forEach(row => addItem(tasks, 'ready_to_apply', {
            kind: 'row',
            ruleId: row.id,
            row,
            rawText: row.rawText,
            description: row.description,
            relatedRuleIds: [row.id],
        }));
    }

    if (reviewRows.length) {
        reviewRows.forEach(row => addItem(tasks, 'review_rules', {
            kind: 'row',
            ruleId: row.id,
            row,
            rawText: row.rawText,
            description: row.description,
            relatedRuleIds: [row.id],
        }));
    }

    if (unsupported.length) {
        unsupported.forEach(row => addItem(tasks, 'unsupported_items', {
            kind: 'row',
            ruleId: row.id,
            row,
            rawText: row.rawText,
            description: row.description,
            relatedRuleIds: [row.id],
        }));
    }

    (scan?.problems || []).forEach(problem => {
        addItem(tasks, ruleTaskIdForScanProblem(problem), {
            kind: 'scan_problem',
            problemId: problem.id || '',
            title: problem.title || '智能检查发现问题',
            message: problem.description || '',
            description: problem.description || '',
            fixSuggestion: problem.fixSuggestion || '',
            severity: problem.severity || 'info',
            autoFixable: Boolean(problem.autoFixable),
            relatedRuleIds: scanRelatedRuleIds(problem),
            problem,
        });
    });

    return [...tasks.values()].sort((left, right) => {
        const leftIndex = TASK_ORDER.indexOf(left.id);
        const rightIndex = TASK_ORDER.indexOf(right.id);
        const normalizedLeft = leftIndex === -1 ? TASK_ORDER.length : leftIndex;
        const normalizedRight = rightIndex === -1 ? TASK_ORDER.length : rightIndex;
        return normalizedLeft - normalizedRight;
    });
}

export function getActiveRuleReviewTask(dialog = {}, scan = null) {
    const tasks = buildRuleReviewTasks(dialog, scan);
    const activeTaskId = dialog.activeTaskId || dialog.selectedSection || '';
    return tasks.find(task => task.id === activeTaskId) || tasks[0] || null;
}

export function ruleTaskContext(task = null) {
    if (!task) return null;
    return {
        taskId: task.id,
        taskType: task.type,
        relatedRuleIds: uniqueValues(task.relatedRuleIds || [], 40),
        examples: uniqueValues(task.examples || task.items?.map(item => item.message || item.targetText), 6),
    };
}
