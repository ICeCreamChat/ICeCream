import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp } from '../gateway/app.js';
import {
    applyAiReviewToParseResult,
    parseTimetableRules,
    rebindTimetableRuleResult,
} from '../gateway/services/timetable-rule-parser.js';
import { assessConstraintParseReadiness } from '../gateway/services/timetable-constraints/parse-readiness.js';
import { applyConstraintEntityBindings } from '../gateway/services/timetable-constraints/entity-binding.js';
import { finalizeSourceRequirementPresentation } from '../gateway/services/timetable-constraints/source-requirement.js';
import { createTimetableStore } from '../gateway/services/timetable-store.js';
import { parseTimetableRosterFile } from '../gateway/services/timetable-import.js';
import { createDefaultTimetableProject } from '../gateway/services/timetable-project.js';
import {
    buildUnifiedRequirementItems,
    getRequirementGroupKey,
} from '../public/js/tools/timetable/constraint-dialog-review-model.js';
import { createCompleteNaturalLanguage137Project } from './fixtures/timetable-natural-language-137-project.js';

const workbookPath = path.join(process.cwd(), '真实学校排课约束需求.xlsx');
const rosterWorkbookPath = path.join(process.cwd(), '真实学校整学期任课数据.xlsx');
const naturalLanguage137FixturePath = path.join(process.cwd(), 'test/fixtures/timetable-natural-language-137.json');
const REVIEW_19_SOURCE_ROWS = new Set([
    76, 77, 78, 79, 80, 81, 82, 83,
    124, 125, 126, 127, 128, 129, 130, 131,
    133, 134, 135,
]);
const INTERNAL_OBJECT_NAMES = new Set([
    'unsupported', 'need_review', 'needs_review', 'unknown', 'requirement', 'schedule_request',
]);

test('parse readiness requires valid teacher, class, subject and lesson-plan references', () => {
    const project = createCompleteNaturalLanguage137Project();
    assert.equal(assessConstraintParseReadiness(project).ready, true);
    const invalid = structuredClone(project);
    invalid.lessonPlans[0].teacherId = 'missing-teacher';
    invalid.lessonPlans[0].teacherIds = ['missing-teacher'];
    const readiness = assessConstraintParseReadiness(invalid);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.invalidLessonPlans, [invalid.lessonPlans[0].id]);
});

test('entity bindings only persist aliases to existing entities', () => {
    const project = createCompleteNaturalLanguage137Project();
    const targetId = project.teachers[0].id;
    const bound = applyConstraintEntityBindings(project, [{ kind: 'teacher', sourceName: '刘老师', targetId }]);
    assert.equal(bound.constraintEntityAliases.teacher['刘老师'], targetId);
    assert.throws(
        () => applyConstraintEntityBindings(project, [{ kind: 'teacher', sourceName: '不存在', targetId: 'missing' }]),
        error => error?.reason === 'entity_binding_target_not_found',
    );
});

