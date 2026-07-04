import { describe, test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import AdmZip from 'adm-zip';

import {
    applyTimetableRequirementActions,
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

function xmlEscape(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
    })[char]);
}

function buildConstraintWorkbook(rows = []) {
    const strings = rows.flat();
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map(value => `<si><t>${xmlEscape(value)}</t></si>`).join('')}
</sst>`;
    let stringIndex = 0;
    const sheetRows = rows.map((row, rowIndex) => {
        const cells = row.map((_, columnIndex) => {
            const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
            return `<c r="${ref}" t="s"><v>${stringIndex++}</v></c>`;
        }).join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const zip = new AdmZip();
    zip.addFile('xl/sharedStrings.xml', Buffer.from(sharedStrings, 'utf8'));
    zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="AI约束建议" sheetId="1" r:id="rId1"/></sheets>
</workbook>`, 'utf8'));
    zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`, 'utf8'));
    zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`, 'utf8'));
    return zip.toBuffer();
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

test('local fallback prefers explicit periods over broad morning text', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语文尽量安排在上午第1-3节',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'subject_preferred_periods' && r.targetId === 's1');
    assert.ok(row, 'should produce a subject_preferred_periods row');
    assert.equal(row.status, 'effective');
    assert.deepEqual(row.slots, [
        '1-1', '1-2', '1-3',
        '2-1', '2-2', '2-3',
        '3-1', '3-2', '3-3',
        '4-1', '4-2', '4-3',
        '5-1', '5-2', '5-3',
    ]);
    assert.equal(result.draftRows.some(r => r.type === 'subject_morning' && r.targetId === 's1'), false);
});

test('local fallback keeps continuation context for grouped subject period preferences', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语文、数学、英语尽量安排在上午前四节，尤其优先第1-3节。',
        project,
        env: {},
    });
    const rows = result.draftRows
        .filter(row => row.type === 'subject_preferred_periods')
        .sort((left, right) => left.targetId.localeCompare(right.targetId));
    assert.deepEqual(rows.map(row => row.targetId), ['s1', 's2', 's3']);
    assert.ok(rows.every(row => row.status === 'effective'));
    assert.ok(rows.every(row => row.slots.includes('1-1') && row.slots.includes('5-3')));
    assert.ok(rows.every(row => !row.slots.includes('1-4') && !row.slots.includes('5-4')));
});

test('local fallback parses Chinese numeral front periods for unavailable teachers', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '张老师周一前两节不排',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'teacher_unavailable');
    assert.ok(row);
    assert.equal(row.targetId, 't1');
    assert.deepEqual(row.slots, ['1-1', '1-2']);
    assert.equal(row.status, 'effective');
});

test('local fallback parses subject avoid periods without a broad day part', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '体育第一节不要排',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'subject_avoid_periods' && r.targetId === 's4');
    assert.ok(row);
    assert.equal(row.status, 'effective');
    assert.deepEqual(row.slots, ['1-1', '2-1', '3-1', '4-1', '5-1']);
});

test('parseTimetableRules returns object-first requirement semantics and actions for supported demands', async () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp_math_c1', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 4, blockPreference: 'single' },
            { id: 'lp_math_c2', classId: 'c2', subjectId: 's2', teacherId: 't2', weeklyHours: 4, blockPreference: 'single' },
        ],
    });
    const result = await parseTimetableRules({
        text: '数学必须连堂；未注明默认单节；连堂块不能拆开；高负载教师不要连续太多。',
        project,
        env: {},
    });

    const blockRequirement = result.requirementItems.find(item => item.intent === 'block_preference');
    assert.ok(blockRequirement);
    assert.equal(blockRequirement.object.kind, 'subject');
    assert.equal(blockRequirement.object.name, '数学');
    assert.deepEqual(blockRequirement.object.matchedIds, ['s2']);
    assert.equal(blockRequirement.applyTo, 'lesson_plan');
    assert.equal(blockRequirement.parameters.blockPreference, 'double');

    const defaultSingle = result.requirementItems.find(item => item.intent === 'default_block_policy');
    assert.ok(defaultSingle);
    assert.equal(defaultSingle.status, 'handled');
    assert.equal(defaultSingle.applyTo, 'solver_policy');

    const blockIntegrity = result.requirementItems.find(item => item.intent === 'block_integrity');
    assert.ok(blockIntegrity);
    assert.equal(blockIntegrity.status, 'handled');
    assert.equal(blockIntegrity.object.kind, 'lesson_block');

    const highLoad = result.requirementItems.find(item => item.intent === 'teacher_load_protection');
    assert.ok(highLoad);
    assert.equal(highLoad.object.kind, 'derived_group');
    assert.equal(highLoad.applyTo, 'optimization');

    const actionKinds = result.semanticActions.map(action => action.kind).sort();
    assert.ok(actionKinds.includes('lesson_plan_patch'));
    assert.ok(actionKinds.includes('soft_rules_patch'));
    const blockAction = result.semanticActions.find(action => action.kind === 'lesson_plan_patch');
    assert.equal(blockAction.status, 'ready');
    assert.deepEqual(blockAction.target.lessonPlanIds.sort(), ['lp_math_c1', 'lp_math_c2']);
    assert.equal(blockAction.patch.blockPreference, 'double');
});

