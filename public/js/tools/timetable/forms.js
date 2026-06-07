import { cloneValue } from './state.js';

export function sampleRosterText() {
    return [
        '年级,班级,课程,教师,周课时,连堂',
        '七年级,1班,数学,陈老师,4,单节',
        '七年级,1班,语文,林老师,5,混合',
        '七年级,1班,英语,周老师,4,单节',
        '七年级,1班,体育,许老师,2,双连堂',
        '七年级,2班,数学,陈老师,4,单节',
        '七年级,2班,语文,赵老师,5,混合',
        '七年级,2班,英语,周老师,4,单节',
        '七年级,2班,音乐,钱老师,1,单节',
    ].join('\n');
}

export function parseSlotInput(value = '') {
    return String(value)
        .split(/[,，;；\s]+/)
        .map(item => item.trim())
        .filter(item => /^\d+-\d+$/.test(item));
}

export function readProjectForm(container) {
    const form = container.querySelector('#tt-project-form');
    const data = new FormData(form);
    return {
        schoolName: data.get('schoolName'),
        term: data.get('term'),
        weekdays: Number(data.get('weekdays')),
        periodsPerDay: Number(data.get('periodsPerDay')),
    };
}

export function readRulesForm(container, project) {
    const rules = cloneValue(project.rules || { hardRules: {}, softRules: {} });
    rules.hardRules = rules.hardRules || {};
    rules.softRules = rules.softRules || {};
    rules.hardRules.teacherUnavailable = { ...(rules.hardRules.teacherUnavailable || {}) };
    rules.hardRules.classUnavailable = { ...(rules.hardRules.classUnavailable || {}) };

    const teacherId = container.querySelector('#tt-rule-teacher')?.value;
    const teacherSlots = parseSlotInput(container.querySelector('#tt-rule-teacher-slots')?.value);
    const classId = container.querySelector('#tt-rule-class')?.value;
    const classSlots = parseSlotInput(container.querySelector('#tt-rule-class-slots')?.value);
    const morningSubjects = [...container.querySelectorAll('[data-morning-subject]:checked')].map(item => item.value);

    if (teacherId) rules.hardRules.teacherUnavailable[teacherId] = teacherSlots;
    if (classId) rules.hardRules.classUnavailable[classId] = classSlots;
    rules.softRules.morningSubjects = morningSubjects;
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
        plans: '任课信息',
        master: '总课表',
        class: '班级课表',
    })[type] || '课表';
}
