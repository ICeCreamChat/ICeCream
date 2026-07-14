import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseTimetableRules } from '../gateway/services/timetable-rule-parser.js';
import {
    buildConstraintApplyPlan,
    buildUnifiedRequirementItems,
    getActionableDraftRows,
    getActionableRequirementCount,
    getBackendRuleRows,
    getRequirementGroupKey,
} from '../public/js/tools/timetable/constraint-dialog-review-model.js';

function sourceRequirement({
    sourceId,
    rawText,
    clauses = [],
    machineRuleIds = [],
    origin = 'user_input',
    status = 'parsed',
    understandingStatus = 'parsed',
    executionStatus = 'executable',
    reviewStatus = 'ready',
    warnings = [],
    parsedBy = ['local'],
} = {}) {
    return {
        sourceId,
        rawText,
        textHash: `${sourceId}:hash`,
        origin,
        status,
        understandingStatus,
        executionStatus,
        reviewStatus,
        warnings,
        questions: [],
        parsedBy,
        clauses,
        machineRuleIds,
        source: {
            inputType: 'text',
            lineNumber: 1,
            rawText,
            textHash: `${sourceId}:hash`,
        },
    };
}

function clause({
    id,
    sourceId,
    clauseId,
    intent = 'preferred_periods',
    status = 'actionable',
    reviewStatus = 'ready',
    understandingStatus = 'parsed',
    executionStatus = 'executable',
    applyTo = 'rule',
    warnings = [],
} = {}) {
    return {
        id,
        requirementId: id,
        sourceId,
        clauseId,
        constraintId: clauseId,
        intent,
        status,
        reviewStatus,
        understandingStatus,
        executionStatus,
        applyTo,
        object: { kind: 'subject', name: '数学', matchedIds: ['math'], scope: 'explicit' },
        parameters: {},
        warnings,
    };
}

test('sourceRequirements are the only top-level cardinality and identical text never merges distinct sourceId values', () => {
    const sharedText = '同一句原文也可能来自不同上传行。';
    const firstClause = clause({
        id: 'req_a',
        sourceId: 'src:a',
        clauseId: 'clause:a',
    });
    const secondClause = clause({
        id: 'req_b',
        sourceId: 'src:b',
        clauseId: 'clause:b',
    });
    const review = {
        schemaVersion: 2,
        sourceRequirements: [
            sourceRequirement({ sourceId: 'src:a', rawText: sharedText, clauses: [firstClause] }),
            sourceRequirement({ sourceId: 'src:b', rawText: sharedText, clauses: [secondClause] }),
        ],
        requirementItems: [firstClause, secondClause],
        draftRows: [],
        semanticActions: [],
    };

    const items = buildUnifiedRequirementItems(review);

    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.id), ['src:a', 'src:b']);
    assert.deepEqual(items.map(item => item.sourceId), ['src:a', 'src:b']);
    assert.deepEqual(items.map(item => item.primaryRequirementId), ['req_a', 'req_b']);
});

test('advanced constraint rows are actionable backend rules when their source card is rule-applicable', () => {
    const sourceId = 'src:advanced';
    const machineRuleId = 'machine:advanced';
    const advancedClause = clause({
        id: 'req_advanced',
        sourceId,
        clauseId: 'clause:advanced',
        intent: 'teacher_gap_preference',
    });
    const review = {
        schemaVersion: 2,
        sourceRequirements: [{
            ...sourceRequirement({
                sourceId,
                rawText: '张老师同一天多节课尽量排得紧凑。',
                clauses: [advancedClause],
                machineRuleIds: [machineRuleId],
            }),
            applicationTarget: 'rule',
            requiresHumanReview: false,
        }],
        constraintIRs: [{
            ...advancedClause,
            capabilityId: 'teacher.compact_day',
        }],
        requirementItems: [advancedClause],
        draftRows: [{
            id: 'row_advanced',
            sourceId,
            clauseId: 'clause:advanced',
            requirementId: 'req_advanced',
            machineRuleId,
            type: 'advanced_constraint',
            advancedType: 'teacher.compact_day',
            status: 'effective',
        }],
        semanticActions: [],
    };

    assert.equal(getActionableRequirementCount(review), 1);
    assert.deepEqual(getActionableDraftRows(review).map(row => row.id), ['row_advanced']);
    assert.deepEqual(getBackendRuleRows(review).map(row => row.id), ['row_advanced']);
});

