import { describe, test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseTimetableRules,
    continueTimetableRuleConversation,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    TimetableRuleParseError,
} from '../gateway/services/timetable-rule-parser.js';

// --- Helpers ---

function makeProject(overrides = {}) {
    return {
        teachers: [
            { id: 't1', name: '张老师' },
            { id: 't2', name: '李老师' },
            { id: 't3', name: '王老师' },
        ],
        classes: [
            { id: 'c1', name: '一(1)班', grade: '一年级' },
            { id: 'c2', name: '二(1)班', grade: '二年级' },
        ],
        subjects: [
            { id: 's1', name: '语文' },
            { id: 's2', name: '数学' },
            { id: 's3', name: '英语' },
            { id: 's4', name: '体育' },
        ],
        periods: [
            { day: 1, period: 1 }, { day: 1, period: 2 }, { day: 1, period: 3 }, { day: 1, period: 4 },
            { day: 2, period: 1 }, { day: 2, period: 2 }, { day: 2, period: 3 }, { day: 2, period: 4 },
            { day: 3, period: 1 }, { day: 3, period: 2 }, { day: 3, period: 3 }, { day: 3, period: 4 },
            { day: 4, period: 1 }, { day: 4, period: 2 }, { day: 4, period: 3 }, { day: 4, period: 4 },
            { day: 5, period: 1 }, { day: 5, period: 2 }, { day: 5, period: 3 }, { day: 5, period: 4 },
        ],
        periodsPerDay: 4,
        weekdays: 5,
        rules: { hardRules: {}, softRules: {} },
        ...overrides,
    };
}

// --- Tests ---

// ============================================================
// 1. parseTimetableRules — local fallback (no API key)
// ============================================================

test('parseTimetableRules falls back to local parser when no API key is configured', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '张老师周一第1节不排',
        project,
        env: {},
    });
    assert.ok(result.draftRows.length >= 1);
    assert.ok(result.warnings.some(w => /智能解析不可用/.test(w)));
});

test('parseTimetableRules throws on empty text input', async () => {
    const project = makeProject();
    await assert.rejects(
        () => parseTimetableRules({ text: '', project, env: {} }),
        error => error instanceof TimetableRuleParseError && error.reason === 'empty_prompt',
    );
});

test('parseTimetableRules throws on unsupported file type', async () => {
    const project = makeProject();
    await assert.rejects(
        () => parseTimetableRules({
            text: '',
            file: { buffer: Buffer.from('test'), filename: 'test.pdf' },
            project,
            env: {},
        }),
        error => error instanceof TimetableRuleParseError && error.reason === 'unsupported_file_type',
    );
});

// ============================================================
// 2. Local fallback: teacher_unavailable
// ============================================================

test('local fallback parses teacher_unavailable with exact match', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '张老师周一第1节不排',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'teacher_unavailable');
    assert.ok(row);
    assert.equal(row.targetId, 't1');
    assert.equal(row.targetName, '张老师');
    assert.equal(row.status, 'effective');
    assert.ok(row.confidence >= 0.85, `confidence ${row.confidence} should be >= 0.85`);
    assert.deepEqual(row.slots, ['1-1']);
});

test('local fallback does not create ambiguity when name is an exact match', async () => {
    // 项目中有"张老师"和"张明",但输入精确写了"张老师",应该直接匹配不追问
    const project = makeProject({
        teachers: [{ id: 't1', name: '张老师' }, { id: 't3', name: '张明' }],
    });
    const result = await parseTimetableRules({
        text: '张老师周一第2节不排',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'teacher_unavailable');
    assert.equal(row.targetId, 't1');
    assert.equal(row.status, 'effective');
    assert.equal(row.ambiguity, null);
    assert.equal(result.clarifyingQuestions.length, 0);
});

// ============================================================
// 3. Local fallback: teacher_daily_limit
// ============================================================

test('local fallback parses teacher_daily_limit and marks effective', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '李老师每天最多3节',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'teacher_daily_limit');
    assert.ok(row);
    assert.equal(row.targetId, 't2');
    assert.equal(row.limit, 3);
    assert.equal(row.status, 'effective');
    assert.ok(row.confidence >= 0.85);
});

test('local fallback parses teacher_consecutive_limit', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '王老师连续上课最多2节',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'teacher_consecutive_limit');
    assert.ok(row, 'should find teacher_consecutive_limit row');
    assert.equal(row.targetId, 't3');
    assert.equal(row.limit, 2);
    assert.equal(row.status, 'effective');
});

// ============================================================
// 4. Local fallback: subject_morning
// ============================================================

test('local fallback parses subject_morning for named subjects', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语文尽量安排到上午',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'subject_morning' && r.targetId === 's1');
    assert.ok(row);
    assert.equal(row.status, 'effective');
});

