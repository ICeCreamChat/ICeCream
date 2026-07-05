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
    assert.deepEqual(state.constraintDialog, {
        open: false,
        requirementFilter: 'all',
        selectedRequirementId: '',
    });
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

    assert.match(html, /tt-requirement-workbench/);
    assert.match(html, /已理解需求 \(1\)/);
    assert.match(html, /落地结果/);
    assert.match(html, /数学尽量上午/);
    assert.match(html, /data-constraint-id="rule_1"/);
    assert.match(html, /data-action="edit-constraint"/);
    assert.match(html, /data-action="delete-constraint"/);
    assert.match(html, /data-action="apply-constraints"/);
    assert.match(html, /data-action="start-ai-chat"/);
    assert.doesNotMatch(html, /已识别约束/);
});

test('constraint dialog formats recognized constraint time, source row and review warnings', () => {
    const baseState = {
        project: project(),
        ruleReview: {
            inputMode: 'text',
            draftRows: [{
                id: 'rule_slots',
                rawText: '数学尽量第1-2节',
                type: 'subject_preferred_periods',
                targetName: '数学',
                slots: ['1-1', '1-2'],
                sourceSheet: 'AI约束建议',
                sourceRow: 2,
                parseSource: 'local_xlsx',
                priority: 'soft',
                status: 'effective',
                confidence: 0.94,
            }, {
                id: 'rule_week',
                rawText: '单周数学第1节优先',
                type: 'subject_preferred_periods',
                targetName: '数学',
                slots: ['1-1'],
                weekPattern: 'odd',
                warnings: ['当前规则模型暂不支持单双周，不会自动生效。'],
                priority: 'soft',
                status: 'needs_review',
                confidence: 0.68,
            }, {
                id: 'rule_morning',
                rawText: '数学尽量上午',
                type: 'subject_morning',
                targetName: '数学',
                priority: 'soft',
                status: 'effective',
                confidence: 0.9,
            }],
        },
    };
    const slotHtml = renderConstraintDialog(createTimetablePlannerState({
        ...baseState,
        constraintDialog: { open: true, selectedRequirementId: 'draft_req_rule_slots' },
    }));
    const weekHtml = renderConstraintDialog(createTimetablePlannerState({
        ...baseState,
        constraintDialog: { open: true, selectedRequirementId: 'draft_req_rule_week' },
    }));
    const morningHtml = renderConstraintDialog(createTimetablePlannerState({
        ...baseState,
        constraintDialog: { open: true, selectedRequirementId: 'draft_req_rule_morning' },
    }));

    assert.match(slotHtml, /周一第1节、周一第2节/);
    assert.match(slotHtml, /来源：AI约束建议 第 2 行/);
    assert.match(slotHtml, /AI约束建议 第 2 行 · 本地识别/);
    assert.match(weekHtml, /单双周/);
    assert.match(morningHtml, /上午时段/);
    assert.doesNotMatch(slotHtml + weekHtml + morningHtml, /<b>时间：<\/b>-/);
});

test('legacy rule review entry opens constraint dialog instead of the removed workbench', () => {
    const controller = new TimetablePlannerController();
    controller.render = () => {};

    controller.openRuleReview('manual');

    assert.equal(controller.state.constraintDialog.open, true);
    assert.equal(controller.state.smartWorkbench.open, false);
});
