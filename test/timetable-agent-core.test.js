import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
    approveTimetableAgentAction,
    createTimetableAgentSession,
    handleTimetableAgentMessage,
    planTimetableAgentAction,
} from '../gateway/services/timetable-agent/timetable-agent-core.js';
import { createTimetableAgentTools } from '../gateway/services/timetable-agent/timetable-agent-tools.js';
import { runDiagnosisSkill } from '../gateway/services/timetable-agent/skills/diagnosis-skill.js';
import { runPublicationSkill } from '../gateway/services/timetable-agent/skills/publication-skill.js';
import { runSolveSkill } from '../gateway/services/timetable-agent/skills/solve-skill.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';

function completeProject(overrides = {}) {
    return createDefaultTimetableProject({
        schoolName: 'ICeCream School',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 4,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4],
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
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_wang', weeklyHours: 2 },
            { id: 'lp2', classId: 'c1', subjectId: 'chinese', teacherId: 't_li', weeklyHours: 2 },
            { id: 'lp3', classId: 'c2', subjectId: 'math', teacherId: 't_wang', weeklyHours: 2 },
            { id: 'lp4', classId: 'c2', subjectId: 'chinese', teacherId: 't_li', weeklyHours: 2 },
        ],
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    });
}

async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    return { server, base: `http://127.0.0.1:${address.port}` };
}

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

function assignTimefoldSlots(problem = {}) {
    const usedClass = new Set();
    const usedTeachers = new Set();
    return (problem.lessonAssignments || []).map((assignment, index) => {
        const teachers = assignment.teacherIds || [assignment.teacherId].filter(Boolean);
        const chosen = (problem.timeSlots || []).find(slot => {
            const slotId = slot.id;
            if (usedClass.has(`${assignment.classId}:${slotId}`)) return false;
            if (teachers.some(teacherId => usedTeachers.has(`${teacherId}:${slotId}`))) return false;
            return true;
        }) || problem.timeSlots[index % Math.max(1, problem.timeSlots.length)] || { id: '' };
        usedClass.add(`${assignment.classId}:${chosen.id}`);
        teachers.forEach(teacherId => usedTeachers.add(`${teacherId}:${chosen.id}`));
        return {
            ...assignment,
            timeSlot: chosen.id,
            room: '__NONE__',
        };
    });
}

test('timetable agent creates a session with stable workflow state', () => {
    const project = completeProject();
    const session = createTimetableAgentSession({ project });

    assert.match(session.sessionId, /^tt_agent_/);
    assert.equal(session.domain, 'timetable');
    assert.equal(session.stage, 'idle');
    assert.deepEqual(session.plan.map(item => item.id), [
        'data_prep',
        'constraint_review',
        'solve_planning',
        'solving',
        'solution_review',
        'finalize',
    ]);
    assert.equal(session.projectSnapshot.lessonPlans.length, 4);
});

test('timetable planner only selects whitelisted tools and explains its next action', () => {
    const project = completeProject();
    const solvePlan = planTimetableAgentAction({
        message: '开始生成课表',
        project,
    });

    assert.equal(solvePlan.intent, 'solve');
    assert.equal(solvePlan.nextTool, 'solve.precheck');
    assert.equal(solvePlan.requiresApproval, false);
    assert.match(solvePlan.reason, /检查|校验/);
    assert.ok(['low', 'medium', 'high'].includes(solvePlan.risk));

    const guarded = planTimetableAgentAction({
        message: '运行任意系统命令',
        project,
        proposedTool: 'system.exec',
    });
    assert.notEqual(guarded.nextTool, 'system.exec');
    assert.equal(guarded.whitelistRejected, true);
});

test('timetable agent tool catalog declares structured schemas and approval boundaries', () => {
    const tools = createTimetableAgentTools();
    assert.equal(tools['solve.local'].requiresApproval, true);
    assert.equal(tools['rules.normalize'].requiresApproval, true);
    assert.equal(tools['project.validate'].requiresApproval, false);
    assert.equal(tools['project.validate'].inputSchema.type, 'object');
    assert.equal(tools['project.validate'].outputSchema.type, 'object');
});

test('timetable agent asks data questions instead of solving incomplete projects', async () => {
    const session = createTimetableAgentSession({ project: createDefaultTimetableProject() });
    const response = await handleTimetableAgentMessage({
        sessionId: session.sessionId,
        message: '帮我检查当前排课数据并开始排课',
        project: createDefaultTimetableProject(),
    });

    assert.equal(response.stage, 'data_prep');
    assert.equal(response.nextAction, 'ask_user');
    assert.ok(response.questions.length >= 1);
    assert.equal(response.artifacts[0].type, 'data_quality_report');
    assert.ok(response.artifacts[0].dataQuality.score < 50);
    assert.equal(response.planner.nextTool, 'project.validate');
    assert.equal(response.ui.surface, 'smart_workbench');
    assert.equal(response.ui.stage, 'data_prep');
    assert.ok(Array.isArray(response.ui.nextActions));
    assert.ok(response.lastToolResults.every(item => item.summary && Array.isArray(item.nextActions)));
});