test('source requirement with missing origin stays visible as unknown instead of becoming user input', () => {
    const missingOrigin = sourceRequirement({
        sourceId: 'src:missing-origin',
        rawText: '来源字段缺失时不能冒充用户输入。',
        clauses: [],
        machineRuleIds: [],
        status: 'needs_review',
        understandingStatus: 'unrecognized',
        executionStatus: 'needs_review',
        reviewStatus: 'needs_review',
    });
    delete missingOrigin.origin;

    const [item] = buildUnifiedRequirementItems({
        schemaVersion: 2,
        sourceRequirements: [missingOrigin],
        requirementItems: [],
        constraintIRs: [],
        draftRows: [],
        semanticActions: [],
    });

    assert.equal(item.id, 'src:missing-origin');
    assert.equal(item.origin, 'unknown');
    assert.equal(item.source.origin, 'unknown');
});

test('schema v2 empty sourceRequirements never promotes expanded legacy artifacts to user input cards', () => {
    const items = buildUnifiedRequirementItems({
        schemaVersion: 2,
        sourceRequirements: [],
        requirementItems: Array.from({ length: 196 }, (_, index) => ({
            id: `expanded_${index + 1}`,
            intent: 'preferred_periods',
            status: 'actionable',
            applyTo: 'rule',
            source: { rawText: `派生语义 ${index + 1}` },
        })),
        draftRows: [],
        semanticActions: [],
    });

    assert.equal(items.length, 0);
});

test('one source card owns its clauses, machine rules and semantic actions through stable identities', () => {
    const sourceId = 'src:multi';
    const firstClause = clause({
        id: 'req_multi_a',
        sourceId,
        clauseId: 'clause:multi:a',
        intent: 'minimum_day_gap',
    });
    const secondClause = clause({
        id: 'req_multi_b',
        sourceId,
        clauseId: 'clause:multi:b',
        intent: 'avoid_weekday_concentration',
        status: 'needs_review',
        reviewStatus: 'unsupported',
        executionStatus: 'unsupported_by_solver',
        applyTo: 'review',
        warnings: ['当前求解器暂不支持。'],
    });
    const review = {
        schemaVersion: 2,
        sourceRequirements: [sourceRequirement({
            sourceId,
            rawText: '地理和生物尽量隔天分布，不要都挤在周四周五。',
            clauses: [firstClause, secondClause],
            machineRuleIds: ['machine:multi:a'],
            status: 'partially_supported',
            executionStatus: 'partially_actionable',
            reviewStatus: 'needs_review',
        })],
        constraintIRs: [firstClause, secondClause],
        requirementItems: [firstClause, secondClause],
        draftRows: [{
            id: 'row_multi_a',
            machineRuleId: 'machine:multi:a',
            requirementId: 'req_multi_a',
            clauseId: 'clause:multi:a',
            sourceId,
            type: 'course_interval',
            status: 'effective',
        }],
        semanticActions: [{
            id: 'action_multi_a',
            requirementId: 'req_multi_a',
            sourceId,
            kind: 'lesson_plan_patch',
            status: 'ready',
        }],
    };

    const items = buildUnifiedRequirementItems(review);

    assert.equal(items.length, 1);
    assert.equal(items[0].id, sourceId);
    assert.deepEqual(items[0].requirementIds.sort(), ['req_multi_a', 'req_multi_b']);
    assert.deepEqual(items[0].clauseIds.sort(), ['clause:multi:a', 'clause:multi:b']);
    assert.equal(items[0].clauses.length, 2);
    assert.deepEqual(items[0].machineRules.map(row => row.id), ['row_multi_a']);
    assert.deepEqual(items[0].semanticActions.map(action => action.id), ['action_multi_a']);
});

test('understood but unsupported source remains visible without fabricated machine rules', () => {
    const sourceId = 'src:unsupported';
    const unsupportedClause = clause({
        id: 'req_unsupported',
        sourceId,
        clauseId: 'clause:unsupported',
        intent: 'cross_venue_boundary',
        status: 'needs_review',
        reviewStatus: 'unsupported',
        understandingStatus: 'parsed',
        executionStatus: 'unsupported_by_solver',
        applyTo: 'review',
        warnings: ['需求语义已保留，但当前求解器不支持自动执行。'],
    });
    const review = {
        schemaVersion: 2,
        sourceRequirements: [sourceRequirement({
            sourceId,
            rawText: '第4节和第5节之间不要安排需要跨场地转移的连续课程。',
            clauses: [unsupportedClause],
            status: 'unsupported',
            understandingStatus: 'parsed',
            executionStatus: 'unsupported_by_solver',
            reviewStatus: 'unsupported',
            warnings: ['需求语义已保留，但当前求解器不支持自动执行。'],
        })],
        constraintIRs: [unsupportedClause],
        requirementItems: [unsupportedClause],
        draftRows: [],
        semanticActions: [],
    };

    const [item] = buildUnifiedRequirementItems(review);

    assert.equal(item.id, sourceId);
    assert.equal(item.clauses.length, 1);
    assert.equal(item.machineRules.length, 0);
    assert.equal(item.understandingStatus, 'parsed');
    assert.equal(item.executionStatus, 'unsupported_by_solver');
    assert.equal(getRequirementGroupKey(item), 'review');
    assert.ok(item.warnings.some(warning => warning.includes('求解器不支持')));
});

