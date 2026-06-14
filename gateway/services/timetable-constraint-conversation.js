const SLOT_REQUIRED_TYPES = new Set([
    'teacher_unavailable',
    'class_unavailable',
    'locked_slot',
    'subject_preferred_periods',
    'subject_avoid_periods',
]);

const SUPPORTED_TYPES = new Set([
    ...SLOT_REQUIRED_TYPES,
    'teacher_daily_limit',
    'teacher_consecutive_limit',
    'subject_morning',
    'subject_spread',
]);

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_WORD_TO_NUMBER = new Map([
    ['一', 1],
    ['二', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['日', 7],
    ['天', 7],
]);

function cloneValue(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function byId(items = []) {
    return new Map(items.map(item => [item.id, item]));
}

function itemName(item, fallback = '') {
    return item?.name || item?.className || item?.label || fallback;
}

function resolveName(map, id, fallback) {
    return itemName(map.get(id), fallback || id || '未指定对象');
}

function uniqueValues(items = [], limit = 5) {
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

function asCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function rowWarnings(row = {}) {
    return Array.isArray(row.warnings) ? row.warnings.map(String).filter(Boolean) : [];
}

function rowTitle(row = {}, project = {}) {
    return row.description
        || row.rawText
        || explainConstraintToUser(row, project)
        || '待复核约束';
}

function compactGroup(group = {}) {
    return {
        type: String(group.type || 'issue'),
        label: String(group.label || '待处理'),
        count: asCount(group.count),
        examples: uniqueValues(group.examples || [], 3),
        relatedRuleIds: uniqueValues(group.relatedRuleIds || [], 40),
    };
}

function addDerivedGroup(groups, group) {
    const next = compactGroup(group);
    if (next.count) groups.push(next);
}

function deriveGroupsFromConstraints(constraints = [], project = {}) {
    const groups = [];
    const missingSlots = constraints.filter(row => rowWarnings(row).some(warning => /缺少明确节次/.test(warning)));
    const outOfRange = constraints.filter(row => rowWarnings(row).some(warning => /不在当前排课范围内/.test(warning)));
    const allClasses = constraints.filter(row => rowWarnings(row).some(warning => /全部班级.*没有匹配对象/.test(warning)));
    const needReview = constraints.filter(row => ['needs_review', 'invalid'].includes(row.status));
    const unsupported = constraints.filter(row => ['unsupported', 'suggestion'].includes(row.status));
    const warnings = constraints.flatMap(row => rowWarnings(row));

    addDerivedGroup(groups, {
        type: 'missing_slots',
        label: '缺少明确节次',
        count: missingSlots.length,
        examples: missingSlots.flatMap(row => rowWarnings(row)),
        relatedRuleIds: missingSlots.map(row => row.id),
    });
    addDerivedGroup(groups, {
        type: 'out_of_range_slots',
        label: '节次超出范围',
        count: outOfRange.length,
        examples: outOfRange.flatMap(row => rowWarnings(row)),
        relatedRuleIds: outOfRange.map(row => row.id),
    });
    addDerivedGroup(groups, {
        type: 'all_classes_unmatched',
        label: '全部班级未匹配',
        count: allClasses.length,
        examples: allClasses.flatMap(row => rowWarnings(row)),
        relatedRuleIds: allClasses.map(row => row.id),
    });
    addDerivedGroup(groups, {
        type: 'need_review',
        label: '需要复核',
        count: needReview.length,
        examples: needReview.map(row => rowTitle(row, project)),
        relatedRuleIds: needReview.map(row => row.id),
    });
    addDerivedGroup(groups, {
        type: 'unsupported',
        label: '暂不支持',
        count: unsupported.length,
        examples: unsupported.map(row => rowTitle(row, project)),
        relatedRuleIds: unsupported.map(row => row.id),
    });
    addDerivedGroup(groups, {
        type: 'warnings',
        label: '解析提醒',
        count: warnings.length,
        examples: warnings,
    });

    return groups;
}

function buildSuggestedPrompts(groups = [], counts = {}) {
    const types = new Set(groups.map(group => group.type));
    const prompts = [];
    if (types.has('missing_slots') || types.has('missing_info') || counts.needsInput) {
        prompts.push('先处理缺少明确节次的问题');
    }
    if (types.has('out_of_range_slots')) {
        prompts.push('过滤不在当前排课范围内的第8-10节');
    }
    if (types.has('all_classes_unmatched')) {
        prompts.push('把全部班级展开为当前所有班级');
    }
    if (counts.needReview || types.has('need_review')) {
        prompts.push('解释需要复核的约束里哪些最影响排课');
    }
    if (counts.unsupported || types.has('unsupported')) {
        prompts.push('说明暂不支持的建议如何人工处理');
    }
    return uniqueValues(prompts, 5);
}

function normalizeReviewContext(reviewContext = {}, constraints = [], project = {}) {
    const derivedGroups = deriveGroupsFromConstraints(constraints, project);
    const groups = (Array.isArray(reviewContext.groups) && reviewContext.groups.length
        ? reviewContext.groups
        : derivedGroups
    ).map(compactGroup).filter(group => group.count);

    const counts = {
        total: asCount(reviewContext.counts?.total) || constraints.length,
        autoAcceptable: asCount(reviewContext.counts?.autoAcceptable),
        needsInput: asCount(reviewContext.counts?.needsInput),
        needReview: asCount(reviewContext.counts?.needReview),
        unsupported: asCount(reviewContext.counts?.unsupported),
        warnings: asCount(reviewContext.counts?.warnings),
        conflicts: asCount(reviewContext.counts?.conflicts),
        ...Object.fromEntries(Object.entries(reviewContext.counts || {}).map(([key, value]) => [key, asCount(value)])),
    };

    for (const group of groups) {
        if (group.type === 'missing_slots' || group.type === 'missing_info' || group.type === 'clarifying_questions') {
            counts.needsInput ||= group.count;
        }
        if (group.type === 'need_review') counts.needReview ||= group.count;
        if (group.type === 'unsupported') counts.unsupported ||= group.count;
        if (group.type === 'warnings') counts.warnings ||= group.count;
        if (group.type === 'conflicts') counts.conflicts ||= group.count;
    }

    const suggestedPrompts = uniqueValues(
        reviewContext.suggestedPrompts?.length
            ? reviewContext.suggestedPrompts
            : buildSuggestedPrompts(groups, counts),
        5
    );

    return {
        counts,
        groups,
        nextAction: String(reviewContext.nextAction || ''),
        suggestedPrompts,
    };
}

function activeWeekdays(project = {}) {
    const values = Array.isArray(project.activeWeekdays) && project.activeWeekdays.length
        ? project.activeWeekdays
        : [1, 2, 3, 4, 5];
    return values.map(Number).filter(day => day >= 1 && day <= 7);
}

function activePeriods(project = {}) {
    const values = Array.isArray(project.activePeriods) && project.activePeriods.length
        ? project.activePeriods
        : [1, 2, 3, 4, 5, 6, 7];
    return values.map(Number).filter(period => period >= 1);
}

function slotKey(day, period) {
    return `${Number(day)}-${Number(period)}`;
}

function slotInProject(slot, project = {}) {
    const match = String(slot || '').match(/^(\d+)-(\d+)$/);
    if (!match) return false;
    const days = new Set(activeWeekdays(project));
    const periods = new Set(activePeriods(project));
    return days.has(Number(match[1])) && periods.has(Number(match[2]));
}

function extractDaysFromMessage(message, project = {}) {
    const text = String(message || '');
    const allowed = new Set(activeWeekdays(project));
    if (/周一\s*(到|至|-)\s*周五|星期一\s*(到|至|-)\s*星期五|工作日|每天|每日/.test(text)) {
        return [1, 2, 3, 4, 5].filter(day => allowed.has(day));
    }

    const days = new Set();
    const matcher = /(?:周|星期)([一二三四五六日天])/g;
    let match;
    while ((match = matcher.exec(text))) {
        const day = DAY_WORD_TO_NUMBER.get(match[1]);
        if (allowed.has(day)) days.add(day);
    }
    return days.size ? [...days].sort((a, b) => a - b) : activeWeekdays(project);
}

function extractPeriodsFromMessage(message, project = {}) {
    const text = String(message || '');
    const allowed = new Set(activePeriods(project));
    const periods = new Set();
    const rangeMatcher = /第?\s*(\d{1,2})\s*(?:到|至|-)\s*(\d{1,2})\s*节/g;
    let rangeMatch;
    while ((rangeMatch = rangeMatcher.exec(text))) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        for (let period = Math.min(start, end); period <= Math.max(start, end); period += 1) {
            if (allowed.has(period)) periods.add(period);
        }
    }

    const singleMatcher = /第\s*(\d{1,2})\s*节/g;
    let match;
    while ((match = singleMatcher.exec(text))) {
        const period = Number(match[1]);
        if (allowed.has(period)) periods.add(period);
    }
    return [...periods].sort((a, b) => a - b);
}

function extractSlotKeysFromMessage(message, project = {}) {
    const explicitSlots = [...String(message || '').matchAll(/\b([1-7])-([1-9]\d?)\b/g)]
        .map(match => slotKey(match[1], match[2]))
        .filter(slot => slotInProject(slot, project));
    if (explicitSlots.length) return uniqueValues(explicitSlots, 80).sort();

    const days = extractDaysFromMessage(message, project);
    const periods = extractPeriodsFromMessage(message, project);
    if (!days.length || !periods.length) return [];
    return days.flatMap(day => periods.map(period => slotKey(day, period))).sort((a, b) => {
        const [dayA, periodA] = a.split('-').map(Number);
        const [dayB, periodB] = b.split('-').map(Number);
        return dayA - dayB || periodA - periodB;
    });
}

function removeWarnings(row = {}, pattern) {
    return rowWarnings(row).filter(warning => !pattern.test(warning));
}

function rowNeedsSlots(row = {}) {
    return SLOT_REQUIRED_TYPES.has(row.type);
}

function maybeEffective(row = {}) {
    if (!SUPPORTED_TYPES.has(row.type)) return row.status || 'needs_review';
    if (rowNeedsSlots(row) && !(row.slots || []).length) return 'needs_review';
    return rowWarnings(row).length ? (row.status || 'needs_review') : 'effective';
}

export function explainConstraintToUser(constraint = {}, project = {}) {
    const teachers = byId(project.teachers || []);
    const classes = byId(project.classes || []);
    const subjects = byId(project.subjects || []);

    const teacher = constraint.targetName
        || resolveName(teachers, constraint.teacherId || constraint.targetId, '教师');
    const klass = constraint.className
        || resolveName(classes, constraint.classId || constraint.targetId, '班级');
    const subject = constraint.subjectName
        || resolveName(subjects, constraint.subjectId || constraint.targetId, '课程');
    const value = constraint.value ?? constraint.limit ?? '默认';
    const slotText = formatSlots(constraint.slots || constraint.periods || []);

    switch (constraint.type) {
        case 'teacher_daily_limit':
            return `${teacher} 每天最多上 ${value} 节课`;
        case 'teacher_consecutive_limit':
            return `${teacher} 连续上课不超过 ${value} 节`;
        case 'teacher_unavailable':
            return `${teacher} 在 ${slotText} 不可排课`;
        case 'class_unavailable':
            return `${klass} 在 ${slotText} 不可排课`;
        case 'locked_slot':
            return `${teacher} 给 ${klass} 上 ${subject}，固定在 ${slotText}`;
        case 'subject_morning':
            return `${subject} 优先安排在上午`;
        case 'subject_preferred_periods':
            return `${subject} 优先安排在 ${slotText}`;
        case 'subject_avoid_periods':
            return `${subject} 避开 ${slotText}`;
        case 'subject_spread':
            return `${subject} 尽量分散到不同日期`;
        case 'teacher_load_balance':
            return `${teacher} 的工作量尽量均衡`;
        case 'class_daily_balance':
            return `${klass} 每天的课程尽量均衡`;
        default:
            return constraint.description || constraint.rawText || `${constraint.type || '未知'} 约束`;
    }
}

export function formatSlots(slots = []) {
    if (!Array.isArray(slots) || !slots.length) return '指定时段';
    return slots.map(slot => {
        if (typeof slot === 'object' && slot) {
            const day = Number(slot.day);
            const period = Number(slot.period);
            if (Number.isFinite(day) && Number.isFinite(period)) {
                return `${WEEKDAY_NAMES[day - 1] || `周${day}`}第 ${period} 节`;
            }
        }
        const match = String(slot).match(/^(\d+)-(\d+)$/);
        if (!match) return String(slot);
        const day = Number(match[1]);
        const period = Number(match[2]);
        return `${WEEKDAY_NAMES[day - 1] || `周${day}`}第 ${period} 节`;
    }).join('、');
}

export class TimetableConstraintConversation {
    constructor() {
        this.history = [];
        this.constraints = [];
        this.project = {};
        this.reviewContext = normalizeReviewContext();
        this.suggestedPrompts = [];
        this.pendingPreview = null;
    }

    initialize(constraints = [], project = {}, reviewContext = {}) {
        if (!Array.isArray(constraints)) {
            throw new Error('constraints 必须是数组。');
        }

        this.constraints = cloneValue(constraints) || [];
        this.project = cloneValue(project) || {};
        this.reviewContext = normalizeReviewContext(reviewContext, this.constraints, this.project);
        this.suggestedPrompts = this.reviewContext.suggestedPrompts;
        this.history = [{
            role: 'assistant',
            content: this.generateWelcomeMessage(),
            timestamp: Date.now(),
        }];
    }

    generateWelcomeMessage() {
        const { counts, groups } = this.reviewContext;
        if (groups.length) {
            const summary = [
                counts.needsInput ? `${counts.needsInput} 条需要补充信息` : '',
                counts.needReview ? `${counts.needReview} 条需要复核` : '',
                counts.unsupported ? `${counts.unsupported} 条暂不支持` : '',
                counts.warnings ? `${counts.warnings} 条解析提醒` : '',
                counts.conflicts ? `${counts.conflicts} 条冲突风险` : '',
            ].filter(Boolean).join('，');
            const agenda = groups.slice(0, 4).map((group, index) => {
                const example = group.examples?.[0] ? `：${group.examples[0]}` : '';
                return `${index + 1}. ${group.label} ${group.count} 条${example}`;
            }).join('\n');
            const prompts = this.suggestedPrompts.length
                ? `\n\n我建议先点一个动作：\n${this.suggestedPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}`
                : '';
            return `我们先围绕当前复核结果讨论，不泛聊。\n\n当前重点：${summary || `${this.constraints.length} 条约束待处理`}。\n\n优先处理：\n${agenda}${prompts}`;
        }

        const examples = this.constraints
            .slice(0, 3)
            .map((constraint, index) => `${index + 1}. ${explainConstraintToUser(constraint, this.project)}`)
            .join('\n');
        return `我已经读取到 ${this.constraints.length} 条排课约束。\n\n${examples || '还没有可展示的约束。'}\n\n你可以让我解释约束、调整数值、删除不需要的规则，或回复“确认”完成优化。`;
    }

    async chat(userMessage, env = {}, fetchImpl = globalThis.fetch, options = {}) {
        const message = String(userMessage || '').trim();
        if (!message) throw new Error('message 不能为空。');

        this.history.push({ role: 'user', content: message, timestamp: Date.now() });
        const intent = this.recognizeIntent(message);
        const response = await this.respond(message, {
            ...intent,
            requestedIntent: options.intent || '',
            taskContext: options.taskContext || null,
        }, env, fetchImpl);
        this.reviewContext = normalizeReviewContext(this.reviewContext, this.constraints, this.project);
        this.suggestedPrompts = response.suggestedPrompts || this.reviewContext.suggestedPrompts;

        this.history.push({
            role: 'assistant',
            content: response.message,
            timestamp: Date.now(),
        });

        return {
            message: response.message,
            explanation: response.explanation || null,
            constraints: this.constraints,
            suggestedActions: response.actions || [],
            actionPreview: response.actionPreview || null,
            reviewContext: this.reviewContext,
            suggestedPrompts: this.suggestedPrompts,
            completed: Boolean(response.completed),
        };
    }

    recognizeIntent(message) {
        const normalized = message.trim().toLowerCase();
        const entities = this.extractEntities(message);

        if (/^(确认|可以|没问题|就这样|完成|好了|ok|okay|yes)$/i.test(normalized)) {
            return { type: 'confirm', confidence: 0.95, entities };
        }
        if (/(为什么|解释|含义|什么意思|怎么看|说明)/.test(normalized) || /[?？]$/.test(normalized)) {
            return { type: 'query', confidence: 0.85, entities };
        }
        if (/(过滤|忽略|移除|删除).*(超出范围|不在当前排课范围|第?8|第?9|第?10)/.test(normalized)) {
            return { type: 'filter_out_of_range', confidence: 0.9, entities };
        }
        if (/(展开|按.*所有|按.*全部|所有班级|全部班级).*(班级|当前)/.test(normalized)) {
            return { type: 'expand_all_classes', confidence: 0.86, entities };
        }
        if (/(删除|取消|移除|不要).*(约束|规则)?/.test(normalized)) {
            return { type: 'delete', confidence: 0.85, entities };
        }
        if (/(改成|调整|修改|最多|不超过|限制|换成|设为)/.test(normalized)) {
            return { type: 'modify', confidence: 0.8, entities };
        }
        return { type: 'general', confidence: 0.5, entities };
    }

    extractEntities(message) {
        const entities = {
            teachers: [],
            classes: [],
            subjects: [],
            numbers: [],
        };
        for (const teacher of this.project.teachers || []) {
            if (teacher.name && message.includes(teacher.name)) {
                entities.teachers.push({ id: teacher.id, name: teacher.name });
            }
        }
        for (const klass of this.project.classes || []) {
            const name = itemName(klass);
            if (name && message.includes(name)) {
                entities.classes.push({ id: klass.id, name });
            }
        }
        for (const subject of this.project.subjects || []) {
            if (subject.name && message.includes(subject.name)) {
                entities.subjects.push({ id: subject.id, name: subject.name });
            }
        }
        const numbers = message.match(/\d+/g);
        if (numbers) entities.numbers = numbers.map(Number);
        return entities;
    }

    async respond(message, intent, env, fetchImpl) {
        if (intent.requestedIntent === 'apply_preview') {
            const applied = this.applyPendingPreview();
            if (applied) return applied;
        }
        if (intent.requestedIntent === 'preview_fix') {
            const preview = this.buildActionPreview(intent.taskContext, message);
            if (preview) {
                this.pendingPreview = preview;
                return {
                    message: `问题是什么：${this.explainTaskProblem(intent.taskContext)}\n\n建议怎么处理：先查看下面的修改预览。\n\n准备改成什么：${preview.after}`,
                    explanation: this.buildTaskExplanation(intent.taskContext),
                    actionPreview: preview,
                    actions: [{ type: 'preview_fix', taskId: intent.taskContext?.taskId || '' }],
                };
            }
        }
        if (intent.requestedIntent === 'explain') {
            return {
                message: `问题是什么：${this.explainTaskProblem(intent.taskContext)}\n\n建议怎么处理：${this.explainTaskAction(intent.taskContext)}\n\n准备改成什么：如果需要修改，请先点“帮我生成修正”，我会先给预览。`,
                explanation: this.buildTaskExplanation(intent.taskContext),
                actionPreview: null,
            };
        }

        const slotResult = this.applyMissingSlotsFromMessage(message);
        if (slotResult) return slotResult;

        if (intent.type === 'filter_out_of_range') {
            const result = this.filterOutOfRangeSlots();
            if (result) return result;
        }
        if (intent.type === 'expand_all_classes') {
            const result = this.expandAllClasses();
            if (result) return result;
        }
        if (intent.type === 'confirm') return this.handleConfirm();
        if (intent.type === 'modify') {
            const localResult = this.applySimpleModification(intent.entities);
            if (localResult) return localResult;
        }
        if (intent.type === 'delete') {
            const localResult = this.applySimpleDelete(intent.entities);
            if (localResult) return localResult;
        }

        const aiMessage = await this.callAI({
            instruction: this.instructionForIntent(intent.type),
            userMessage: message,
        }, env, fetchImpl);
        return { message: aiMessage };
    }

    taskRows(taskContext = null) {
        const ids = new Set(taskContext?.relatedRuleIds || []);
        if (!ids.size) return this.constraints;
        return this.constraints.filter(row => ids.has(row.id));
    }

    explainTaskProblem(taskContext = null) {
        const example = taskContext?.examples?.[0] || '';
        const type = taskContext?.taskType || taskContext?.taskId || '';
        if (/out_of_range|slot/.test(type)) {
            return example || '有些节次不在当前排课范围内，系统不能直接写入。';
        }
        if (/clarifying|teacher|subject|class|confirm/.test(type)) {
            return example || '系统找到了多个可能对象，不能替你猜是哪一个。';
        }
        if (/conflict/.test(type)) {
            return example || '存在可能互相矛盾的硬约束，需要先确认取舍。';
        }
        if (/unsupported/.test(type)) {
            return example || '这类要求当前只能作为建议，不能直接由排课器执行。';
        }
        return example || '这项约束还需要复核后才能安全生效。';
    }

    explainTaskAction(taskContext = null) {
        const type = taskContext?.taskType || taskContext?.taskId || '';
        if (/out_of_range|slot/.test(type)) return '删除超出范围的节次，或改成当前排课范围内的节次。';
        if (/clarifying|teacher|subject|class|confirm/.test(type)) return '从候选里选择真实对象；没有候选时先回任课数据补充。';
        if (/conflict/.test(type)) return '保留更重要的硬约束，删除或放宽另一条。';
        if (/unsupported/.test(type)) return '把它留作建议，后续通过人工调整或质量优化处理。';
        return '先核对对象、节次和强弱，再确认是否生效。';
    }

    buildTaskExplanation(taskContext = null) {
        return {
            problem: this.explainTaskProblem(taskContext),
            recommendation: this.explainTaskAction(taskContext),
            relatedRuleIds: taskContext?.relatedRuleIds || [],
            examples: taskContext?.examples || [],
        };
    }

    buildActionPreview(taskContext = null, message = '') {
        const type = `${taskContext?.taskType || ''} ${taskContext?.taskId || ''}`;
        if (/out_of_range|slot/.test(type)) {
            return this.previewFilterOutOfRangeSlots(taskContext);
        }
        const slots = extractSlotKeysFromMessage(message, this.project);
        if (slots.length) return this.previewFillMissingSlots(taskContext, slots);
        return null;
    }

    previewFilterOutOfRangeSlots(taskContext = null) {
        const changes = [];
        for (const row of this.taskRows(taskContext)) {
            const beforeSlots = row.slots || [];
            const nextSlots = beforeSlots.filter(slot => slotInProject(slot, this.project));
            const hasRangeWarning = rowWarnings(row).some(warning => /不在当前排课范围内/.test(warning));
            if (!hasRangeWarning && nextSlots.length === beforeSlots.length) continue;
            const next = {
                ...row,
                slots: nextSlots,
                warnings: rowWarnings(row).filter(warning => !/不在当前排课范围内/.test(warning)),
            };
            changes.push({
                ruleId: row.id,
                reason: `${rowTitle(row, this.project)}：过滤超出范围节次`,
                updates: {
                    slots: nextSlots,
                    warnings: next.warnings,
                    status: maybeEffective(next),
                },
            });
        }
        if (!changes.length) return null;
        return {
            title: '过滤超出范围节次',
            before: '包含当前排课范围外的节次',
            after: '只保留当前排课范围内节次',
            affectedRuleIds: changes.map(change => change.ruleId),
            changes,
            requiresConfirmation: true,
        };
    }

    previewFillMissingSlots(taskContext = null, slots = []) {
        const changes = [];
        for (const row of this.taskRows(taskContext)) {
            const hasMissingWarning = rowWarnings(row).some(warning => /缺少明确节次/.test(warning));
            if (!hasMissingWarning && !((rowNeedsSlots(row) && !(row.slots || []).length))) continue;
            const next = {
                ...row,
                slots,
                warnings: removeWarnings(row, /缺少明确节次/),
            };
            changes.push({
                ruleId: row.id,
                reason: `${rowTitle(row, this.project)}：补充节次`,
                updates: {
                    slots,
                    warnings: next.warnings,
                    status: maybeEffective(next),
                },
            });
        }
        if (!changes.length) return null;
        return {
            title: '补充缺少的节次',
            before: '缺少明确节次',
            after: `改为 ${formatSlots(slots)}`,
            affectedRuleIds: changes.map(change => change.ruleId),
            changes,
            requiresConfirmation: true,
        };
    }

    applyPendingPreview() {
        const preview = this.pendingPreview;
        if (!preview?.changes?.length) return null;
        const changeById = new Map(preview.changes.map(change => [change.ruleId, change]));
        this.constraints = this.constraints.map(row => {
            const change = changeById.get(row.id);
            return change ? { ...row, ...(change.updates || {}) } : row;
        });
        this.pendingPreview = null;
        return {
            message: `已应用“${preview.title || '修正预览'}”到草稿。请回到复核表确认后生效。`,
            explanation: {
                problem: '修正已应用到草稿。',
                recommendation: '继续核对草稿，然后确认生效。',
                relatedRuleIds: preview.affectedRuleIds || [],
                examples: [],
            },
            actionPreview: null,
            actions: [{ type: 'apply_preview', count: preview.changes.length }],
        };
    }

    unresolvedCount() {
        return this.constraints.filter(row => (
            ['needs_review', 'invalid'].includes(row.status)
            || rowWarnings(row).length
            || ['unsupported', 'suggestion'].includes(row.status)
        )).length;
    }

    handleConfirm() {
        const unresolved = this.unresolvedCount();
        if (unresolved) {
            return {
                message: `还有 ${unresolved} 条约束未处理完成，建议先处理当前复核重点后再确认。`,
                completed: false,
            };
        }
        return {
            message: `好的，约束优化完成。当前共有 ${this.constraints.length} 条约束，可以确认生效。`,
            completed: true,
        };
    }

    applyMissingSlotsFromMessage(message) {
        if (!/(缺少|补充|统一|设为|改成|第\s*\d+\s*节)/.test(message)) return null;
        const slots = extractSlotKeysFromMessage(message, this.project);
        if (!slots.length) return null;

        let changed = 0;
        this.constraints = this.constraints.map(row => {
            const hasMissingWarning = rowWarnings(row).some(warning => /缺少明确节次/.test(warning));
            if (!hasMissingWarning && !((rowNeedsSlots(row) && !(row.slots || []).length))) return row;
            const warnings = removeWarnings(row, /缺少明确节次/);
            changed += 1;
            const next = {
                ...row,
                slots,
                warnings,
            };
            return {
                ...next,
                status: maybeEffective(next),
            };
        });

        if (!changed) return null;
        return {
            message: `已为 ${changed} 条缺少节次的约束补充 ${formatSlots(slots)}。请继续复核剩余问题。`,
            actions: [{ type: 'fill_missing_slots', slots, count: changed }],
        };
    }

    filterOutOfRangeSlots() {
        let changed = 0;
        this.constraints = this.constraints.map(row => {
            const warnings = rowWarnings(row);
            const hasRangeWarning = warnings.some(warning => /不在当前排课范围内/.test(warning));
            if (!hasRangeWarning && !(row.slots || []).some(slot => !slotInProject(slot, this.project))) return row;
            const slots = (row.slots || []).filter(slot => slotInProject(slot, this.project));
            const next = {
                ...row,
                slots,
                warnings: warnings.filter(warning => !/不在当前排课范围内/.test(warning)),
            };
            changed += 1;
            return {
                ...next,
                status: maybeEffective(next),
            };
        });
        if (!changed) return null;
        return {
            message: `已过滤 ${changed} 条约束中不在当前排课范围内的节次。若过滤后没有节次，请继续补充新的可用节次。`,
            actions: [{ type: 'filter_out_of_range_slots', count: changed }],
        };
    }

    expandAllClasses() {
        const classes = this.project.classes || [];
        if (!classes.length) return null;
        let changed = 0;
        const nextRows = [];
        for (const row of this.constraints) {
            const mentionsAllClasses = /全部班级|所有班级/.test(`${row.targetName || ''}${row.targetId || ''}${row.rawText || ''}${row.className || ''}`)
                || rowWarnings(row).some(warning => /全部班级.*没有匹配对象/.test(warning));
            if (row.type !== 'class_unavailable' || !mentionsAllClasses) {
                nextRows.push(row);
                continue;
            }
            changed += 1;
            for (const klass of classes) {
                const warnings = rowWarnings(row).filter(warning => !/全部班级.*没有匹配对象/.test(warning));
                const next = {
                    ...row,
                    id: `${row.id || 'class_rule'}_${klass.id}`,
                    targetType: 'class',
                    targetId: klass.id,
                    targetName: itemName(klass, klass.id),
                    classId: klass.id,
                    className: itemName(klass, klass.id),
                    warnings,
                };
                nextRows.push({ ...next, status: maybeEffective(next) });
            }
        }
        if (!changed) return null;
        this.constraints = nextRows;
        return {
            message: `已把 ${changed} 条“全部班级”规则展开为 ${classes.length} 个当前班级的规则。`,
            actions: [{ type: 'expand_all_classes', sourceCount: changed, classCount: classes.length }],
        };
    }

    instructionForIntent(intentType) {
        const instructions = {
            query: '用户在询问约束含义，请优先解释当前复核重点，并指出对求解的影响。',
            modify: '用户想调整约束。请先说明理解到的修改目标，再给出可以在复核表落地的建议。',
            delete: '用户想删除约束。请说明你识别到的目标，并提醒删除会影响哪些复核项。',
            general: '用户正在讨论排课约束，请围绕当前未解决的缺信息、需复核、暂不支持或解析提醒给出下一步。',
        };
        return instructions[intentType] || instructions.general;
    }

    applySimpleModification(entities) {
        const teacher = entities.teachers[0];
        const value = entities.numbers[0];
        if (!teacher || !Number.isFinite(value)) return null;
        const index = this.constraints.findIndex(constraint => {
            const typeMatches = ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(constraint.type);
            const targetMatches = constraint.targetId === teacher.id
                || constraint.teacherId === teacher.id
                || constraint.targetName === teacher.name;
            return typeMatches && targetMatches;
        });
        if (index < 0) return null;

        const previous = this.constraints[index];
        const description = previous.type === 'teacher_consecutive_limit'
            ? `${teacher.name} 连续上课不超过 ${value} 节`
            : `${teacher.name} 每天最多上 ${value} 节课`;
        this.constraints[index] = {
            ...previous,
            value,
            description,
            status: previous.status === 'invalid' ? 'needs_review' : previous.status,
        };
        return {
            message: `已把 ${teacher.name} 的约束调整为 ${value} 节。请在复核表中确认后生效。`,
            actions: [{
                type: 'modify',
                targetConstraintId: previous.id,
                changes: { value },
            }],
        };
    }

    applySimpleDelete(entities) {
        const candidates = [
            ...entities.teachers,
            ...entities.classes,
            ...entities.subjects,
        ];
        if (!candidates.length) return null;

        const names = new Set(candidates.map(item => item.name));
        const ids = new Set(candidates.map(item => item.id));
        const before = this.constraints.length;
        this.constraints = this.constraints.filter(constraint => (
            !ids.has(constraint.targetId)
            && !ids.has(constraint.teacherId)
            && !ids.has(constraint.classId)
            && !ids.has(constraint.subjectId)
            && !names.has(constraint.targetName)
            && !names.has(constraint.className)
            && !names.has(constraint.subjectName)
        ));
        const removed = before - this.constraints.length;
        if (!removed) return null;
        return {
            message: `已移除 ${removed} 条相关约束，请复核后确认生效。`,
            actions: [{ type: 'delete', count: removed }],
        };
    }

    async callAI({ instruction, userMessage }, env = {}, fetchImpl = globalThis.fetch) {
        const apiKey = env.AI_API_KEY;
        const baseUrl = env.AI_BASE_URL || 'https://api.anthropic.com';
        const model = env.AI_MODEL || 'claude-3-5-sonnet-20241022';
        if (!apiKey || typeof fetchImpl !== 'function') return this.fallbackResponse(userMessage);

        const constraintList = this.constraints
            .slice(0, 80)
            .map((constraint, index) => `${index + 1}. ${explainConstraintToUser(constraint, this.project)}；状态=${constraint.status || 'unknown'}；提醒=${rowWarnings(constraint).join('；') || '无'}`)
            .join('\n');
        const reviewJson = JSON.stringify(this.reviewContext).slice(0, 6000);
        const system = `你是 ICeCream 排课系统的约束复核助手。你必须优先围绕当前 unresolved reviewContext 讨论，不要泛泛聊天。\n\nreviewContext:\n${reviewJson}\n\n当前约束摘要：\n${constraintList || '暂无约束'}\n\n${instruction}`;
        const messages = this.history
            .slice(-6)
            .filter(item => ['user', 'assistant'].includes(item.role))
            .map(item => ({ role: item.role, content: item.content }));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetchImpl(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 900,
                    system,
                    messages,
                }),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`AI request failed with status ${response.status}`);
            const data = await response.json();
            return data.content?.[0]?.text || this.fallbackResponse(userMessage);
        } catch (error) {
            console.error('Constraint AI call failed:', error);
            return this.fallbackResponse(userMessage);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    fallbackResponse(userMessage) {
        const lower = String(userMessage || '').toLowerCase();
        const focus = this.reviewContext.groups?.[0];
        if (/(为什么|解释|含义|什么意思|说明)/.test(lower) || /[?？]$/.test(lower)) {
            const agenda = this.reviewContext.groups
                .slice(0, 4)
                .map((group, index) => `${index + 1}. ${group.label} ${group.count} 条${group.examples?.[0] ? `：${group.examples[0]}` : ''}`)
                .join('\n');
            return `当前最需要处理的是复核问题，而不是重新泛化解释约束：\n\n${agenda || '暂无未解决重点。'}\n\n建议先回答第一类问题，处理完后再确认生效。`;
        }
        if (/(删除|取消|移除|不要)/.test(lower)) {
            return '请带上教师、班级、课程或行内容再删除；如果只是处理当前问题，建议先点“过滤超出范围节次”或“展开全部班级”。';
        }
        if (/(改成|调整|修改|最多|不超过|限制|换成|设为)/.test(lower)) {
            return '可以直接给出可落地答案，例如“把缺少节次的约束统一设为周一到周五第7节”。我会把它写回草稿约束。';
        }
        return focus
            ? `建议先处理“${focus.label}”：${focus.examples?.[0] || '请补充具体处理方式'}`
            : '我可以围绕当前复核结果处理缺信息、需复核、暂不支持和解析提醒。';
    }
}
