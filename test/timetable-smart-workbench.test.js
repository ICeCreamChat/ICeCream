import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { TimetablePlannerController } from '../public/js/tools/timetable/controller.js';
import { createTimetablePlannerState } from '../public/js/tools/timetable/state.js';
import { renderConstraintDialog } from '../public/js/tools/timetable/view-constraint-dialog.js';

function project(overrides = {}) {
    return createDefaultTimetableProject({
        schoolName: '测试学校',
        teachers: [{ id: 't1', name: '张老师' }],
        classes: [{ id: 'c1', grade: '七年级', name: '1班' }],
        subjects: [{ id: 's1', name: '数学', priority: 90, color: '#0891b2' }],
        lessonPlans: [{
            id: 'lp1',
            classId: 'c1',
            subjectId: 's1',
            teacherId: 't1',
            weeklyHours: 4,
        }],
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    });
}

test('constraint dialog state replaces the removed smart workbench by default', () => {
    const state = createTimetablePlannerState({ project: project() });

    assert.deepEqual(state.smartWorkbench, { open: false });
    assert.deepEqual(state.constraintDialog, { open: false });
});

test('constraint dialog renders the current intelligent constraints entry without old workbench markers', () => {
    const html = renderConstraintDialog(createTimetablePlannerState({
        project: project(),
        constraintDialog: { open: true },
        ruleReview: {
            inputMode: 'text',
            text: '张老师周一不排课',
            draftRows: [],
            parsing: false,
        },
    }));

    assert.match(html, /data-constraint-dialog-overlay/);
    assert.match(html, /tt-constraint-dialog/);
    assert.match(html, /智能约束助手/);
    assert.match(html, /data-action="parse-constraints"/);
    assert.doesNotMatch(html, /data-smart-workbench-root/);
    assert.doesNotMatch(html, /tt-smart-workbench/);
});

test('constraint dialog renders recognized constraints and apply action', () => {
    const html = renderConstraintDialog(createTimetablePlannerState({
        project: project(),
        constraintDialog: { open: true },
        ruleReview: {
            inputMode: 'text',
            draftRows: [{
                id: 'rule_1',
                rawText: '数学尽量上午',
                type: 'subject_morning',
                targetName: '数学',
                priority: 'soft',
                status: 'effective',
                confidence: 0.94,
            }],
        },
    }));

    assert.match(html, /已识别约束 \(1\)/);
    assert.match(html, /数学尽量上午/);
    assert.match(html, /data-action="apply-constraints"/);
    assert.match(html, /data-action="start-ai-chat"/);
});

test('legacy rule review entry opens constraint dialog instead of the removed workbench', () => {
    const controller = new TimetablePlannerController();
    controller.render = () => {};

    controller.openRuleReview('manual');

    assert.equal(controller.state.constraintDialog.open, true);
    assert.equal(controller.state.smartWorkbench.open, false);
});
