import assert from 'node:assert/strict';
import test from 'node:test';

import {
    answerConstraintIntakeClarification,
    applyConstraintIntake,
    confirmConstraintIntake,
    constraintIntakeStatusLine,
    createConstraintIntakeSession,
    handleConstraintIntakeMessage,
    resetConstraintIntakeSessions,
    solveConstraintIntake,
} from '../gateway/services/timetable-agent/skills/constraint-intake-skill.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';

function completeProject(overrides = {}) {
    return createDefaultTimetableProject({
        schoolName: 'Constraint Agent School',
        term: '2026',
        weekdays: 5,
        periodsPerDay: 4,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4],
        teachers: [
            { id: 't_wang', name: '王老师', subjects: ['math'], unavailableSlots: [] },
        ],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班' },
        ],
        subjects: [
            { id: 'math', name: '数学', priority: 100, color: '#14b8a6' },
        ],
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang', weeklyHours: 3 },
        ],
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    });
}

test('constraint intake status uses source input statistics instead of expanded clauses or requirement items', () => {
    const sourceRequirements = Array.from({ length: 137 }, (_, index) => ({
        sourceId: 'src:' + (index + 1),
        origin: 'user_input',
    }));
    const requirementItems = Array.from({ length: 196 }, (_, index) => ({ id: 'req:' + (index + 1) }));
    assert.equal(constraintIntakeStatusLine({
        stage: 'INTAKE',
        review: {
            statistics: { userInputCount: 137 },
            sourceRequirements,
            requirementItems,
            draftRows: Array.from({ length: 128 }, (_, index) => ({ id: 'row:' + index })),
        },
    }), '[已理解 137 · 待澄清 0 · 待确认 0]');

    assert.equal(constraintIntakeStatusLine({
        stage: 'INTAKE',
        review: {
            sourceRequirements: [
                { sourceId: 'src:a', origin: 'user_input' },
                { sourceId: 'src:b', origin: 'manual' },
                { sourceId: 'src:unknown' },
                { sourceId: 'sys:a', origin: 'system_supplement' },
            ],
            requirementItems,
        },
    }), '[已理解 1 · 待澄清 0 · 待确认 0]');

    assert.equal(constraintIntakeStatusLine({
        stage: 'INTAKE',
        review: {
            sourceRequirements: [],
            requirementItems,
        },
    }), '[已理解 0 · 待澄清 0 · 待确认 0]');
});

test('constraint intake rejects APPLY before explicit confirmation', async () => {
    resetConstraintIntakeSessions();
    const project = completeProject();
    const session = createConstraintIntakeSession({ project });
    const parsed = await handleConstraintIntakeMessage({
        sessionId: session.sessionId,
        message: '王老师周三第3节没空，七年级1班数学尽量上午。',
        project,
        env: {},
    });

    assert.equal(parsed.stage, 'CONFIRM');
    assert.match(parsed.statusLine, /^\[已理解 1 · 待澄清 0 · 待确认 2\]$/);
    await assert.rejects(
        () => applyConstraintIntake({
            sessionId: session.sessionId,
            confirmationToken: parsed.confirmationToken,
            project,
        }),
        error => {
            assert.equal(error.reason, 'apply_before_confirm');
            assert.equal(error.status, 409);
            return true;
        },
    );
});

test('constraint intake completes local flow from INTAKE to REPORT', async () => {
    resetConstraintIntakeSessions();
    const project = completeProject();
    const session = createConstraintIntakeSession({ project });

    assert.equal(session.stage, 'INTAKE');
    assert.equal(constraintIntakeStatusLine(session), '[已理解 0 · 待澄清 0 · 待确认 0]');

    const parsed = await handleConstraintIntakeMessage({
        sessionId: session.sessionId,
        message: '王老师周三第3节没空，七年级1班数学尽量上午。',
        project,
        env: {},
    });
    assert.equal(parsed.stage, 'CONFIRM');
    assert.equal(parsed.review.draftRows.length, 2);
    assert.match(parsed.confirmationToken, /^confirm_apply_/);

    const confirmed = confirmConstraintIntake({
        sessionId: session.sessionId,
        confirmationToken: parsed.confirmationToken,
    });
    assert.equal(confirmed.stage, 'CONFIRM');
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.statusLine, '[已理解 1 · 待澄清 0 · 待确认 0]');

    let savedAfterApply = null;
    const applied = await applyConstraintIntake({
        sessionId: session.sessionId,
        confirmationToken: parsed.confirmationToken,
        project,
        saveProject: nextProject => {
            savedAfterApply = nextProject;
            return nextProject;
        },
    });
    assert.equal(applied.stage, 'APPLY');
    assert.deepEqual(applied.appliedSummary, {
        appliedRuleCount: 2,
        appliedSemanticActionCount: 0,
        skippedCount: 0,
    });
    assert.deepEqual(applied.project.rules.hardRules.teacherUnavailable.t_wang, ['3-3']);
    assert.ok(savedAfterApply);

    const solved = await solveConstraintIntake({
        sessionId: session.sessionId,
        project: applied.project,
        saveProject: nextProject => nextProject,
    });
    assert.equal(solved.stage, 'REPORT');
    assert.equal(solved.solveResult.success, true);
    assert.ok(solved.solveResult.schedule.slots.length > 0);
    assert.equal(solved.fulfillment.summary.total, 2);
    assert.equal(solved.fulfillment.summary.violated, 0);
    assert.match(solved.reply, /约束满足度报告/);
});