test('local fallback parses "语数英尽量上午" as 3 subject_morning rules', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语数英尽量安排到上午',
        project,
        env: {},
    });
    const morningRows = result.draftRows.filter(r => r.type === 'subject_morning' && r.status === 'effective');
    assert.ok(morningRows.length >= 3, `expected >= 3 subject_morning effective rows, got ${morningRows.length}`);
});

// ============================================================
// 5. Local fallback: class_unavailable
// ============================================================

test('local fallback parses class_unavailable with afternoon slots', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '一(1)班周五下午不排课',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'class_unavailable');
    assert.ok(row, 'should find class_unavailable row');
    assert.equal(row.targetId, 'c1');
    // with periodsPerDay=4, afternoon periods are [3,4], day 5
    assert.ok(row.slots.every(s => s.startsWith('5-')), 'slots should be on day 5');
    assert.ok(row.slots.length >= 2, 'should have at least 2 afternoon slots');
    // With periodsPerDay=4 and activePeriods=[1,2,3,4], slots 5-3 and 5-4 are valid
    assert.equal(row.status, 'effective');
});

// ============================================================
// 6. normalizeTimetableRuleDraftRows — conflict detection
// ============================================================

test('normalize detects blocking conflict for duplicate locked slots on same teacher', () => {
    const project = makeProject();
    // Two locked_slot rules: same teacher, same time slot, different classes → blocking
    const draftRows = [
        {
            type: 'locked_slot',
            teacherId: 't1',
            teacherName: '张老师',
            classId: 'c1',
            className: '一(1)班',
            subjectId: 's1',
            subjectName: '语文',
            slots: ['1-1'],
            confidence: 0.9,
            status: 'effective',
        },
        {
            type: 'locked_slot',
            teacherId: 't1',
            teacherName: '张老师',
            classId: 'c2',
            className: '二(1)班',
            subjectId: 's2',
            subjectName: '数学',
            slots: ['1-1'],
            confidence: 0.9,
            status: 'effective',
        },
    ];
    const result = normalizeTimetableRuleDraftRows({ project, draftRows, source: 'test' });
    const blockingConflicts = result.conflicts.filter(c => c.level === 'blocking');
    assert.ok(blockingConflicts.length >= 1, 'should detect blocking conflict for same teacher same slot');
});

// ============================================================
// 7. continueTimetableRuleConversation — clarify flow
// ============================================================

test('clarify answers resolve ambiguity and set status to effective', () => {
    const project = makeProject({
        teachers: [{ id: 't1', name: '张三' }, { id: 't2', name: '张四' }],
    });
    // Simulate a row with ambiguity (two candidates for "张")
    const draftRows = [{
        id: 'rule_draft_1',
        type: 'teacher_unavailable',
        targetId: '',
        targetName: '张',
        slots: ['1-1'],
        confidence: 0.7,
        status: 'needs_review',
        warnings: ['张 存在多个候选，请确认后再生效。'],
        ambiguity: {
            field: 'target',
            targetType: 'teacher',
            targetText: '张',
            candidates: [
                { id: 't1', name: '张三', label: '张三', confidence: 0.72 },
                { id: 't2', name: '张四', label: '张四', confidence: 0.72 },
            ],
        },
        ambiguities: [{
            field: 'target',
            targetType: 'teacher',
            targetText: '张',
            candidates: [
                { id: 't1', name: '张三', label: '张三', confidence: 0.72 },
                { id: 't2', name: '张四', label: '张四', confidence: 0.72 },
            ],
        }],
    }];
    const result = continueTimetableRuleConversation({
        project,
        draftRows,
        answers: [{ questionId: 'q_rule_draft_1_target', value: 't1', label: '张三' }],
        originalText: '张周一第1节不排',
    });
    const row = result.draftRows[0];
    assert.equal(row.targetId, 't1');
    assert.equal(row.targetName, '张三');
    assert.equal(row.status, 'effective');
    assert.ok(row.confidence >= 0.85);
    assert.equal(row.ambiguity, null);
});

test('clarify without answers does not change status', () => {
    const project = makeProject();
    const draftRows = [{
        id: 'rule_draft_1',
        type: 'teacher_unavailable',
        targetId: '',
        targetName: '不存在的人',
        slots: ['1-1'],
        confidence: 0.5,
        status: 'needs_review',
        ambiguity: null,
        ambiguities: [],
        warnings: [],
    }];
    const result = continueTimetableRuleConversation({
        project,
        draftRows,
        answers: [],
        originalText: '不存在的人周一第1节不排',
    });
    assert.equal(result.draftRows[0].status, 'needs_review');
});

// ============================================================
// 8. diagnoseTimetableRules
// ============================================================

test('diagnose reports no blocking rules for safe constraints', () => {
    const project = makeProject();
    const draftRows = [{
        type: 'teacher_daily_limit',
        targetId: 't1',
        targetName: '张老师',
        limit: 3,
        confidence: 0.9,
        status: 'effective',
    }];
    const diagnosis = diagnoseTimetableRules({ project, draftRows });
    assert.equal(diagnosis.blockingRules.length, 0);
    assert.ok(diagnosis.summary.includes('没有明显无解风险'));
});

