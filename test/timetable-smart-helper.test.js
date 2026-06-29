import assert from 'node:assert/strict';
import test from 'node:test';

import {
    autoScanConstraints,
    generateAutoFix,
} from '../gateway/services/timetable-auto-scanner.js';
import { createGatewayApp } from '../gateway/app.js';

const project = {
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
    teachers: [
        { id: 't_wang', name: '王老师' },
        { id: 't_busy', name: '忙老师' },
    ],
    lessonPlans: [
        { id: 'lp_busy', teacherId: 't_busy', weeklyHours: 36 },
    ],
};

async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    return { server, base: `http://127.0.0.1:${address.port}` };
}

test('smart helper scan reports real stats and only marks inferable missing slots auto-fixable', async () => {
    const constraints = [{
        id: 'missing-inferable',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_wang',
        targetName: '王老师',
        rawText: '王老师周三下午不排课',
        slots: [],
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
    }, {
        id: 'missing-unknown',
        type: 'class_unavailable',
        targetType: 'class',
        targetId: 'c1',
        targetName: '七年级1班',
        rawText: '七年级1班有活动',
        slots: [],
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
    }];

    const result = await autoScanConstraints(constraints, { ...project, lessonPlans: [] });
    const missing = result.problems.find(problem => problem.id === 'missing_slots');

    assert.equal(missing.count, 2);
    assert.equal(missing.autoFixable, true);
    assert.equal(missing.autoFixableCount, 1);
    assert.equal(result.stats.autoFixable, 1);
    assert.equal(result.stats.checksPerformed, 5);
    assert.equal(typeof result.stats.scanDuration, 'number');
    assert.equal(result.stats.complianceScore, result.stats.completeness);
});

test('smart helper missing-slot fix derives slots from text instead of hard-coded placeholders', async () => {
    const problem = {
        id: 'missing_slots',
        count: 1,
        constraints: [{
            id: 'missing-inferable',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't_wang',
            targetName: '王老师',
            rawText: '王老师周三下午不排课',
            slots: [],
        }],
    };

    const fix = await generateAutoFix(problem, project);

    assert.equal(fix.fixes[0].action, 'set_slots');
    assert.deepEqual(fix.fixes[0].slots, ['3-5', '3-6', '3-7']);
    assert.notDeepEqual(fix.fixes[0].slots, ['1-1', '1-2', '1-3']);
});

test('smart helper teacher overload fix creates a reviewable soft rule draft row', async () => {
    const scan = await autoScanConstraints([], project);
    const overload = scan.problems.find(problem => problem.id === 'teacher_overload');
    const fix = await generateAutoFix(overload, project);

    assert.equal(fix.fixes[0].action, 'add_constraint');
    assert.equal(fix.fixes[0].constraint.type, 'teacher_daily_limit');
    assert.equal(fix.fixes[0].constraint.targetId, 't_busy');
    assert.equal(fix.fixes[0].constraint.priority, 'soft');
    assert.equal(fix.fixes[0].constraint.status, 'effective');
});

test('smart helper conflict fix names the changed row and replacement slot', async () => {
    const conflictProblem = {
        id: 'time_conflicts',
        count: 1,
        conflicts: [{
            slot: '1-1',
            constraints: [{
                id: 'row-a',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_wang',
                targetName: '王老师',
                slots: ['1-1'],
            }, {
                id: 'row-b',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_wang',
                targetName: '王老师',
                slots: ['1-1'],
            }],
        }],
    };

    const fix = await generateAutoFix(conflictProblem, project);

    assert.equal(fix.fixes[0].action, 'replace_slot');
    assert.equal(fix.fixes[0].constraintId, 'row-b');
    assert.equal(fix.fixes[0].from, '1-1');
    assert.match(fix.fixes[0].to, /^\d-\d$/);
    assert.notEqual(fix.fixes[0].to, '1-1');
});

test('smart helper scan API validates request shape and returns stats contract', async () => {
    const { server, base } = await listen(createGatewayApp({ isDev: false }));
    try {
        const invalid = await fetch(`${base}/api/tools/timetable/constraints/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ constraints: {}, project }),
        });
        const invalidPayload = await invalid.json();
        assert.equal(invalid.status, 400);
        assert.equal(invalidPayload.success, false);
        assert.match(invalidPayload.error, /constraints 必须是数组/);

        const valid = await fetch(`${base}/api/tools/timetable/constraints/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ constraints: [], project }),
        });
        const payload = await valid.json();
        assert.equal(valid.status, 200);
        assert.equal(payload.success, true);
        assert.equal(typeof payload.data.stats.total, 'number');
        assert.equal(typeof payload.data.stats.scanDuration, 'number');
        assert.equal(payload.data.stats.checksPerformed, 5);
        assert.equal(payload.data.stats.complianceScore, payload.data.stats.completeness);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