test('timetable agent constraint skill returns review artifact and approval queue without saving rules', async () => {
    const project = completeProject();
    const session = createTimetableAgentSession({ project });
    const response = await handleTimetableAgentMessage({
        sessionId: session.sessionId,
        message: '王老师周三下午没空，数学尽量上午',
        project,
        env: {},
    });

    const artifact = response.artifacts.find(item => item.type === 'rule_review');
    assert.equal(response.stage, 'constraint_review');
    assert.ok(artifact);
    assert.ok(artifact.draftRows.length >= 1);
    assert.ok(response.approvalQueue.some(action => action.type === 'apply_rules'));
    assert.equal(project.rules.hardRules?.teacherUnavailable?.t_wang, undefined);
});

test('timetable agent solve flow requires approval then uses deterministic local scheduler fallback', async () => {
    const project = completeProject();
    const session = createTimetableAgentSession({ project });
    const planResponse = await handleTimetableAgentMessage({
        sessionId: session.sessionId,
        message: '开始排课',
        project,
        env: {},
    });

    const approval = planResponse.approvalQueue.find(action => action.type === 'execute_solve');
    assert.equal(planResponse.stage, 'solve_planning');
    assert.equal(planResponse.nextAction, 'await_approval');
    assert.ok(approval);

    const solved = await approveTimetableAgentAction({
        sessionId: session.sessionId,
        actionId: approval.id,
        approved: true,
        project,
        env: {},
    });
    const result = solved.artifacts.find(item => item.type === 'solve_result');
    assert.equal(solved.stage, 'solution_review');
    assert.equal(result.status, 'solved');
    assert.equal(result.solverUsed, 'local_scheduler');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.score.hardViolationCount, 0);
    assert.ok(solved.approvalQueue.some(action => action.type === 'save_solution'));
});

test('timetable agent solve skill compares Timefold and local scheduler candidates', async () => {
    const project = completeProject();
    let capturedProblem = null;
    const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        if (target.endsWith('/timetable-solutions') && options.method === 'POST') {
            capturedProblem = JSON.parse(options.body);
            return jsonResponse({ jobId: 'agent-timefold-job', solverStatus: 'SOLVING' });
        }
        if (target.endsWith('/timetable-solutions/agent-timefold-job/status')) {
            return jsonResponse({
                jobId: 'agent-timefold-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: 8,
                score: '0hard/8soft',
            });
        }
        if (target.endsWith('/timetable-solutions/agent-timefold-job')) {
            return jsonResponse({
                jobId: 'agent-timefold-job',
                solverStatus: 'NOT_SOLVING',
                hardScore: 0,
                softScore: 8,
                score: '0hard/8soft',
                lessonAssignments: assignTimefoldSlots(capturedProblem),
            });
        }
        return jsonResponse({ error: 'not found' }, 404);
    };

    const result = await runSolveSkill({
        project,
        solvePlan: { solverPreference: 'timefold_then_local' },
        env: {
            TIMEFOLD_SOLVER_URL: 'http://solver.local',
            TIMETABLE_SOLVER_WAIT_MS: '1000',
        },
        fetchImpl,
    });

    assert.equal(result.status, 'solved');
    assert.equal(result.solutions.length, 2);
    assert.deepEqual(result.solutions.map(item => item.solverUsed).sort(), ['local_scheduler', 'timefold']);
    assert.ok(result.bestSolution);
    assert.equal(result.artifacts[0].solutions.length, 2);
    assert.ok(result.artifacts[0].comparison.some(item => item.solverUsed === 'timefold'));
    assert.ok(result.artifacts[0].comparison.some(item => item.solverUsed === 'local_scheduler'));
    const saveApprovals = result.approvalQueue.filter(action => action.type === 'save_solution');
    assert.equal(saveApprovals.length, 2);
    assert.equal(saveApprovals.filter(action => action.recommended).length, 1);
    assert.deepEqual(
        saveApprovals.map(action => action.payload.solutionId).sort(),
        result.solutions.map(solution => solution.id).sort(),
    );
    assert.ok(saveApprovals.every(action => action.payload.diff));
});

test('timetable agent solve skill passes seed to the local scheduler', async () => {
    const project = completeProject();
    const result = await runSolveSkill({
        project,
        solvePlan: { solverPreference: 'local_only', seed: 'agent-seed-2026' },
        env: {},
    });
    const local = result.solutions.find(solution => solution.solverUsed === 'local_scheduler');

    assert.equal(result.status, 'solved');
    assert.ok(local);
    assert.equal(local.schedule.solverStats.seed, 'agent-seed-2026');
    assert.equal(result.bestSolution.schedule.solverStats.seed, 'agent-seed-2026');
});