test('diagnose reports blocking rules when teacher is fully unavailable', () => {
    const project = makeProject();
    // Make t1 unavailable for 4 out of 4 periods per day (via project rules)
    project.rules.hardRules.teacherUnavailable = {
        t1: ['1-1', '1-2', '1-3', '1-4', '2-1', '2-2', '2-3', '2-4', '3-1', '3-2', '3-3', '3-4', '4-1', '4-2', '4-3', '4-4', '5-1', '5-2', '5-3', '5-4'],
    };
    const diagnosis = diagnoseTimetableRules({ project, draftRows: [] });
    assert.ok(diagnosis.blockingRules.length >= 1);
});

// ============================================================
// 9. Multiple constraints in one input
// ============================================================

test('local fallback parses multiple constraints from compound text', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '张老师周一第1节不排；李老师每天最多3节；语文尽量安排到上午',
        project,
        env: {},
    });
    const types = result.draftRows.map(r => r.type);
    assert.ok(types.includes('teacher_unavailable'));
    assert.ok(types.includes('teacher_daily_limit'));
    assert.ok(types.includes('subject_morning'));
    // All should be effective (exact matches)
    const effectiveCount = result.draftRows.filter(r => r.status === 'effective').length;
    assert.ok(effectiveCount >= 3, `expected >= 3 effective rows, got ${effectiveCount}`);
});

// ============================================================
// 10. Edge cases
// ============================================================

test('normalize handles empty draftRows gracefully', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({ project, draftRows: [], source: 'test' });
    assert.deepEqual(result.draftRows, []);
    assert.deepEqual(result.autoAcceptable, []);
    assert.deepEqual(result.clarifyingQuestions, []);
    assert.equal(result.nextAction, 'no_result');
});

test('normalize handles unsupported constraint type', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{ type: 'teacher_load_balance', targetId: 't1', confidence: 0.9 }],
        source: 'test',
    });
    assert.equal(result.draftRows[0].status, 'suggestion');
});

test('normalize handles completely unknown type as unsupported', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{ type: 'teleportation_constraint', targetId: 't1', confidence: 0.9 }],
        source: 'test',
    });
    assert.equal(result.draftRows[0].status, 'unsupported');
});

// ============================================================
// 11. Period Times (data model)
// ============================================================

import { normalizePeriodTimes, generateDefaultPeriodTimes, normalizeTimetableProject } from '../gateway/services/timetable-project.js';

test('normalizePeriodTimes filters invalid entries and non-active periods', () => {
    const raw = [
        { period: 1, start: '08:00', end: '08:40' },
        { period: 2, start: 'bad', end: '09:30' },
        { period: 99, start: '10:00', end: '10:40' },
        { period: 3, start: '09:40', end: '10:20' },
    ];
    const result = normalizePeriodTimes(raw, [1, 2, 3]);
    assert.equal(result.length, 3);
    assert.equal(result[0].start, '08:00');
    assert.equal(result[1].start, ''); // 'bad' filtered out
    assert.equal(result[2].start, '09:40');
});

test('generateDefaultPeriodTimes produces correct time slots', () => {
    const times = generateDefaultPeriodTimes([1, 2, 3, 4, 5, 6, 7]);
    assert.equal(times.length, 7);
    assert.equal(times[0].start, '08:00');
    assert.equal(times[0].end, '08:40');
    assert.equal(times[1].start, '08:50');
    // After lunch (period 5+), times should jump
    assert.ok(times[4].start > '11:30', `afternoon should start after 11:30, got ${times[4].start}`);
});

test('normalizeTimetableProject preserves periodTimes', () => {
    const project = normalizeTimetableProject({
        periodsPerDay: 4,
        weekdays: 5,
        periodTimes: [
            { period: 1, start: '08:00', end: '08:40' },
            { period: 2, start: '08:50', end: '09:30' },
        ],
    });
    assert.equal(project.periodTimes.length, 2);
    assert.equal(project.periodTimes[0].period, 1);
    assert.equal(project.periodTimes[0].start, '08:00');
});

// ============================================================
// 12. AI Roster Parsing (local fallback)
// ============================================================

import { parseRosterAiOrLocal } from '../gateway/services/timetable-import.js';

test('parseRosterAiOrLocal falls back to local when no API key', async () => {
    const text = 'grade,class,subject,teacher,hours\nG8,1班,数学,张老师,4';
    const result = await parseRosterAiOrLocal({ text, project: {}, env: {} });
    assert.equal(result.source, 'local');
    assert.ok(result.draftRows.length >= 1);
});

test('parseRosterAiOrLocal throws on empty input', async () => {
    await assert.rejects(
        () => parseRosterAiOrLocal({ text: '', project: {}, env: {} }),
        error => /为空/.test(error.message),
    );
});
