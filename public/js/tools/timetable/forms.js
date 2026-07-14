import { cloneValue } from './state.js';

export function sampleRosterText() {
    return [
        '年级,班级,课程,教师,周课时,连堂,教室,课程类型,课程标签,课型,资源类型',
        '七年级,G7-1班,语文,刘书涵,5,单节,G7-01本班教室,主科,主科、晨间优先,普通课,普通教室',
        '七年级,G7-1班,物理,余思齐,2,混合,物理实验室A,实验,实验、功能教室,实验课,实验室',
    ].join('\n');
}

export function parseSlotInput(value = '') {
    return String(value)
        .split(/[,，;；\s]+/)
        .map(item => item.trim())
        .filter(item => /^\d+-\d+$/.test(item));
}

function checkedNumbers(container, selector) {
    return [...container.querySelectorAll(`${selector}:checked`)]
        .map(item => Number(item.value))
        .filter(value => Number.isInteger(value))
        .sort((left, right) => left - right);
}

function checkedValues(container, selector) {
    return [...container.querySelectorAll(`${selector}:checked`)]
        .map(item => item.value)
        .filter(Boolean);
}

function checkedTargets(container, targetType) {
    return [...container.querySelectorAll(`[data-manual-rule-target][data-manual-rule-target-type="${targetType}"]:checked`)]
        .map(input => ({
            id: input.value,
            name: input.dataset.targetName || input.value,
        }));
}

export function readProjectForm(container) {
    const activeWeekdays = checkedNumbers(container, '[data-active-weekday]');
    const activePeriods = checkedNumbers(container, '[data-active-period]');
    return {
        activeWeekdays,
        activePeriods,
        weekdays: activeWeekdays.length ? Math.max(...activeWeekdays) : 5,
        periodsPerDay: activePeriods.length ? Math.max(...activePeriods) : 7,
    };
}

export function readRulesForm(container, project) {
    const rules = cloneValue(project.rules || { hardRules: {}, softRules: {} });
    rules.hardRules = rules.hardRules || {};
    rules.softRules = rules.softRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };

    const morningSubjects = [...container.querySelectorAll('[data-morning-subject]:checked')].map(item => item.value);

    if (morningSubjects.length) rules.softRules.morningSubjects = morningSubjects;
    return rules;
}

export function readRulePrompt(container) {
    return container.querySelector('#tt-rule-review-text')?.value
        || container.querySelector('#tt-rule-prompt')?.value
        || '';
}

export function readManualRuleBuilderForm(container) {
    const type = container.querySelector('#tt-manual-rule-type')?.value || 'teacher_unavailable';
    const targetType = type === 'class_unavailable' ? 'class' : type === 'subject_morning' || type.includes('subject_') ? 'subject' : 'teacher';
    const limit = Number(container.querySelector('#tt-manual-rule-limit')?.value || 0);
    const targetGroups = {
        teacher: checkedTargets(container, 'teacher'),
        class: checkedTargets(container, 'class'),
        subject: checkedTargets(container, 'subject'),
    };
    const targets = type === 'locked_slot'
        ? []
        : targetGroups[targetType] || [];
    const days = checkedNumbers(container, '[data-manual-rule-day]');
    const periods = checkedNumbers(container, '[data-manual-rule-period]');
    return { type, targetType: type === 'locked_slot' ? 'locked_slot' : targetType, targets, targetGroups, days, periods, limit };
}

function slotsFromDaysAndPeriods(days = [], periods = []) {
    const slots = [];
    for (const day of days) {
        for (const period of periods) slots.push(`${day}-${period}`);
    }
    return slots;
}

