import { describe, test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import AdmZip from 'adm-zip';

import {
    applyTimetableRequirementActions,
    continueTimetableRequirementClarification,
    parseTimetableRules,
    continueTimetableRuleConversation,
    diagnoseTimetableRules,
    normalizeTimetableRuleDraftRows,
    parserShadowTextWithTrace,
    TimetableRuleParseError,
} from '../gateway/services/timetable-rule-parser.js';
import {
    buildUnifiedRequirementItems,
} from '../public/js/tools/timetable/constraint-dialog-review-model.js';
import {
    buildSourceRequirements,
} from '../gateway/services/timetable-constraints/source-requirement.js';
import {
    compileRequirementToRows,
} from '../gateway/services/timetable-intent-compiler.js';

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

function aiExtractionFetch(extractionContent = {}, reviewItems = []) {
    return async (_url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const system = body.messages?.[0]?.content || '';
        const content = system.includes('复审核查员')
            ? { reviewItems }
            : extractionContent;
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: JSON.stringify(content) } }],
            }),
        };
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
    assert.equal(result.aiReview?.status, 'unavailable');
    assert.equal(result.sourceRequirements.length, 1);
    assert.equal(result.statistics.userInputCount, 1);
});

test('parseTimetableRules throws on empty text input', async () => {
    const project = makeProject();
    await assert.rejects(
        () => parseTimetableRules({ text: '', project, env: {} }),
        error => error instanceof TimetableRuleParseError && error.reason === 'empty_prompt',
    );
});

test('parseTimetableRules does not silently truncate long pasted text', async () => {
    const project = makeProject();
    const longText = Array.from({ length: 90 }, (_, index) => (
        `第${index + 1}条暂时无法识别的排课说明，包含一段用于撑长输入的描述文本，要求系统不要在中间截断，也不要把后面的内容丢掉。`
    )).join('\n');
    const aiRequests = [];

    assert.ok(longText.length > 4000);
    await parseTimetableRules({
        text: longText,
        project,
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: '1',
        },
        fetchImpl: async (_url, options = {}) => {
            const body = JSON.parse(options.body || '{}');
            const user = JSON.parse(body.messages?.[1]?.content || '{}');
            aiRequests.push(user.request || '');
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    choices: [{ message: { content: JSON.stringify({ draftRows: [], requirementItems: [], warnings: [] }) } }],
                }),
            };
        },
    });

    assert.equal(aiRequests.length, 1);
    assert.ok(aiRequests[0].length > 4000);
    assert.match(aiRequests[0], /第90条暂时无法识别的排课说明/);
    assert.ok(aiRequests[0].includes('\n'));
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

test('local fallback inherits teacher and slot for colloquial pronoun continuation', async () => {
    const project = makeProject({
        teachers: [{ id: 't_liu', name: '刘书涵' }],
    });
    const rawText = '刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const result = await parseTimetableRules({ text: rawText, project, env: {} });
    const row = result.draftRows.find(item => item.type === 'teacher_unavailable');

    assert.ok(row, 'pronoun continuation must produce an executable teacher_unavailable rule');
    assert.equal(row.targetId, 't_liu');
    assert.equal(row.targetName, '刘书涵');
    assert.deepEqual(row.slots, ['1-2']);
    assert.equal(row.status, 'effective');
    assert.equal(result.sourceRequirements.length, 1);
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

test('local fallback asks for a class before applying a named subject morning preference', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语文尽量安排到上午',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'subject_morning' && r.targetId === 's1');
    assert.ok(row);
    assert.equal(row.status, 'needs_review');
    assert.match(row.clarifications.join(' '), /补充班级.*全校/);
    assert.deepEqual(result.draftRules.softRules.morningSubjects || [], []);
});

test('local fallback keeps grouped subject morning preferences in range clarification', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语数英尽量安排到上午',
        project,
        env: {},
    });
    const morningRows = result.draftRows.filter(r => r.type === 'subject_morning');
    assert.ok(morningRows.length >= 3, `expected >= 3 subject_morning rows, got ${morningRows.length}`);
    assert.ok(morningRows.every(row => row.status === 'needs_review'));
    assert.deepEqual(result.draftRules.softRules.morningSubjects || [], []);
});

test('local fallback parses phase 1 rule primitives', async () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp1', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 3 },
            { id: 'lp2', classId: 'c1', subjectId: 's2', teacherId: 't2', weeklyHours: 3 },
        ],
    });
    const result = await parseTimetableRules({
        text: [
            '体育尽量安排到下午。',
            '周一第1节全校升旗不排课。',
            '李老师每周最多2节。',
            '张老师和李老师不能同时上课。',
            '语文每天最多1节。',
            '语文和数学不要排同一天。',
            '英语至少间隔2天。',
        ].join(''),
        project,
        env: {},
    });

    assert.ok(result.draftRows.some(row => row.type === 'subject_afternoon' && row.targetId === 's4' && row.status === 'effective'));
    assert.deepEqual(result.draftRules.softRules.afternoonSubjects, ['s4']);
    assert.ok(result.draftRows.some(row => row.type === 'global_unavailable' && row.slots.includes('1-1')));
    assert.ok(result.draftRules.hardRules.globalUnavailable.includes('1-1'));
    assert.ok(result.draftRows.some(row => row.type === 'teacher_weekly_limit' && row.targetId === 't2' && row.limit === 2));
    assert.equal(result.draftRules.hardRules.teacherWeeklyLimit.t2, 2);
    assert.ok(result.draftRows.some(row => row.type === 'teacher_mutual_exclusion' && row.status === 'effective'));
    assert.deepEqual(result.draftRules.hardRules.teacherMutualExclusion[0].teacherIds.sort(), ['t1', 't2']);
    assert.equal(result.draftRules.hardRules.subjectDailyLimit.s1, 1);
    assert.ok(result.draftRules.hardRules.subjectNotSameDay.some(item => item.subjectIds.includes('s1') && item.subjectIds.includes('s2')));
    assert.equal(result.draftRules.softRules.spreadSubjectGaps.s3, 2);
    assert.ok(result.conflicts.some(conflict => /每周上限 2 节/.test(conflict.message)));
});

test('local fallback parses room_requirement into hard room requirements', async () => {
    const project = makeProject({
        rooms: [{ id: 'gym', name: '体育馆', tags: ['sport'] }],
    });
    const result = await parseTimetableRules({
        text: '体育课安排在体育馆',
        project,
        env: {},
    });

    const row = result.draftRows.find(item => item.type === 'room_requirement');
    assert.ok(row);
    assert.equal(row.status, 'effective');
    assert.deepEqual(result.draftRules.hardRules.roomRequirements.s4.roomIds, ['gym']);
});

test('intent compiler accepts scalar matchedIds and compiles avoid_first_period into machine rules', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [],
        source: 'test',
        semanticRequirements: [{
            id: 'req_avoid_first',
            intent: 'avoid_first_period',
            object: { kind: 'subject', matchedIds: 's4', name: '体育' },
            source: { rawText: '全校体育不要排第一节' },
            confidence: 0.9,
        }],
    });

    const row = result.draftRows.find(item => item.type === 'subject_avoid_periods');
    assert.ok(row);
    assert.equal(row.requirementId, 'req_avoid_first');
    assert.deepEqual(row.slots, ['1-1', '2-1', '3-1', '4-1', '5-1']);
    assert.deepEqual(result.draftRules.softRules.subjectPreferredPeriods.s4.avoid, ['1-1', '2-1', '3-1', '4-1', '5-1']);
});

test('intent compiler accepts singleton project collections for teaching-group meetings', () => {
    const rows = compileRequirementToRows({
        id: 'req_teaching_group_singleton',
        intent: 'teaching_group_meeting',
        parameters: { subjectId: 's2', slots: '3-7' },
        source: { rawText: '数学组周三第7节集体备课，相关老师不要排课。' },
    }, {
        lessonPlans: { subjectId: 's2', teacherId: 't1' },
        teachers: { id: 't2', subjects: 's2' },
    });

    assert.deepEqual(rows.map(row => row.targetId).sort(), ['t1', 't2']);
    assert.ok(rows.every(row => row.status === 'effective'));
    assert.ok(rows.every(row => row.slots.length === 1 && row.slots[0] === '3-7'));
});

test('local fallback preserves explicit periods but requires a course range', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '语文尽量安排在上午第1-3节',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'subject_preferred_periods' && r.targetId === 's1');
    assert.ok(row, 'should produce a subject_preferred_periods row');
    assert.equal(row.status, 'needs_review');
    assert.match(row.clarifications.join(' '), /补充班级.*全校/);
    assert.deepEqual(row.slots, [
        '1-1', '1-2', '1-3',
        '2-1', '2-2', '2-3',
        '3-1', '3-2', '3-3',
        '4-1', '4-2', '4-3',
        '5-1', '5-2', '5-3',
    ]);
    assert.equal(result.draftRows.some(r => r.type === 'subject_morning' && r.targetId === 's1'), false);
});

test('local fallback keeps grouped subject period preferences for range clarification', async () => {
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
    assert.ok(rows.every(row => row.status === 'needs_review'));
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

test('local fallback preserves subject avoid periods but requires a course range', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '体育第一节不要排',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.type === 'subject_avoid_periods' && r.targetId === 's4');
    assert.ok(row);
    assert.equal(row.status, 'needs_review');
    assert.match(row.clarifications.join(' '), /补充班级.*全校/);
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
    assert.equal(highLoad.status, 'needs_review');
    assert.equal(highLoad.clarification?.field, 'maxConsecutive');

    const actionKinds = result.semanticActions.map(action => action.kind).sort();
    assert.ok(actionKinds.includes('lesson_plan_patch'));
    assert.equal(actionKinds.includes('soft_rules_patch'), false);
    const blockAction = result.semanticActions.find(action => action.kind === 'lesson_plan_patch');
    assert.equal(blockAction.status, 'ready');
    assert.deepEqual(blockAction.target.lessonPlanIds.sort(), ['lp_math_c1', 'lp_math_c2']);
    assert.equal(blockAction.patch.blockPreference, 'double');
});

test('parseTimetableRules asks for clarification before applying vague high-load teacher protection', async () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp_math_c1', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 6 },
            { id: 'lp_chinese_c1', classId: 'c1', subjectId: 's1', teacherId: 't2', weeklyHours: 5 },
        ],
    });
    const result = await parseTimetableRules({
        text: '高负载教师不要连续太多。',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'teacher_load_protection');
    assert.ok(requirement);
    assert.equal(requirement.status, 'needs_review');
    assert.equal(requirement.applyTo, 'optimization');
    assert.equal(requirement.clarification?.kind, 'number');
    assert.equal(requirement.clarification?.field, 'maxConsecutive');
    assert.equal(requirement.clarification?.defaultValue, 3);
    assert.match(requirement.clarification?.question || '', /连续/);
    assert.equal(result.semanticActions.some(action => action.requirementId === requirement.id && action.status === 'ready'), false);
    assert.ok(result.clarifyingQuestions.some(question => question.requirementId === requirement.id));
    assert.equal(result.nextAction, 'ask_user');
});

test('parseTimetableRules locally clarifies colloquial dense teacher load wording without AI', async () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp_math_c1', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 6 },
            { id: 'lp_chinese_c1', classId: 'c1', subjectId: 's1', teacherId: 't2', weeklyHours: 5 },
        ],
    });
    const result = await parseTimetableRules({
        text: '老师的课别太密。',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'teacher_load_protection');
    assert.ok(requirement);
    assert.equal(requirement.status, 'needs_review');
    assert.equal(requirement.applyTo, 'optimization');
    assert.equal(requirement.clarification?.field, 'maxConsecutive');
    assert.equal(result.nextAction, 'ask_user');
});

