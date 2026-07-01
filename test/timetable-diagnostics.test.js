import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
    createDefaultTimetableProject,
    runTimetableScheduler,
    validateTimetablePublication,
} from '../gateway/services/timetable-scheduler.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';
import { buildTimetableDiagnostics } from '../gateway/services/timetable-diagnostics.js';

function impossibleProject() {
    return createDefaultTimetableProject({
        weekdays: 1,
        periodsPerDay: 1,
        activeWeekdays: [1],
        activePeriods: [1],
        teachers: [{ id: 't_math', name: '陈老师', subjects: ['math'], unavailableSlots: [] }],
        classes: [
            { id: 'c1', grade: '七年级', name: '1班' },
            { id: 'c2', grade: '七年级', name: '2班' },
        ],
        subjects: [{ id: 'math', name: '数学', priority: 100, color: '#14b8a6' }],
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
            { id: 'lp2', classId: 'c2', subjectId: 'math', teacherId: 't_math', weeklyHours: 1 },
        ],
        rules: { hardRules: {}, softRules: {} },
    });
}

test('timetable diagnostics aggregates schedule issues by severity and object', () => {
    const result = runTimetableScheduler(impossibleProject());
    const diagnostics = result.schedule.diagnostics;

    assert.equal(result.success, false);
    assert.ok(diagnostics);
    assert.equal(diagnostics.diagnosticsVersion, 1);
    assert.ok(diagnostics.summary.error >= 1);
    assert.ok(diagnostics.summary.total >= diagnostics.summary.error);
    assert.ok(diagnostics.items.some(item => item.category === 'unplaced' && item.severity === 'error'));
    assert.ok(diagnostics.items.some(item => item.targetKind === 'class' && item.targetId === 'c2'));
    assert.ok(Array.isArray(diagnostics.byObject.classes.c2));
    assert.ok(diagnostics.byObject.classes.c2.length >= 1);
    assert.ok(diagnostics.suggestions.some(item => item.targetDiagnostics?.length));
});

test('timetable diagnostics can include publication review items without mutating suggestions', () => {
    const scheduled = runTimetableScheduler(impossibleProject()).project;
    const publication = validateTimetablePublication(scheduled);
    const diagnostics = buildTimetableDiagnostics(scheduled, { publication });

    assert.equal(publication.ok, false);
    assert.ok(Array.isArray(publication.issueEntries));
    assert.deepEqual(publication.issueEntries, publication.reviewItems);
    assert.ok(diagnostics.items.some(item => item.category === 'publication' && item.type === 'incomplete_schedule'));
    assert.ok(diagnostics.items.some(item => item.category === 'publication' && item.severity === 'error'));
    assert.ok(diagnostics.suggestions.length >= 1);
    assert.ok(diagnostics.suggestions.every(item => item.applied === false));
    assert.equal(scheduled.schedule.publication?.diagnostics, undefined);
});

test('timetable diagnostics prefers publication issueEntries over legacy reviewItems when both exist', () => {
    const scheduled = runTimetableScheduler(impossibleProject()).project;
    const publication = {
        ...validateTimetablePublication(scheduled),
        issueEntries: [{
            type: 'manual_adjusted',
            severity: 'warning',
            targetKind: 'schedule',
            targetId: '',
            targetName: '课表',
            message: '请以 issueEntries 为准。',
        }],
        reviewItems: [{
            type: 'manual_adjusted',
            severity: 'warning',
            targetKind: 'schedule',
            targetId: '',
            targetName: '课表',
            message: '这是旧 reviewItems。',
        }],
    };
    const diagnostics = buildTimetableDiagnostics(scheduled, { publication });

    assert.ok(diagnostics.items.some(item => item.category === 'publication' && item.message === '请以 issueEntries 为准。'));
    assert.ok(!diagnostics.items.some(item => item.category === 'publication' && item.message === '这是旧 reviewItems。'));
});

test('timetable schedule run API persists diagnostics with the legacy response fields', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'icecream-timetable-diagnostics-'));

    const store = createTimetableStore();
    await store.saveProject(createDefaultTimetableProject({
        weekdays: 2,
        periodsPerDay: 2,
        activeWeekdays: [1, 2],
        activePeriods: [1, 2],
        teachers: [{ id: 't_math', name: 'Math Teacher', subjects: ['math'], unavailableSlots: [] }],
        classes: [{ id: 'c1', grade: 'G7', name: '1' }],
        subjects: [{ id: 'math', name: 'Math', priority: 90, color: '#2563eb' }],
        lessonPlans: [{ id: 'lp_math', classId: 'c1', subjectId: 'math', teacherId: 't_math', weeklyHours: 2 }],
        rules: { hardRules: {}, softRules: {} },
    }));

    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => {
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });

    try {
        const response = await fetch(`${baseUrl}/api/tools/timetable/schedule/run`, { method: 'POST' });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.ok(payload.data.schedule.diagnostics);
        assert.equal(payload.data.schedule.diagnostics.diagnosticsVersion, 1);
        assert.ok(Array.isArray(payload.data.schedule.conflicts));
        assert.ok(Array.isArray(payload.data.schedule.unplaced));
        assert.ok(payload.data.schedule.audit);
        assert.ok(payload.data.schedule.score);

        const saved = await store.loadProject();
        assert.ok(saved.schedule.diagnostics);
        assert.equal(saved.schedule.diagnostics.diagnosticsVersion, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) {
            delete process.env.TIMETABLE_DATA_DIR;
        } else {
            process.env.TIMETABLE_DATA_DIR = previousDataDir;
        }
    }
});
