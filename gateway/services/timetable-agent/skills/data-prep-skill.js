import {
    auditTimetableProject,
    getActivePeriods,
    getActiveWeekdays,
    normalizeTimetableProject,
    validateTimetableProjectForSolve,
} from '../../timetable-scheduler.js';
import { makeTimetableAgentArtifactId } from '../timetable-agent-state.js';

function question(id, title, description, field = {}) {
    return {
        id,
        type: field.type || 'action',
        title,
        description,
        required: true,
        ...field,
    };
}

function dataIssue(type, severity, message, extra = {}) {
    return { type, severity, message, ...extra };
}

function dataQualityScore({ project, validation, audit }) {
    let score = 100;
    if (!project.classes.length) score -= 20;
    if (!project.teachers.length) score -= 20;
    if (!project.subjects.length) score -= 15;
    if (!project.lessonPlans.length) score -= 30;
    if (!getActiveWeekdays(project).length) score -= 10;
    if (!getActivePeriods(project).length) score -= 10;
    if (!validation.ok) score -= 15;
    score -= Math.min(30, (audit.blockingIssues || []).length * 10);
    score -= Math.min(15, (audit.warnings || []).length * 3);
    return Math.max(0, Math.min(100, score));
}

export function runDataPrepSkill({ project: input = {} } = {}) {
    const project = normalizeTimetableProject(input);
    const validation = validateTimetableProjectForSolve(project);
    const audit = auditTimetableProject(project);
    const questions = [];
    const issues = [];

    if (!project.lessonPlans.length) {
        questions.push(question(
            'missing_lesson_plans',
            '需要导入任课数据',
            '当前项目还没有任课关系，无法进入求解。',
            { target: 'roster' },
        ));
        issues.push(dataIssue('missing_lesson_plans', 'error', '缺少任课关系。'));
    }
    if (!project.classes.length) {
        questions.push(question('missing_classes', '需要班级名单', '任课数据中没有可排课的班级。', { target: 'classes' }));
        issues.push(dataIssue('missing_classes', 'error', '缺少班级。'));
    }
    if (!project.teachers.length) {
        questions.push(question('missing_teachers', '需要教师名单', '任课数据中没有可匹配的教师。', { target: 'teachers' }));
        issues.push(dataIssue('missing_teachers', 'error', '缺少教师。'));
    }
    if (!project.subjects.length) {
        questions.push(question('missing_subjects', '需要课程名单', '任课数据中没有课程。', { target: 'subjects' }));
        issues.push(dataIssue('missing_subjects', 'error', '缺少课程。'));
    }
    if (!getActiveWeekdays(project).length || !getActivePeriods(project).length) {
        questions.push(question('missing_scope', '需要排课范围', '请先选择可用周几和可用节次。', { target: 'range' }));
        issues.push(dataIssue('missing_scope', 'error', '缺少可用排课范围。'));
    }

    for (const item of audit.blockingIssues || []) {
        issues.push(dataIssue(item.type || 'audit_blocking', 'error', item.message || item.type, item));
    }
    for (const item of audit.warnings || []) {
        issues.push(dataIssue(item.type || 'audit_warning', 'warning', item.message || item.type, item));
    }

    const score = dataQualityScore({ project, validation, audit });
    const dataQuality = {
        score,
        teachers: project.teachers.length,
        classes: project.classes.length,
        subjects: project.subjects.length,
        rosterRows: project.lessonPlans.length,
        capacity: {
            activeWeekdays: getActiveWeekdays(project).length,
            activePeriods: getActivePeriods(project).length,
            totalSlots: getActiveWeekdays(project).length * getActivePeriods(project).length * project.classes.length,
            totalLessons: project.lessonPlans.reduce((sum, plan) => sum + Number(plan.weeklyHours || 0), 0),
        },
        issues,
    };

    return {
        normalizedProject: project,
        dataQuality,
        questions,
        warnings: issues.filter(item => item.severity !== 'error'),
        nextAction: questions.length ? 'ask_user' : validation.ok ? 'continue' : 'failed',
        artifacts: [{
            id: makeTimetableAgentArtifactId('data_quality_report'),
            type: 'data_quality_report',
            title: '排课数据检查报告',
            summary: validation.ok ? '当前任课数据可以进入排课。' : validation.message,
            stats: dataQuality.capacity,
            dataQuality,
            issues,
            questions,
        }],
    };
}