test('real roster workbook creates stable room entities and keeps the real 137 sources actionable', async () => {
    const imported = parseTimetableRosterFile({
        filename: path.basename(rosterWorkbookPath),
        buffer: fs.readFileSync(rosterWorkbookPath),
    });
    assert.equal(imported.teachers.length, 62);
    assert.equal(imported.classes.length, 30);
    assert.equal(imported.subjects.length, 14);
    assert.equal(imported.lessonPlans.length, 360);
    assert.equal(imported.stats.fixedRoomCount, 43);
    assert.equal(imported.rooms.length, 43);
    const roomIds = new Set(imported.rooms.map(room => room.id));
    imported.lessonPlans.forEach(plan => {
        assert.ok(plan.allowedRoomIds.length > 0, plan.id);
        plan.allowedRoomIds.forEach(roomId => assert.ok(roomIds.has(roomId), `${plan.id}:${roomId}`));
    });
    const reimported = parseTimetableRosterFile({
        filename: path.basename(rosterWorkbookPath),
        buffer: fs.readFileSync(rosterWorkbookPath),
    }, { project: createDefaultTimetableProject(imported) });
    assert.deepEqual(
        new Map(reimported.rooms.map(room => [room.name, room.id])),
        new Map(imported.rooms.map(room => [room.name, room.id])),
    );

    const project = createDefaultTimetableProject({
        ...imported,
        weekdays: 5,
        periodsPerDay: 8,
        activeWeekdays: [1, 2, 3, 4, 5],
        activePeriods: [1, 2, 3, 4, 5, 6, 7, 8],
        rules: { hardRules: {}, softRules: {}, advancedRules: [] },
    });
    const result = await parseTimetableRules({
        file: { filename: path.basename(workbookPath), buffer: fs.readFileSync(workbookPath) },
        project,
        env: { TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true' },
    });
    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(result.constraintIRs.length, 150);
    assert.equal(result.sourceRequirements.filter(item => item.requiresHumanReview).length, 0);
    assert.equal(result.sourceRequirements.filter(item => item.applicationTarget !== 'rule').length, 0);
    assert.equal(result.constraintIRs.filter(item => item.executionStatus !== 'executable').length, 0);
});

test('manually pasted 137 constraints use the same deterministic contract as the workbook', async () => {
    const fixture = JSON.parse(fs.readFileSync(naturalLanguage137FixturePath, 'utf8'));
    const text = fixture.map(item => item.rawText).join('\n');
    const result = await parseTimetableRules({
        text,
        project: createCompleteNaturalLanguage137Project(),
        env: {
            TIMETABLE_RULE_AI_EXTRACT: '0',
            TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true',
        },
    });

    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(new Set(result.sourceRequirements.map(item => item.sourceId)).size, 137);
    assert.equal(result.constraintIRs.length, 150);
    assert.equal(
        result.sourceRequirements.reduce((count, item) => count + item.clauses.length, 0),
        result.constraintIRs.length,
        'source card details must project only the final canonical ConstraintIR set',
    );
    assert.equal(result.requirementItems.length, result.constraintIRs.length);
    assert.equal(result.statistics.clauseCount, result.constraintIRs.length);
    assert.equal(result.sourceRequirements.filter(item => item.requiresHumanReview).length, 0);
    assert.equal(result.sourceRequirements.filter(item => item.applicationTarget !== 'rule').length, 0);
    assert.equal(result.constraintIRs.filter(item => item.executionStatus !== 'executable').length, 0);
    const cards = buildUnifiedRequirementItems(result);
    assert.equal(cards.length, 137);
    assert.equal(cards.filter(item => getRequirementGroupKey(item) === 'review').length, 0);
    assert.equal(cards.filter(item => getRequirementGroupKey(item) === 'rule').length, 137);
    assert.equal(cards.filter(item => INTERNAL_OBJECT_NAMES.has(String(item.object?.name || '').toLowerCase())).length, 0);
    assert.equal(result.constraintIRs.filter(item => (
        /^(?:日课量|至少|每个班每天课量|课组内的教师|固定活动)$/i.test(String(item.target?.name || item.targetName || item.target || ''))
    )).length, 0);
});

test('complete 137 project keeps source cardinality and has no unsupported solver capability', async () => {
    const result = await parseTimetableRules({
        file: { filename: path.basename(workbookPath), buffer: fs.readFileSync(workbookPath) },
        project: createCompleteNaturalLanguage137Project(),
        env: {},
    });
    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(new Set(result.sourceRequirements.map(item => item.sourceId)).size, 137);
    assert.equal(result.constraintIRs.length, 150);
    assert.equal(result.constraintIRs.filter(item => item.executionStatus === 'unsupported_by_solver').length, 0);
    assert.equal(result.constraintIRs.filter(item => item.executionStatus === 'blocked_by_reference').length, 0);
    assert.equal(result.constraintIRs.filter(item => item.executionStatus === 'blocked_by_clarification').length, 0);
    assert.equal(result.sourceRequirements.filter(item => item.requiresHumanReview).length, 0);
    assert.equal(result.sourceRequirements.filter(item => item.applicationTarget !== 'rule').length, 0);
    assert.equal(result.sourceRequirements.filter(item => !item.machineRuleIds.length).length, 0);

    const review19Sources = result.sourceRequirements.filter(item => REVIEW_19_SOURCE_ROWS.has(item.source?.rowNumber));
    const review19SourceIds = new Set(review19Sources.map(item => item.sourceId));
    assert.equal(review19Sources.length, 19);
    assert.equal(result.constraintIRs.filter(item => review19SourceIds.has(item.sourceId)).length, 22);
    assert.equal(review19Sources.reduce((count, item) => count + item.machineRuleIds.length, 0), 22);
    review19Sources.forEach(item => {
        assert.equal(item.executionStatus, 'executable', item.rawText);
        assert.equal(item.applicationTarget, 'rule', item.rawText);
        assert.equal(item.requiresHumanReview, false, item.rawText);
        assert.deepEqual(item.reviewReasons, [], item.rawText);
    });

    const cards = buildUnifiedRequirementItems(result);
    assert.equal(cards.length, 137);
    assert.equal(cards.filter(item => getRequirementGroupKey(item) === 'review').length, 0);
    assert.equal(cards.filter(item => getRequirementGroupKey(item) === 'rule').length, 137);
    assert.equal(cards.filter(item => INTERNAL_OBJECT_NAMES.has(String(item.object?.name || '').toLowerCase())).length, 0);
    assert.equal(cards.find(item => item.source?.sourceRow === 133)?.object?.name, '全校');
    assert.equal(cards.find(item => item.source?.sourceRow === 134)?.object?.name, '同一备课组内教师');
});

test('one hundred unverified AI flags stay advisory without changing the 137 source classification', async () => {
    const project = createCompleteNaturalLanguage137Project();
    const local = await parseTimetableRules({
        file: { filename: path.basename(workbookPath), buffer: fs.readFileSync(workbookPath) },
        project,
        env: { TIMETABLE_RULE_AI_REVIEW_DISABLED: 'true' },
    });
    const reviewItems = local.sourceRequirements.slice(0, 100).map((source, index) => ({
        id: `advisory-${index + 1}`,
        verdict: 'flag',
        sourceId: source.sourceId,
        textHash: source.textHash,
        target: { sourceId: source.sourceId, textHash: source.textHash },
        evidence: { quote: source.rawText },
        reason: '低置信提示，未发现可由本地验证器复现的问题。',
    }));
    const result = applyAiReviewToParseResult({
        project,
        result: local,
        review: { model: 'mock-review', reviewItems },
        inputType: 'xlsx_constraints',
    });

    assert.equal(result.sourceRequirements.length, 137);
    assert.equal(result.constraintIRs.length, 150);
    assert.deepEqual(result.draftRows, local.draftRows);
    assert.deepEqual(result.constraintIRs, local.constraintIRs);
    assert.deepEqual(result.sourceRequirements, local.sourceRequirements);
    assert.deepEqual(
        result.draftRows.map(item => item.machineRuleId),
        local.draftRows.map(item => item.machineRuleId),
    );
    assert.equal(result.aiAssistance.advisoryCount, 100);
    assert.equal(result.aiAssistance.blockingCount, 0);
    assert.equal(result.sourceRequirements.filter(item => item.requiresHumanReview).length, 0);
    assert.equal(result.sourceRequirements.filter(item => item.applicationTarget === 'rule').length, 137);
});

test('canonical source review state only lets verified AI findings block application', () => {
    const executable = finalizeSourceRequirementPresentation({
        sourceId: 'source-executable',
        origin: 'user_input',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        machineRuleIds: ['rule-1'],
        warnings: ['普通软约束提示'],
        clauses: [{
            id: 'clause-1',
            executionStatus: 'executable',
            understandingStatus: 'parsed',
            machineRuleIds: ['rule-1'],
            warnings: ['普通软约束提示'],
        }],
    });
    assert.equal(executable.applicationTarget, 'rule');
    assert.equal(executable.requiresHumanReview, false);

    const partial = finalizeSourceRequirementPresentation({
        sourceId: 'source-partial',
        origin: 'user_input',
        understandingStatus: 'parsed',
        executionStatus: 'partially_executable',
        machineRuleIds: ['rule-2'],
        clauses: [],
    });
    assert.equal(partial.applicationTarget, 'review');
    assert.ok(partial.reviewReasons.some(reason => reason.code === 'partially_executable'));

    const flagged = finalizeSourceRequirementPresentation({
        sourceId: 'source-flagged',
        origin: 'user_input',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        machineRuleIds: ['rule-3'],
        clauses: [{
            id: 'clause-3',
            executionStatus: 'executable',
            understandingStatus: 'parsed',
            machineRuleIds: ['rule-3'],
            aiReviewStatus: 'flagged',
            aiReviewValidationStatus: 'advisory',
            aiReviewBlocking: false,
            aiReviewWarnings: ['对象范围需要确认'],
        }],
    });
    assert.equal(flagged.applicationTarget, 'rule');
    assert.equal(flagged.requiresHumanReview, false);
    assert.deepEqual(flagged.reviewReasons, []);

    const verified = finalizeSourceRequirementPresentation({
        sourceId: 'source-verified-ai-blocker',
        origin: 'user_input',
        understandingStatus: 'parsed',
        executionStatus: 'executable',
        machineRuleIds: ['rule-4'],
        clauses: [{
            id: 'clause-4',
            executionStatus: 'executable',
            understandingStatus: 'parsed',
            machineRuleIds: ['rule-4'],
            aiReviewStatus: 'flagged',
            aiReviewValidationStatus: 'blocking',
            aiReviewBlocking: true,
            aiReviewIssueCode: 'semantic_interpretation_conflict',
            aiReviewWarnings: ['原文存在两个无法自动裁决的解释'],
        }],
    });
    assert.equal(verified.applicationTarget, 'review');
    assert.equal(verified.requiresHumanReview, true);
    assert.ok(verified.reviewReasons.some(reason => (
        reason.code === 'ai_review_semantic_interpretation_conflict'
        && reason.origin === 'ai'
        && reason.verified === true
    )));
});

test('source-first cards recover semantic objects instead of displaying internal status names', () => {
    const sourceId = 'source-object-recovery';
    const cards = buildUnifiedRequirementItems({
        schemaVersion: 2,
        sourceRequirements: [{
            sourceId,
            rawText: '所有年级第4节和第5节之间不要安排跨场地课程。',
            textHash: 'source-object-recovery-hash',
            origin: 'user_input',
            status: 'actionable',
            understandingStatus: 'parsed',
            executionStatus: 'executable',
            reviewStatus: 'understood',
            applicationTarget: 'rule',
            requiresHumanReview: false,
            reviewReasons: [],
            machineRuleIds: ['rule-object-recovery'],
            clauses: [],
            source: {
                rawText: '所有年级第4节和第5节之间不要安排跨场地课程。',
                textHash: 'source-object-recovery-hash',
                lineNumber: 1,
            },
        }],
        constraintIRs: [{
            id: 'constraint-object-recovery',
            constraintId: 'constraint-object-recovery',
            clauseId: 'constraint-object-recovery',
            sourceId,
            textHash: 'source-object-recovery-hash',
            capabilityId: 'schedule.cross_venue_boundary',
            intent: 'cross_venue_boundary',
            target: { kind: 'global', name: '全校', matchedIds: ['__global__'], scope: 'global' },
            executionStatus: 'executable',
            understandingStatus: 'parsed',
            reviewStatus: 'understood',
            support: 'full',
            landing: ['rule'],
            machineRuleIds: ['rule-object-recovery'],
        }],
        requirementItems: [{
            id: 'legacy-object-recovery',
            sourceId,
            textHash: 'source-object-recovery-hash',
            object: { kind: 'global', name: 'unsupported' },
            intent: 'schedule_request',
            status: 'needs_review',
            applyTo: 'review',
        }],
        draftRows: [{
            id: 'rule-object-recovery',
            machineRuleId: 'rule-object-recovery',
            sourceId,
            targetType: 'global',
            targetName: 'need_review',
            type: 'advanced_constraint',
            status: 'effective',
        }],
    });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].object.name, '全校');
    assert.equal(getRequirementGroupKey(cards[0]), 'rule');
});