test('parseTimetableRules treats system invariants as handled requirements instead of noisy all-slot rules', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '同一位教师同一时间只能给一个班上课。同一个班级同一时间只能安排一门课程。',
        project,
        env: {},
    });

    assert.equal(result.draftRows.some(row => row.type === 'teacher_unavailable'), false);
    assert.equal(result.draftRows.some(row => row.type === 'class_unavailable'), false);
    assert.ok(result.requirementItems.some(item => item.intent === 'teacher_time_conflict' && item.status === 'handled'));
    assert.ok(result.requirementItems.some(item => item.intent === 'class_time_conflict' && item.status === 'handled'));
});

test('applyTimetableRequirementActions applies lesson-plan and soft-rule semantic actions with validation', () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp_math', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 4, blockPreference: 'single' },
        ],
    });
    const result = applyTimetableRequirementActions({
        project,
        actions: [
            {
                id: 'act_block',
                kind: 'lesson_plan_patch',
                target: { lessonPlanIds: ['lp_math'] },
                patch: { blockPreference: 'double' },
            },
            {
                id: 'act_soft',
                kind: 'soft_rules_patch',
                target: { teacherIds: ['t1', 'missing_teacher'] },
                patch: { teacherLimits: { consecutive: 3 }, balancedTeacherLoad: true },
            },
        ],
    });

    assert.equal(result.project.lessonPlans.find(plan => plan.id === 'lp_math').blockPreference, 'double');
    assert.equal(result.project.rules.softRules.teacherLimits.t1.consecutive, 3);
    assert.equal(result.project.rules.softRules.balancedTeacherLoad, true);
    assert.ok(result.applied.some(item => item.id === 'act_block'));
    assert.ok(result.applied.some(item => item.id === 'act_soft'));
    assert.ok(result.needsReview.some(item => item.id === 'act_soft' && /missing_teacher/.test(item.reason)));
});

test('local fallback marks unsupported week-pattern constraints for review instead of applying them', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '单周语文第1节优先',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.targetId === 's1' || r.targetName === '语文');
    assert.ok(row);
    assert.equal(row.weekPattern, 'odd');
    assert.equal(row.status, 'needs_review');
    assert.match(row.warnings.join(' '), /单双周|不会自动生效/);
    assert.equal(result.draftRules.softRules.subjectPreferredPeriods?.s1, undefined);
});

test('xlsx local fallback preserves sheet and row source for expanded subject rules', async () => {
    const project = makeProject();
    const file = {
        filename: 'AI排课约束建议.xlsx',
        buffer: buildConstraintWorkbook([
            ['约束内容'],
            ['语文、数学、英语尽量安排在上午第1-3节'],
        ]),
    };
    const result = await parseTimetableRules({ file, project, env: {} });
    const rows = result.draftRows
        .filter(row => row.type === 'subject_preferred_periods')
        .sort((left, right) => left.targetId.localeCompare(right.targetId));
    assert.deepEqual(rows.map(row => row.targetId), ['s1', 's2', 's3']);
    assert.ok(rows.every(row => row.sourceSheet === 'AI约束建议'));
    assert.ok(rows.every(row => row.sourceRow === 2));
});

test('normalize splits a grouped subject target into independent effective rules', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        source: 'ai',
        draftRows: [{
            id: 'grouped-subjects',
            rawText: '语文、数学、英语尽量安排到上午',
            type: 'subject_morning',
            targetType: 'subject',
            targetName: '语文,数学,英语',
            priority: 'soft',
            status: 'effective',
            confidence: 0.92,
        }],
    });

    const rows = result.draftRows.filter(row => row.type === 'subject_morning');
    assert.deepEqual(rows.map(row => row.targetId), ['s1', 's2', 's3']);
    assert.deepEqual(rows.map(row => row.targetName), ['语文', '数学', '英语']);
    assert.ok(rows.every(row => row.status === 'effective'));
    assert.deepEqual(result.clarifyingQuestions, []);
    assert.deepEqual(result.missingInfo, []);
});