test('continueTimetableRequirementClarification supports multi-round high-load teacher clarification', () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp_math_c1', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 6 },
        ],
    });
    const previousResult = normalizeTimetableRuleDraftRows({
        project,
        originalText: '高负载教师不要连续太多。',
        semanticRequirements: [{
            id: 'req_high_load',
            object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t1'], scope: 'derived' },
            intent: 'teacher_load_protection',
            parameters: { balancedTeacherLoad: true },
            status: 'needs_review',
            applyTo: 'optimization',
            confidence: 0.82,
            clarification: {
                id: 'clarify_req_high_load_max_consecutive',
                kind: 'number',
                field: 'maxConsecutive',
                question: '连续超过几节算太多？',
                defaultValue: 3,
            },
        }],
    });

    const firstRound = continueTimetableRequirementClarification({
        project,
        previousResult,
        answers: [{ requirementId: 'req_high_load', field: 'maxConsecutive', value: 2 }],
    });

    const afterFirst = firstRound.requirementItems.find(item => item.id === 'req_high_load');
    assert.ok(afterFirst);
    assert.equal(afterFirst.status, 'needs_review');
    assert.equal(afterFirst.parameters.maxConsecutive, 2);
    assert.equal(afterFirst.clarification?.kind, 'choice');
    assert.equal(afterFirst.clarification?.field, 'dailyLimit');
    assert.equal(afterFirst.clarificationHistory.length, 1);
    assert.equal(firstRound.semanticActions.some(item => item.requirementId === 'req_high_load'), false);
    assert.equal(firstRound.nextAction, 'ask_user');

    const result = continueTimetableRequirementClarification({
        project,
        previousResult: firstRound,
        answers: [{ requirementId: 'req_high_load', field: 'dailyLimit', value: '4' }],
    });

    const requirement = result.requirementItems.find(item => item.id === 'req_high_load');
    assert.ok(requirement);
    assert.equal(requirement.status, 'actionable');
    assert.equal(requirement.parameters.maxConsecutive, 2);
    assert.equal(requirement.parameters.maxDaily, 4);
    assert.equal(requirement.clarification, null);
    assert.equal(requirement.clarificationHistory.length, 2);
    const action = result.semanticActions.find(item => item.requirementId === 'req_high_load');
    assert.ok(action);
    assert.equal(action.kind, 'soft_rules_patch');
    assert.equal(action.status, 'ready');
    assert.equal(action.patch.teacherLimits.consecutive, 2);
    assert.equal(action.patch.teacherLimits.daily, 4);
    assert.equal(result.nextAction, 'ready_to_apply');
});

test('continueTimetableRequirementClarification preserves source model and projects clauses without legacy requirementItems', () => {
    const project = makeProject({
        lessonPlans: [
            { id: 'lp_math_c1', classId: 'c1', subjectId: 's2', teacherId: 't1', weeklyHours: 6 },
        ],
    });
    const [sourceRequirement] = buildSourceRequirements([{
        lineNumber: 1,
        rawText: '高负载教师不要连续太多。',
    }], { inputType: 'text', origin: 'user_input' });
    const previousResult = normalizeTimetableRuleDraftRows({
        project,
        originalText: '高负载教师不要连续太多。',
        sourceRequirements: [sourceRequirement],
        semanticRequirements: [{
            id: 'req_high_load_source',
            sourceId: sourceRequirement.sourceId,
            textHash: sourceRequirement.source.textHash,
            rawText: sourceRequirement.source.rawText,
            lineNumber: 1,
            object: { kind: 'derived_group', name: '高负载教师', matchedIds: ['t1'], scope: 'derived' },
            intent: 'teacher_load_protection',
            parameters: { balancedTeacherLoad: true },
            status: 'needs_review',
            applyTo: 'optimization',
            confidence: 0.82,
            clarification: {
                id: 'clarify_req_high_load_source_max_consecutive',
                kind: 'number',
                field: 'maxConsecutive',
                question: '连续超过几节算太多？',
                defaultValue: 3,
            },
        }],
    });
    const systemSupplement = {
        supplementId: 'system:test',
        origin: 'system_supplement',
        reason: '系统规则',
    };

    const result = continueTimetableRequirementClarification({
        project,
        previousResult: {
            ...previousResult,
            requirementItems: [],
            systemSupplements: [systemSupplement],
        },
        answers: [{
            requirementId: 'req_high_load_source',
            field: 'maxConsecutive',
            value: 2,
        }],
    });

    assert.equal(result.sourceRequirements.length, 1);
    assert.equal(result.sourceRequirements[0].sourceId, sourceRequirement.sourceId);
    assert.equal(result.statistics.userInputCount, 1);
    assert.equal(result.systemSupplements.length, 1);
    assert.equal(result.systemSupplements[0].supplementId, 'system:test');
    assert.ok(result.constraintIRs.length > 0);
    const requirement = result.requirementItems.find(item => item.id === 'req_high_load_source');
    assert.ok(requirement);
    assert.equal(requirement.parameters.maxConsecutive, 2);
    assert.equal(requirement.clarification?.field, 'dailyLimit');
    const sourceClause = result.sourceRequirements[0].clauses.find(item => item.id === 'req_high_load_source');
    assert.ok(sourceClause);
    assert.equal(sourceClause.parameters.maxConsecutive, 2);
});

test('normalizeTimetableRuleDraftRows canonicalizes AI semantic requirement aliases', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [],
        source: 'ai',
        semanticRequirements: [
            {
                id: 'req_ai_morning',
                object: { kind: 'subject', name: '语文', matchedIds: ['s1'], scope: 'explicit' },
                intent: 'morning_preference',
                status: 'candidate',
                applyTo: 'rule',
                parameters: { dayPart: 'morning' },
                confidence: 0.84,
                source: { rawText: '语文尽量上午' },
            },
            {
                id: 'req_ai_spread',
                object: { kind: 'subject', name: '英语', matchedIds: ['s3'], scope: 'explicit' },
                intent: 'spread',
                status: 'candidate',
                applyTo: 'optimization',
                confidence: 0.78,
                source: { rawText: '英语不要集中在同一天' },
            },
            {
                id: 'req_ai_subject_morning',
                object: { kind: 'subject', name: '数学', matchedIds: ['s2'], scope: 'explicit' },
                intent: 'subject_morning',
                status: 'ready',
                applyTo: 'lessonPlan',
                confidence: 0.9,
                source: { rawText: '数学尽量上午' },
            },
            {
                id: 'req_ai_teacher_limit',
                object: { kind: 'teacher', name: '张老师', matchedIds: ['t1'], scope: 'explicit' },
                intent: 'teacher_daily_limit',
                status: 'suggestion',
                applyTo: 'rules',
                parameters: { limit: 4 },
                confidence: 0.86,
                source: { rawText: '张老师每天最多4节' },
            },
        ],
    });

    const morning = result.requirementItems.find(item => item.id === 'req_ai_morning');
    const spread = result.requirementItems.find(item => item.id === 'req_ai_spread');
    const subjectMorning = result.requirementItems.find(item => item.id === 'req_ai_subject_morning');
    const teacherLimit = result.requirementItems.find(item => item.id === 'req_ai_teacher_limit');
    assert.equal(morning.intent, 'preferred_day_part');
    assert.equal(morning.status, 'needs_review');
    assert.equal(spread.intent, 'subject_spread');
    assert.equal(spread.status, 'needs_review');
    assert.equal(subjectMorning.intent, 'preferred_day_part');
    assert.equal(subjectMorning.status, 'actionable');
    assert.equal(subjectMorning.applyTo, 'lesson_plan');
    assert.equal(teacherLimit.intent, 'teacher_daily_limit');
    assert.equal(teacherLimit.status, 'needs_review');
    assert.equal(teacherLimit.applyTo, 'rule');
    assert.equal(result.requirementItems.some(item => item.intent === 'morning_preference'), false);
    assert.equal(result.requirementItems.some(item => item.intent === 'spread'), false);
    assert.equal(result.requirementItems.some(item => item.intent === 'subject_morning'), false);
    assert.equal(result.requirementItems.some(item => item.status === 'candidate'), false);
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

test('xlsx AI supplement cannot turn system invariants into all-slot unavailable rules', async () => {
    const project = makeProject();
    const allSlots = [
        '1-1', '1-2', '1-3', '1-4',
        '2-1', '2-2', '2-3', '2-4',
        '3-1', '3-2', '3-3', '3-4',
        '4-1', '4-2', '4-3', '4-4',
        '5-1', '5-2', '5-3', '5-4',
    ];
    const file = {
        filename: 'AI排课约束建议.xlsx',
        buffer: buildConstraintWorkbook([
            ['约束内容'],
            ['同一位教师同一时间只能给一个班上课。'],
            ['同一个班级同一时间只能安排一门课程。'],
            ['每个班级每门课程必须按表中的周课时排满，不能少排或多排。'],
        ]),
    };
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        draftRows: [
                            {
                                rawText: '同一位教师同一时间只能给一个班上课。',
                                type: 'teacher_unavailable',
                                targetType: 'teacher',
                                targetName: '全部教师',
                                slots: allSlots,
                                priority: 'hard',
                                confidence: 0.86,
                                sourceRow: 2,
                            },
                            {
                                rawText: '同一个班级同一时间只能安排一门课程。',
                                type: 'class_unavailable',
                                targetType: 'class',
                                targetName: '全部班级',
                                slots: allSlots,
                                priority: 'hard',
                                confidence: 0.86,
                                sourceRow: 3,
                            },
                            {
                                rawText: '每个班级每门课程必须按表中的周课时排满，不能少排或多排。',
                                type: 'class_unavailable',
                                targetType: 'class',
                                targetName: '全部班级',
                                slots: allSlots,
                                priority: 'hard',
                                confidence: 0.82,
                                sourceRow: 4,
                            },
                        ],
                    }),
                },
            }],
        }),
    });

    const result = await parseTimetableRules({
        file,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    assert.equal(result.draftRows.some(row => row.type === 'teacher_unavailable'), false);
    assert.equal(result.draftRows.some(row => row.type === 'class_unavailable'), false);
    assert.equal(result.autoAcceptable.length, 0);
    assert.ok(result.requirementItems.some(item => item.intent === 'teacher_time_conflict' && item.status === 'handled'));
    assert.ok(result.requirementItems.some(item => item.intent === 'class_time_conflict' && item.status === 'handled'));
    assert.ok(result.requirementItems.some(item => item.intent === 'lesson_hours_completeness' && item.status === 'handled'));
});

test('parseTimetableRules links full-sentence AI requirement to a shortened machine rule', async () => {
    const fullText = 'AI测试：刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const shortText = '刘书涵老师周一第2节不要排课';
    const project = makeProject({
        teachers: [{ id: 't_liu', name: '刘书涵' }],
    });
    const fetchImpl = async (_url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const system = body.messages?.[0]?.content || '';
        const isReview = system.includes('复审核查员');
        const content = isReview
            ? {
                reviewItems: [{
                    verdict: 'accept',
                    target: { type: 'teacher_unavailable', targetId: 't_liu' },
                    reason: '需求明确，本地解析正确。',
                    evidence: { quote: shortText },
                }],
            }
            : {
                requirementItems: [{
                    id: 'req_need',
                    object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
                    intent: 'schedule_request',
                    status: 'needs_review',
                    applyTo: 'review',
                    source: { rawText: fullText },
                    confidence: 0.9,
                }],
                draftRows: [{
                    id: 'row_short_rule',
                    type: 'teacher_unavailable',
                    targetType: 'teacher',
                    targetId: 't_liu',
                    targetName: '刘书涵',
                    slots: ['1-2'],
                    rawText: shortText,
                    priority: 'hard',
                    confidence: 0.95,
                }],
            };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: JSON.stringify(content) } }],
            }),
        };
    };

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    const row = result.draftRows.find(item => item.id === 'row_short_rule');
    assert.ok(row);
    assert.equal(row.requirementId, 'req_need');
    assert.equal(row.type, 'teacher_unavailable');
    assert.equal(row.status, 'effective');
    assert.equal(row.sourceId, result.sourceRequirements[0].sourceId);
    assert.equal(row.textHash, result.sourceRequirements[0].source.textHash);
    assert.ok(result.requirementItems.some(item => item.id === 'req_need'));
});

test('parseTimetableRules never falls back when an AI machine rule has an explicit unknown sourceId', async () => {
    const fullText = 'AI测试：刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const project = makeProject({ teachers: [{ id: 't_liu', name: '刘书涵' }] });
    const fetchImpl = aiExtractionFetch({
        requirementItems: [],
        draftRows: [{
            id: 'row_explicit_unknown_source',
            sourceId: 'src:unknown',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't_liu',
            targetName: '刘书涵',
            slots: ['1-2'],
            rawText: '刘书涵老师周一第2节不要排课',
            priority: 'hard',
            confidence: 0.99,
        }],
    });

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    assert.equal(result.draftRows.some(row => row.id === 'row_explicit_unknown_source'), false);
    assert.ok(result.rejected.some(item => item.artifact?.id === 'row_explicit_unknown_source'));
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_unknown_source_id'));
});

test('parseTimetableRules never falls back when an AI machine rule has an explicit wrong textHash', async () => {
    const fullText = 'AI测试：刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const project = makeProject({ teachers: [{ id: 't_liu', name: '刘书涵' }] });
    const expectedSource = buildSourceRequirements([{
        rawText: fullText,
        lineNumber: 1,
        inputType: 'text',
        origin: 'user_input',
    }], { inputType: 'text', origin: 'user_input' })[0];
    const fetchImpl = aiExtractionFetch({
        requirementItems: [],
        draftRows: [{
            id: 'row_explicit_bad_hash',
            sourceId: expectedSource.sourceId,
            textHash: 'bad-hash',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't_liu',
            targetName: '刘书涵',
            slots: ['1-2'],
            rawText: '刘书涵老师周一第2节不要排课',
            priority: 'hard',
            confidence: 0.99,
        }],
    });

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    assert.equal(result.sourceRequirements[0].sourceId, expectedSource.sourceId);
    assert.equal(result.draftRows.some(row => row.id === 'row_explicit_bad_hash'), false);
    assert.ok(result.rejected.some(item => item.artifact?.id === 'row_explicit_bad_hash'));
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_text_hash_mismatch'));
});