test('rebind uses saved aliases without changing source identity or calling AI', async () => {
    const project = createCompleteNaturalLanguage137Project();
    const sourceTeacher = project.teachers[0];
    sourceTeacher.name = '现有教师';
    const previous = await parseTimetableRules({
        text: '待绑定老师周一第2节不要排课。',
        project,
        env: {},
    });
    assert.equal(previous.constraintIRs[0].executionStatus, 'blocked_by_reference');
    const bound = applyConstraintEntityBindings(project, [{
        kind: 'teacher',
        sourceName: '待绑定老师',
        targetId: sourceTeacher.id,
    }]);
    const rebound = rebindTimetableRuleResult({ project: bound, previousResult: previous });
    assert.equal(rebound.constraintIRs[0].executionStatus, 'executable');
    assert.equal(rebound.constraintIRs[0].target.matchedIds[0], sourceTeacher.id);
    assert.equal(rebound.sourceRequirements[0].sourceId, previous.sourceRequirements[0].sourceId);
    assert.equal(rebound.sourceRequirements[0].textHash, previous.sourceRequirements[0].textHash);
});

test('local recompile unblocks an eighth-period rule after timetable configuration is completed', async () => {
    const project = createCompleteNaturalLanguage137Project();
    project.activePeriods = [1, 2, 3, 4, 5, 6, 7];
    project.periodsPerDay = 7;
    const previous = await parseTimetableRules({
        text: `${project.teachers[0].name}老师周一第8节不要排课。`,
        project,
        env: {},
    });
    assert.equal(previous.constraintIRs[0].executionStatus, 'blocked_by_clarification');
    project.activePeriods.push(8);
    project.periodsPerDay = 8;
    const rebound = rebindTimetableRuleResult({ project, previousResult: previous });
    assert.equal(rebound.constraintIRs[0].executionStatus, 'executable');
    assert.equal(rebound.sourceRequirements[0].sourceId, previous.sourceRequirements[0].sourceId);
    assert.equal(rebound.sourceRequirements[0].textHash, previous.sourceRequirements[0].textHash);
});