test('normalize splits a grouped ambiguous teacher target before asking questions', () => {
    const project = makeProject();
    const groupedCandidates = project.teachers.slice(0, 2).map(teacher => ({
        id: teacher.id,
        label: teacher.name,
        confidence: 0.7,
    }));
    const result = normalizeTimetableRuleDraftRows({
        project,
        source: 'ai',
        draftRows: [{
            id: 'grouped-teachers',
            rawText: '张老师、李老师周一第一节不排',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetName: '张老师、李老师',
            slots: ['1-1'],
            priority: 'hard',
            status: 'needs_review',
            confidence: 0.9,
            warnings: ['存在多个候选，系统不会自动猜测。'],
            ambiguity: {
                field: 'target',
                targetType: 'teacher',
                targetText: '张老师、李老师',
                candidates: groupedCandidates,
            },
            ambiguities: [{
                field: 'target',
                targetType: 'teacher',
                targetText: '张老师、李老师',
                candidates: groupedCandidates,
            }],
        }],
    });

    assert.deepEqual(result.draftRows.map(row => row.targetId), ['t1', 't2']);
    assert.ok(result.draftRows.every(row => row.status === 'effective'));
    assert.deepEqual(result.clarifyingQuestions, []);
    assert.deepEqual(result.draftRules.hardRules.teacherUnavailable, {
        t1: ['1-1'],
        t2: ['1-1'],
    });
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

test('normalize returns a four-category rule report without dropping legacy fields', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{
            id: 'rule_kept',
            type: 'teacher_unavailable',
            targetId: 't1',
            slots: ['1-1'],
            confidence: 0.95,
        }, {
            id: 'rule_review',
            type: 'teacher_unavailable',
            targetName: '未知老师',
            slots: ['1-2'],
            confidence: 0.72,
        }, {
            id: 'rule_degraded',
            type: 'teacher_load_balance',
            targetId: 't1',
            confidence: 0.9,
        }, {
            id: 'rule_dropped',
            type: 'teacher_unavailable',
            targetId: 't1',
            slots: [],
            status: 'invalid',
            confidence: 0.4,
        }],
        source: 'test',
        inputType: 'text',
        initialWarnings: ['原始规则里有一条需要人工确认。'],
    });

    assert.ok(result.ruleReport);
    assert.equal(result.ruleReport.summary.kept, 1);
    assert.equal(result.ruleReport.summary.review >= 1, true);
    assert.equal(result.ruleReport.summary.degraded, 1);
    assert.equal(result.ruleReport.summary.dropped, 1);
    assert.equal(result.ruleReport.hasIssues, true);
    assert.ok(result.ruleReport.entries.some(item => item.category === 'kept' && item.source.rowId === 'rule_kept'));
    assert.ok(result.ruleReport.entries.some(item => item.category === 'review' && /需要复核|人工确认/.test(item.reason)));
    assert.ok(result.ruleReport.entries.some(item => item.category === 'degraded' && item.source.rowId === 'rule_degraded'));
    assert.ok(result.ruleReport.entries.some(item => item.category === 'dropped' && item.source.rowId === 'rule_dropped'));
    assert.ok(Array.isArray(result.draftRows));
    assert.ok(Array.isArray(result.autoAcceptable));
    assert.ok(Array.isArray(result.needReview));
    assert.ok(Array.isArray(result.unsupportedItems));
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

import {
    buildTimetableRosterFromRows,
    parseRosterAiOrLocal,
    previewTimetableRosterText,
} from '../gateway/services/timetable-import.js';

test('parseRosterAiOrLocal falls back to local when no API key', async () => {
    const text = 'grade,class,subject,teacher,hours\nG8,1班,数学,张老师,4';
    const result = await parseRosterAiOrLocal({ text, project: {}, env: {} });
    assert.equal(result.source, 'local');
    assert.ok(result.draftRows.length >= 1);
});

test('timetable roster preview includes a four-category import report', () => {
    const text = [
        'grade,class,subject,teacher,hours,block',
        'G8,1班,数学,张老师,4,double',
        'G8,1班,数学,张老师,4,double',
        'G8,2班,语文,,3,single',
        'G8,3班,英语,李老师,3,三连堂',
    ].join('\n');
    const result = previewTimetableRosterText(text, { project: makeProject() });

    assert.ok(result.importReport);
    assert.equal(result.importReport.summary.kept, 2);
    assert.equal(result.importReport.summary.dropped, 1);
    assert.equal(result.importReport.summary.review, 1);
    assert.equal(result.importReport.summary.degraded, 1);
    assert.equal(result.importReport.hasIssues, true);
    assert.ok(result.importReport.entries.some(item => item.category === 'dropped' && item.field === 'teacherName'));
    assert.ok(result.importReport.entries.some(item => item.category === 'review' && /重复任课/.test(item.reason)));
    assert.ok(result.importReport.entries.some(item => item.category === 'degraded' && item.field === 'blockPreference'));
    assert.ok(result.draftRows.length >= 4);
    assert.ok(Array.isArray(result.issues));
});

test('timetable roster import preserves legacy fields and returns import report', () => {
    const rows = [{
        id: 'draft_valid',
        grade: 'G8',
        className: '1班',
        subjectName: '数学',
        teacherName: '张老师',
        weeklyHours: 4,
        blockPreference: 'double',
    }];
    const result = buildTimetableRosterFromRows(rows, { project: makeProject() });

    assert.equal(result.count, 1);
    assert.equal(result.lessonPlans.length, 1);
    assert.ok(result.importReport);
    assert.equal(result.importReport.summary.kept, 1);
    assert.equal(result.importReport.summary.total, 1);
    assert.equal(result.importReport.hasIssues, false);
});

test('parseRosterAiOrLocal throws on empty input', async () => {
    await assert.rejects(
        () => parseRosterAiOrLocal({ text: '', project: {}, env: {} }),
        error => /为空/.test(error.message),
    );
});
