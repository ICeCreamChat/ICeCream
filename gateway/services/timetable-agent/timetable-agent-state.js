import { normalizeTimetableProject } from '../timetable-scheduler.js';

const sessions = new Map();

function nowIso() {
    return new Date().toISOString();
}

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultTimetableAgentPlan() {
    return [
        { id: 'data_prep', label: '数据准备', status: 'pending' },
        { id: 'constraint_review', label: '约束复核', status: 'pending' },
        { id: 'solve_planning', label: '求解计划', status: 'pending' },
        { id: 'solving', label: '执行求解', status: 'pending' },
        { id: 'solution_review', label: '方案确认', status: 'pending' },
        { id: 'finalize', label: '保存导出', status: 'pending' },
    ];
}

export function createTimetableAgentState({ project = {}, mode = 'assistant' } = {}) {
    const timestamp = nowIso();
    return {
        sessionId: makeId('tt_agent'),
        domain: 'timetable',
        mode,
        stage: 'idle',
        projectSnapshot: normalizeTimetableProject(project),
        messages: [],
        plan: defaultTimetableAgentPlan(),
        questions: [],
        approvalQueue: [],
        artifacts: [],
        lastToolResults: [],
        warnings: [],
        errors: [],
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

export function saveTimetableAgentState(state = {}) {
    const next = { ...state, updatedAt: nowIso() };
    sessions.set(next.sessionId, next);
    return next;
}

export function createTimetableAgentSessionState(input = {}) {
    return saveTimetableAgentState(createTimetableAgentState(input));
}

export function getTimetableAgentState(sessionId) {
    return sessions.get(sessionId) || null;
}

export function requireTimetableAgentState(sessionId) {
    const session = getTimetableAgentState(sessionId);
    if (!session) {
        const error = new Error('智能排课 Agent 会话不存在或已过期。');
        error.status = 404;
        error.reason = 'agent_session_not_found';
        throw error;
    }
    return session;
}

export function resetTimetableAgentState(sessionId, { project, mode } = {}) {
    if (sessionId) sessions.delete(sessionId);
    return createTimetableAgentSessionState({ project, mode });
}

export function updateTimetableAgentPlan(plan = [], activeStage = 'idle') {
    const order = plan.map(item => item.id);
    const activeIndex = order.indexOf(activeStage);
    return plan.map((item, index) => ({
        ...item,
        status: activeIndex < 0
            ? item.status || 'pending'
            : index < activeIndex
                ? 'completed'
                : index === activeIndex
                    ? 'active'
                    : 'pending',
    }));
}

export function clearTimetableAgentSessions() {
    sessions.clear();
}

export function makeTimetableAgentArtifactId(type = 'artifact') {
    return makeId(`tt_${type}`);
}

export function makeTimetableAgentActionId(type = 'action') {
    return makeId(`tt_${type}`);
}
