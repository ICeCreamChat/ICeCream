import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultTimetableProject } from '../gateway/services/timetable-scheduler.js';
import { TimetablePlannerController } from '../public/js/tools/timetable/controller.js';

function response(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return JSON.stringify(status >= 200 && status < 300
                ? { success: true, data }
                : { success: false, error: data?.error || 'request_failed', data: data?.data || {} });
        },
    };
}

function controllerWithReview(ruleReview) {
    const controller = new TimetablePlannerController();
    controller.render = () => {};
    controller.state.project = createDefaultTimetableProject();
    controller.state.ruleReview = structuredClone(ruleReview);
    controller.state.constraintDialog = { open: true, requirementFilter: 'all', selectedRequirementId: '' };
    return controller;
}

test('constraint apply keeps semantic actions when backend reports no applied items', async () => {
    const controller = controllerWithReview({
        draftRows: [],
        requirementItems: [{
            id: 'req_action',
            status: 'actionable',
            applyTo: 'lesson_plan',
            source: { rawText: '数学改为连堂' },
        }],
        semanticActions: [{
            id: 'action_block',
            requirementId: 'req_action',
            kind: 'lesson_plan_patch',
            status: 'ready',
            payload: { blockPreference: 'double' },
        }],
        conflicts: [],
    });
    const alerts = [];
    const calls = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.confirm;
    const originalAlert = globalThis.alert;
    globalThis.confirm = () => true;
    globalThis.alert = message => alerts.push(message);
    globalThis.fetch = async url => {
        calls.push(String(url));
        if (String(url).endsWith('/requirements/apply')) {
            return response({ project: createDefaultTimetableProject(), applied: [], skipped: [], needsReview: [] });
        }
        if (String(url).endsWith('/rules/diagnose')) {
            return response({ diagnosis: { blockingRules: [], conflicts: [] } });
        }
        throw new Error(`Unexpected fetch ${url}`);
    };

    try {
        await controller.applyConstraintsFromDialog();

        assert.deepEqual(controller.state.ruleReview.semanticActions.map(item => item.id), ['action_block']);
        assert.equal(controller.state.constraintDialog.open, true);
        assert.doesNotMatch(alerts.join('\n'), /已写入/);
        assert.match(alerts.join('\n'), /没有.*生效|未实际生效/);
        assert.equal(calls.filter(url => url.endsWith('/rules/diagnose')).length, 0);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.confirm = originalConfirm;
        globalThis.alert = originalAlert;
    }
});

test('constraint apply clears saved rules but retains a failed semantic action', async () => {
    const controller = controllerWithReview({
        draftRows: [{
            id: 'rule_teacher',
            requirementId: 'req_rule',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 'teacher_1',
            slots: ['1-1'],
            priority: 'hard',
            status: 'effective',
        }],
        requirementItems: [{
            id: 'req_rule',
            status: 'actionable',
            applyTo: 'rule',
            source: { rawText: '张老师周一第1节不排' },
        }, {
            id: 'req_action',
            status: 'actionable',
            applyTo: 'lesson_plan',
            source: { rawText: '数学改为连堂' },
        }],
        semanticActions: [{
            id: 'action_block',
            requirementId: 'req_action',
            kind: 'lesson_plan_patch',
            status: 'ready',
            payload: { blockPreference: 'double' },
        }],
        conflicts: [],
    });
    const alerts = [];
    const calls = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.confirm;
    const originalAlert = globalThis.alert;
    globalThis.confirm = () => true;
    globalThis.alert = message => alerts.push(message);
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
        if (String(url).endsWith('/rules/normalize')) {
            return response({
                draftRows: [{ id: 'rule_teacher', status: 'effective' }],
                draftRules: { hardRules: { teacherUnavailable: { teacher_1: ['1-1'] } }, softRules: {} },
            });
        }
        if (String(url).endsWith('/rules')) {
            return response({ project: createDefaultTimetableProject() });
        }
        if (String(url).endsWith('/requirements/apply')) {
            return response({ error: 'semantic_apply_failed' }, 500);
        }
        if (String(url).endsWith('/rules/diagnose')) {
            return response({ diagnosis: { blockingRules: [], conflicts: [] } });
        }
        throw new Error(`Unexpected fetch ${url}`);
    };

    try {
        await controller.applyConstraintsFromDialog();

        assert.deepEqual(controller.state.ruleReview.draftRows, []);
        assert.deepEqual(controller.state.ruleReview.semanticActions.map(item => item.id), ['action_block']);
        assert.deepEqual(controller.state.ruleReview.savedItems.map(item => item.id), ['rule_teacher']);
        assert.equal(controller.state.constraintDialog.open, true);
        assert.match(alerts.join('\n'), /部分.*成功/);
        assert.match(alerts.join('\n'), /1 条硬规则/);
        assert.doesNotMatch(alerts.join('\n'), /共 2 条已生效/);
        assert.equal(calls.filter(call => call.url.endsWith('/rules/diagnose')).length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.confirm = originalConfirm;
        globalThis.alert = originalAlert;
    }
});

test('constraint apply does not save or clear rules when normalization yields zero effective rows', async () => {
    const controller = controllerWithReview({
        draftRows: [{
            id: 'rule_review',
            requirementId: 'req_rule',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 'teacher_1',
            slots: ['1-1'],
            priority: 'hard',
            status: 'effective',
        }],
        requirementItems: [{ id: 'req_rule', status: 'actionable', applyTo: 'rule' }],
        semanticActions: [],
        conflicts: [],
    });
    const alerts = [];
    const calls = [];
    const originalFetch = globalThis.fetch;
    const originalConfirm = globalThis.confirm;
    const originalAlert = globalThis.alert;
    globalThis.confirm = () => true;
    globalThis.alert = message => alerts.push(message);
    globalThis.fetch = async url => {
        calls.push(String(url));
        if (String(url).endsWith('/rules/normalize')) {
            return response({ draftRows: [{ id: 'rule_review', status: 'needs_review' }], draftRules: null });
        }
        throw new Error(`Unexpected fetch ${url}`);
    };

    try {
        await controller.applyConstraintsFromDialog();

        assert.deepEqual(controller.state.ruleReview.draftRows.map(item => item.id), ['rule_review']);
        assert.equal(calls.some(url => url.endsWith('/rules')), false);
        assert.doesNotMatch(alerts.join('\n'), /已写入/);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.confirm = originalConfirm;
        globalThis.alert = originalAlert;
    }
});
