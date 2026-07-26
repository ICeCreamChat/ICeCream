import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import {
    buildSourceRequirements,
} from '../gateway/services/timetable-constraints/source-requirement.js';
import {
    buildRequirementStatistics,
} from '../gateway/services/timetable-constraints/statistics.js';

const fixturePath = path.join(process.cwd(), 'test/fixtures/timetable-natural-language-137.json');
const workbookPath = path.join(process.cwd(), '真实学校排课约束需求.xlsx');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function findSourceByRow(result, sourceRow) {
    return (result.sourceRequirements || []).find(item => item.source?.rowNumber === sourceRow);
}

test('real timetable natural-language fixture contains exactly 137 source rows', () => {
    assert.equal(fixture.length, 137);
    assert.equal(new Set(fixture.map(item => item.sourceRow)).size, 137);
    assert.ok(fixture.every(item => item.sourceSheet === '自然语言约束'));
    assert.ok(fixture.every(item => typeof item.rawText === 'string' && item.rawText.trim()));
});

test('fixture rawText exactly matches the real workbook source text', async () => {
    const result = await parseTimetableRules({
        file: {
            filename: '真实学校排课约束需求.xlsx',
            buffer: fs.readFileSync(workbookPath),
        },
        project: {},
        env: {},
    });
    const actualByRow = new Map((result.sourceRequirements || []).map(item => [
        item.source?.rowNumber,
        item.source?.rawText,
    ]));
    const mismatches = fixture.filter(item => actualByRow.get(item.sourceRow) !== item.rawText);

    assert.equal(
        mismatches.length,
        0,
        `fixture must preserve workbook punctuation and text exactly; mismatched rows: ${mismatches.length}`,
    );
});
test('same source text at different spreadsheet rows keeps distinct stable source identities', () => {
    const rawText = '刘老师周一第2节不要排课。';
    const rows = [
        { sourceSheet: '自然语言约束', sourceRow: 2, rawText },
        { sourceSheet: '自然语言约束', sourceRow: 3, rawText },
    ];
    const first = buildSourceRequirements(rows, {
        inputType: 'xlsx_constraints',
        fileName: 'constraints.xlsx',
        origin: 'user_input',
    });
    const second = buildSourceRequirements(rows, {
        inputType: 'xlsx_constraints',
        fileName: 'constraints.xlsx',
        origin: 'user_input',
    });

    assert.equal(first.length, 2);
    assert.notEqual(first[0].sourceId, first[1].sourceId);
    assert.equal(first[0].source.textHash, first[1].source.textHash);
    assert.deepEqual(first.map(item => item.sourceId), second.map(item => item.sourceId));
});

test('137 spreadsheet inputs remain 137 top-level source requirements while machine rows may expand', async () => {
    const result = await parseTimetableRules({
        file: {
            filename: '真实学校排课约束需求.xlsx',
            buffer: fs.readFileSync(workbookPath),
        },
        project: {},
        env: {},
    });

    assert.equal(result.schemaVersion, 2);
    assert.equal(result.parserVersion, 'timetable_rule_parser_constraint_ir_v11');
    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(new Set(result.sourceRequirements.map(item => item.sourceId)).size, 137);
    assert.equal(result.statistics.userInputCount, 137);
    assert.equal(result.statistics.sourceRequirementCount, 137);
    const sourceClauseCount = result.sourceRequirements.reduce((total, item) => total + (item.clauses || []).length, 0);
    assert.equal(result.statistics.clauseCount, sourceClauseCount);
    assert.equal(result.constraintIRs.length, sourceClauseCount);
    assert.ok(result.statistics.clauseCount >= result.statistics.userInputCount);
    assert.equal(result.statistics.draftRowCount, result.draftRows.length);
    const machineRows = result.draftRows.filter(item => item.machineRuleId);
    const reviewRows = result.draftRows.filter(item => !item.machineRuleId);
    assert.equal(result.statistics.machineRuleCount, machineRows.length);
    assert.equal(new Set(machineRows.map(item => item.machineRuleId)).size, machineRows.length);
    assert.ok(reviewRows.length > 0, 'review-only compatibility rows must remain visible');
    assert.ok(reviewRows.every(item => ['needs_review', 'invalid', 'unsupported'].includes(item.status)));
    assert.equal(result.requirementItems.length, sourceClauseCount, 'legacy requirementItems project clauses, not top-level user inputs');

    const geographyBiology = findSourceByRow(result, 131);
    assert.ok(geographyBiology, 'unrecognized source row must remain visible');
    assert.match(geographyBiology.source.rawText, /地理和生物尽量隔天分布/);
    assert.match(geographyBiology.understandingStatus, /invalid_reference|partially_parsed|unrecognized|ambiguous/);

    const expandedMorningSource = findSourceByRow(result, 114);
    assert.ok(expandedMorningSource);
    assert.equal(expandedMorningSource.clauses.length, 6);
    assert.equal(
        expandedMorningSource.machineRuleIds.length,
        0,
        '指定教师覆盖班级的上午偏好不得扩大编译为全校学科机器规则',
    );

    for (const [sourceRow, expectedClauses] of [[115, 4], [116, 2], [138, 1]]) {
        const source = findSourceByRow(result, sourceRow);
        assert.ok(source, `missing source requirement at sourceRow ${sourceRow}`);
        assert.equal(source.clauses.length, expectedClauses);
        assert.equal(source.machineRuleIds.length, 0, `sourceRow ${sourceRow} must keep scoped semantics without a widened machine rule`);
    }

    const crossVenueBoundary = findSourceByRow(result, 133);
    assert.ok(crossVenueBoundary);
    assert.equal(crossVenueBoundary.clauses.length, 1);
    assert.equal(crossVenueBoundary.clauses[0].capabilityId, 'schedule.cross_venue_boundary');
    assert.equal(crossVenueBoundary.machineRuleIds.length, 1, 'cross-venue boundary must compile to one advanced machine rule');

    const cached = await parseTimetableRules({
        file: {
            filename: '真实学校排课约束需求.xlsx',
            buffer: fs.readFileSync(workbookPath),
        },
        project: {},
        env: {},
    });
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.schemaVersion, 2);
    assert.equal(cached.parserVersion, 'timetable_rule_parser_constraint_ir_v11');
    assert.equal(cached.sourceRequirements.length, 137);
});

test('system supplements are counted separately from user source requirements', () => {
    const sources = buildSourceRequirements([
        { lineNumber: 1, rawText: '张老师周一第1节不排课。' },
        { lineNumber: 2, rawText: '李老师周二第2节不排课。' },
    ], { inputType: 'text', origin: 'user_input' });
    const statistics = buildRequirementStatistics({
        sourceRequirements: sources,
        systemSupplements: [
            { supplementId: 'system:teacher-no-overlap', origin: 'system_supplement' },
        ],
        draftRows: [],
    });

    assert.equal(statistics.userInputCount, 2);
    assert.equal(statistics.systemSupplementCount, 1);
    assert.equal(statistics.sourceRequirementCount, 2);
});