test('parseTimetableRules rejects a legacy AI machine rule when multiple sources match semantically', async () => {
    const fullText = [
        'AI测试：刘书涵老师周一第2节不要排课。',
        'AI测试补充：刘书涵老师周一第2节不能安排课程。',
    ].join('\n');
    const project = makeProject({ teachers: [{ id: 't_liu', name: '刘书涵' }] });
    const fetchImpl = aiExtractionFetch({
        requirementItems: [],
        draftRows: [{
            id: 'row_ambiguous_legacy_source',
            type: 'teacher_unavailable',
            targetType: 'teacher',
            targetId: 't_liu',
            targetName: '刘书涵',
            slots: ['1-2'],
            rawText: '刘书涵老师周一第2节不要排课',
            priority: 'hard',
            confidence: 0.99,
        }],
    });

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    assert.equal(result.sourceRequirements.length, 2);
    assert.equal(result.draftRows.some(row => row.id === 'row_ambiguous_legacy_source'), false);
    assert.ok(result.rejected.some(item => item.artifact?.id === 'row_ambiguous_legacy_source'));
    assert.equal(
        result.sourceRequirements.some(source => source.machineRuleIds?.includes('row_ambiguous_legacy_source')),
        false,
        'ambiguous legacy output must never bind by array index or first-source order',
    );
});

test('parseTimetableRules preserves top-level rawText when AI requirement has a source object', async () => {
    const fullText = 'AI测试：刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const shortText = '刘书涵老师周一第2节不要排课';
    const project = makeProject({
        teachers: [{ id: 't_liu', name: '刘书涵' }],
    });
    const fetchImpl = async (_url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const system = body.messages?.[0]?.content || '';
        const isReview = system.includes('复审核查员');
        const content = isReview
            ? {
                reviewItems: [{
                    verdict: 'accept',
                    target: { type: 'teacher_unavailable', targetId: 't_liu' },
                    reason: '需求明确，本地解析正确。',
                    evidence: { quote: shortText },
                }],
            }
            : {
                requirementItems: [{
                    id: 'req_raw_top_level',
                    object: { kind: 'global', name: '全局', matchedIds: [], scope: 'derived' },
                    intent: 'schedule_request',
                    status: 'needs_review',
                    applyTo: 'rule',
                    rawText: fullText,
                    source: { channel: 'user_input' },
                    confidence: 0.9,
                }],
                draftRows: [{
                    id: 'row_short_rule_from_top_raw',
                    type: 'teacher_unavailable',
                    targetType: 'teacher',
                    targetId: 't_liu',
                    targetName: '刘书涵',
                    slots: ['1-2'],
                    rawText: shortText,
                    priority: 'hard',
                    confidence: 0.95,
                }],
            };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: JSON.stringify(content) } }],
            }),
        };
    };

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    const row = result.draftRows.find(item => item.id === 'row_short_rule_from_top_raw');
    const requirement = result.requirementItems.find(item => item.id === 'req_raw_top_level');
    assert.ok(row);
    assert.ok(requirement);
    assert.equal(row.requirementId, 'req_raw_top_level');
    assert.equal(requirement.source.rawText, fullText);
});

test('parseTimetableRules rejects named AI shells without source evidence beside real rules', async () => {
    const fullText = 'AI测试：刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const shortText = '刘书涵老师周一第2节不要排课';
    const project = makeProject({
        teachers: [{ id: 't_liu', name: '刘书涵' }],
    });
    const fetchImpl = async (_url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const system = body.messages?.[0]?.content || '';
        const isReview = system.includes('复审核查员');
        const content = isReview
            ? {
                reviewItems: [{
                    verdict: 'accept',
                    target: { type: 'teacher_unavailable', targetId: 't_liu' },
                    reason: '需求明确，本地解析正确。',
                    evidence: { quote: shortText },
                }],
            }
            : {
                requirementItems: [{
                    id: 'req_named_empty_shell',
                    object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
                    intent: 'schedule_request',
                    status: 'needs_review',
                    applyTo: 'rule',
                    source: { channel: 'user_input' },
                    parameters: {},
                    confidence: 0.7,
                }],
                draftRows: [{
                    id: 'row_named_shell_real_rule',
                    type: 'teacher_unavailable',
                    targetType: 'teacher',
                    targetId: 't_liu',
                    targetName: '刘书涵',
                    slots: ['1-2'],
                    rawText: shortText,
                    priority: 'hard',
                    confidence: 0.95,
                }],
            };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: JSON.stringify(content) } }],
            }),
        };
    };

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });
    const visibleItems = buildUnifiedRequirementItems(result);


    assert.ok(result.draftRows.some(row => row.id === 'row_named_shell_real_rule' && row.status === 'effective'));
    assert.equal(result.requirementItems.some(item => item.id === 'req_named_empty_shell'), false);
    assert.ok(result.rejected.some(item => item.artifact?.id === 'req_named_empty_shell'));
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_missing_source_identity'));
    assert.equal(visibleItems.length, 1);
    assert.equal(visibleItems[0].intent, 'teacher_unavailable');
    assert.equal(visibleItems[0].object.name, '刘书涵');
});

test('parseTimetableRules rejects placeholder-only AI shells without source evidence beside real rules', async () => {
    const fullText = 'AI测试：刘书涵老师周一第2节要参加语文备课组集体备课，这节不要给他安排课。';
    const shortText = '刘书涵老师周一第2节不要排课';
    const project = makeProject({
        teachers: [{ id: 't_liu', name: '刘书涵' }],
    });
    const fetchImpl = async (_url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const system = body.messages?.[0]?.content || '';
        const isReview = system.includes('复审核查员');
        const content = isReview
            ? {
                reviewItems: [{
                    verdict: 'accept',
                    target: { type: 'teacher_unavailable', targetId: 't_liu' },
                    reason: '需求明确，本地解析正确。',
                    evidence: { quote: shortText },
                }],
            }
            : {
                requirementItems: [{
                    id: 'req_placeholder_shell',
                    object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
                    intent: 'schedule_request',
                    status: 'needs_review',
                    applyTo: 'rule',
                    source: { channel: 'user_input', label: '我的输入' },
                    parameters: {
                        teacherName: '刘书涵',
                        type: 'teacher_unavailable',
                        time: '-',
                        destination: '排课规则',
                    },
                    reviewEvidence: {
                        reason: 'AI 已复审：这是上层排课需求理解，实际落地为教师不可排规则。',
                    },
                    confidence: 0.7,
                }],
                draftRows: [{
                    id: 'row_placeholder_shell_real_rule',
                    type: 'teacher_unavailable',
                    targetType: 'teacher',
                    targetId: 't_liu',
                    targetName: '刘书涵',
                    slots: ['1-2'],
                    rawText: shortText,
                    priority: 'hard',
                    confidence: 0.95,
                }],
            };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: JSON.stringify(content) } }],
            }),
        };
    };

    const result = await parseTimetableRules({
        text: fullText,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });
    const visibleItems = buildUnifiedRequirementItems(result);


    assert.ok(result.draftRows.some(row => row.id === 'row_placeholder_shell_real_rule' && row.status === 'effective'));
    assert.equal(result.requirementItems.some(item => item.id === 'req_placeholder_shell'), false);
    assert.ok(result.rejected.some(item => item.artifact?.id === 'req_placeholder_shell'));
    assert.ok(result.warningItems.some(item => item.code === 'ai_source_missing_source_identity'));
    assert.equal(visibleItems.length, 1);
    assert.equal(visibleItems[0].intent, 'teacher_unavailable');
    assert.equal(visibleItems[0].object.name, '刘书涵');
});

test('normalizeTimetableRuleDraftRows links only the matching same-teacher period', () => {
    const project = makeProject({
        teachers: [{ id: 't_liu', name: '刘书涵' }],
    });
    const result = normalizeTimetableRuleDraftRows({
        project,
        source: 'ai',
        inputType: 'text',
        draftRows: [
            {
                id: 'row_monday_second',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_liu',
                targetName: '刘书涵',
                slots: ['1-2'],
                rawText: '刘书涵老师周一第2节不要排课',
                priority: 'hard',
            },
            {
                id: 'row_tuesday_third',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_liu',
                targetName: '刘书涵',
                slots: ['2-3'],
                rawText: '刘书涵老师周二第3节不要排课',
                priority: 'hard',
            },
        ],
        semanticRequirements: [
            {
                id: 'req_monday_second',
                object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
                intent: 'schedule_request',
                status: 'needs_review',
                applyTo: 'review',
                source: { rawText: '刘书涵老师周一第2节不要排课' },
            },
            {
                id: 'req_tuesday_third',
                object: { kind: 'teacher', name: '刘书涵', matchedIds: ['t_liu'], scope: 'explicit' },
                intent: 'schedule_request',
                status: 'needs_review',
                applyTo: 'review',
                source: { rawText: '刘书涵老师周二第3节不要排课' },
            },
        ],
    });

    assert.equal(result.draftRows.find(row => row.id === 'row_monday_second').requirementId, 'req_monday_second');
    assert.equal(result.draftRows.find(row => row.id === 'row_tuesday_third').requirementId, 'req_tuesday_third');
});

test('normalizeTimetableRuleDraftRows can link one demand to multiple same-slot machine rules', () => {
    const project = makeProject({
        teachers: [
            { id: 't_liu', name: '刘书涵' },
            { id: 't_zhang', name: '张老师' },
        ],
    });
    const result = normalizeTimetableRuleDraftRows({
        project,
        source: 'ai',
        inputType: 'text',
        draftRows: [
            {
                id: 'row_liu',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_liu',
                targetName: '刘书涵',
                slots: ['1-2'],
                rawText: '刘书涵和张老师周一第2节都不要排课',
                priority: 'hard',
            },
            {
                id: 'row_zhang',
                type: 'teacher_unavailable',
                targetType: 'teacher',
                targetId: 't_zhang',
                targetName: '张老师',
                slots: ['1-2'],
                rawText: '刘书涵和张老师周一第2节都不要排课',
                priority: 'hard',
            },
        ],
        semanticRequirements: [{
            id: 'req_group',
            object: { kind: 'teacher_group', name: '刘书涵、张老师', matchedIds: ['t_liu', 't_zhang'], scope: 'explicit' },
            intent: 'schedule_request',
            status: 'needs_review',
            applyTo: 'review',
            source: { rawText: '刘书涵和张老师周一第2节都不要排课' },
        }],
    });

    assert.equal(result.draftRows.find(row => row.id === 'row_liu').requirementId, 'req_group');
    assert.equal(result.draftRows.find(row => row.id === 'row_zhang').requirementId, 'req_group');
});

test('normalizeTimetableRuleDraftRows never widens a named teacher gap preference to all teachers', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        source: 'local',
        inputType: 'text',
        originalText: '张老师同一天如果有多节课，尽量排得紧凑，别出现长空堂。',
        draftRows: [{
            id: 'row_teacher_gap',
            type: 'teacher_gap_preference',
            targetType: 'teacher',
            targetId: 't1',
            targetName: '张老师',
            rawText: '张老师同一天如果有多节课，尽量排得紧凑，别出现长空堂。',
            priority: 'soft',
            status: 'ready',
        }],
    });

    const row = result.draftRows.find(item => item.id === 'row_teacher_gap' || item.type === 'advanced_constraint');
    assert.ok(row);
    assert.equal(row.targetType, 'teacher');
    assert.equal(row.targetId, 't1');
    assert.equal(row.targetName, '张老师');
    assert.equal(row.status, 'effective');
    assert.equal(row.executionStatus, 'executable');
    assert.equal(result.draftRules.softRules.teacherGapWeight, 0);

    const ir = result.constraintIRs.find(item => item.capabilityId === 'teacher.compact_day');
    assert.ok(ir);
    assert.equal(ir.target.kind, 'teacher');
    assert.deepEqual(ir.target.matchedIds, ['t1']);
    assert.equal(ir.executionStatus, 'executable');
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
        text: '全校单周语文第1节优先',
        project,
        env: {},
    });
    const row = result.draftRows.find(r => r.targetId === 's1' || r.targetName === '语文');
    assert.ok(row);
    assert.equal(row.weekPattern, 'odd');
    assert.equal(row.status, 'needs_review');
    assert.match(row.warnings.join(' '), /单双周|不会自动生效/);
    assert.equal(result.draftRules.softRules.subjectPreferredPeriods?.s1, undefined);
    const requirement = result.requirementItems.find(item => item.rowId === row.id);
    assert.ok(requirement);
    assert.equal(requirement.modelSupport?.supported, false);
    assert.equal(requirement.modelSupport?.capability, 'weekPattern');
    assert.equal(requirement.modelSupport?.requiredModel, 'complex_v1');
});

