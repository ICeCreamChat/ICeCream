import express from 'express';

import { createTimetableStore } from '../services/timetable-store.js';
import {
    answerTimetableAgentQuestions,
    approveTimetableAgentAction,
    createTimetableAgentSession,
    getTimetableAgentSession,
    handleTimetableAgentMessage,
    resetTimetableAgentSession,
    runTimetableAgent,
} from '../services/timetable-agent/timetable-agent-core.js';
import {
    answerConstraintIntakeClarification,
    applyConstraintIntake,
    confirmConstraintIntake,
    createConstraintIntakeSession,
    getConstraintIntakeSession,
    handleConstraintIntakeMessage,
    reportConstraintIntake,
    solveConstraintIntake,
} from '../services/timetable-agent/skills/constraint-intake-skill.js';

const router = express.Router();

function store() {
    return createTimetableStore();
}

function ok(res, data) {
    return res.json({ success: true, data });
}

function fail(res, error, status = 400, data = undefined) {
    return res.status(status || 400).json({
        success: false,
        error: error.message || String(error),
        ...(data === undefined ? {} : { data }),
    });
}

async function projectFromRequest(req) {
    if (req.body?.project) return req.body.project;
    return store().loadProject();
}

router.post('/session', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const state = createTimetableAgentSession({
            project,
            mode: req.body?.mode || 'assistant',
        });
        ok(res, { sessionId: state.sessionId, state });
    } catch (error) {
        fail(res, error, error.status || 500);
    }
});

router.post('/constraint-intake/session', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const state = createConstraintIntakeSession({
            project,
            mode: req.body?.mode || 'constraint_intake',
        });
        ok(res, { sessionId: state.sessionId, state });
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_session_failed' });
    }
});

router.get('/constraint-intake/session/:id', (req, res) => {
    const state = getConstraintIntakeSession(req.params.id);
    if (!state) {
        fail(res, new Error('对话排课会话不存在或已过期。'), 404, { reason: 'constraint_intake_session_not_found' });
        return;
    }
    ok(res, { sessionId: state.sessionId, state });
});

router.post('/constraint-intake/message', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const response = await handleConstraintIntakeMessage({
            sessionId: req.body?.sessionId,
            message: req.body?.message || '',
            project,
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_message_failed' });
    }
});

router.post('/constraint-intake/answer', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const response = answerConstraintIntakeClarification({
            sessionId: req.body?.sessionId,
            answers: req.body?.answers || [],
            project,
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_answer_failed' });
    }
});

router.post('/constraint-intake/confirm', async (req, res) => {
    try {
        const response = confirmConstraintIntake({
            sessionId: req.body?.sessionId,
            confirmationToken: req.body?.confirmationToken || '',
            highRiskToken: req.body?.highRiskToken || '',
            excludedApplyItemKeys: req.body?.excludedApplyItemKeys || [],
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_confirm_failed' });
    }
});

router.post('/constraint-intake/apply', async (req, res) => {
    try {
        const timetableStore = store();
        const project = req.body?.project || await timetableStore.loadProject();
        const response = await applyConstraintIntake({
            sessionId: req.body?.sessionId,
            confirmationToken: req.body?.confirmationToken || '',
            highRiskToken: req.body?.highRiskToken || '',
            excludedApplyItemKeys: req.body?.excludedApplyItemKeys || [],
            project,
            saveProject: nextProject => timetableStore.saveProject(nextProject),
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_apply_failed' });
    }
});

router.post('/constraint-intake/solve', async (req, res) => {
    try {
        const timetableStore = store();
        const project = req.body?.project || await timetableStore.loadProject();
        const response = await solveConstraintIntake({
            sessionId: req.body?.sessionId,
            project,
            seed: req.body?.seed || 'constraint-intake-agent',
            saveProject: nextProject => timetableStore.saveProject(nextProject),
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_solve_failed' });
    }
});

router.post('/constraint-intake/report', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const response = reportConstraintIntake({
            sessionId: req.body?.sessionId,
            project,
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'constraint_intake_report_failed' });
    }
});

router.get('/session/:id', (req, res) => {
    const state = getTimetableAgentSession(req.params.id);
    if (!state) {
        fail(res, new Error('智能排课 Agent 会话不存在或已过期。'), 404, { reason: 'agent_session_not_found' });
        return;
    }
    ok(res, { sessionId: state.sessionId, state });
});

router.post('/message', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const response = await handleTimetableAgentMessage({
            sessionId: req.body?.sessionId,
            message: req.body?.message || '',
            project,
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'agent_message_failed' });
    }
});

router.post('/run', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const response = await runTimetableAgent({
            sessionId: req.body?.sessionId,
            project,
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'agent_run_failed' });
    }
});

router.post('/answer', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const response = await answerTimetableAgentQuestions({
            sessionId: req.body?.sessionId,
            answers: req.body?.answers || [],
            project,
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'agent_answer_failed' });
    }
});

router.post('/approve', async (req, res) => {
    try {
        const timetableStore = store();
        const project = req.body?.project || await timetableStore.loadProject();
        const response = await approveTimetableAgentAction({
            sessionId: req.body?.sessionId,
            actionId: req.body?.actionId,
            approved: Boolean(req.body?.approved),
            project,
            saveProject: nextProject => timetableStore.saveProject(nextProject),
        });
        ok(res, response);
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'agent_approve_failed' });
    }
});

router.post('/reset', async (req, res) => {
    try {
        const project = await projectFromRequest(req);
        const state = resetTimetableAgentSession({
            sessionId: req.body?.sessionId,
            project,
            mode: req.body?.mode || 'assistant',
        });
        ok(res, { sessionId: state.sessionId, state });
    } catch (error) {
        fail(res, error, error.status || 500, { reason: error.reason || 'agent_reset_failed' });
    }
});

export default router;