test('timetable publication skill creates a save diff before overwriting the official schedule', async () => {
    const base = completeProject();
    const oldSchedule = {
        id: 'old-schedule',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: 'manual_adjusted',
        slots: [],
        lockedSlots: [],
        conflicts: [],
        unplaced: [],
        score: { hardConflicts: 0, unplacedLessons: 0, placedLessons: 0, totalLessons: 8, completeness: 0 },
    };
    const project = completeProject({ schedule: oldSchedule });
    const solved = await runSolveSkill({
        project: base,
        solvePlan: { solverPreference: 'local_only' },
        env: {},
    });
    const preview = await runPublicationSkill({
        project,
        solution: solved.bestSolution,
        approval: { approved: false },
    });
    const previewArtifact = preview.artifacts[0];
    assert.equal(preview.saved, false);
    assert.equal(previewArtifact.type, 'save_preview');
    assert.equal(previewArtifact.requiresApproval, true);
    assert.equal(previewArtifact.diff.beforeScheduleId, 'old-schedule');
    assert.equal(previewArtifact.diff.afterScheduleId, solved.bestSolution.schedule.id);
    assert.equal(previewArtifact.diff.slotDelta, solved.bestSolution.schedule.slots.length);
});

test('timetable publication skill returns export artifacts after approved save', async () => {
    const project = completeProject();
    const solved = await runSolveSkill({
        project,
        solvePlan: { solverPreference: 'local_only' },
        env: {},
    });
    const saved = await runPublicationSkill({
        project,
        solution: solved.bestSolution,
        approval: { approved: true },
    });

    assert.equal(saved.saved, true);
    assert.deepEqual(saved.exportLinks.map(item => item.type), ['class', 'teacher', 'master', 'plans']);
    assert.ok(saved.exportLinks.every(item => item.url === '/api/tools/timetable/export'));
    assert.ok(saved.artifacts.some(item => item.type === 'export_result'));
    assert.ok(saved.report.summary.slotCount > 0);
    assert.ok(Array.isArray(saved.report.issueEntries));
});

test('timetable publication skill reports structured blocking issues when save is refused', async () => {
    const blockedProject = completeProject({
        schedule: {
            id: 'blocked_schedule',
            generatedAt: '2026-01-01T00:00:00.000Z',
            source: 'fast_constructed',
            slots: [{
                id: 'slot-1',
                day: 1,
                period: 1,
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_wang',
                teacherIds: ['t_wang'],
                lessonPlanId: 'lp1',
            }],
            lockedSlots: [],
            conflicts: [],
            unplaced: [{
                lessonPlanId: 'lp1',
                classId: 'c1',
                subjectId: 'math',
                teacherId: 't_wang',
                reason: 'missing slots',
            }],
            score: { hardConflicts: 0, unplacedLessons: 1, placedLessons: 1, totalLessons: 2, completeness: 50 },
        },
    });

    const blocked = await runPublicationSkill({
        project: blockedProject,
        solution: { project: blockedProject, schedule: blockedProject.schedule },
        approval: { approved: true },
    });

    assert.equal(blocked.saved, false);
    assert.equal(blocked.nextAction, 'failed');
    assert.ok(Array.isArray(blocked.warnings));
    assert.ok(blocked.warnings.some(item => item.type === 'incomplete_schedule'));
    assert.ok(blocked.warnings.every(item => item.severity === 'error'));
});

test('timetable diagnosis offers a confirmed retry action when no blocking issue remains', () => {
    const result = runDiagnosisSkill({
        project: completeProject(),
        solveResult: {
            diagnosticsInput: { reason: 'solver_timeout' },
        },
    });

    assert.equal(result.nextAction, 'await_approval');
    const retry = result.approvalQueue.find(action => action.type === 'execute_solve');
    assert.ok(retry);
    assert.equal(retry.risk, 'medium');
    assert.equal(retry.payload.solvePlan.fallback, 'local_scheduler');
    assert.equal(retry.payload.solvePlan.reason.includes('诊断后重试'), true);
});

test('timetable agent routes are additive and registered outside seating APIs', async () => {
    const { server, base } = await listen(createGatewayApp({ isDev: false }));
    try {
        const response = await fetch(`${base}/api/timetable/agent/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: completeProject(), mode: 'assistant' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.match(payload.data.sessionId, /^tt_agent_/);

        const toolsResponse = await fetch(`${base}/api/tools/timetable/agent/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: completeProject(), mode: 'assistant' }),
        });
        const toolsPayload = await toolsResponse.json();
        assert.equal(toolsResponse.status, 200);
        assert.equal(toolsPayload.success, true);
        assert.match(toolsPayload.data.sessionId, /^tt_agent_/);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