test('complex model parses week-pattern constraints into ready semantic actions', async () => {
    const project = makeProject({
        timetableModelVersion: 'complex_v1',
        lessonPlans: [
            { id: 'lp_chinese', classId: 'c1', subjectId: 's1', teacherId: 't1', weeklyHours: 4 },
        ],
    });
    const result = await parseTimetableRules({
        text: '全校单周语文第1节优先',
        project,
        env: {},
    });

    const row = result.draftRows.find(r => r.targetId === 's1' || r.targetName === '语文');
    assert.ok(row);
    assert.equal(row.weekPattern, 'odd');
    assert.equal(row.status, 'effective');
    const requirement = result.requirementItems.find(item => item.rowId === row.id);
    assert.ok(requirement);
    assert.equal(requirement.status, 'actionable');
    assert.equal(requirement.applyTo, 'model_extension');
    assert.equal(requirement.modelSupport?.supported, true);
    const action = result.semanticActions.find(item => item.requirementId === requirement.id);
    assert.ok(action);
    assert.equal(action.kind, 'complex_model_patch');
    assert.equal(action.status, 'ready');
    assert.deepEqual(action.target.subjectIds, ['s1']);
    assert.equal(action.patch.weekPattern, 'odd');
    assert.deepEqual(action.patch.preferredSlots, ['1-1', '2-1', '3-1', '4-1', '5-1']);
});

test('parseTimetableRules models cross-campus commute demand as unsupported complex requirement', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '张老师跨校区不要连续两节',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'campus_commute_gap');
    assert.ok(requirement);
    assert.equal(requirement.object.kind, 'teacher');
    assert.equal(requirement.object.name, '张老师');
    assert.deepEqual(requirement.object.matchedIds, ['t1']);
    assert.equal(requirement.status, 'needs_review');
    assert.equal(requirement.applyTo, 'model_extension');
    assert.equal(requirement.parameters.maxConsecutiveAcrossCampus, 1);
    assert.equal(requirement.modelSupport?.supported, false);
    assert.equal(requirement.modelSupport?.capability, 'campus_commute');
    assert.equal(requirement.modelSupport?.requiredModel, 'complex_v1');
    assert.equal(result.semanticActions.some(action => action.requirementId === requirement.id && action.status === 'ready'), false);
    assert.equal(result.nextAction, 'ask_user');
});

test('complex model parses cross-campus commute demand into ready model action', async () => {
    const project = makeProject({ timetableModelVersion: 'complex_v1' });
    const result = await parseTimetableRules({
        text: '张老师跨校区不要连续两节',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'campus_commute_gap');
    assert.ok(requirement);
    assert.equal(requirement.status, 'actionable');
    assert.equal(requirement.applyTo, 'model_extension');
    assert.equal(requirement.modelSupport?.supported, true);
    const action = result.semanticActions.find(item => item.requirementId === requirement.id);
    assert.ok(action);
    assert.equal(action.kind, 'complex_model_patch');
    assert.equal(action.status, 'ready');
    assert.equal(action.patch.commuteRules.defaultGapPeriods, 1);
    assert.equal(action.patch.commuteRules.teacherGapPeriods.t1, 1);
});

test('parseTimetableRules models combined-class demand as unsupported teaching group requirement', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '一(1)班和二(1)班合班上体育',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'teaching_group_session');
    assert.ok(requirement);
    assert.equal(requirement.object.kind, 'teaching_group');
    assert.deepEqual(requirement.parameters.classIds.sort(), ['c1', 'c2']);
    assert.deepEqual(requirement.parameters.subjectIds, ['s4']);
    assert.equal(requirement.status, 'needs_review');
    assert.equal(requirement.applyTo, 'model_extension');
    assert.equal(requirement.modelSupport?.supported, false);
    assert.equal(requirement.modelSupport?.capability, 'teachingGroup');
    assert.equal(requirement.modelSupport?.requiredModel, 'complex_v1');
    assert.equal(result.semanticActions.some(action => action.requirementId === requirement.id && action.status === 'ready'), false);
});

test('complex model parses combined-class demand into ready teaching group action', async () => {
    const project = makeProject({ timetableModelVersion: 'complex_v1' });
    const result = await parseTimetableRules({
        text: '一(1)班和二(1)班合班上体育',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'teaching_group_session');
    assert.ok(requirement);
    assert.equal(requirement.status, 'actionable');
    assert.equal(requirement.applyTo, 'model_extension');
    assert.equal(requirement.modelSupport?.supported, true);
    const action = result.semanticActions.find(item => item.requirementId === requirement.id);
    assert.ok(action);
    assert.equal(action.kind, 'complex_model_patch');
    assert.equal(action.status, 'ready');
    assert.deepEqual(action.patch.teachingGroup.classIds.sort(), ['c1', 'c2']);
    assert.deepEqual(action.patch.teachingGroup.subjectIds, ['s4']);
    assert.equal(action.patch.teachingGroup.mode, 'combined_class');
});

test('room or venue preference waits for binding when the named room is absent', async () => {
    const project = makeProject();
    const result = await parseTimetableRules({
        text: '体育课尽量安排在操场',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'room_requirement');
    assert.ok(requirement);
    assert.equal(requirement.object.kind, 'subject');
    assert.equal(requirement.object.name, '体育');
    assert.deepEqual(requirement.object.matchedIds, ['s4']);
    assert.equal(requirement.parameters.roomName, '操场');
    assert.equal(requirement.status, 'needs_review');
    assert.equal(requirement.applyTo, 'rule');
    assert.equal(requirement.executionStatus, 'blocked_by_reference');
    assert.equal(result.sourceRequirements[0].applicationTarget, 'review');
    assert.equal(result.sourceRequirements[0].requiresHumanReview, true);
    assert.equal(result.semanticActions.some(action => action.requirementId === requirement.id && action.status === 'ready'), false);
});

test('room or venue preference compiles after the named room is available', async () => {
    const project = makeProject({
        timetableModelVersion: 'complex_v1',
        rooms: [{ id: 'playground', name: '操场', tags: ['sport'] }],
        lessonPlans: [
            { id: 'lp_pe', classId: 'c1', subjectId: 's4', teacherId: 't1', weeklyHours: 2 },
        ],
    });
    const result = await parseTimetableRules({
        text: '体育课尽量安排在操场',
        project,
        env: {},
    });

    const requirement = result.requirementItems.find(item => item.intent === 'room_requirement');
    assert.ok(requirement);
    assert.equal(requirement.status, 'actionable');
    assert.equal(requirement.applyTo, 'rule');
    assert.equal(requirement.executionStatus, 'executable');
    assert.deepEqual(requirement.parameters.roomIds, ['playground']);
    assert.equal(result.sourceRequirements[0].applicationTarget, 'rule');
    assert.equal(result.sourceRequirements[0].requiresHumanReview, false);
    assert.ok(result.draftRows.some(row => (
        row.type === 'room_requirement'
        && row.targetId === 's4'
        && row.roomIds.includes('playground')
    )));
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

test('xlsx constraints parse locally with stable ids and calls AI review for decisive rows', async () => {
    const project = makeProject();
    let aiCalls = 0;
    const file = {
        filename: 'constraints.xlsx',
        buffer: buildConstraintWorkbook([
            ['约束内容'],
            ['全校数学尽量安排在上午第1-2节'],
            ['张老师周一前两节不排'],
        ]),
    };
    const fetchImpl = async (url, init = {}) => {
        aiCalls += 1;
        const body = JSON.parse(init.body || '{}');
        assert.match(body.messages?.[0]?.content || '', /复审|审计/);
        assert.equal(body.temperature, 0);
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            reviewItems: [
                                {
                                    verdict: 'accept',
                                    target: { sourceRow: 2 },
                                    reason: '本地识别与原文一致。',
                                    evidence: { sourceRow: 2, quote: '全校数学尽量安排在上午第1-2节' },
                                },
                                {
                                    verdict: 'accept',
                                    target: { sourceRow: 3 },
                                    reason: '本地识别与原文一致。',
                                    evidence: { sourceRow: 3, quote: '张老师周一前两节不排' },
                                },
                            ],
                        }),
                    },
                }],
            }),
        };
    };

    const first = await parseTimetableRules({
        file,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });
    const second = await parseTimetableRules({
        file,
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    assert.equal(aiCalls, 1);
    assert.equal(first.inputType, 'xlsx_constraints');
    assert.equal(first.source, 'local_xlsx');
    assert.equal(first.parseSource, 'local_xlsx');
    assert.equal(first.aiReview?.status, 'reviewed');
    assert.equal(first.aiReview?.reviewItems.length, 2);
    assert.equal(first.sourceRequirements.length, 2);
    assert.equal(first.statistics.userInputCount, 2);
    assert.ok(first.parserVersion);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.deepEqual(
        first.draftRows.map(row => ({
            id: row.id,
            stableKey: row.stableKey,
            parseSource: row.parseSource,
            aiReviewStatus: row.aiReviewStatus,
            reviewedParseSource: row.reviewedParseSource,
            type: row.type,
            targetId: row.targetId,
            sourceRow: row.sourceRow,
        })),
        second.draftRows.map(row => ({
            id: row.id,
            stableKey: row.stableKey,
            parseSource: row.parseSource,
            aiReviewStatus: row.aiReviewStatus,
            reviewedParseSource: row.reviewedParseSource,
            type: row.type,
            targetId: row.targetId,
            sourceRow: row.sourceRow,
        })),
    );
    assert.ok(first.draftRows.every(row => row.parseSource === 'local_xlsx'));
    assert.ok(first.draftRows.every(row => row.aiReviewStatus === ''));
    assert.ok(first.draftRows.every(row => row.reviewedParseSource === ''));
    assert.ok(first.aiReview.reviewItems.every(item => item.validationStatus === 'accepted'));
    assert.ok(first.draftRows.every(row => row.stableKey));
    assert.deepEqual(first.draftRows.map(row => row.sourceRow), [...first.draftRows.map(row => row.sourceRow)].sort((a, b) => a - b));
    assert.deepEqual(first.draftRules.softRules.subjectPreferredPeriods.s2.prefer, [
        '1-1', '1-2', '2-1', '2-2', '3-1', '3-2', '4-1', '4-2', '5-1', '5-2',
    ]);
    assert.deepEqual(first.draftRules.hardRules.teacherUnavailable.t1, ['1-1', '1-2']);
});

test('AI review flag stays advisory when local validation cannot reproduce a blocker', async () => {
    const project = makeProject();
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        reviewItems: [{
                            verdict: 'flag',
                            target: { targetId: 's2' },
                            reason: 'AI 复审认为“上午”范围较宽，需要人工确认是否只限前两节。',
                            evidence: { quote: '全校数学尽量安排到上午' },
                        }],
                    }),
                },
            }],
        }),
    });

    const result = await parseTimetableRules({
        text: '全校数学尽量安排到上午',
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    const row = result.draftRows.find(item => item.targetId === 's2');
    assert.ok(row);
    assert.notEqual(row.status, 'needs_review');
    assert.equal(row.aiReviewStatus, '');
    assert.equal(row.aiReviewValidationStatus, '');
    assert.equal(row.aiReviewBlocking, false);
    assert.deepEqual(row.aiReviewWarnings, []);
    assert.equal(result.aiReview.status, 'reviewed');
    assert.equal(result.aiReview.reviewItems[0].validationStatus, 'advisory');
    assert.match(result.aiReview.reviewItems[0].reason, /人工确认/);
    assert.equal(result.aiReview.flaggedCount, 1);
    assert.equal(result.aiReview.advisoryCount, 1);
    assert.equal(result.aiReview.blockingCount, 0);
    assert.equal(result.needReview.some(item => item.id === row.id), false);
    assert.equal(result.sourceRequirements[0].requiresHumanReview, false);
    assert.equal(result.sourceRequirements[0].applicationTarget, 'rule');
    assert.deepEqual(result.sourceRequirements[0].reviewReasons, []);
    assert.deepEqual(result.aiAssistance, {
        mode: 'targeted_review',
        acceptedCount: 0,
        correctedCount: 0,
        advisoryCount: 1,
        blockingCount: 0,
    });
});

test('AI review invalid suggested patch is not applied to local result', async () => {
    const project = makeProject();
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        reviewItems: [{
                            verdict: 'suggest_patch',
                            target: { targetId: 's2' },
                            reason: 'AI 误把对象改成不存在的课程。',
                            evidence: { quote: '全校数学尽量安排到上午' },
                            patch: {
                                type: 'subject_morning',
                                targetType: 'subject',
                                targetName: '火星课',
                                targetId: '',
                            },
                        }],
                    }),
                },
            }],
        }),
    });

    const result = await parseTimetableRules({
        text: '全校数学尽量安排到上午',
        project,
        env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_BASE: 'http://ai.test' },
        fetchImpl,
    });

    assert.ok(result.draftRows.some(row => row.type === 'subject_morning' && row.targetId === 's2'));
    assert.equal(result.draftRows.some(row => row.targetName === '火星课'), false);
    assert.equal(result.aiReview.appliedSuggestionCount, 0);
    assert.ok(result.warnings.some(warning => /AI 复审建议未通过本地校验/.test(warning)));
});

