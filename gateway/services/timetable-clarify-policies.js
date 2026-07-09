import { getActivePeriods } from './timetable-project.js';

function text(value = '', max = 240) {
    return String(value ?? '').trim().slice(0, max);
}

function numberValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function maxPeriod(project = {}) {
    return Math.max(3, Number(project.periodsPerDay) || getActivePeriods(project).length || 8);
}

function numberQuestion(id = '', field = '', question = '', defaultValue = 3, project = {}) {
    return {
        id: `clarify_${id}_${field}`,
        kind: 'number',
        field,
        question,
        defaultValue,
        min: 1,
        max: maxPeriod(project),
    };
}

function choiceQuestion(id = '', field = '', question = '', options = []) {
    return {
        id: `clarify_${id}_${field}`,
        kind: 'choice',
        field,
        question,
        options,
    };
}

function option(label = '', value = '') {
    return { label, value: String(value) };
}

function normalizeDailyLimit(parameters = {}) {
    const value = text(parameters.dailyLimit || parameters.maxDaily || '', 40);
    if (!value) return parameters;
    if (value === 'none' || value === 'no' || value === 'skip') {
        return { ...parameters, dailyLimit: 'none' };
    }
    const daily = numberValue(value);
    if (!daily) return parameters;
    return { ...parameters, dailyLimit: String(daily), maxDaily: daily };
}

export function nextClarificationForRequirement(project = {}, requirement = {}) {
    const id = text(requirement.id || 'requirement', 120);
    const intent = text(requirement.intent || '', 120);
    const parameters = normalizeDailyLimit(requirement.parameters || {});

    if (intent === 'teacher_load_protection') {
        if (!numberValue(parameters.maxConsecutive)) {
            return {
                parameters,
                clarification: numberQuestion(id, 'maxConsecutive', '连续超过几节算太密？', 3, project),
                status: 'needs_review',
                applyTo: requirement.applyTo || 'optimization',
            };
        }
        if (!parameters.dailyLimit) {
            return {
                parameters,
                clarification: choiceQuestion(id, 'dailyLimit', '还要限制每天最多几节吗？', [
                    option('不限制每日上限', 'none'),
                    option('每天最多 4 节', '4'),
                    option('每天最多 5 节', '5'),
                ]),
                status: 'needs_review',
                applyTo: requirement.applyTo || 'optimization',
            };
        }
        return {
            parameters,
            clarification: null,
            status: 'actionable',
            applyTo: requirement.applyTo || 'optimization',
        };
    }

    if (intent === 'room_requirement') {
        const hasRoom = text(parameters.roomName || '', 120)
            || (Array.isArray(parameters.roomIds) && parameters.roomIds.length)
            || (Array.isArray(parameters.requiredTags) && parameters.requiredTags.length);
        if (!hasRoom) {
            const roomOptions = (project.rooms || []).slice(0, 6).map(room => option(room.name || room.id, room.name || room.id));
            return {
                parameters,
                clarification: choiceQuestion(id, 'roomName', '这门课需要哪个教室或场地？', roomOptions),
                status: 'needs_review',
                applyTo: requirement.applyTo || 'rule',
            };
        }
    }

    if (['preferred_periods', 'avoid_periods', 'unavailable_periods'].includes(intent)) {
        const hasSlots = Array.isArray(parameters.slots) && parameters.slots.length;
        const hasDayPart = text(parameters.dayPart || parameters.periods || '', 80);
        if (!hasSlots && !hasDayPart) {
            return {
                parameters,
                clarification: choiceQuestion(id, 'dayPart', '你希望这个需求对应哪个时段？', [
                    option('上午', 'morning'),
                    option('下午', 'afternoon'),
                    option('每天第一节', 'first_period'),
                    option('每天最后一节', 'last_period'),
                ]),
                status: 'needs_review',
                applyTo: requirement.applyTo || 'rule',
            };
        }
    }

    if (['teacher_daily_limit', 'teacher_consecutive_limit', 'teacher_weekly_limit', 'teacher_max_days_per_week', 'subject_daily_limit'].includes(intent)) {
        if (!numberValue(parameters.limit || parameters.max || parameters.maxConsecutive || parameters.maxDays)) {
            return {
                parameters,
                clarification: numberQuestion(id, 'limit', '这个上限是多少节或多少天？', 3, project),
                status: 'needs_review',
                applyTo: requirement.applyTo || 'rule',
            };
        }
    }

    if (intent === 'block_preference' && !text(parameters.blockPreference || '', 40)) {
        return {
            parameters,
            clarification: choiceQuestion(id, 'blockPreference', '这门课希望按哪种连堂方式安排？', [
                option('单节', 'single'),
                option('双连堂', 'double'),
                option('单双混合', 'mixed'),
            ]),
            status: 'needs_review',
            applyTo: requirement.applyTo || 'lesson_plan',
        };
    }

    return {
        parameters,
        clarification: requirement.clarification || null,
        status: requirement.status || 'needs_review',
        applyTo: requirement.applyTo || 'review',
    };
}

export function applyClarificationPolicy(project = {}, requirement = {}) {
    const next = { ...requirement };
    const policy = nextClarificationForRequirement(project, next);
    next.parameters = policy.parameters || next.parameters || {};
    next.clarification = policy.clarification;
    next.status = policy.status;
    next.applyTo = policy.applyTo;
    return next;
}