test('constraint intake answers requirement clarification and then confirms', async () => {
    resetConstraintIntakeSessions();
    const project = completeProject({
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang', weeklyHours: 6 },
        ],
    });
    const session = createConstraintIntakeSession({ project });

    const parsed = await handleConstraintIntakeMessage({
        sessionId: session.sessionId,
        message: '高负载教师不要连续太多。',
        project,
        env: {},
    });
    assert.equal(parsed.stage, 'CLARIFY');
    assert.equal(parsed.questions[0].field, 'maxConsecutive');

    const firstAnswer = answerConstraintIntakeClarification({
        sessionId: session.sessionId,
        project,
        answers: [{ requirementId: parsed.questions[0].requirementId, field: 'maxConsecutive', value: 2 }],
    });
    assert.equal(firstAnswer.stage, 'CLARIFY');
    assert.equal(firstAnswer.questions[0].field, 'dailyLimit');
    assert.equal(firstAnswer.clarifyTurns, 1);
    assert.equal(firstAnswer.statusLine, '[已理解 1 · 待澄清 1 · 待确认 0]');

    const secondAnswer = answerConstraintIntakeClarification({
        sessionId: session.sessionId,
        project,
        answers: [{ requirementId: parsed.questions[0].requirementId, field: 'dailyLimit', value: 4 }],
    });
    assert.equal(secondAnswer.stage, 'CONFIRM');
    assert.match(secondAnswer.confirmationToken, /^confirm_apply_/);
    assert.equal(secondAnswer.statusLine, '[已理解 1 · 待澄清 0 · 待确认 1]');
    assert.equal(secondAnswer.review.semanticActions[0].kind, 'soft_rules_patch');
});

test('constraint intake hands unresolved clarification to manual review after three turns', async () => {
    resetConstraintIntakeSessions();
    const project = completeProject({
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_wang', weeklyHours: 6 },
        ],
    });
    const session = createConstraintIntakeSession({ project });

    const parsed = await handleConstraintIntakeMessage({
        sessionId: session.sessionId,
        message: '高负载教师不要连续太多。',
        project,
        env: {},
    });
    assert.equal(parsed.stage, 'CLARIFY');

    let result = null;
    for (let index = 0; index < 3; index += 1) {
        result = answerConstraintIntakeClarification({
            sessionId: session.sessionId,
            project,
            answers: [],
        });
    }

    assert.equal(result.stage, 'CONFIRM');
    assert.equal(result.manualReviewRequired, true);
    assert.equal(result.confirmationToken, null);
    assert.equal(result.statusLine, '[已理解 1 · 待澄清 0 · 待确认 0]');
    assert.match(result.reply, /人工复核台/);
    assert.equal(result.review.manualReviewRequired, true);
});

test('constraint intake requires second confirmation for hard rule delete or relaxation', async () => {
    resetConstraintIntakeSessions();
    const project = completeProject({
        rules: {
            hardRules: {
                teacherUnavailable: { t_wang: ['3-3'] },
            },
            softRules: {},
        },
    });
    const session = createConstraintIntakeSession({ project });
    const risk = await handleConstraintIntakeMessage({
        sessionId: session.sessionId,
        message: '删除王老师周三第3节这个硬约束。',
        project,
        env: {},
    });

    assert.equal(risk.stage, 'CONFIRM');
    assert.equal(risk.highRiskAction.type, 'delete_hard_rule');
    assert.match(risk.highRiskToken, /^confirm_high_risk_/);
    assert.equal(risk.statusLine, '[已理解 0 · 待澄清 0 · 待确认 1]');

    assert.throws(
        () => confirmConstraintIntake({
            sessionId: session.sessionId,
            confirmationToken: risk.confirmationToken || 'ordinary-confirm',
        }),
        error => {
            assert.equal(error.reason, 'high_risk_confirmation_required');
            return true;
        },
    );

    await assert.rejects(
        () => applyConstraintIntake({
            sessionId: session.sessionId,
            highRiskToken: risk.highRiskToken,
            project,
        }),
        error => {
            assert.equal(error.reason, 'high_risk_confirmation_required');
            return true;
        },
    );

    const confirmed = confirmConstraintIntake({
        sessionId: session.sessionId,
        highRiskToken: risk.highRiskToken,
    });
    assert.equal(confirmed.highRiskConfirmed, true);
    assert.equal(confirmed.statusLine, '[已理解 0 · 待澄清 0 · 待确认 0]');

    const applied = await applyConstraintIntake({
        sessionId: session.sessionId,
        highRiskToken: risk.highRiskToken,
        project,
    });
    assert.equal(applied.stage, 'APPLY');
    assert.equal(applied.appliedSummary.appliedRuleCount, 0);
    assert.equal(applied.appliedSummary.highRiskAction.type, 'delete_hard_rule');
    assert.match(applied.appliedSummary.message, /不自动删除/);
});