test('AI review timeout returns the local parse result with an unavailable warning', async () => {
    const project = makeProject();
    let receivedAbortSignal = false;
    const fetchImpl = async (_url, init = {}) => {
        receivedAbortSignal = Boolean(init.signal);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                resolve({
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        choices: [{
                            message: {
                                content: JSON.stringify({
                                    reviewItems: [{
                                        verdict: 'accept',
                                        target: { targetId: 's2' },
                                        reason: '迟到的复审结果不应覆盖超时降级。',
                                        evidence: { quote: '全校数学尽量安排到上午' },
                                    }],
                                }),
                            },
                        }],
                    }),
                });
            }, 50);
            init.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        });
    };

    const result = await parseTimetableRules({
        text: '全校数学尽量安排到上午',
        project,
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
            TIMETABLE_RULE_AI_REVIEW_TIMEOUT_MS: '5',
        },
        fetchImpl,
    });

    assert.equal(receivedAbortSignal, true);
    assert.equal(result.aiReview.status, 'unavailable');
    assert.equal(result.aiReview.reason, 'ai_review_timeout');
    assert.ok(result.warnings.some(warning => /AI 复审未完成|超时/.test(warning)));
    assert.ok(result.draftRows.some(row => row.type === 'subject_morning' && row.targetId === 's2'));
    assert.equal(result.sourceRequirements.length, 1);
});

test('AI review invalid JSON safely preserves every local source requirement', async () => {
    const requestText = [
        '全校数学尽量安排到上午。',
        '张老师周一第1节不排。',
    ].join('\n');
    const result = await parseTimetableRules({
        text: requestText,
        project: makeProject(),
        env: {
            DEEPSEEK_API_KEY: 'test-key',
            DEEPSEEK_API_BASE: 'http://ai.test',
        },
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: '{not valid review json' } }],
            }),
        }),
    });

    assert.equal(result.aiReview.status, 'unavailable');
    assert.equal(result.aiReview.reason, 'ai_review_invalid_json');
    assert.equal(result.sourceRequirements.length, 2);
    assert.equal(result.statistics.userInputCount, 2);
    assert.equal(new Set(result.sourceRequirements.map(item => item.sourceId)).size, 2);
    assert.ok(result.draftRows.some(row => row.type === 'subject_morning'));
    assert.ok(result.draftRows.some(row => row.type === 'teacher_unavailable'));
});

test('normalize splits a grouped subject target into independent effective rules', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        source: 'ai',
        draftRows: [{
            id: 'grouped-subjects',
            rawText: '全校语文、数学、英语尽量安排到上午',
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
        text: '张老师周一第1节不排；李老师每天最多3节；全校语文尽量安排到上午',
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

test('normalize handles teacher load balance as an effective v2 soft rule', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{ type: 'teacher_load_balance', targetId: 't1', confidence: 0.9 }],
        source: 'test',
    });
    assert.equal(result.draftRows[0].status, 'effective');
    assert.deepEqual(result.draftRules.softRules.teacherLoadBalance, { enabled: true, weight: 1, explicit: true });
});

