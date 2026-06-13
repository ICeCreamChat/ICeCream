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