test('system supplements stay in a separate origin group and parsedBy never rewrites user origin', () => {
    const userClause = clause({
        id: 'req_user',
        sourceId: 'src:user',
        clauseId: 'clause:user',
    });
    const review = {
        schemaVersion: 2,
        sourceRequirements: [sourceRequirement({
            sourceId: 'src:user',
            rawText: '用户输入。',
            clauses: [userClause],
            origin: 'user_input',
            parsedBy: ['local', 'ai'],
        })],
        requirementItems: [
            userClause,
            {
                id: 'req_system_legacy',
                origin: 'system_supplement',
                intent: 'teacher_conflict',
                status: 'handled',
                applyTo: 'handled',
                source: { rawText: '教师不能同时上两节课。' },
            },
        ],
        systemSupplements: [{
            supplementId: 'system:teacher-conflict',
            origin: 'system_supplement',
            parsedBy: ['system'],
            reason: '求解器基础约束',
            requirement: {
                id: 'req_system',
                intent: 'teacher_conflict',
                status: 'handled',
                applyTo: 'handled',
                source: { rawText: '教师不能同时上两节课。' },
            },
            machineRuleIds: [],
        }],
        draftRows: [],
        semanticActions: [],
    };

    const items = buildUnifiedRequirementItems(review);
    const userItem = items.find(item => item.sourceId === 'src:user');
    const systemItems = items.filter(item => item.origin === 'system_supplement');

    assert.equal(userItem.origin, 'user_input');
    assert.deepEqual(userItem.parsedBy, ['local', 'ai']);
    assert.equal(systemItems.length, 1);
    assert.equal(systemItems[0].id, 'system:teacher-conflict');
});