export function buildManualRuleDraftRows(form = {}) {
    const slots = slotsFromDaysAndPeriods(form.days, form.periods);
    if (form.type === 'locked_slot') {
        const rows = [];
        const classes = form.targetGroups?.class || [];
        const subjects = form.targetGroups?.subject || [];
        const teachers = form.targetGroups?.teacher || [];
        let index = 0;
        for (const classItem of classes) {
            for (const subject of subjects) {
                for (const teacher of teachers) {
                    for (const slot of slots) {
                        rows.push({
                            id: `manual_${Date.now()}_${index}`,
                            source: 'manual',
                            rawText: `锁定 ${classItem.name} ${subject.name} ${teacher.name} ${slot}`,
                            type: 'locked_slot',
                            targetType: 'locked_slot',
                            targetId: `${classItem.id}:${subject.id}:${teacher.id}`,
                            targetName: `${classItem.name} / ${subject.name} / ${teacher.name}`,
                            classId: classItem.id,
                            className: classItem.name,
                            subjectId: subject.id,
                            subjectName: subject.name,
                            teacherId: teacher.id,
                            teacherName: teacher.name,
                            slots: [slot],
                            days: form.days,
                            periods: form.periods,
                            priority: 'hard',
                            status: 'effective',
                            confidence: 1,
                            description: '手动锁定课节',
                            warnings: [],
                        });
                        index += 1;
                    }
                }
            }
        }
        return rows;
    }
    return (form.targets || []).map((target, index) => {
        const isTeacherLimit = ['teacher_daily_limit', 'teacher_consecutive_limit'].includes(form.type);
        return {
            id: `manual_${Date.now()}_${index}`,
            source: 'manual',
            rawText: `${target.name} ${form.type}`,
            type: form.type,
            targetType: form.targetType,
            targetId: target.id,
            targetName: target.name,
            slots: form.type === 'subject_morning' || isTeacherLimit ? [] : slots,
            days: form.days,
            periods: form.periods,
            limit: isTeacherLimit ? Math.max(1, Number(form.limit) || 1) : undefined,
            priority: form.type.startsWith('subject_') || isTeacherLimit ? 'soft' : 'hard',
            status: 'effective',
            confidence: 1,
            description: '手动批量新增',
            warnings: [],
        };
    });
}

export function readBulkRuleForm(container) {
    const type = container.querySelector('#tt-bulk-rule-type')?.value || 'teacher_unavailable';
    const targetType = type === 'class_unavailable' ? 'class' : type === 'subject_morning' ? 'subject' : 'teacher';
    return {
        type,
        targetIds: checkedValues(container, `[data-bulk-target][data-bulk-target-type="${targetType}"]`),
        days: checkedNumbers(container, '[data-bulk-day]'),
        periods: checkedNumbers(container, '[data-bulk-period]'),
    };
}

function slotKeys(days, periods) {
    const result = [];
    for (const day of days) {
        for (const period of periods) result.push(`${day}-${period}`);
    }
    return result;
}

function mergeSlots(map, id, slots) {
    if (!id || !slots.length) return;
    map[id] = [...new Set([...(map[id] || []), ...slots])].sort();
}

export function buildBulkRules(project, form) {
    const rules = cloneValue(project.rules || { hardRules: {}, softRules: {} });
    rules.hardRules = rules.hardRules || {};
    rules.softRules = rules.softRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };
    rules.hardRules.lockedSlots = [...(rules.hardRules.lockedSlots || [])];
    rules.softRules.morningSubjects = [...(rules.softRules.morningSubjects || [])];

    if (form.type === 'subject_morning') {
        for (const subjectId of form.targetIds) {
            if (!rules.softRules.morningSubjects.includes(subjectId)) rules.softRules.morningSubjects.push(subjectId);
        }
        return rules;
    }

    const slots = slotKeys(form.days, form.periods);
    if (form.type === 'class_unavailable') {
        for (const classId of form.targetIds) mergeSlots(rules.hardRules.classUnavailable, classId, slots);
    } else {
        for (const teacherId of form.targetIds) mergeSlots(rules.hardRules.teacherUnavailable, teacherId, slots);
    }
    return rules;
}

export function readLockedSlotForm(container, project) {
    const locked = {
        day: Number(container.querySelector('#tt-lock-day')?.value),
        period: Number(container.querySelector('#tt-lock-period')?.value),
        classId: container.querySelector('#tt-lock-class')?.value,
        subjectId: container.querySelector('#tt-lock-subject')?.value,
        teacherId: container.querySelector('#tt-lock-teacher')?.value,
    };
    const plan = project.lessonPlans.find(item => (
        item.classId === locked.classId
        && item.subjectId === locked.subjectId
        && (item.teacherId === locked.teacherId || item.teacherIds?.includes(locked.teacherId))
    ));
    if (plan) {
        locked.lessonPlanId = plan.id;
        locked.roomId = plan.roomId || null;
    }
    return locked;
}

export function exportName(type) {
    return ({
        teacher: '教师课表',
        published_teacher: '正式教师课表',
        plans: '任课信息',
        master: '总课表',
        published_master: '正式总课表',
        class: '班级课表',
        published_class: '正式班级课表',
    })[type] || '课表';
}
