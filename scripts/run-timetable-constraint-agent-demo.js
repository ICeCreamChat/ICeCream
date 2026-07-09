#!/usr/bin/env node

import {
    applyConstraintIntake,
    confirmConstraintIntake,
    createConstraintIntakeSession,
    handleConstraintIntakeMessage,
    reportConstraintIntake,
    resetConstraintIntakeSessions,
    solveConstraintIntake,
} from '../gateway/services/timetable-agent/skills/constraint-intake-skill.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';

function argValue(name, fallback = '') {
    const exact = process.argv.find(item => item.startsWith(`${name}=`));
    if (exact) return exact.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
    return fallback;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function demoProject() {
    return createDefaultTimetableProject({
        schoolName: 'Constraint Agent Demo School',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 6,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6],
        teachers: [
            { id: 't_wang', name: '王老师', subjects: ['math'], unavailableSlots: [] },
            { id: 't_li', name: '李老师', subjects: ['chinese'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班' },
            { id: 'c2', grade: '七年级', name: '2班' },
        ],
        subjects: [
            { id: 'math', name: '数学', priority: 100, color: '#14b8a6' },
            { id: 'chinese', name: '语文', priority: 95, color: '#60a5fa' },
        ],
        lessonPlans: [
            { id: 'lp_c1_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang', weeklyHours: 3 },
            { id: 'lp_c1_chinese', classId: 'c1', subjectId: 'chinese', teacherId: 't_li', weeklyHours: 3 },
            { id: 'lp_c2_math', classId: 'c2', subjectId: 'math', teacherId: 't_wang', weeklyHours: 3 },
            { id: 'lp_c2_chinese', classId: 'c2', subjectId: 'chinese', teacherId: 't_li', weeklyHours: 3 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
}

async function loadProject() {
    if (!hasFlag('--use-current-project')) return demoProject();
    return createTimetableStore().loadProject();
}

async function main() {
    resetConstraintIntakeSessions();

    const realAi = hasFlag('--real-ai') || process.env.TIMETABLE_CONSTRAINT_AGENT_REAL_AI === '1';
    const save = hasFlag('--save');
    const message = argValue(
        '--message',
        '王老师周三第3节没空，数学尽量上午，确认后生成课表。',
    );
    const env = realAi
        ? { ...process.env, TIMETABLE_RULE_AI_EXTRACT: process.env.TIMETABLE_RULE_AI_EXTRACT || '1' }
        : {};
    const store = createTimetableStore();
    const project = await loadProject();
    const saveProject = save
        ? nextProject => store.saveProject(nextProject)
        : nextProject => nextProject;

    console.log(`[constraint-agent-demo] AI=${realAi ? 'real' : 'local-fallback'} save=${save ? 'on' : 'off'}`);
    console.log(`[constraint-agent-demo] input=${message}`);

    const session = createConstraintIntakeSession({ project });
    const parsed = await handleConstraintIntakeMessage({
        sessionId: session.sessionId,
        message,
        project,
        env,
    });
    if (parsed.stage === 'CLARIFY') {
        throw new Error(`demo needs clarification: ${(parsed.questions || []).map(item => item.question).join(' / ')}`);
    }
    if (parsed.stage !== 'CONFIRM' || !parsed.confirmationToken) {
        throw new Error(`demo expected CONFIRM stage, got ${parsed.stage}`);
    }

    const confirmed = confirmConstraintIntake({
        sessionId: session.sessionId,
        confirmationToken: parsed.confirmationToken,
    });
    const applied = await applyConstraintIntake({
        sessionId: session.sessionId,
        confirmationToken: parsed.confirmationToken,
        project,
        saveProject,
    });
    const solved = await solveConstraintIntake({
        sessionId: session.sessionId,
        project: applied.project,
        saveProject,
    });
    const report = reportConstraintIntake({
        sessionId: session.sessionId,
        project: solved.project || applied.project,
    });

    const summary = {
        sessionId: session.sessionId,
        stages: [session.stage, parsed.stage, confirmed.stage, applied.stage, solved.stage, report.stage],
        statusLine: report.statusLine,
        understood: parsed.review?.requirementItems?.length || parsed.review?.draftRows?.length || 0,
        applied: applied.appliedSummary,
        solved: solved.solveResult?.success === true,
        placedLessons: solved.solveResult?.schedule?.slots?.length || 0,
        fulfillment: report.fulfillment?.summary || solved.fulfillment?.summary || null,
    };
    console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
    console.error('[constraint-agent-demo] failed:', error?.message || error);
    process.exitCode = 1;
});