test('legacy responses without sourceRequirements keep the existing requirementItems fallback', () => {
    const items = buildUnifiedRequirementItems({
        requirementItems: [{
            id: 'legacy_req',
            intent: 'preferred_periods',
            status: 'actionable',
            applyTo: 'rule',
            source: { rawText: '数学尽量上午。' },
        }],
        draftRows: [{
            id: 'legacy_row',
            requirementId: 'legacy_req',
            type: 'subject_morning',
            status: 'effective',
        }],
        semanticActions: [],
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'legacy_req');
    assert.deepEqual(items[0].machineRules.map(row => row.id), ['legacy_row']);
});

test('legacy manual placeholder rows stay visible but are never actionable or persistable', () => {
    for (const type of ['forbid', 'prefer', 'avoid']) {
        const row = {
            id: `manual_${type}`,
            type,
            targetName: '张老师',
            timeLabel: '周一第1节',
            status: 'ready',
            origin: 'manual',
        };
        const review = { draftRows: [row] };

        assert.equal(getActionableRequirementCount(review), 0, `${type} must require conversion`);
        assert.deepEqual(getBackendRuleRows(review), []);
        assert.deepEqual(buildUnifiedRequirementItems(review)[0]?.machineRules?.map(item => item.id), [row.id]);
    }
});

test('constraint apply plan counts unique requirements and only persistable effects', () => {
    const review = {
        requirementItems: [{
            id: 'req_combined',
            status: 'actionable',
            applyTo: 'rule',
            source: { rawText: '语文上午优先并改为连堂' },
        }],
        draftRows: [{
            id: 'rule_soft',
            requirementId: 'req_combined',
            type: 'subject_morning',
            targetType: 'subject',
            targetId: 'subject_chinese',
            status: 'effective',
            priority: 'soft',
        }, {
            id: 'legacy_forbid',
            requirementId: 'req_combined',
            type: 'forbid',
            status: 'ready',
        }],
        semanticActions: [{
            id: 'action_block',
            requirementId: 'req_combined',
            kind: 'lesson_plan_patch',
            status: 'ready',
        }],
    };

    const plan = buildConstraintApplyPlan(review);

    assert.equal(plan.requirementCount, 1);
    assert.equal(plan.effectCount, 2);
    assert.equal(plan.hardRuleCount, 0);
    assert.equal(plan.softRuleCount, 1);
    assert.equal(plan.lessonPlanActionCount, 1);
    assert.deepEqual(plan.backendRuleRows.map(row => row.id), ['rule_soft']);
    assert.deepEqual(plan.semanticActions.map(action => action.id), ['action_block']);
    assert.deepEqual(plan.requirementIds, ['req_combined']);
});

test('the real 137-row workbook renders exactly 137 source cards and keeps expanded clauses inside their source', async () => {
    const result = await parseTimetableRules({
        file: {
            filename: '真实学校排课约束需求.xlsx',
            buffer: fs.readFileSync('真实学校排课约束需求.xlsx'),
        },
        project: {},
        env: {},
    });

    const items = buildUnifiedRequirementItems(result);
    const bySourceRow = rowNumber => items.find(item => item.source?.rowNumber === rowNumber || item.source?.sourceRow === rowNumber);

    assert.equal(items.length, 137);
    assert.equal(new Set(items.map(item => item.sourceId)).size, 137);
    assert.ok(items.every(item => item.id === item.sourceId));
    for (const [rowNumber, expectedClauseCount] of [[114, 3], [116, 2], [131, 3], [138, 1]]) {
        const item = bySourceRow(rowNumber);
        assert.ok(item, `missing source card for row ${rowNumber}`);
        assert.equal(
            item.clauses.length,
            expectedClauseCount,
            `row ${rowNumber} should keep its precise clauses inside one source card`,
        );
    }

    const crossVenueBoundary = bySourceRow(133);
    assert.ok(crossVenueBoundary);
    assert.equal(crossVenueBoundary.clauses.length, 1);
    assert.equal(crossVenueBoundary.machineRules.length, 1);
    assert.equal(crossVenueBoundary.executionStatus, 'executable');
});


test('source review model accepts singleton payload objects and scalar identity fields', () => {
    const sourceId = 'src:singleton';
    const semanticClause = clause({
        id: 'req_singleton',
        sourceId,
        clauseId: 'clause:singleton',
    });
    semanticClause.machineRuleIds = 'machine:singleton';
    semanticClause.object.matchedIds = 'math';
    const source = sourceRequirement({
        sourceId,
        rawText: '数学尽量安排在上午。',
        clauses: semanticClause,
        machineRuleIds: 'machine:singleton',
        parsedBy: 'ai',
    });

    const [item] = buildUnifiedRequirementItems({
        schemaVersion: 2,
        sourceRequirements: source,
        requirementItems: semanticClause,
        constraintIRs: semanticClause,
        draftRows: {
            id: 'row:singleton',
            machineRuleId: 'machine:singleton',
            sourceId,
            type: 'subject_morning',
            targetType: 'subject',
            targetId: 'math',
            subjectIds: 'math',
            status: 'effective',
        },
        semanticActions: {
            id: 'action:singleton',
            sourceId,
            kind: 'rule',
            status: 'ready',
        },
    });

    assert.equal(item.id, sourceId);
    assert.deepEqual(item.machineRuleIds, ['machine:singleton']);
    assert.deepEqual(item.machineRules.map(row => row.id), ['row:singleton']);
    assert.deepEqual(item.semanticActions.map(action => action.id), ['action:singleton']);
    assert.ok(item.parsedBy.includes('ai'));
});

test('legacy owner matching uses scalar slots to bind a machine row to the correct requirement', () => {
    const sharedText = '王老师周一第2节或第3节不要排课。';
    const items = buildUnifiedRequirementItems({
        requirementItems: [{
            id: 'legacy_slot_1_2',
            intent: 'teacher_unavailable',
            status: 'actionable',
            applyTo: 'rule',
            parameters: { slots: '1-2' },
            source: { rawText: sharedText },
        }, {
            id: 'legacy_slot_1_3',
            intent: 'teacher_unavailable',
            status: 'actionable',
            applyTo: 'rule',
            parameters: { slots: '1-3' },
            source: { rawText: sharedText },
        }],
        draftRows: {
            id: 'legacy_row_slot_1_3',
            type: 'teacher_unavailable',
            slots: '1-3',
            status: 'effective',
            sourceText: sharedText,
        },
        semanticActions: [],
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'legacy_slot_1_3');
    assert.deepEqual(items[0].machineRules.map(row => row.id), ['legacy_row_slot_1_3']);
});
