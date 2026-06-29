import assert from 'node:assert/strict';
import test from 'node:test';

import { TimetableConstraintConversation } from '../gateway/services/timetable-constraint-conversation.js';

const project = {
    activeWeekdays: [1, 2, 3, 4, 5],
    activePeriods: [1, 2, 3, 4, 5, 6, 7],
    teachers: [{ id: 't_wang', name: '王老师' }],
    classes: [{ id: 'c1', name: '七年级1班' }, { id: 'c2', name: '七年级2班' }],
    subjects: [{ id: 'chemistry', name: '化学' }],
};

test('constraint chat opens from the current review issues instead of a generic prompt', () => {
    const conversation = new TimetableConstraintConversation();
    conversation.initialize([{
        id: 'missing-slot-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_wang',
        targetName: '王老师',
        slots: [],
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
    }], project, {
        counts: {
            needsInput: 34,
            needReview: 101,
            unsupported: 1,
            warnings: 76,
        },
        groups: [{
            type: 'missing_info',
            label: '需要补充信息',
            count: 34,
            examples: ['缺少明确节次，请补充后再生效。'],
        }, {
            type: 'out_of_range_slots',
            label: '节次超出范围',
            count: 9,
            examples: ['节次 1-10、2-10、3-10、4-10、5-10 不在当前排课范围内。'],
        }],
        suggestedPrompts: [
            '先处理缺少明确节次的问题',
            '过滤不在当前排课范围内的第8-10节',
        ],
    });

    const welcome = conversation.history[0].content;
    assert.match(welcome, /34 条需要补充信息/);
    assert.match(welcome, /101 条需要复核/);
    assert.match(welcome, /1 条暂不支持/);
    assert.match(welcome, /76 条解析提醒/);
    assert.match(welcome, /缺少明确节次/);
    assert.match(welcome, /第8-10节/);
    assert.deepEqual(conversation.suggestedPrompts.slice(0, 2), [
        '先处理缺少明确节次的问题',
        '过滤不在当前排课范围内的第8-10节',
    ]);
});

test('constraint chat can apply a concrete slot answer to rows missing slots', async () => {
    const conversation = new TimetableConstraintConversation();
    conversation.initialize([{
        id: 'missing-slot-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_wang',
        targetName: '王老师',
        slots: [],
        status: 'needs_review',
        warnings: ['缺少明确节次，请补充后再生效。'],
    }], project, {
        counts: { needsInput: 1, needReview: 1, unsupported: 0, warnings: 1 },
        groups: [{
            type: 'missing_info',
            label: '需要补充信息',
            count: 1,
            examples: ['缺少明确节次，请补充后再生效。'],
        }],
    });

    const result = await conversation.chat('把缺少节次的约束统一设为周一到周五第7节');
    const [row] = result.constraints;

    assert.deepEqual(row.slots, ['1-7', '2-7', '3-7', '4-7', '5-7']);
    assert.equal(row.status, 'effective');
    assert.equal(row.warnings.some(warning => warning.includes('缺少明确节次')), false);
    assert.match(result.message, /已为 1 条缺少节次的约束补充/);
});

test('constraint chat explains a focused task without changing constraints', async () => {
    const conversation = new TimetableConstraintConversation();
    conversation.initialize([{
        id: 'ambiguous-teacher-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetName: '王老师',
        slots: ['3-5'],
        status: 'needs_review',
        warnings: ['存在多个候选教师。'],
    }], project, {
        groups: [{
            type: 'clarifying_questions',
            label: '确认教师名称',
            count: 1,
            examples: ['王老师可能对应多位教师'],
            relatedRuleIds: ['ambiguous-teacher-1'],
        }],
    });
    const before = JSON.stringify(conversation.constraints);

    const result = await conversation.chat('解释这个问题', {}, undefined, {
        intent: 'explain',
        taskContext: {
            taskId: 'confirm_teacher_names',
            taskType: 'clarifying_questions',
            relatedRuleIds: ['ambiguous-teacher-1'],
            examples: ['王老师可能对应多位教师'],
        },
    });

    assert.equal(JSON.stringify(conversation.constraints), before);
    assert.match(result.message, /问题是什么/);
    assert.match(result.message, /建议怎么处理/);
    assert.match(result.explanation.problem, /王老师/);
    assert.equal(result.actionPreview, null);
});

test('constraint chat returns a confirmation preview before changing draft constraints', async () => {
    const conversation = new TimetableConstraintConversation();
    conversation.initialize([{
        id: 'range-1',
        type: 'teacher_unavailable',
        targetType: 'teacher',
        targetId: 't_wang',
        targetName: '王老师',
        slots: ['1-7', '1-8', '2-8'],
        status: 'needs_review',
        warnings: ['节次 1-8、2-8 不在当前排课范围内。'],
    }], project, {
        groups: [{
            type: 'out_of_range_slots',
            label: '修正节次范围',
            count: 1,
            examples: ['节次 1-8、2-8 不在当前排课范围内。'],
            relatedRuleIds: ['range-1'],
        }],
    });
    const before = JSON.stringify(conversation.constraints);

    const preview = await conversation.chat('帮我生成修正', {}, undefined, {
        intent: 'preview_fix',
        taskContext: {
            taskId: 'fix_slot_range',
            taskType: 'out_of_range_slots',
            relatedRuleIds: ['range-1'],
            examples: ['节次 1-8、2-8 不在当前排课范围内。'],
        },
    });

    assert.equal(JSON.stringify(conversation.constraints), before);
    assert.match(preview.message, /准备改成什么/);
    assert.equal(preview.actionPreview.requiresConfirmation, true);
    assert.deepEqual(preview.actionPreview.affectedRuleIds, ['range-1']);
    assert.deepEqual(preview.actionPreview.changes[0].updates.slots, ['1-7']);

    const applied = await conversation.chat('应用这个预览', {}, undefined, {
        intent: 'apply_preview',
        taskContext: {
            taskId: 'fix_slot_range',
            taskType: 'out_of_range_slots',
            relatedRuleIds: ['range-1'],
        },
    });

    assert.deepEqual(applied.constraints[0].slots, ['1-7']);
    assert.equal(applied.constraints[0].warnings.length, 0);
    assert.match(applied.message, /已应用/);
});