test('normalize handles completely unknown type as unsupported', () => {
    const project = makeProject();
    const result = normalizeTimetableRuleDraftRows({
        project,
        draftRows: [{ type: 'teleportation_constraint', targetId: 't1', confidence: 0.9 }],
        source: 'test',
    });
    assert.equal(result.draftRows[0].status, 'unsupported');
    assert.equal(result.unsupportedItems[0].status, 'unsupported');
    assert.equal(result.constraintIRs[0].executionStatus, 'unsupported_by_solver');
    assert.deepEqual(result.constraintIRs[0].machineRuleIds, []);
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
    assert.equal(result.ruleReport.summary.kept, 2);
    assert.equal(result.ruleReport.summary.review >= 1, true);
    assert.equal(result.ruleReport.summary.degraded, 0);
    assert.equal(result.ruleReport.summary.dropped, 1);
    assert.equal(result.ruleReport.hasIssues, true);
    assert.ok(result.ruleReport.entries.some(item => item.category === 'kept' && item.source.rowId === 'rule_kept'));
    assert.ok(result.ruleReport.entries.some(item => item.category === 'review' && /需要复核|人工确认/.test(item.reason)));
    assert.ok(result.ruleReport.entries.some(item => item.category === 'kept' && item.source.rowId === 'rule_degraded'));
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

test('parseRosterAiOrLocal preserves structured lesson metadata without sending the table to AI', async () => {
    let fetchCalls = 0;
    const text = [
        '年级,班级,课程,教师,周课时,连堂,课型,教学资源',
        '七年级,1班,物理,程老师,4,单节,复习课、校本研修课,机房、Maker Space',
    ].join('\n');
    const result = await parseRosterAiOrLocal({
        text,
        project: {},
        env: { DEEPSEEK_API_KEY: 'configured-for-test' },
        fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error('structured table must not call AI');
        },
    });

    assert.equal(fetchCalls, 0);
    assert.equal(result.source, 'local');
    assert.deepEqual(result.draftRows[0].activityTypes, ['复习', '校本研修课']);
    assert.deepEqual(result.draftRows[0].requiredResourceTypes, ['计算机教室', 'Maker Space']);
    assert.equal(result.draftRows[0].roomName, '');
});

test('parseRosterAiOrLocal local fallback parses common natural language roster rows', async () => {
    const result = await parseRosterAiOrLocal({
        text: '七年级1班语文林老师每周5节，混合',
        project: {},
        env: {},
    });

    assert.equal(result.source, 'local');
    assert.equal(result.draftRows.length, 1);
    assert.deepEqual({
        grade: result.draftRows[0].grade,
        className: result.draftRows[0].className,
        subjectName: result.draftRows[0].subjectName,
        teacherName: result.draftRows[0].teacherName,
        weeklyHours: result.draftRows[0].weeklyHours,
        blockPreference: result.draftRows[0].blockPreference,
    }, {
        grade: '七年级',
        className: '1班',
        subjectName: '语文',
        teacherName: '林老师',
        weeklyHours: 5,
        blockPreference: 'mixed',
    });
    assert.equal(result.issues.length, 0);
});

test('parseRosterAiOrLocal local fallback parses natural language block and room details', async () => {
    const result = await parseRosterAiOrLocal({
        text: '八年级2班物理程远航老师每周3节，双连堂，物理实验室',
        project: {},
        env: {},
    });

    assert.equal(result.source, 'local');
    assert.equal(result.draftRows.length, 1);
    const row = result.draftRows[0];
    assert.equal(row.grade, '八年级');
    assert.equal(row.className, '2班');
    assert.equal(row.subjectName, '物理');
    assert.equal(row.teacherName, '程远航');
    assert.equal(row.weeklyHours, 3);
    assert.equal(row.blockPreference, 'double');
    assert.equal(row.roomName, '物理实验室');
    assert.ok(result.warnings.some(message => /双连堂课时建议使用偶数/.test(message)));
});

test('parseRosterAiOrLocal local fallback parses multiple natural roster rows and Chinese numeral hours', async () => {
    const result = await parseRosterAiOrLocal({
        text: [
            '九年级1班化学丁子航每周4节，双连堂，在化学实验室',
            '初一3班体育由王强老师上，一周两节，单节',
        ].join('\n'),
        project: {},
        env: {},
    });

    assert.equal(result.source, 'local');
    assert.equal(result.draftRows.length, 2);
    assert.deepEqual(result.draftRows.map(row => ({
        grade: row.grade,
        className: row.className,
        subjectName: row.subjectName,
        teacherName: row.teacherName,
        weeklyHours: row.weeklyHours,
        blockPreference: row.blockPreference,
        roomName: row.roomName,
    })), [{
        grade: '九年级',
        className: '1班',
        subjectName: '化学',
        teacherName: '丁子航',
        weeklyHours: 4,
        blockPreference: 'double',
        roomName: '化学实验室',
    }, {
        grade: '初一',
        className: '3班',
        subjectName: '体育',
        teacherName: '王强',
        weeklyHours: 2,
        blockPreference: 'single',
        roomName: '',
    }]);
});

test('parseRosterAiOrLocal local fallback does not create shifted fake rows for unrecognized prose', async () => {
    const result = await parseRosterAiOrLocal({
        text: '这份任课数据等教务处确认后再补充，暂时没有具体老师和课时。',
        project: {},
        env: {},
    });

    assert.equal(result.source, 'local');
    assert.equal(result.draftRows.length, 0);
    assert.ok(result.warnings.some(message => /本地未能识别自然语言/.test(message)));
    assert.ok(result.importReport.hasIssues);
    assert.ok(result.importReport.entries.some(item => item.category === 'review' && /本地未能识别自然语言/.test(item.reason)));
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

test('local parser conservatively carries an explicit teacher across a comma continuation with “也”', async () => {
    const result = await parseTimetableRules({
        text: '张老师周一第1节不排，周三第2节也不排',
        project: makeProject(),
        env: {},
    });
    const teacherRows = result.draftRows.filter(row => row.type === 'teacher_unavailable' && row.targetName === '张老师');
    const slots = [...new Set(teacherRows.flatMap(row => row.slots || []))].sort();

    assert.deepEqual(slots, ['1-1', '3-2']);
    assert.equal(result.draftRows.some(row => row.type === 'subject_avoid_periods'), false);
    assert.ok(result.constraintIRs.every(item => item.target.name !== '周三第2节也'));
});

test('parser-only shadow normalization supports market aliases and typos without changing source identity', async () => {
    const rawText = '張老師週一笫二堂沒空';
    const [expectedSource] = buildSourceRequirements([{
        lineNumber: 1,
        rawText,
    }], { inputType: 'text', origin: 'user_input' });

    const result = await parseTimetableRules({
        text: rawText,
        project: makeProject(),
        env: {},
    });
    const source = result.sourceRequirements[0];
    const teacherRows = result.draftRows.filter(row => row.type === 'teacher_unavailable' && row.targetName === '张老师');
    const expectedRules = new Set([
        'traditional_week',
        'ordinal_typo',
        'traditional_negation',
        'traditional_teacher',
        'traditional_surname',
        'lesson_counter_alias',
    ]);

    assert.deepEqual([...new Set(teacherRows.flatMap(row => row.slots || []))], ['1-2']);
    assert.equal(source.source.rawText, rawText);
    assert.equal(source.sourceId, expectedSource.sourceId);
    assert.equal(source.source.textHash, expectedSource.source.textHash);
    assert.deepEqual(new Set(result.constraintIRs[0].normalizationTrace.map(item => item.rule)), expectedRules);
    assert.deepEqual(result.draftRows[0].normalizationTrace, result.constraintIRs[0].normalizationTrace);
    assert.deepEqual(source.clauses[0].normalizationTrace, result.constraintIRs[0].normalizationTrace);
    assert.equal(result.draftRows[0].rawText, rawText);
    assert.equal(result.constraintIRs[0].textHash, expectedSource.source.textHash);
});

test('shadow normalization covers registered market variants and keeps auditable traces', () => {
    const cases = [
        ['數學和英語', '数学和英语', ['traditional_math', 'traditional_english']],
        ['体肓课', '体育课', ['bounded_pe_typo']],
        ['物里实验', '物理实验', ['bounded_physics_typo']],
        ['周叁第—节', '周三第一节', ['homophone_weekday', 'dash_ordinal_one']],
        ['壹周', '一周', ['financial_numeral_week']],
        ['物化生', '物理、化学、生物', ['school_science_group_alias']],
        ['音体美信', '音乐、体育、美术、信息技术', ['school_subject_group_alias']],
        ['大连堂', '连排两节', ['school_block_alias']],
        ['集备', '集体备课', ['school_collective_planning_alias']],
    ];

    for (const [input, expectedText, expectedRules] of cases) {
        const normalized = parserShadowTextWithTrace(input);
        assert.equal(normalized.text, expectedText, input);
        assert.deepEqual(normalized.trace.map(item => item.rule), expectedRules, input);
        assert.ok(normalized.trace.every(item => item.from !== item.to), input);
    }
});

test('shadow normalization does not rewrite similar ordinary entities or already-canonical words', () => {
    for (const input of [
        '体肓馆周一开放',
        '物里老师周二值班',
        '张老师带七年级1班数学',
        '体育馆周一开放',
        '物理老师周二值班',
    ]) {
        const normalized = parserShadowTextWithTrace(input);
        assert.equal(normalized.text, input);
        assert.deepEqual(normalized.trace, []);
    }
});


test('local parser understands head-period aliases written with 堂课', async () => {
    const result = await parseTimetableRules({
        text: '李老师周一头两堂课别排',
        project: makeProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'teacher_unavailable' && item.targetName === '李老师');

    assert.ok(row);
    assert.deepEqual(row.slots, ['1-1', '1-2']);
});

test('local parser resolves tail-period aliases without leaking the count as an absolute period', async () => {
    for (const [text, expectedSlots] of [
        ['李老师周二后两节不能排', ['2-3', '2-4']],
        ['张老师周二最后两节没空', ['2-3', '2-4']],
    ]) {
        const result = await parseTimetableRules({ text, project: makeProject(), env: {} });
        const row = result.draftRows.find(item => item.type === 'teacher_unavailable');
        assert.ok(row, text);
        assert.deepEqual(row.slots, expectedSlots, text);
    }
});

test('local parser understands last and reverse-index period expressions', async () => {
    for (const [text, expectedSlots] of [
        ['王老师周五末节不方便', ['5-4']],
        ['张老师周四尾节无法上课', ['4-4']],
        ['李老师周三倒数第2节请假', ['3-3']],
    ]) {
        const result = await parseTimetableRules({ text, project: makeProject(), env: {} });
        const row = result.draftRows.find(item => item.type === 'teacher_unavailable');
        assert.ok(row, text);
        assert.deepEqual(row.slots, expectedSlots, text);
    }
});

test('local parser recognizes common teacher-unavailable phrases when time is explicit', async () => {
    for (const [text, expectedTarget, expectedSlots] of [
        ['张老师周一第1节不方便', '张老师', ['1-1']],
        ['李老师周二第2节无法上课', '李老师', ['2-2']],
        ['王老师周三第3节没法上课', '王老师', ['3-3']],
        ['张老师周四第4节请假', '张老师', ['4-4']],
        ['李老师周五第1节不在校', '李老师', ['5-1']],
    ]) {
        const result = await parseTimetableRules({ text, project: makeProject(), env: {} });
        const row = result.draftRows.find(item => item.type === 'teacher_unavailable' && item.targetName === expectedTarget);
        assert.ok(row, text);
        assert.deepEqual(row.slots, expectedSlots, text);
    }
});

test('an explicit new teacher target interrupts comma-clause context inheritance', async () => {
    const result = await parseTimetableRules({
        text: '张老师周一第1节不排，李老师周三第2节不排',
        project: makeProject(),
        env: {},
    });
    const teacherSlots = Object.fromEntries(result.draftRows
        .filter(item => item.type === 'teacher_unavailable')
        .map(item => [item.targetName, item.slots]));

    assert.deepEqual(teacherSlots, {
        张老师: ['1-1'],
        李老师: ['3-2'],
    });
});


test('grade-only weekly course preferences preserve their details but require a class scope', async () => {
    const result = await parseTimetableRules({
        text: '九年级语文、数学、英语每周尽量有3次以上排在第1到第3节，不要集中到下午。',
        project: makeProject({ periodsPerDay: 8 }),
        env: {},
    });
    const preferred = result.constraintIRs.filter(item => item.capabilityId === 'subject.preferred_periods');

    assert.equal(preferred.length, 3);
    assert.deepEqual(preferred.map(item => item.target.name).sort(), ['数学', '英语', '语文']);
    preferred.forEach((ir) => {
        assert.deepEqual(ir.parameters.gradeNames, ['九年级']);
        assert.equal(ir.parameters.minOccurrences, 3);
        assert.deepEqual(ir.parameters.periods, [1, 2, 3]);
        assert.deepEqual(ir.parameters.avoidDayParts, ['afternoon']);
        assert.equal(ir.executionStatus, 'blocked_by_clarification');
        assert.match(ir.clarifications.join(' '), /补充班级.*全校/);
        assert.equal(ir.machineRuleIds.length, 0);
    });
});

test('grade-only final-period preferences preserve their details but require a class scope', async () => {
    const result = await parseTimetableRules({
        text: '七年级最后一节尽量不排数学和英语，避免新生下午后段学习压力过大。',
        project: makeProject({ periodsPerDay: 8 }),
        env: {},
    });
    const avoided = result.constraintIRs.filter(item => item.capabilityId === 'subject.avoid_periods');

    assert.equal(avoided.length, 2);
    assert.deepEqual(avoided.map(item => item.target.name).sort(), ['数学', '英语']);
    avoided.forEach((ir) => {
        assert.deepEqual(ir.parameters.gradeNames, ['七年级']);
        assert.deepEqual(ir.parameters.periods, [8]);
        assert.equal(ir.parameters.periods.includes(7), false);
        assert.equal(ir.executionStatus, 'blocked_by_clarification');
        assert.match(ir.clarifications.join(' '), /补充班级.*全校/);
        assert.equal(ir.machineRuleIds.length, 0);
    });
});


test('cross-sentence meeting continuation inherits teacher and prior explicit time', async () => {
    const result = await parseTimetableRules({
        text: '王老师这学期带语文。她周三第3节要开会，不能排课。',
        project: makeProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'teacher_unavailable' && item.targetName === '王老师');
    assert.ok(row);
    assert.deepEqual(row.days, [3]);
    assert.deepEqual(row.periods, [3]);
    assert.deepEqual(row.slots, ['3-3']);
});

test('precise class activity preserves class context for a later referenced period', async () => {
    const project = makeProject({
        classes: [
            { id: 'c7_1', grade: '七年级', name: '1班' },
            { id: 'c7_2', grade: '七年级', name: '2班' },
            { id: 'c9_1', grade: '九年级', name: '1班' },
        ],
    });
    const result = await parseTimetableRules({
        text: '七年级1班周五有班会。这个班第3节不要排普通课。',
        project,
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'class_unavailable' && item.targetName === '七年级1班');
    assert.ok(row);
    assert.deepEqual(row.slots, ['5-3']);
});

test('teacher daily-limit continuation applies the changed upper bound to the new explicit teacher', async () => {
    const result = await parseTimetableRules({
        text: '张老师每天最多4节。这个上限李老师改成3节。',
        project: makeProject(),
        env: {},
    });
    const limits = Object.fromEntries(result.draftRows
        .filter(item => item.type === 'teacher_daily_limit')
        .map(item => [item.targetName, item.limit]));
    assert.deepEqual(limits, { 张老师: 4, 李老师: 3 });
});

test('course interval accepts colloquial 至少隔一天 and keeps each subject', async () => {
    const result = await parseTimetableRules({
        text: '数学和英语至少隔一天。它们还要尽量分散。',
        project: makeProject(),
        env: {},
    });
    const intervals = result.draftRows.filter(item => item.type === 'course_interval');
    assert.deepEqual(intervals.map(item => item.targetName).sort(), ['数学', '英语']);
    assert.ok(intervals.every(item => item.minGapDays === 1));
});

test('shared-grade class shorthand keeps textual order for 前者 and 后者', async () => {
    const project = makeProject({
        classes: [
            { id: 'c3_1', grade: '三年级', name: '1班' },
            { id: 'c7_1', grade: '七年级', name: '1班' },
            { id: 'c7_2', grade: '七年级', name: '2班' },
            { id: 'c9_1', grade: '九年级', name: '1班' },
        ],
    });
    const result = await parseTimetableRules({
        text: '七年级1班和2班周五活动。后者第3节开始，前者第4节开始。',
        project,
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'class_unavailable');
    const slotsByClass = Object.fromEntries(
        rows.map(item => [item.targetName, item.slots])
    );
    assert.deepEqual(slotsByClass, {
        七年级2班: ['5-3'],
        七年级1班: ['5-4'],
    });
});

test('typed context resolves a subject antecedent but still asks for its class scope', async () => {
    const result = await parseTimetableRules({
        text: '数学是主科。这门课尽量上午。',
        project: makeProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'subject_morning' && item.targetName === '数学');

    assert.ok(row);
    assert.equal(result.sourceRequirements.length, 1);
    assert.equal(row.sourceId, result.sourceRequirements[0].sourceId);
    const ir = result.constraintIRs.find(item => item.capabilityId === 'subject.preferred_day_part');
    assert.ok(ir);
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
});

test('typed context carries a unique explicit slot to a later subject reference', async () => {
    const result = await parseTimetableRules({
        text: '英语周一第2节可以排。上述时段也适合语文。',
        project: makeProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'subject_preferred_periods');
    const slotsBySubject = Object.fromEntries(rows.map(item => [item.targetName, item.slots]));

    assert.deepEqual(slotsBySubject, {
        语文: ['1-2'],
        英语: ['1-2'],
    });
    assert.ok(rows.every(item => item.sourceId === result.sourceRequirements[0].sourceId));
});

test('ambiguous singular teacher pronoun asks for clarification instead of guessing', async () => {
    const result = await parseTimetableRules({
        text: '张老师和王老师周一有课。他周二上午没空。',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'teacher.unavailable');

    assert.ok(ir);
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.equal(ir.executionStatus, 'blocked_by_reference');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.equal(ir.target.name, '教师');
    assert.match(ir.clarifications.join(' '), /他.*先行词/);
    assert.equal(result.draftRows.some(item => item.type === 'teacher_unavailable'), false);
    assert.equal(['张老师', '王老师'].includes(ir.target.name), false);
});

test('ordered teacher antecedents resolve 前一位 and 后一位 without swapping targets', async () => {
    const result = await parseTimetableRules({
        text: '张老师和王老师周一有课。前一位周二上午没空，后一位周三下午没空。',
        project: makeProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'teacher_unavailable');
    const daysByTeacher = Object.fromEntries(rows.map(item => [item.targetName, item.days]));

    assert.deepEqual(daysByTeacher, {
        王老师: [3],
        张老师: [2],
    });
    assert.ok(rows.every(item => item.status === 'effective'));
});

test('a new explicit subject replaces the prior subject antecedent for later singular reference', async () => {
    const result = await parseTimetableRules({
        text: '数学尽量上午。英语尽量下午。这门课周五第1节也可以。',
        project: makeProject(),
        env: {},
    });
    const row = result.draftRows.find(item => (
        item.type === 'subject_preferred_periods'
        && item.targetName === '英语'
        && item.slots?.includes('5-1')
    ));

    assert.ok(row, 'the latest explicit subject must replace the older subject context');
    assert.equal(result.constraintIRs.some(item => (
        item.reviewStatus === 'needs_clarification'
        && item.clarifications?.some(message => message.includes('这门课'))
    )), false);
});

test('typed context never inherits an antecedent across source requirement boundaries', async () => {
    const result = await parseTimetableRules({
        text: '张老师周一上午没空。\n他周二下午也没空。',
        project: makeProject(),
        env: {},
    });

    assert.equal(result.sourceRequirements.length, 2);
    const [firstSource, secondSource] = result.sourceRequirements;
    assert.notEqual(firstSource.sourceId, secondSource.sourceId);
    assert.equal(firstSource.source.rawText, '张老师周一上午没空。');
    assert.equal(secondSource.source.rawText, '他周二下午也没空。');
    assert.ok(firstSource.machineRuleIds.length > 0);
    assert.deepEqual(secondSource.machineRuleIds, []);

    const secondIr = result.constraintIRs.find(item => item.sourceId === secondSource.sourceId);
    assert.ok(secondIr);
    assert.equal(secondIr.target.name, '教师');
    assert.equal(secondIr.reviewStatus, 'needs_clarification');
    assert.equal(secondIr.executionStatus, 'blocked_by_reference');
    assert.deepEqual(secondIr.machineRuleIds, []);
    assert.equal(result.draftRows.some(item => item.sourceId === secondSource.sourceId), false);
});



test('partial quantified negation stays in clarification and never expands to all blocked slots', async () => {
    const result = await parseTimetableRules({
        text: '张老师不能周一周二都排第一节',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'teacher.avoid_periods');
    const clause = result.sourceRequirements[0]?.clauses?.find(item => item.capabilityId === 'teacher.avoid_periods');

    assert.ok(ir);
    assert.ok(clause);
    assert.deepEqual(ir.parameters.days, [1, 2]);
    assert.deepEqual(ir.parameters.periods, [1]);
    assert.equal(ir.strength, 'hard');
    assert.ok(ir.negation.cues.includes('不能'));
    assert.equal(ir.negation.scope, 'scoped');
    assert.equal(ir.negation.polarity, 'negative');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.equal(ir.executionStatus, 'unsupported_by_solver');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.deepEqual(clause.machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
    assert.deepEqual(result.sourceRequirements[0].machineRuleIds, []);
});

test('not-all negation remains semantic-only clarification without an unknown machine row', async () => {
    const result = await parseTimetableRules({
        text: '不是所有主科都必须上午',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'unknown');
    const clause = result.sourceRequirements[0]?.clauses?.find(item => item.intent === 'unknown');

    assert.ok(ir);
    assert.ok(clause);
    assert.equal(ir.target.name, '主科');
    assert.equal(ir.strength, 'soft');
    assert.ok(ir.negation.cues.includes('不是'));
    assert.equal(ir.negation.scope, 'scoped');
    assert.equal(ir.negation.polarity, 'limited_or_double_negative');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.equal(ir.executionStatus, 'unsupported_by_solver');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.deepEqual(clause.machineRuleIds, []);
    assert.deepEqual(result.sourceRequirements[0].machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

test('scoped exception negation preserves its exception and stays non-executable', async () => {
    const result = await parseTimetableRules({
        text: '除体育外，其他课不要排最后一节',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'subject.avoid_periods');
    const clause = result.sourceRequirements[0]?.clauses?.find(item => item.capabilityId === 'subject.avoid_periods');

    assert.ok(ir);
    assert.ok(clause);
    assert.deepEqual(ir.exceptions, ['体育']);
    assert.deepEqual(clause.exceptions, ['体育']);
    assert.equal(ir.target.kind, 'derived_group');
    assert.equal(clause.object.kind, 'derived_group');
    assert.equal(ir.negation.scope, 'scoped');
    assert.ok(ir.negation.cues.some(cue => cue.includes('除体育外')));
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

test('only-laboratory scoped negation preserves both subject and room while staying non-executable', async () => {
    const baseProject = makeProject();
    const result = await parseTimetableRules({
        text: '只有实验课才可以使用实验室',
        project: makeProject({
            subjects: [...baseProject.subjects, { id: 's5', name: '实验课' }],
            rooms: [{ id: 'lab', name: '实验室', tags: ['实验室', '实验'] }],
        }),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'room.required');
    const clause = result.sourceRequirements[0]?.clauses?.find(item => item.capabilityId === 'room.required');

    assert.ok(ir);
    assert.ok(clause);
    assert.equal(ir.target.name, '实验课');
    assert.equal(clause.object.name, '实验课');
    assert.equal(ir.parameters.roomName, '实验室');
    assert.equal(ir.parameters.roomRequirement?.roomName, '实验室');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.deepEqual(result.sourceRequirements[0].machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

test('complex negation keeps multi-subject Friday crowding in course-scope clarification', async () => {
    const result = await parseTimetableRules({
        text: '不要把语文和英语都挤在周五',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'subject.spread');
    const clause = result.sourceRequirements[0]?.clauses?.find(item => item.capabilityId === 'subject.spread');

    assert.ok(ir);
    assert.ok(clause);
    assert.equal(ir.intent, 'subject_spread');
    assert.equal(ir.target.kind, 'subject_group');
    assert.equal(clause.object.kind, 'subject_group');
    assert.deepEqual(new Set(ir.target.matchedIds), new Set(['s1', 's3']));
    assert.deepEqual(new Set(clause.object.matchedIds), new Set(['s1', 's3']));
    assert.deepEqual(ir.parameters.subjectIds, ['s1', 's3']);
    assert.deepEqual(ir.parameters.subjectNames, ['语文', '英语']);
    assert.deepEqual(ir.parameters.days, [5]);
    assert.deepEqual(ir.parameters.avoidDays, [5]);
    assert.equal(ir.strength, 'soft');
    assert.ok(ir.negation.cues.includes('不要'));
    assert.equal(ir.executionStatus, 'blocked_by_clarification');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.match(ir.clarifications.join(' '), /补充班级.*全校/);
    assert.deepEqual(ir.machineRuleIds, []);
    assert.deepEqual(clause.machineRuleIds, []);
    assert.deepEqual(result.sourceRequirements[0].machineRuleIds, []);
    assert.equal(result.draftRows.length, 1);
    assert.equal(result.draftRows[0].courseScopeClarification, true);
    assert.equal(result.draftRows[0].status, 'needs_review');
    assert.equal(result.constraintIRs.some(item => item.capabilityId === 'subject.avoid_periods'), false);
});

test('not-required-afternoon clause keeps only the explicit soft first-period avoidance', async () => {
    const result = await parseTimetableRules({
        text: '体育课不是必须下午，但尽量别在上午第一节',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'subject.avoid_periods');
    const row = result.draftRows.find(item => item.type === 'subject_avoid_periods');

    assert.ok(ir);
    assert.ok(row);
    assert.equal(ir.intent, 'avoid_first_period');
    assert.equal(ir.target.name, '体育');
    assert.notEqual(ir.target.name, '但');
    assert.deepEqual(ir.parameters.periods, [1]);
    assert.equal(ir.strength, 'soft');
    assert.equal(ir.negation.polarity, 'limited_or_double_negative');
    assert.ok(ir.negation.cues.includes('不是'));
    assert.ok(ir.negation.cues.includes('尽量别'));
    assert.equal(result.constraintIRs.some(item => item.capabilityId === 'subject.preferred_periods'), false);
});

test('double negation keeps only the explicit soft last-period avoidance', async () => {
    const project = makeProject();
    const lastPeriod = Math.max(...project.periods.map(item => item.period));
    const result = await parseTimetableRules({
        text: '数学不是不能排下午，只是尽量别放最后一节',
        project,
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'subject.avoid_periods');
    const row = result.draftRows.find(item => item.type === 'subject_avoid_periods');

    assert.ok(ir);
    assert.ok(row);
    assert.equal(ir.strength, 'soft');
    assert.equal(ir.negation.polarity, 'limited_or_double_negative');
    assert.ok(ir.negation.cues.includes('不是不能'));
    assert.ok(ir.negation.cues.includes('尽量别'));
    assert.deepEqual(ir.parameters.periods, [lastPeriod]);
    assert.deepEqual(row.periods, [lastPeriod]);
    assert.equal(row.priority, 'soft');
    assert.ok(row.slots.every(slot => slot.endsWith(`-${lastPeriod}`)));
});


test('parallel period list keeps every explicitly enumerated lesson index', async () => {
    const result = await parseTimetableRules({
        text: '英語优先第2、3節',
        project: makeProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.capabilityId === 'subject.preferred_periods');
    const row = result.draftRows.find(item => item.type === 'subject_preferred_periods');

    assert.ok(ir);
    assert.ok(row);
    assert.equal(ir.target.name, '英语');
    assert.deepEqual(ir.parameters.periods, [2, 3]);
    assert.deepEqual(row.periods, [2, 3]);
    assert.deepEqual(row.slots, [
        '1-2', '1-3',
        '2-2', '2-3',
        '3-2', '3-3',
        '4-2', '4-3',
        '5-2', '5-3',
    ]);
});

test('undefined golden hour stays as reviewable semantics without a fabricated morning rule', async () => {
    const result = await parseTimetableRules({
        text: '数学课尽量排在“黄金时段”',
        project: makeProject(),
        env: {},
    });
    const source = result.sourceRequirements[0];
    const ir = result.constraintIRs.find(item => item.intent === 'golden_hour_preference');
    const clause = source?.clauses?.find(item => item.intent === 'golden_hour_preference');

    assert.equal(result.sourceRequirements.length, 1);
    assert.ok(ir);
    assert.ok(clause);
    assert.equal(ir.capabilityId, 'subject.preferred_day_part');
    assert.equal(ir.target.kind, 'subject');
    assert.equal(ir.target.name, '数学');
    assert.deepEqual(ir.target.matchedIds, ['s2']);
    assert.equal(ir.parameters.dayPart, 'golden');
    assert.equal(ir.strength, 'soft');
    assert.equal(ir.understandingStatus, 'parsed');
    assert.equal(ir.executionStatus, 'blocked_by_clarification');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.deepEqual(clause.machineRuleIds, []);
    assert.deepEqual(source.machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

function makeEllipsisMarketProject() {
    return makeProject({
        classes: [
            { id: 'c7_1', grade: '七年级', name: '1班' },
            { id: 'c7_2', grade: '七年级', name: '2班' },
        ],
        subjects: [
            { id: 's1', name: '语文' },
            { id: 's2', name: '数学' },
            { id: 's3', name: '英语' },
            { id: 's4', name: '体育' },
            { id: 's5', name: '音乐' },
            { id: 's6', name: '物理' },
            { id: 's7', name: '化学' },
            { id: 's8', name: '生物' },
            { id: 's9', name: '信息技术' },
            { id: 's10', name: '校本课' },
            { id: 's11', name: '社团课' },
            { id: 's12', name: '培优课' },
        ],
        rooms: [{ id: 'lab', name: '实验室', tags: ['实验室', '实验'] }],
        periods: Array.from({ length: 35 }, (_, index) => ({
            day: Math.floor(index / 7) + 1,
            period: (index % 7) + 1,
        })),
        periodsPerDay: 7,
        dayPartBoundaries: { morningEndPeriod: 4, afternoonStartPeriod: 5 },
    });
}

test('ellipsis unavailable continuation inherits teacher and day while replacing the period', async () => {
    const result = await parseTimetableRules({
        text: '王老师周二第1节没空，第2节也不行',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'teacher_unavailable');

    assert.equal(result.sourceRequirements.length, 1);
    assert.deepEqual(rows.map(item => [item.targetName, item.slots]).sort(), [
        ['王老师', ['2-1']],
        ['王老师', ['2-2']],
    ]);
});

test('ellipsis same-as predicate keeps morning semantics for a new explicit subject', async () => {
    const result = await parseTimetableRules({
        text: '数学尽量上午，英语也一样',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'subject_morning');

    assert.deepEqual(rows.map(item => item.targetName).sort(), ['数学', '英语']);
    assert.equal(result.draftRows.some(item => (
        item.targetName === '英语' && item.type === 'subject_preferred_periods'
    )), false);
});

test('ellipsis negative predicate keeps first-period scope for a new explicit subject', async () => {
    const result = await parseTimetableRules({
        text: '体育不要第一节，音乐也不要',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'subject_avoid_periods');

    assert.deepEqual(rows.map(item => item.targetName).sort(), ['体育', '音乐']);
    assert.ok(rows.every(item => item.slots.length === 5));
    assert.ok(rows.every(item => item.slots.every(slot => slot.endsWith('-1'))));
});

test('ellipsis teacher daily limit inherits daily scope but replaces target and limit', async () => {
    const result = await parseTimetableRules({
        text: '张老师每天最多4节，李老师最多3节',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const limits = Object.fromEntries(result.draftRows
        .filter(item => item.type === 'teacher_daily_limit')
        .map(item => [item.targetName, item.limit]));

    assert.deepEqual(limits, { 张老师: 4, 李老师: 3 });
});

test('ellipsis room predicate inherits the room while replacing the explicit subject', async () => {
    const result = await parseTimetableRules({
        text: '物理实验去实验室，化学实验也去',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'room_requirement');

    assert.deepEqual(rows.map(item => [item.targetName, item.roomName]).sort(), [
        ['化学', '实验室'],
        ['物理', '实验室'],
    ]);
});

test('ellipsis preferred-time continuation inherits subject and replaces explicit time', async () => {
    const result = await parseTimetableRules({
        text: '语文周一第2节优先，周三第3节也可以',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'subject_preferred_periods');

    assert.deepEqual(rows.map(item => [item.targetName, item.slots]).sort(), [
        ['语文', ['1-2']],
        ['语文', ['3-3']],
    ]);
});

test('ellipsis class shorthand inherits grade and same time for fixed activity', async () => {
    const result = await parseTimetableRules({
        text: '七年级1班周五第7节班会，2班同一时间也安排',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'class_unavailable');

    assert.equal(result.sourceRequirements.length, 1);
    assert.deepEqual(rows.map(item => [item.targetName, item.slots]).sort(), [
        ['七年级1班', ['5-7']],
        ['七年级2班', ['5-7']],
    ]);
});

test('ellipsis spread paraphrases preserve both subjects while asking for their class scopes', async () => {
    const result = await parseTimetableRules({
        text: '英语一周分散点，数学也别扎堆',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const irs = result.constraintIRs
        .filter(item => item.capabilityId === 'subject.spread')
        .sort((left, right) => left.target.name.localeCompare(right.target.name));

    assert.deepEqual(irs.map(item => item.target.name), ['数学', '英语']);
    assert.ok(irs.every(item => item.executionStatus === 'blocked_by_clarification'));
    assert.ok(irs.every(item => item.machineRuleIds.length === 0));
});

test('day-part-scoped consecutive limit stays semantic-only instead of widening globally', async () => {
    const result = await parseTimetableRules({
        text: '张老师最多连续2节，下午最好别连着上',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'teacher_consecutive_limit');

    assert.ok(ir);
    assert.equal(ir.target.name, '张老师');
    assert.equal(ir.parameters.limit, 2);
    assert.equal(ir.parameters.dayPart, 'afternoon');
    assert.equal(ir.executionStatus, 'unsupported_by_solver');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.equal(result.draftRows.some(item => item.type === 'teacher_consecutive_limit'), false);
});

test('global meeting blocks only its explicit time and ignores a later normal period', async () => {
    const result = await parseTimetableRules({
        text: '周一上午全校开会，下午正常',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'global_unavailable');

    assert.ok(row);
    assert.deepEqual(row.days, [1]);
    assert.deepEqual(row.periods, [1, 2, 3, 4]);
    assert.deepEqual(row.slots, ['1-1', '1-2', '1-3', '1-4']);
    assert.equal(result.draftRows.some(item => (item.slots || []).some(slot => /^1-[5-7]$/.test(slot))), false);
});

test('colloquial empty-slot wording maps to teacher unavailable time', async () => {
    const result = await parseTimetableRules({
        text: '王老师周三头一堂先空着',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'teacher_unavailable');

    assert.ok(row);
    assert.equal(row.targetName, '王老师');
    assert.deepEqual(row.days, [3]);
    assert.deepEqual(row.periods, [1]);
    assert.deepEqual(row.slots, ['3-1']);
});

test('colloquial tail-period pressure maps to a soft last-period avoidance', async () => {
    const result = await parseTimetableRules({
        text: '体育别老压在收尾那节',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'avoid_last_period');
    const row = result.draftRows.find(item => item.type === 'subject_avoid_periods');

    assert.ok(ir);
    assert.ok(row);
    assert.equal(ir.target.name, '体育');
    assert.equal(ir.strength, 'soft');
    assert.deepEqual(ir.parameters.periods, [7]);
    assert.ok(row.slots.every(slot => slot.endsWith('-7')));
});

test('colloquial daily maximum accepts 一天顶多 and 堂', async () => {
    const result = await parseTimetableRules({
        text: '李老师一天顶多上四堂',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'teacher_daily_limit');

    assert.ok(row);
    assert.equal(row.targetName, '李老师');
    assert.equal(row.limit, 4);
});

test('colloquial consecutive maximum inherits teacher across 连轴转 explanation', async () => {
    const result = await parseTimetableRules({
        text: '张老师的课别排成连轴转，最多连两堂',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'teacher_consecutive_limit');

    assert.ok(row);
    assert.equal(row.targetName, '张老师');
    assert.equal(row.limit, 2);
});

test('compressed colloquial period enumeration keeps second and third periods', async () => {
    const result = await parseTimetableRules({
        text: '英语第二三节优先安排一下',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'subject_preferred_periods');

    assert.ok(row);
    assert.equal(row.targetName, '英语');
    assert.deepEqual(row.periods, [2, 3]);
    assert.ok(row.slots.every(slot => /-(?:2|3)$/.test(slot)));
});

test('colloquial weekly attendance wording maps to teacher maximum teaching days', async () => {
    const result = await parseTimetableRules({
        text: '张老师这周只来三天，课往这三天归拢',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const row = result.draftRows.find(item => item.type === 'teacher_max_days_per_week');

    assert.ok(row);
    assert.equal(row.targetName, '张老师');
    assert.equal(row.limit, 3);
});

test('role-group first-period preference requires clarification and stays semantic-only', async () => {
    const result = await parseTimetableRules({
        text: '班主任头节少排点，得盯早读',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'teacher_avoid_periods');

    assert.ok(ir);
    assert.equal(ir.target.kind, 'derived_group');
    assert.equal(ir.target.name, '班主任');
    assert.deepEqual(ir.parameters.periods, [1]);
    assert.equal(ir.understandingStatus, 'ambiguous');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

test('colloquial day-gap wording keeps both subjects and one-day interval', async () => {
    const result = await parseTimetableRules({
        text: '物理化学中间至少岔开一天',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const rows = result.draftRows.filter(item => item.type === 'course_interval');

    assert.deepEqual(rows.map(item => item.targetName).sort(), ['化学', '物理']);
    assert.ok(rows.every(item => item.minGapDays === 1));
});

test('subjective main-subject comfort request asks for clarification without a machine rule', async () => {
    const result = await parseTimetableRules({
        text: '帮我把主科排舒服点',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'unknown');

    assert.ok(ir);
    assert.equal(ir.target.kind, 'subject_group');
    assert.equal(ir.target.name, '主科');
    assert.equal(ir.understandingStatus, 'ambiguous');
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

test('school morning meeting maps to an executable global fixed activity', async () => {
    const result = await parseTimetableRules({
        text: '周一第一节是晨会，全校不排正课',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'global_unavailable');
    const row = result.draftRows.find(item => item.type === 'global_unavailable');

    assert.ok(ir);
    assert.ok(row);
    assert.deepEqual(ir.parameters.days, [1]);
    assert.deepEqual(ir.parameters.periods, [1]);
    assert.equal(ir.activity?.name || ir.activity, '晨会');
    assert.deepEqual(row.slots, ['1-1']);
});

test('undefined school activity periods stay in clarification with their activity names', async () => {
    const cases = [
        ['周三大课间做操，不占学科课', 'global_unavailable', '大课间'],
        ['眼保健操时段不排新课', 'global_unavailable', '眼保健操'],
        ['午间管理时段不排普通教学任务', 'lunch_protection', '午间管理'],
    ];

    for (const [text, intent, activity] of cases) {
        const result = await parseTimetableRules({ text, project: makeEllipsisMarketProject(), env: {} });
        const ir = result.constraintIRs.find(item => item.intent === intent);
        assert.ok(ir, text);
        assert.equal(ir.activity?.name || ir.activity, activity, text);
        assert.equal(ir.reviewStatus, 'needs_clarification', text);
        assert.deepEqual(ir.machineRuleIds, [], text);
        assert.equal(result.draftRows.length, 0, text);
    }
});

test('grade fixed activities preserve grade scope and exact explicit time without class expansion', async () => {
    const cases = [
        ['周五第7节校本课，七年级统一占用', '七年级', '校本课', [5], [7], ''],
        ['九年级周测安排在周四下午，普通课停排', '九年级', '周测', [4], [5, 6, 7], 'afternoon'],
    ];

    for (const [text, grade, activity, days, periods, dayPart] of cases) {
        const result = await parseTimetableRules({ text, project: makeEllipsisMarketProject(), env: {} });
        const ir = result.constraintIRs.find(item => item.intent === 'class_unavailable');
        assert.ok(ir, text);
        assert.equal(ir.target.kind, 'grade', text);
        assert.equal(ir.target.name, grade, text);
        assert.equal(ir.activity?.name || ir.activity, activity, text);
        assert.deepEqual(ir.parameters.days, days, text);
        assert.deepEqual(ir.parameters.periods, periods, text);
        if (dayPart) assert.equal(ir.parameters.dayPart, dayPart, text);
        assert.equal(ir.executionStatus, 'unsupported_by_solver', text);
        assert.deepEqual(ir.machineRuleIds, [], text);
    }
});

test('preparation-group collective planning maps to teaching group meeting semantics', async () => {
    const result = await parseTimetableRules({
        text: '语文组周二下午集备，组内老师不要排课',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'teaching_group_meeting');

    assert.ok(ir);
    assert.equal(ir.target.kind, 'teaching_group');
    assert.equal(ir.target.name, '语文组');
    assert.equal(ir.activity?.name || ir.activity, '集备');
    assert.deepEqual(ir.parameters.days, [2]);
    assert.equal(ir.parameters.dayPart, 'afternoon');
    assert.deepEqual(ir.machineRuleIds, []);
    assert.equal(result.draftRows.length, 0);
});

test('walk-class and co-teaching sessions retain activity semantics for clarification', async () => {
    const cases = [
        ['走班课要同开，几个行政班同一节上', '走班课'],
        ['双师课两位老师必须同时到班', '双师课'],
    ];

    for (const [text, activity] of cases) {
        const result = await parseTimetableRules({ text, project: makeEllipsisMarketProject(), env: {} });
        const ir = result.constraintIRs.find(item => item.intent === 'teaching_group_session');
        assert.ok(ir, text);
        assert.equal(ir.activity?.name || ir.activity, activity, text);
        assert.equal(ir.reviewStatus, 'needs_clarification', text);
        assert.deepEqual(ir.machineRuleIds, [], text);
    }
});

test('school club period preference retains slots but asks for missing lesson identity', async () => {
    const result = await parseTimetableRules({
        text: '社团课统一放周三最后两节',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'locked_slot');

    assert.ok(ir);
    assert.equal(ir.target.name, '社团课');
    assert.deepEqual(ir.parameters.days, [3]);
    assert.deepEqual(ir.parameters.periods, [6, 7]);
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
});

test('alternating early reading assignment retains subjects and first period for clarification', async () => {
    const result = await parseTimetableRules({
        text: '早读由语文英语轮流占第一节',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'first_period_assign');

    assert.ok(ir);
    assert.equal(ir.target.kind, 'subject_group');
    assert.deepEqual(ir.parameters.subjectNames, ['语文', '英语']);
    assert.deepEqual(ir.parameters.periods, [1]);
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
});

test('school science block alias preserves each subject and block size', async () => {
    const result = await parseTimetableRules({
        text: '物化生实验课要连排两节，学校叫大连堂',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const irs = result.constraintIRs.filter(item => item.intent === 'block_preference');
    const subjectNames = new Set(irs.flatMap(item => (
        item.parameters.subjectNames?.length ? item.parameters.subjectNames : [item.target.name]
    )));

    assert.deepEqual(subjectNames, new Set(['物理', '化学', '生物']));
    assert.ok(irs.length > 0);
    assert.ok(irs.every(item => item.parameters.blockSize === 2));
    assert.equal(result.constraintIRs.some(item => item.intent === 'teacher_consecutive_limit'), false);
});

test('undefined golden period avoidance preserves the full school subject group for clarification', async () => {
    const result = await parseTimetableRules({
        text: '音体美信尽量别占黄金段',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'subject_avoid_periods');

    assert.ok(ir);
    assert.equal(ir.target.kind, 'subject_group');
    assert.deepEqual(new Set(ir.parameters.subjectNames), new Set(['音乐', '体育', '美术', '信息技术']));
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
});

test('head-teacher meeting keeps role group and weekday without guessing the class-meeting period', async () => {
    const result = await parseTimetableRules({
        text: '班主任会放在周一班会课，全体班主任避开',
        project: makeEllipsisMarketProject(),
        env: {},
    });
    const ir = result.constraintIRs.find(item => item.intent === 'teacher_unavailable');

    assert.ok(ir);
    assert.equal(ir.target.kind, 'derived_group');
    assert.equal(ir.target.name, '全体班主任');
    assert.equal(ir.activity?.name || ir.activity, '班主任会');
    assert.deepEqual(ir.parameters.days, [1]);
    assert.equal(ir.reviewStatus, 'needs_clarification');
    assert.deepEqual(ir.machineRuleIds, []);
});

test('course preferences compile to a scoped advanced rule only when the class is explicit', async () => {
    const project = makeProject({
        teachers: [
            { id: 't_liu', name: '刘老师' },
            { id: 't_wang', name: '王老师' },
        ],
        classes: [
            { id: 'c_g7_1', grade: '七年级', name: 'G7-1班' },
            { id: 'c_g7_2', grade: '七年级', name: 'G7-2班' },
        ],
        subjects: [{ id: 'math', name: '数学' }],
        lessonPlans: [
            { id: 'lp_g7_1_liu', classId: 'c_g7_1', subjectId: 'math', teacherIds: ['t_liu'], weeklyHours: 5 },
            { id: 'lp_g7_2_wang', classId: 'c_g7_2', subjectId: 'math', teacherIds: ['t_wang'], weeklyHours: 5 },
        ],
    });

    const scoped = await parseTimetableRules({
        text: 'G7-1班数学上午优先',
        project,
        env: {},
    });
    const scopedRule = scoped.draftRules.advancedRules[0];
    assert.ok(scopedRule);
    assert.equal(scopedRule.type, 'subject.preferred_day_part');
    assert.deepEqual(scopedRule.parameters.classIds, ['c_g7_1']);
    assert.deepEqual(scopedRule.parameters.teacherIds || [], []);
    assert.equal(scoped.draftRules.softRules.morningSubjects.includes('math'), false);

    const teacherScoped = await parseTimetableRules({
        text: 'G7-1班刘老师的数学避开周一第1节',
        project,
        env: {},
    });
    const teacherRule = teacherScoped.draftRules.advancedRules[0];
    assert.ok(teacherRule);
    assert.equal(teacherRule.type, 'subject.avoid_periods');
    assert.deepEqual(teacherRule.parameters.classIds, ['c_g7_1']);
    assert.deepEqual(teacherRule.parameters.teacherIds, ['t_liu']);

    const ambiguous = await parseTimetableRules({
        text: '数学尽量上午',
        project,
        env: {},
    });
    const ambiguousRule = ambiguous.constraintIRs.find(item => item.capabilityId === 'subject.preferred_day_part');
    assert.ok(ambiguousRule);
    assert.equal(ambiguousRule.executionStatus, 'blocked_by_clarification');
    assert.match(ambiguousRule.clarifications.join(' '), /补充班级.*全校/);
    assert.deepEqual(ambiguous.draftRules.advancedRules, []);
    assert.deepEqual(ambiguous.draftRules.softRules.morningSubjects || [], []);

    const global = await parseTimetableRules({
        text: '全校数学尽量上午',
        project,
        env: {},
    });
    assert.ok(global.draftRules.softRules.morningSubjects.includes('math'));
    assert.deepEqual(global.draftRules.advancedRules, []);
});