test('HTTP parse readiness and rebind endpoints preserve the public binding contract', async () => {
    const previousDataDir = process.env.TIMETABLE_DATA_DIR;
    process.env.TIMETABLE_DATA_DIR = await fs.promises.mkdtemp(path.join(tmpdir(), 'icecream-constraint-binding-'));
    const store = createTimetableStore();
    const app = createGatewayApp({ isDev: false });
    const server = app.listen(0, '127.0.0.1');
    const baseUrl = await new Promise(resolve => {
        server.on('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });

    try {
        const blockedResponse = await fetch(`${baseUrl}/api/tools/timetable/rules/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: '待绑定老师周一第2节不要排课。' }),
        });
        const blockedPayload = await blockedResponse.json();
        assert.equal(blockedResponse.status, 409);
        assert.equal(blockedPayload.data.reason, 'roster_required');
        assert.equal(blockedPayload.data.readiness.ready, false);

        const project = createCompleteNaturalLanguage137Project();
        const teacher = project.teachers[0];
        teacher.name = '现有教师';
        await store.saveProject(project);
        const previous = await parseTimetableRules({
            text: '待绑定老师周一第2节不要排课。',
            project,
            env: {},
        });
        const rebindResponse = await fetch(`${baseUrl}/api/tools/timetable/rules/rebind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bindings: [{ kind: 'teacher', sourceName: '待绑定老师', targetId: teacher.id }],
                previousResult: previous,
            }),
        });
        const rebindPayload = await rebindResponse.json();
        assert.equal(rebindResponse.status, 200);
        assert.equal(rebindPayload.data.project.constraintEntityAliases.teacher['待绑定老师'], teacher.id);
        assert.equal(rebindPayload.data.constraintIRs[0].executionStatus, 'executable');
        assert.equal(rebindPayload.data.sourceRequirements[0].sourceId, previous.sourceRequirements[0].sourceId);
        assert.equal(rebindPayload.data.sourceRequirements[0].textHash, previous.sourceRequirements[0].textHash);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousDataDir === undefined) delete process.env.TIMETABLE_DATA_DIR;
        else process.env.TIMETABLE_DATA_DIR = previousDataDir;
    }
});
